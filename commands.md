🚀 Команды управления проектом Telegram Shop Bot
📁 Основные команды
1. Открытие проекта
cmd# Переход в папку проекта
cd C:\Users\user08jun\telegram-shop-bot

# Проверка что вы в правильной папке
dir
2. Запуск проекта
cmd# 🔥 ОСНОВНАЯ КОМАНДА - Запуск бота + админ-панели
npm run dev:both

# Альтернативные варианты:
npm run dev          # Только бот
npm run admin        # Только админ-панель
npm start           # Продакшен режим
3. После запуска открыть

Админ-панель: http://localhost:3001
Бот: найти @LuxQRWP_bot в Telegram


🛠️ Команды разработки
Тестирование
cmdnpm run test         # Тест подключений к БД и Telegram
Управление зависимостями
cmdnpm install          # Установка всех зависимостей
npm update          # Обновление пакетов
Очистка
cmdnpm cache clean --force    # Очистка кэша npm

🔄 Git команды
Первоначальная настройка
cmdgit init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/USERNAME/telegram-shop-bot.git
git push -u origin main
Ежедневная работа
cmdgit add .                          # Добавить все изменения
git commit -m "Описание изменений" # Зафиксировать изменения
git push origin main               # Отправить на GitHub

git pull origin main               # Получить изменения
git status                         # Проверить статус

🗄️ База данных PostgreSQL
Подключение к БД
cmdpsql -U postgres                  # Подключение как супер-пользователь
psql -U bot_user -d telegram_shop_bot  # Подключение как bot_user
Управление БД
sql-- Создание базы (выполнить один раз)
CREATE DATABASE telegram_shop_bot;
CREATE USER bot_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE telegram_shop_bot TO bot_user;
GRANT ALL ON SCHEMA public TO bot_user;

-- Проверка таблиц
\c telegram_shop_bot
\dt

-- Выход
\q
Бэкап БД
cmdpg_dump -U bot_user -d telegram_shop_bot > backup.sql

🌐 Админ-панель
Доступ

URL: http://localhost:3001
Логин: Ваш Telegram ID
Пароль: admin123 (из .env)

Страницы

/ - Вход
/dashboard - Главная панель
/products - Управление товарами
/users - Управление пользователями


🤖 Telegram бот команды
Команды пользователей
/start - Главное меню
/help - Справка
Команды администраторов
/admin_help - Помощь для админов
/admin_stats - Статистика бота

🔧 Диагностика проблем
Проверка портов
cmdnetstat -an | findstr :3001       # Проверка админ-панели
netstat -an | findstr :3000       # Проверка бота
Убить процесс на порту
cmdnetstat -ano | findstr :3001      # Найти PID процесса
taskkill /PID номер_процесса /F   # Убить процесс
Проверка файлов
cmddir admin-panel                   # Проверить папку админ-панели
dir admin-panel\views             # Проверить HTML файлы
dir models                        # Проверить модели

📊 Мониторинг
Просмотр логов
cmdtype logs\2025-07-15.log          # Просмотр логов за день
dir logs                          # Список всех логов
Очистка логов
cmddel logs\*.log                    # Удалить все логи

🚨 Экстренные команды
Полная остановка
cmdCtrl+C                            # В консоли где запущен проект
Полный перезапуск
cmd# 1. Остановить (Ctrl+C)
# 2. Очистить кэш
npm cache clean --force
# 3. Переустановить зависимости
npm install
# 4. Запустить заново
npm run dev:both
Сброс БД (ОСТОРОЖНО!)
sql-- Подключиться к PostgreSQL
psql -U postgres
-- Удалить и пересоздать БД
DROP DATABASE telegram_shop_bot;
CREATE DATABASE telegram_shop_bot;
GRANT ALL PRIVILEGES ON DATABASE telegram_shop_bot TO bot_user;

🔑 Важные файлы
Конфигурация

.env - Переменные окружения (НЕ commitить!)
package.json - Зависимости и скрипты
.gitignore - Исключения для Git

Основные файлы кода

bot.js - Главный файл бота
admin-panel/server.js - Сервер админ-панели
models/index.js - Модели базы данных


📱 Полезные ссылки

Админ-панель: http://localhost:3001
BotFather: https://t.me/BotFather
GitHub репозиторий: https://github.com/USERNAME/telegram-shop-bot
PostgreSQL документация: https://www.postgresql.org/docs/


⚡ Быстрый старт (копировать и выполнить)
cmdcd C:\Users\user08jun\telegram-shop-bot
npm run dev:both
После запуска открыть:

http://localhost:3001 (админ-панель)
@LuxQRWP_bot в Telegram


🎯 Следующие шаги разработки

✅ Базовый бот работает
✅ Админ-панель работает
✅ Привязка к GitHub
🔄 Добавление функций Admin/Authors товаров
🔄 Система подтверждения покупок
🔄 Развертывание на сервере

Сохраните этот файл как commands.md в папке проекта!