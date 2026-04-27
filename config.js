require('dotenv').config();
const { envPath, ensureDirectories } = require('./paths');

// Обеспечиваем создание папок
ensureDirectories();

module.exports = {
    botToken: process.env.BOT_TOKEN,
    dbPath: './data/bee_calendar.db',  // Относительный путь, будет дополнен в database.js
    notificationTime: '08:00',
    timezone: 'Europe/Moscow'
};