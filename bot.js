const { Telegraf, Markup } = require('telegraf');
const { syncModels, User, Product, Purchase, Admin, ReservedLine } = require('./models');
const fs = require('fs').promises;
const path = require('path');
const LineReservationManager = require('./utils/lineReservation');
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

    const hasReservedLines = await ReservedLine.findOne({
      where: {
        userId: userId,
        status: 'reserved',
        reservedUntil: { [require('sequelize').Op.gt]: new Date() }
      }
    });

    const userState = userStates.get(userId);
    const hasAdminProcess = userState && (userState.state === 'admin_list_sent' || userState.state === 'admin_file_sent');
    const hasShopProcess = userState && (userState.state === 'shop_list_sent' || userState.state === 'shop_file_sent' || userState.state === 'shop_lines_reserved');

    const buttons = [
      [Markup.button.callback('🛍️ Купить Shop', 'buy_shop')],
      [Markup.button.callback('👨‍💼 Купить Admin', 'buy_admin')],
      [Markup.button.callback('✍️ Купить Authors', 'buy_authors')],
      [Markup.button.callback('📈 Покупки SEO', 'seo_menu')],
      [Markup.button.callback('👤 Личный кабинет', 'profile')]
    ];

    // Показываем кнопку "Товар куплен" только если есть активная покупка
    if (hasActiveReservation || hasPendingPurchase || hasAdminProcess || hasShopProcess || hasReservedLines) {
      buttons.push([Markup.button.callback('💰 Товар куплен', 'purchase_completed')]);
    }

    // Показываем кнопку резерва если есть зарезервированные строки
    if (hasReservedLines) {
      buttons.push([Markup.button.callback('📋 Мои резервы', 'show_reserved_lines')]);
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
    
    // Проверяем, есть ли зарезервированные строки
    const reservedLines = await ReservedLine.findAll({
      where: {
        userId: buyer.telegramId,
        status: 'reserved'
      },
      include: [Product]
    });

    const newWeeklySpent = parseFloat(buyer.weeklySpent || 0) + amount;
    const newTotalSpent = parseFloat(buyer.totalSpent || 0) + amount;
    
    const oldStatus = buyer.status;
    const newStatus = getUserStatus(newWeeklySpent);

    // Создаем покупку
    const purchase = await Purchase.create({
      userId: buyer.telegramId,
      productId: reservedLines.length > 0 ? reservedLines[0].productId : null,
      amount: amount,
      status: 'confirmed',
      confirmedBy: ctx.from.id
    });

    // Обновляем статистику покупателя
    await buyer.update({
      weeklySpent: newWeeklySpent,
      totalSpent: newTotalSpent,
      status: newStatus
    });

    // ПОДТВЕРЖДАЕМ ПРОДАЖУ ЗАРЕЗЕРВИРОВАННЫХ СТРОК
    if (reservedLines.length > 0) {
      const productId = reservedLines[0].productId;
      
      // Помечаем строки как проданные
      await LineReservationManager.confirmSale(buyer.telegramId, productId, purchase.id);
      
      // Создаем файл с полными данными для покупателя
      try {
        const fullDataFile = await LineReservationManager.createReservedLinesFile(
          buyer.telegramId, 
          productId
        );

        // Отправляем покупателю файл с ПОЛНЫМИ данными
        await ctx.telegram.sendDocument(
          buyer.telegramId,
          { source: fullDataFile.filePath },
          {
            caption: `🎉 **ПОКУПКА ПОДТВЕРЖДЕНА!**\n\n` +
              `✅ **Получены полные данные доступа**\n` +
              `📦 **Товар:** ${reservedLines[0].Product.name}\n` +
              `🔒 **Строк:** ${fullDataFile.count}\n` +
              `💰 **Сумма:** $${amount}\n\n` +
              `🔑 **В файле содержатся логины и пароли!**\n` +
              `🏆 **Ваш статус:** ${newStatus}\n\n` +
              `Спасибо за покупку! 🛍️`,
            parse_mode: 'Markdown'
          }
        );

        // Удаляем временный файл
        setTimeout(async () => {
          try {
            await fs.unlink(fullDataFile.filePath);
          } catch (cleanupError) {
            console.error('Ошибка удаления файла:', cleanupError);
          }
        }, 30000); // 30 секунд

      } catch (fileError) {
        console.error('Ошибка создания файла с полными данными:', fileError);
        await ctx.telegram.sendMessage(
          buyer.telegramId,
          `✅ **ПОКУПКА ПОДТВЕРЖДЕНА!**\n\n` +
          `💰 Сумма: $${amount}\n` +
          `🏆 Статус: ${newStatus}\n\n` +
          `⚠️ Возникла техническая ошибка с файлом.\n` +
          `Обратитесь к администратору: @chubakabezshersti`,
          { parse_mode: 'Markdown' }
        );
      }
    } else {
      // Стандартное уведомление для товаров без резервирования строк
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
        const statusProgress = getStatusProgress(newWeeklySpent);
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

        // Отправляем покупателю уведомление с обновленным меню
        const buyerMenu = await createMainMenu(buyer.telegramId);
        await ctx.telegram.sendMessage(buyer.telegramId, buyerResponseText, {
          ...buyerMenu
        });

      } catch (buyerError) {
        console.error('Ошибка уведомления покупателя:', buyerError);
        await ctx.reply(`⚠️ Продажа подтверждена, но не удалось уведомить покупателя (ID: ${buyer.telegramId})`);
      }
    }

    // Очищаем состояния покупателя
    userStates.delete(buyer.telegramId);
    
    // Снимаем резервы с товаров
    await Product.update(
      { reservedBy: null, reservedUntil: null },
      { where: { reservedBy: buyer.telegramId } }
    );

    // Ответ администратору
    let adminResponseText = `✅ ПРОДАЖА ПОДТВЕРЖДЕНА!\n\n`;
    adminResponseText += `👤 Покупатель: @${buyer.username || buyer.firstName} (ID: ${buyer.telegramId})\n`;
    adminResponseText += `💰 Сумма: $${amount}\n`;
    
    if (reservedLines.length > 0) {
      adminResponseText += `🔒 Строк продано: ${reservedLines.length}\n`;
      adminResponseText += `📦 Товар: ${reservedLines[0].Product.name}\n`;
      adminResponseText += `📤 Покупатель получил файл с полными данными\n`;
    }
    
    adminResponseText += `📊 Новый статус: ${newStatus}\n`;
    adminResponseText += `💎 Всего потрачено: $${newTotalSpent}`;

    await ctx.reply(adminResponseText);

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

🆕 **НОВАЯ СИСТЕМА РЕЗЕРВИРОВАНИЯ СТРОК:**
Выберите нужные строки → они резервируются за вами → оплатите → получите полные данные!

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

    // Статистика резервов
    const totalReservedLines = await ReservedLine.count();
    const activeReservedLines = await ReservedLine.count({
      where: {
        status: 'reserved',
        reservedUntil: { [require('sequelize').Op.gt]: new Date() }
      }
    });
    const soldLines = await ReservedLine.count({
      where: { status: 'sold' }
    });

    const statsText = `📊 **Статистика бота:**

👥 **Пользователи:** ${totalUsers}
📦 **Товары:** ${totalProducts}  
✅ **Завершенные покупки:** ${totalPurchases}
⏳ **Ожидающие покупки:** ${pendingPurchases}
💰 **Общая выручка:** $${revenue}

🔒 **РЕЗЕРВЫ СТРОК:**
📋 **Всего зарезервировано:** ${totalReservedLines}
⚡ **Активных резервов:** ${activeReservedLines}
✅ **Продано строк:** ${soldLines}

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

  // Обработка Shop списка с резервированием строк
  if (!isAdmin) {
    const text = ctx.message.text.trim();
    const userState = userStates.get(ctx.user.telegramId);

    // Пропускаем команды
    if (text.startsWith('/')) {
      console.log(`⚡ Команда ${text} пропущена обработчиком текста`);
      return;
    }

    console.log(`📝 Обработка текста от ${ctx.user.telegramId}: "${text}"`);

    // 1. НОВОЕ: Обработка Shop списка с резервированием строк
    if (userState && userState.state === 'shop_file_sent') {
      console.log(`🛍️ Пользователь выбирает Shop строки: ${ctx.user.telegramId}`);
      
      try {
        // Парсим выбранные строки
        const selectedLines = text.split('\n').filter(line => line.trim());
        
        if (selectedLines.length === 0) {
          return ctx.reply(
            '❌ **Пустой список**\n\n' +
            'Отправьте строки из файла, которые хотите купить.',
            { parse_mode: 'Markdown' }
          );
        }

        // Показываем процесс резервирования
        const processingMsg = await ctx.reply(
          `⏳ **Резервирование ${selectedLines.length} строк...**\n\n` +
          `Проверяем доступность и резервируем за вами выбранные позиции.`,
          { parse_mode: 'Markdown' }
        );

        // РЕЗЕРВИРУЕМ СТРОКИ
        const reservationResult = await LineReservationManager.reserveLines(
          ctx.user.telegramId,
          userState.productId,
          selectedLines
        );

        if (!reservationResult.success) {
          await ctx.telegram.editMessageText(
            ctx.chat.id,
            processingMsg.message_id,
            undefined,
            `❌ **Ошибка резервирования**\n\n${reservationResult.error}`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        // Обновляем состояние пользователя
        userStates.set(ctx.user.telegramId, {
          ...userState,
          state: 'shop_lines_reserved',
          reservedCount: reservationResult.count
        });

        // Уведомляем об успешном резервировании
        const successMenu = Markup.inlineKeyboard([
          [Markup.button.callback('📋 Показать резерв', 'show_reserved_lines')],
          [Markup.button.callback('💰 Товар куплен', 'purchase_completed')],
          [Markup.button.callback('🔙 Главное меню', 'main_menu')]
        ]);

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          undefined,
          `✅ **СТРОКИ ЗАРЕЗЕРВИРОВАНЫ!**\n\n` +
          `🔒 **Зарезервировано:** ${reservationResult.count} строк\n` +
          `⏰ **Резерв до:** ${reservationResult.reservedUntil.toLocaleString('ru-RU')}\n\n` +
          `💡 **Что дальше:**\n` +
          `• Свяжитесь с администратором для оплаты\n` +
          `• После оплаты нажмите "💰 Товар куплен"\n` +
          `• Получите файл с ПОЛНЫМИ данными доступа\n\n` +
          `🔗 **Поддержка:** @chubakabezshersti`,
          {
            parse_mode: 'Markdown',
            reply_markup: successMenu.reply_markup
          }
        );

        // Уведомляем админов с подробностями
        await sendAdminNotification(ctx,
          `🔒 ЗАРЕЗЕРВИРОВАНЫ SHOP СТРОКИ\n\n` +
          `👤 Пользователь: @${escapeMarkdown(ctx.user.username || ctx.user.firstName)}\n` +
          `📱 ID: ${ctx.user.telegramId}\n` +
          `🏆 Статус: ${ctx.user.status}\n\n` +
          `📦 Товар: ${userState.productCode}\n` +
          `🔒 Зарезервировано: ${reservationResult.count} строк\n` +
          `⏰ Резерв до: ${reservationResult.reservedUntil.toLocaleString('ru-RU')}\n\n` +
          `💬 ВЫБРАННЫЕ СТРОКИ:\n${escapeMarkdown(text)}\n\n` +
          `💡 Свяжитесь с пользователем для завершения сделки`,
          {},
          true,
          ctx.user.telegramId
        );

      } catch (error) {
        console.error('Ошибка резервирования Shop строк:', error);
        await ctx.reply(
          '❌ **Произошла ошибка**\n\n' +
          'Не удалось зарезервировать строки. Попробуйте позже.',
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    // 2. Обработка Admin списка (как раньше)
    if (userState && userState.state === 'admin_file_sent') {
      const lines = text.split('\n').filter(line => line.trim());
      const domainPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}$/;
      
      if (lines.length > 0 && lines.some(line => domainPattern.test(line.trim()))) {
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
          `✅ **Admin список получен!**\n\n` +
          `📝 **Количество доменов:** ${lines.length}\n\n` +
          `Ваш список отправлен администратору.\n` +
          `После покупки нажмите "💰 Товар куплен".`,
          { 
            ...purchaseMenu,
            parse_mode: 'Markdown' 
          }
        );

        await sendListToAdmins(ctx, userState.productCode, text, 'text', null, 'ADMIN');
        return;
      }
    }

    // 3. Справка
    const helpMainMenu = await createMainMenu(ctx.user.telegramId);
    await ctx.reply(
      `ℹ️ **Новая система покупок!**\n\n` +
      `🛍️ **Shop товары:**\n` +
      `• Выберите товар → получите preview\n` +
      `• Отправьте нужные строки → резервирование\n` +
      `• Оплатите → получите полные данные\n\n` +
      `👨‍💼 **Admin товары:**\n` +
      `• Стандартный процесс с доменами\n\n` +
      `**Резервирование гарантирует, что выбранные строки достанутся именно вам!**`,
      { 
        ...helpMainMenu,
        parse_mode: 'Markdown'
      }
    );
  }
  
  // Передаем обработку дальше для обычных пользователей
  return next();
});

// ==================== SHOP ТОВАРЫ С РЕЗЕРВИРОВАНИЕМ ====================

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
    messageText += `🆕 **НОВАЯ СИСТЕМА РЕЗЕРВИРОВАНИЯ:**\n`;
    messageText += `• Выберите товар из списка ниже\n`;
    messageText += `• Получите preview файл (логины скрыты)\n`;
    messageText += `• Выберите нужные строки\n`;
    messageText += `• Строки резервируются ЗА ВАМИ\n`;
    messageText += `• После оплаты получите ПОЛНЫЕ данные\n\n`;
    
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

    // Отправляем файл с анализом (СКРЫТЫЕ логины/пароли)
    try {
      let fileContent = '';
      let processedContent = '';
      
      try {
        fileContent = await fs.readFile(product.filePath, 'utf8');
        const processedLines = LineReservationManager.processFileLines(fileContent, true);
        processedContent = processedLines.join('\n');
      } catch (fileError) {
        console.error('Ошибка чтения файла товара:', fileError);
        processedContent = 'Ошибка загрузки данных товара';
      }

      // Создаем временный файл с обработанными данными
      const tempFileName = `preview_${product.uniqueCode}_${Date.now()}.txt`;
      const tempFilePath = path.join(__dirname, 'temp', tempFileName);
      
      await fs.mkdir(path.join(__dirname, 'temp'), { recursive: true });
      await fs.writeFile(tempFilePath, processedContent, 'utf8');

      await ctx.replyWithDocument(
        { source: tempFilePath },
        {
          caption: `🛍️ **SHOP товар: ${product.name}**\n\n` +
            `🆕 **НОВЫЙ ПРОЦЕСС С РЕЗЕРВИРОВАНИЕМ:**\n` +
            `1️⃣ Изучите список магазинов в файле\n` +
            `2️⃣ Скопируйте нужные строки и отправьте их боту\n` +
            `3️⃣ Строки будут ЗАРЕЗЕРВИРОВАНЫ за вами\n` +
            `4️⃣ После оплаты получите ПОЛНЫЕ данные\n\n` +
            `⚠️ **ВАЖНО:** Логины/пароли скрыты для безопасности\n` +
            `💰 После покупки получите полные доступы\n` +
            `⏰ **Резерв до:** ${reserveUntil.toLocaleString('ru-RU')}\n\n` +
            `**Отправьте выбранные строки в следующем сообщении:**`,
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
      await sendAdminNotification(ctx,
        `🛍️ ЗАПРОС SHOP ТОВАРА\n\n` +
        `👤 Пользователь: @${escapeMarkdown(ctx.user.username || ctx.user.firstName)}\n` +
        `📱 ID: ${ctx.user.telegramId}\n` +
        `🏆 Статус: ${ctx.user.status}\n\n` +
        `📦 Товар: ${escapeMarkdown(product.name)}\n` +
        `🔗 Код: ${product.uniqueCode}\n` +
        `📁 Preview файл отправлен (логины/пароли скрыты)\n` +
        `⏰ Резерв до: ${reserveUntil.toLocaleString('ru-RU')}\n\n` +
        `💡 Пользователь выберет строки для резервирования`,
        {},
        false,
        ctx.user.telegramId
      );

    } catch (error) {
      console.error('Ошибка отправки файла:', error);
      await ctx.reply('❌ **Ошибка отправки файла**\n\nОбратитесь к администратору.');
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
    messageText += `📝 **Процесс покупки:**\n`;
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

      // Уведомляем админов
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
      await ctx.reply('❌ **Ошибка отправки файла**\n\nОбратитесь к администратору.');
    }

  } catch (error) {
    console.error('Ошибка выбора Admin товара:', error);
    await ctx.reply('❌ Ошибка обработки запроса');
  }
});

// ==================== ОБРАБОТКА ФАЙЛОВ ====================

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
      
      // Скачиваем и читаем содержимое
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

// ==================== НОВЫЕ ОБРАБОТЧИКИ КНОПОК ====================

// Показать зарезервированные строки
bot.action('show_reserved_lines', async (ctx) => {
  try {
    const reservedLines = await ReservedLine.findAll({
      where: {
        userId: ctx.user.telegramId,
        status: 'reserved',
        reservedUntil: { [require('sequelize').Op.gt]: new Date() }
      },
      include: [Product],
      order: [['createdAt', 'DESC']]
    });

    if (reservedLines.length === 0) {
      return ctx.answerCbQuery('❌ У вас нет активных резервов');
    }

    // Группируем по товарам
    const byProducts = {};
    reservedLines.forEach(line => {
      const productId = line.productId;
      if (!byProducts[productId]) {
        byProducts[productId] = {
          product: line.Product,
          lines: [],
          count: 0
        };
      }
      byProducts[productId].lines.push(line);
      byProducts[productId].count++;
    });

    let reserveText = `📋 **ВАШИ ЗАРЕЗЕРВИРОВАННЫЕ СТРОКИ**\n\n`;
    
    Object.values(byProducts).forEach(productData => {
      reserveText += `📦 **${productData.product.name}**\n`;
      reserveText += `🔒 Строк: ${productData.count}\n`;
      reserveText += `⏰ До: ${productData.lines[0].reservedUntil.toLocaleString('ru-RU')}\n\n`;
      
      productData.lines.slice(0, 3).forEach((line, index) => {
        reserveText += `${index + 1}. ${line.processedContent.slice(0, 80)}...\n`;
      });
      
      if (productData.count > 3) {
        reserveText += `... и еще ${productData.count - 3} строк\n`;
      }
      reserveText += `\n`;
    });
    
    reserveText += `💡 После оплаты получите файл с полными данными!`;

    await ctx.reply(reserveText, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery('✅ Показаны зарезервированные строки');

  } catch (error) {
    console.error('Ошибка показа резерва:', error);
    await ctx.answerCbQuery('❌ Ошибка загрузки резерва');
  }
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

    const hasReservedLines = await ReservedLine.findOne({
      where: {
        userId: ctx.user.telegramId,
        status: 'reserved',
        reservedUntil: { [require('sequelize').Op.gt]: new Date() }
      }
    });

    const userState = userStates.get(ctx.user.telegramId);
    const hasAdminProcess = userState && (userState.state === 'admin_list_sent' || userState.state === 'admin_file_sent');
    const hasShopProcess = userState && (userState.state === 'shop_list_sent' || userState.state === 'shop_file_sent' || userState.state === 'shop_lines_reserved');

    if (!hasActiveReservation && !hasPendingPurchase && !hasAdminProcess && !hasShopProcess && !hasReservedLines) {
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

    const reservedLinesStats = await LineReservationManager.getUserReservationStats(ctx.user.telegramId);
    const statusProgress = getStatusProgress(ctx.user.weeklySpent || 0);

    let profileText = `👤 **Ваш личный кабинет**\n\n`;
    profileText += `🏆 Статус: **${ctx.user.status}**\n`;
    profileText += `💰 Потрачено за неделю: **${ctx.user.weeklySpent || 0}**\n`;
    profileText += `💎 Всего потрачено: **${ctx.user.totalSpent || 0}**\n`;
    profileText += `🛒 Количество покупок: **${purchases.length}**\n\n`;
    
    // Статистика резервов
    if (reservedLinesStats.total > 0) {
      profileText += `📋 **РЕЗЕРВЫ СТРОК:**\n`;
      profileText += `🔒 Зарезервировано: ${reservedLinesStats.reserved}\n`;
      profileText += `✅ Куплено: ${reservedLinesStats.sold}\n`;
      profileText += `⏰ Истекло: ${reservedLinesStats.expired}\n\n`;
    }
    
    // Показываем прогресс до следующего статуса
    if (statusProgress.next) {
      const progressBar = '▓'.repeat(Math.floor(statusProgress.progress / 10)) + 
                         '░'.repeat(10 - Math.floor(statusProgress.progress / 10));
      profileText += `📈 **Прогресс до ${statusProgress.next}:**\n`;
      profileText += `[${progressBar}] ${statusProgress.progress}%\n`;
      profileText += `💸 Осталось потратить: ${statusProgress.needed}\n\n`;
    } else {
      profileText += `👑 **Вы достигли максимального статуса!**\n\n`;
    }
    
    profileText += `📊 **Система статусов:**\n`;
    profileText += `• **Пыль** - до $2000 в неделю\n`;
    profileText += `• **VIP** - $2000+ в неделю\n`;
    profileText += `• **PREMIUM** - $5000+ в неделю\n`;
    profileText += `• **INFINITY** - $8000+ в неделю (максимум)\n\n`;

    if (purchases.length > 0) {
      profileText += `📦 **Ваши покупки:**\n`;
      purchases.slice(0, 5).forEach(p => {
        profileText += `• ${p.Product?.name || 'Неизвестный товар'} - ${p.amount}\n`;
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
    supportText += `🕐 Время ответа: обычно в течение 30 минут.\n\n`;
    supportText += `🆕 **НОВАЯ СИСТЕМА РЕЗЕРВИРОВАНИЯ:**\n`;
    supportText += `• Строки резервируются только за вами\n`;
    supportText += `• Полные данные после оплаты\n`;
    supportText += `• Гарантия получения выбранных позиций`;

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
          `🕐 Время ответа: обычно в течение 30 минут.\n\n` +
          `🆕 НОВАЯ СИСТЕМА РЕЗЕРВИРОВАНИЯ:\n` +
          `• Строки резервируются только за вами\n` +
          `• Полные данные после оплаты\n` +
          `• Гарантия получения выбранных позиций`;
          
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
    // Очищаем истекшие резервы товаров
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

    // Очищаем истекшие резервы строк
    const expiredLinesCount = await LineReservationManager.cleanExpiredReserves();
    
  } catch (error) {
    console.error('Ошибка автоочистки:', error);
  }
}, 60000); // Каждую минуту

// ==================== ЗАПУСК БОТА ====================

async function startBot() {
  try {
    console.log('🤖 Запуск Telegram бота...');
    
    await syncModels();
    
    await bot.launch();
    console.log('✅ Бот успешно запущен!');
    console.log('🆕 НОВАЯ СИСТЕМА РЕЗЕРВИРОВАНИЯ СТРОК АКТИВНА!');
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