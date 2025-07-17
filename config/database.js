const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres',
    logging: console.log, // Включить для отладки
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    define: {
      timestamps: true,
      underscored: false
    }
  }
);

// Тест подключения
async function testConnection() {
  try {
    await sequelize.authenticate();
    console.log('✅ Подключение к PostgreSQL установлено успешно');
  } catch (error) {
    console.error('❌ Ошибка подключения к базе данных:', error.message);
    console.error('🔧 Проверьте настройки в .env файле');
  }
}

testConnection();

module.exports = sequelize;