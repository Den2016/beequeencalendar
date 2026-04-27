const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Существующие API
    getUsers: () => fetch('http://localhost:3001/api/users').then(res => res.json()),
    getParams: () => fetch('http://localhost:3001/api/params').then(res => res.json()),
    getNotifications: () => fetch('http://localhost:3001/api/notifications').then(res => res.json()),
    getDelayedMessages: () => fetch('http://localhost:3001/api/delayed').then(res => res.json()),
    
    // API для логов
    onLogMessage: (callback) => {
        ipcRenderer.removeAllListeners('log-message');
        ipcRenderer.on('log-message', (event, data) => callback(data));
    },
    clearLogs: () => ipcRenderer.invoke('clear-logs'),
    exportLogs: () => ipcRenderer.invoke('export-logs'),
    getLogs: () => ipcRenderer.invoke('get-logs')
});