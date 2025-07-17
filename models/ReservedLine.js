const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ReservedLine = sequelize.define('ReservedLine', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.BIGINT,
    allowNull: false
  },
  productId: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  lineContent: {
    type: DataTypes.TEXT,
    allowNull: false // Полная строка с логином/паролем
  },
  processedContent: {
    type: DataTypes.TEXT,
    allowNull: false // Обработанная строка без логина/пароля
  },
  lineIndex: {
    type: DataTypes.INTEGER,
    allowNull: false // Позиция в файле
  },
  status: {
    type: DataTypes.ENUM('reserved', 'sold'),
    defaultValue: 'reserved'
  }
});

module.exports = ReservedLine;