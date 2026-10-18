'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const frameListeners = new Set();

ipcRenderer.on('prism:output-frame', async (_event, data) => {
  // A single acknowledgement covers all consumers. A fast observer must not
  // release producer backpressure while the canvas is still decoding a frame.
  try {
    const results = await Promise.allSettled([...frameListeners].map(callback => Promise.resolve().then(() => callback(data))));
    for (const result of results) if (result.status === 'rejected') console.error('Output frame could not be displayed:', result.reason);
  } finally { ipcRenderer.send('prism:output-ack'); }
});

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Expected a callback.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktop', {
  importMedia: () => ipcRenderer.invoke('prism:import'),
  importPaths: paths => ipcRenderer.invoke('prism:import-paths', paths),
  mediaThumbnails: paths => ipcRenderer.invoke('prism:media-thumbnails', paths),
  onMediaProgress: callback => subscribe('prism:media-progress', callback),
  browseRoots: () => ipcRenderer.invoke('prism:media-roots'),
  browseDirectory: path => ipcRenderer.invoke('prism:media-directory', path),
  chooseMediaDirectory: initialPath => ipcRenderer.invoke('prism:media-choose-directory', initialPath),
  reconnectMedia: (project, request) => ipcRenderer.invoke('prism:media-reconnect', project, request),
  relinkProject: (project, folder) => ipcRenderer.invoke('prism:media-relink', project, folder),
  revealInExplorer: path => ipcRenderer.invoke('prism:media-reveal', path),
  getPathForFile: file => webUtils.getPathForFile(file),
  saveProject: (project, saveAs = false) => ipcRenderer.invoke('prism:save', project, saveAs),
  openProject: () => ipcRenderer.invoke('prism:open'),
  resetProjectPath: () => ipcRenderer.invoke('prism:reset-project-path'),
  recoverProject: () => ipcRenderer.invoke('prism:recover'),
  autosave: project => ipcRenderer.invoke('prism:autosave', project),
  getDisplays: () => ipcRenderer.invoke('prism:displays'),
  openOutput: displayId => ipcRenderer.invoke('prism:output-open', displayId),
  closeOutput: () => ipcRenderer.invoke('prism:output-close'),
  outputStatus: () => ipcRenderer.invoke('prism:output-status'),
  sendOutputFrame: data => ipcRenderer.send('prism:output-frame', data),
  onOutputState: callback => subscribe('prism:output-state', callback),
  onOutputFrame: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback.');
    frameListeners.add(callback);
    return () => frameListeners.delete(callback);
  },
  saveSnapshot: (kind, name, data) => ipcRenderer.invoke('prism:snapshot-save', kind, name, data),
  saveRecording: data => ipcRenderer.invoke('prism:record-save', data),
  beginRecording: () => ipcRenderer.invoke('prism:record-begin'),
  writeRecordingChunk: (id, data) => ipcRenderer.invoke('prism:record-chunk', id, data),
  finishRecording: id => ipcRenderer.invoke('prism:record-finish', id),
  startOSC: (port, host) => ipcRenderer.invoke('prism:osc-start', port, host),
  stopOSC: () => ipcRenderer.invoke('prism:osc-stop'),
  oscStatus: () => ipcRenderer.invoke('prism:osc-status'),
  onControl: callback => subscribe('prism:control', callback),
  onWarning: callback => subscribe('prism:warning', callback),
  onOSCError: callback => subscribe('prism:osc-error', callback),
});
