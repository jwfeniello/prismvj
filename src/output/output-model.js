// Advanced Output (projection mapping) configuration: screens, slices, polygon
// slices and masks. Pure data; no DOM or WebGL lives here.
export const OUTPUT_LIMITS = Object.freeze({ screens: 16, slices: 256, masks: 32, points: 64, warpPoints: 16, dimension: 16384, coordinate: 65536 });
export const WARP_MODES = ['none', 'perspective', 'grid', 'bezier'];
export const BLEND_MODES = ['normal', 'add'];
export const POINT_MODES = ['linear', 'bezier'];
export const SOURCE_PATTERN = /^(composition|(layer|group|screen):[a-zA-Z0-9_-]{1,100})$/;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const integer = (value, fallback, min, max) => Math.round(number(value, fallback, min, max));
const choice = (value, values, fallback) => values.includes(value) ? value : fallback;
const string = (value, fallback = '', max = 256) => typeof value === 'string' ? value.slice(0, max) : fallback;
const bool = (value, fallback = false) => typeof value === 'boolean' ? value : fallback;
let idCounter = 0;
export const uid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${(++idCounter).toString(36)}`}`;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const safeId = (value, prefix) => validId(value) ? value : uid(prefix);
const C = OUTPUT_LIMITS.coordinate;
const coord = (value, fallback) => number(value, fallback, -C, C);

function array(value, label, max, fallback = []) {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  if (value.length > max) throw new RangeError(`${label} exceeds the limit of ${max}.`);
  return value;
}

const context = (ctx = {}) => {
  const compositionWidth = integer(ctx.compositionWidth, 1920, 1, OUTPUT_LIMITS.dimension);
  const compositionHeight = integer(ctx.compositionHeight, 1080, 1, OUTPUT_LIMITS.dimension);
  return { compositionWidth, compositionHeight,
    screenWidth: integer(ctx.screenWidth, compositionWidth, 1, OUTPUT_LIMITS.dimension),
    screenHeight: integer(ctx.screenHeight, compositionHeight, 1, OUTPUT_LIMITS.dimension) };
};

function point(raw, fallback = { x: 0, y: 0 }) {
  return record(raw) ? { x: coord(raw.x, fallback.x), y: coord(raw.y, fallback.y) } : { x: fallback.x, y: fallback.y };
}
// Bezier path points carry `in`/`out` handle offsets relative to the point.
function pathPoint(raw, bezier) {
  const result = point(raw);
  if (bezier && record(raw)) for (const key of ['in', 'out']) if (record(raw[key])) result[key] = point(raw[key]);
  return result;
}
function pointList(raw, label, min, fallback, bezier = false) {
  const list = array(raw, label, OUTPUT_LIMITS.points, null);
  if (!list) return fallback.map(p => ({ ...p }));
  const result = list.filter(record).map(item => pathPoint(item, bezier));
  return result.length >= min ? result : fallback.map(p => ({ ...p }));
}
function rect(raw, fallback) {
  const r = record(raw) ? raw : {};
  return { x: coord(r.x, fallback.x), y: coord(r.y, fallback.y), width: number(r.width, fallback.width, 1, C), height: number(r.height, fallback.height, 1, C) };
}
export const rectCorners = r => [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];
export const boundsOf = pts => {
  if (!pts.length) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
};
const scalePoints = (pts, sx, sy) => pts.map(p => ({ x: p.x * sx, y: p.y * sy }));

function colour(raw, target) {
  target.opacity = number(raw.opacity, 1, 0, 1);
  target.brightness = number(raw.brightness, 0, -1, 1);
  target.contrast = number(raw.contrast, 0, -1, 1);
  for (const key of ['red', 'green', 'blue']) target[key] = number(raw[key], 0, -1, 1);
  return target;
}

export function identityWarpPoints(cols, rows) {
  const points = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) points.push({ x: i / (cols - 1), y: j / (rows - 1) });
  return points;
}

// Warp points live in the unit square spanned by the perspective corners, so
// linear ('grid') and bezier warping are applied inside the corner pin.
export function normalizeWarp(raw) {
  const r = record(raw) ? raw : {};
  const mode = r.mode === 'linear' ? 'grid' : choice(r.mode, WARP_MODES, 'none');
  const cols = integer(r.cols, 2, 2, OUTPUT_LIMITS.warpPoints);
  const rows = integer(r.rows, 2, 2, OUTPUT_LIMITS.warpPoints);
  const list = array(r.points, 'Warp points', OUTPUT_LIMITS.warpPoints ** 2, null);
  let points;
  if (list && list.length === cols * rows && list.every(record)) {
    points = list.map((p, index) => {
      const fallback = { x: (index % cols) / (cols - 1), y: Math.floor(index / cols) / (rows - 1) };
      const result = { x: number(p.x, fallback.x, -4, 5), y: number(p.y, fallback.y, -4, 5) };
      if (mode === 'bezier') for (const key of ['hu', 'hv']) if (record(p[key])) result[key] = { x: number(p[key].x, 0, -4, 4), y: number(p[key].y, 0, -4, 4) };
      return result;
    });
  } else points = identityWarpPoints(cols, rows);
  return { mode, cols, rows, points };
}

function softEdge(raw) {
  const r = record(raw) ? raw : {};
  return { left: number(r.left, 0, 0, 1), right: number(r.right, 0, 0, 1), top: number(r.top, 0, 0, 1), bottom: number(r.bottom, 0, 0, 1),
    gamma: number(r.gamma, 1, 0.1, 4), power: number(r.power, 2, 0.1, 8), luminance: number(r.luminance, 0.5, 0, 1) };
}

function sliceMask(raw) {
  const r = record(raw) ? raw : {};
  const mode = choice(r.mode, POINT_MODES, 'linear');
  const points = pointList(r.points, 'Slice mask points', 3, [], mode === 'bezier');
  return { enabled: bool(r.enabled) && points.length >= 3, invert: bool(r.invert), mode, points };
}

function normalizeSlice(raw, index, ctx, id) {
  if (!record(raw)) throw new TypeError(`Slice ${index + 1} is invalid.`);
  const { compositionWidth: cw, compositionHeight: ch, screenWidth: sw, screenHeight: sh } = ctx;
  const type = raw.type === 'polygon' ? 'polygon' : 'slice';
  const rawInput = record(raw.input) ? raw.input : {};
  const rawOutput = record(raw.output) ? raw.output : {};
  const sx = sw / cw, sy = sh / ch;
  const source = typeof rawInput.source === 'string' && SOURCE_PATTERN.test(rawInput.source) ? rawInput.source : 'composition';
  const input = { source, rect: null, rotation: 0, flipH: bool(rawInput.flipH), flipV: bool(rawInput.flipV) };
  const output = {};
  if (type === 'polygon') {
    const fallback = [{ x: cw / 2, y: ch * 0.2 }, { x: cw * 0.8, y: ch * 0.8 }, { x: cw * 0.2, y: ch * 0.8 }];
    input.points = pointList(rawInput.points, 'Polygon points', 3, fallback);
    input.rect = boundsOf(input.points);
    const outPoints = array(rawOutput.points, 'Polygon output points', OUTPUT_LIMITS.points, null);
    output.points = outPoints && outPoints.length === input.points.length && outPoints.every(record)
      ? outPoints.map((p, i) => point(p, { x: input.points[i].x * sx, y: input.points[i].y * sy }))
      : scalePoints(input.points, sx, sy);
    output.corners = rectCorners(boundsOf(output.points));
    output.warp = { mode: 'none', cols: 2, rows: 2, points: identityWarpPoints(2, 2) };
  } else {
    input.rect = rect(rawInput.rect, { x: 0, y: 0, width: cw, height: ch });
    input.rotation = number(rawInput.rotation, 0, -36000, 36000);
    const corners = array(rawOutput.corners, 'Output corners', 4, null);
    const fallback = scalePoints(rectCorners(input.rect), sx, sy);
    output.corners = corners && corners.length === 4 ? corners.map((p, i) => point(p, fallback[i])) : fallback;
    output.warp = normalizeWarp(rawOutput.warp);
  }
  const slice = { id, name: string(raw.name, type === 'polygon' ? `Polygon ${index + 1}` : `Slice ${index + 1}`, 128),
    enabled: bool(raw.enabled, true), solo: bool(raw.solo), bypass: bool(raw.bypass), type, input, output,
    mask: sliceMask(raw.mask), softEdge: softEdge(raw.softEdge), blendMode: choice(raw.blendMode, BLEND_MODES, 'normal'),
    isKey: bool(raw.isKey), blackBg: bool(raw.blackBg) };
  return colour(raw, slice);
}

function outputMask(raw, index, id) {
  if (!record(raw)) throw new TypeError(`Mask ${index + 1} is invalid.`);
  const mode = choice(raw.mode, POINT_MODES, 'linear');
  const points = pointList(raw.points, 'Mask points', 3, [], mode === 'bezier');
  if (points.length < 3) throw new TypeError(`Mask ${index + 1} needs at least three points.`);
  return { id, name: string(raw.name, `Mask ${index + 1}`, 128), enabled: bool(raw.enabled, true), invert: bool(raw.invert), mode, points };
}

function normalizeScreen(raw, index, ctx, unique) {
  if (!record(raw)) throw new TypeError(`Screen ${index + 1} is invalid.`);
  const device = record(raw.device) ? raw.device : {};
  const width = integer(device.width, ctx.compositionWidth, 1, OUTPUT_LIMITS.dimension);
  const height = integer(device.height, ctx.compositionHeight, 1, OUTPUT_LIMITS.dimension);
  const displayId = device.type === 'display' ? string(device.displayId, '', 256) : '';
  const screen = { id: unique(raw.id, 'screen'), name: string(raw.name, `Screen ${index + 1}`, 128), enabled: bool(raw.enabled, true), folded: bool(raw.folded),
    device: displayId ? { type: 'display', displayId, width, height } : { type: 'virtual', width, height },
    delay: number(raw.delay, 0, 0, 100), blackLevel: number(raw.blackLevel, 0, 0, 1) };
  colour(raw, screen);
  const sliceCtx = { ...ctx, screenWidth: width, screenHeight: height };
  screen.slices = array(raw.slices, 'Slices', OUTPUT_LIMITS.slices).map((item, i) => normalizeSlice(item, i, sliceCtx, unique(item?.id, 'slice')));
  screen.masks = array(raw.masks, 'Masks', OUTPUT_LIMITS.masks).map((item, i) => outputMask(item, i, unique(item?.id, 'mask')));
  return screen;
}

// Build an allow-listed copy: unknown fields never survive, numbers are clamped
// and counts are capped. Structural problems throw like validateProject().
export function normalizeOutputConfig(input, options = {}) {
  const ctx = context(options);
  if (input === undefined || input === null) return createOutputConfig(ctx);
  if (!record(input)) throw new TypeError('The output configuration must be an object.');
  if (input.version !== undefined && input.version !== 1) throw new TypeError('Unsupported output configuration version. Expected version 1.');
  const used = new Set();
  const unique = (value, prefix) => {
    const id = safeId(value, prefix);
    if (used.has(id)) throw new TypeError(`Duplicate ${prefix} identifier: ${id}`);
    used.add(id); return id;
  };
  const rawScreens = array(input.screens, 'Screens', OUTPUT_LIMITS.screens, null);
  const screens = rawScreens ? rawScreens.map((item, i) => normalizeScreen(item, i, ctx, unique)) : [screenFromComposition(ctx.compositionWidth, ctx.compositionHeight)];
  // Every physical output drives one screen only; later claims fall back to virtual.
  const claimed = new Set();
  for (const screen of screens) {
    if (screen.device.type !== 'display') continue;
    if (claimed.has(screen.device.displayId)) screen.device = { type: 'virtual', width: screen.device.width, height: screen.device.height };
    else claimed.add(screen.device.displayId);
  }
  const config = { version: 1, screens };
  if (typeof input.preset === 'string' && input.preset) config.preset = string(input.preset, '', 128);
  return config;
}

// ctx: { compositionWidth, compositionHeight, screenWidth, screenHeight }
export function createSlice(options = {}, ctx = {}) {
  return normalizeSlice({ ...options, type: 'slice' }, 0, context(ctx), safeId(options.id, 'slice'));
}

export function createPolygonSlice(options = {}, ctx = {}) {
  return normalizeSlice({ name: 'Polygon', ...options, type: 'polygon' }, 0, context(ctx), safeId(options.id, 'slice'));
}

// Preset shapes: rect, ellipse (four bezier points) and triangle.
export function shapePoints(shape = 'rect', { x = 0, y = 0, width = 100, height = 100 } = {}) {
  const cx = x + width / 2, cy = y + height / 2;
  if (shape === 'triangle') return [{ x: cx, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  if (shape === 'ellipse') {
    const k = 0.5522847498, rx = width / 2, ry = height / 2;
    return [
      { x: cx, y, in: { x: -k * rx, y: 0 }, out: { x: k * rx, y: 0 } },
      { x: x + width, y: cy, in: { x: 0, y: -k * ry }, out: { x: 0, y: k * ry } },
      { x: cx, y: y + height, in: { x: k * rx, y: 0 }, out: { x: -k * rx, y: 0 } },
      { x, y: cy, in: { x: 0, y: k * ry }, out: { x: 0, y: -k * ry } },
    ];
  }
  return rectCorners({ x, y, width, height });
}

// options: { shape:'rect'|'ellipse'|'triangle', rect:{x,y,width,height}, name, invert, enabled, mode, points }
export function createMask(options = {}, ctx = {}) {
  const c = context(ctx);
  const shape = options.shape || 'rect';
  const bounds = record(options.rect) ? options.rect : { x: c.screenWidth * 0.25, y: c.screenHeight * 0.25, width: c.screenWidth / 2, height: c.screenHeight / 2 };
  const { shape: _shape, rect: _rect, ...rest } = options;
  const raw = { mode: shape === 'ellipse' ? 'bezier' : 'linear', points: shapePoints(shape, bounds), ...rest };
  return outputMask(raw, 0, safeId(options.id, 'mask'));
}

export function createScreen(options = {}, ctx = {}) {
  const c = context(ctx);
  const device = record(options.device) ? options.device : {};
  const width = integer(device.width, c.compositionWidth, 1, OUTPUT_LIMITS.dimension);
  const height = integer(device.height, c.compositionHeight, 1, OUTPUT_LIMITS.dimension);
  const slices = options.slices ?? [{ name: 'Slice 1' }];
  const used = new Set();
  const unique = (value, prefix) => { let id = safeId(value, prefix); while (used.has(id)) id = uid(prefix); used.add(id); return id; };
  return normalizeScreen({ ...options, id: safeId(options.id, 'screen'), device: { ...device, width, height }, slices }, 0, c, unique);
}

// One virtual screen with one full-frame slice: identical to the plain output.
export function screenFromComposition(width = 1920, height = 1080) {
  return createScreen({ name: 'Screen 1' }, { compositionWidth: width, compositionHeight: height });
}

export function createOutputConfig(ctx = {}) {
  const c = context(ctx);
  return { version: 1, screens: [screenFromComposition(c.compositionWidth, c.compositionHeight)] };
}

// Deep copy with a fresh id (Duplicate action).
export function duplicateSlice(slice, ctx = {}) {
  const copy = JSON.parse(JSON.stringify(slice));
  copy.id = uid('slice');
  copy.name = `${slice.name} copy`.slice(0, 128);
  return normalizeSlice(copy, 0, context(ctx), copy.id);
}
