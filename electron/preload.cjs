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
  importSequence: (folder, fps) => ipcRenderer.invoke('prism:import-sequence', folder, fps),
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
  linkStatus: () => ipcRenderer.invoke('prism:link-status'),
  linkEnable: enabled => ipcRenderer.invoke('prism:link-enable', enabled),
  linkTempo: bpm => ipcRenderer.invoke('prism:link-tempo', bpm),
  linkPlaying: playing => ipcRenderer.invoke('prism:link-playing', playing),
  linkStartStopSync: enabled => ipcRenderer.invoke('prism:link-start-stop-sync', enabled),
  onLinkState: callback => subscribe('prism:link-state', callback),
  startProLink: options => ipcRenderer.invoke('prism:prolink-start', options),
  stopProLink: () => ipcRenderer.invoke('prism:prolink-stop'),
  onProLinkState: callback => subscribe('prism:prolink-state', callback),
  onProLinkBeat: callback => subscribe('prism:prolink-beat', callback),
  onProLinkWarning: callback => subscribe('prism:prolink-warning', callback),
  convertAdd: paths => ipcRenderer.invoke('prism:convert-add', paths),
  convertPick: kind => ipcRenderer.invoke('prism:convert-pick', kind),
  convertChooseFolder: () => ipcRenderer.invoke('prism:convert-folder'),
  convertFrame: (id, seconds) => ipcRenderer.invoke('prism:convert-frame', id, seconds),
  convertPreview: id => ipcRenderer.invoke('prism:convert-preview', id),
  convertEnqueue: requests => ipcRenderer.invoke('prism:convert-enqueue', requests),
  convertCancel: id => ipcRenderer.invoke('prism:convert-cancel', id),
  convertPrioritize: ids => ipcRenderer.invoke('prism:convert-prioritize', ids),
  convertClear: () => ipcRenderer.invoke('prism:convert-clear'),
  convertForget: ids => ipcRenderer.invoke('prism:convert-forget', ids),
  convertState: () => ipcRenderer.invoke('prism:convert-state'),
  convertReveal: output => ipcRenderer.invoke('prism:convert-reveal', output),
  onConvertState: callback => subscribe('prism:convert-state', callback),
  sendOSC: (host, port, messages) => ipcRenderer.invoke('prism:osc-send', host, port, messages),
  startDMX: options => ipcRenderer.invoke('prism:dmx-start', options),
  stopDMX: () => ipcRenderer.invoke('prism:dmx-stop'),
  sendDMX: frames => ipcRenderer.send('prism:dmx-send', frames),
  startDMXInput: options => ipcRenderer.invoke('prism:dmx-input-start', options),
  stopDMXInput: () => ipcRenderer.invoke('prism:dmx-input-stop'),
  onDMXInput: callback => subscribe('prism:dmx-input', callback),
  scanISFFolder: folder => ipcRenderer.invoke('prism:isf-scan', folder),
  searchISF: options => ipcRenderer.invoke('prism:isf-search', options),
  installISF: id => ipcRenderer.invoke('prism:isf-install', id),
  isfLibrary: () => ipcRenderer.invoke('prism:isf-library'),
  removeISF: id => ipcRenderer.invoke('prism:isf-remove', id),
  openISFPage: url => ipcRenderer.invoke('prism:isf-open', url),
  captureSources: () => ipcRenderer.invoke('prism:capture-sources'),
  selectCaptureSource: id => ipcRenderer.invoke('prism:capture-select', id),
  placeOutputWindow: (frameName, displayId, fullscreen) => ipcRenderer.invoke('prism:output-window-place', frameName, displayId, fullscreen),
  closeOutputWindow: frameName => ipcRenderer.invoke('prism:output-window-close', frameName),
  onOutputWindowClosed: callback => subscribe('prism:output-window-closed', callback),
  onWarning: callback => subscribe('prism:warning', callback),
  onOSCError: callback => subscribe('prism:osc-error', callback),
});
