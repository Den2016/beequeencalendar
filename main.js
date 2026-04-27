const { app, Tray, Menu, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { models } = require('./database');
const { appRoot, logsDir, assetsDir, ensureDirectories } = require('./paths');
const { isAutoLaunchEnabled, enableAutoLaunch, disableAutoLaunch, toggleAutoLaunch, showFirstLaunchDialog } = require('./autoLaunch');

let tray = null;
let mainWindow = null;

// Обеспечиваем создание папок
ensureDirectories();

// ========== СИСТЕМА ЛОГИРОВАНИЯ ==========
const MAX_LOGS = 1000;
let logsStore = [];
let logFile = null;

function initLogFile() {
    const date = new Date().toISOString().split('T')[0];
    logFile = path.join(logsDir, `bot-${date}.log`);
}

function saveLog(level, ...args) {
    const timestamp = new Date().toISOString();
    let message = '';
    let stack = null;
    
    for (const arg of args) {
        if (arg instanceof Error) {
            message += arg.message + ' ';
            stack = arg.stack;
        } else if (typeof arg === 'object') {
            try {
                message += JSON.stringify(arg, null, 2) + ' ';
            } catch (e) {
                message += String(arg) + ' ';
            }
        } else {
            message += String(arg) + ' ';
        }
    }
    
    const logEntry = {
        id: Date.now() + Math.random(),
        timestamp,
        level,
        message: message.trim(),
        stack: stack || null
    };
    
    logsStore.push(logEntry);
    if (logsStore.length > MAX_LOGS) {
        logsStore = logsStore.slice(0, MAX_LOGS);
    }
    
    if (logFile) {
        const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
        if (stack) {
            fs.appendFileSync(logFile, logLine + stack + '\n');
        } else {
            fs.appendFileSync(logFile, logLine);
        }
    }
    
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('log-message', logEntry);
    }
}

// Перехват console
const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;
const originalDebug = console.debug;

console.log = function(...args) {
    originalLog.apply(console, args);
    saveLog('info', ...args);
};

console.info = function(...args) {
    originalInfo.apply(console, args);
    saveLog('info', ...args);
};

console.warn = function(...args) {
    originalWarn.apply(console, args);
    saveLog('warn', ...args);
};

console.error = function(...args) {
    originalError.apply(console, args);
    saveLog('error', ...args);
};

console.debug = function(...args) {
    originalDebug.apply(console, args);
    saveLog('debug', ...args);
};

// Перехват непойманных ошибок
process.on('uncaughtException', (error) => {
    saveLog('error', 'Uncaught Exception:', error);
    originalError('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    saveLog('error', 'Unhandled Rejection at:', promise, 'reason:', reason);
    originalError('Unhandled Rejection at:', promise, 'reason:', reason);
});

// IPC обработчики
ipcMain.handle('clear-logs', () => {
    logsStore = [];
    return { success: true };
});

ipcMain.handle('export-logs', () => {
    if (!logFile || !fs.existsSync(logFile)) {
        return { success: false, error: 'Log file not found' };
    }
    const content = fs.readFileSync(logFile, 'utf8');
    return { success: true, content };
});

ipcMain.handle('get-logs', () => {
    return logsStore;
});

// ========== IPC ДЛЯ АВТОЗАПУСКА ==========
ipcMain.handle('get-auto-launch-status', async () => {
    return await isAutoLaunchEnabled();
});

ipcMain.handle('set-auto-launch', async (event, enabled) => {
    const result = await toggleAutoLaunch(enabled);
    return result;
});

// ========== ОСТАЛЬНОЙ КОД ==========

const bot = require('./bot');
const { initScheduler } = require('./scheduler');

function createTray() {
    // Исправление: проверяем существование assetsDir и иконки
    let iconPath = null;
    
    // Пробуем найти иконку в разных местах
    const possiblePaths = [
        assetsDir ? path.join(assetsDir, 'icon.ico') : null,
        path.join(__dirname, 'assets', 'icon.ico'),
        path.join(appRoot, 'assets', 'icon.ico'),
        path.join(process.cwd(), 'assets', 'icon.ico')
    ];
    
    for (const tryPath of possiblePaths) {
        if (tryPath && fs.existsSync(tryPath)) {
            iconPath = tryPath;
            break;
        }
    }
    
    if (iconPath) {
        console.log('📁 Using icon from:', iconPath);
        tray = new Tray(iconPath);
    } else {
        console.log('⚠️ Icon not found, creating tray without icon');
        // Создаем простой Tray без иконки (с пустым Image)
        const { nativeImage } = require('electron');
        const emptyIcon = nativeImage.createEmpty();
        tray = new Tray(emptyIcon);
    }
    
    const contextMenu = Menu.buildFromTemplate([
        { label: '📊 Показать мониторинг', click: showWindow },
        { type: 'separator' },
        { label: '🚪 Выход', click: () => { app.quit(); } }
    ]);
    
    tray.setToolTip('🐝 Bee Telegram Bot');
    tray.setContextMenu(contextMenu);
    tray.on('click', showWindow);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    
    mainWindow.loadFile('index.html');
    
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12') {
            mainWindow.webContents.openDevTools();
        }
    });
}

function showWindow() {
    if (mainWindow === null) {
        createWindow();
    }
    mainWindow.show();
}

app.whenReady().then(async () => {
    initLogFile();
    console.log('🐝 Bee Telegram Bot starting...');
    console.log(`📁 Working directory: ${appRoot}`);
    console.log(`📁 Log file: ${logFile}`);
    
    createTray();
    createWindow(); // Создаем окно сразу для диалогов
    
    // Запускаем сервер для API мониторинга
    const express = require('express');
    const expressApp = express();
    const port = 3001;
    
    expressApp.get('/api/users', async (req, res) => {
        try {
            const users = await models.BeeUser.findAll();
            res.json(users);
        } catch (err) {
            console.error('Error fetching users:', err);
            res.status(500).json({ error: err.message });
        }
    });
    
    expressApp.get('/api/params', async (req, res) => {
        try {
            const { dbAsync } = require('./database');
            const params = await dbAsync.all('SELECT * FROM beeparams ORDER BY id DESC LIMIT 50');
            res.json(params);
        } catch (err) {
            console.error('Error fetching params:', err);
            res.status(500).json({ error: err.message });
        }
    });
    
    expressApp.get('/api/notifications', async (req, res) => {
        try {
            const { dbAsync } = require('./database');
            const notifications = await dbAsync.all('SELECT * FROM beesubscribes WHERE sent = 0 ORDER BY dt ASC');
            res.json(notifications);
        } catch (err) {
            console.error('Error fetching notifications:', err);
            res.status(500).json({ error: err.message });
        }
    });
    
    expressApp.get('/api/delayed', async (req, res) => {
        try {
            const { dbAsync } = require('./database');
            const delayed = await dbAsync.all(`
                SELECT s.*, u.first_name, u.username 
                FROM beesubscribes s
                LEFT JOIN beeuser u ON s.tg_id = u.tg_id
                WHERE s.tp = 1 AND s.sent = 0
                ORDER BY s.dt ASC
            `);
            res.json(delayed);
        } catch (err) {
            console.error('Error fetching delayed messages:', err);
            res.status(500).json({ error: err.message });
        }
    });
    
    expressApp.listen(port, () => {
        console.log(`📊 Monitor API running on http://localhost:${port}`);
    });
    
    // Инициализируем планировщик
    initScheduler(bot);
    
    // Показываем диалог первого запуска для автозапуска (только в собранном приложении)
    if (app.isPackaged) {
        await showFirstLaunchDialog(mainWindow);
    }    
    console.log('✅ Bee Telegram Bot started successfully!');
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});