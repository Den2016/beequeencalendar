const path = require('path');
const fs = require('fs');
const os = require('os');

function getAppRoot() {
    if (process.env.NODE_ENV === 'development') {
        return __dirname;
    }
    return path.dirname(process.execPath);
}

// Для данных используем AppData/Roaming
function getDataRoot() {
    if (process.env.NODE_ENV === 'development') {
        return getAppRoot();
    }
    // В Windows: C:\Users\USER\AppData\Roaming\BeeTelegramBot
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'BeeTelegramBot');
}

const appRoot = getAppRoot();
const dataRoot = getDataRoot();

// Путь к .env - рядом с exe (пользователь может его редактировать)
const envPath = path.join(appRoot, '.env');

// Папки для данных - в AppData
const dataDir = path.join(dataRoot, 'data');
const logsDir = path.join(dataRoot, 'logs');

function ensureDirectories() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log('📁 Created data directory:', dataDir);
    }
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
        console.log('📁 Created logs directory:', logsDir);
    }
}

module.exports = {
    appRoot,
    dataRoot,
    envPath,
    dataDir,
    logsDir,
    ensureDirectories
};