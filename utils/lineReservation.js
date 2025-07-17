const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class LineReservationManager {
  
  /**
   * Обработка строк файла - скрытие логинов/паролей
   * Формат: URL:login:password:Orders info → URL Orders info
   */
  static processFileLines(fileContent, hideCredentials = true) {
    const lines = fileContent.split('\n').filter(line => line.trim());
    
    if (!hideCredentials) {
      return lines; // Возвращаем полные строки с логинами/паролями
    }
    
    // Скрываем логины/пароли для показа покупателю
    return lines.map(line => {
      const parts = line.split(':');
      if (parts.length >= 4) {
        // Берем URL (первая часть) и информацию о заказах (все после 3-го двоеточия)
        const url = parts[0];
        const ordersInfo = parts.slice(3).join(':');
        return `${url} ${ordersInfo}`;
      }
      return line; // Если формат не подходит, возвращаем как есть
    });
  }

  /**
   * Поиск выбранных строк в файле товара
   */
  static findLinesInFile(fileContent, selectedLines) {
    const fullLines = fileContent.split('\n').filter(line => line.trim());
    const processedLines = this.processFileLines(fileContent, true);
    const foundLines = [];
    
    selectedLines.forEach(selectedLine => {
      const selectedTrimmed = selectedLine.trim();
      
      // Ищем точное совпадение в обработанных строках
      const index = processedLines.findIndex(processedLine => 
        processedLine.trim() === selectedTrimmed
      );
      
      if (index !== -1) {
        foundLines.push({
          original: fullLines[index],
          processed: processedLines[index],
          index: index
        });
      }
    });
    
    return foundLines;
  }

  /**
   * Валидация выбранных строк пользователем
   */
  static async validateSelectedLines(productId, userSelectedLines) {
    try {
      const { Product, ReservedLine } = require('../models');
      
      const product = await Product.findByPk(productId);
      if (!product) {
        throw new Error('Товар не найден');
      }

      const fileContent = await fs.readFile(product.filePath, 'utf8');
      const foundLines = this.findLinesInFile(fileContent, userSelectedLines);

      if (foundLines.length === 0) {
        throw new Error('Выбранные строки не найдены в файле товара');
      }

      console.log(`🔍 Найдено ${foundLines.length} строк из ${userSelectedLines.length} запрошенных`);

      // Проверяем, не зарезервированы ли уже строки
      for (const line of foundLines) {
        const lineHash = crypto.createHash('sha256')
          .update(`${productId}_${line.index}_${line.original}`)
          .digest('hex');

        const existingReserve = await ReservedLine.findOne({
          where: {
            lineHash,
            status: 'reserved',
            reservedUntil: { [require('sequelize').Op.gt]: new Date() }
          }
        });

        if (existingReserve) {
          throw new Error(`Строка "${line.processed}" уже зарезервирована другим пользователем`);
        }
      }

      return foundLines;
    } catch (error) {
      console.error('Ошибка валидации строк:', error);
      throw error;
    }
  }

  /**
   * Резервирование ТОЛЬКО выбранных строк за пользователем (15 минут)
   */
  static async reserveLines(userId, productId, userSelectedLines) {
    try {
      const { ReservedLine } = require('../models');
      
      // Валидируем строки
      const validatedLines = await this.validateSelectedLines(productId, userSelectedLines);
      
      // Резервируем строки НА 15 МИНУТ
      const reservedLines = await ReservedLine.reserveLines(userId, productId, validatedLines);

      console.log(`✅ Зарезервировано ${reservedLines.length} строк на 15 минут для пользователя ${userId}`);
      
      return {
        success: true,
        reservedLines,
        count: reservedLines.length,
        reservedUntil: reservedLines[0]?.reservedUntil
      };

    } catch (error) {
      console.error('Ошибка резервирования строк:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Создание файла с зарезервированными строками для отправки пользователю
   */
  static async createReservedLinesFile(userId, productId) {
    try {
      const { ReservedLine } = require('../models');
      
      const reservedLines = await ReservedLine.findAll({
        where: {
          userId,
          productId,
          status: 'sold' // Только ПРОДАННЫЕ строки
        },
        order: [['lineIndex', 'ASC']]
      });

      if (reservedLines.length === 0) {
        throw new Error('Нет проданных строк для выдачи');
      }

      // Создаем содержимое файла с ПОЛНЫМИ данными (включая логины/пароли)
      const fileContent = reservedLines
        .map(line => line.lineContent) // Исходная строка с логином/паролем
        .join('\n');

      // Создаем временный файл
      const tempDir = path.join(__dirname, '../temp');
      await fs.mkdir(tempDir, { recursive: true });
      
      const fileName = `purchased_lines_${userId}_${productId}_${Date.now()}.txt`;
      const filePath = path.join(tempDir, fileName);
      
      await fs.writeFile(filePath, fileContent, 'utf8');

      console.log(`📁 Создан файл с ${reservedLines.length} купленными строками для пользователя ${userId}`);

      return {
        filePath,
        fileName,
        count: reservedLines.length,
        content: fileContent
      };

    } catch (error) {
      console.error('Ошибка создания файла купленных строк:', error);
      throw error;
    }
  }

  /**
   * Подтверждение продажи зарезервированных строк
   */
  static async confirmSale(userId, productId, purchaseId) {
    try {
      const { ReservedLine } = require('../models');
      
      const confirmedCount = await ReservedLine.confirmSale(userId, productId, purchaseId);
      
      console.log(`✅ Подтверждена продажа ${confirmedCount} строк для пользователя ${userId}`);
      
      return {
        success: true,
        confirmedCount
      };

    } catch (error) {
      console.error('Ошибка подтверждения продажи:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * НЕ удаляем строки из исходного файла - оставляем товар доступным!
   */
  static async removeReservedLinesFromProduct(userId, productId) {
    // ВАЖНО: НЕ УДАЛЯЕМ строки из файла товара!
    // Файл остается целым для других покупателей
    console.log(`ℹ️ Строки НЕ удаляются из файла товара ${productId} - товар остается доступным`);
    return 0;
  }

  /**
   * Очистка истекших резервов (старше 15 минут)
   */
  static async cleanExpiredReserves() {
    try {
      const { ReservedLine } = require('../models');
      
      const expiredCount = await ReservedLine.cleanExpiredReserves();
      
      if (expiredCount > 0) {
        console.log(`🧹 Очищено ${expiredCount} истекших резервов (старше 15 минут)`);
      }
      
      return expiredCount;
    } catch (error) {
      console.error('Ошибка очистки истекших резервов:', error);
      return 0;
    }
  }

  /**
   * Получение статистики резервов пользователя
   */
  static async getUserReservationStats(userId) {
    try {
      const { ReservedLine } = require('../models');
      
      const stats = await ReservedLine.findAll({
        where: { userId },
        attributes: [
          'status',
          [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']
        ],
        group: ['status'],
        raw: true
      });

      const result = {
        reserved: 0,
        sold: 0,
        expired: 0,
        total: 0
      };

      stats.forEach(stat => {
        result[stat.status] = parseInt(stat.count);
        result.total += parseInt(stat.count);
      });

      return result;
    } catch (error) {
      console.error('Ошибка получения статистики резервов:', error);
      return { reserved: 0, sold: 0, expired: 0, total: 0 };
    }
  }

  /**
   * Получение зарезервированных строк пользователя
   */
  static async getUserReservedLines(userId, productId = null) {
    try {
      const { ReservedLine, Product } = require('../models');
      
      const where = {
        userId,
        status: 'reserved',
        reservedUntil: { [require('sequelize').Op.gt]: new Date() }
      };

      if (productId) {
        where.productId = productId;
      }

      return await ReservedLine.findAll({
        where,
        include: [{
          model: Product,
          attributes: ['name', 'uniqueCode', 'category']
        }],
        order: [['createdAt', 'DESC']]
      });
    } catch (error) {
      console.error('Ошибка получения зарезервированных строк:', error);
      return [];
    }
  }

  /**
   * Продление резерва строк на 15 минут
   */
  static async extendReservation(userId, productId, minutes = 15) {
    try {
      const { ReservedLine } = require('../models');
      
      const newReservedUntil = new Date(Date.now() + minutes * 60 * 1000);
      
      const [updatedCount] = await ReservedLine.update(
        { reservedUntil: newReservedUntil },
        {
          where: {
            userId,
            productId,
            status: 'reserved'
          }
        }
      );

      console.log(`⏰ Продлен резерв на ${minutes} минут для ${updatedCount} строк пользователя ${userId}`);
      
      return {
        success: true,
        updatedCount,
        newReservedUntil
      };

    } catch (error) {
      console.error('Ошибка продления резерва:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Отмена резерва строк
   */
  static async cancelReservation(userId, productId) {
    try {
      const { ReservedLine } = require('../models');
      
      const [updatedCount] = await ReservedLine.update(
        { 
          status: 'expired',
          reservedUntil: new Date()
        },
        {
          where: {
            userId,
            productId,
            status: 'reserved'
          }
        }
      );

      console.log(`❌ Отменен резерв ${updatedCount} строк для пользователя ${userId}`);
      
      return {
        success: true,
        cancelledCount: updatedCount
      };

    } catch (error) {
      console.error('Ошибка отмены резерва:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Получение статистики по товару
   */
  static async getProductReservationStats(productId) {
    try {
      const { ReservedLine, User } = require('../models');
      
      const reservedLines = await ReservedLine.findAll({
        where: { productId },
        include: [
          { 
            model: User, 
            attributes: ['telegramId', 'username', 'firstName', 'status'] 
          }
        ],
        order: [['lineIndex', 'ASC']]
      });

      // Группируем по пользователям
      const byUsers = {};
      const byStatus = { reserved: 0, sold: 0, expired: 0 };
      
      reservedLines.forEach(line => {
        const userId = line.userId;
        if (!byUsers[userId]) {
          byUsers[userId] = {
            user: line.User,
            lines: [],
            totalLines: 0,
            statuses: {}
          };
        }
        byUsers[userId].lines.push(line);
        byUsers[userId].totalLines++;
        
        const status = line.status;
        byUsers[userId].statuses[status] = (byUsers[userId].statuses[status] || 0) + 1;
        byStatus[status]++;
      });

      return {
        totalLines: reservedLines.length,
        byUsers: Object.values(byUsers),
        byStatus,
        activeReserves: byStatus.reserved
      };

    } catch (error) {
      console.error('Ошибка получения статистики товара:', error);
      return {
        totalLines: 0,
        byUsers: [],
        byStatus: { reserved: 0, sold: 0, expired: 0 },
        activeReserves: 0
      };
    }
  }

  /**
   * Обработка текстового списка от пользователя
   */
  static parseUserTextInput(textInput) {
    const lines = textInput.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    console.log(`📝 Обработан текстовый ввод: ${lines.length} строк`);
    return lines;
  }

  /**
   * Обработка файла от пользователя
   */
  static async parseUserFileInput(fileContent) {
    try {
      const lines = fileContent.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
      
      console.log(`📄 Обработан файл: ${lines.length} строк`);
      return lines;
    } catch (error) {
      console.error('Ошибка обработки файла:', error);
      throw new Error('Не удалось обработать файл');
    }
  }
}

module.exports = LineReservationManager;