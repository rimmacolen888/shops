const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PurchaseState = sequelize.define('PurchaseState', {
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
  state: {
    type: DataTypes.ENUM('file_sent', 'waiting_list', 'list_sent', 'waiting_confirm', 'completed'),
    defaultValue: 'file_sent'
  },
  userList: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  messageData: {
    type: DataTypes.JSONB,
    defaultValue: {}
  }
});

module.exports = PurchaseState;