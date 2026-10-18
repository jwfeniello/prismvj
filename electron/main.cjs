'use strict';

const { app, BrowserWindow, dialog, ipcMain, protocol, net, screen, session, shell, desktopCapturer } = require('electron');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const dgram = require('node:dgram');
const { isAutomatedLaunch, validateBuiltPage } = require('./startup.cjs');
const { createMediaConverter } = require('./media-converter.cjs');
const { scanISFFolder } = require('./isf-library.cjs');
const { DmxSender, DmxReceiver } = require('./dmx-network.cjs');
const abletonLink = require('./link.cjs');

// Test profiles and automation/debugging switches also imply hidden mode. A
// forgotten environment flag must never put test windows or dialogs on stage.
const hiddenTestWindows = isAutomatedLaunch({ hasSwitch: name => app.commandLine.hasSwitch(name) });
if (hiddenTestWindows) {
  // Integration tests must never put a native modal on the operator's desktop.
  dialog.showErrorBox = (title, message) => console.error(`${title}: ${message}`);
  for (const name of ['showMessageBox', 'showOpenDialog', 'showSaveDialog']) {
    dialog[name] = async () => { throw new Error(`Native ${name} is disabled in hidden tests; install a test stub.`); };
  }
  shell.showItemInFolder = () => { throw new Error('Native Explorer is disabled in hidden tests; install a test stub.'); };
  process.on('uncaughtException', error => { console.error(error); app.exit(1); });
  process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
}

// Explicit test-only overrides keep integration tests out of the operator's profile.
if (process.env.PRISM_TEST_DATA) {
  if (!path.isAbsolute(process.env.PRISM_TEST_DATA)) throw new Error('PRISM_TEST_DATA must be an absolute directory.');
  app.setPath('userData', process.env.PRISM_TEST_DATA);
}

protocol.registerSchemesAsPrivileged([{ scheme: 'prism-media', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true,
} }]);

const MAX_PROJECT = 16 * 1024 * 1024;
const MAX_FRAME = 12 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 2000;
const MAX_DIRECTORY_SCAN = 10000;
const RELINK_LIMITS = Object.freeze({ entries: 20000, directories: 2000, depth: 16, milliseconds: 10000 });
const MEDIA = new Map([
  ...['.mp4', '.m4v', '.mov', '.webm', '.ogv', '.ogg', '.mkv', '.avi'].map(ext => [ext, 'video']),
  ...['.wav', '.mp3', '.flac', '.m4a', '.aac', '.aiff', '.aif', '.oga'].map(ext => [ext, 'audio']),
  ...['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].map(ext => [ext, 'image']),
]);
const mediaTokens = new Map();
const mediaPaths = new Map();
const recordings = new Map();
const devURL = process.env.PRISM_DEV_URL || '';
let editor = null;
let output = null;
let currentProjectPath = null;
let recoveryPath;
let saveQueue = Promise.resolve();
let frameBusy = false;
let frameSentAt = 0;
let oscSocket = null;
let oscOutSocket = null;
let dmxSender = null;
let dmxReceiver = null;
let captureSourceId = '';
// Output windows opened by the editor with window.open share its process, so
// the composition canvas is drawn directly on the GPU instead of being encoded.
const outputWindows = new Map();
let oscState = { active: false, port: null, host: '127.0.0.1', received: 0, rejected: 0 };
let modelPromise;
let shutdownStarted = false;
let shutdownFinished = false;
let mediaConverter;

function converter() {
  return mediaConverter ||= createMediaConverter({
    cacheDirectory: path.join(app.getPath('userData'), 'media-cache'),
    resourcesPath: process.resourcesPath,
    onProgress: value => notify('prism:media-progress', value),
  });
}

function model() {
  return modelPromise ||= import(pathToFileURL(path.join(app.getAppPath(), 'src', 'model.js')).href);
}

function isAppURL(value) {
  try {
    const url = new URL(value);
    if (devURL) return url.origin === new URL(devURL).origin;
    const expected = pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html'));
    return url.protocol === 'file:' && url.pathname === expected.pathname;
  } catch { return false; }
}

function checkSender(event, allowOutput = false) {
  const valid = event.sender === editor?.webContents || (allowOutput && event.sender === output?.webContents);
  if (!valid || event.senderFrame !== event.sender.mainFrame || !isAppURL(event.senderFrame.url)) {
    throw new Error('Request must originate in the application window.');
  }
}

function handle(name, callback, allowOutput = false) {
  ipcMain.handle(name, async (event, ...args) => {
    checkSender(event, allowOutput);
    return callback(...args);
  });
}

function notify(channel, value) {
  if (editor && !editor.isDestroyed()) editor.webContents.send(channel, value);
}

async function log(message) {
  try { await fs.appendFile(path.join(app.getPath('userData'), 'prism.log'), `${new Date().toISOString()} ${String(message).slice(0, 4000)}\n`); }
  catch { /* A log write failure must not interrupt live output. */ }
}

async function atomicWrite(destination, data) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await fs.open(temporary, 'wx');
    await file.writeFile(data);
    await file.sync();
    await file.close();
    file = null;
    // Rename replaces an existing file atomically; do not unlink the good save first.
    await fs.rename(temporary, destination);
  } catch (error) {
    if (file) await file.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function cleanProject(input) {
  const serialized = JSON.stringify(input);
  if (Buffer.byteLength(serialized) > MAX_PROJECT) throw new Error('Project exceeds the 16 MB limit.');
  const { validateProject } = await model();
  const project = validateProject(JSON.parse(serialized));
  for (const { media } of projectMedia(project, true)) {
    // Session/blob URLs cannot be restored in a later process. Paths are authoritative.
    if (media.path || (media.url && !media.url.startsWith('data:'))) media.url = '';
  }
  return project;
}

function absolutePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 32768 || value.includes('\0')) throw new Error('Expected an absolute local path.');
  return path.resolve(value);
}

// Image sequences (manual p. 65) play from a prepared video copy; the clip
// keeps the first frame's path plus its frame rate (`sequenceFps`).
const SEQUENCE_FPS = 25;
const sequenceFps = value => Number.isFinite(value) && value > 0 && value <= 240 ? value : null;

async function registerMedia(filePath, { sequence = null } = {}) {
  const absolute = absolutePath(filePath);
  const fps = sequenceFps(sequence);
  const kind = fps ? 'video' : MEDIA.get(path.extname(absolute).toLowerCase());
  if (!kind) throw new Error(`Unsupported media extension: ${path.extname(absolute)}`);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error('Media path is not a file.');
  // HAP and DXV play from the original file: the renderer uploads their DXT
  // frames as GPU textures. ProRes and other MOV codecs need a browser
  // playback copy. The clip always keeps the original path for save,
  // reconnect and Show in Explorer.
  const mov = !fps && path.extname(absolute).toLowerCase() === '.mov';
  // PRISM_GPU_VIDEO=0 converts every MOV (for troubleshooting and for testing the copies).
  const gpu = mov && process.env.PRISM_GPU_VIDEO !== '0' ? await converter().gpuCodec(absolute, stat) : null;
  if (gpu) return registerGpuMovie(absolute, stat, gpu);
  const prepared = fps ? await converter().prepareImageSequence(absolute, { fps })
    : mov ? await converter().prepare(absolute, stat) : null;
  const playbackPath = prepared?.playbackPath || absolute;
  // A changed original creates a fresh cache file and URL, leaving any decoder
  // that is still using an older revision undisturbed.
  let token = mediaPaths.get(playbackPath);
  if (!token) {
    token = randomUUID();
    mediaTokens.set(token, prepared ? { playbackPath, reversePath: prepared.reversePath, thumbnailPath: prepared.thumbnailPath } : playbackPath);
    mediaPaths.set(playbackPath, token);
  } else if (prepared) {
    mediaTokens.set(token, { playbackPath, reversePath: prepared.reversePath, thumbnailPath: prepared.thumbnailPath });
  }
  return { name: fps ? path.basename(path.dirname(absolute)) : path.basename(absolute), path: absolute, kind,
    ...(prepared ? { hasAlpha: prepared.hasAlpha } : {}), ...(fps ? { sequenceFps: fps } : {}),
    url: `prism-media://media/${token}/${encodeURIComponent(path.basename(fps ? prepared.playbackPath : absolute))}` };
}

// The URL carries the codec (?gpu=hap|dxv) and file revision, so a replaced file
// opens a fresh decoder. Thumbnails, the soundtrack and a converted copy for
// GPUs without S3TC textures are produced on first request.
function registerGpuMovie(absolute, stat, gpu) {
  let token = mediaPaths.get(absolute);
  if (!token) { token = randomUUID(); mediaPaths.set(absolute, token); }
  const previous = mediaTokens.get(token);
  const revision = `${stat.size}-${Math.round(stat.mtimeMs)}`;
  mediaTokens.set(token, { gpu: gpu.codec, playbackPath: absolute, stat, thumbnailPath: previous?.revision === revision ? previous.thumbnailPath : null, revision });
  return { name: path.basename(absolute), path: absolute, kind: 'video', ...(gpu.hasAlpha !== undefined ? { hasAlpha: gpu.hasAlpha } : {}),
    url: `prism-media://media/${token}/${encodeURIComponent(path.basename(absolute))}?gpu=${gpu.codec}&rev=${revision}` };
}

async function gpuMoviePath(asset, params) {
  if (params.has('thumbnail')) return asset.thumbnailPath ||= await converter().thumbnail(asset.playbackPath, asset.stat);
  if (params.has('audio')) return converter().extractAudio(asset.playbackPath, asset.stat, { reverse: params.has('reverse') });
  if (params.has('converted') || params.has('reverse')) {
    const prepared = await converter().prepare(asset.playbackPath, asset.stat);
    return params.has('reverse') ? prepared.reversePath : prepared.playbackPath;
  }
  return asset.playbackPath;
}

// A folder (or a numbered frame) becomes an image-sequence clip.
async function registerSequence(target, fps = SEQUENCE_FPS) {
  const sequence = await converter().findImageSequence(absolutePath(target), { probe: false });
  if (!sequence) throw new Error('No numbered image sequence was found in that folder.');
  return registerMedia(sequence.firstFile, { sequence: fps });
}

async function mediaThumbnails(paths) {
  if (!Array.isArray(paths) || paths.length > 48) throw new Error('Too many thumbnail requests.');
  const result = [];
  for (const filePath of paths) {
    try {
      const absolute = absolutePath(filePath);
      if (path.extname(absolute).toLowerCase() !== '.mov') throw new Error('A MOV file is required.');
      const thumbnailPath = await converter().thumbnail(absolute);
      let token = mediaPaths.get(thumbnailPath);
      if (!token) {
        token = randomUUID();
        mediaTokens.set(token, thumbnailPath);
        mediaPaths.set(thumbnailPath, token);
      }
      result.push({ path: absolute, thumbnailUrl: `prism-media://media/${token}/${encodeURIComponent(path.basename(thumbnailPath))}` });
    } catch (error) { result.push({ path: filePath, error: error.message }); }
  }
  return result;
}

// Keep component identity with each path so recovery and reconnect can target a
// single mask or soundtrack without replacing other media in the composition.
function* projectMedia(project, includeSources = false) {
  if (project.mask) yield { media: project.mask, component: 'mask', kinds: ['image'] };
  for (const layer of project.layers) {
    if (layer.mask) yield { media: layer.mask, layerId: layer.id, component: 'mask', kinds: ['image'] };
    for (const slots of Object.values(layer.clips)) for (const clip of slots) {
      if (!clip) continue;
      const identity = { layerId: layer.id, clipId: clip.id };
      // 'video' identifies the clip's primary component, including stills and
      // standalone audio clips; 'audio' identifies an attached soundtrack.
      if (clip.kind !== 'source' || includeSources) yield { ...identity, media: clip, component: 'video', kinds: [clip.kind] };
      if (clip.audio) yield { ...identity, media: clip.audio, component: 'audio', kinds: ['audio', 'video'] };
      if (clip.mask) yield { ...identity, media: clip.mask, component: 'mask', kinds: ['image'] };
    }
  }
}

function mediaIdentity(item) {
  return { id: item.media.id, ...(item.layerId ? { layerId: item.layerId } : {}),
    ...(item.clipId ? { clipId: item.clipId } : {}), component: item.component, path: item.media.path };
}

async function registerComponent(item, replacementPath = item.media.path) {
  const registered = await registerMedia(replacementPath, { sequence: item.media.sequenceFps });
  if (!item.kinds.includes(registered.kind)) throw new Error(`This component needs ${item.kinds.join(' or ')} media.`);
  return registered;
}

async function restoreMedia(project) {
  const missing = [];
  for (const item of projectMedia(project)) {
    if (!item.media.path) continue;
    try {
      const registered = await registerComponent(item);
      item.media.url = registered.url;
      if (registered.hasAlpha !== undefined) item.media.hasAlpha = registered.hasAlpha;
    }
    catch { item.media.url = ''; missing.push(mediaIdentity(item)); }
  }
  return { project, missing };
}

async function browseRoots() {
  const roots = [];
  const seen = new Set();
  const candidates = ['home', 'desktop', 'downloads', 'videos', 'music', 'pictures', 'documents']
    .map(name => ({ name: name[0].toUpperCase() + name.slice(1), path: app.getPath(name) }));
  if (process.platform === 'win32') {
    for (let letter = 65; letter <= 90; letter++) {
      const drive = `${String.fromCharCode(letter)}:\\`;
      candidates.push({ name: drive, path: drive });
    }
  } else candidates.push({ name: 'File system', path: path.parse(app.getPath('home')).root });
  const available = await Promise.all(candidates.map(async candidate => {
    try { return (await fs.stat(candidate.path)).isDirectory() ? candidate : null; } catch { return null; }
  }));
  for (const candidate of available) {
    if (!candidate) continue;
    const key = process.platform === 'win32' ? candidate.path.toLowerCase() : candidate.path;
    if (seen.has(key)) continue;
    seen.add(key); roots.push({ ...candidate, kind: 'directory' });
  }
  return roots;
}

async function browseDirectory(directory) {
  const absolute = absolutePath(directory);
  const entries = [];
  let scanned = 0;
  let truncated = false;
  // opendir bounds memory even when pointed at a folder containing millions of
  // files. Symlinks/reparse points are omitted rather than following cycles.
  for await (const entry of await fs.opendir(absolute)) {
    if (++scanned > MAX_DIRECTORY_SCAN) { truncated = true; break; }
    const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? MEDIA.get(path.extname(entry.name).toLowerCase()) : null;
    if (kind) entries.push({ name: entry.name, path: path.join(absolute, entry.name), kind });
  }
  entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory')
    || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name));
  if (entries.length > MAX_DIRECTORY_ENTRIES) truncated = true;
  entries.length = Math.min(entries.length, MAX_DIRECTORY_ENTRIES);
  // Metadata is collected in small batches so a folder cannot flood the OS with
  // thousands of simultaneous stat requests while live output is rendering.
  for (let index = 0; index < entries.length; index += 32) {
    await Promise.all(entries.slice(index, index + 32).map(async entry => {
      try {
        const stat = await fs.stat(entry.path);
        entry.size = entry.kind === 'directory' ? null : stat.size;
        entry.modified = stat.mtimeMs;
      } catch { entry.size = null; entry.modified = null; }
    }));
  }
  const parent = path.dirname(absolute);
  return { path: absolute, parent: parent === absolute ? null : parent, entries, truncated };
}

async function chooseMediaDirectory(initialPath) {
  const result = await dialog.showOpenDialog(editor, { title: 'Choose media folder', properties: ['openDirectory'],
    ...(initialPath ? { defaultPath: absolutePath(initialPath) } : {}) });
  return result.canceled || !result.filePaths.length ? null : absolutePath(result.filePaths[0]);
}

async function reconnectMedia(input, request) {
  if (!request || !['video', 'audio', 'mask'].includes(request.component)) throw new Error('Choose a media component to reconnect.');
  const restored = await restoreMedia(await cleanProject(input));
  const item = [...projectMedia(restored.project)].find(candidate => candidate.component === request.component
    && (request.clipId ? candidate.clipId === request.clipId : !candidate.clipId)
    && (request.layerId ? candidate.layerId === request.layerId : request.clipId || !candidate.layerId));
  if (!item) throw new Error('The selected media component no longer exists.');
  // The reconnect workflow only changes paths that are actually unavailable.
  if (!item.media.path || item.media.url) return { ...restored, relinked: [], ambiguous: [] };
  let replacementPath = request.replacementPath;
  if (!replacementPath) {
    const result = await dialog.showOpenDialog(editor, { title: `Reconnect ${path.basename(item.media.path)}`, properties: ['openFile'],
      defaultPath: path.dirname(item.media.path),
      filters: [{ name: 'Compatible media', extensions: [...MEDIA].filter(([, kind]) => item.kinds.includes(kind)).map(([ext]) => ext.slice(1)) }] });
    if (result.canceled || !result.filePaths.length) return null;
    replacementPath = result.filePaths[0];
  }
  const registered = await registerComponent(item, replacementPath);
  const previousPath = item.media.path;
  item.media.path = registered.path; item.media.url = registered.url;
  if (registered.hasAlpha !== undefined) item.media.hasAlpha = registered.hasAlpha;
  return { ...await restoreMedia(restored.project), relinked: [{ ...mediaIdentity(item), previousPath }], ambiguous: [] };
}

async function scanMediaFolder(folder) {
  const candidates = new Map();
  const queue = [{ path: absolutePath(folder), depth: 0 }];
  const started = Date.now();
  const scan = { entries: 0, directories: 0, truncated: false, errors: [] };
  const basenameKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
  for (let index = 0; index < queue.length; index++) {
    if (scan.directories >= RELINK_LIMITS.directories || Date.now() - started > RELINK_LIMITS.milliseconds) { scan.truncated = true; break; }
    const current = queue[index];
    scan.directories++;
    try {
      for await (const entry of await fs.opendir(current.path)) {
        if (++scan.entries > RELINK_LIMITS.entries || Date.now() - started > RELINK_LIMITS.milliseconds) { scan.truncated = true; break; }
        const filePath = path.join(current.path, entry.name);
        if (entry.isDirectory()) {
          if (current.depth >= RELINK_LIMITS.depth || queue.length >= RELINK_LIMITS.directories) scan.truncated = true;
          else queue.push({ path: filePath, depth: current.depth + 1 });
        } else if (entry.isFile() && MEDIA.has(path.extname(entry.name).toLowerCase())) {
          const key = basenameKey(entry.name);
          if (!candidates.has(key)) candidates.set(key, []);
          candidates.get(key).push(filePath);
        }
      }
    } catch (error) { scan.errors.push({ path: current.path, error: error.message }); }
    if (scan.entries > RELINK_LIMITS.entries || Date.now() - started > RELINK_LIMITS.milliseconds) break;
  }
  return { candidates, scan, basenameKey };
}

async function relinkProject(input, folder) {
  const restored = await restoreMedia(await cleanProject(input));
  if (!restored.missing.length) return { ...restored, relinked: [], ambiguous: [] };
  if (!folder) folder = await chooseMediaDirectory();
  if (!folder) return null;
  const { candidates, scan, basenameKey } = await scanMediaFolder(folder);
  const relinked = [];
  const ambiguous = [];
  for (const item of projectMedia(restored.project)) {
    if (!item.media.path || item.media.url) continue;
    const paths = (candidates.get(basenameKey(path.basename(item.media.path))) || [])
      .filter(candidate => item.kinds.includes(MEDIA.get(path.extname(candidate).toLowerCase()))).sort();
    if (paths.length > 1) { ambiguous.push({ ...mediaIdentity(item), candidates: paths }); continue; }
    // A truncated/inaccessible tree cannot prove that a name is unique. Let the
    // operator narrow the folder or choose a file explicitly instead of guessing.
    if (paths.length !== 1 || scan.truncated || scan.errors.length) continue;
    try {
      const registered = await registerComponent(item, paths[0]);
      const previousPath = item.media.path;
      item.media.path = registered.path; item.media.url = registered.url;
      if (registered.hasAlpha !== undefined) item.media.hasAlpha = registered.hasAlpha;
      relinked.push({ ...mediaIdentity(item), previousPath });
    } catch { /* A file removed during scanning remains reported as missing. */ }
  }
  return { ...await restoreMedia(restored.project), relinked, ambiguous, scan };
}

async function readProject(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_PROJECT) throw new Error('Invalid or oversized project file.');
  const project = await cleanProject(JSON.parse(await fs.readFile(filePath, 'utf8')));
  return restoreMedia(project);
}

async function importFiles(paths) {
  if (!Array.isArray(paths) || paths.length > 512) throw new Error('Import at most 512 files at once.');
  const items = [];
  for (const filePath of paths) {
    try {
      const directory = typeof filePath === 'string' && path.isAbsolute(filePath) && (await fs.stat(filePath).catch(() => null))?.isDirectory();
      items.push(directory ? await registerSequence(filePath) : await registerMedia(filePath));
    }
    catch (error) { items.push({ name: path.basename(String(filePath)), path: filePath, error: error.message }); }
  }
  return items;
}

function windowOptions(extra = {}) {
  return {
    backgroundColor: '#111319', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: false,
      navigateOnDragDrop: false, spellcheck: false }, ...extra,
  };
}

function lockWindow(window) {
  window.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (window !== editor || url !== 'about:blank' || !/^prism-output-[a-z0-9-]{1,40}$/.test(frameName) || outputWindows.size >= 16) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: windowOptions({ show: false, title: 'PrismVJ — Output', autoHideMenuBar: true, backgroundColor: '#000000', minWidth: 160, minHeight: 90 }) };
  });
  window.webContents.on('did-create-window', (child, { frameName }) => {
    if (window !== editor) { child.close(); return; }
    outputWindows.set(frameName, child);
    child.setMenu(null);
    child.webContents.on('will-navigate', event => event.preventDefault());
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.on('closed', () => { outputWindows.delete(frameName); notify('prism:output-window-closed', frameName); });
    child.webContents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') child.setFullScreen(false); });
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => {
    void log(`Renderer stopped: ${details.reason}`);
    if (window === output) { window.close(); return; }
    if (hiddenTestWindows) { console.error(`Renderer stopped: ${details.reason}`); app.exit(1); return; }
    dialog.showMessageBox({ type: 'error', title: 'PrismVJ', message: 'The display process stopped.',
      detail: 'Your saved compositions and recovery files are preserved. Restart PrismVJ to recover the last autosave.' }).catch(() => {});
  });
}

function loadWindow(window, isOutput = false) {
  if (devURL) return window.loadURL(`${devURL.replace(/\/$/, '')}/${isOutput ? '?output=1' : ''}`);
  return window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), isOutput ? { query: { output: '1' } } : {});
}

async function createEditor() {
  if (!devURL) await validateBuiltPage(path.join(app.getAppPath(), 'dist'));
  editor = new BrowserWindow(windowOptions({ width: 1540, height: 960, minWidth: 1000, minHeight: 650, title: 'PrismVJ', show: false }));
  editor.setMenu(null);
  lockWindow(editor);
  editor.on('closed', () => { editor = null; if (output && !output.isDestroyed()) output.close(); });
  await loadWindow(editor);
  if (!hiddenTestWindows) editor.show();
}

async function openOutput(displayId) {
  const displays = screen.getAllDisplays();
  const display = displays.find(item => String(item.id) === String(displayId)) || displays.find(item => item.id !== screen.getPrimaryDisplay().id) || displays[0];
  if (output && !output.isDestroyed()) {
    output.setFullScreen(false); output.setBounds(display.bounds); output.setFullScreen(!hiddenTestWindows && displays.length > 1);
    if (!hiddenTestWindows) output.show();
    return true;
  }
  output = new BrowserWindow(windowOptions({ ...display.bounds, show: false, title: 'PrismVJ — Output',
    fullscreen: !hiddenTestWindows && displays.length > 1, frame: displays.length === 1, minWidth: 320, minHeight: 180 }));
  output.setMenu(null);
  lockWindow(output);
  output.on('closed', () => { output = null; frameBusy = false; notify('prism:output-state', false); });
  output.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') output?.setFullScreen(false);
  });
  await loadWindow(output, true);
  if (!hiddenTestWindows) output.showInactive();
  notify('prism:output-state', true);
  return true;
}

function toBuffer(data, maximum) {
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new Error('Expected binary data.');
  const size = data.byteLength;
  if (!size || size > maximum) throw new Error(`Binary payload must contain 1–${maximum} bytes.`);
  return data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function snapshotBuffer(data) {
  const buffer = toBuffer(data, 64 * 1024 * 1024);
  if (buffer.length < 33 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Snapshot data is not a PNG image.');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216) throw new Error('Snapshot dimensions are unsupported.');
  return buffer;
}

// OSC types intentionally supported by the initial contract: i, f, s, T, F, N.
// Reject malformed padding, nonfinite floats, unsupported types and scheduled bundles.
function parseOSC(buffer, depth = 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.length > 65507 || depth > 4) throw new Error('Invalid OSC packet.');
  let cursor = 0;
  const readString = () => {
    const end = buffer.indexOf(0, cursor);
    if (end < cursor || end - cursor > 4096) throw new Error('Invalid OSC string.');
    const value = buffer.toString('utf8', cursor, end);
    const next = (end + 4) & ~3;
    if (next > buffer.length || buffer.subarray(end, next).some(byte => byte !== 0)) throw new Error('Invalid OSC padding.');
    cursor = next; return value;
  };
  const address = readString();
  if (address === '#bundle') {
    if (cursor + 8 > buffer.length || buffer.readBigUInt64BE(cursor) > 1n) throw new Error('Scheduled OSC bundles are not supported.');
    cursor += 8;
    const messages = [];
    while (cursor < buffer.length) {
      if (cursor + 4 > buffer.length) throw new Error('Truncated OSC bundle.');
      const length = buffer.readUInt32BE(cursor); cursor += 4;
      if (!length || cursor + length > buffer.length) throw new Error('Invalid OSC bundle element.');
      messages.push(...parseOSC(buffer.subarray(cursor, cursor + length), depth + 1)); cursor += length;
      if (messages.length > 64) throw new Error('OSC bundle exceeds 64 messages.');
    }
    return messages;
  }
  if (!/^\/[a-zA-Z0-9_\/-]{1,255}$/.test(address)) throw new Error('Invalid OSC address.');
  const tags = readString();
  if (!/^,[ifsTFN]{0,32}$/.test(tags)) throw new Error('Unsupported OSC argument types.');
  const args = [];
  for (const tag of tags.slice(1)) {
    if (tag === 's') { args.push(readString()); continue; }
    if (tag === 'T' || tag === 'F' || tag === 'N') { args.push(tag === 'N' ? null : tag === 'T'); continue; }
    if (cursor + 4 > buffer.length) throw new Error('Truncated OSC argument.');
    const value = tag === 'i' ? buffer.readInt32BE(cursor) : buffer.readFloatBE(cursor);
    if (!Number.isFinite(value)) throw new Error('OSC values must be finite.');
    args.push(value); cursor += 4;
  }
  if (cursor !== buffer.length) throw new Error('Unexpected OSC payload.');
  return [{ address, args }];
}

function oscString(value) {
  const bytes = Buffer.from(`${value}\0`, 'utf8');
  return Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4)]);
}

function encodeOSC(address, args) {
  if (typeof address !== 'string' || !/^\/[\x21-\x7e]{0,254}$/.test(address)) throw new Error('Invalid OSC address.');
  if (!Array.isArray(args) || args.length > 16) throw new Error('Invalid OSC arguments.');
  let tags = ',';
  const payload = args.map(arg => {
    if (typeof arg === 'boolean') { tags += arg ? 'T' : 'F'; return Buffer.alloc(0); }
    if (typeof arg === 'string') { tags += 's'; return oscString(arg.slice(0, 1024)); }
    if (typeof arg !== 'number' || !Number.isFinite(arg)) throw new Error('OSC values must be finite numbers, strings or booleans.');
    const buffer = Buffer.alloc(4);
    if (Number.isInteger(arg) && Math.abs(arg) < 2 ** 31) { tags += 'i'; buffer.writeInt32BE(arg); } else { tags += 'f'; buffer.writeFloatBE(arg); }
    return buffer;
  });
  return Buffer.concat([oscString(address), oscString(tags), ...payload]);
}

// OSC output (manual p. 196): sends state changes to a controller or another app.
async function sendOSC(host, port, messages) {
  if (typeof host !== 'string' || !/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid OSC output host or port.');
  if (!Array.isArray(messages) || messages.length > 256) throw new Error('Invalid OSC message batch.');
  if (!oscOutSocket) {
    oscOutSocket = dgram.createSocket('udp4');
    oscOutSocket.on('error', error => { void log(`OSC out: ${error.message}`); });
    await new Promise(resolve => oscOutSocket.bind(0, resolve));
    oscOutSocket.setBroadcast(true);
  }
  for (const message of messages) oscOutSocket.send(encodeOSC(message.address, message.args || []), port, host);
  return true;
}

async function stopDMX() {
  const sender = dmxSender; dmxSender = null;
  await sender?.stop().catch(() => {});
  return true;
}

async function startDMX(options) {
  await stopDMX();
  const sender = new DmxSender({ protocol: options?.protocol === 'sacn' ? 'sacn' : 'artnet', host: typeof options?.host === 'string' ? options.host : undefined,
    port: Number.isInteger(options?.port) ? options.port : undefined, rate: Number.isFinite(options?.rate) ? options.rate : 44, sourceName: 'PrismVJ' });
  sender.on('error', error => notify('prism:warning', `DMX output: ${error.message}`));
  await sender.start();
  dmxSender = sender;
  return true;
}

async function stopDMXInput() {
  const receiver = dmxReceiver; dmxReceiver = null;
  await receiver?.stop().catch(() => {});
  return true;
}

async function startDMXInput(options) {
  await stopDMXInput();
  const receiver = new DmxReceiver({ protocol: options?.protocol === 'sacn' ? 'sacn' : 'artnet', port: Number.isInteger(options?.port) ? options.port : undefined,
    bindAddress: typeof options?.bindAddress === 'string' ? options.bindAddress : '0.0.0.0', universes: Array.isArray(options?.universes) ? options.universes.slice(0, 64) : undefined });
  receiver.on('dmx', frame => notify('prism:dmx-input', { universe: frame.universe, data: frame.data }));
  receiver.on('error', error => notify('prism:warning', `DMX input: ${error.message}`));
  await receiver.start();
  dmxReceiver = receiver;
  return true;
}

async function stopOSC() {
  const socket = oscSocket; oscSocket = null;
  if (socket) await new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } });
  oscState = { ...oscState, active: false, port: null };
  return oscState;
}

async function startOSC(port = 7000, host = '127.0.0.1') {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('Invalid OSC port or bind address.');
  await stopOSC();
  const socket = dgram.createSocket('udp4');
  let budgetAt = Date.now(), count = 0;
  socket.on('message', (packet, remote) => {
    if (Date.now() - budgetAt >= 1000) { budgetAt = Date.now(); count = 0; }
    if (++count > 1000) { oscState.rejected++; return; }
    try {
      for (const message of parseOSC(packet)) { oscState.received++; notify('prism:control', { ...message, source: 'osc', remote: remote.address }); }
    } catch { oscState.rejected++; }
  });
  socket.on('error', error => { void log(`OSC: ${error.message}`); notify('prism:osc-error', error.message); });
  await new Promise((resolve, reject) => {
    const failed = error => { socket.removeListener('listening', ready); socket.close(); reject(error); };
    const ready = () => { socket.removeListener('error', failed); resolve(); };
    socket.once('error', failed); socket.once('listening', ready); socket.bind(port, host);
  });
  oscSocket = socket;
  oscState = { active: true, port, host, received: 0, rejected: 0 };
  return oscState;
}

function setupIPC() {
  handle('prism:import', async () => {
    const result = await dialog.showOpenDialog(editor, { title: 'Import media', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Media', extensions: [...MEDIA.keys()].map(ext => ext.slice(1)) }] });
    return result.canceled ? [] : importFiles(result.filePaths);
  });
  handle('prism:import-paths', importFiles);
  handle('prism:media-thumbnails', mediaThumbnails);
  handle('prism:import-sequence', async (target, fps) => {
    let folder = typeof target === 'string' && target ? target : null;
    if (!folder) {
      const result = await dialog.showOpenDialog(editor, { title: 'Import image sequence (choose its folder)', properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      folder = result.filePaths[0];
    }
    return registerSequence(folder, sequenceFps(fps) || SEQUENCE_FPS);
  });
  handle('prism:media-roots', browseRoots);
  handle('prism:media-directory', browseDirectory);
  handle('prism:media-choose-directory', chooseMediaDirectory);
  handle('prism:media-reconnect', reconnectMedia);
  handle('prism:media-relink', relinkProject);
  handle('prism:media-reveal', async filePath => {
    const absolute = absolutePath(filePath);
    await fs.stat(absolute);
    shell.showItemInFolder(absolute);
    return true;
  });
  handle('prism:save', async (input, saveAs = false) => {
    const project = await cleanProject(input);
    let destination = currentProjectPath;
    if (saveAs || !destination) {
      const result = await dialog.showSaveDialog(editor, { title: 'Save composition', defaultPath: destination || `${project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.prism`,
        filters: [{ name: 'Prism composition', extensions: ['prism', 'json'] }] });
      if (result.canceled || !result.filePath) return null;
      destination = result.filePath;
    }
    const operation = saveQueue.then(() => atomicWrite(destination, JSON.stringify(project, null, 2)));
    saveQueue = operation.catch(() => {}); await operation;
    currentProjectPath = destination;
    return { path: destination };
  });
  handle('prism:open', async () => {
    const result = await dialog.showOpenDialog(editor, { title: 'Open composition', properties: ['openFile'],
      filters: [{ name: 'Prism composition', extensions: ['prism', 'json'] }] });
    if (result.canceled) return null;
    const restored = await readProject(result.filePaths[0]);
    currentProjectPath = result.filePaths[0];
    return { ...restored, path: currentProjectPath };
  });
  handle('prism:reset-project-path', () => { currentProjectPath = null; return true; });
  handle('prism:autosave', async input => {
    const project = await cleanProject(input);
    const operation = saveQueue.then(() => atomicWrite(recoveryPath, JSON.stringify(project)));
    saveQueue = operation.catch(() => {}); await operation; return true;
  });
  handle('prism:recover', async () => {
    const folder = path.dirname(recoveryPath);
    const entries = (await fs.readdir(folder)).filter(name => /^recovery-.*\.prism$/.test(name));
    const candidates = await Promise.all(entries.map(async name => ({ file: path.join(folder, name), stat: await fs.stat(path.join(folder, name)) })));
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const errors = [];
    for (const candidate of candidates) {
      if (candidate.file === recoveryPath) continue;
      try {
        const restored = await readProject(candidate.file);
        if (errors.length) notify('prism:warning', `Skipped ${errors.length} unreadable recovery file(s); originals preserved.`);
        return restored.project;
      } catch (error) { errors.push(error.message); void log(`Recovery preserved unreadable file ${candidate.file}: ${error.message}`); }
    }
    if (errors.length) throw new Error('Recovery files could not be read. They have been preserved in the application data folder.');
    return null;
  });
  handle('prism:displays', () => screen.getAllDisplays().map(item => ({ id: item.id, label: item.label || `Display ${item.id}`, width: item.bounds.width, height: item.bounds.height })));
  handle('prism:output-open', openOutput);
  handle('prism:output-close', () => { output?.close(); return true; });
  handle('prism:output-status', () => Boolean(output && !output.isDestroyed()), true);
  handle('prism:snapshot-save', async (kind, name, data) => {
    if (kind !== 'clip' && kind !== 'output') throw new Error('Unknown snapshot type.');
    const buffer = snapshotBuffer(data);
    const safeName = String(name || kind).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 80) || kind;
    const filename = `Prism-${kind}-${safeName}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.png`;
    const destination = path.join(app.getPath('userData'), 'Recordings', filename);
    await atomicWrite(destination, buffer);
    return destination;
  });
  handle('prism:record-save', async data => {
    const buffer = toBuffer(data, 256 * 1024 * 1024);
    const result = await dialog.showSaveDialog(editor, { title: 'Save recording', defaultPath: `Prism-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`, filters: [{ name: 'WebM video', extensions: ['webm'] }] });
    if (result.canceled || !result.filePath) return null;
    await atomicWrite(result.filePath, buffer);
    return result.filePath;
  });
  handle('prism:record-begin', async () => {
    if (recordings.size) throw new Error('A recording is already open.');
    const result = await dialog.showSaveDialog(editor, { title: 'Record composition', defaultPath: `Prism-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`, filters: [{ name: 'WebM video', extensions: ['webm'] }] });
    if (result.canceled || !result.filePath) return null;
    const id = randomUUID(); const temporary = `${result.filePath}.${id}.part`;
    const file = await fs.open(temporary, 'wx');
    recordings.set(id, { file, temporary, destination: result.filePath, queue: Promise.resolve(), pending: 0, error: null });
    return { id, path: result.filePath };
  });
  handle('prism:record-chunk', async (id, data) => {
    const record = recordings.get(id);
    if (!record || record.finishing) throw new Error('Recording is not open.');
    if (record.error) throw record.error;
    const buffer = toBuffer(data, MAX_CHUNK);
    if (record.pending + buffer.length > 64 * 1024 * 1024) throw new Error('Recording disk queue is full. Stop recording and choose a faster disk.');
    record.pending += buffer.length;
    const operation = record.queue.then(() => {
      if (record.error) throw record.error;
      return record.file.writeFile(buffer);
    });
    record.queue = operation.catch(error => { record.error = error; });
    try { await operation; return true; } finally { record.pending -= buffer.length; }
  });
  handle('prism:record-finish', async id => {
    const record = recordings.get(id);
    if (!record) throw new Error('Recording is not open.');
    record.finishing = true;
    try {
      await record.queue;
      if (record.error) throw record.error;
      await record.file.sync(); await record.file.close();
      await fs.rename(record.temporary, record.destination);
      return record.destination;
    } catch (error) { await record.file.close().catch(() => {}); throw error; }
    finally { recordings.delete(id); }
  });
  handle('prism:osc-start', startOSC);
  handle('prism:osc-stop', stopOSC);
  handle('prism:osc-status', () => ({ ...oscState }));
  handle('prism:osc-send', (host, port, messages) => sendOSC(host, port, messages));
  handle('prism:link-status', () => abletonLink.status());
  handle('prism:link-enable', enabled => abletonLink.setEnabled(enabled, state => notify('prism:link-state', state)));
  handle('prism:link-tempo', bpm => abletonLink.setTempo(bpm));
  handle('prism:link-playing', playing => abletonLink.setPlaying(playing));
  handle('prism:link-start-stop-sync', enabled => abletonLink.setStartStopSync(enabled));
  handle('prism:dmx-start', startDMX);
  handle('prism:dmx-stop', stopDMX);
  handle('prism:dmx-input-start', startDMXInput);
  handle('prism:dmx-input-stop', stopDMXInput);
  ipcMain.on('prism:dmx-send', (event, frames) => {
    if (event.sender !== editor?.webContents || !dmxSender || !Array.isArray(frames) || frames.length > 64) return;
    for (const frame of frames) {
      if (!Array.isArray(frame) || !Number.isInteger(frame[0]) || !(frame[1] instanceof Uint8Array) || frame[1].length > 512) continue;
      try { dmxSender.send(frame[0], frame[1]); } catch { /* invalid universe for this protocol */ }
    }
  });
  handle('prism:isf-scan', async folder => {
    let directory = typeof folder === 'string' && folder ? folder : null;
    if (!directory) {
      const result = await dialog.showOpenDialog(editor, { title: 'Import ISF shader folder', properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      directory = result.filePaths[0];
    }
    return { folder: directory, files: (await scanISFFolder(directory)).map(({ name, text }) => ({ name, text })) };
  });
  handle('prism:capture-sources', async () => (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }))
    .slice(0, 64).map(source => ({ id: source.id, name: source.name, screen: source.id.startsWith('screen:') })));
  handle('prism:capture-select', id => { captureSourceId = typeof id === 'string' ? id.slice(0, 200) : ''; return true; });
  handle('prism:output-window-place', (frameName, displayId, fullscreen) => {
    const child = outputWindows.get(frameName);
    if (!child || child.isDestroyed()) return false;
    const displays = screen.getAllDisplays(), display = displays.find(item => String(item.id) === String(displayId));
    if (display) { child.setFullScreen(false); child.setBounds(display.bounds); }
    child.setFullScreen(!!fullscreen && !!display && !hiddenTestWindows);
    if (!hiddenTestWindows) child.showInactive();
    return true;
  });
  handle('prism:output-window-close', frameName => { outputWindows.get(frameName)?.close(); return true; });
  ipcMain.on('prism:output-frame', (event, data) => {
    try {
      checkSender(event);
      if (!output || output.isDestroyed() || (frameBusy && Date.now() - frameSentAt < 2000)) return;
      const buffer = toBuffer(data, MAX_FRAME);
      frameBusy = true; frameSentAt = Date.now();
      output.webContents.send('prism:output-frame', buffer);
    } catch { /* Drop malformed/late frames without interrupting program output. */ }
  });
  ipcMain.on('prism:output-ack', event => { if (event.sender === output?.webContents) frameBusy = false; });
}

app.whenReady().then(async () => {
  app.setName('PrismVJ');
  if (devURL && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(devURL)) {
    throw new Error('PRISM_DEV_URL must be a localhost HTTP origin with an explicit port.');
  }
  const recoveryDirectory = path.join(app.getPath('userData'), 'recovery');
  await fs.mkdir(recoveryDirectory, { recursive: true });
  // Each process owns its own autosave. Launching a demo cannot overwrite prior recovery.
  recoveryPath = path.join(recoveryDirectory, `recovery-${Date.now()}-${randomUUID()}.prism`);
  protocol.handle('prism-media', async request => {
    try {
      const url = new URL(request.url);
      const asset = url.hostname === 'media' && mediaTokens.get(url.pathname.split('/')[1]);
      const filePath = typeof asset === 'string' ? asset : asset?.gpu ? await gpuMoviePath(asset, url.searchParams) : url.searchParams.has('reverse') ? asset?.reversePath
        : url.searchParams.has('thumbnail') ? asset?.thumbnailPath : asset?.playbackPath;
      if (!filePath || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
      const extension = path.extname(filePath).toLowerCase();
      const types = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.ogv': 'video/ogg', '.ogg': 'video/ogg',
        '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.oga': 'audio/ogg',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' };
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges', 'Accept-Ranges': 'bytes' };
      const range = request.headers.get('range');
      if (range) {
        // Electron's file: fetch currently ignores Range; implement it explicitly so
        // Chromium media seeking never resets to the first frame or reads whole files.
        const stat = await fs.stat(filePath);
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
        const suffix = !match[1];
        const first = suffix ? Math.max(0, stat.size - Number(match[2])) : Number(match[1]);
        const last = suffix || !match[2] ? stat.size - 1 : Math.min(stat.size - 1, Number(match[2]));
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || first > last || first >= stat.size) {
          return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
        }
        Object.assign(headers, { 'Content-Type': types[extension] || 'application/octet-stream', 'Content-Range': `bytes ${first}-${last}/${stat.size}`, 'Content-Length': String(last - first + 1) });
        const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(filePath, { start: first, end: last }));
        return new Response(body, { status: 206, headers });
      }
      if (request.method === 'HEAD') {
        // Electron's file HEAD response reports a zero length. Supply the actual
        // playback file size, including when a MOV token serves a cached WebM.
        const stat = await fs.stat(filePath);
        return new Response(null, { headers: { ...headers, 'Content-Type': types[extension] || 'application/octet-stream', 'Content-Length': String(stat.size) } });
      }
      const response = await net.fetch(pathToFileURL(filePath).href, { method: request.method });
      const resultHeaders = new Headers(response.headers);
      resultHeaders.set('Access-Control-Allow-Origin', '*');
      resultHeaders.set('Accept-Ranges', 'bytes');
      resultHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: resultHeaders });
    } catch { return new Response('Media unavailable', { status: 404 }); }
  });
  // Electron 44 requests midiSysex even for requestMIDIAccess({sysex:false}).
  // Both permission labels are therefore restricted to this trusted editor frame.
  // MIDI, capture devices/screens and audio device selection are limited to
  // the trusted editor frame.
  const canUseMIDI = (contents, permission, details) => ['midi', 'midiSysex', 'media', 'display-capture', 'speaker-selection'].includes(permission)
    && contents === editor?.webContents && details?.isMainFrame !== false && isAppURL(contents.getURL());
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(canUseMIDI(contents, permission, details)));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => canUseMIDI(contents, permission, details));
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (request.frame !== editor?.webContents.mainFrame) { callback({}); return; }
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .then(sources => callback({ video: sources.find(source => source.id === captureSourceId) || sources.find(source => source.id.startsWith('screen:')) || sources[0] }))
      .catch(() => callback({}));
  });
  setupIPC();
  await createEditor();
}).catch(async error => {
  // Report startup failure without a blocking native modal, including failures
  // that occur between preflight and navigation. The launcher captures stderr.
  console.error(`PrismVJ could not start: ${error.message}`);
  await fs.mkdir(app.getPath('userData'), { recursive: true }).catch(() => {});
  await log(`Startup failed: ${error.message}`);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shutdownFinished) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void (async () => {
    await mediaConverter?.close();
    await stopOSC();
    await stopDMX();
    await stopDMXInput();
    abletonLink.stop();
    oscOutSocket?.close();
    await saveQueue;
    for (const record of recordings.values()) {
      record.finishing = true;
      try {
        await record.queue;
        if (record.error) throw record.error;
        await record.file.sync();
        await record.file.close();
        await fs.rename(record.temporary, record.destination);
      } catch (error) {
        await record.file.close().catch(() => {});
        await log(`Recording incomplete, part file preserved: ${error.message}`);
      }
    }
  })().catch(error => log(error.message)).finally(() => {
    shutdownFinished = true;
    app.quit();
  });
});

// Kept available for protocol tests without exposing it through the renderer bridge.
module.exports = { parseOSC, encodeOSC };
