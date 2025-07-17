const { Telegraf, Markup } = require('telegraf');
const { syncModels, User, Product, Purchase, Admin } = require('./models');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// Проверка переменных окружения
const requiredEnvVars = ['BOT_TOKEN', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'ADMIN_IDS'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Отсутствует переменная окружения: ${envVar}`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);

// Хранилище состояний пользователей для Admin покупок
const userStates = new Map();
// Хранилище состояний админов для подтверждения продаж
const adminStates = new Map();

// Middleware для логирования
bot.use(async (ctx, next) => {
  console.log(`📨 Сообщение от ${ctx.from?.id}: ${ctx.message?.text || ctx.callbackQuery?.data}`);
  
  try {
    await next();
  } catch (error) {
    console.error(`❌ Ошибка: ${error.message}`);
    console.error(`❌ Stack: ${error.stack}`);
    await ctx.reply('⚠️ Произошла ошибка. Попробуйте позже.');
  }
});

// Middleware для регистрации пользователей
bot.use(async (ctx, next) => {
  if (ctx.from?.id) {
    try {
      const [user, created] = await User.findOrCreate({
        where: { telegramId: ctx.from.id },
        defaults: {
          telegramId: ctx.from.id,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name
        }
      });

      if (created) {
        console.log(`👤 Новый пользователь: ${ctx.from.id}`);
        
        // Уведомление админам о новом пользователе
        await sendAdminNotification(ctx, 
          `🆕 НОВЫЙ ПОЛЬЗОВАТЕЛЬ ЗАРЕГИСТРИРОВАН:\n\n` +
          `👤 ID: ${ctx.from.id}\n` +
          `📱 Username: @${escapeMarkdown(ctx.from.username) || 'не указан'}\n` +
          `🏷️ Имя: ${escapeMarkdown(ctx.from.first_name) || 'не указано'}`
        );
      } else {
        await user.update({ lastActivity: new Date() });
      }

      ctx.user = user;
    } catch (error) {
      console.error('Ошибка регистрации пользователя:', error);
    }
  }
  
  return next();
});

// Функция экранирования специальных символов для Markdown
function escapeMarkdown(text) {
  if (!text) return text;
  return text.toString()
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/-/g, '\\-')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!');
}

// Функция отправки уведомлений админам с детальным логированием
async function sendAdminNotification(ctx, message, options = {}, showConfirmButton = false, buyerId = null) {
  const adminIds = process.env.ADMIN_IDS.split(',');
  console.log(`📤 Попытка отправки уведомления ${adminIds.length} админам: ${adminIds.join(', ')}`);
  
  let successCount = 0;
  let failureCount = 0;
  
  for (const adminId of adminIds) {
    const trimmedAdminId = adminId.trim();
    try {
      console.log(`📤 Отправка сообщения админу ${trimmedAdminId}...`);
      
      // Добавляем кнопку подтверждения покупки если нужно
      let messageOptions = {
        parse_mode: 'Markdown',
        ...options
      };

      if (showConfirmButton && buyerId) {
        messageOptions.reply_markup = {
          inline_keyboard: [[
            { text: '✅ Подтвердить покупку', callback_data: `confirm_purchase_${buyerId}` }
          ]]
        };
      }
      
      // Сначала пробуем с Markdown
      await ctx.telegram.sendMessage(trimmedAdminId, message, messageOptions);
      
      console.log(`✅ Сообщение успешно отправлено админу ${trimmedAdminId}`);
      successCount++;
      
    } catch (error) {
      console.error(`❌ Ошибка отправки админу ${trimmedAdminId}:`);
      console.error(`   Код ошибки: ${error.code}`);
      console.error(`   Описание: ${error.description}`);
      console.error(`   Параметры: ${error.parameters ? JSON.stringify(error.parameters) : 'нет'}`);
      
      // Если ошибка парсинга Markdown, попробуем без форматирования
      if (error.code === 400 && error.description.includes('parse entities')) {
        try {
          console.log(`🔄 Повторная отправка без форматирования админу ${trimmedAdminId}...`);
          
          // Убираем все Markdown символы и отправляем как обычный текст
          const plainMessage = message.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').replace(/\_/g, '');
          
          let plainOptions = { ...options };
          if (showConfirmButton && buyerId) {
            plainOptions.reply_markup = {
              inline_keyboard: [[
                { text: '✅ Подтвердить покупку', callback_data: `confirm_purchase_${buyerId}` }
              ]]
            };
          }
          
          await ctx.telegram.sendMessage(trimmedAdminId, plainMessage, plainOptions);
          
          console.log(`✅ Сообщение отправлено как обычный текст админу ${trimmedAdminId}`);
          successCount++;
          
        } catch (retryError) {
          console.error(`❌ Повторная отправка также провалилась админу ${trimmedAdminId}:`, retryError.description);
          failureCount++;
        }
      } else {
        failureCount++;
        
        // Дополнительная диагностика
        if (error.code === 403) {
          console.error(`   🚫 Админ ${trimmedAdminId} заблокировал бота или не начинал диалог`);
        } else if (error.code === 400) {
          console.error(`   ⚠️ Неверный ID админа или проблема с сообщением`);
        }
      }
    }
  }
  
  console.log(`📊 Результат отправки: ${successCount} успешно, ${failureCount} ошибок`);
  return { successCount, failureCount };
}

// Функция создания главного меню с учетом состояния пользователя
async function createMainMenu(userId) {
  try {
    // Проверяем, есть ли у пользователя активные резервы или pending покупки
    const hasActiveReservation = await Product.findOne({
      where: {
        reservedBy: userId,
        reservedUntil: { [require('sequelize').Op.gt]: new Date() }
      }
    });

    const hasPendingPurchase = await Purchase.findOne({
      where: {
        userId: userId,
        status: 'pending'
      }
    });

    const userState = userStates.get(userId);
    const hasAdminProcess = userState && (userState.state === 'admin_list_sent' || userState.state === 'admin_file_sent');
    const hasShopProcess = userState && (userState.state === 'shop_list_sent' || userState.state === 'shop_file_sent');

    const buttons = [
      [Markup.button.callback('🛍️ Купить Shop', 'buy_shop')],
      [Markup.button.callback('👨‍💼 Купить Admin', 'buy_admin')],
      [Markup.button.callback('✍️ Купить Authors', 'buy_authors')],
      [Markup.button.callback('📈 Покупки SEO', 'seo_menu')],
      [Markup.button.callback('👤 Личный кабинет', 'profile')]
    ];

    // Показываем кнопку "Товар куплен" только если есть активная покупка
    if (hasActiveReservation || hasPendingPurchase || hasAdminProcess || hasShopProcess) {
      buttons.push([Markup.button.callback('💰 Товар куплен', 'purchase_completed')]);
    }

    buttons.push([Markup.button.callback('🆘 Поддержка', 'support')]);

    return Markup.inlineKeyboard(buttons);
  } catch (error) {
    console.error('Ошибка создания главного меню:', error);
    // Возвращаем базовое меню в случае ошибки
    return Markup.inlineKeyboard([
      [Markup.button.callback('🛍️ Купить Shop', 'buy_shop')],
      [Markup.button.callback('👨‍💼 Купить Admin', 'buy_admin')],
      [Markup.button.callback('✍️ Купить Authors', 'buy_authors')],
      [Markup.button.callback('📈 Покупки SEO', 'seo_menu')],
      [Markup.button.callback('👤 Личный кабинет', 'profile')],
      [Markup.button.callback('🆘 Поддержка', 'support')]
    ]);
  }
}

// Функция обработки строк файла - скрытие логинов/паролей
function processFileLines(fileContent, hideCredentials = true) {
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

// Функция поиска строк в файле
function findLinesInFile(fileContent, selectedLines) {
  const fullLines = fileContent.split('\n').filter(line => line.trim());
  const processedLines = processFileLines(fileContent, true);
  const foundLines = [];
  
  selectedLines.forEach(selectedLine => {
    const selectedTrimmed = selectedLine.trim();
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

// Функция удаления строк из файла
async function removeServerLinesFromFile(filePath, linesToRemove) {
  try {
    const fileContent = await fs.readFile(filePath, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim());
    
    // Удаляем выбранные строки
    const remainingLines = lines.filter(line => 
      !linesToRemove.some(removeIndex => lines[removeIndex] === line)
    );
    
    // Записываем обновленный файл
    await fs.writeFile(filePath, remainingLines.join('\n'), 'utf8');
    console.log(`📝 Обновлен файл ${filePath}, удалено ${linesToRemove.length} строк`);
    
    return remainingLines.length;
  } catch (error) {
    console.error('Ошибка обновления файла:', error);
    throw error;
  }
}
function getUserStatus(weeklySpent) {
  if (weeklySpent >= 8000) return 'INFINITY';
  if (weeklySpent >= 5000) return 'PREMIUM';
  if (weeklySpent >= 2000) return 'VIP';
  return 'Пыль';
}

// Функция получения прогресса до следующего статуса
function getStatusProgress(weeklySpent) {
  if (weeklySpent >= 8000) {
    return { current: 'INFINITY', next: null, progress: 100, needed: 0 };
  } else if (weeklySpent >= 5000) {
    const progress = Math.round((weeklySpent - 5000) / 30); // 30 долларов = 1%
    const needed = 8000 - weeklySpent;
    return { current: 'PREMIUM', next: 'INFINITY', progress: Math.min(progress, 99), needed };
  } else if (weeklySpent >= 2000) {
    const progress = Math.round((weeklySpent - 2000) / 30); // 30 долларов = 1%
    const needed = 5000 - weeklySpent;
    return { current: 'VIP', next: 'PREMIUM', progress: Math.min(progress, 99), needed };
  } else {
    const progress = Math.round(weeklySpent / 20); // 20 долларов = 1%
    const needed = 2000 - weeklySpent;
    return { current: 'Пыль', next: 'VIP', progress: Math.min(progress, 99), needed };
  }
}

// Функция подтверждения продажи администратором
async function confirmSaleByAdmin(ctx, buyer, amount) {
  try {
    console.log(`🏪 Подтверждение продажи админом ${ctx.from.id} для пользователя ${buyer.telegramId} на сумму $${amount}`);
    
    const newWeeklySpent = parseFloat(buyer.weeklySpent || 0) + amount;
    const newTotalSpent = parseFloat(buyer.totalSpent || 0) + amount;
    
    const oldStatus = buyer.status;
    const newStatus = getUserStatus(newWeeklySpent);
    const statusProgress = getStatusProgress(newWeeklySpent);

    // Обновляем статистику покупателя
    await buyer.update({
      weeklySpent: newWeeklySpent,
      totalSpent: newTotalSpent,
      status: newStatus
    });

    // Очищаем состояния и резервы покупателя + ОТКЛЮЧАЕМ ТОВАР
    userStates.delete(buyer.telegramId);
    
    // Находим товар который купил пользователь и отключаем его
    const purchasedProduct = await Product.findOne({
      where: { reservedBy: buyer.telegramId }
    });
    
    if (purchasedProduct) {
      await purchasedProduct.update({
        isAvailable: false,  // ОТКЛЮЧАЕМ ТОВАР НАВСЕГДА
        reservedBy: null,
        reservedUntil: null
      });
      console.log(`📦 Товар ${purchasedProduct.uniqueCode} отключен после продажи`);
    }
    
    // Снимаем резервы с остальных товаров пользователя (если есть)
    await Product.update(
      { reservedBy: null, reservedUntil: null },
      { where: { reservedBy: buyer.telegramId } }
    );
    
    // Подтверждаем покупки
    await Purchase.update(
      { status: 'confirmed', amount: amount, confirmedBy: ctx.from.id },
      { where: { userId: buyer.telegramId, status: 'pending' } }
    );

    // Уведомляем администратора об успешном подтверждении
    let adminResponseText = `✅ ПРОДАЖА ПОДТВЕРЖДЕНА!\n\n`;
    adminResponseText += `👤 Покупатель: @${buyer.username || buyer.firstName} (ID: ${buyer.telegramId})\n`;
    adminResponseText += `💰 Сумма продажи: ${amount}\n`;
    
    if (purchasedProduct) {
      adminResponseText += `📦 Проданный товар: ${purchasedProduct.name} (${purchasedProduct.uniqueCode})\n`;
      adminResponseText += `🔒 Статус товара: Отключен навсегда\n`;
    }
    
    adminResponseText += `📊 Новая статистика покупателя:\n`;
    adminResponseText += `💎 Потрачено за неделю: ${newWeeklySpent}\n`;
    adminResponseText += `💰 Всего потрачено: ${newTotalSpent}\n`;
    adminResponseText += `🏆 Статус: ${newStatus}\n\n`;
    
    if (newStatus !== oldStatus) {
      adminResponseText += `🎉 Статус покупателя повышен с ${oldStatus} до ${newStatus}!\n\n`;
    }
    
    adminResponseText += `Покупатель получит уведомление о подтвержденной покупке.`;

    // Отправляем без Markdown, чтобы избежать ошибок
    try {
      await ctx.reply(adminResponseText);
    } catch (error) {
      console.error('Ошибка отправки ответа админу:', error);
      await ctx.reply('✅ Продажа подтверждена! (ошибка форматирования сообщения)');
    }

    // Уведомляем покупателя о подтвержденной покупке
    try {
      let buyerResponseText = `✅ Ваша покупка подтверждена администратором!\n\n`;
      buyerResponseText += `💰 Сумма: ${amount}\n`;
      buyerResponseText += `📊 Ваша статистика обновлена:\n`;
      buyerResponseText += `💎 Потрачено за неделю: ${newWeeklySpent}\n`;
      buyerResponseText += `💰 Всего потрачено: ${newTotalSpent}\n`;
      buyerResponseText += `🏆 Статус: ${newStatus}\n\n`;
      
      if (newStatus !== oldStatus) {
        buyerResponseText += `🎉 Поздравляем! Ваш статус повышен до ${newStatus}!\n\n`;
      }
      
      // Показываем прогресс до следующего статуса
      if (statusProgress.next) {
        const progressBar = '▓'.repeat(Math.floor(statusProgress.progress / 10)) + 
                           '░'.repeat(10 - Math.floor(statusProgress.progress / 10));
        buyerResponseText += `📈 Прогресс до ${statusProgress.next}:\n`;
        buyerResponseText += `[${progressBar}] ${statusProgress.progress}%\n`;
        buyerResponseText += `💸 Осталось потратить: ${statusProgress.needed}\n\n`;
      } else {
        buyerResponseText += `👑 Вы достигли максимального статуса!\n\n`;
      }
      
      buyerResponseText += `Спасибо за покупку!`;

      // Отправляем покупателю уведомление с обновленным меню (без Markdown)
      const buyerMenu = await createMainMenu(buyer.telegramId);
      await ctx.telegram.sendMessage(buyer.telegramId, buyerResponseText, {
        ...buyerMenu
      });

    } catch (buyerError) {
      console.error('Ошибка уведомления покупателя:', buyerError);
      await ctx.reply(`⚠️ Продажа подтверждена, но не удалось уведомить покупателя (ID: ${buyer.telegramId})`);
    }

    // Уведомляем остальных админов
    const adminIds = process.env.ADMIN_IDS.split(',');
    for (const adminId of adminIds) {
      const trimmedAdminId = adminId.trim();
      if (parseInt(trimmedAdminId) !== ctx.from.id) {
        try {
          await ctx.telegram.sendMessage(trimmedAdminId,
            `💰 ПРОДАЖА ПОДТВЕРЖДЕНА\n\n` +
            `👨‍💼 Администратор: ${ctx.from.first_name || ctx.from.id}\n` +
            `👤 Покупатель: @${buyer.username || buyer.firstName} (${buyer.telegramId})\n` +
            `💰 Сумма: $${amount}\n` +
            `🏆 Новый статус: ${newStatus}\n` +
            `📊 Всего потрачено: $${newTotalSpent}`
          );
        } catch (error) {
          console.log(`Не удалось уведомить админа ${trimmedAdminId}`);
        }
      }
    }

  } catch (error) {
    console.error('Ошибка в confirmSaleByAdmin:', error);
    throw error;
  }
}

// Функция отправки списка админам
async function sendListToAdmins(ctx, productCode, listContent, listType, fileName = null, category = 'ADMIN') {
  console.log(`📋 Отправка списка админам от пользователя ${ctx.user.telegramId} (${category})...`);
  
  const categoryIcon = category === 'SHOP' ? '🛍️' : '📊';
  const categoryName = category === 'SHOP' ? 'SHOP' : 'ADMIN';
  
  let message = `📋 ${categoryIcon} СПИСОК ОТ ПОКУПАТЕЛЯ - ${categoryName}\n\n`;
  message += `👤 Покупатель: @${escapeMarkdown(ctx.user.username || ctx.user.firstName)}\n`;
  message += `📱 ID: ${ctx.user.telegramId}\n`;
  message += `🏆 Статус: ${ctx.user.status}\n`;
  message += `🔗 Товар: ${productCode}\n\n`;
  
  if (listType === 'file') {
    message += `📄 Тип: Файл (${escapeMarkdown(fileName)})\n`;
  } else {
    message += `📝 Тип: Текст в чате\n`;
  }
  
  message += `📊 Содержимое:\n${escapeMarkdown(listContent)}\n\n`;
  message += `💬 Действие: Свяжитесь с покупателем для оплаты`;

  await sendAdminNotification(ctx, message, {}, true, ctx.user.telegramId);
}

// Команда /start
bot.start(async (ctx) => {
  const welcomeText = `🎉 **Добро пожаловать в наш магазин цифровых товаров!**

📋 **Доступные разделы:**
• **Shop** - Готовые интернет-магазины с статистикой
• **Admin** - Административные панели сайтов  
• **Authors** - Авторские наработки и материалы
• **SEO** - Специальные SEO инструменты

💰 **Оплата принимается в криптовалюте:**
USDT (TRC20), BTC, ETH и другие по согласованию

🏆 **Система статусов:**
• **Пыль** - до $2000 в неделю
• **VIP** - $2000+ в неделю
• **PREMIUM** - $5000+ в неделю (приоритетное обслуживание)
• **INFINITY** - $8000+ в неделю (максимальный статус)

Выберите нужный раздел:`;

  const mainMenu = await createMainMenu(ctx.user.telegramId);
  await ctx.reply(welcomeText, {
    ...mainMenu,
    parse_mode: 'Markdown'
  });
});

// Обработчики кнопок главного меню
bot.action('main_menu', async (ctx) => {
  try {
    const mainMenu = await createMainMenu(ctx.user.telegramId);
    await ctx.editMessageText(
      '🏠 **Главное меню**\n\nВыберите нужный раздел:',
      {
        ...mainMenu,
        parse_mode: 'Markdown'
      }
    );
  } catch (error) {
    if (error.description && error.description.includes('message is not modified')) {
      // Игнорируем ошибку неизмененного сообщения
      return;
    }
    console.error('Ошибка главного меню:', error);
  }
});

// ==================== КОМАНДЫ АДМИНИСТРАТОРОВ ====================

bot.command('admin_stats', async (ctx) => {
  const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id));
  if (!adminIds.includes(ctx.from.id)) return;

  try {
    const totalUsers = await User.count();
    const totalProducts = await Product.count();
    const totalPurchases = await Purchase.count({ where: { status: 'confirmed' } });
    const pendingPurchases = await Purchase.count({ where: { status: 'pending' } });
    
    const revenue = await Purchase.sum('amount', { 
      where: { status: 'confirmed' } 
    }) || 0;

    const statsText = `📊 **Статистика бота:**

👥 **Пользователи:** ${totalUsers}
📦 **Товары:** ${totalProducts}  
✅ **Завершенные покупки:** ${totalPurchases}
⏳ **Ожидающие покупки:** ${pendingPurchases}
💰 **Общая выручка:** $${revenue}

📅 **Дата:** ${new Date().toLocaleString('ru-RU')}`;

    await ctx.reply(statsText, { parse_mode: 'Markdown' });
  } catch (error) {
    await ctx.reply('❌ Ошибка получения статистики');
  }
});

// Команда для тестирования уведомлений админам
bot.command('admin_test', async (ctx) => {
  const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id));
  if (!adminIds.includes(ctx.from.id)) return;

  console.log(`🧪 Тест уведомлений инициирован админом ${ctx.from.id}`);
  
  const testResult = await sendAdminNotification(ctx, 
    `🧪 ТЕСТ УВЕДОМЛЕНИЙ\n\n` +
    `✅ Это тестовое сообщение для проверки системы уведомлений.\n` +
    `📅 Время: ${new Date().toLocaleString('ru-RU')}\n` +
    `👤 Инициатор: ${ctx.from.id}`
  );

  await ctx.reply(
    `📊 **Результат теста:**\n` +
    `✅ Успешно: ${testResult.successCount}\n` +
    `❌ Ошибки: ${testResult.failureCount}`,
    { parse_mode: 'Markdown' }
  );
});

// Команда подтверждения продажи администратором
bot.command('sold', async (ctx) => {
  const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id));
  if (!adminIds.includes(ctx.from.id)) return;

  await ctx.reply(
    `💰 **Подтверждение продажи**\n\n` +
    `Укажите ID покупателя и сумму продажи в формате:\n` +
    `\`1234567890 500\`\n\n` +
    `Где:\n` +
    `• Первое число - ID пользователя\n` +
    `• Второе число - сумма продажи в долларах`,
    { parse_mode: 'Markdown' }
  );
  
  adminStates.set(ctx.from.id, {
    state: 'waiting_sale_confirmation'
  });
});

// Обработка команды админа для подтверждения продажи
bot.on('text', async (ctx, next) => {
  const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id));
  const isAdmin = adminIds.includes(ctx.from.id);
  const adminState = adminStates.get(ctx.from.id);
  
  // Обработка подтверждения продажи от админа
  if (isAdmin && adminState && adminState.state === 'waiting_sale_confirmation') {
    const text = ctx.message.text.trim();
    const match = text.match(/^(\d+)\s+(\d+(?:\.\d{2})?)$/);
    
    if (match) {
      const buyerId = parseInt(match[1]);
      const amount = parseFloat(match[2]);
      
      try {
        // Находим пользователя
        const buyer = await User.findOne({ where: { telegramId: buyerId } });
        
        if (!buyer) {
          adminStates.delete(ctx.from.id);
          return ctx.reply(`❌ Пользователь с ID ${buyerId} не найден в базе данных.`);
        }
        
        // Подтверждаем продажу
        await confirmSaleByAdmin(ctx, buyer, amount);
        adminStates.delete(ctx.from.id);
        
      } catch (error) {
        console.error('Ошибка подтверждения продажи:', error);
        await ctx.reply('❌ Ошибка подтверждения продажи. Попробуйте позже.');
        adminStates.delete(ctx.from.id);
      }
    } else {
      await ctx.reply(
        `❌ **Неверный формат**\n\n` +
        `Используйте формат: \`ID_пользователя сумма\`\n` +
        `Например: \`1234567890 500\``,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // Обработка ввода суммы после нажатия кнопки "Подтвердить покупку"
  if (isAdmin && adminState && adminState.state === 'waiting_purchase_amount') {
    const text = ctx.message.text.trim();
    const amountMatch = text.match(/^(\d+(?:\.\d{2})?)$/);
    
    if (amountMatch) {
      const amount = parseFloat(amountMatch[1]);
      
      if (amount > 0) {
        try {
          // Находим пользователя
          const buyer = await User.findOne({ where: { telegramId: adminState.buyerId } });
          
          if (!buyer) {
            adminStates.delete(ctx.from.id);
            return ctx.reply(`❌ Пользователь с ID ${adminState.buyerId} не найден в базе данных.`);
          }
          
          // Подтверждаем продажу
          await confirmSaleByAdmin(ctx, buyer, amount);
          adminStates.delete(ctx.from.id);
          
        } catch (error) {
          console.error('Ошибка подтверждения покупки:', error);
          await ctx.reply('❌ Ошибка подтверждения покупки. Попробуйте позже.');
          adminStates.delete(ctx.from.id);
        }
      } else {
        await ctx.reply(
          `❌ **Неверная сумма**\n\nСумма должна быть больше 0.`,
          { parse_mode: 'Markdown' }
        );
      }
    } else {
      await ctx.reply(
        `❌ **Неверный формат суммы**\n\n` +
        `Укажите только число, например: \`500\` или \`1250.50\``,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }
  
  // Передаем обработку дальше для обычных пользователей
  return next();
});

// ==================== SHOP ТОВАРЫ ====================

bot.action('buy_shop', async (ctx) => {
  try {
    const products = await Product.findAll({
      where: { category: 'SHOP', isAvailable: true },
      order: [['createdAt', 'DESC']]
    });

    if (products.length === 0) {
      return ctx.editMessageText(
        '📭 **В данный момент товары категории Shop отсутствуют**\n\n' +
        'Администратор скоро добавит новые товары.',
        {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Главное меню', callback_data: 'main_menu' }]] },
          parse_mode: 'Markdown'
        }
      );
    }

    // Создаем инлайн кнопки для каждого товара
    const productButtons = products.map(product => [
      Markup.button.callback(
        `🛍️ ${product.name} ${product.reservedBy ? '🔒' : '✅'}`, 
        `shop_product_${product.id}`
      )
    ]);
    
    productButtons.push([Markup.button.callback('🔙 Главное меню', 'main_menu')]);

    let messageText = `🛍️ **Покупка Shop товаров**\n\n`;
    messageText += `📝 **Процесс покупки:**\n`;
    messageText += `• Выберите товар из списка ниже\n`;
    messageText += `• Получите файл с анализом магазинов\n`;
    messageText += `• Загрузите свой список или напишите в чат\n`;
    messageText += `• Администратор получит ваш список\n`;
    messageText += `• После покупки нажмите "Товар куплен"\n\n`;
    
    messageText += `📊 **Доступно товаров: ${products.length}**\n\n`;
    messageText += `Выберите товар:`;

    await ctx.editMessageText(messageText, {
      reply_markup: { inline_keyboard: productButtons },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Ошибка в buy_shop:', error);
    await ctx.editMessageText(
      '❌ Ошибка загрузки товаров. Попробуйте позже.',
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Главное меню', callback_data: 'main_menu' }]] } }
    );
  }
});

// Обработка выбора конкретного Shop товара
bot.action(/shop_product_(\d+)/, async (ctx) => {
  try {
    const productId = parseInt(ctx.match[1]);
    const product = await Product.findByPk(productId);

    if (!product || !product.isAvailable) {
      return ctx.reply('❌ Товар недоступен или не найден');
    }

    if (product.reservedBy && product.reservedBy !== ctx.user.telegramId) {
      return ctx.reply(`⏰ Товар уже зарезервирован другим пользователем`);
    }

    // Резервируем товар
    const reserveUntil = new Date(Date.now() + 30 * 60 * 1000);
    await product.update({
      reservedBy: ctx.user.telegramId,
      reservedUntil: reserveUntil
    });

    // Устанавливаем состояние пользователя
    userStates.set(ctx.user.telegramId, {
      state: 'shop_file_sent',
      productId: productId,
      productCode: product.uniqueCode
    });

    // Отправляем файл с анализом
    try {
      // Читаем файл и обрабатываем строки (скрываем логины/пароли)
      let fileContent = '';
      let processedContent = '';
      
      try {
        fileContent = await fs.readFile(product.filePath, 'utf8');
        const processedLines = processFileLines(fileContent, true);
        processedContent = processedLines.join('\n');
      } catch (fileError) {
        console.error('Ошибка чтения файла товара:', fileError);
        processedContent = 'Ошибка загрузки данных товара';
      }

      // Создаем временный файл с обработанными данными для отправки
      const tempFileName = `temp_${product.uniqueCode}_${Date.now()}.txt`;
      const tempFilePath = path.join(__dirname, 'temp', tempFileName);
      
      // Создаем папку temp если не существует
      await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true });
      await fs.writeFile(tempFilePath, processedContent, 'utf8');

      await ctx.replyWithDocument(
        { source: tempFilePath },
        {
          caption: `🛍️ **Анализ Shop товара: ${product.name}**\n\n` +
            `📝 **Инструкция:**\n` +
            `1. Изучите список магазинов в прикрепленном файле\n` +
            `2. Выберите нужные строки и отправьте их боту\n` +
            `3. Можете загрузить TXT файл или написать в чат:\n` +
            `   \`строка1\`\n` +
            `   \`строка2\`\n` +
            `   \`строка3\`\n\n` +
            `⚠️ **Важно:** Логины и пароли скрыты для безопасности\n` +
            `💰 После оплаты вы получите полные данные доступа\n` +
            `⏰ **Резерв до:** ${reserveUntil.toLocaleString('ru-RU')}`,
          parse_mode: 'Markdown'
        }
      );

      // Удаляем временный файл
      setTimeout(async () => {
        try {
          await fs.unlink(tempFilePath);
        } catch (cleanupError) {
          console.error('Ошибка удаления временного файла:', cleanupError);
        }
      }, 5000);

      // Уведомляем админов
      console.log(`🛍️ Отправка уведомления о запросе Shop товара...`);
      await sendAdminNotification(ctx,
        `🛍️ ЗАПРОС SHOP ТОВАРА\n\n` +
        `👤 Пользователь: @${escapeMarkdown(ctx.user.username || ctx.user.firstName)}\n` +
        `📱 ID: ${ctx.user.telegramId}\n` +
        `🏆 Статус: ${ctx.user.status}\n\n` +
        `📦 Товар: ${escapeMarkdown(product.name)}\n` +
        `🔗 Код: ${product.uniqueCode}\n` +
        `📁 Файл отправлен пользователю (логины/пароли скрыты)\n` +
        `⏰ Резерв до: ${reserveUntil.toLocaleString('ru-RU')}`,
        {},
        true,
        ctx.user.telegramId
      );

    } catch (error) {
      console.error('Ошибка отправки файла:', error);
      await ctx.reply(
        '❌ **Ошибка отправки файла**\n\n' +
        'Файл анализа недоступен. Обратитесь к администратору.'
      );
    }

  } catch (error) {
    console.error('Ошибка выбора Shop товара:', error);
    await ctx.reply('❌ Ошибка обработки запроса');
  }
});

// ==================== ADMIN ТОВАРЫ ====================

bot.action('buy_admin', async (ctx) => {
  try {
    const products = await Product.findAll({
      where: { category: 'ADMIN', isAvailable: true },
      order: [['createdAt', 'DESC']]
    });

    if (products.length === 0) {
      return ctx.editMessageText(
        '📭 **В данный момент товары категории Admin отсутствуют**\n\n' +
        'Администратор скоро добавит новые административные панели.',
        {
          reply_markup: { inline_keyboard: [[{ text: '🔙 Главное меню', callback_data: 'main_menu' }]] },
          parse_mode: 'Markdown'
        }
      );
    }

    // Создаем инлайн кнопки для каждого товара
    const productButtons = products.map(product => [
      Markup.button.callback(
        `📦 ${product.name} ${product.reservedBy ? '🔒' : '✅'}`, 
        `admin_product_${product.id}`
      )
    ]);
    
    productButtons.push([Markup.button.callback('🔙 Главное меню', 'main_menu')]);

    let messageText = `👨‍💼 **Покупка Admin товаров**\n\n`;
    messageText += `📝 **Новый процесс покупки:**\n`;
    messageText += `• Выберите товар из списка ниже\n`;
    messageText += `• Получите файл с анализом посещаемости\n`;
    messageText += `• Загрузите свой список или напишите в чат\n`;
    messageText += `• Администратор получит ваш список\n`;
    messageText += `• После покупки нажмите "Товар куплен"\n\n`;
    
    messageText += `📊 **Доступно товаров: ${products.length}**\n\n`;
    messageText += `Выберите товар:`;

    await ctx.editMessageText(messageText, {
      reply_markup: { inline_keyboard: productButtons },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Ошибка в buy_admin:', error);
    await ctx.editMessageText(
      '❌ Ошибка загрузки товаров. Попробуйте позже.',
      { reply_markup: { inline_keyboard: [[{ text: '🔙 Главное меню', callback_data: 'main_menu' }]] } }
    );
  }
});

// Обработка выбора конкретного Admin товара
bot.action(/admin_product_(\d+)/, async (ctx) => {
  try {
    const productId = parseInt(ctx.match[1]);
    const product = await Product.findByPk(productId);

    if (!product || !product.isAvailable) {
      return ctx.reply('❌ Товар недоступен или не найден');
    }

    if (product.reservedBy && product.reservedBy !== ctx.user.telegramId) {
      return ctx.reply(`⏰ Товар уже зарезервирован другим пользователем`);
    }

    // Резервируем товар
    const reserveUntil = new Date(Date.now() + 30 * 60 * 1000);
    await product.update({
      reservedBy: ctx.user.telegramId,
      reservedUntil: reserveUntil
    });

    // Устанавливаем состояние пользователя
    userStates.set(ctx.user.telegramId, {
      state: 'admin_file_sent',
      productId: productId,
      productCode: product.uniqueCode
    });

    // Отправляем файл с анализом
    try {
      await ctx.replyWithDocument(
        { source: product.filePath },
        {
          caption: `📊 **Анализ Admin товара: ${product.name}**\n\n` +
            `📝 **Инструкция:**\n` +
            `1. Изучите анализ в прикрепленном файле\n` +
            `2. Загрузите TXT файл со списком выбранных сайтов\n` +
            `3. Или напишите список прямо в чат:\n` +
            `   \`site1.com\`\n` +
            `   \`site2.com\`\n` +
            `   \`site3.com\`\n\n` +
            `⏰ **Резерв до:** ${reserveUntil.toLocaleString('ru-RU')}`,
          parse_mode: 'Markdown'
        }
      );

      // Уведомляем админов с улучшенным логированием
      console.log(`📊 Отправка уведомления о запросе Admin товара...`);
      await sendAdminNotification(ctx,
        `📊 ЗАПРОС ADMIN ТОВАРА\n\n` +
        `👤 Пользователь: @${escapeMarkdown(ctx.user.username || ctx.user.firstName)}\n` +
        `📱 ID: ${ctx.user.telegramId}\n` +
        `🏆 Статус: ${ctx.user.status}\n\n` +
        `📦 Товар: ${escapeMarkdown(product.name)}\n` +
        `🔗 Код: ${product.uniqueCode}\n` +
        `📁 Файл отправлен пользователю\n` +
        `⏰ Резерв до: ${reserveUntil.toLocaleString('ru-RU')}`,
        {},
        true,
        ctx.user.telegramId
      );

    } catch (error) {
      console.error('Ошибка отправки файла:', error);
      await ctx.reply(
        '❌ **Ошибка отправки файла**\n\n' +
        'Файл анализа недоступен. Обратитесь к администратору.'
      );
    }

  } catch (error) {
    console.error('Ошибка выбора Admin товара:', error);
    await ctx.reply('❌ Ошибка обработки запроса');
  }
});

// ==================== ОБРАБОТКА ФАЙЛОВ И ТЕКСТА ====================

// Обработка загруженных файлов
bot.on('document', async (ctx) => {
  const userState = userStates.get(ctx.user.telegramId);
  
  if (userState && (userState.state === 'admin_file_sent' || userState.state === 'shop_file_sent')) {
    try {
      const fileExtension = ctx.message.document.file_name.split('.').pop().toLowerCase();
      
      if (fileExtension !== 'txt') {
        return ctx.reply('❌ Пожалуйста, загрузите файл в формате .txt');
      }

      // Получаем файл
      const file = await ctx.telegram.getFile(ctx.message.document.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
      
      // Скачиваем и читаем содержимое (для небольших файлов)
      const response = await fetch(fileUrl);
      const fileContent = await response.text();

      // Определяем тип категории
      const isShop = userState.state === 'shop_file_sent';
      const category = isShop ? 'SHOP' : 'ADMIN';

      // Обновляем состояние
      userStates.set(ctx.user.telegramId, {
        ...userState,
        state: isShop ? 'shop_list_sent' : 'admin_list_sent',
        userList: fileContent,
        listType: 'file'
      });

      const purchaseMenu = Markup.inlineKeyboard([
        [Markup.button.callback('💰 Товар куплен', 'purchase_completed')],
        [Markup.button.callback('🔙 Главное меню', 'main_menu')]
      ]);

      await ctx.reply(
        `✅ **Файл получен!**\n\n` +
        `📄 **Файл:** ${ctx.message.document.file_name}\n` +
        `📊 **Размер:** ${(ctx.message.document.file_size / 1024).toFixed(1)} KB\n\n` +
        `Ваш список отправлен администратору для обработки.\n\n` +
        `💬 **Что дальше?**\n` +
        `Администратор свяжется с вами для завершения сделки.\n` +
        `После получения товара нажмите "💰 Товар куплен".`,
        { 
          ...purchaseMenu,
          parse_mode: 'Markdown' 
        }
      );

      // Отправляем админам
      await sendListToAdmins(ctx, userState.productCode, fileContent, 'file', ctx.message.document.file_name, category);

    } catch (error) {
      console.error('Ошибка обработки файла:', error);
      await ctx.reply('❌ Ошибка обработки файла. Попробуйте еще раз.');
    }
  }
});

// ==================== ОБЪЕДИНЕННЫЙ ОБРАБОТЧИК ТЕКСТА ====================

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userState = userStates.get(ctx.user.telegramId);

  // Пропускаем команды - они обрабатываются отдельными обработчиками
  if (text.startsWith('/')) {
    console.log(`⚡ Команда ${text} пропущена обработчиком текста`);
    return;
  }

  console.log(`📝 Обработка текста от ${ctx.user.telegramId}: "${text}"`);
  console.log(`📊 Состояние пользователя:`, userState);

  // 1. Обработка Shop списка (новый приоритет)
  if (userState && userState.state === 'shop_file_sent') {
    console.log(`🛍️ Пользователь в режиме ожидания Shop списка от ${ctx.user.telegramId}`);
    
    // Любой текст от пользователя в этом состоянии считается списком магазинов
    userStates.set(ctx.user.telegramId, {
      ...userState,
      state: 'shop_list_sent',
      userList: text,
      listType: 'text'
    });

    const purchaseMenu = Markup.inlineKeyboard([
      [Markup.button.callback('💰 Товар куплен', 'purchase_completed')],
      [Markup.button.callback('🔙 Главное меню', 'main_menu')]
    ]);

    await ctx.reply(
      `✅ **Список получен!**\n\n` +
      `📝 **Количество строк:** ${text.split('\n').filter(line => line.trim()).length}\n\n` +
      `Ваш список отправлен администратору для обработки.\n\n` +
      `💬 **Что дальше?**\n` +
      `Администратор свяжется с вами для завершения сделки.\n` +
      `После получения товара нажмите "💰 Товар куплен".`,
      { 
        ...purchaseMenu,
        parse_mode: 'Markdown' 
      }
    );

    await sendListToAdmins(ctx, userState.productCode, text, 'text', null, 'SHOP');
    return;
  }

  // 2. Обработка Admin списка
  if (userState && userState.state === 'admin_file_sent') {
    const lines = text.split('\n').filter(line => line.trim());
    const domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/;
    
    if (lines.length > 0 && lines.some(line => domainPattern.test(line.trim()))) {
      console.log(`📝 Обнаружен список доменов от ${ctx.user.telegramId}`);
      
      userStates.set(ctx.user.telegramId, {
        ...userState,
        state: 'admin_list_sent',
        userList: text,
        listType: 'text'
      });

      const purchaseMenu = Markup.inlineKeyboard([
        [Markup.button.callback('💰 Товар куплен', 'purchase_completed')],
        [Markup.button.callback('🔙 Главное меню', 'main_menu')]
      ]);

      await ctx.reply(
        `✅ **Список получен!**\n\n` +
        `📝 **Количество строк:** ${lines.length}\n\n` +
        `Ваш список отправлен администратору для обработки.\n\n` +
        `💬 **Что дальше?**\n` +
        `Администратор свяжется с вами для завершения сделки.\n` +
        `После получения товара нажмите "💰 Товар куплен".`,
        { 
          ...purchaseMenu,
          parse_mode: 'Markdown' 
        }
      );

      await sendListToAdmins(ctx, userState.productCode, text, 'text', null, 'ADMIN');
      return;
    }
  }

  // 3. Справка по командам
  console.log(`ℹ️ Отправка справки пользователю ${ctx.user.telegramId}`);
  const helpMainMenu = await createMainMenu(ctx.user.telegramId);
  await ctx.reply(
    `ℹ️ **Доступные команды:**\n\n` +
    `/start - Главное меню\n` +
    `/help - Эта справка\n\n` +
    `**Для покупки товаров:**\n` +
    `• Используйте кнопки в разделах Shop/Admin\n` +
    `• Выбирайте товар из списка кнопок\n` +
    `• Отправляйте списки или файлы как указано\n\n` +
    `**Новый процесс покупки более удобный и безопасный!**`,
    { 
      ...helpMainMenu,
      parse_mode: 'Markdown'
    }
  );
});

// ==================== ПОДТВЕРЖДЕНИЕ ПОКУПКИ ПОЛЬЗОВАТЕЛЕМ ====================

bot.action('purchase_completed', async (ctx) => {
  try {
    // Проверяем, есть ли у пользователя право на подтверждение покупки
    const hasActiveReservation = await Product.findOne({
      where: {
        reservedBy: ctx.user.telegramId,
        reservedUntil: { [require('sequelize').Op.gt]: new Date() }
      }
    });

    const hasPendingPurchase = await Purchase.findOne({
      where: {
        userId: ctx.user.telegramId,
        status: 'pending'
      }
    });

    const userState = userStates.get(ctx.user.telegramId);
    const hasAdminProcess = userState && (userState.state === 'admin_list_sent' || userState.state === 'admin_file_sent');
    const hasShopProcess = userState && (userState.state === 'shop_list_sent' || userState.state === 'shop_file_sent');

    if (!hasActiveReservation && !hasPendingPurchase && !hasAdminProcess && !hasShopProcess) {
      return ctx.reply(
        `❌ **Нет активных покупок**\n\n` +
        `У вас нет активных резервов или покупок для подтверждения.\n` +
        `Сначала выберите и зарезервируйте товар.`,
        { parse_mode: 'Markdown' }
      );
    }

    await ctx.reply(
      `⏳ **Ожидание подтверждения от администратора**\n\n` +
      `Ваша покупка будет подтверждена администратором после завершения сделки.\n` +
      `Вы получите уведомление с обновленной статистикой.\n\n` +
      `💡 **Примечание:** Администратор указывает точную сумму покупки.`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Ошибка подтверждения покупки:', error);
    await ctx.reply('❌ Произошла ошибка. Попробуйте позже.');
  }
});

// Обработка нажатия кнопки "Подтвердить покупку" админом
bot.action(/confirm_purchase_(\d+)/, async (ctx) => {
  const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id));
  if (!adminIds.includes(ctx.from.id)) {
    return ctx.answerCbQuery('❌ У вас нет прав администратора');
  }

  const buyerId = parseInt(ctx.match[1]);
  
  try {
    // Проверяем, существует ли пользователь
    const buyer = await User.findOne({ where: { telegramId: buyerId } });
    
    if (!buyer) {
      return ctx.answerCbQuery(`❌ Пользователь с ID ${buyerId} не найден`);
    }

    // Устанавливаем состояние ожидания суммы для админа
    adminStates.set(ctx.from.id, {
      state: 'waiting_purchase_amount',
      buyerId: buyerId,
      buyerName: buyer.username || buyer.firstName
    });

    await ctx.answerCbQuery('✅ Введите сумму продажи');
    await ctx.reply(
      `💰 **Подтверждение покупки**\n\n` +
      `👤 **Покупатель:** @${buyer.username || buyer.firstName} (ID: ${buyerId})\n\n` +
      `Укажите сумму продажи в долларах.\n` +
      `Например: \`500\` или \`1250.50\``,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error('Ошибка при обработке подтверждения покупки:', error);
    await ctx.answerCbQuery('❌ Произошла ошибка');
  }
});

// ==================== ДРУГИЕ ОБРАБОТЧИКИ ====================

bot.action('buy_authors', async (ctx) => {
  await ctx.editMessageText(
    `✍️ **Покупка Authors**\n\n` +
    `📝 **Описание:**\n` +
    `Авторские наработки и эксклюзивные материалы.\n\n` +
    `🔧 **Функционал в разработке...**\n` +
    `Скоро будет доступен полный список авторских материалов.`,
    {
      reply_markup: { inline_keyboard: [[{ text: '🔙 Главное меню', callback_data: 'main_menu' }]] },
      parse_mode: 'Markdown'
    }
  );
});

bot.action('seo_menu', async (ctx) => {
  const seoMenu = Markup.inlineKeyboard([
    [Markup.button.callback('👨‍💼 Admin SEO', 'buy_admin_seo')],
    [Markup.button.callback('✍️ Authors SEO', 'buy_authors_seo')],
    [Markup.button.callback('🔙 Главное меню', 'main_menu')]
  ]);

  await ctx.editMessageText(
    '📈 **Покупки SEO**\n\nВыберите категорию:',
    {
      ...seoMenu,
      parse_mode: 'Markdown'
    }
  );
});

bot.action('buy_admin_seo', async (ctx) => {
  await ctx.editMessageText(
    `👨‍💼 **Admin SEO**\n\n` +
    `📝 **Описание:**\n` +
    `SEO инструменты для администраторов с расширенной аналитикой.\n\n` +
    `🔧 **Функционал в разработке...**`,
    {
      reply_markup: { inline_keyboard: [[{ text: '🔙 SEO меню', callback_data: 'seo_menu' }]] },
      parse_mode: 'Markdown'
    }
  );
});

bot.action('buy_authors_seo', async (ctx) => {
  await ctx.editMessageText(
    `✍️ **Authors SEO**\n\n` +
    `📝 **Описание:**\n` +
    `Авторские SEO решения и уникальные методики продвижения.\n\n` +
    `🔧 **Функционал в разработке...**`,
    {
      reply_markup: { inline_keyboard: [[{ text: '🔙 SEO меню', callback_data: 'seo_menu' }]] },
      parse_mode: 'Markdown'
    }
  );
});

bot.action('profile', async (ctx) => {
  try {
    const purchases = await Purchase.findAll({
      where: { userId: ctx.user.telegramId, status: 'confirmed' },
      include: [Product]
    });

    const statusProgress = getStatusProgress(ctx.user.weeklySpent || 0);

    let profileText = `👤 **Ваш личный кабинет**\n\n`;
    profileText += `🏆 Статус: **${ctx.user.status}**\n`;
    profileText += `💰 Потрачено за неделю: **$${ctx.user.weeklySpent || 0}**\n`;
    profileText += `💎 Всего потрачено: **$${ctx.user.totalSpent || 0}**\n`;
    profileText += `🛒 Количество покупок: **${purchases.length}**\n\n`;
    
    // Показываем прогресс до следующего статуса
    if (statusProgress.next) {
      const progressBar = '▓'.repeat(Math.floor(statusProgress.progress / 10)) + 
                         '░'.repeat(10 - Math.floor(statusProgress.progress / 10));
      profileText += `📈 **Прогресс до ${statusProgress.next}:**\n`;
      profileText += `[${progressBar}] ${statusProgress.progress}%\n`;
      profileText += `💸 Осталось потратить: $${statusProgress.needed}\n\n`;
    } else {
      profileText += `👑 **Вы достигли максимального статуса!**\n\n`;
    }
    
    profileText += `📊 **Система статусов:**\n`;
    profileText += `• **Пыль** - до $2000 в неделю\n`;
    profileText += `• **VIP** - $2000+ в неделю\n`;
    profileText += `• **INFINITY** - $8000+ в неделю (максимум)\n\n`;

    if (purchases.length > 0) {
      profileText += `📦 **Ваши покупки:**\n`;
      purchases.slice(0, 5).forEach(p => {
        profileText += `• ${p.Product.name} - ${p.amount}\n`;
      });
      if (purchases.length > 5) {
        profileText += `... и еще ${purchases.length - 5} покупок\n`;
      }
    } else {
      profileText += `📦 **Покупок пока нет**\n`;
      profileText += `Используйте меню для выбора товаров.`;
    }

    const profileMenu = await createMainMenu(ctx.user.telegramId);
    await ctx.editMessageText(profileText, {
      ...profileMenu,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Ошибка профиля:', error);
    if (error.description && error.description.includes('message is not modified')) {
      // Игнорируем ошибку неизмененного сообщения
      return;
    }
    try {
      const errorMenu = await createMainMenu(ctx.user.telegramId);
      await ctx.editMessageText(
        '❌ Ошибка загрузки профиля',
        errorMenu
      );
    } catch (editError) {
      await ctx.reply('❌ Ошибка загрузки профиля');
    }
  }
});

bot.action('support', async (ctx) => {
  try {
    let supportText = `🆘 **Техническая поддержка**\n\n`;
    supportText += `Для связи с администратором используйте:\n\n`;
    supportText += `👨‍💼 **Поддержка:** @chubakabezshersti\n\n`;
    supportText += `📞 Администратор ответит в личных сообщениях в ближайшее время.\n`;
    supportText += `🕐 Время ответа: обычно в течение 30 минут.`;

    // Создаем меню только с кнопкой возврата
    const supportMenu = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Главное меню', 'main_menu')]
    ]);
    
    try {
      await ctx.editMessageText(supportText, {
        ...supportMenu,
        parse_mode: 'Markdown'
      });
    } catch (error) {
      if (error.description && error.description.includes('message is not modified')) {
        // Если сообщение не изменилось, отправляем новое
        await ctx.reply(supportText, {
          ...supportMenu,
          parse_mode: 'Markdown'
        });
        return;
      }
      
      // Если другая ошибка с Markdown, отправляем без форматирования
      console.error('Ошибка поддержки с Markdown:', error);
      try {
        const plainText = `🆘 ТЕХНИЧЕСКАЯ ПОДДЕРЖКА\n\n` +
          `Для связи с администратором используйте:\n\n` +
          `👨‍💼 Поддержка: @chubakabezshersti\n\n` +
          `📞 Администратор ответит в личных сообщениях в ближайшее время.\n` +
          `🕐 Время ответа: обычно в течение 30 минут.`;
          
        await ctx.editMessageText(plainText, supportMenu);
      } catch (finalError) {
        // В крайнем случае отправляем новое сообщение
        await ctx.reply('🆘 Для связи с поддержкой напишите: @chubakabezshersti', supportMenu);
      }
    }
    
  } catch (error) {
    console.error('Ошибка в support:', error);
    await ctx.reply('❌ Ошибка загрузки поддержки. Напишите: @chubakabezshersti');
  }
});

// ==================== АВТОМАТИЧЕСКИЕ ПРОЦЕССЫ ====================

setInterval(async () => {
  try {
    const expiredReservations = await Product.findAll({
      where: {
        reservedBy: { [require('sequelize').Op.not]: null },
        reservedUntil: { [require('sequelize').Op.lt]: new Date() }
      }
    });

    for (const product of expiredReservations) {
      await product.update({
        reservedBy: null,
        reservedUntil: null
      });
      console.log(`⏰ Снят резерв с товара ${product.uniqueCode}`);
    }
  } catch (error) {
    console.error('Ошибка снятия резерва:', error);
  }
}, 60000);

// ==================== ЗАПУСК БОТА ====================

async function startBot() {
  try {
    console.log('🤖 Запуск Telegram бота...');
    
    await syncModels();
    
    await bot.launch();
    console.log('✅ Бот успешно запущен!');
    console.log(`🌐 Админ-панель будет доступна на: http://localhost:${process.env.ADMIN_PANEL_PORT || 3001}`);
    console.log(`🔗 Бот: @${(await bot.telegram.getMe()).username}`);
    console.log(`👨‍💼 Админы: ${process.env.ADMIN_IDS}`);
    
  } catch (error) {
    console.error('❌ Ошибка запуска бота:', error);
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  console.log('🛑 Получен сигнал SIGINT, завершение работы...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('🛑 Получен сигнал SIGTERM, завершение работы...');
  bot.stop('SIGTERM');
});

module.exports = { bot, createMainMenu };

if (require.main === module) {
  startBot();
}