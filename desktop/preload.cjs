const { contextBridge, ipcRenderer } = require('electron');

const invoke = name => value => ipcRenderer.invoke(`pihole:${name}`, value);
contextBridge.exposeInMainWorld('pihole', Object.freeze({
  getState: invoke('state'), start: invoke('start'), stop: invoke('stop'),
  openDashboard: invoke('dashboard'), saveSettings: invoke('settings'),
  setStartup: invoke('startup'), chooseRepository: invoke('repository'),
  openGuide: invoke('guide'), quit: invoke('quit'),
  onState: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('pihole:state', listener);
    return () => ipcRenderer.removeListener('pihole:state', listener);
  }
}));
