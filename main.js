const { app, Tray, Menu, BrowserWindow } = require('electron');
const path = require('path');
const { models } = require('./database');

let tray = null;
let mainWindow = null;

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Подключаем бота и планировщик
const bot = require('./bot');
const { initScheduler } = require('./scheduler');

function createTray() {
    // Используем вашу иконку из папки assets
    tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
    
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
        width: 900,
        height: 600,
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
}

function showWindow() {
    if (mainWindow === null) {
        createWindow();
    }
    mainWindow.show();
}

app.whenReady().then(() => {
    createTray();
    
    // Запускаем сервер для API мониторинга
    const express = require('express');
    const expressApp = express();
    const port = 3001;
    
    expressApp.get('/api/users', async (req, res) => {
        const users = await models.BeeUser.findAll();
        res.json(users);
    });
    
    expressApp.get('/api/params', async (req, res) => {
        const { dbAsync } = require('./database');
        const params = await dbAsync.all('SELECT * FROM beeparams ORDER BY id DESC LIMIT 50');
        res.json(params);
    });
    
    expressApp.get('/api/notifications', async (req, res) => {
        const { dbAsync } = require('./database');
        const notifications = await dbAsync.all('SELECT * FROM beesubscribes WHERE sent = 0 ORDER BY dt ASC');
        res.json(notifications);
    });
    
    expressApp.listen(port, () => {
        console.log(`📊 Monitor API running on http://localhost:${port}`);
    });
    
    // Инициализируем планировщик уведомлений
    initScheduler(bot);
    
    console.log('🐝 Bee Telegram Bot started!');
});

app.on('window-all-closed', (e) => {
    e.preventDefault(); // Keep app running in tray
});