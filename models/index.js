const sequelize = require('../config/database');
const User = require('./User');
const Product = require('./Product');
const Purchase = require('./Purchase');
const Admin = require('./Admin');
const Notification = require('./Notification');
const PurchaseState = require('./PurchaseState');
const ReservedLine = require('./ReservedLine');

// Основные связи между моделями
User.hasMany(Purchase, { foreignKey: 'userId' });
Purchase.belongsTo(User, { foreignKey: 'userId' });

Product.hasMany(Purchase, { foreignKey: 'productId' });
Purchase.belongsTo(Product, { foreignKey: 'productId' });

Admin.hasMany(Purchase, { foreignKey: 'confirmedBy' });
Purchase.belongsTo(Admin, { foreignKey: 'confirmedBy', as: 'ConfirmedByAdmin' });

User.hasMany(Notification, { foreignKey: 'userId' });
Notification.belongsTo(User, { foreignKey: 'userId' });

Admin.hasMany(Notification, { foreignKey: 'adminId' });
Notification.belongsTo(Admin, { foreignKey: 'adminId' });

// Связи для ReservedLine (НОВАЯ СИСТЕМА РЕЗЕРВИРОВАНИЯ СТРОК)
User.hasMany(ReservedLine, { foreignKey: 'userId' });
ReservedLine.belongsTo(User, { foreignKey: 'userId' });

Product.hasMany(ReservedLine, { foreignKey: 'productId' });
ReservedLine.belongsTo(Product, { foreignKey: 'productId' });

Purchase.hasMany(ReservedLine, { foreignKey: 'purchaseId' });
ReservedLine.belongsTo(Purchase, { foreignKey: 'purchaseId' });

// Связи для PurchaseState
User.hasMany(PurchaseState, { foreignKey: 'userId' });
PurchaseState.belongsTo(User, { foreignKey: 'userId' });

Product.hasMany(PurchaseState, { foreignKey: 'productId' });
PurchaseState.belongsTo(Product, { foreignKey: 'productId' });

async function syncModels() {
  try {
    console.log('🔄 Синхронизация моделей с базой данных...');
    
    // Синхронизируем в правильном порядке (сначала независимые таблицы)
    await sequelize.sync({ force: false, alter: true });
    console.log('✅ Модели синхронизированы с базой данных');
    console.log('🆕 Система резервирования строк готова к работе!');
    
    await createInitialAdmins();
    await printDatabaseStats();
  } catch (error) {
    console.error('❌ Ошибка синхронизации моделей:', error);
    throw error;
  }
}

async function createInitialAdmins() {
  try {
    const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()));
    
    for (const adminId of adminIds) {
      if (adminId && !isNaN(adminId)) {
        const [admin, created] = await Admin.findOrCreate({
          where: { telegramId: adminId },
          defaults: {
            telegramId: adminId,
            role: adminId === adminIds[0] ? 'super_admin' : 'admin',
            isActive: true,
            notifications: true
          }
        });
        
        if (created) {
          console.log(`👨‍💼 Создан администратор: ${adminId}`);
        }
      }
    }
    
    console.log(`✅ Инициализированы ${adminIds.length} администраторов`);
  } catch (error) {
    console.error('❌ Ошибка создания администраторов:', error);
  }
}

async function printDatabaseStats() {
  try {
    const stats = {
      users: await User.count(),
      products: await Product.count(),
      purchases: await Purchase.count(),
      admins: await Admin.count(),
      reservedLines: await ReservedLine.count(),
      activeReserves: await ReservedLine.count({
        where: {
          status: 'reserved',
          reservedUntil: { [require('sequelize').Op.gt]: new Date() }
        }
      })
    };
    
    console.log('📊 Статистика базы данных:');
    console.log(`   👥 Пользователи: ${stats.users}`);
    console.log(`   📦 Товары: ${stats.products}`);
    console.log(`   🛒 Покупки: ${stats.purchases}`);
    console.log(`   👨‍💼 Администраторы: ${stats.admins}`);
    console.log(`   📋 Зарезервированных строк: ${stats.reservedLines}`);
    console.log(`   ⚡ Активных резервов: ${stats.activeReserves}`);
  } catch (error) {
    console.error('❌ Ошибка получения статистики БД:', error);
  }
}

// Хелпер функции для работы с резервами
const ReservationHelper = {
  // Получить активные резервы пользователя
  async getUserActiveReserves(userId) {
    return await ReservedLine.findAll({
      where: {
        userId,
        status: 'reserved',
        reservedUntil: { [require('sequelize').Op.gt]: new Date() }
      },
      include: [Product],
      order: [['createdAt', 'DESC']]
    });
  },

  // Проверить, есть ли конфликты резервирования
  async checkReservationConflicts(productId, lineIndices) {
    const conflicts = await ReservedLine.findAll({
      where: {
        productId,
        lineIndex: { [require('sequelize').Op.in]: lineIndices },
        status: 'reserved',
        reservedUntil: { [require('sequelize').Op.gt]: new Date() }
      },
      include: [User]
    });
    
    return conflicts;
  },

  // Получить статистику по товару
  async getProductStats(productId) {
    const stats = await ReservedLine.getStatsByProduct(productId);
    
    // Добавляем информацию о доступных строках
    const product = await Product.findByPk(productId);
    if (product && product.filePath) {
      try {
        const fs = require('fs').promises;
        const fileContent = await fs.readFile(product.filePath, 'utf8');
        const totalLines = fileContent.split('\n').filter(line => line.trim()).length;
        stats.availableLines = totalLines - stats.byStatus.sold;
      } catch (error) {
        console.error('Ошибка чтения файла товара:', error);
        stats.availableLines = 0;
      }
    }
    
    return stats;
  }
};

module.exports = {
  sequelize,
  User,
  Product,
  Purchase,
  Admin,
  Notification,
  PurchaseState,
  ReservedLine,
  ReservationHelper,
  syncModels
};