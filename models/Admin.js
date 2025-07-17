const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Admin = sequelize.define('Admin', {
  telegramId: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    allowNull: false
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true
  },
  role: {
    type: DataTypes.ENUM('super_admin', 'admin'),
    defaultValue: 'admin'
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  notifications: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
});

module.exports = Admin;