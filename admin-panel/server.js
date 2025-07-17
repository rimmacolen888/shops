const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { User, Product, Purchase, Admin, Notification } = require('../models');
require('dotenv').config();

const app = express();

// Middleware безопасности
app.use(helmet({
  contentSecurityPolicy: false // Отключаем для загрузки локальных файлов
}));
app.use(cors());
app.use(express.json({ limit: process.env.UPLOAD_MAX_SIZE }));
app.use(express.urlencoded({ extended: true, limit: process.env.UPLOAD_MAX_SIZE }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100 // лимит запросов на IP
});
app.use('/api', limiter);

// Статические файлы
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const category = req.body.category || 'temp';
    const uploadPath = path.join(__dirname, '../uploads', category.toLowerCase());
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const category = req.body.category || 'TEMP';
    const ext = path.extname(file.originalname);
    cb(null, `${category}_${String(uniqueSuffix).padStart(3, '0')}${ext}`);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.txt', '.zip'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только файлы .txt и .zip'));
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

// Middleware аутентификации
const authenticateAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Токен не предоставлен' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.adminId = decoded.adminId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
};

// ==================== АУТЕНТИФИКАЦИЯ ====================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { password, adminId } = req.body;
    
    // Проверка пароля
    if (password !== process.env.ADMIN_PANEL_PASSWORD) {
      return res.status(401).json({ error: 'Неверный пароль' });
    }

    // Проверка ID администратора
    const adminIds = process.env.ADMIN_IDS.split(',').map(id => parseInt(id));
    if (!adminIds.includes(parseInt(adminId))) {
      return res.status(401).json({ error: 'Неавторизованный администратор' });
    }

    // Создание токена
    const token = jwt.sign(
      { adminId: adminId },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ token, adminId });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================== ТОВАРЫ ====================

app.get('/api/products', authenticateAdmin, async (req, res) => {
  try {
    const products = await Product.findAll({
      order: [['createdAt', 'DESC']]
    });
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения товаров' });
  }
});

app.post('/api/products', authenticateAdmin, upload.single('file'), async (req, res) => {
  try {
    const { category, name, description, price } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'Файл не загружен' });
    }

    // Генерация уникального кода
    const count = await Product.count({ where: { category } });
    const uniqueCode = `${category}_${String(count + 1).padStart(3, '0')}`;

    const product = await Product.create({
      uniqueCode,
      category,
      name,
      description,
      filePath: file.path,
      price: price || null
    });

    res.json(product);
  } catch (error) {
    console.error('Ошибка создания товара:', error);
    res.status(500).json({ error: 'Ошибка создания товара' });
  }
});

app.delete('/api/products/:id', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    // Удаление файла
    const fs = require('fs').promises;
    try {
      await fs.unlink(product.filePath);
    } catch (error) {
      console.log('Файл уже удален или не существует');
    }

    await product.destroy();
    res.json({ message: 'Товар удален' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка удаления товара' });
  }
});

// НОВОЕ: Снятие резерва с товара
app.patch('/api/products/:id/unreserve', authenticateAdmin, async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Товар не найден' });
    }

    await product.update({
      reservedBy: null,
      reservedUntil: null
    });

    res.json({ message: 'Резерв снят', product });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка снятия резерва' });
  }
});

// НОВОЕ: Массовое снятие резерва
app.patch('/api/products/unreserve-all', authenticateAdmin, async (req, res) => {
  try {
    const updatedCount = await Product.update(
      {
        reservedBy: null,
        reservedUntil: null
      },
      {
        where: {
          reservedBy: { [require('sequelize').Op.not]: null }
        }
      }
    );

    res.json({ message: `Резерв снят с ${updatedCount[0]} товаров` });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка снятия резерва' });
  }
});

// ==================== ПОЛЬЗОВАТЕЛИ ====================

app.get('/api/users', authenticateAdmin, async (req, res) => {
  try {
    const users = await User.findAll({
      order: [['createdAt', 'DESC']],
      limit: 100
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения пользователей' });
  }
});

app.patch('/api/users/:id/status', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const user = await User.findByPk(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    await user.update({ status });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка обновления статуса' });
  }
});

// НОВОЕ: Блокировка пользователя
app.patch('/api/users/:id/block', authenticateAdmin, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    await user.update({ isBlocked: true });
    res.json({ message: 'Пользователь заблокирован', user });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка блокировки пользователя' });
  }
});

// НОВОЕ: Разблокировка пользователя
app.patch('/api/users/:id/unblock', authenticateAdmin, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    await user.update({ isBlocked: false });
    res.json({ message: 'Пользователь разблокирован', user });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка разблокировки пользователя' });
  }
});

// ==================== ПОКУПКИ ====================

app.get('/api/purchases', authenticateAdmin, async (req, res) => {
  try {
    const purchases = await Purchase.findAll({
      include: [
        { model: User, attributes: ['telegramId', 'username', 'firstName'] },
        { model: Product, attributes: ['name', 'category', 'uniqueCode'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    res.json(purchases);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения покупок' });
  }
});

// НОВОЕ: Получение детальных покупок с фильтрами
app.get('/api/purchases/detailed', authenticateAdmin, async (req, res) => {
  try {
    const { status, category } = req.query;
    const whereClause = {};
    const productWhere = {};

    if (status) whereClause.status = status;
    if (category) productWhere.category = category;

    const purchases = await Purchase.findAll({
      where: whereClause,
      include: [
        { 
          model: User, 
          attributes: ['telegramId', 'username', 'firstName', 'status', 'totalSpent'] 
        },
        { 
          model: Product, 
          attributes: ['name', 'category', 'uniqueCode', 'description'],
          where: Object.keys(productWhere).length > 0 ? productWhere : undefined
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    res.json(purchases);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения покупок' });
  }
});

app.post('/api/purchases/:id/confirm', authenticateAdmin, async (req, res) => {
  try {
    const { amount } = req.body;
    const purchase = await Purchase.findByPk(req.params.id, {
      include: [User, Product]
    });

    if (!purchase) {
      return res.status(404).json({ error: 'Покупка не найдена' });
    }

    await purchase.update({
      status: 'confirmed',
      amount: amount,
      confirmedBy: req.adminId
    });

    // Обновление статистики пользователя
    const user = purchase.User;
    await user.update({
      weeklySpent: parseFloat(user.weeklySpent) + parseFloat(amount),
      totalSpent: parseFloat(user.totalSpent) + parseFloat(amount)
    });

    // Обновление статуса пользователя
    const newStatus = user.weeklySpent >= 2000 ? 'LUXtop10' : 'Пыль';
    if (user.status !== newStatus) {
      await user.update({ status: newStatus });
    }

    res.json(purchase);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка подтверждения покупки' });
  }
});

// НОВОЕ: Отклонение заявки на покупку
app.patch('/api/purchases/:id/reject', authenticateAdmin, async (req, res) => {
  try {
    const purchase = await Purchase.findByPk(req.params.id, {
      include: [Product]
    });

    if (!purchase) {
      return res.status(404).json({ error: 'Покупка не найдена' });
    }

    // Отменяем покупку
    await purchase.update({ status: 'cancelled' });

    // Снимаем резерв с товара
    if (purchase.Product) {
      await purchase.Product.update({
        reservedBy: null,
        reservedUntil: null
      });
    }

    res.json({ message: 'Заявка отклонена, резерв снят' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка отклонения заявки' });
  }
});

// НОВОЕ: Подтверждение самостоятельной покупки пользователем
app.post('/api/purchases/self-confirm', authenticateAdmin, async (req, res) => {
  try {
    const { userId, productCode, amount } = req.body;

    const user = await User.findByPk(userId);
    const product = await Product.findOne({ where: { uniqueCode: productCode } });

    if (!user || !product) {
      return res.status(404).json({ error: 'Пользователь или товар не найдены' });
    }

    // Создаем подтвержденную покупку
    const purchase = await Purchase.create({
      userId: userId,
      productId: product.id,
      amount: parseFloat(amount),
      status: 'confirmed',
      confirmedBy: req.adminId
    });

    // Обновляем статистику пользователя
    const newWeeklySpent = parseFloat(user.weeklySpent || 0) + parseFloat(amount);
    const newTotalSpent = parseFloat(user.totalSpent || 0) + parseFloat(amount);
    
    let newStatus = user.status;
    if (newWeeklySpent >= 2000) {
      newStatus = 'LUXtop10';
    } else if (newWeeklySpent >= 1000) {
      newStatus = 'TOP10';
    }

    await user.update({
      weeklySpent: newWeeklySpent,
      totalSpent: newTotalSpent,
      status: newStatus
    });

    // Снимаем резерв с товара
    await product.update({
      reservedBy: null,
      reservedUntil: null
    });

    res.json({ 
      message: 'Покупка подтверждена',
      purchase,
      user: {
        ...user.toJSON(),
        weeklySpent: newWeeklySpent,
        totalSpent: newTotalSpent,
        status: newStatus
      }
    });
  } catch (error) {
    console.error('Ошибка подтверждения покупки:', error);
    res.status(500).json({ error: 'Ошибка подтверждения покупки' });
  }
});

// ==================== СТАТИСТИКА ====================

app.get('/api/stats', authenticateAdmin, async (req, res) => {
  try {
    const totalUsers = await User.count();
    const totalProducts = await Product.count();
    const totalPurchases = await Purchase.count({ where: { status: 'confirmed' } });
    const pendingPurchases = await Purchase.count({ where: { status: 'pending' } });
    
    const revenue = await Purchase.sum('amount', { 
      where: { status: 'confirmed' } 
    }) || 0;

    const recentUsers = await User.count({
      where: {
        createdAt: {
          [require('sequelize').Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        }
      }
    });

    // НОВОЕ: Дополнительная статистика
    const reservedProducts = await Product.count({
      where: {
        reservedBy: { [require('sequelize').Op.not]: null }
      }
    });

    const blockedUsers = await User.count({
      where: { isBlocked: true }
    });

    const categoryStats = await Product.count({
      group: ['category'],
      attributes: ['category']
    });

    res.json({
      totalUsers,
      totalProducts,
      totalPurchases,
      pendingPurchases,
      revenue,
      recentUsers,
      reservedProducts,
      blockedUsers,
      categoryStats
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения статистики' });
  }
});

// НОВОЕ: Статистика по категориям
app.get('/api/stats/categories', authenticateAdmin, async (req, res) => {
  try {
    const stats = await Promise.all([
      Product.count({ where: { category: 'SHOP' } }),
      Product.count({ where: { category: 'ADMIN' } }),
      Product.count({ where: { category: 'AUTHORS' } }),
      Product.count({ where: { category: 'ADMIN_SEO' } }),
      Product.count({ where: { category: 'AUTHORS_SEO' } })
    ]);

    res.json({
      SHOP: stats[0],
      ADMIN: stats[1],
      AUTHORS: stats[2],
      ADMIN_SEO: stats[3],
      AUTHORS_SEO: stats[4]
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения статистики категорий' });
  }
});

// ==================== СИСТЕМНЫЕ ФУНКЦИИ ====================

// НОВОЕ: Очистка истекших резервов
app.post('/api/system/clean-expired-reserves', authenticateAdmin, async (req, res) => {
  try {
    const expiredCount = await Product.update(
      {
        reservedBy: null,
        reservedUntil: null
      },
      {
        where: {
          reservedBy: { [require('sequelize').Op.not]: null },
          reservedUntil: { [require('sequelize').Op.lt]: new Date() }
        }
      }
    );

    res.json({ message: `Очищено ${expiredCount[0]} истекших резервов` });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка очистки резервов' });
  }
});

// НОВОЕ: Экспорт данных
app.get('/api/export/users', authenticateAdmin, async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['telegramId', 'username', 'firstName', 'status', 'totalSpent', 'createdAt']
    });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=users.json');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка экспорта пользователей' });
  }
});

app.get('/api/export/purchases', authenticateAdmin, async (req, res) => {
  try {
    const purchases = await Purchase.findAll({
      include: [
        { model: User, attributes: ['telegramId', 'username'] },
        { model: Product, attributes: ['name', 'category', 'uniqueCode'] }
      ]
    });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=purchases.json');
    res.json(purchases);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка экспорта покупок' });
  }
});

// ==================== HTML СТРАНИЦЫ ====================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/dashboard.html'));
});

app.get('/products', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/products.html'));
});

app.get('/users', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/users.html'));
});

// НОВОЕ: Страница управления покупками
app.get('/purchases', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/purchases.html'));
});

// ==================== ЗАПУСК СЕРВЕРА ====================

const PORT = process.env.ADMIN_PANEL_PORT || 3001;
app.listen(PORT, () => {
  console.log(`🌐 Админ-панель запущена на порту ${PORT}`);
  console.log(`🔗 Откройте http://localhost:${PORT} для доступа`);
  console.log(`📊 Доступные страницы:`);
  console.log(`   - http://localhost:${PORT} (Вход)`);
  console.log(`   - http://localhost:${PORT}/dashboard (Панель управления)`);
  console.log(`   - http://localhost:${PORT}/products (Товары)`);
  console.log(`   - http://localhost:${PORT}/users (Пользователи)`);
  console.log(`   - http://localhost:${PORT}/purchases (Покупки)`);
});

module.exports = app;