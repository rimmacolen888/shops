const sequelize = require('../config/database');
const User = require('./User');
const Product = require('./Product');
const Purchase = require('./Purchase');
const Admin = require('./Admin');
const Notification = require('./Notification');

// Связи между моделями
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

async function syncModels() {
  try {
    await sequelize.sync({ force: false, alter: true });
    console.log('✅ Модели синхронизированы с базой данных');
    
    await createInitialAdmins();
  } catch (error) {
    console.error('❌ Ошибка синхронизации моделей:', error);
  }
}

async function createInitialAdmins() {
  try {
    const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()));
    
    for (const adminId of adminIds) {
      if (adminId && !isNaN(adminId)) {
        await Admin.findOrCreate({
          where: { telegramId: adminId },
          defaults: {
            telegramId: adminId,
            role: adminId === adminIds[0] ? 'super_admin' : 'admin',
            isActive: true,
            notifications: true
          }
        });
      }
    }
    
    console.log(`✅ Инициализированы ${adminIds.length} администраторов`);
  } catch (error) {
    console.error('❌ Ошибка создания администраторов:', error);
  }
}

module.exports = {
  sequelize,
  User,
  Product,
  Purchase,
  Admin,
  Notification,
  syncModels
};