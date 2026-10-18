// Advanced Output editor (Resolume-style screen setup): screens/slices list,
// Input Selection and Output Transformation stages with direct manipulation,
// a properties panel, presets, import/export and undo.
import { evaluateExpression } from '../expression.js';
import { normalizeOutputConfig, createScreen, createSlice, createPolygonSlice, createMask, duplicateSlice, shapePoints, rectCorners, boundsOf, identityWarpPoints, uid, OUTPUT_LIMITS } from './output-model.js';
import { quadHomography, applyHomography, invertHomography, createWarpEvaluator, sliceOutputOutline, sliceInputOutline, pointInPolygon, polygonBounds, flattenPath, snapValue, isSimplePolygon } from './geometry.js';
import { OutputMapper } from './mapper.js';

export const PRESET_KEY = 'prism-output-presets';
const COLORS = ['#84ffd4', '#ff8a5c', '#7ab8ff', '#ffd45c', '#d38cff', '#5cffa1', '#ff6fa8', '#5ce1ff'];
const CORNER_SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const rotate = (p, a) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Numeric fields accept arithmetic ("1920/3") or a trailing operation ("/3").
export { evaluateExpression };

const getPath = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const setPath = (object, path, value) => {
  const keys = path.split('.'), last = keys.pop();
  const target = keys.reduce((value, key) => value?.[key], object);
  if (target) target[last] = value;
};

function readPresets(storage) {
  try { const value = JSON.parse(storage?.getItem(PRESET_KEY) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
function writePresets(storage, presets) {
  try { storage?.setItem(PRESET_KEY, JSON.stringify(presets)); return true; } catch { return false; }
}

export function openAdvancedOutput({ host, config: initialConfig, compositionCanvas, compositionSize = {}, displays = [], layers = [], groups = [], onChange = () => {}, onClose = () => {}, outputOptions: initialOptions = {}, onOutputOptions = () => {}, storage } = {}) {
  if (!host) throw new TypeError('openAdvancedOutput needs a host element.');
  const doc = host.ownerDocument, win = doc.defaultView;
  const store = storage === undefined ? (() => { try { return win.localStorage; } catch { return null; } })() : storage;
  const comp = { compositionWidth: Math.max(1, Math.round(compositionSize.width || compositionCanvas?.width || 1920)), compositionHeight: Math.max(1, Math.round(compositionSize.height || compositionCanvas?.height || 1080)) };
  let config = normalizeOutputConfig(initialConfig ? clone(initialConfig) : undefined, comp);
  if (!config.screens.length) config.screens.push(createScreen({ name: 'Screen 1' }, comp));
  let screenId = config.screens[0].id;
  let selected = new Set(config.screens[0].slices[0] ? [config.screens[0].slices[0].id] : []);
  let tab = 'input', mode = 'transform', snapping = true, zoom = 1, pan = { x: 0, y: 0 };
  let drag = null, drawing = null, activePoint = null, spaceHeld = false, renaming = null, closed = false, raf = 0, menu = null, listDrag = null;
  let compCanvas = compositionCanvas || null;
  const options = { testCard: false, identify: false, showFPS: false, showInfo: false, ...initialOptions };
  const undoStack = [], redoStack = [];
  const listeners = [];
  const listen = (target, type, handler, opts) => { target.addEventListener(type, handler, opts); listeners.push(() => target.removeEventListener(type, handler, opts)); };

  // ---- DOM ----------------------------------------------------------------
  const el = (tag, props = {}, ...children) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node && key !== 'list' && key !== 'style') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child.nodeType ? child : doc.createTextNode(String(child)));
    return node;
  };
  let stylesheet = doc.getElementById('ao-stylesheet');
  const ownsStylesheet = !stylesheet;
  if (!stylesheet) {
    stylesheet = el('link', { id: 'ao-stylesheet', rel: 'stylesheet', href: new URL('./output-editor.css', import.meta.url).href });
    doc.head.append(stylesheet);
  }
  const presetSelect = el('select', { id: 'ao-preset-select', title: 'Presets', onchange: () => loadPreset(presetSelect.value) });
  const presetName = el('input', { type: 'text', id: 'ao-preset-name', placeholder: 'Preset name', maxLength: 128 });
  const importInput = el('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: () => importFile(importInput.files?.[0]) });
  const optionButton = (key, label, title) => el('button', { dataset: { option: key }, title, onclick: () => setOption(key, !options[key]) }, label);
  const header = el('div', { class: 'ao-header' },
    el('h1', {}, 'Advanced Output'), presetSelect, presetName,
    el('button', { dataset: { action: 'save-preset' }, onclick: savePreset }, 'Save'),
    el('button', { dataset: { action: 'delete-preset' }, onclick: deletePreset, class: 'ao-danger' }, 'Delete'),
    el('button', { dataset: { action: 'export' }, onclick: exportFile }, 'Export'),
    el('button', { dataset: { action: 'import' }, onclick: () => importInput.click() }, 'Import'), importInput,
    el('span', { class: 'ao-sep' }),
    optionButton('testCard', 'Test Card', 'Show the test card on every output'),
    optionButton('identify', 'Identify', 'Identify displays'),
    optionButton('showFPS', 'FPS', 'Show FPS'),
    optionButton('showInfo', 'Display Info', 'Show display info'),
    el('span', { class: 'ao-spacer' }),
    el('button', { dataset: { action: 'undo' }, title: 'Undo (Ctrl+Z)', onclick: undo }, 'Undo'),
    el('button', { dataset: { action: 'redo' }, title: 'Redo (Ctrl+Y)', onclick: redo }, 'Redo'),
    el('button', { dataset: { action: 'close' }, class: 'ao-primary', onclick: () => close(true) }, 'Close'));
  const tree = el('div', { class: 'ao-tree', id: 'ao-tree' });
  const list = el('div', { class: 'ao-list' },
    el('div', { class: 'ao-list-tools' },
      el('button', { dataset: { action: 'add-screen' }, onclick: addScreen, title: 'Add a virtual screen' }, '+ Screen'),
      el('button', { dataset: { action: 'add-slice' }, onclick: () => addSlice(), title: 'Add a slice' }, '+ Slice'),
      el('button', { dataset: { action: 'add-polygon' }, onclick: () => addPolygon(), title: 'Add a triangle polygon slice' }, '+ Polygon'),
      el('button', { dataset: { action: 'add-mask' }, onclick: () => addMask('rect'), title: 'Add an output mask' }, '+ Mask'),
      el('button', { dataset: { action: 'duplicate' }, onclick: duplicateSelection, title: 'Duplicate (Ctrl+D)' }, 'Duplicate'),
      el('button', { dataset: { action: 'delete' }, onclick: deleteSelection, class: 'ao-danger', title: 'Delete (Del)' }, 'Delete')),
    tree);
  const tabButton = (id, label) => el('button', { dataset: { tab: id }, onclick: () => setTab(id) }, label);
  const modeButton = (id, label) => el('button', { dataset: { mode: id }, onclick: () => { mode = id; activePoint = null; syncToolbar(); } }, label);
  const hint = el('span', { class: 'ao-hint', id: 'ao-hint' });
  const toolbar = el('div', { class: 'ao-toolbar' },
    modeButton('transform', 'Transform'), modeButton('points', 'Edit Points'),
    el('button', { dataset: { action: 'draw' }, onclick: startDrawing, title: 'Click to place points; click the first point or double-click to close' }, 'Draw'),
    el('button', { dataset: { action: 'snap' }, onclick: () => { snapping = !snapping; syncToolbar(); }, title: 'Snap to edges, centre and other slices (hold Ctrl to bypass)' }, 'Snap'),
    el('button', { dataset: { action: 'fit' }, onclick: () => { zoom = 1; pan = { x: 0, y: 0 }; } }, 'Fit'),
    hint);
  const glCanvas = el('canvas', { class: 'ao-gl', id: 'ao-stage-gl' });
  const overlay = el('canvas', { class: 'ao-overlay', id: 'ao-stage-overlay', tabIndex: 0 });
  const stage = el('div', { class: 'ao-stage', id: 'ao-stage' }, glCanvas, overlay);
  const center = el('div', { class: 'ao-center' }, el('div', { class: 'ao-tabs' }, tabButton('input', 'Input Selection'), tabButton('output', 'Output Transformation')), toolbar, stage);
  const props = el('div', { class: 'ao-props', id: 'ao-props' });
  const root = el('div', { class: 'ao-root', id: 'ao-root' }, header, list, center, props);
  host.append(root);

  let mapper = null;
  try {
    mapper = new OutputMapper(glCanvas, { onError: message => { hint.textContent = message; } });
    if (compCanvas) mapper.setSource('composition', compCanvas);
  } catch (error) { hint.textContent = error.message; }

  // ---- Model helpers ------------------------------------------------------
  const currentScreen = () => config.screens.find(s => s.id === screenId) || config.screens[0];
  const screenCtx = screen => ({ ...comp, screenWidth: screen.device.width, screenHeight: screen.device.height });
  function find(id) {
    for (const screen of config.screens) {
      let index = screen.slices.findIndex(s => s.id === id);
      if (index >= 0) return { kind: 'slice', item: screen.slices[index], screen, index };
      index = screen.masks.findIndex(m => m.id === id);
      if (index >= 0) return { kind: 'mask', item: screen.masks[index], screen, index };
    }
    return null;
  }
  const selectedItems = () => [...selected].map(find).filter(Boolean);
  const primary = () => { const items = selectedItems(); return items[items.length - 1] || null; };
  const sliceColor = (screen, slice) => COLORS[Math.max(0, screen.slices.indexOf(slice)) % COLORS.length];

  function checkpoint() {
    undoStack.push(JSON.stringify(config));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(json) {
    config = normalizeOutputConfig(JSON.parse(json), comp);
    if (!config.screens.some(s => s.id === screenId)) screenId = config.screens[0]?.id;
    selected = new Set([...selected].filter(id => find(id)));
    activePoint = null;
    changed(true);
  }
  function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(config)); restore(undoStack.pop()); }
  function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(config)); restore(redoStack.pop()); }

  function emit() {
    mapper?.invalidate();
    try { onChange(clone(config)); } catch (error) { hint.textContent = `Output change failed: ${error.message}`; }
  }
  function changed(structure = false) {
    emit();
    if (structure) { renderTree(); renderProps(); } else { syncTree(); syncProps(); }
  }
  function select(ids, { additive = false } = {}) {
    if (!additive) selected = new Set();
    for (const id of ids) {
      const found = find(id);
      if (!found) continue;
      if (additive && selected.has(id)) selected.delete(id); else selected.add(id);
      screenId = found.screen.id;
    }
    activePoint = null;
    renderTree(); renderProps();
  }
  function selectScreen(id) { screenId = id; selected = new Set(); activePoint = null; renderTree(); renderProps(); }

  // ---- Structure actions ---------------------------------------------------
  function addScreen() {
    if (config.screens.length >= OUTPUT_LIMITS.screens) { hint.textContent = `A setup is limited to ${OUTPUT_LIMITS.screens} screens.`; return; }
    checkpoint();
    const screen = createScreen({ name: `Screen ${config.screens.length + 1}` }, comp);
    config.screens.push(screen);
    screenId = screen.id; selected = new Set([screen.slices[0].id]);
    changed(true);
  }
  function insertSlice(slice) {
    const screen = currentScreen();
    if (screen.slices.length >= OUTPUT_LIMITS.slices) { hint.textContent = `A screen is limited to ${OUTPUT_LIMITS.slices} slices.`; return null; }
    checkpoint();
    screen.slices.unshift(slice);
    selected = new Set([slice.id]); activePoint = null;
    changed(true);
    return slice;
  }
  function addSlice(options = {}) {
    const screen = currentScreen();
    return insertSlice(createSlice({ name: `Slice ${screen.slices.length + 1}`, ...options }, screenCtx(screen)));
  }
  function addPolygon(points) {
    const screen = currentScreen();
    const { compositionWidth: w, compositionHeight: h } = comp;
    return insertSlice(createPolygonSlice({ name: `Polygon ${screen.slices.length + 1}`, input: { points: points || shapePoints('triangle', { x: w * 0.3, y: h * 0.25, width: w * 0.4, height: h * 0.5 }) } }, screenCtx(screen)));
  }
  function addMask(shape = 'rect', points) {
    const screen = currentScreen();
    if (screen.masks.length >= OUTPUT_LIMITS.masks) { hint.textContent = `A screen is limited to ${OUTPUT_LIMITS.masks} masks.`; return; }
    checkpoint();
    const mask = createMask(points ? { points, name: `Mask ${screen.masks.length + 1}` } : { shape, name: `Mask ${screen.masks.length + 1}` }, screenCtx(screen));
    screen.masks.unshift(mask);
    selected = new Set([mask.id]); tab = 'output'; activePoint = null;
    syncToolbar(); changed(true);
  }
  function duplicateSelection() {
    const items = selectedItems();
    if (!items.length) return;
    checkpoint();
    const ids = [];
    for (const { kind, item, screen } of items) {
      const arr = kind === 'slice' ? screen.slices : screen.masks, index = arr.indexOf(item);
      if (kind === 'slice' && screen.slices.length < OUTPUT_LIMITS.slices) { const copy = duplicateSlice(item, screenCtx(screen)); arr.splice(index, 0, copy); ids.push(copy.id); }
      if (kind === 'mask' && screen.masks.length < OUTPUT_LIMITS.masks) { const copy = { ...clone(item), id: uid('mask'), name: `${item.name} copy`.slice(0, 128) }; arr.splice(index, 0, copy); ids.push(copy.id); }
    }
    selected = new Set(ids);
    changed(true);
  }
  function deleteSelection() {
    const items = selectedItems();
    if (!items.length) {
      if (config.screens.length <= 1) return;
      checkpoint();
      config.screens = config.screens.filter(s => s.id !== screenId);
      screenId = config.screens[0].id;
      changed(true); return;
    }
    checkpoint();
    for (const { kind, item, screen } of items) {
      if (kind === 'slice') screen.slices = screen.slices.filter(s => s !== item);
      else screen.masks = screen.masks.filter(m => m !== item);
    }
    selected = new Set(); activePoint = null;
    changed(true);
  }
  function moveItem(id, delta) {
    const found = find(id);
    if (!found) return;
    const arr = found.kind === 'slice' ? found.screen.slices : found.screen.masks;
    const to = found.index + delta;
    if (to < 0 || to >= arr.length) return;
    checkpoint();
    arr.splice(found.index, 1); arr.splice(to, 0, found.item);
    changed(true);
  }
  function moveScreen(id, delta) {
    const index = config.screens.findIndex(s => s.id === id), to = index + delta;
    if (index < 0 || to < 0 || to >= config.screens.length) return;
    checkpoint();
    const [screen] = config.screens.splice(index, 1); config.screens.splice(to, 0, screen);
    changed(true);
  }
  // List drag and drop. Screens reorder among screens; a slice or mask lands before/after a
  // row of its own kind (possibly on another screen), or at the top of a screen it is dropped on.
  function reorder(source, target, after) {
    if (source.kind === 'screen') {
      const from = config.screens.findIndex(s => s.id === source.id);
      const rest = config.screens.filter(s => s.id !== source.id), at = rest.findIndex(s => s.id === target.id);
      if (target.kind !== 'screen' || from < 0 || at < 0 || at + (after ? 1 : 0) === from) return false;
      checkpoint();
      rest.splice(at + (after ? 1 : 0), 0, config.screens[from]);
      config.screens = rest;
      changed(true); return true;
    }
    const found = find(source.id);
    if (!found) return false;
    let screen, index;
    if (target.kind === 'screen') { screen = config.screens.find(s => s.id === target.id); index = 0; }
    else {
      const other = find(target.id);
      if (!other) return false;
      screen = other.screen;
      index = other.kind === found.kind ? other.index + (after ? 1 : 0) : found.kind === 'slice' ? 0 : screen.masks.length;
    }
    if (!screen) return false;
    const key = found.kind === 'slice' ? 'slices' : 'masks', from = found.screen[key], to = screen[key];
    if (from !== to) {
      if (found.kind === 'slice' && from.length <= 1) { hint.textContent = 'A screen always keeps at least one slice.'; return false; }
      if (to.length >= OUTPUT_LIMITS[key]) { hint.textContent = `A screen is limited to ${OUTPUT_LIMITS[key]} ${key}.`; return false; }
    } else {
      if (index > found.index) index--;
      if (index === found.index) return false;
    }
    checkpoint();
    from.splice(found.index, 1); to.splice(index, 0, found.item);
    screenId = screen.id;
    changed(true); return true;
  }

  // Slices can move between screens, but a screen always keeps one slice.
  function moveToScreen(id, targetId) {
    const found = find(id), target = config.screens.find(s => s.id === targetId);
    if (!found || !target || found.screen === target) return;
    if (found.kind === 'slice' && found.screen.slices.length <= 1) { hint.textContent = 'A screen always keeps at least one slice.'; return; }
    checkpoint();
    if (found.kind === 'slice') { found.screen.slices.splice(found.index, 1); target.slices.unshift(found.item); }
    else { found.screen.masks.splice(found.index, 1); target.masks.unshift(found.item); }
    screenId = target.id;
    changed(true);
  }
  function setDevice(screen, value) {
    const old = { ...screen.device };
    if (value.startsWith('display:')) {
      const display = displays.find(d => `display:${d.id}` === value);
      if (!display) return;
      checkpoint();
      // Each physical output can only drive one screen.
      for (const other of config.screens) if (other !== screen && other.device.type === 'display' && other.device.displayId === display.id) other.device = { type: 'virtual', width: other.device.width, height: other.device.height };
      screen.device = { type: 'display', displayId: String(display.id).slice(0, 256), width: clamp(Math.round(display.width), 1, OUTPUT_LIMITS.dimension), height: clamp(Math.round(display.height), 1, OUTPUT_LIMITS.dimension) };
    } else { checkpoint(); screen.device = { type: 'virtual', width: old.width, height: old.height }; }
    rescaleScreen(screen, old.width, old.height);
    changed(true);
  }
  function setScreenSize(screen, width, height) {
    const old = { ...screen.device };
    screen.device = { ...screen.device, width: clamp(Math.round(width), 1, OUTPUT_LIMITS.dimension), height: clamp(Math.round(height), 1, OUTPUT_LIMITS.dimension) };
    rescaleScreen(screen, old.width, old.height);
  }
  // Keep the mapping proportional when the output resolution changes.
  function rescaleScreen(screen, oldWidth, oldHeight) {
    const fx = screen.device.width / oldWidth, fy = screen.device.height / oldHeight;
    if (fx === 1 && fy === 1) return;
    const scale = p => { p.x *= fx; p.y *= fy; for (const key of ['in', 'out']) if (p[key]) { p[key].x *= fx; p[key].y *= fy; } };
    for (const slice of screen.slices) { slice.output.corners.forEach(scale); slice.output.points?.forEach(scale); }
    for (const mask of screen.masks) mask.points.forEach(scale);
  }
  function matchOutputShape(slice, screen) {
    const fx = comp.compositionWidth / screen.device.width, fy = comp.compositionHeight / screen.device.height;
    if (slice.type === 'polygon') { slice.input.points = slice.output.points.map(p => ({ x: p.x * fx, y: p.y * fy })); slice.input.rect = boundsOf(slice.input.points); return; }
    const b = polygonBounds(slice.output.corners);
    slice.input.rect = { x: b.x * fx, y: b.y * fy, width: Math.max(1, b.width * fx), height: Math.max(1, b.height * fy) };
    slice.input.rotation = 0;
  }
  function matchInputShape(slice, screen) {
    const fx = screen.device.width / comp.compositionWidth, fy = screen.device.height / comp.compositionHeight;
    if (slice.type === 'polygon') { slice.output.points = slice.input.points.map(p => ({ x: p.x * fx, y: p.y * fy })); return; }
    slice.output.corners = rectCorners(slice.input.rect).map(p => ({ x: p.x * fx, y: p.y * fy }));
    const w = slice.output.warp;
    slice.output.warp = { mode: w.mode, cols: w.cols, rows: w.rows, points: identityWarpPoints(w.cols, w.rows) };
  }
  // toInput: output := input ("Match output to input"); otherwise input := output.
  function matchSelection(toInput) {
    const slices = selectedItems().filter(f => f.kind === 'slice');
    if (!slices.length) return;
    checkpoint();
    for (const { item, screen } of slices) (toInput ? matchInputShape : matchOutputShape)(item, screen);
    changed(true);
  }
  // Re-sample an existing warp onto a new grid so the current shape is kept.
  function resizeWarp(slice, cols, rows) {
    const warp = slice.output.warp;
    cols = clamp(Math.round(cols), 2, OUTPUT_LIMITS.warpPoints); rows = clamp(Math.round(rows), 2, OUTPUT_LIMITS.warpPoints);
    const evaluate = createWarpEvaluator(warp);
    const points = [];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const p = evaluate(i / (cols - 1), j / (rows - 1)); points.push({ x: p.x, y: p.y }); }
    slice.output.warp = { mode: warp.mode, cols, rows, points };
  }

  // ---- Presets and files --------------------------------------------------
  function renderPresets() {
    const presets = readPresets(store);
    presetSelect.replaceChildren(el('option', { value: '' }, config.preset ? `Preset: ${config.preset}` : 'Presets…'), ...Object.keys(presets).sort().map(name => el('option', { value: name }, name)));
    presetSelect.value = '';
  }
  function savePreset() {
    const name = (presetName.value || config.preset || '').trim().slice(0, 128);
    if (!name) { hint.textContent = 'Type a preset name first.'; presetName.focus(); return; }
    const presets = readPresets(store);
    config.preset = name;
    presets[name] = clone(config);
    hint.textContent = writePresets(store, presets) ? `Saved preset "${name}".` : 'Presets could not be saved (storage unavailable).';
    renderPresets(); emit();
  }
  function loadPreset(name) {
    const preset = readPresets(store)[name];
    if (!preset) return;
    try {
      const next = normalizeOutputConfig(preset, comp);
      if (!next.screens.length) throw new Error('it contains no screens');
      checkpoint();
      config = next; config.preset = name;
      screenId = config.screens[0].id; selected = new Set(); activePoint = null;
      presetName.value = name;
      changed(true); renderPresets();
    } catch (error) { hint.textContent = `Preset "${name}" is invalid: ${error.message}`; }
  }
  function deletePreset() {
    const name = (presetName.value || config.preset || '').trim();
    const presets = readPresets(store);
    if (!name || !presets[name]) { hint.textContent = 'Choose or type an existing preset to delete.'; return; }
    delete presets[name]; writePresets(store, presets); renderPresets();
    hint.textContent = `Deleted preset "${name}".`;
  }
  function exportFile() {
    const blob = new win.Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = win.URL.createObjectURL(blob);
    const link = el('a', { href: url, download: `${(config.preset || 'output-setup').replace(/[^\w -]+/g, '_')}.json` });
    doc.body.append(link); link.click(); link.parentNode.removeChild(link);
    win.setTimeout(() => win.URL.revokeObjectURL(url), 1000);
  }
  async function importFile(file) {
    importInput.value = '';
    if (!file) return;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('file is larger than 8 MB');
      const next = normalizeOutputConfig(JSON.parse(await file.text()), comp);
      if (!next.screens.length) throw new Error('it contains no screens');
      checkpoint();
      config = next; screenId = config.screens[0].id; selected = new Set(); activePoint = null;
      changed(true);
      hint.textContent = `Imported ${file.name}.`;
    } catch (error) { hint.textContent = `Import failed: ${error.message}`; }
  }
  function setOption(key, value) {
    options[key] = value;
    syncToolbar();
    try { onOutputOptions({ ...options }); } catch { /* listener failure must not break the editor */ }
  }
  function setTab(next) {
    tab = next === 'output' ? 'output' : 'input';
    activePoint = null; drawing = null;
    syncToolbar();
    if (selected.size > 1) renderProps();
  }
  function startDrawing() {
    drawing = { points: [] };
    hint.textContent = tab === 'input' ? 'Click to place polygon points. Click the first point or double-click to finish.' : 'Click to place mask points. Click the first point or double-click to finish.';
  }
  function finishDrawing() {
    const points = drawing?.points || [];
    drawing = null;
    if (points.length < 3) { hint.textContent = ''; return; }
    if (!isSimplePolygon(points)) { hint.textContent = 'That shape crosses itself and cannot be triangulated.'; return; }
    if (tab === 'input') addPolygon(points); else addMask('rect', points);
    hint.textContent = '';
  }

  // ---- Stage geometry ---------------------------------------------------------
  const contentSize = () => tab === 'input' ? { width: comp.compositionWidth, height: comp.compositionHeight } : { width: currentScreen().device.width, height: currentScreen().device.height };
  function view() {
    const rect = stage.getBoundingClientRect(), size = contentSize(), pad = 28;
    const fit = Math.max(0.01, Math.min((rect.width - pad * 2) / size.width, (rect.height - pad * 2) / size.height));
    const scale = fit * zoom;
    return { scale, ox: (rect.width - size.width * scale) / 2 + pan.x, oy: (rect.height - size.height * scale) / 2 + pan.y, rect, size };
  }
  const toStage = (v, p) => ({ x: v.ox + p.x * v.scale, y: v.oy + p.y * v.scale });
  const toContent = (v, clientX, clientY) => ({ x: (clientX - v.rect.left - v.ox) / v.scale, y: (clientY - v.rect.top - v.oy) / v.scale });

  // Outline of an item on the current stage (content pixels).
  function outlineOf(found) {
    if (found.kind === 'mask') return flattenPath(found.item.points, found.item.mode, 12);
    return tab === 'input' ? sliceInputOutline(found.item) : sliceOutputOutline(found.item);
  }
  // Transform frame: rotated input rect for regular slices, else the bounding box.
  function frameOf(found) {
    if (tab === 'input' && found.kind === 'slice' && found.item.type !== 'polygon') {
      const r = found.item.input.rect;
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, w: r.width, h: r.height, rot: (found.item.input.rotation || 0) * Math.PI / 180 };
    }
    const b = polygonBounds(outlineOf(found));
    return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, w: b.width, h: b.height, rot: 0 };
  }
  const frameCorner = (f, [sx, sy]) => { const d = rotate({ x: sx * f.w / 2, y: sy * f.h / 2 }, f.rot); return { x: f.cx + d.x, y: f.cy + d.y }; };
  const rotateHandle = (f, scale) => { const d = rotate({ x: 0, y: -f.h / 2 - 26 / scale }, f.rot); return { x: f.cx + d.x, y: f.cy + d.y }; };

  // Point sets moved by the affine transform on the current stage. Slice masks
  // travel with their slice on the Input Selection stage.
  function pointSets(found) {
    if (found.kind === 'mask') return [found.item.points];
    const slice = found.item;
    if (tab === 'output') return [slice.type === 'polygon' ? slice.output.points : slice.output.corners];
    return slice.type === 'polygon' ? [slice.input.points, ...(slice.mask.enabled ? [slice.mask.points] : [])] : (slice.mask.enabled ? [slice.mask.points] : []);
  }
  // Maps frame f0 onto frame f1 (scale in f0's rotated axes, then f1's rotation).
  function affine(f0, f1) {
    const sx = f0.w > 1e-9 ? f1.w / f0.w : 1, sy = f0.h > 1e-9 ? f1.h / f0.h : 1;
    const linear = v => { const a = rotate(v, -f0.rot); return rotate({ x: a.x * sx, y: a.y * sy }, f1.rot); };
    return { linear, map: p => { const d = linear({ x: p.x - f0.cx, y: p.y - f0.cy }); return { x: f1.cx + d.x, y: f1.cy + d.y }; } };
  }
  // `group`: f0/f1 are the selection frame, so rect slices derive their own rect and rotation from the mapped axes.
  function applyAffine(found, snapshot, f0, f1, group = false) {
    const { linear, map } = affine(f0, f1);
    const live = pointSets(found), snap = pointSets(snapshot);
    live.forEach((points, s) => points.forEach((p, i) => {
      const q = map(snap[s][i]); p.x = q.x; p.y = q.y;
      for (const key of ['in', 'out']) if (snap[s][i][key]) p[key] = linear(snap[s][i][key]);
    }));
    if (found.kind === 'slice') {
      const slice = found.item;
      if (tab === 'input' && slice.type !== 'polygon' && group) {
        const r = snapshot.item.input.rect, deg = snapshot.item.input.rotation || 0, rot = deg * Math.PI / 180;
        const c = map({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        const ex = linear(rotate({ x: r.width, y: 0 }, rot)), ey = linear(rotate({ x: 0, y: r.height }, rot));
        const w = Math.max(1, Math.hypot(ex.x, ex.y)), h = Math.max(1, Math.hypot(ey.x, ey.y));
        let turn = (Math.atan2(ex.y, ex.x) - rot) * 180 / Math.PI;
        turn -= Math.round(turn / 360) * 360;
        slice.input.rect = { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h };
        slice.input.rotation = round(deg + turn, 4) || 0;
      } else if (tab === 'input' && slice.type !== 'polygon') {
        slice.input.rect = { x: f1.cx - f1.w / 2, y: f1.cy - f1.h / 2, width: Math.max(1, f1.w), height: Math.max(1, f1.h) };
        slice.input.rotation = round(f1.rot * 180 / Math.PI, 4);
      }
      if (slice.type === 'polygon') { slice.input.rect = boundsOf(slice.input.points); slice.output.corners = rectCorners(boundsOf(slice.output.points)); }
    }
  }

  // Multi-selection: the items transformable on the current stage and their shared bounding box.
  const groupItems = () => selectedItems().filter(f => f.screen.id === currentScreen().id && (tab === 'output' || f.kind === 'slice'));
  function groupFrame(items) {
    const b = polygonBounds(items.flatMap(outlineOf));
    return { cx: b.x + b.width / 2, cy: b.y + b.height / 2, w: b.width, h: b.height, rot: 0 };
  }
  function transformGroup(items, f0, f1) { for (const found of items) applyAffine(found, { ...found, item: clone(found.item) }, f0, f1, true); }
  function transformDrag(f1) {
    drag.current = f1;
    if (drag.members) for (const m of drag.members) applyAffine(m.found, { ...m.found, item: m.snapshot }, drag.frame, f1, true);
    else applyAffine(drag.found, { ...drag.found, item: drag.snapshot }, drag.frame, f1);
  }

  function snapTargets(v, excludeIds) {
    const size = contentSize(), xs = [0, size.width / 2, size.width], ys = [0, size.height / 2, size.height];
    const screen = currentScreen();
    for (const item of [...screen.slices, ...(tab === 'output' ? screen.masks : [])]) {
      if (excludeIds.has(item.id)) continue;
      const b = polygonBounds(outlineOf(find(item.id)));
      xs.push(b.x, b.x + b.width / 2, b.x + b.width); ys.push(b.y, b.y + b.height / 2, b.y + b.height);
    }
    return { xs, ys, threshold: 8 / v.scale };
  }

  // Edit-point handles for the primary selection on the current stage.
  function pointHandles() {
    const found = primary();
    if (!found || mode !== 'points' || found.screen.id !== currentScreen().id) return [];
    const handles = [];
    const pathHandles = (points, kind, bezier) => points.forEach((p, index) => {
      handles.push({ kind, index, x: p.x, y: p.y });
      if (bezier) for (const handle of ['in', 'out']) handles.push({ kind, index, handle, x: p.x + (p[handle]?.x || 0), y: p.y + (p[handle]?.y || 0), anchor: p });
    });
    if (found.kind === 'mask') { if (tab === 'output') pathHandles(found.item.points, 'mask', found.item.mode === 'bezier'); return handles; }
    const slice = found.item;
    if (tab === 'input') {
      if (slice.type === 'polygon') pathHandles(slice.input.points, 'ipoly', false);
      else if (slice.mask.enabled) pathHandles(slice.mask.points, 'smask', slice.mask.mode === 'bezier');
      return handles;
    }
    if (slice.type === 'polygon') { pathHandles(slice.output.points, 'opoly', false); return handles; }
    slice.output.corners.forEach((p, index) => handles.push({ kind: 'corner', index, x: p.x, y: p.y, big: true }));
    const warp = slice.output.warp, H = quadHomography(slice.output.corners);
    if (H && (warp.mode === 'grid' || warp.mode === 'bezier')) warp.points.forEach((p, index) => { const q = applyHomography(H, p.x, p.y); handles.push({ kind: 'warp', index, x: q.x, y: q.y }); });
    return handles;
  }
  function pathFor(kind, found) {
    const slice = found.item;
    return kind === 'mask' ? found.item.points : kind === 'smask' ? slice.mask.points : kind === 'ipoly' ? slice.input.points : kind === 'opoly' ? slice.output.points : null;
  }
  function setHandle(found, h, p, mirror = true) {
    const slice = found.item;
    if (h.kind === 'corner') { slice.output.corners[h.index] = { x: p.x, y: p.y }; return; }
    if (h.kind === 'warp') {
      const H = quadHomography(slice.output.corners), inv = H && invertHomography(H);
      if (!inv) return;
      const q = applyHomography(inv, p.x, p.y), old = slice.output.warp.points[h.index];
      slice.output.warp.points[h.index] = { ...old, x: clamp(q.x, -4, 5), y: clamp(q.y, -4, 5) };
      return;
    }
    const points = pathFor(h.kind, found), point = points[h.index];
    if (h.handle) {
      const offset = { x: p.x - point.x, y: p.y - point.y };
      point[h.handle] = offset;
      if (mirror) point[h.handle === 'in' ? 'out' : 'in'] = { x: -offset.x, y: -offset.y };
    } else { point.x = p.x; point.y = p.y; }
    if (found.kind === 'slice' && slice.type === 'polygon') { slice.input.rect = boundsOf(slice.input.points); slice.output.corners = rectCorners(boundsOf(slice.output.points)); }
  }
  function insertPoint(found, kind, p, threshold) {
    const points = pathFor(kind, found);
    if (!points || points.length >= OUTPUT_LIMITS.points) return false;
    let best = null;
    points.forEach((a, i) => {
      const b = points[(i + 1) % points.length], dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy || 1;
      const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0, 1), d = dist(p, { x: a.x + t * dx, y: a.y + t * dy });
      if (d <= threshold && (!best || d < best.d)) best = { i, t, d };
    });
    if (!best) return false;
    checkpoint();
    const lerp = (list, i, t) => { const a = list[i], b = list[(i + 1) % list.length]; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; };
    if (found.kind === 'slice' && found.item.type === 'polygon') {
      const slice = found.item;
      // Input and output points of a polygon slice stay paired.
      slice.input.points.splice(best.i + 1, 0, lerp(slice.input.points, best.i, best.t));
      slice.output.points.splice(best.i + 1, 0, lerp(slice.output.points, best.i, best.t));
      slice.input.rect = boundsOf(slice.input.points);
    } else points.splice(best.i + 1, 0, lerp(points, best.i, best.t));
    return true;
  }
  function removePoint(found, h) {
    const points = pathFor(h.kind, found);
    if (!points || h.handle || points.length <= 3) return false;
    checkpoint();
    if (found.kind === 'slice' && found.item.type === 'polygon') {
      found.item.input.points.splice(h.index, 1); found.item.output.points.splice(h.index, 1);
      found.item.input.rect = boundsOf(found.item.input.points);
    } else points.splice(h.index, 1);
    activePoint = null;
    return true;
  }
  function hitHandle(v, p) {
    const r = 8 / v.scale;
    const handles = pointHandles();
    for (let i = handles.length - 1; i >= 0; i--) if (dist(handles[i], p) <= r * (handles[i].big ? 1.4 : 1)) return { type: 'point', handle: handles[i] };
    if (mode !== 'transform') return null;
    let f, group = null;
    if (selected.size > 1) {
      group = groupItems();
      if (!group.length) return null;
      f = groupFrame(group);
    } else {
      const found = primary();
      if (!found || found.screen.id !== currentScreen().id || (tab === 'input' && found.kind === 'mask')) return null;
      f = frameOf(found);
    }
    if (dist(rotateHandle(f, v.scale), p) <= r) return { type: 'rotate', frame: f, group };
    for (let k = 0; k < 4; k++) if (dist(frameCorner(f, CORNER_SIGNS[k]), p) <= r) return { type: 'scale', frame: f, corner: k, group };
    return null;
  }
  function stageItems() {
    const screen = currentScreen();
    return [...(tab === 'output' ? screen.masks : []), ...screen.slices].map(item => find(item.id));
  }
  function hitItem(p) {
    for (const found of stageItems()) if (pointInPolygon(p, outlineOf(found))) return found;
    return null;
  }

  // ---- Pointer and keyboard interaction --------------------------------------
  function onPointerDown(event) {
    if (closed) return;
    closeMenu();
    overlay.focus({ preventScroll: true });
    const v = view(), p = toContent(v, event.clientX, event.clientY);
    try { overlay.setPointerCapture(event.pointerId); } catch { /* synthetic events have no capturable pointer */ }
    if (event.button === 1 || spaceHeld) { drag = { type: 'pan', start: { x: event.clientX, y: event.clientY }, pan0: { ...pan } }; return; }
    if (event.button !== 0) return;
    if (drawing) {
      if (drawing.points.length >= 3 && dist(drawing.points[0], p) <= 10 / v.scale) finishDrawing();
      else if (drawing.points.length < OUTPUT_LIMITS.points) drawing.points.push(p);
      return;
    }
    const hit = hitHandle(v, p);
    if (hit) {
      const found = primary();
      if (hit.type === 'point') activePoint = hit.handle;
      drag = { ...hit, start: p, found, snapshot: clone(found.item), moved: false, mirror: !event.altKey,
        members: hit.group?.map(f => ({ found: f, snapshot: clone(f.item) })) };
      return;
    }
    const item = hitItem(p);
    if (item) {
      if (event.shiftKey) { select([item.item.id], { additive: true }); if (!selected.has(item.item.id)) return; }
      else if (!selected.has(item.item.id)) select([item.item.id]);
      const items = selectedItems().filter(f => f.screen.id === currentScreen().id && (tab === 'output' || f.kind === 'slice'));
      drag = { type: 'move', start: p, items: items.map(f => ({ found: f, snapshot: clone(f.item), frame: frameOf(f) })), moved: false };
      return;
    }
    if (!event.shiftKey && selected.size) { selected = new Set(); activePoint = null; renderTree(); renderProps(); }
    drag = { type: 'marquee', start: p, end: p, additive: event.shiftKey };
  }
  function onPointerMove(event) {
    if (!drag || closed) return;
    const v = view(), p = toContent(v, event.clientX, event.clientY), useSnap = snapping && !event.ctrlKey && !event.metaKey;
    if (drag.type === 'pan') { pan = { x: drag.pan0.x + event.clientX - drag.start.x, y: drag.pan0.y + event.clientY - drag.start.y }; return; }
    if (drag.type === 'marquee') { drag.end = p; return; }
    if (!drag.moved) { if (dist(p, drag.start) * v.scale < 2) return; drag.moved = true; checkpoint(); }
    if (drag.type === 'move') {
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (event.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (useSnap) {
        const targets = snapTargets(v, new Set(drag.items.map(entry => entry.found.item.id)));
        const boxes = drag.items.map(({ frame: f }) => polygonBounds([0, 1, 2, 3].map(k => frameCorner(f, CORNER_SIGNS[k]))));
        const best = (edges, delta, list) => {
          let shift = null;
          for (const edge of edges) { const r = snapValue(edge + delta, list, targets.threshold); if (r.snapped && (shift === null || Math.abs(r.value - edge - delta) < Math.abs(shift))) shift = r.value - edge - delta; }
          return shift || 0;
        };
        dx += best(boxes.flatMap(b => [b.x, b.x + b.width / 2, b.x + b.width]), dx, targets.xs);
        dy += best(boxes.flatMap(b => [b.y, b.y + b.height / 2, b.y + b.height]), dy, targets.ys);
      }
      for (const { found, snapshot, frame } of drag.items) applyAffine(found, { ...found, item: snapshot }, frame, { ...frame, cx: frame.cx + dx, cy: frame.cy + dy });
    } else if (drag.type === 'scale') {
      const f = drag.frame, sign = CORNER_SIGNS[drag.corner], fixed = frameCorner(f, [-sign[0], -sign[1]]);
      const d = rotate({ x: p.x - fixed.x, y: p.y - fixed.y }, -f.rot);
      let w = Math.max(1, d.x * sign[0]), h = Math.max(1, d.y * sign[1]);
      if (event.shiftKey && f.w > 0 && f.h > 0) { const s = Math.max(w / f.w, h / f.h); w = f.w * s; h = f.h * s; }
      const c = rotate({ x: sign[0] * w / 2, y: sign[1] * h / 2 }, f.rot);
      transformDrag({ cx: fixed.x + c.x, cy: fixed.y + c.y, w, h, rot: f.rot });
    } else if (drag.type === 'rotate') {
      const f = drag.frame, a0 = Math.atan2(drag.start.y - f.cy, drag.start.x - f.cx), a = Math.atan2(p.y - f.cy, p.x - f.cx);
      let rot = f.rot + a - a0;
      if (event.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
      transformDrag({ ...f, rot });
    } else if (drag.type === 'point') {
      let q = p;
      if (useSnap && !drag.handle.handle) {
        const targets = snapTargets(v, new Set([drag.found.item.id]));
        q = { x: snapValue(p.x, targets.xs, targets.threshold).value, y: snapValue(p.y, targets.ys, targets.threshold).value };
      }
      setHandle(drag.found, drag.handle, q, drag.mirror);
    }
    changed(false);
  }
  function onPointerUp(event) {
    if (!drag) return;
    try { overlay.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
    if (drag.type === 'marquee') {
      const a = drag.start, b = drag.end, x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      if (x1 - x0 > 1 || y1 - y0 > 1) {
        const ids = stageItems().filter(found => { const bb = polygonBounds(outlineOf(found)); const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2; return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1; }).map(found => found.item.id);
        select(drag.additive ? [...new Set([...selected, ...ids])] : ids);
      }
    } else if (drag.moved) renderProps();
    drag = null;
  }
  function onDoubleClick(event) {
    const v = view(), p = toContent(v, event.clientX, event.clientY);
    if (drawing) { finishDrawing(); return; }
    const found = primary();
    if (!found || mode !== 'points') return;
    const hit = hitHandle(v, p);
    if (hit?.type === 'point') { if (removePoint(found, hit.handle)) changed(true); return; }
    const kinds = new Set(pointHandles().filter(h => !h.handle && h.kind !== 'corner' && h.kind !== 'warp').map(h => h.kind));
    for (const kind of kinds) if (insertPoint(found, kind, p, 8 / v.scale)) { changed(true); return; }
  }
  function onWheel(event) {
    event.preventDefault();
    const before = toContent(view(), event.clientX, event.clientY);
    zoom = clamp(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), 0.2, 20);
    const v = view(), after = toContent(v, event.clientX, event.clientY);
    pan = { x: pan.x + (after.x - before.x) * v.scale, y: pan.y + (after.y - before.y) * v.scale };
  }
  function nudge(dx, dy) {
    const found = primary();
    if (!found) return;
    checkpoint();
    if (mode === 'points' && activePoint) {
      const h = pointHandles().find(x => x.kind === activePoint.kind && x.index === activePoint.index && x.handle === activePoint.handle);
      if (h) setHandle(found, h, { x: h.x + dx, y: h.y + dy }, true);
    } else {
      for (const item of selectedItems()) {
        if (tab === 'input' && item.kind === 'mask') continue;
        const f = frameOf(item);
        applyAffine(item, { ...item, item: clone(item.item) }, f, { ...f, cx: f.cx + dx, cy: f.cy + dy });
      }
    }
    changed(false);
  }
  function onKeyDown(event) {
    if (closed || !root.isConnected) return;
    const target = event.target, typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    if (typing) return;
    const ctrl = event.ctrlKey || event.metaKey, key = event.key;
    if (ctrl && key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (ctrl && key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
    if (ctrl && key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelection(); return; }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      const found = primary();
      if (mode === 'points' && activePoint && found) { if (removePoint(found, activePoint)) changed(true); }
      else deleteSelection();
      return;
    }
    if (key === 'Escape') { if (drawing) { drawing = null; hint.textContent = ''; } else if (menu) closeMenu(); else activePoint = null; return; }
    if (key === 'Enter' && drawing) { finishDrawing(); return; }
    if (key === ' ') { spaceHeld = true; event.preventDefault(); return; }
    const step = event.shiftKey ? 10 : 1;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (arrows[key]) { event.preventDefault(); nudge(...arrows[key]); }
  }
  function onKeyUp(event) { if (event.key === ' ') spaceHeld = false; }

  // ---- Stage drawing -------------------------------------------------------
  function draw() {
    const v = view(), dpr = win.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(v.rect.width * dpr)), h = Math.max(1, Math.round(v.rect.height * dpr));
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
    const ctx = overlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const screen = currentScreen(), s = v.scale, size = v.size;
    const box = { x: v.ox, y: v.oy, w: size.width * s, h: size.height * s };
    if (tab === 'input') {
      if (glCanvas.style.display !== 'none') glCanvas.style.display = 'none';
      ctx.fillStyle = '#000'; ctx.fillRect(box.x, box.y, box.w, box.h);
      if (compCanvas) try { ctx.imageSmoothingEnabled = s < 1; ctx.drawImage(compCanvas, box.x, box.y, box.w, box.h); } catch { /* source not ready */ }
    } else if (mapper) {
      const style = glCanvas.style, px = `${Math.round(box.x)}px`, py = `${Math.round(box.y)}px`, pw = `${Math.round(box.w)}px`, ph = `${Math.round(box.h)}px`;
      if (style.display) style.display = '';
      if (style.left !== px) style.left = px;
      if (style.top !== py) style.top = py;
      if (style.width !== pw) style.width = pw;
      if (style.height !== ph) style.height = ph;
      mapper.resize(Math.max(1, Math.min(size.width, Math.round(box.w * dpr))), Math.max(1, Math.min(size.height, Math.round(box.h * dpr))));
      mapper.render(screen, { testCard: options.testCard });
    }
    ctx.strokeStyle = '#5a5a5a'; ctx.lineWidth = 1; ctx.strokeRect(box.x - 0.5, box.y - 0.5, box.w + 1, box.h + 1);
    ctx.fillStyle = '#929292'; ctx.font = '10px Segoe UI, Arial, sans-serif'; ctx.textBaseline = 'bottom';
    ctx.fillText(tab === 'input' ? `Composition ${size.width} × ${size.height}` : `${screen.name} · ${size.width} × ${size.height}`, box.x, box.y - 4);
    const path = points => { ctx.beginPath(); points.forEach((p, i) => { const q = toStage(v, p); ctx[i ? 'lineTo' : 'moveTo'](q.x, q.y); }); ctx.closePath(); };
    for (const found of stageItems().reverse()) {
      const isSel = selected.has(found.item.id), outline = outlineOf(found);
      const color = found.kind === 'mask' ? '#c9a8ff' : sliceColor(screen, found.item);
      const invalid = found.kind === 'slice' && found.item.type === 'polygon' && !isSimplePolygon(found.item.input.points);
      const alpha = found.item.enabled ? 1 : 0.35;
      path(outline);
      if (found.kind === 'slice') { ctx.fillStyle = color; ctx.globalAlpha = alpha * (isSel ? 0.16 : 0.07); ctx.fill(); }
      ctx.globalAlpha = alpha;
      ctx.setLineDash(found.kind === 'mask' ? [6, 4] : []);
      ctx.strokeStyle = invalid ? '#ff4d4d' : isSel ? '#ffffff' : color; ctx.lineWidth = isSel ? 2 : 1.25;
      ctx.stroke(); ctx.setLineDash([]);
      if (found.kind === 'slice' && tab === 'input' && found.item.mask.enabled) {
        path(flattenPath(found.item.mask.points, found.item.mask.mode, 16));
        ctx.setLineDash([3, 3]); ctx.strokeStyle = '#c9a8ff'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      }
      if (found.kind === 'slice' && tab === 'output' && isSel && (found.item.output.warp.mode === 'grid' || found.item.output.warp.mode === 'bezier')) drawWarpGrid(ctx, v, found.item);
      const b = polygonBounds(outline), label = toStage(v, { x: b.x, y: b.y });
      ctx.fillStyle = color; ctx.textBaseline = 'top'; ctx.font = '11px Segoe UI, Arial, sans-serif';
      ctx.fillText(found.item.name, label.x + 4, label.y + 3);
      ctx.globalAlpha = 1;
    }
    const drawFrame = (f, handles, dashed) => {
      const corners = [0, 1, 2, 3].map(k => frameCorner(f, CORNER_SIGNS[k]));
      ctx.strokeStyle = '#84ffd4'; ctx.lineWidth = 1; ctx.setLineDash(dashed ? [4, 3] : []); path(corners); ctx.stroke(); ctx.setLineDash([]);
      if (!handles) return;
      const top = toStage(v, { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 }), rh = toStage(v, rotateHandle(f, s));
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
      ctx.fillStyle = '#84ffd4'; ctx.beginPath(); ctx.arc(rh.x, rh.y, 5, 0, Math.PI * 2); ctx.fill();
      for (const c of corners) { const q = toStage(v, c); ctx.fillStyle = '#112e24'; ctx.fillRect(q.x - 5, q.y - 5, 10, 10); ctx.strokeStyle = '#84ffd4'; ctx.strokeRect(q.x - 5, q.y - 5, 10, 10); }
    };
    const found = primary();
    if (selected.size > 1) {
      // The selection frame follows the gesture (it stays rotated while dragging the rotate handle).
      const items = groupItems();
      if (items.length) drawFrame(drag?.members && drag.current ? drag.current : groupFrame(items), mode === 'transform', true);
    } else if (mode === 'transform' && found && found.screen.id === screen.id && !(tab === 'input' && found.kind === 'mask')) drawFrame(frameOf(found), true, false);
    for (const h of pointHandles()) {
      const q = toStage(v, h), active = activePoint && activePoint.kind === h.kind && activePoint.index === h.index && activePoint.handle === h.handle;
      if (h.handle) { const a = toStage(v, h.anchor); ctx.strokeStyle = '#c9a8ff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
      ctx.fillStyle = active ? '#ffffff' : h.big ? '#84ffd4' : h.handle ? '#c9a8ff' : '#112e24';
      ctx.strokeStyle = '#84ffd4'; ctx.lineWidth = 1.5;
      const r = h.big ? 7 : h.handle ? 3.5 : 4.5;
      ctx.beginPath();
      if (h.big) ctx.rect(q.x - r, q.y - r, r * 2, r * 2); else ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
    if (drawing?.points.length) {
      ctx.strokeStyle = '#ffd45c'; ctx.lineWidth = 1.5; ctx.beginPath();
      drawing.points.forEach((p, i) => { const q = toStage(v, p); ctx[i ? 'lineTo' : 'moveTo'](q.x, q.y); });
      ctx.stroke();
      for (const p of drawing.points) { const q = toStage(v, p); ctx.fillStyle = '#ffd45c'; ctx.fillRect(q.x - 3, q.y - 3, 6, 6); }
    }
    if (drag?.type === 'marquee') {
      const a = toStage(v, drag.start), b = toStage(v, drag.end);
      ctx.setLineDash([4, 3]); ctx.strokeStyle = '#84ffd4'; ctx.lineWidth = 1; ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.setLineDash([]);
    }
  }
  function drawWarpGrid(ctx, v, slice) {
    const H = quadHomography(slice.output.corners);
    if (!H) return;
    const evaluate = createWarpEvaluator(slice.output.warp), { cols, rows } = slice.output.warp, steps = 16;
    ctx.strokeStyle = 'rgba(132,255,212,0.45)'; ctx.lineWidth = 1;
    const line = fn => { ctx.beginPath(); for (let k = 0; k <= steps; k++) { const [u, w] = fn(k / steps), p = evaluate(u, w), q = toStage(v, applyHomography(H, p.x, p.y)); ctx[k ? 'lineTo' : 'moveTo'](q.x, q.y); } ctx.stroke(); };
    for (let i = 0; i < cols; i++) line(t => [i / (cols - 1), t]);
    for (let j = 0; j < rows; j++) line(t => [t, j / (rows - 1)]);
  }
  function loop() {
    if (closed) return;
    raf = win.requestAnimationFrame(loop);
    try { draw(); } catch (error) { hint.textContent = `Stage error: ${error.message}`; }
  }

  // ---- Left list -----------------------------------------------------------
  const detach = node => node?.parentNode?.removeChild(node);
  function deviceLabel(screen) {
    if (screen.device.type === 'display') { const d = displays.find(x => x.id === screen.device.displayId); return `${d?.label || screen.device.displayId} · ${screen.device.width}×${screen.device.height}`; }
    return `Virtual · ${screen.device.width}×${screen.device.height}`;
  }
  function startRename(target, nameNode) {
    renaming = target;
    const input = el('input', { type: 'text', class: 'ao-rename', value: target.name, maxLength: 128 });
    const finish = commit => {
      if (renaming !== target) return;
      renaming = null;
      const value = input.value.trim().slice(0, 128);
      if (commit && value && value !== target.name) { checkpoint(); target.name = value; changed(true); } else renderTree();
    };
    input.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') finish(true); if (event.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', event => event.stopPropagation());
    const row = nameNode.closest('.ao-row');
    if (row) row.draggable = false; // text selection inside the field must not start a row drag
    nameNode.replaceWith(input); input.focus(); input.select();
  }
  function openMenu(x, y, entries) {
    closeMenu();
    menu = el('div', { class: 'ao-menu', id: 'ao-menu' }, entries.map(entry => entry === '-' ? el('hr') : el('button', { disabled: entry.disabled, onclick: () => { closeMenu(); entry.run(); } }, entry.label)));
    root.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(x, win.innerWidth - r.width - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, win.innerHeight - r.height - 4))}px`;
  }
  function closeMenu() { detach(menu); menu = null; }
  function screenMenu(event, screen) {
    event.preventDefault();
    openMenu(event.clientX, event.clientY, [
      { label: 'Virtual output', run: () => setDevice(screen, 'virtual') },
      ...displays.map(d => ({ label: `${d.label || d.id} (${d.width}×${d.height})${config.screens.some(s => s !== screen && s.device.displayId === d.id) ? ' · in use' : ''}`, run: () => setDevice(screen, `display:${d.id}`) })),
      '-',
      { label: 'Rename', run: () => { const node = tree.querySelector(`[data-screen="${screen.id}"] .ao-name`); if (node) startRename(screen, node); } },
      { label: 'Move up', run: () => moveScreen(screen.id, -1) }, { label: 'Move down', run: () => moveScreen(screen.id, 1) },
      { label: 'Delete screen', disabled: config.screens.length <= 1, run: () => { selectScreen(screen.id); deleteSelection(); } },
    ]);
  }
  function mirror(slice, screen) {
    const w = screen.device.width, m = p => ({ x: w - p.x, y: p.y });
    if (slice.type === 'polygon') slice.output.points = slice.output.points.map(m);
    else { const c = slice.output.corners.map(m); slice.output.corners = [c[1], c[0], c[3], c[2]]; }
  }
  function itemMenu(event, found) {
    event.preventDefault();
    if (!selected.has(found.item.id)) select([found.item.id]);
    const slice = found.kind === 'slice' ? found.item : null;
    const act = fn => () => { checkpoint(); fn(); changed(true); };
    openMenu(event.clientX, event.clientY, [
      { label: 'Duplicate', run: duplicateSelection }, { label: 'Delete', run: deleteSelection },
      { label: 'Move up', run: () => moveItem(found.item.id, -1) }, { label: 'Move down', run: () => moveItem(found.item.id, 1) },
      ...(slice ? ['-',
        { label: selected.size > 1 ? 'Match input to output' : 'Match output shape', run: () => matchSelection(false) },
        { label: selected.size > 1 ? 'Match output to input' : 'Match input shape (reset output)', run: () => matchSelection(true) },
        { label: 'Fill composition', disabled: slice.type === 'polygon', run: act(() => { slice.input.rect = { x: 0, y: 0, width: comp.compositionWidth, height: comp.compositionHeight }; slice.input.rotation = 0; }) },
        { label: 'Mirror across x-axis', run: act(() => mirror(slice, found.screen)) }] : []),
      ...config.screens.filter(s => s !== found.screen).map(s => ({ label: `Move to ${s.name}`, run: () => moveToScreen(found.item.id, s.id) })),
    ]);
  }
  const DROP_CLASSES = ['ao-drop-before', 'ao-drop-after', 'ao-drop-into'];
  const clearDropMarks = () => { for (const row of tree.querySelectorAll('.ao-drop-before,.ao-drop-after,.ao-drop-into,.ao-dragging')) row.classList.remove(...DROP_CLASSES, 'ao-dragging'); };
  function dropPlace(event, kind, id) {
    if (!listDrag || listDrag.id === id || (listDrag.kind === 'screen' && kind !== 'screen')) return null;
    if (kind === 'screen' && listDrag.kind !== 'screen') return 'into';
    const r = event.currentTarget.getBoundingClientRect();
    return event.clientY > r.top + r.height / 2 ? 'after' : 'before';
  }
  // Drag-and-drop handlers for one list row (in addition to the up/down buttons).
  const dragProps = (kind, id) => ({
    draggable: true,
    ondragstart: event => {
      listDrag = { kind, id };
      try { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); } catch { /* synthetic events may lack a data transfer */ }
      event.currentTarget.classList.add('ao-dragging');
    },
    ondragover: event => {
      const place = dropPlace(event, kind, id);
      if (!place) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      if (!event.currentTarget.classList.contains(`ao-drop-${place}`)) { event.currentTarget.classList.remove(...DROP_CLASSES); event.currentTarget.classList.add(`ao-drop-${place}`); }
    },
    ondragleave: event => event.currentTarget.classList.remove(...DROP_CLASSES),
    ondrop: event => {
      const place = dropPlace(event, kind, id), source = listDrag;
      event.preventDefault();
      listDrag = null; clearDropMarks();
      if (place) reorder(source, { kind, id }, place === 'after');
    },
    ondragend: () => { listDrag = null; clearDropMarks(); },
  });
  function renderTree() {
    if (renaming) return;
    const rows = [];
    config.screens.forEach(screen => {
      const isCurrent = screen.id === currentScreen().id;
      const nameNode = el('span', { class: 'ao-name' }, screen.name, el('small', {}, deviceLabel(screen)));
      rows.push(el('div', { class: `ao-row ao-screen-row${isCurrent ? ' ao-current' : ''}${isCurrent && !selected.size ? ' ao-selected' : ''}`, dataset: { screen: screen.id }, ...dragProps('screen', screen.id),
        onclick: () => selectScreen(screen.id), oncontextmenu: event => screenMenu(event, screen), ondblclick: () => startRename(screen, nameNode) },
      el('input', { type: 'checkbox', checked: screen.enabled, title: 'Enable output', onclick: event => event.stopPropagation(), onchange: event => { checkpoint(); screen.enabled = event.target.checked; changed(true); } }),
      el('button', { class: 'ao-fold', title: screen.folded ? 'Unfold' : 'Fold', onclick: event => { event.stopPropagation(); screen.folded = !screen.folded; changed(true); } }, screen.folded ? '▸' : '▾'),
      nameNode));
      if (screen.folded) return;
      const itemRow = (item, kind) => {
        const nameText = el('span', { class: 'ao-name' }, item.name);
        return el('div', { class: `ao-row ${kind === 'mask' ? 'ao-mask-row' : 'ao-item-row'}${selected.has(item.id) ? ' ao-selected' : ''}`, dataset: { item: item.id }, ...dragProps(kind, item.id),
          onclick: event => select([item.id], { additive: event.shiftKey || event.ctrlKey || event.metaKey }),
          oncontextmenu: event => { const found = find(item.id); if (found) itemMenu(event, found); }, ondblclick: () => startRename(item, nameText) },
        el('input', { type: 'checkbox', checked: item.enabled, title: 'Enabled', onclick: event => event.stopPropagation(), onchange: event => { checkpoint(); item.enabled = event.target.checked; changed(true); } }),
        kind === 'slice' ? el('span', { class: 'ao-swatch', style: `background:${sliceColor(screen, item)}` }) : null,
        nameText,
        kind === 'mask' ? el('span', { class: 'ao-badge' }, item.invert ? 'hole' : 'mask') : item.type === 'polygon' ? el('span', { class: 'ao-badge' }, 'poly') : null,
        item.solo ? el('span', { class: 'ao-badge' }, 'S') : null,
        el('button', { class: 'ao-mini', title: 'Move up', onclick: event => { event.stopPropagation(); moveItem(item.id, -1); } }, '▲'),
        el('button', { class: 'ao-mini', title: 'Move down', onclick: event => { event.stopPropagation(); moveItem(item.id, 1); } }, '▼'));
      };
      for (const mask of screen.masks) rows.push(itemRow(mask, 'mask'));
      for (const slice of screen.slices) rows.push(itemRow(slice, 'slice'));
    });
    tree.replaceChildren(...rows);
  }
  function syncTree() {
    if (renaming) return;
    for (const row of tree.querySelectorAll('[data-item]')) {
      const found = find(row.dataset.item), name = row.querySelector('.ao-name');
      if (found && name && name.textContent !== found.item.name) name.textContent = found.item.name;
    }
  }

  // ---- Properties panel ------------------------------------------------------
  const RESET = { opacity: 1, 'softEdge.gamma': 1, 'softEdge.power': 2, 'softEdge.luminance': 0.5 };
  const section = (title, ...children) => el('div', { class: 'ao-section' }, el('h3', {}, title), el('div', { class: 'ao-section-body' }, ...children));
  const field = (label, control) => el('div', { class: 'ao-field' }, el('label', {}, label), control);
  const blurOnEnter = input => input.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') input.blur(); });
  // `targets()` returns the objects a field writes to (multi-selection aware).
  function numberInput(path, targets, { min = -OUTPUT_LIMITS.coordinate, max = OUTPUT_LIMITS.coordinate, digits = 2 } = {}) {
    const input = el('input', { type: 'text', inputMode: 'decimal', dataset: { path } });
    input.syncValue = () => { const value = getPath(targets()[0], path); if (doc.activeElement !== input) input.value = Number.isFinite(value) ? String(round(value, digits)) : ''; };
    input.addEventListener('change', () => {
      const list = targets(), value = evaluateExpression(input.value, getPath(list[0], path));
      if (!Number.isFinite(value)) { input.syncValue(); return; }
      checkpoint();
      for (const target of list) setPath(target, path, clamp(value, min, max));
      for (const target of list) if (target.type === 'polygon') target.input.rect = boundsOf(target.input.points);
      changed(false); input.value = String(round(clamp(value, min, max), digits));
    });
    blurOnEnter(input);
    input.syncValue();
    return input;
  }
  function rangeField(label, path, targets, min, max, step = 0.01) {
    const range = el('input', { type: 'range', min, max, step, dataset: { path } });
    const text = numberInput(path, targets, { min, max });
    range.syncValue = () => { range.value = getPath(targets()[0], path) ?? 0; };
    let started = false;
    range.addEventListener('input', () => { if (!started) { checkpoint(); started = true; } for (const t of targets()) setPath(t, path, Number(range.value)); text.syncValue(); changed(false); });
    range.addEventListener('change', () => { started = false; });
    range.addEventListener('dblclick', () => { checkpoint(); for (const t of targets()) setPath(t, path, RESET[path] ?? 0); changed(false); });
    range.syncValue();
    return field(label, el('div', { class: 'ao-range' }, range, text));
  }
  function check(label, path, targets, structure = false) {
    const input = el('input', { type: 'checkbox', dataset: { path } });
    input.syncValue = () => { input.checked = !!getPath(targets()[0], path); };
    input.addEventListener('change', () => { checkpoint(); for (const t of targets()) setPath(t, path, input.checked); changed(structure); });
    input.syncValue();
    return el('label', {}, input, label);
  }
  function selectField(label, path, targets, choices, onSet) {
    const select = el('select', { dataset: { path } }, choices.map(([value, text]) => el('option', { value }, text)));
    select.syncValue = () => { select.value = getPath(targets()[0], path); };
    select.addEventListener('change', () => { checkpoint(); for (const t of targets()) { setPath(t, path, select.value); onSet?.(t); } changed(true); });
    select.syncValue();
    return field(label, select);
  }
  const colourFields = targets => [rangeField('Opacity', 'opacity', targets, 0, 1), rangeField('Brightness', 'brightness', targets, -1, 1), rangeField('Contrast', 'contrast', targets, -1, 1),
    rangeField('Red', 'red', targets, -1, 1), rangeField('Green', 'green', targets, -1, 1), rangeField('Blue', 'blue', targets, -1, 1)];
  const stripHandles = mask => { if (mask.mode === 'linear') for (const p of mask.points) { delete p.in; delete p.out; } };
  const shapeLabel = shape => shape[0].toUpperCase() + shape.slice(1);

  function screenPanels(screen) {
    const targets = () => [currentScreen()];
    const deviceSelect = el('select', { id: 'ao-device', onchange: () => setDevice(currentScreen(), deviceSelect.value) },
      el('option', { value: 'virtual' }, 'Virtual output'), displays.map(d => el('option', { value: `display:${d.id}` }, `${d.label || d.id} (${d.width}×${d.height})`)));
    deviceSelect.value = screen.device.type === 'display' ? `display:${screen.device.displayId}` : 'virtual';
    // Resolution edits rescale the screen's slices and masks proportionally.
    const sizeInput = key => {
      const input = el('input', { type: 'text', inputMode: 'numeric', dataset: { path: `device.${key}` }, disabled: screen.device.type === 'display' });
      input.syncValue = () => { if (doc.activeElement !== input) input.value = String(currentScreen().device[key]); };
      input.addEventListener('change', () => {
        const s = currentScreen(), value = evaluateExpression(input.value, s.device[key]);
        if (!Number.isFinite(value) || s.device.type === 'display') { input.syncValue(); return; }
        checkpoint();
        setScreenSize(s, key === 'width' ? value : s.device.width, key === 'height' ? value : s.device.height);
        changed(true);
      });
      blurOnEnter(input); input.syncValue();
      return input;
    };
    const nameInput = el('input', { type: 'text', value: screen.name, maxLength: 128, onchange: event => { checkpoint(); screen.name = event.target.value.trim().slice(0, 128) || screen.name; changed(true); } });
    blurOnEnter(nameInput);
    return [
      section('Screen', field('Name', nameInput), field('Device', deviceSelect), field('Resolution', el('div', { class: 'ao-pair' }, sizeInput('width'), sizeInput('height'))),
        el('div', { class: 'ao-checks' }, check('Enabled', 'enabled', targets, true)),
        rangeField('Delay (ms)', 'delay', targets, 0, 100, 1), rangeField('Black level', 'blackLevel', targets, 0, 1)),
      section('Colour', ...colourFields(targets)),
      section('Add', el('div', { class: 'ao-actions' },
        el('button', { onclick: () => addSlice() }, 'Slice'), el('button', { onclick: () => addPolygon() }, 'Polygon'),
        ...['rect', 'ellipse', 'triangle'].map(shape => el('button', { onclick: () => addMask(shape) }, `${shapeLabel(shape)} mask`)))),
    ];
  }
  function maskPanels(found, sameKind, nameInput) {
    return [section(selected.size > 1 ? `${selected.size} selected` : 'Output mask', field('Name', nameInput),
      el('div', { class: 'ao-checks' }, check('Enabled', 'enabled', sameKind), check('Invert (hole)', 'invert', sameKind, true)),
      selectField('Point mode', 'mode', sameKind, [['linear', 'Linear'], ['bezier', 'Bezier']], stripHandles),
      field('Points', el('span', {}, String(found.item.points.length))),
      el('div', { class: 'ao-actions' }, ...['rect', 'ellipse', 'triangle'].map(shape => el('button', { onclick: () => {
        checkpoint(); const b = polygonBounds(found.item.points); found.item.points = shapePoints(shape, b); found.item.mode = shape === 'ellipse' ? 'bezier' : 'linear'; changed(true);
      } }, shapeLabel(shape))), el('button', { onclick: duplicateSelection }, 'Duplicate'), el('button', { class: 'ao-danger', onclick: deleteSelection }, 'Delete')))];
  }
  function slicePanels(found, sameKind, nameInput) {
    const slice = found.item, isPoly = slice.type === 'polygon', one = () => [primary()?.item].filter(Boolean);
    const sources = [['composition', 'Composition'], ...layers.map(l => [`layer:${l.id}`, `Layer: ${l.name}`]), ...groups.map(g => [`group:${g.id}`, `Group: ${g.name}`]),
      ...config.screens.filter(s => s !== found.screen && s.device.type === 'virtual').map(s => [`screen:${s.id}`, `Virtual: ${s.name}`])];
    if (!sources.some(([value]) => value === slice.input.source)) sources.push([slice.input.source, slice.input.source]);
    const simple = !isPoly || isSimplePolygon(slice.input.points);
    const panels = [section(selected.size > 1 ? `${selected.size} selected · ${slice.name}` : isPoly ? 'Polygon slice' : 'Slice', field('Name', nameInput),
      el('div', { class: 'ao-checks' }, check('Enabled', 'enabled', sameKind, true), check('Solo', 'solo', sameKind, true), check('Bypass', 'bypass', sameKind, true)),
      selectField('Source', 'input.source', sameKind, sources))];
    const inputFields = isPoly ? [field('Points', el('span', { class: simple ? '' : 'ao-error' }, `${slice.input.points.length}${simple ? '' : ' · not triangulatable'}`))]
      : [field('Position', el('div', { class: 'ao-pair' }, numberInput('input.rect.x', one), numberInput('input.rect.y', one))),
        field('Size', el('div', { class: 'ao-pair' }, numberInput('input.rect.width', one, { min: 1 }), numberInput('input.rect.height', one, { min: 1 }))),
        field('Rotation', numberInput('input.rotation', one, { min: -36000, max: 36000 }))];
    panels.push(section('Input Selection', ...inputFields, el('div', { class: 'ao-checks' }, check('Flip H', 'input.flipH', sameKind), check('Flip V', 'input.flipV', sameKind))));
    const maskTargets = () => sameKind().map(s => s.mask);
    panels.push(section('Slice Mask', el('div', { class: 'ao-checks' }, check('Enabled', 'mask.enabled', sameKind, true), check('Invert', 'mask.invert', sameKind)),
      selectField('Point mode', 'mode', maskTargets, [['linear', 'Linear'], ['bezier', 'Bezier']], stripHandles),
      el('div', { class: 'ao-actions' }, ...['rect', 'ellipse', 'triangle'].map(shape => el('button', { title: 'Apply a preset mask shape', onclick: () => {
        checkpoint();
        const b = polygonBounds(sliceInputOutline(slice));
        slice.mask = { enabled: true, invert: slice.mask.invert, mode: shape === 'ellipse' ? 'bezier' : 'linear', points: shapePoints(shape, { x: b.x + b.width * 0.1, y: b.y + b.height * 0.1, width: b.width * 0.8, height: b.height * 0.8 }) };
        mode = 'points'; tab = 'input'; syncToolbar(); changed(true);
      } }, shapeLabel(shape))))));
    const matchButtons = [el('button', { onclick: () => { checkpoint(); matchInputShape(slice, found.screen); changed(true); } }, 'Match input'),
      el('button', { onclick: () => { checkpoint(); matchOutputShape(slice, found.screen); changed(true); } }, 'Match output shape')];
    if (isPoly) panels.push(section('Output Transformation', field('Points', el('span', {}, `${slice.output.points.length} (edit on the stage)`)), el('div', { class: 'ao-actions' }, ...matchButtons)));
    else {
      const gridInput = key => {
        const input = el('input', { type: 'text', inputMode: 'numeric', dataset: { path: `output.warp.${key}` } });
        input.syncValue = () => { if (doc.activeElement !== input) input.value = String(primary()?.item.output?.warp[key] ?? 2); };
        input.addEventListener('change', () => {
          const s = primary()?.item, value = s && evaluateExpression(input.value, s.output.warp[key]);
          if (!Number.isFinite(value)) { input.syncValue(); return; }
          checkpoint(); resizeWarp(s, key === 'cols' ? value : s.output.warp.cols, key === 'rows' ? value : s.output.warp.rows); changed(true);
        });
        blurOnEnter(input); input.syncValue();
        return input;
      };
      panels.push(section('Output Transformation',
        ...['Top left', 'Top right', 'Bottom right', 'Bottom left'].map((label, i) => field(label, el('div', { class: 'ao-pair' }, numberInput(`output.corners.${i}.x`, one), numberInput(`output.corners.${i}.y`, one)))),
        selectField('Warp', 'mode', () => one().map(s => s.output.warp), [['none', 'Perspective only'], ['grid', 'Linear grid'], ['bezier', 'Bezier grid']], warp => { if (warp.mode !== 'bezier') for (const p of warp.points) { delete p.hu; delete p.hv; } }),
        field('Grid points', el('div', { class: 'ao-pair' }, gridInput('cols'), gridInput('rows'))),
        el('div', { class: 'ao-actions' }, el('button', { onclick: () => { checkpoint(); const w = slice.output.warp; slice.output.warp = { ...w, points: identityWarpPoints(w.cols, w.rows) }; changed(true); } }, 'Reset warp'), ...matchButtons)));
    }
    panels.push(section('Soft Edge', rangeField('Left', 'softEdge.left', sameKind, 0, 1), rangeField('Right', 'softEdge.right', sameKind, 0, 1),
      rangeField('Top', 'softEdge.top', sameKind, 0, 1), rangeField('Bottom', 'softEdge.bottom', sameKind, 0, 1),
      rangeField('Gamma', 'softEdge.gamma', sameKind, 0.1, 4), rangeField('Power', 'softEdge.power', sameKind, 0.1, 8), rangeField('Luminance', 'softEdge.luminance', sameKind, 0, 1)));
    panels.push(section('Colour', ...colourFields(sameKind), selectField('Blend', 'blendMode', sameKind, [['normal', 'Normal'], ['add', 'Add']]),
      el('div', { class: 'ao-checks' }, check('Is Key', 'isKey', sameKind), check('Black BG', 'blackBg', sameKind))));
    panels.push(section('Actions', el('div', { class: 'ao-actions' }, el('button', { onclick: duplicateSelection }, 'Duplicate'), el('button', { class: 'ao-danger', onclick: deleteSelection }, 'Delete'))));
    return panels;
  }
  // Multi-selection: X/Y/W/H edit the selection's bounding box on the current stage;
  // Rotate turns the whole selection around its centre by the typed angle.
  function selectionPanel() {
    const read = (f, key) => key === 'x' ? f.cx - f.w / 2 : key === 'y' ? f.cy - f.h / 2 : key === 'width' ? f.w : key === 'height' ? f.h : 0;
    const boxInput = key => {
      const input = el('input', { type: 'text', inputMode: 'decimal', dataset: { path: `selection.${key}` }, title: key === 'rotation' ? 'Rotate the selection around its centre (degrees)' : undefined });
      const value = () => { const items = groupItems(); return items.length ? String(round(read(groupFrame(items), key), 2)) : ''; };
      input.syncValue = () => { if (doc.activeElement !== input) input.value = value(); };
      input.addEventListener('change', () => {
        const items = groupItems();
        if (!items.length) { input.syncValue(); return; }
        const f0 = groupFrame(items), next = evaluateExpression(input.value, read(f0, key));
        if (!Number.isFinite(next)) { input.syncValue(); return; }
        const f1 = { ...f0 };
        if (key === 'x') f1.cx = next + f0.w / 2;
        else if (key === 'y') f1.cy = next + f0.h / 2;
        else if (key === 'width') { f1.w = Math.max(1, next); f1.cx = f0.cx - f0.w / 2 + f1.w / 2; }
        else if (key === 'height') { f1.h = Math.max(1, next); f1.cy = f0.cy - f0.h / 2 + f1.h / 2; }
        else f1.rot = clamp(next, -36000, 36000) * Math.PI / 180;
        checkpoint(); transformGroup(items, f0, f1); changed(false);
        input.value = value();
      });
      blurOnEnter(input); input.syncValue();
      return input;
    };
    const slices = selectedItems().filter(f => f.kind === 'slice').length;
    return section(`Selection · ${selected.size} items · ${tab === 'input' ? 'Input' : 'Output'}`,
      field('Position', el('div', { class: 'ao-pair' }, boxInput('x'), boxInput('y'))),
      field('Size', el('div', { class: 'ao-pair' }, boxInput('width'), boxInput('height'))),
      field('Rotate', boxInput('rotation')),
      slices ? el('div', { class: 'ao-actions' },
        el('button', { dataset: { action: 'match-output-to-input' }, title: 'Reset each selected slice\'s output to its input selection', onclick: () => matchSelection(true) }, 'Match output to input'),
        el('button', { dataset: { action: 'match-input-to-output' }, title: 'Set each selected slice\'s input selection to its output shape', onclick: () => matchSelection(false) }, 'Match input to output')) : null);
  }
  function renderProps() {
    const found = primary();
    if (!found) { props.replaceChildren(...screenPanels(currentScreen())); return; }
    const sameKind = () => selectedItems().filter(f => f.kind === found.kind).map(f => f.item);
    const nameInput = el('input', { type: 'text', value: found.item.name, maxLength: 128, onchange: event => { checkpoint(); found.item.name = event.target.value.trim().slice(0, 128) || found.item.name; changed(true); } });
    blurOnEnter(nameInput);
    props.replaceChildren(...(selected.size > 1 ? [selectionPanel()] : []), ...(found.kind === 'mask' ? maskPanels(found, sameKind, nameInput) : slicePanels(found, sameKind, nameInput)));
  }
  function syncProps() { for (const node of props.querySelectorAll('[data-path]')) node.syncValue?.(); }
  function syncToolbar() {
    for (const button of center.querySelectorAll('[data-tab]')) button.classList.toggle('ao-active', button.dataset.tab === tab);
    for (const button of toolbar.querySelectorAll('[data-mode]')) button.classList.toggle('ao-active', button.dataset.mode === mode);
    toolbar.querySelector('[data-action="snap"]').classList.toggle('ao-active', snapping);
    for (const button of header.querySelectorAll('[data-option]')) button.classList.toggle('ao-active', !!options[button.dataset.option]);
  }

  // ---- Lifecycle -------------------------------------------------------------
  listen(overlay, 'pointerdown', onPointerDown);
  listen(overlay, 'pointermove', onPointerMove);
  listen(overlay, 'pointerup', onPointerUp);
  listen(overlay, 'pointercancel', onPointerUp);
  listen(overlay, 'dblclick', onDoubleClick);
  listen(overlay, 'wheel', onWheel, { passive: false });
  listen(overlay, 'contextmenu', event => {
    event.preventDefault();
    const found = hitItem(toContent(view(), event.clientX, event.clientY));
    if (found) itemMenu(event, found);
  });
  listen(win, 'keydown', onKeyDown);
  listen(win, 'keyup', onKeyUp);
  listen(doc, 'pointerdown', event => { if (menu && !menu.contains(event.target)) closeMenu(); });
  renderPresets(); renderTree(); renderProps(); syncToolbar();
  raf = win.requestAnimationFrame(loop);

  function close(fromUser = false) {
    if (closed) return;
    closed = true;
    win.cancelAnimationFrame(raf);
    for (const unlisten of listeners.splice(0)) unlisten();
    closeMenu();
    mapper?.dispose(); mapper = null;
    detach(root);
    if (ownsStylesheet) detach(stylesheet);
    if (fromUser) try { onClose(); } catch { /* listener errors are the caller's concern */ }
  }

  return {
    update(canvas, sources) {
      if (closed) return;
      if (canvas) { compCanvas = canvas; mapper?.setSource('composition', canvas); }
      if (sources) for (const [id, source] of sources) if (id !== 'composition' || !canvas) mapper?.setSource(id, source);
    },
    close: () => close(false),
    getConfig: () => clone(config),
    setConfig(next) {
      const normalized = normalizeOutputConfig(clone(next), comp);
      if (!normalized.screens.length) return;
      checkpoint(); config = normalized;
      if (!config.screens.some(s => s.id === screenId)) screenId = config.screens[0].id;
      selected = new Set([...selected].filter(id => find(id)));
      mapper?.invalidate(); renderTree(); renderProps();
    },
    getOutputOptions: () => ({ ...options }),
    setTab, select: ids => select(ids), undo, redo,
    // Stage content coordinates → client coordinates (integration/testing helper).
    contentToClient(x, y) { const v = view(), p = toStage(v, { x, y }); return { x: v.rect.left + p.x, y: v.rect.top + p.y }; },
    get tab() { return tab; },
    get selection() { return [...selected]; },
  };
}
