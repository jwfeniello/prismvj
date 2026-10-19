// GPU host for ISF shaders parsed by isf.js. Each shader is one program
// (PASSINDEX selects the pass); each instance (an effect, a clip's source or
// a transition) owns its pass buffers, which are double-buffered so a
// persistent buffer can read its previous frame while it is rewritten. ISF
// expects straight (unpremultiplied) alpha, so engine inputs are converted on
// the way in and the result is premultiplied on the way out.
import { evaluateSize } from './isf.js';

const VERTEX = `#version 300 es
precision highp float;
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const UNPREMULTIPLY = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D uImage;
void main() { vec4 c = texture(uImage, uv); frag = c.a > 0.00001 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }`;
const PREMULTIPLY = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D uImage;
void main() { vec4 c = clamp(texture(uImage, uv), 0.0, 1.0); frag = vec4(c.rgb * c.a, c.a); }`;
const MAX_SIZE = 8192;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function hexColor(value) {
  const hex = typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value.slice(1) : 'ffffffff';
  return [0, 2, 4, 6].map(index => index < hex.length ? parseInt(hex.slice(index, index + 2), 16) / 255 : 1);
}

export class IsfRuntime {
  constructor(gl, { onError = () => {} } = {}) {
    this.gl = gl;
    this.onError = onError;
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
    this.programs = new Map();
    this.instances = new Map();
    this.assets = new Map();
    this.audio = { wave: null, fft: null, frame: -1 };
    this.audioTextures = new Map();
    this.frame = 0;
    this.unpremultiply = this._helper(UNPREMULTIPLY);
    this.premultiply = this._helper(PREMULTIPLY);
    this.blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  }

  // ------------------------------------------------------------ programs

  _compile(type, source) {
    const gl = this.gl, shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  _helper(fragment) {
    const gl = this.gl, program = gl.createProgram();
    const shaders = [this._compile(gl.VERTEX_SHADER, VERTEX), this._compile(gl.FRAGMENT_SHADER, fragment)];
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`ISF helper failed: ${gl.getProgramInfoLog(program)}`);
    for (const shader of shaders) { gl.detachShader(program, shader); gl.deleteShader(shader); }
    return { program, image: gl.getUniformLocation(program, 'uImage') };
  }

  _start(definition) {
    const gl = this.gl, { program: source } = definition.isf, program = gl.createProgram();
    const shaders = [this._compile(gl.VERTEX_SHADER, source.vertex), this._compile(gl.FRAGMENT_SHADER, source.fragment)];
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    return { definition, program, shaders, ready: false, failed: false, locations: null };
  }

  _finish(entry) {
    const gl = this.gl;
    if (entry.ready || entry.failed) return true;
    if (this.parallel && !gl.getProgramParameter(entry.program, this.parallel.COMPLETION_STATUS_KHR)) return false;
    if (!gl.getProgramParameter(entry.program, gl.LINK_STATUS)) {
      const log = entry.shaders.map(shader => gl.getShaderInfoLog(shader)).filter(Boolean).join(' ') || gl.getProgramInfoLog(entry.program) || 'unknown error';
      for (const shader of entry.shaders) gl.deleteShader(shader);
      gl.deleteProgram(entry.program);
      entry.failed = true;
      entry.error = log.trim().slice(0, 600);
      this.onError(`isf-${entry.definition.id}`, `${entry.definition.name} (ISF) could not compile: ${entry.error}`);
      return true;
    }
    for (const shader of entry.shaders) { gl.detachShader(entry.program, shader); gl.deleteShader(shader); }
    entry.shaders = [];
    const isf = entry.definition.isf, location = name => gl.getUniformLocation(entry.program, name);
    entry.locations = {
      PASSINDEX: location('PASSINDEX'), RENDERSIZE: location('RENDERSIZE'), TIME: location('TIME'), TIMEDELTA: location('TIMEDELTA'),
      DATE: location('DATE'), FRAMEINDEX: location('FRAMEINDEX'),
      uniforms: isf.uniforms.map(uniform => location(uniform.glsl)),
      images: isf.images.map(image => [location(image.glsl), location(`_${image.glsl}_imgSize`)]),
    };
    entry.ready = true;
    return true;
  }

  _entry(definition) {
    let entry = this.programs.get(definition.id);
    if (entry && entry.definition !== definition) { this._deleteProgram(entry); entry = null; }
    if (!entry) { entry = this._start(definition); this.programs.set(definition.id, entry); }
    return entry;
  }

  _deleteProgram(entry) {
    const gl = this.gl;
    for (const shader of entry.shaders || []) gl.deleteShader(shader);
    if (!entry.failed) gl.deleteProgram(entry.program);
    this.programs.delete(entry.definition.id);
  }

  // Start compiling in the background (first use is then instant).
  prewarm(definition) { if (definition?.isf) this._entry(definition); }
  pending() { for (const entry of this.programs.values()) if (!entry.ready && !entry.failed) return true; return false; }
  // Finish every compile now (blocking); true when one became ready.
  flush() {
    const parallel = this.parallel;
    let finished = false;
    this.parallel = null;
    try { for (const entry of this.programs.values()) if (!entry.ready && !entry.failed) { this._finish(entry); finished = true; } }
    finally { this.parallel = parallel; }
    return finished;
  }
  // Compile errors for a definition ('' while pending or when it compiled).
  error(definition) { return this.programs.get(definition?.id)?.error || ''; }
  // ------------------------------------------------------------ targets and textures

  _texture() {
    const gl = this.gl, texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  _target(width, height, float = false) {
    const gl = this.gl, texture = this._texture(), framebuffer = gl.createFramebuffer();
    const wide = float && this.floatTargets;
    if (wide) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture, framebuffer, width, height, float: wide };
  }

  _free(target) { if (target) { this.gl.deleteTexture(target.texture); this.gl.deleteFramebuffer(target.framebuffer); } }

  // A target of the requested size, reallocated (and so cleared) on change.
  _sized(holder, key, width, height, float = false) {
    const target = holder[key];
    if (target && target.width === width && target.height === height && target.float === (float && this.floatTargets)) return target;
    this._free(target);
    return (holder[key] = this._target(width, height, float));
  }

  _draw(helper, source, target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(helper.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source || this.blank);
    gl.uniform1i(helper.image, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return target;
  }

  // Straight-alpha copy of an engine (premultiplied) target.
  _straight(holder, key, input, width, height) {
    if (!input?.texture) return null;
    return this._draw(this.unpremultiply, input.texture, this._sized(holder, key, width, height));
  }

  // Bundled and imported images arrive as data: URLs; they load
  // asynchronously and read as transparent black until ready.
  _asset(url) {
    if (typeof url !== 'string' || !/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(url)) return null;
    let asset = this.assets.get(url);
    if (!asset) {
      asset = { texture: null, width: 1, height: 1, used: this.frame };
      this.assets.set(url, asset);
      const image = new Image();
      image.onload = () => {
        if (this.disposed || this.assets.get(url) !== asset) return;
        const gl = this.gl;
        asset.texture = this._texture();
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        asset.width = image.naturalWidth || 1;
        asset.height = image.naturalHeight || 1;
      };
      image.src = url;
    }
    asset.used = this.frame;
    return asset.texture ? asset : null;
  }

  // audioProvider() returns the latest { wave, fft } Uint8Arrays (engine).
  _readAudio() {
    if (this.audio.frame === this.frame) return;
    const data = this.audioProvider?.() || null;
    this.audio = { wave: data?.wave || null, fft: data?.fft || null, frame: this.frame };
  }

  _audioTexture(role, count) {
    const gl = this.gl, key = `${role}:${count}`;
    let entry = this.audioTextures.get(key);
    if (!entry) {
      entry = { texture: this._texture(), data: new Uint8Array(count * 4), frame: -1 };
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, count, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.audioTextures.set(key, entry);
    }
    if (entry.frame !== this.frame) {
      entry.frame = this.frame;
      this._readAudio();
      const source = role === 'wave' ? this.audio.wave : this.audio.fft, data = entry.data;
      for (let i = 0; i < count; i++) {
        // Waveforms sit at 0.5 when silent; spectra at 0.
        let value = role === 'wave' ? 128 : 0;
        if (source?.length) {
          const position = i / Math.max(1, count - 1) * (source.length - 1), low = Math.floor(position), high = Math.min(source.length - 1, low + 1);
          value = source[low] + (source[high] - source[low]) * (position - low);
        }
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = value;
        data[i * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, count, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    return { texture: entry.texture, width: count, height: 1 };
  }

  // ------------------------------------------------------------ rendering

  _instance(key, definition) {
    let instance = this.instances.get(key);
    if (instance && instance.definition !== definition) { this._dropInstance(key); instance = null; }
    if (!instance) {
      instance = { definition, frame: 0, lastTime: null, buffers: new Map(), copies: {}, used: this.frame };
      this.instances.set(key, instance);
    }
    instance.used = this.frame;
    return instance;
  }

  _dropInstance(key) {
    const instance = this.instances.get(key);
    if (!instance) return;
    for (const buffer of instance.buffers.values()) { this._free(buffer.front); this._free(buffer.back); }
    for (const target of Object.values(instance.copies)) this._free(target);
    this.instances.delete(key);
  }

  // Declared defaults, for params an older save or a new input lacks.
  _defaults(definition) {
    if (!this.defaultCache) this.defaultCache = new WeakMap();
    let defaults = this.defaultCache.get(definition);
    if (!defaults) { defaults = Object.fromEntries((definition.params || []).map(param => [param.key, param.default])); this.defaultCache.set(definition, defaults); }
    return defaults;
  }

  _sizeValues(definition, params, width, height) {
    const values = { WIDTH: width, HEIGHT: height };
    for (const uniform of definition.isf.uniforms) {
      if (!uniform.key) continue;
      const value = params[uniform.key];
      values[uniform.key] = uniform.type === 'long' ? uniform.values[clamp(Math.trunc(Number(value) || 0), 0, uniform.values.length - 1)]
        : typeof value === 'boolean' ? +value : finite(value) ? value : 0;
    }
    return values;
  }

  _passSize(pass, values, width, height) {
    const size = (node, fallback) => {
      if (!node) return fallback;
      const value = Math.round(evaluateSize(node, values));
      return Number.isFinite(value) && value >= 1 ? Math.min(MAX_SIZE, value) : fallback;
    };
    return [size(pass.width, width), size(pass.height, height)];
  }

  _imageFor(image, instance, sources, params, assets) {
    if (image.role === 'input') return sources.input;
    if (image.role === 'start') return sources.start;
    if (image.role === 'end') return sources.end;
    if (image.role === 'wave' || image.role === 'fft') return this._audioTexture(image.role, image.count);
    if (image.role === 'buffer') { const buffer = instance.buffers.get(image.name); return buffer ? buffer.front : null; }
    if (image.role === 'imported') return this._asset(assets?.[image.path] || assets?.[image.name]);
    // Image params: None, This input, Below this layer, Bundled image.
    const choice = Math.trunc(Number(params[image.key] ?? 1));
    if (choice === 1) return sources.input;
    if (choice === 2) return sources.below;
    if (choice === 3) return this._asset(assets?.[image.name]);
    return null;
  }
  _setUniform(location, uniform, params, progress, width, height) {
    if (!location) return;
    const gl = this.gl;
    if (uniform.role === 'progress') { gl.uniform1f(location, clamp(finite(progress) ? progress : 0, 0, 1)); return; }
    const value = params[uniform.key];
    if (uniform.type === 'float') gl.uniform1f(location, finite(value) ? value : 0);
    else if (uniform.type === 'bool') gl.uniform1i(location, value ? 1 : 0);
    else if (uniform.type === 'long') gl.uniform1i(location, uniform.values[clamp(Math.trunc(Number(value) || 0), 0, uniform.values.length - 1)] ?? 0);
    else if (uniform.type === 'color') gl.uniform4f(location, ...hexColor(value));
    else if (uniform.type === 'point') {
      const point = Array.isArray(value) && finite(value[0]) && finite(value[1]) ? value : [0.5, 0.5];
      if (uniform.mode === 'pixels') gl.uniform2f(location, point[0] * width, point[1] * height);
      else gl.uniform2f(location, point[0], point[1]);
    }
  }

  // Renders one instance and returns its premultiplied output target, or
  // null while the program compiles (or after it failed).
  // sources: { input, start, end, below } are engine (premultiplied) targets.
  run(key, definition, { input = null, start = null, end = null, below = null, progress = 0, params = {}, time = 0, width, height }) {
    if (!definition?.isf) return null;
    const entry = this._entry(definition);
    if (!this._finish(entry) || !entry.ready) return null;
    const gl = this.gl, isf = definition.isf, instance = this._instance(key, definition), copies = instance.copies;
    params = { ...this._defaults(definition), ...(params || {}) };
    width = clamp(Math.round(width) || 1, 1, MAX_SIZE);
    height = clamp(Math.round(height) || 1, 1, MAX_SIZE);
    const sources = {
      input: this._straight(copies, 'input', input, width, height),
      start: this._straight(copies, 'start', start, width, height),
      end: this._straight(copies, 'end', end, width, height),
      below: isf.images.some(image => image.role === 'param') ? this._straight(copies, 'below', below, width, height) : null,
    };
    const delta = instance.lastTime === null ? 1 / 60 : clamp(time - instance.lastTime, 0, 1);
    instance.lastTime = time;
    const now = new Date();
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000];
    const values = this._sizeValues(definition, params, width, height);
    const assets = isf.assets, locations = entry.locations;
    let result = null;
    for (let index = 0; index < isf.passes.length; index++) {
      const pass = isf.passes[index], [w, h] = this._passSize(pass, values, width, height);
      let dest, buffer = null;
      if (pass.target) {
        buffer = instance.buffers.get(pass.target);
        const float = pass.float && this.floatTargets;
        if (!buffer || buffer.front.width !== w || buffer.front.height !== h || buffer.front.float !== float) {
          if (buffer) { this._free(buffer.front); this._free(buffer.back); }
          buffer = { front: this._target(w, h, pass.float), back: this._target(w, h, pass.float) };
          instance.buffers.set(pass.target, buffer);
        }
        dest = buffer.back;
      } else dest = this._sized(copies, `pass${index}`, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dest.framebuffer);
      gl.viewport(0, 0, w, h);
      // Persistent buffers keep what was there; everything else starts clear.
      if (!pass.persistent) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      gl.useProgram(entry.program);
      gl.uniform1i(locations.PASSINDEX, index);
      gl.uniform2f(locations.RENDERSIZE, w, h);
      gl.uniform1f(locations.TIME, time);
      gl.uniform1f(locations.TIMEDELTA, delta);
      gl.uniform4f(locations.DATE, ...date);
      gl.uniform1i(locations.FRAMEINDEX, instance.frame);
      isf.uniforms.forEach((uniform, i) => this._setUniform(locations.uniforms[i], uniform, params, progress, w, h));
      // Resolve every image first: uploads (audio) bind on the active unit.
      const textures = isf.images.map(image => this._imageFor(image, instance, sources, params, assets));
      isf.images.forEach((image, i) => {
        const texture = textures[i];
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, texture?.texture || this.blank);
        if (locations.images[i][0]) gl.uniform1i(locations.images[i][0], i);
        if (locations.images[i][1]) gl.uniform2f(locations.images[i][1], texture?.width || w, texture?.height || h);
      });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (buffer) { [buffer.front, buffer.back] = [buffer.back, buffer.front]; result = buffer.front; } else result = dest;
    }
    instance.frame++;
    return result ? this._draw(this.premultiply, result.texture, this._sized(copies, 'output', width, height)) : null;
  }

  // Call once per engine frame: advances the clock, releases idle state.
  beginFrame() {
    this.frame++;
    if (this.frame % 60) return;
    for (const [key, instance] of this.instances) if (this.frame - instance.used > 120) this._dropInstance(key);
    for (const [url, asset] of this.assets) if (this.frame - asset.used > 1800) { if (asset.texture) this.gl.deleteTexture(asset.texture); this.assets.delete(url); }
  }

  // After a lost context: forget GL objects without touching them.
  reset() {
    this.programs.clear();
    this.instances.clear();
    this.assets.clear();
    this.audioTextures.clear();
    this.disposed = true;
  }

  dispose() {
    if (this.disposed) return;
    for (const key of [...this.instances.keys()]) this._dropInstance(key);
    for (const entry of [...this.programs.values()]) this._deleteProgram(entry);
    for (const asset of this.assets.values()) if (asset.texture) this.gl.deleteTexture(asset.texture);
    for (const entry of this.audioTextures.values()) this.gl.deleteTexture(entry.texture);
    this.gl.deleteProgram(this.unpremultiply.program);
    this.gl.deleteProgram(this.premultiply.program);
    this.gl.deleteTexture(this.blank);
    this.reset();
  }
}