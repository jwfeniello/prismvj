// DMX Output (Lumiverses + fixtures, manual pp. 133-139) and DMX Shortcuts input (pp. 183-188).
// Pure model and pixel sampling, no DOM. Configs are treated as immutable: replace the object to change it
// (normalized results and sampling plans are cached by object identity).

export const DMX_LIMITS = Object.freeze({ lumiverses: 64, universes: 64, fixtures: 1024, columns: 1024, rows: 1024, pixelsPerFixture: 8192, samplesPerFixture: 262144 });
export const DMX_PROTOCOLS = Object.freeze(['artnet', 'sacn']);
export const DMX_ORDERS = Object.freeze(['row-major', 'column-major', 'snake', 'column-snake']);
export const DMX_WHITE_MODES = Object.freeze(['extract', 'add', 'off']);
export const DMX_UNIVERSE_RANGE = Object.freeze({ artnet: Object.freeze([0, 32767]), sacn: Object.freeze([1, 63999]) });
export const DMX_DEFAULT_PORT = Object.freeze({ artnet: 6454, sacn: 5568 });

// Channel letters: r g b; w white; a amber; d dimmer (carries fixture brightness); l luminance (single channel).
const LAYOUTS = {
  rgb: 'rgb', rbg: 'rbg', grb: 'grb', gbr: 'gbr', brg: 'brg', bgr: 'bgr',
  rgbw: 'rgbw', grbw: 'grbw', bgrw: 'bgrw', wrgb: 'wrgb', rgba: 'rgba', w: 'l',
  'dimmer-rgb': 'drgb', 'rgb-dimmer': 'rgbd', 'dimmer-rgbw': 'drgbw',
};
export const DMX_CHANNEL_LAYOUTS = Object.freeze(Object.keys(LAYOUTS));
const R = 0, G = 1, B = 2, W = 3, A = 4, D = 5, L = 6;
const CODE = { r: R, g: G, b: B, w: W, a: A, d: D, l: L };
const LAYOUT_CODES = Object.fromEntries(Object.entries(LAYOUTS).map(([name, letters]) => [name, Uint8Array.from(letters, ch => CODE[ch])]));

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;
const num = (value, min, max, fallback) => finite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const int = (value, min, max, fallback) => finite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
const port = (value, fallback) => Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : fallback;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const ipv4 = value => typeof value === 'string' && IPV4.test(value) && value !== '0.0.0.0' ? value : null;
const label = (value, fallback) => typeof value === 'string' && value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || fallback;
const list = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];

export const fixtureFootprint = fixture => fixture.columns * fixture.rows * (LAYOUT_CODES[fixture.channels] ?? LAYOUT_CODES.rgb).length;

// Universes a fixture occupies: a Lumiverse is 512 channels; larger fixtures spill into the next universes.
function fixtureSpan(lumiverse, fixture) {
  const start = fixture.startChannel - 1, footprint = fixtureFootprint(fixture);
  return { first: lumiverse.universe, last: lumiverse.universe + Math.floor((start + footprint - 1) / 512), start, footprint };
}

function normalizeRect(value) {
  if (!plain(value)) return { x: 0, y: 0, width: 16, height: 16 };
  return { x: num(value.x, -65536, 65536, 0), y: num(value.y, -65536, 65536, 0),
    width: num(value.width, 0.001, 65536, 16), height: num(value.height, 0.001, 65536, 16) };
}

function normalizeInput(value) {
  const src = plain(value) ? value : {};
  const protocol = pick(src.protocol, DMX_PROTOCOLS, 'artnet');
  const [min, max] = DMX_UNIVERSE_RANGE[protocol];
  return {
    enabled: bool(src.enabled, false), protocol, port: port(src.port, DMX_DEFAULT_PORT[protocol]),
    bindAddress: src.bindAddress === '0.0.0.0' ? '0.0.0.0' : ipv4(src.bindAddress) ?? '0.0.0.0',
    universe: int(src.universe, min, max, min), channelOffset: int(src.channelOffset, 0, 511, 0),
  };
}

const normalizedCache = new WeakMap();

export function normalizeDmxConfig(input) {
  const src = plain(input) ? input : {};
  const protocol = pick(src.protocol, DMX_PROTOCOLS, 'artnet');
  const [min, max] = DMX_UNIVERSE_RANGE[protocol];
  const host = ipv4(src.host) ?? (protocol === 'artnet' ? '255.255.255.255' : ''); // '' = sACN multicast
  const config = {
    version: 1, enabled: bool(src.enabled, false), protocol, host, port: port(src.port, DMX_DEFAULT_PORT[protocol]),
    rate: num(src.rate, 1, 100, 44), lumiverses: [], fixtures: [], input: normalizeInput(src.input),
  };
  const lumiverses = new Map(), baseUniverses = new Set();
  for (const raw of list(src.lumiverses, 256)) {
    if (config.lumiverses.length >= DMX_LIMITS.lumiverses) break;
    if (!plain(raw) || !ID.test(raw.id) || lumiverses.has(raw.id)) continue;
    const universe = int(raw.universe, min, max, min);
    if (baseUniverses.has(universe)) continue;
    const lumiverse = {
      id: raw.id, name: label(raw.name, raw.id), universe, host: ipv4(raw.host) ?? '', enabled: bool(raw.enabled, true),
      brightness: num(raw.brightness, 0, 1, 1), delay: int(raw.delay, 0, 1000, 40),
    };
    lumiverses.set(lumiverse.id, lumiverse); baseUniverses.add(universe); config.lumiverses.push(lumiverse);
  }
  const ids = new Set(), used = new Set();
  for (const raw of list(src.fixtures, DMX_LIMITS.fixtures * 4)) {
    if (config.fixtures.length >= DMX_LIMITS.fixtures) break;
    if (!plain(raw) || !ID.test(raw.id) || ids.has(raw.id) || !lumiverses.has(raw.lumiverseId)) continue;
    const fixture = {
      id: raw.id, name: label(raw.name, raw.id), lumiverseId: raw.lumiverseId, enabled: bool(raw.enabled, true),
      startChannel: int(raw.startChannel, 1, 512, 1), rect: normalizeRect(raw.rect), rotation: num(raw.rotation, -360, 360, 0),
      columns: int(raw.columns, 1, DMX_LIMITS.columns, 1), rows: int(raw.rows, 1, DMX_LIMITS.rows, 1),
      order: pick(raw.order, DMX_ORDERS, 'row-major'), flipH: bool(raw.flipH, false), flipV: bool(raw.flipV, false),
      channels: pick(raw.channels, DMX_CHANNEL_LAYOUTS, 'rgb'), brightness: num(raw.brightness, 0, 1, 1),
      gamma: num(raw.gamma, 0.1, 4, 1), whiteMode: pick(raw.whiteMode, DMX_WHITE_MODES, 'extract'), blackLevel: num(raw.blackLevel, 0, 1, 0),
    };
    if (fixture.columns * fixture.rows > DMX_LIMITS.pixelsPerFixture) continue;
    const { first, last } = fixtureSpan(lumiverses.get(fixture.lumiverseId), fixture);
    if (last > max) continue;
    let added = 0;
    for (let u = first; u <= last; u++) if (!used.has(u)) added++;
    if (used.size + added > DMX_LIMITS.universes) continue;
    for (let u = first; u <= last; u++) used.add(u);
    ids.add(fixture.id); config.fixtures.push(fixture);
  }
  normalizedCache.set(config, config);
  return config;
}

function normalized(config) {
  if (!plain(config)) return normalizeDmxConfig(config);
  let result = normalizedCache.get(config);
  if (!result) { result = normalizeDmxConfig(config); normalizedCache.set(config, result); }
  return result;
}

function activeFixtures(cfg) {
  const lumiverses = new Map(cfg.lumiverses.map(lumiverse => [lumiverse.id, lumiverse]));
  const result = [];
  for (const fixture of cfg.fixtures) {
    const lumiverse = lumiverses.get(fixture.lumiverseId);
    if (fixture.enabled && lumiverse?.enabled) result.push([fixture, lumiverse]);
  }
  return result;
}

// Universe -> target host ('' means the sender default: config.host / broadcast / sACN multicast).
export function dmxUniverseRoutes(config) {
  const cfg = normalized(config), routes = new Map();
  for (const [fixture, lumiverse] of activeFixtures(cfg)) {
    const { first, last } = fixtureSpan(lumiverse, fixture);
    for (let u = first; u <= last; u++) if (!routes.has(u)) routes.set(u, lumiverse.host);
  }
  return routes;
}

// Pairs of fixture ids whose patched channels overlap (manual p. 139 marks these red).
export function findChannelOverlaps(config) {
  const cfg = normalized(config);
  const lumiverses = new Map(cfg.lumiverses.map(lumiverse => [lumiverse.id, lumiverse]));
  const ranges = cfg.fixtures.map(fixture => {
    const { first, start, footprint } = fixtureSpan(lumiverses.get(fixture.lumiverseId), fixture);
    const begin = first * 512 + start;
    return { id: fixture.id, begin, end: begin + footprint - 1 };
  }).sort((a, b) => a.begin - b.begin);
  const overlaps = [];
  for (let i = 0; i < ranges.length && overlaps.length < 1024; i++) {
    for (let j = i + 1; j < ranges.length && ranges[j].begin <= ranges[i].end; j++) overlaps.push([ranges[i].id, ranges[j].id]);
  }
  return overlaps.slice(0, 1024);
}

function corners(fixture) {
  const { x, y, width, height } = fixture.rect;
  const cx = x + width / 2, cy = y + height / 2, angle = fixture.rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle), hw = width / 2, hh = height / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos]);
}

// Minimal composition-pixel box covering every active fixture, so the renderer can read back only that region.
export function fixtureSampleRect(config, { width, height } = {}) {
  const EPS = 1e-6;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [fixture] of activeFixtures(normalized(config))) {
    for (const [px, py] of corners(fixture)) {
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
  }
  if (minX === Infinity) return null;
  let x0 = Math.floor(minX + EPS), y0 = Math.floor(minY + EPS), x1 = Math.ceil(maxX - EPS), y1 = Math.ceil(maxY - EPS);
  if (Number.isInteger(width) && width > 0) { x0 = Math.max(0, x0); x1 = Math.min(width, x1); }
  if (Number.isInteger(height) && height > 0) { y0 = Math.max(0, y0); y1 = Math.min(height, y1); }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

// --- Sampling ------------------------------------------------------------------------------------------

function geometrySignature(fixture, frame) {
  const { x, y, width, height } = fixture.rect;
  return `${x},${y},${width},${height},${fixture.rotation},${fixture.columns},${fixture.rows},${fixture.order},${fixture.flipH},${fixture.flipV}|`
    + `${frame.width},${frame.height},${frame.flipY},${frame.rx},${frame.ry},${frame.rw},${frame.rh}`;
}

// Box filter: every frame pixel whose centre falls inside a (rotated) cell contributes to that cell's average.
// Positions outside the frame count as black. Cells smaller than a pixel fall back to their nearest pixel.
function buildGeometry(fixture, frame) {
  const { columns: cols, rows } = fixture, cells = cols * rows;
  const { x, y, width: w, height: h } = fixture.rect;
  const cx = x + w / 2, cy = y + h / 2, angle = fixture.rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const { width: fw, height: fh, flipY, rx, ry } = frame;
  const sx = fw / frame.rw, sy = fh / frame.rh; // frame pixels per composition pixel
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of corners(fixture)) {
    const bx = (px - rx) * sx, by = (py - ry) * sy;
    minX = Math.min(minX, bx); maxX = Math.max(maxX, bx); minY = Math.min(minY, by); maxY = Math.max(maxY, by);
  }
  const x0 = Math.floor(minX), x1 = Math.ceil(maxX), y0 = Math.floor(minY), y1 = Math.ceil(maxY);
  const area = (x1 - x0) * (y1 - y0);
  const step = area > DMX_LIMITS.samplesPerFixture ? Math.ceil(Math.sqrt(area / DMX_LIMITS.samplesPerFixture)) : 1;
  const totals = new Float64Array(cells), cellOf = [], indexOf = [];
  const add = (cell, tx, ty) => {
    totals[cell]++;
    if (tx >= 0 && tx < fw && ty >= 0 && ty < fh) { cellOf.push(cell); indexOf.push(((flipY ? fh - 1 - ty : ty) * fw + tx) * 4); }
  };
  for (let ty = y0; ty < y1; ty += step) {
    const dy = ry + (ty + 0.5) / sy - cy;
    for (let tx = x0; tx < x1; tx += step) {
      const dx = rx + (tx + 0.5) / sx - cx;
      const u = (dx * cos + dy * sin) / w + 0.5, v = (dy * cos - dx * sin) / h + 0.5;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      add(Math.min(rows - 1, Math.floor(v * rows)) * cols + Math.min(cols - 1, Math.floor(u * cols)), tx, ty);
    }
  }
  for (let cell = 0; cell < cells; cell++) {
    if (totals[cell]) continue;
    const lx = ((cell % cols + 0.5) / cols - 0.5) * w, ly = ((Math.floor(cell / cols) + 0.5) / rows - 0.5) * h;
    add(cell, Math.floor((cx + lx * cos - ly * sin - rx) * sx), Math.floor((cy + lx * sin + ly * cos - ry) * sy));
  }
  const offsets = new Int32Array(cells + 1);
  for (const cell of cellOf) offsets[cell + 1]++;
  for (let i = 0; i < cells; i++) offsets[i + 1] += offsets[i];
  const indices = new Int32Array(cellOf.length), cursor = offsets.slice(0, cells);
  for (let k = 0; k < cellOf.length; k++) indices[cursor[cellOf[k]]++] = indexOf[k];
  const inverse = new Float64Array(cells);
  for (let i = 0; i < cells; i++) inverse[i] = 1 / totals[i];
  // DMX pixel order -> cell (row * cols + col), after zig-zag and Pacman flips.
  const order = new Int32Array(cells);
  for (let i = 0; i < cells; i++) {
    let col, row;
    if (fixture.order === 'column-major') { col = Math.floor(i / rows); row = i % rows; }
    else if (fixture.order === 'column-snake') { col = Math.floor(i / rows); row = col & 1 ? rows - 1 - i % rows : i % rows; }
    else if (fixture.order === 'snake') { row = Math.floor(i / cols); col = row & 1 ? cols - 1 - i % cols : i % cols; }
    else { row = Math.floor(i / cols); col = i % cols; }
    if (fixture.flipH) col = cols - 1 - col;
    if (fixture.flipV) row = rows - 1 - row;
    order[i] = row * cols + col;
  }
  return { cells, order, offsets, indices, inverse };
}

function buildLut(gamma, gain, blackLevel) {
  const lut = new Uint8Array(256), floor = blackLevel * 255;
  for (let i = 1; i < 256; i++) {
    const value = 255 * gain * Math.pow(i / 255, gamma);
    lut[i] = value < floor ? 0 : Math.min(255, Math.round(value));
  }
  return lut;
}

function writeFixture(item, pixels) {
  const { geo, comps, lut, bufs, dimmer, needsW, needsA } = item;
  const { order, offsets, indices, inverse } = geo;
  const count = comps.length, whiteOn = item.whiteMode !== 'off', extract = item.whiteMode === 'extract';
  let channel = item.start;
  for (let i = 0; i < geo.cells; i++) {
    const cell = order[i];
    let r = 0, g = 0, b = 0;
    for (let k = offsets[cell], end = offsets[cell + 1]; k < end; k++) { const p = indices[k]; r += pixels[p]; g += pixels[p + 1]; b += pixels[p + 2]; }
    const scale = inverse[cell]; r *= scale; g *= scale; b *= scale;
    let white = 0, amber = 0;
    if (needsW && whiteOn) { white = Math.min(r, g, b); if (extract) { r -= white; g -= white; b -= white; } }
    if (needsA && whiteOn) { amber = Math.min(r, g / 0.75); if (extract) { r -= amber; g -= 0.75 * amber; } } // amber ~ (255,191,0)
    for (let c = 0; c < count; c++) {
      let value;
      switch (comps[c]) {
        case R: value = lut[(r + 0.5) | 0]; break;
        case G: value = lut[(g + 0.5) | 0]; break;
        case B: value = lut[(b + 0.5) | 0]; break;
        case W: value = lut[(white + 0.5) | 0]; break;
        case A: value = lut[(amber + 0.5) | 0]; break;
        case D: value = dimmer; break;
        default: value = lut[Math.min(255, (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.5) | 0)];
      }
      bufs[channel >> 9][channel & 511] = value;
      channel++;
    }
  }
}

// A sampler owns its caches and output buffers. sample() returns the same Map and Uint8Array(512) objects every
// frame (zeroed and refilled): copy them if they must outlive the next call.
export function createDmxSampler() {
  const geometry = new Map(), outputs = new Map(), stats = { builds: 0, plans: 0, frames: 0 };
  let plan = [], planConfig, frame = null;

  function buildPlan(config) {
    const cfg = normalized(config), universes = new Set(), seen = new Set();
    plan = [];
    for (const [fixture, lumiverse] of activeFixtures(cfg)) {
      const sig = geometrySignature(fixture, frame);
      let cached = geometry.get(fixture.id);
      if (!cached || cached.sig !== sig) { cached = { sig, geo: buildGeometry(fixture, frame) }; geometry.set(fixture.id, cached); stats.builds++; }
      seen.add(fixture.id);
      const comps = LAYOUT_CODES[fixture.channels];
      const { first, last, start } = fixtureSpan(lumiverse, fixture);
      const bufs = [];
      for (let u = first; u <= last; u++) {
        let buffer = outputs.get(u);
        if (!buffer) { buffer = new Uint8Array(512); outputs.set(u, buffer); }
        universes.add(u); bufs.push(buffer);
      }
      const dimmed = comps.includes(D), gain = fixture.brightness * lumiverse.brightness;
      plan.push({ geo: cached.geo, comps, start, bufs, lut: buildLut(fixture.gamma, dimmed ? 1 : gain, fixture.blackLevel),
        dimmer: Math.round(255 * gain), whiteMode: fixture.whiteMode, needsW: comps.includes(W), needsA: comps.includes(A) });
    }
    for (const id of geometry.keys()) if (!seen.has(id)) geometry.delete(id);
    for (const u of outputs.keys()) if (!universes.has(u)) outputs.delete(u);
    planConfig = config; stats.plans++;
  }

  function sample(pixels, width, height, config, { flipY = true, region } = {}) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) throw new RangeError('Invalid DMX sample frame size.');
    if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) || pixels.length < width * height * 4) throw new TypeError('DMX sampling needs RGBA bytes for the whole frame.');
    if (region !== undefined && region !== null && !plain(region)) throw new RangeError('Invalid DMX sample region.');
    const rx = region ? region.x : 0, ry = region ? region.y : 0, rw = region ? region.width : width, rh = region ? region.height : height;
    if (!finite(rx) || !finite(ry) || !finite(rw) || !finite(rh) || rw <= 0 || rh <= 0) throw new RangeError('Invalid DMX sample region.');
    const flip = !!flipY;
    if (!frame || frame.width !== width || frame.height !== height || frame.flipY !== flip
      || frame.rx !== rx || frame.ry !== ry || frame.rw !== rw || frame.rh !== rh) {
      frame = { width, height, flipY: flip, rx, ry, rw, rh };
      planConfig = undefined;
    }
    if (config !== planConfig) buildPlan(config);
    for (const buffer of outputs.values()) buffer.fill(0);
    for (const item of plan) writeFixture(item, pixels);
    stats.frames++;
    return outputs;
  }

  return { sample, stats, clear() { geometry.clear(); outputs.clear(); plan = []; planConfig = undefined; frame = null; } };
}

const defaultSampler = createDmxSampler();

// pixels: RGBA bytes of a width x height frame covering `region` of the composition (default: the composition
// itself at 1:1). flipY: true for WebGL readPixels (bottom row first). Returns Map<universe, Uint8Array(512)>.
export function sampleFixtures(pixels, width, height, config, options = {}) {
  return defaultSampler.sample(pixels, width, height, config, options);
}

// --- DMX Shortcuts input -------------------------------------------------------------------------------

// Channel is 1-based within the input Lumiverse; offset is its Channel Offset. fine: 16-bit (coarse, fine) pair.
export function dmxInputToValue(data, channel, { fine = false, invert = false, offset = 0 } = {}) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || !Number.isInteger(channel) || !Number.isInteger(offset)) return null;
  const index = channel - 1 + offset, limit = Math.min(512, data.length);
  if (channel < 1 || index < 0 || index + (fine ? 1 : 0) >= limit) return null;
  const value = fine ? (data[index] * 256 + data[index + 1]) / 65535 : data[index] / 255;
  return invert ? 1 - value : value;
}

// Shortcut groups (radio buttons / dropdowns) split the 0..255 range evenly over their options.
export function dmxValueToIndex(byte, count) {
  if (!Number.isInteger(count) || count < 1 || !finite(byte)) return null;
  return Math.min(count - 1, Math.floor(Math.min(255, Math.max(0, byte)) * count / 256));
}

// Art-Net "Subnet/Universe" as shown in the UI <-> 15-bit Port-Address.
export function artnetPortAddress(net, subnet, universe) {
  const ok = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
  return ok(net, 127) && ok(subnet, 15) && ok(universe, 15) ? net << 8 | subnet << 4 | universe : null;
}
export function splitArtnetPortAddress(address) {
  return Number.isInteger(address) && address >= 0 && address <= 32767 ? { net: address >> 8, subnet: address >> 4 & 15, universe: address & 15 } : null;
}
