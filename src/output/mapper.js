// WebGL2 renderer for one Advanced Output screen: draws every enabled slice of a
// screen from its source texture(s) with corner-pin/warp geometry, slice masks,
// soft edges and colour correction, then applies screen colour correction,
// output masks and overlays (test card, identify, FPS/info).
import { buildSliceMesh, sliceSignature, maskSignature, flattenPath, sliceOutputOutline, polygonBounds } from './geometry.js';

const SLICE_VS = `#version 300 es
in vec2 aPos;
in vec2 aUv;
in vec2 aLocal;
uniform mat3 uMatrix;
uniform vec2 uSourceSize;
out vec2 vUv;
out vec2 vLocal;
void main() {
  vec3 p = uMatrix * vec3(aPos, 1.0);
  // Homogeneous w makes the rasteriser interpolate perspective-correctly.
  gl_Position = vec4(p.xy, 0.0, p.z);
  vUv = aUv / uSourceSize;
  vLocal = aLocal;
}`;

const SLICE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vLocal;
uniform sampler2D uSource;
uniform sampler2D uMask;
uniform bool uUseMask;
uniform vec4 uEdge;
uniform vec3 uCurve;
uniform vec3 uColor;
uniform vec3 uGain;
uniform int uFlags;
uniform int uSourceFlags;
out vec4 outColor;
float ramp(float x) {
  x = clamp(x, 0.0, 1.0);
  float f = x < 0.5 ? uCurve.z * pow(2.0 * x, uCurve.y) : 1.0 - (1.0 - uCurve.z) * pow(2.0 - 2.0 * x, uCurve.y);
  return pow(clamp(f, 0.0, 1.0), 1.0 / uCurve.x);
}
float edge(float d, float width) { return width <= 0.0 ? 1.0 : ramp(d / width); }
void main() {
  // Raw pixel sources keep readPixels' bottom-up rows (flag 1) and may be straight alpha (flag 2).
  vec4 c = texture(uSource, (uSourceFlags & 1) != 0 ? vec2(vUv.x, 1.0 - vUv.y) : vUv);
  if ((uSourceFlags & 2) != 0) c.rgb *= c.a;
  if (any(lessThan(vUv, vec2(0.0))) || any(greaterThan(vUv, vec2(1.0)))) c = vec4(0.0);
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  rgb = clamp(((rgb - 0.5) * (1.0 + uColor.y) + 0.5 + uColor.x) * (1.0 + uGain), 0.0, 1.0);
  float a = c.a;
  if ((uFlags & 1) != 0) { rgb = vec3(a); a = 1.0; }
  if ((uFlags & 2) != 0) { rgb *= a; a = 1.0; } else rgb *= a;
  float k = edge(vLocal.x, uEdge.x) * edge(1.0 - vLocal.x, uEdge.y) * edge(vLocal.y, uEdge.z) * edge(1.0 - vLocal.y, uEdge.w) * uColor.z;
  if (uUseMask) k *= texture(uMask, vLocal).a;
  outColor = vec4(rgb, a) * k;
}`;

const SCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const SCREEN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uMask;
uniform sampler2D uOverlay;
uniform bool uUseMask;
uniform bool uUseOverlay;
uniform bool uLine;
uniform vec4 uColor;
uniform vec3 uGain;
uniform vec2 uSize;
uniform float uTime;
out vec4 outColor;
void main() {
  vec4 scene = texture(uScene, vUv);
  vec3 rgb = scene.rgb;
  if (uLine) {
    vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uSize;
    float phase = fract(uTime * 0.1) * (uSize.x + uSize.y);
    if (abs(px.x + px.y - phase) < 2.5) rgb = vec3(1.0);
  }
  rgb = clamp(((rgb - 0.5) * (1.0 + uColor.y) + 0.5 + uColor.x) * (1.0 + uGain), 0.0, 1.0);
  rgb = uColor.w + (1.0 - uColor.w) * rgb;
  if (uUseMask) rgb *= texture(uMask, vUv).a;
  rgb *= uColor.z;
  if (uUseOverlay) { vec4 o = texture(uOverlay, vUv); rgb = o.rgb + rgb * (1.0 - o.a); }
  outColor = vec4(rgb, 1.0);
}`;

const SOURCE_SIZE = source => [source.videoWidth || source.naturalWidth || source.displayWidth || source.width || 0, source.videoHeight || source.naturalHeight || source.displayHeight || source.height || 0];
// { width, height, data: Uint8Array|Uint8ClampedArray RGBA rows bottom-up, premultiplied? } (ImageData stays a TexImageSource).
const isRawSource = source => ArrayBuffer.isView(source?.data) && !(typeof ImageData === 'function' && source instanceof ImageData);
const MAX_DELAY_SLOTS = 8;
const IDENTIFY_COLORS = ['#ff5a5a', '#4fc3ff', '#84ffd4', '#ffd84f', '#c58cff', '#ff9a4f', '#5affa0', '#ff7ad1'];
const createCanvas = (w, h) => {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; return canvas;
};

export class OutputMapper {
  constructor(canvas, { onError = () => {}, preserveDrawingBuffer = false, subdivisions = 8 } = {}) {
    this.canvas = canvas;
    this.onError = onError;
    this.subdivisions = subdivisions;
    this.sources = new Map();
    this.entries = new Map();
    this.frame = 0;
    this.lost = false;
    this.disposed = false;
    this.fps = 0;
    // allocations: texture storage (re)definitions for raw sources and delay slots; copies: delay-ring frame copies.
    this.stats = { slices: 0, uploads: 0, allocations: 0, copies: 0 };
    this._frameTime = 1 / 60;
    this._lastTime = null;
    this._errors = new Set();
    this._lastRender = 0;
    this._onLost = event => {
      event.preventDefault();
      this.lost = true;
      this._forget();
      this._error('context', 'Output graphics context lost. Waiting for the GPU to recover.');
    };
    this._onRestored = () => {
      if (this.disposed) return;
      this.lost = false;
      this._errors.delete('context');
      try { this._init(); } catch (error) { this._error('restore', error.message); }
    };
    canvas.addEventListener('webglcontextlost', this._onLost);
    canvas.addEventListener('webglcontextrestored', this._onRestored);
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer, powerPreference: 'high-performance' });
    if (!this.gl) throw new Error('WebGL 2 is unavailable for the output. Enable hardware acceleration or update the graphics driver.');
    this._init();
  }

  _error(key, message) {
    if (this._errors.has(key) || this.disposed) return;
    this._errors.add(key);
    try { this.onError(String(message)); } catch { /* listener errors must not break rendering */ }
  }

  _program(vs, fs) {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`Output shader error: ${gl.getShaderInfoLog(shader)}`);
      return shader;
    };
    const program = gl.createProgram();
    const v = compile(gl.VERTEX_SHADER, vs), f = compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(program, v); gl.attachShader(program, f);
    gl.bindAttribLocation(program, 0, 'aPos'); gl.bindAttribLocation(program, 1, 'aUv'); gl.bindAttribLocation(program, 2, 'aLocal');
    gl.linkProgram(program);
    gl.deleteShader(v); gl.deleteShader(f);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`Output program error: ${gl.getProgramInfoLog(program)}`);
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
    for (let i = 0; i < count; i++) { const name = gl.getActiveUniform(program, i).name; uniforms[name] = gl.getUniformLocation(program, name); }
    return { program, uniforms };
  }

  _texture(filter = this.gl.LINEAR) {
    const gl = this.gl, texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  _upload(texture, image, flipY) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }

  _init() {
    const gl = this.gl;
    this.sliceProgram = this._program(SLICE_VS, SLICE_FS);
    this.screenProgram = this._program(SCREEN_VS, SCREEN_FS);
    this.emptyVao = gl.createVertexArray();
    this.copyFbo = gl.createFramebuffer();
    this.white = this._texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    this.scene = null;
    this.maskTexture = null; this._maskKey = null; this._maskScreen = null;
    this.cardTexture = null; this._cardKey = null; this._cardScreen = null;
    this.overlayTexture = null; this._overlayKey = null; this._overlayTime = 0; this._overlayVisible = false;
    this._resetSources();
    gl.disable(gl.DEPTH_TEST);
  }

  _resetSources() {
    for (const entry of this.sources.values()) { entry.texture = null; entry.frame = -1; entry.texWidth = 0; entry.texHeight = 0; entry.ring = null; entry.dirty = true; }
  }

  // Drop GL handles after context loss (they are invalid and must not be deleted).
  _forget() {
    this.entries.clear();
    this._resetSources();
    this.copyFbo = null;
    this.scene = null; this.maskTexture = null; this.cardTexture = null; this.overlayTexture = null;
    this._maskScreen = null; this._cardScreen = null; this._overlayKey = null;
  }

  // source: any TexImageSource (uploaded every render), or raw pixels
  // { width, height, data: Uint8Array|Uint8ClampedArray, premultiplied = true } with RGBA rows
  // bottom-up as gl.readPixels returns them. Raw pixels upload once per setSource call (pass
  // the same object again after refilling its buffer); same-size updates reuse the texture.
  setSource(id, source) {
    if (!source) { this.removeSource(id); return; }
    let entry = this.sources.get(id);
    if (!entry) { entry = { source, texture: null, view: null, frame: -1, width: 0, height: 0, texWidth: 0, texHeight: 0, ring: null }; this.sources.set(id, entry); }
    const raw = isRawSource(source);
    entry.source = source; entry.frame = -1; entry.dirty = true;
    entry.raw = raw; entry.flags = raw ? (source.premultiplied === false ? 3 : 1) : 0;
  }

  removeSource(id) {
    const entry = this.sources.get(id);
    if (entry) this._dropRing(entry);
    if (entry?.texture && !this.lost) this.gl.deleteTexture(entry.texture);
    this.sources.delete(id);
  }

  // Number of GPU frame copies currently held for screen delay.
  get ringTextures() {
    let count = 0;
    for (const entry of this.sources.values()) count += entry.ring?.slots.length || 0;
    return count;
  }

  // Call after mutating a slice object in place (identity-based cache).
  invalidate() { for (const entry of this.entries.values()) { entry.slice = null; entry.maskSlice = null; } this._cardScreen = null; this._maskScreen = null; }

  resize(width, height) {
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  // Uploads a source once per frame; `entry.view` is the texture to sample (a delayed copy when delay > 0).
  _source(id, delay = 0, time = 0) {
    const entry = this.sources.get(id);
    if (!entry?.source) return null;
    if (entry.frame === this.frame) return entry.width ? entry : null;
    entry.frame = this.frame;
    let fresh = false;
    if (entry.raw) {
      if (entry.dirty || !entry.texture) { if (!this._uploadRaw(id, entry)) return null; fresh = true; }
      if (!entry.width) return null;
    } else {
      const [width, height] = SOURCE_SIZE(entry.source);
      entry.width = width; entry.height = height;
      if (!width || !height) return null;
      try {
        entry.texture ||= this._texture();
        this._upload(entry.texture, entry.source, false);
        entry.texWidth = 0; entry.texHeight = 0;
        this.stats.uploads++; fresh = true;
      } catch (error) { entry.width = 0; this._error(`source:${id}`, `Output source ${id} could not be uploaded: ${error.message}`); return null; }
    }
    entry.view = delay > 0 ? this._delayed(entry, delay, time, fresh) : entry.texture;
    return entry;
  }

  _uploadRaw(id, entry) {
    const gl = this.gl, { width, height, data } = entry.source;
    entry.dirty = false;
    const valid = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= this.maxSize && height <= this.maxSize
      && (data instanceof Uint8Array || data instanceof Uint8ClampedArray) && data.length >= width * height * 4;
    if (!valid) { entry.width = 0; this._error(`source:${id}`, `Output source ${id} has invalid pixel data (expected ${width}×${height} RGBA bytes).`); return false; }
    try {
      if (!entry.texture) entry.texture = this._texture(); else gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      // Rows stay bottom-up and alpha is handled in the shader, so the browser never copies the buffer.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      if (entry.texWidth === width && entry.texHeight === height) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        entry.texWidth = width; entry.texHeight = height; this.stats.allocations++;
      }
      entry.width = width; entry.height = height;
      this.stats.uploads++;
      return true;
    } catch (error) { entry.width = 0; this._error(`source:${id}`, `Output source ${id} could not be uploaded: ${error.message}`); return false; }
  }

  // Screen delay: a small GPU ring of recent source frames stamped with options.time;
  // the frame closest to time - delay is sampled.
  _delayed(entry, delayMs, time, fresh) {
    const gl = this.gl, delay = delayMs / 1000;
    let ring = entry.ring;
    if (ring && (ring.width !== entry.width || ring.height !== entry.height || time < ring.newest)) { this._dropRing(entry); ring = null; }
    if (!ring) ring = entry.ring = { width: entry.width, height: entry.height, slots: [], newest: -Infinity };
    const needed = Math.ceil(delay / this._frameTime - 1e-6) + 1, capacity = Math.min(MAX_DELAY_SLOTS, Math.max(2, needed));
    const oldest = () => ring.slots.reduce((a, b) => (b.time < a.time ? b : a));
    while (ring.slots.length > capacity) { const slot = oldest(); ring.slots.splice(ring.slots.indexOf(slot), 1); if (!this.lost) gl.deleteTexture(slot.texture); }
    // At high frame rates the capped ring samples frames further apart so 100 ms stays reachable.
    const spacing = needed > MAX_DELAY_SLOTS ? delay / (MAX_DELAY_SLOTS - 1) * 0.999 : 0;
    if (!ring.slots.length || (fresh && time - ring.newest >= spacing)) {
      let slot;
      if (ring.slots.length < capacity) {
        slot = { texture: this._texture(), time };
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ring.width, ring.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        ring.slots.push(slot); this.stats.allocations++;
      } else slot = oldest();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.copyFbo);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, entry.texture, 0);
      gl.bindTexture(gl.TEXTURE_2D, slot.texture);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, ring.width, ring.height);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      slot.time = time; ring.newest = time;
      this.stats.copies++;
    }
    const target = time - delay;
    let best = ring.slots[0];
    for (const slot of ring.slots) {
      const d = Math.abs(slot.time - target), bd = Math.abs(best.time - target);
      if (d < bd || (d === bd && slot.time < best.time)) best = slot;
    }
    return best.texture;
  }

  _dropRing(entry) {
    if (!entry.ring) return;
    if (!this.lost && !this.gl.isContextLost()) for (const slot of entry.ring.slots) this.gl.deleteTexture(slot.texture);
    entry.ring = null;
  }

  _sceneTarget(width, height) {
    const gl = this.gl;
    if (this.scene?.width === width && this.scene?.height === height) return this.scene;
    if (this.scene) { gl.deleteTexture(this.scene.texture); gl.deleteFramebuffer(this.scene.framebuffer); }
    const texture = this._texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    this.scene = { texture, framebuffer, width, height };
    return this.scene;
  }

  _releaseEntry(entry) {
    if (this.lost) return;
    const gl = this.gl;
    if (entry.vao) gl.deleteVertexArray(entry.vao);
    for (const buffer of entry.buffers || []) gl.deleteBuffer(buffer);
    if (entry.maskTexture) gl.deleteTexture(entry.maskTexture);
  }

  _entry(slice) {
    let entry = this.entries.get(slice.id);
    if (entry && entry.slice === slice) { entry.used = this.frame; return entry; }
    const signature = sliceSignature(slice);
    if (!entry || entry.signature !== signature) {
      const gl = this.gl;
      if (entry) { this._releaseEntry(entry); entry.maskTexture = null; entry.maskKey = null; entry.maskSlice = null; }
      const mesh = buildSliceMesh(slice, { subdivisions: this.subdivisions });
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buffers = [mesh.positions, mesh.uvs, mesh.locals].map((data, index) => {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(index);
        gl.vertexAttribPointer(index, 2, gl.FLOAT, false, 0, 0);
        return buffer;
      });
      const indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      buffers.push(indexBuffer);
      entry = { ...(entry || {}), signature, vao, buffers, valid: mesh.valid && mesh.indices.length > 0, count: mesh.indices.length,
        indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, matrix: mesh.matrix, clip: new Float32Array(9), clipKey: '' };
      this.entries.set(slice.id, entry);
    }
    entry.slice = slice;
    entry.used = this.frame;
    return entry;
  }

  // Slice input masks are rasterised in slice-local space (follows rotation/flip).
  _sliceMask(entry, slice) {
    if (entry.maskSlice === slice) return slice.mask?.enabled ? entry.maskTexture : null;
    entry.maskSlice = slice;
    if (!slice.mask?.enabled) return null;
    const key = maskSignature(slice.mask) + entry.signature;
    if (entry.maskKey === key) return entry.maskTexture;
    const input = slice.input;
    let toLocal, w, h;
    if (slice.type === 'polygon') {
      const b = polygonBounds(input.points); w = b.width || 1; h = b.height || 1;
      toLocal = p => { const u = (p.x - b.x) / w, v = (p.y - b.y) / h; return [input.flipH ? 1 - u : u, input.flipV ? 1 - v : v]; };
    } else {
      const r = input.rect, rad = -(input.rotation || 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2; w = r.width; h = r.height;
      toLocal = p => {
        const dx = p.x - cx, dy = p.y - cy;
        const u = (dx * cos - dy * sin) / r.width + 0.5, v = (dx * sin + dy * cos) / r.height + 0.5;
        return [input.flipH ? 1 - u : u, input.flipV ? 1 - v : v];
      };
    }
    const scale = 512 / Math.max(w, h), mw = Math.max(8, Math.round(w * scale)), mh = Math.max(8, Math.round(h * scale));
    const canvas = createCanvas(mw, mh), ctx = canvas.getContext('2d');
    const path = flattenPath(slice.mask.points, slice.mask.mode, 24);
    ctx.fillStyle = '#fff';
    if (slice.mask.invert) ctx.fillRect(0, 0, mw, mh);
    ctx.globalCompositeOperation = slice.mask.invert ? 'destination-out' : 'source-over';
    ctx.beginPath();
    path.forEach((p, i) => { const [u, v] = toLocal(p); ctx[i ? 'lineTo' : 'moveTo'](u * mw, v * mh); });
    ctx.closePath(); ctx.fill();
    entry.maskTexture ||= this._texture();
    this._upload(entry.maskTexture, canvas, false);
    entry.maskKey = key;
    return entry.maskTexture;
  }

  _screenMask(screen, width, height) {
    const size = `${width}x${height}`;
    if (this._maskScreen === screen && this._maskSize === size) return this._maskActive ? this.maskTexture : null;
    this._maskScreen = screen; this._maskSize = size;
    const masks = screen.masks?.filter(m => m.enabled) || [];
    this._maskActive = masks.length > 0;
    if (!masks.length) return null;
    const key = JSON.stringify([width, height, masks]);
    if (key === this._maskKey && this.maskTexture) return this.maskTexture;
    const scale = Math.min(1, 2048 / Math.max(width, height)), mw = Math.max(1, Math.round(width * scale)), mh = Math.max(1, Math.round(height * scale));
    const canvas = createCanvas(mw, mh), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, mw, mh);
    for (const mask of masks) {
      // Non-inverted masks keep their inside (crop); inverted masks cut a hole.
      ctx.globalCompositeOperation = mask.invert ? 'destination-out' : 'destination-in';
      ctx.beginPath();
      flattenPath(mask.points, mask.mode, 24).forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x * scale, p.y * scale));
      ctx.closePath(); ctx.fill();
    }
    this.maskTexture ||= this._texture();
    this._upload(this.maskTexture, canvas, true);
    this._maskKey = key;
    return this.maskTexture;
  }

  _testCard(screen, width, height) {
    if (this._cardScreen === screen && this.cardTexture && this._cardSize === `${width}x${height}`) return this.cardTexture;
    const key = JSON.stringify([width, height, screen.name, screen.slices.map(s => [s.name, s.enabled, sliceSignature(s)])]);
    this._cardScreen = screen; this._cardSize = `${width}x${height}`;
    if (key === this._cardKey && this.cardTexture) return this.cardTexture;
    const canvas = drawTestCard(screen, width, height);
    this.cardTexture ||= this._texture();
    this._upload(this.cardTexture, canvas, true);
    this._cardKey = key;
    return this.cardTexture;
  }

  _overlay(screen, options, width, height, now) {
    const { identify, showFPS, showInfo, testCard, label } = options;
    if (!identify && !showFPS && !showInfo && !testCard) { this._overlayVisible = false; return null; }
    const key = JSON.stringify([identify, showFPS, showInfo, testCard, label, options.identifyColor, screen.name, screen.device, width, height]);
    const live = showFPS || showInfo || testCard;
    if (key === this._overlayKey && this.overlayTexture && !(live && now - this._overlayTime >= 250)) return this.overlayTexture;
    const scale = Math.min(1, 2048 / Math.max(width, height)), ow = Math.max(1, Math.round(width * scale)), oh = Math.max(1, Math.round(height * scale));
    const canvas = drawOverlay(screen, { ...options, fps: this.fps, renderer: this._rendererName(), canvasWidth: this.canvas.width, canvasHeight: this.canvas.height }, ow, oh, width, height);
    this.overlayTexture ||= this._texture();
    this._upload(this.overlayTexture, canvas, true);
    this._overlayKey = key; this._overlayTime = now;
    return this.overlayTexture;
  }

  _rendererName() {
    if (this._renderer !== undefined) return this._renderer;
    const gl = this.gl, info = gl.getExtension('WEBGL_debug_renderer_info');
    this._renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || 'WebGL 2');
    return this._renderer;
  }

  // options: { testCard, identify, identifyColor, showFPS, showInfo, label, time (seconds; also the screen-delay clock) }
  render(screen, options = {}) {
    if (this.disposed || this.lost) return { drawn: 0 };
    const gl = this.gl;
    if (gl.isContextLost()) return { drawn: 0 };
    this.frame++;
    const now = typeof performance === 'object' ? performance.now() : Date.now();
    if (this._lastRender) { const dt = now - this._lastRender; if (dt > 0) this.fps = this.fps ? this.fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt; }
    this._lastRender = now;
    const time = Number.isFinite(options.time) ? options.time : now / 1000;
    if (this._lastTime !== null) { const dt = time - this._lastTime; if (dt > 0 && dt < 1) this._frameTime = this._frameTime * 0.8 + dt * 0.2; }
    this._lastTime = time;
    const width = Math.min(this.maxSize, screen?.device?.width || this.canvas.width), height = Math.min(this.maxSize, screen?.device?.height || this.canvas.height);
    const delay = screen && screen.enabled !== false ? Math.min(100, Math.max(0, Number(screen.delay) || 0)) : 0;
    if (!delay) for (const entry of this.sources.values()) if (entry.ring) this._dropRing(entry);
    let drawn = 0;
    try {
      const active = screen?.enabled !== false && !options.testCard ? screen?.slices || [] : [];
      let solo = false;
      for (const slice of active) if (slice.solo && slice.enabled && !slice.bypass) { solo = true; break; }
      // Resolve (upload / delay) every visible source before the scene target is bound.
      for (const slice of active) if (slice.enabled && !slice.bypass && (!solo || slice.solo)) this._source(slice.input.source, delay, time);
      const scene = this._sceneTarget(width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.framebuffer);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (active.length) drawn = this._drawSlices(active, width, height, solo);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.disable(gl.BLEND);
      const p = this.screenProgram, u = p.uniforms;
      gl.useProgram(p.program);
      gl.bindVertexArray(this.emptyVao);
      const card = options.testCard && screen ? this._testCard(screen, width, height) : null;
      const mask = screen && screen.enabled !== false ? this._screenMask(screen, width, height) : null;
      const overlay = screen ? this._overlay(screen, options, width, height, now) : null;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, card || scene.texture);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mask || this.white);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, overlay || this.white);
      gl.uniform1i(u.uScene, 0); gl.uniform1i(u.uMask, 1); gl.uniform1i(u.uOverlay, 2);
      gl.uniform1i(u.uUseMask, mask ? 1 : 0); gl.uniform1i(u.uUseOverlay, overlay ? 1 : 0); gl.uniform1i(u.uLine, card ? 1 : 0);
      const on = screen && screen.enabled !== false;
      gl.uniform4f(u.uColor, on ? screen.brightness || 0 : 0, on ? screen.contrast || 0 : 0, on ? screen.opacity ?? 1 : 0, on ? screen.blackLevel || 0 : 0);
      gl.uniform3f(u.uGain, on ? screen.red || 0 : 0, on ? screen.green || 0 : 0, on ? screen.blue || 0 : 0);
      gl.uniform2f(u.uSize, width, height);
      gl.uniform1f(u.uTime, time);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      this._evict();
    } catch (error) {
      if (!gl.isContextLost()) this._error('render', `Output render failed: ${error.message}`);
    }
    this.stats.slices = drawn;
    return { drawn };
  }

  _drawSlices(slices, width, height, solo) {
    const gl = this.gl, p = this.sliceProgram, u = p.uniforms;
    gl.useProgram(p.program);
    gl.enable(gl.BLEND);
    gl.uniform1i(u.uSource, 0); gl.uniform1i(u.uMask, 1);
    const clipKey = `${width}x${height}`;
    let drawn = 0;
    // The first slice in the list is the front-most one.
    for (let i = slices.length - 1; i >= 0; i--) {
      const slice = slices[i];
      if (!slice.enabled || slice.bypass || (solo && !slice.solo)) continue;
      const source = this._source(slice.input.source);
      if (!source) continue;
      const entry = this._entry(slice);
      if (!entry.valid) continue;
      if (entry.clipKey !== clipKey) {
        const m = entry.matrix, sx = 2 / width, sy = -2 / height;
        // clip = [[sx,0,-1],[0,sy,1],[0,0,1]] · M, stored column-major.
        const r0 = [sx * m[0] - m[6], sx * m[1] - m[7], sx * m[2] - m[8]];
        const r1 = [sy * m[3] + m[6], sy * m[4] + m[7], sy * m[5] + m[8]];
        entry.clip.set([r0[0], r1[0], m[6], r0[1], r1[1], m[7], r0[2], r1[2], m[8]]);
        entry.clipKey = clipKey;
      }
      const maskTexture = this._sliceMask(entry, slice);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source.view);
      gl.uniform1i(u.uSourceFlags, source.flags);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, maskTexture || this.white);
      gl.uniformMatrix3fv(u.uMatrix, false, entry.clip);
      gl.uniform2f(u.uSourceSize, source.width, source.height);
      gl.uniform1i(u.uUseMask, maskTexture ? 1 : 0);
      const e = slice.softEdge || {};
      gl.uniform4f(u.uEdge, e.left || 0, e.right || 0, e.top || 0, e.bottom || 0);
      gl.uniform3f(u.uCurve, e.gamma || 1, e.power || 2, e.luminance ?? 0.5);
      gl.uniform3f(u.uColor, slice.brightness || 0, slice.contrast || 0, slice.opacity ?? 1);
      gl.uniform3f(u.uGain, slice.red || 0, slice.green || 0, slice.blue || 0);
      gl.uniform1i(u.uFlags, (slice.isKey ? 1 : 0) | (slice.blackBg ? 2 : 0));
      if (slice.blendMode === 'add') gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(entry.vao);
      gl.drawElements(gl.TRIANGLES, entry.count, entry.indexType, 0);
      drawn++;
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    return drawn;
  }

  _evict() {
    if (this.frame % 60) return;
    for (const [id, entry] of this.entries) if (this.frame - entry.used > 120) { this._releaseEntry(entry); this.entries.delete(id); }
    for (const entry of this.sources.values()) if (entry.ring && this.frame - entry.frame > 120) this._dropRing(entry);
  }

  readPixel(x, y) {
    const gl = this.gl, value = new Uint8Array(4);
    gl.readPixels(x, this.canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value);
    return [...value];
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    if (!this.lost && !this.gl.isContextLost()) {
      const gl = this.gl;
      for (const entry of this.entries.values()) this._releaseEntry(entry);
      for (const entry of this.sources.values()) { this._dropRing(entry); if (entry.texture) gl.deleteTexture(entry.texture); }
      if (this.copyFbo) gl.deleteFramebuffer(this.copyFbo);
      for (const texture of [this.white, this.maskTexture, this.cardTexture, this.overlayTexture, this.scene?.texture]) if (texture) gl.deleteTexture(texture);
      if (this.scene) gl.deleteFramebuffer(this.scene.framebuffer);
      gl.deleteVertexArray(this.emptyVao);
      gl.deleteProgram(this.sliceProgram.program);
      gl.deleteProgram(this.screenProgram.program);
    }
    this.entries.clear();
    this.sources.clear();
  }
}

// Procedural test card: grid, circle, colour bars, resolution and slice outlines.
export function drawTestCard(screen, width, height) {
  const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, width, height);
  const cell = Math.max(16, Math.round(Math.min(width, height) / 12));
  ctx.strokeStyle = '#5a5a5a'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = (width / 2) % cell; x <= width; x += cell) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, height); }
  for (let y = (height / 2) % cell; y <= height; y += cell) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(width, Math.round(y) + 0.5); }
  ctx.stroke();
  ctx.strokeStyle = '#d8d8d8'; ctx.lineWidth = Math.max(2, cell / 16);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(width, height); ctx.moveTo(width, 0); ctx.lineTo(0, height); ctx.stroke();
  ctx.beginPath(); ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.42, 0, Math.PI * 2); ctx.stroke();
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  const bw = width * 0.6 / bars.length, by = height / 2 - cell, bx = width * 0.2;
  bars.forEach((color, i) => { ctx.fillStyle = color; ctx.fillRect(bx + i * bw, by, Math.ceil(bw), cell * 1.2); });
  for (let i = 0; i < 8; i++) { const v = Math.round(i * 255 / 7); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(bx + i * width * 0.6 / 8, by + cell * 1.2, Math.ceil(width * 0.6 / 8), cell * 0.5); }
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.max(10, Math.round(cell * 0.7))}px Segoe UI, Arial, sans-serif`;
  ctx.fillText(`${screen.name}  ${width} × ${height}`, width / 2, by - cell * 0.8);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, cell / 10);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, width - ctx.lineWidth, height - ctx.lineWidth);
  ctx.font = `${Math.max(10, Math.round(cell * 0.45))}px Segoe UI, Arial, sans-serif`;
  screen.slices.forEach((slice, index) => {
    if (!slice.enabled) return;
    const outline = sliceOutputOutline(slice);
    ctx.strokeStyle = IDENTIFY_COLORS[index % IDENTIFY_COLORS.length]; ctx.lineWidth = Math.max(2, cell / 12);
    ctx.beginPath(); outline.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](p.x, p.y)); ctx.closePath(); ctx.stroke();
    const c = outline.reduce((acc, p) => ({ x: acc.x + p.x / outline.length, y: acc.y + p.y / outline.length }), { x: 0, y: 0 });
    ctx.fillStyle = ctx.strokeStyle; ctx.fillText(slice.name, c.x, c.y + cell * 1.8);
  });
  return canvas;
}

function drawOverlay(screen, options, width, height, deviceWidth, deviceHeight) {
  const canvas = createCanvas(width, height), ctx = canvas.getContext('2d');
  const unit = Math.max(10, Math.round(Math.min(width, height) / 30));
  ctx.textBaseline = 'top';
  if (options.identify) {
    const color = options.identifyColor || IDENTIFY_COLORS[Math.abs([...screen.id].reduce((a, ch) => a * 31 + ch.charCodeAt(0) | 0, 7)) % IDENTIFY_COLORS.length];
    ctx.globalAlpha = 0.55; ctx.fillStyle = color; ctx.fillRect(0, 0, width, height); ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(Math.min(width, height) * 0.45)}px Segoe UI, Arial, sans-serif`;
    ctx.fillText(String(options.label ?? screen.name).slice(0, 8), width / 2, height * 0.45);
    ctx.font = `600 ${unit * 1.4}px Segoe UI, Arial, sans-serif`;
    ctx.fillText(screen.name, width / 2, height * 0.8);
    ctx.textBaseline = 'top';
  }
  const lines = [];
  if (options.showFPS) lines.push(`${Math.round(options.fps || 0)} fps`);
  if (options.testCard) lines.push(new Date().toLocaleTimeString());
  if (options.showInfo) {
    lines.push(screen.name, `${screen.device.type === 'display' ? `Display ${screen.device.displayId}` : 'Virtual output'}`,
      `Output ${deviceWidth} × ${deviceHeight}`, `Window ${options.canvasWidth} × ${options.canvasHeight}`, `Renderer ${options.renderer}`);
  }
  if (lines.length) {
    ctx.font = `${unit}px Segoe UI, Arial, sans-serif`; ctx.textAlign = 'left';
    const w = Math.max(...lines.map(line => ctx.measureText(line).width)) + unit, h = lines.length * unit * 1.3 + unit * 0.6;
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(unit / 2, unit / 2, w, h);
    ctx.fillStyle = '#84ffd4';
    lines.forEach((line, i) => ctx.fillText(line, unit, unit * 0.8 + i * unit * 1.3));
  }
  return canvas;
}
