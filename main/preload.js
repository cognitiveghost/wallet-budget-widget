const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, payload) => cb(payload)),
  saveToken: (token) => ipcRenderer.invoke('token:save', token),
  clearToken: () => ipcRenderer.invoke('token:clear'),
  refresh: () => ipcRenderer.invoke('refresh'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
