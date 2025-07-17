const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Product = sequelize.define('Product', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  uniqueCode: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  category: {
    type: DataTypes.ENUM('SHOP', 'ADMIN', 'AUTHORS', 'ADMIN_SEO', 'AUTHORS_SEO'),
    allowNull: false
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT
  },
  filePath: {
    type: DataTypes.STRING,
    allowNull: false
  },
  isAvailable: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  reservedBy: {
    type: DataTypes.BIGINT,
    allowNull: true
  },
  reservedUntil: {
    type: DataTypes.DATE,
    allowNull: true
  },
  price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  }
});

module.exports = Product;