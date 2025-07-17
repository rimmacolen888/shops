require('dotenv').config();
const { sequelize } = require('../models');

async function testConnection() {
  console.log('🧪 Тестирование подключений...\n');

  // Тест переменных окружения
  console.log('📋 Проверка переменных окружения:');
  const requiredVars = ['BOT_TOKEN', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'ADMIN_IDS'];
  
  for (const varName of requiredVars) {
    const value = process.env[varName];
    console.log(`   ${varName}: ${value ? '✅ Установлено' : '❌ Отсутствует'}`);
  }
  console.log('');

  // Тест подключения к базе данных
  console.log('🗄️ Тестирование подключения к PostgreSQL:');
  try {
    await sequelize.authenticate();
    console.log('   ✅ Подключение к базе данных успешно');
    
    const tables = await sequelize.getQueryInterface().showAllTables();
    console.log(`   📊 Найдено таблиц: ${tables.length}`);
    
  } catch (error) {
    console.log('   ❌ Ошибка подключения к базе данных');
    console.log(`   📝 Детали: ${error.message}`);
  }

  // Тест Telegram токена
  console.log('\n📱 Тестирование Telegram токена:');
  if (process.env.BOT_TOKEN) {
    const { Telegraf } = require('telegraf');
    const testBot = new Telegraf(process.env.BOT_TOKEN);
    
    try {
      const me = await testBot.telegram.getMe();
      console.log(`   ✅ Токен валиден, бот: @${me.username}`);
    } catch (error) {
      console.log('   ❌ Недействительный токен');
    }
  } else {
    console.log('   ❌ Токен не установлен в .env');
  }

  console.log('\n🏁 Тестирование завершено');
  process.exit(0);
}

testConnection().catch(error => {
  console.error('❌ Критическая ошибка тестирования:', error);
  process.exit(1);
});