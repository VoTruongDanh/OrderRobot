const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orderRobotDesktop', {
  getLoginConfig: () => ipcRenderer.invoke('orderrobot:get-login-config'),
  login: (payload) => ipcRenderer.invoke('orderrobot:login', payload),
});
