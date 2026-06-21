import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('audioReadDesktop', {
  selectInput: () => ipcRenderer.invoke('select-input'),
  selectOutput: () => ipcRenderer.invoke('select-output'),
  openPath: path => ipcRenderer.invoke('open-path', path),
  startGeneration: options => ipcRenderer.invoke('start-generation', options),
  previewVoice: options => ipcRenderer.invoke('preview-voice', options),
  cancelGeneration: () => ipcRenderer.invoke('cancel-generation'),
  onStarted: callback => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('generation-started', handler)
    return () => ipcRenderer.removeListener('generation-started', handler)
  },
  onLog: callback => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('generation-log', handler)
    return () => ipcRenderer.removeListener('generation-log', handler)
  },
  onDone: callback => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('generation-done', handler)
    return () => ipcRenderer.removeListener('generation-done', handler)
  },
})
