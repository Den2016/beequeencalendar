const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getUsers: () => fetch('http://localhost:3001/api/users').then(res => res.json()),
    getParams: () => fetch('http://localhost:3001/api/params').then(res => res.json()),
    getNotifications: () => fetch('http://localhost:3001/api/notifications').then(res => res.json())
});