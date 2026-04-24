require('dotenv').config();

module.exports = {
    botToken: process.env.BOT_TOKEN,
    dbPath: './data/bee_calendar.db',
    notificationTime: '08:00', // по умолчанию
    timezone: 'Europe/Moscow'
};