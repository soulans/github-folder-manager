const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  getMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChange: (callback) => {
    ipcRenderer.on('maximize-change', (_event, value) => callback(value));
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  gheFetch: (payload) => ipcRenderer.invoke('ghe-fetch', payload)
});
