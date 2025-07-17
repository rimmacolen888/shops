const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
  telegramId: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    allowNull: false
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true
  },
  firstName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  lastName: {
    type: DataTypes.STRING,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('Пыль', 'VIP', 'PREMIUM', 'INFINITY'),
    defaultValue: 'Пыль'
  },
  weeklySpent: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  totalSpent: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0
  },
  lastActivity: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  isBlocked: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
});

module.exports = User;