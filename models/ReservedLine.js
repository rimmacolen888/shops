const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const crypto = require('crypto');

const ReservedLine = sequelize.define('ReservedLine', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.BIGINT,
    allowNull: false,
    comment: 'ID пользователя Telegram'
  },
  productId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'ID товара'
  },
  lineContent: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: 'Полная строка с логином/паролем'
  },
  processedContent: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: 'Обработанная строка без логина/пароля'
  },
  lineIndex: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'Позиция в файле (начиная с 0)'
  },
  lineHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    comment: 'SHA256 хеш для уникальности строки'
  },
  status: {
    type: DataTypes.ENUM('reserved', 'sold', 'expired'),
    defaultValue: 'reserved',
    comment: 'Статус строки'
  },
  reservedUntil: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'До какого времени зарезервировано (15 минут)'
  },
  soldAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Время продажи'
  },
  purchaseId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'ID покупки после подтверждения'
  }
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['userId', 'productId']
    },
    {
      fields: ['productId', 'status']
    },
    {
      fields: ['lineHash'],
      unique: true
    },
    {
      fields: ['reservedUntil']
    },
    {
      fields: ['status']
    }
  ]
});

// Методы экземпляра
ReservedLine.prototype.isExpired = function() {
  return this.reservedUntil && new Date() > this.reservedUntil;
};

ReservedLine.prototype.extend = function(minutes = 15) {
  this.reservedUntil = new Date(Date.now() + minutes * 60 * 1000);
  return this.save();
};

ReservedLine.prototype.markAsSold = function(purchaseId) {
  this.status = 'sold';
  this.soldAt = new Date();
  this.purchaseId = purchaseId;
  return this.save();
};

ReservedLine.prototype.expire = function() {
  this.status = 'expired';
  this.reservedUntil = new Date();
  return this.save();
};

// Статические методы
ReservedLine.reserveLines = async function(userId, productId, selectedLines) {
  const reservedLines = [];
  const reserveUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 МИНУТ

  for (const line of selectedLines) {
    const lineHash = crypto.createHash('sha256')
      .update(`${productId}_${line.index}_${line.original}`)
      .digest('hex');

    // Проверяем, не зарезервирована ли уже эта строка
    const existing = await ReservedLine.findOne({
      where: { 
        lineHash,
        status: 'reserved',
        reservedUntil: { [require('sequelize').Op.gt]: new Date() }
      }
    });

    if (existing && existing.userId !== userId) {
      throw new Error(`Строка ${line.index + 1} уже зарезервирована другим пользователем`);
    }

    if (existing && existing.userId === userId) {
      // Продлеваем резерв для того же пользователя на 15 минут
      await existing.extend(15);
      reservedLines.push(existing);
    } else {
      // Создаем новый резерв на 15 минут
      const reserved = await ReservedLine.create({
        userId,
        productId,
        lineContent: line.original,
        processedContent: line.processed,
        lineIndex: line.index,
        lineHash,
        status: 'reserved',
        reservedUntil: reserveUntil
      });
      reservedLines.push(reserved);
    }
  }

  console.log(`🔒 Создано ${reservedLines.length} резервов на 15 минут до ${reserveUntil.toLocaleString('ru-RU')}`);
  return reservedLines;
};

ReservedLine.cleanExpiredReserves = async function() {
  const expiredCount = await ReservedLine.update(
    { status: 'expired' },
    {
      where: {
        status: 'reserved',
        reservedUntil: { [require('sequelize').Op.lt]: new Date() }
      }
    }
  );
  return expiredCount[0];
};

ReservedLine.getUserReservedLines = async function(userId, productId = null) {
  const where = {
    userId,
    status: 'reserved',
    reservedUntil: { [require('sequelize').Op.gt]: new Date() }
  };

  if (productId) {
    where.productId = productId;
  }

  return await ReservedLine.findAll({
    where,
    include: [{
      model: require('./Product'),
      attributes: ['name', 'uniqueCode', 'category']
    }],
    order: [['createdAt', 'DESC']]
  });
};

ReservedLine.confirmSale = async function(userId, productId, purchaseId) {
  const updated = await ReservedLine.update(
    {
      status: 'sold',
      soldAt: new Date(),
      purchaseId
    },
    {
      where: {
        userId,
        productId,
        status: 'reserved'
      }
    }
  );
  return updated[0];
};

ReservedLine.getStatsByUser = async function(userId) {
  const stats = await ReservedLine.findAll({
    where: { userId },
    attributes: [
      'status',
      [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']
    ],
    group: ['status'],
    raw: true
  });

  const result = {
    reserved: 0,
    sold: 0,
    expired: 0,
    total: 0
  };

  stats.forEach(stat => {
    result[stat.status] = parseInt(stat.count);
    result.total += parseInt(stat.count);
  });

  return result;
};

ReservedLine.getStatsByProduct = async function(productId) {
  const stats = await ReservedLine.findAll({
    where: { productId },
    attributes: [
      'status',
      [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count'],
      [require('sequelize').fn('COUNT', require('sequelize').fn('DISTINCT', require('sequelize').col('userId'))), 'uniqueUsers']
    ],
    group: ['status'],
    raw: true
  });

  const result = {
    byStatus: { reserved: 0, sold: 0, expired: 0 },
    totalLines: 0,
    uniqueUsers: 0
  };

  stats.forEach(stat => {
    result.byStatus[stat.status] = parseInt(stat.count);
    result.totalLines += parseInt(stat.count);
    result.uniqueUsers += parseInt(stat.uniqueUsers);
  });

  return result;
};

ReservedLine.extendAllForUser = async function(userId, productId, minutes = 15) {
  const newReservedUntil = new Date(Date.now() + minutes * 60 * 1000);
  
  const updated = await ReservedLine.update(
    { reservedUntil: newReservedUntil },
    {
      where: {
        userId,
        productId,
        status: 'reserved'
      }
    }
  );
  
  return updated[0];
};

ReservedLine.cancelAllForUser = async function(userId, productId = null) {
  const where = {
    userId,
    status: 'reserved'
  };
  
  if (productId) {
    where.productId = productId;
  }
  
  const updated = await ReservedLine.update(
    { 
      status: 'expired',
      reservedUntil: new Date()
    },
    { where }
  );
  
  return updated[0];
};

ReservedLine.getGlobalStats = async function() {
  const totalStats = await ReservedLine.findAll({
    attributes: [
      'status',
      [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count'],
      [require('sequelize').fn('COUNT', require('sequelize').fn('DISTINCT', require('sequelize').col('userId'))), 'uniqueUsers']
    ],
    group: ['status'],
    raw: true
  });

  const result = {
    byStatus: { reserved: 0, sold: 0, expired: 0 },
    totalLines: 0,
    uniqueUsers: new Set()
  };

  // Получаем уникальных пользователей отдельно
  const allUsers = await ReservedLine.findAll({
    attributes: ['userId'],
    group: ['userId'],
    raw: true
  });

  totalStats.forEach(stat => {
    result.byStatus[stat.status] = parseInt(stat.count);
    result.totalLines += parseInt(stat.count);
  });

  result.uniqueUsers = allUsers.length;

  return result;
};

ReservedLine.getTopProducts = async function(limit = 10) {
  return await ReservedLine.findAll({
    attributes: [
      'productId',
      [require('sequelize').fn('COUNT', require('sequelize').col('ReservedLine.id')), 'totalReserved'],
      [require('sequelize').fn('SUM', require('sequelize').literal(`CASE WHEN status = 'sold' THEN 1 ELSE 0 END`)), 'totalSold']
    ],
    include: [
      { 
        model: require('./Product'), 
        attributes: ['name', 'uniqueCode', 'category'] 
      }
    ],
    group: ['productId', 'Product.id'],
    order: [[require('sequelize').fn('COUNT', require('sequelize').col('ReservedLine.id')), 'DESC']],
    limit,
    subQuery: false
  });
};

module.exports = ReservedLine;