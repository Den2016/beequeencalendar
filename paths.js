const path = require('path');
const fs = require('fs');
const os = require('os');

function getAppRoot() {
    if (process.env.NODE_ENV === 'development') {
        console.log('🔧 Running in development mode, using project directory as app root');
        return __dirname;
    }
    // В режиме разработки через npm start, process.execPath указывает на electron.exe
    // Поэтому используем process.cwd() для получения папки проекта
    return process.cwd();
}

// Для данных используем AppData/Roaming
function getDataRoot() {
    // В режиме разработки используем локальную папку
    if (process.env.NODE_ENV === 'development') {
        return getAppRoot();
    }
    console.log('🔧 Running in production mode, using AppData/Roaming for data storage');
    // В Windows: C:\Users\USER\AppData\Roaming\BeeTelegramBot
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'BeeTelegramBot');
}

const appRoot = getAppRoot();
const dataRoot = getDataRoot();

// Путь к .env - рядом с exe или в папке проекта при разработке
const envPath = path.join(appRoot, '.env');

// Папки для данных
const dataDir = path.join(dataRoot, 'data');
const logsDir = path.join(dataRoot, 'logs');
const assetsDir = path.join(appRoot, 'assets');

// Принудительное определение NODE_ENV для разработки
if (process.env.NODE_ENV !== 'production' && !process.env.NODE_ENV) {
    // Если запущено через electron . или npm start
    const isDevelopment = !process.execPath.includes('electron.exe') || 
                          process.execPath.includes('node_modules');
    process.env.NODE_ENV = isDevelopment ? 'development' : 'production';
}

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
    assetsDir,
    ensureDirectories
};