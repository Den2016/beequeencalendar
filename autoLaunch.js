const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { appRoot } = require('./paths');

// Ключ в реестре для автозапуска
const REGISTRY_KEY = 'BeeTelegramBot';
const REGISTRY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

// Функция для получения пути к текущему exe
function getExePath() {
    if (!app.isPackaged) {
        return false;
    }
    // В собранном приложении - путь к exe
    return process.execPath;
}

// Проверка включен ли автозапуск
async function isAutoLaunchEnabled() {
    // В режиме разработки автозапуск не нужен
    if (!app.isPackaged) {
        return false;
    }
    
    try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execPromise = promisify(exec);
        
        const command = `reg query "${REGISTRY_PATH}" /v "${REGISTRY_KEY}"`;
        const { stdout } = await execPromise(command);
        
        // Если ключ найден и путь совпадает с текущим exe
        if (stdout && stdout.includes(REGISTRY_KEY)) {
            const currentExe = getExePath();
            const stdoutLower = stdout.toLowerCase();
            const currentExeLower = currentExe.toLowerCase();
            
            return stdoutLower.includes(currentExeLower.replace(/\\/g, '\\\\'));
        }
        return false;
    } catch (error) {
        // Ключ не найден
        return false;
    }
}

// Включение автозапуска
async function enableAutoLaunch() {
    if (!app.isPackaged) {
        console.log('⚠️ Auto-launch is disabled in development mode');
        return { success: false, message: 'Disabled in development mode' };
    }
    
    try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execPromise = promisify(exec);
        
        const exePath = getExePath();
        const command = `reg add "${REGISTRY_PATH}" /v "${REGISTRY_KEY}" /t REG_SZ /d "${exePath}" /f`;
        await execPromise(command);
        console.log('✅ Auto-launch enabled');
        return { success: true, message: 'Auto-launch enabled' };
    } catch (error) {
        console.error('Failed to enable auto-launch:', error);
        return { success: false, message: error.message };
    }
}

// Отключение автозапуска
async function disableAutoLaunch() {
    if (!app.isPackaged) {

        return { success: true, message: 'Disabled in development mode' };
    }
    
    try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execPromise = promisify(exec);
        
        const command = `reg delete "${REGISTRY_PATH}" /v "${REGISTRY_KEY}" /f`;
        await execPromise(command);
        console.log('✅ Auto-launch disabled');
        return { success: true, message: 'Auto-launch disabled' };
    } catch (error) {
        console.error('Failed to disable auto-launch:', error);
        return { success: false, message: error.message };
    }
}

// Переключение автозапуска
async function toggleAutoLaunch(enabled) {
    if (enabled) {
        return await enableAutoLaunch();
    } else {
        return await disableAutoLaunch();
    }
}

// Функция для показа диалога при первом запуске
async function showFirstLaunchDialog(mainWindow) {
    // Проверяем, был ли уже показан диалог
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    let settings = {};
    
    try {
        if (fs.existsSync(settingsPath)) {
            const content = fs.readFileSync(settingsPath, 'utf8');
            settings = JSON.parse(content);
        }
    } catch (err) {
        console.log('No settings file yet');
    }
    
    // Если диалог уже показывали, не показываем снова
    if (settings.firstLaunchDialogShown) {
        console.log('First launch dialog already shown');
        return;
    }
    
    // Ждем, пока окно загрузится
    setTimeout(async () => {
        const result = await require('electron').dialog.showMessageBox(mainWindow, {
            type: 'question',
            title: '🐝 Bee Telegram Bot',
            message: 'Добавить бота в автозагрузку?',
            detail: 'Бот будет автоматически запускаться при старте Windows и работать в системном трее.\n\nВы всегда можете изменить эту настройку позже в интерфейсе программы.',
            buttons: ['✅ Да, добавить', '❌ Нет, позже'],
            defaultId: 0,
            cancelId: 1,
            icon: path.join(__dirname, 'assets', 'icon.ico')
        });
        
        if (result.response === 0) {
            // Пользователь согласился
            await enableAutoLaunch();
            
            // Отправляем событие в renderer для обновления UI
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('auto-launch-status-changed', true);
            }
        }
        
        // Сохраняем, что диалог показан
        settings.firstLaunchDialogShown = true;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }, 2000);
}

module.exports = {
    isAutoLaunchEnabled,
    enableAutoLaunch,
    disableAutoLaunch,
    toggleAutoLaunch,
    showFirstLaunchDialog
};