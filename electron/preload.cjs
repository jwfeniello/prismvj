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

// Spout and NDI (native/video) run inside this renderer process: a 1080p
// frame is 8 MB, and Electron's IPC cannot carry 60 of them per second. The
// page and this preload exchange frames over a private MessageChannel, which
// moves buffers between the two worlds without copying them (contextBridge
// would copy every frame). See videoShare() below for the page-side calls.
let video = null, videoError = null;
function videoBridge() {
  if (video || videoError) return video;
  const path = require('node:path');
  const candidates = [process.resourcesPath && path.join(process.resourcesPath, 'prism_video.node'), path.join(__dirname, 'native', `${process.platform}-${process.arch}`, 'prism_video.node'), path.join(__dirname, 'native', 'prism_video.node')].filter(Boolean);
  for (const candidate of candidates) {
    try { video = require(candidate); videoError = null; break; }
    catch (error) { videoError = error; }
  }
  return video;
}

const shares = new Map();
let shareId = 0, sharePort = null, pollTimer = null;
const RECEIVE_BUFFERS = 3;

function videoStatus() {
  const bridge = videoBridge();
  if (!bridge) return { available: false, error: videoError?.message || 'Spout and NDI are not built.', spout: false, ndi: { available: false } };
  return { available: true, spout: process.platform === 'win32', ndi: bridge.ndiStatus() };
}

function pollReceivers() {
  for (const [id, share] of shares) {
    if (share.direction !== 'in') continue;
    let buffer = share.free.find(item => item.byteLength >= share.size);
    let result = share.native.read(buffer || null, true);
    if (!result) continue;
    const size = result.width * result.height * 4;
    if (!result.copied) {
      // First frame, a new size, or every buffer still on the page.
      if (share.size === size && share.free.length + share.lent >= RECEIVE_BUFFERS) continue;
      share.size = size; share.free = share.free.filter(item => item.byteLength >= size);
      buffer = new ArrayBuffer(size);
      result = share.native.read(buffer, true);
      if (!result?.copied) { share.free.push(buffer); continue; }
    } else share.free.splice(share.free.indexOf(buffer), 1);
    share.lent++;
    sharePort?.postMessage({ type: 'input', id, buffer, width: result.width, height: result.height, alpha: result.alpha, sequence: result.sequence, ageMs: result.ageMs }, [buffer]);
  }
}

function syncPolling() {
  const receiving = [...shares.values()].some(share => share.direction === 'in');
  if (receiving && !pollTimer) pollTimer = setInterval(pollReceivers, 4);
  if (!receiving && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function onShareMessage({ data }) {
  const share = shares.get(data?.id);
  if (data?.type === 'frame') {
    try { if (share?.direction === 'out') share.native.send(data.buffer, data.width, data.height, { alpha: !!data.alpha, fps: data.fps || 60 }); }
    catch (error) { share.error = error.message; }
    sharePort.postMessage({ type: 'returned', id: data.id, buffer: data.buffer }, [data.buffer]);
  } else if (data?.type === 'returned' && share?.direction === 'in') {
    share.lent = Math.max(0, share.lent - 1);
    if (data.buffer.byteLength >= share.size && share.free.length < RECEIVE_BUFFERS) share.free.push(data.buffer);
  }
}

function openShare(direction, kind, name, url) {
  const bridge = videoBridge();
  if (!bridge) throw new Error(videoError?.message || 'Spout and NDI are not built.');
  if (!['spout', 'ndi'].includes(kind)) throw new Error('Unknown video share.');
  const label = typeof name === 'string' ? name.slice(0, 255) : '';
  const native = direction === 'out'
    ? (kind === 'spout' ? bridge.createSpoutSender(label || 'PrismVJ') : bridge.createNdiSender(label || 'PrismVJ'))
    : (kind === 'spout' ? bridge.createSpoutReceiver(label) : bridge.createNdiReceiver(label, typeof url === 'string' ? url.slice(0, 512) : undefined));
  const id = ++shareId;
  shares.set(id, { direction, kind, native, size: 0, free: [], lent: 0, error: null });
  syncPolling();
  return id;
}

function closeShare(id) {
  const share = shares.get(id);
  if (!share) return false;
  shares.delete(id);
  try { share.native.close(); } catch { /* already closed */ }
  syncPolling();
  return true;
}

// The page calls connect() after listening for a 'prism-video-port' message,
// and receives its end of the frame channel in that message.
function connectShares() {
  if (!videoBridge()) return false;
  sharePort?.close();
  const channel = new MessageChannel();
  sharePort = channel.port1;
  sharePort.onmessage = onShareMessage;
  window.postMessage('prism-video-port', '*', [channel.port2]);
  return true;
}

window.addEventListener('beforeunload', () => { for (const id of [...shares.keys()]) closeShare(id); });

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
  makeReverseCopy: path => ipcRenderer.invoke('prism:media-reverse-copy', path),
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
  videoShare: {
    status: () => videoStatus(),
    spoutSenders: () => videoBridge()?.spoutSenders() || [],
    ndiSources: () => (videoBridge()?.ndiStatus().available ? video.ndiSources() : []),
    connect: () => connectShares(),
    openSender: (kind, name) => openShare('out', kind, name),
    openReceiver: (kind, source, url) => openShare('in', kind, source, url),
    info: id => { const share = shares.get(id), info = share?.native.info(); return share ? { ...info, kind: share.kind, direction: share.direction, error: share.error || info.error } : null; },
    close: id => closeShare(id),
    openNdiRuntimePage: () => ipcRenderer.invoke('prism:open-ndi-runtime'),
  },
  onWarning: callback => subscribe('prism:warning', callback),
  onOSCError: callback => subscribe('prism:osc-error', callback),
});
