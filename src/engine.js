import { COMPOSITE_FRAGMENT, blendIndex, normalizeBlend } from './blends.js';
import { GifPlayback, isGifAsset } from './gif-playback.js';
import { buildEffectShader, buildSourceShader, bindParams, uniformNames, effectPasses } from './fx/shader-template.js';
import { effectDefinition, sourceDefinition } from './fx/registry.js';
import { AudioEffectChain } from './audio-fx.js';

const reverseMediaURL = clip => clip?.kind === 'video' && /\.mov$/i.test(clip.path || '')
  && /^prism-media:/i.test(clip.url || '') ? `${clip.url}${clip.url.includes('?') ? '&' : '?'}reverse=1` : null;

// GPU compositor. All intermediate textures use premultiplied alpha.
const VERTEX = `#version 300 es
precision highp float;
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const SOURCE = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D uImage;
uniform int uSource;
uniform float uTime;
uniform vec3 uColor;
uniform vec2 uFit;
uniform float uAspect;
uniform vec3 uChannels;
uniform bool uIgnoreAlpha;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
void main() {
  vec2 q = (uv-0.5)/uFit+0.5;
  if (any(lessThan(q,vec2(0.0))) || any(greaterThan(q,vec2(1.0)))) { frag = vec4(0.0); return; }
  if (uSource == 0) {
    vec4 texel = texture(uImage,q);
    if (uIgnoreAlpha) texel.a = 1.0;
    frag = vec4(texel.rgb * uChannels * texel.a, texel.a);
    return;
  }
  vec2 v = (q - 0.5) * vec2(uAspect,1.0);
  float t = uTime;
  vec3 color = uColor;
  if (uSource == 1) {
    float f = sin(v.x*9.0+t) + sin(v.y*11.0-t*1.3) + sin(length(v)*16.0-t*1.8);
    color = 0.5 + 0.5*cos(f + vec3(0.0,2.1,4.2) + uColor*3.0);
  } else if (uSource == 2) {
    vec2 g = abs(fract((v + vec2(t*0.04,t*0.02))*12.0)-0.5);
    float line = 1.0-smoothstep(0.035,0.065,min(g.x,g.y));
    color = uColor * (0.07 + line*0.93);
  } else if (uSource == 3) {
    float r = length(v);
    float rings = 0.5+0.5*sin(r*70.0-t*5.0);
    color = mix(uColor*0.025,uColor,rings*rings);
  } else if (uSource == 4) {
    float n = hash(floor(q*vec2(640.0,360.0)) + floor(t*24.0));
    color = uColor*n;
  }
  frag = vec4(color*uChannels,1.0);
}`;

const EFFECT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D uImage;
uniform int uEffect;
uniform float uAmount;
uniform float uTime;
uniform vec2 uResolution;
void main() {
  vec2 q = uv;
  float a = clamp(uAmount,0.0,1.0);
  if (uEffect == 7 && a > 0.001) {
    float size = 1.0 + a*a*90.0;
    vec2 cells = max(vec2(1.0),uResolution/size);
    q = (floor(q*cells)+0.5)/cells;
  }
  if (uEffect == 8 && a > 0.001) {
    q.x = abs(q.x-0.5)*2.0;
    if (a > 0.66) q.y = abs(q.y-0.5)*2.0;
  }
  if (uEffect == 9 && a > 0.001) {
    vec2 p = (q-0.5)*vec2(uResolution.x/uResolution.y,1.0);
    float sector = 6.28318530718 / (2.0 + floor(a*14.0));
    float theta = abs(mod(atan(p.y,p.x),sector)-sector*0.5);
    q = vec2(cos(theta),sin(theta))*length(p);
    q.x /= uResolution.x/uResolution.y;
    q += 0.5;
  }
  vec4 pixel = texture(uImage,q);
  vec3 rgb = pixel.a > 0.00001 ? pixel.rgb / pixel.a : vec3(0.0);
  float gray = dot(rgb,vec3(0.2126,0.7152,0.0722));
  if (uEffect == 1) rgb = mix(rgb,1.0-rgb,a);
  else if (uEffect == 2) rgb = mix(rgb,vec3(gray),a);
  else if (uEffect == 3) rgb *= a*2.0;
  else if (uEffect == 4) rgb = (rgb-0.5)*(a*2.0)+0.5;
  else if (uEffect == 5) rgb = mix(vec3(gray),rgb,a*2.0);
  else if (uEffect == 6) {
    float angle = (a-0.5)*6.28318530718;
    vec3 axis = normalize(vec3(1.0));
    rgb = rgb*cos(angle) + cross(axis,rgb)*sin(angle) + axis*dot(axis,rgb)*(1.0-cos(angle));
  }
  if (uEffect == 10 && a > 0.001 && fract(uTime*(1.0+a*24.0)) > 0.5) pixel.a = 0.0;
  frag = vec4(clamp(rgb,0.0,1.0)*pixel.a,pixel.a);
}`;

const TRANSFORM = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D uImage;
uniform mat3 uInverse;
uniform vec2 uResolution;
uniform bool uValid;
void main() {
  if (!uValid) { frag = vec4(0.0); return; }
  vec3 point = uInverse*vec3((uv-0.5)*uResolution,1.0);
  if (point.z <= 0.0000001) { frag = vec4(0.0); return; }
  vec2 q = point.xy/point.z/uResolution+0.5;
  if (any(lessThan(q,vec2(0.0))) || any(greaterThan(q,vec2(1.0)))) frag = vec4(0.0);
  else frag = texture(uImage,q);
}`;

const COPY = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D uImage;
uniform float uOpacity;
uniform bool uOpaque;
void main() {
  vec4 pixel = texture(uImage,uv)*uOpacity;
  frag = vec4(pixel.rgb,uOpaque ? 1.0 : pixel.a);
}`;

const MASK = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D uImage;
uniform sampler2D uMask;
uniform bool uAlpha;
uniform bool uInvert;
uniform bool uLuma;
void main() {
  vec4 mask = texture(uMask,uv);
  float amount = uAlpha ? mask.a : uLuma ? dot(mask.rgb,vec3(0.2126,0.7152,0.0722)) : mask.r;
  if (uInvert) amount = 1.0-amount;
  frag = texture(uImage,uv)*amount;
}`;

const EFFECTS = { invert: 1, grayscale: 2, brightness: 3, contrast: 4, saturation: 5, hue: 6, pixelate: 7, mirror: 8, kaleidoscope: 9, strobe: 10 };
const SOURCES = { plasma: 1, grid: 2, rings: 3, noise: 4, solid: 5 };
const clamp = (v, low = 0, high = 1) => Math.min(high, Math.max(low, Number.isFinite(Number(v)) ? Number(v) : low));
const number = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const groupGain = (group, fader) => group === 'A' || group === 'a' ? Math.min(1, (1-fader)*2) : group === 'B' || group === 'b' ? Math.min(1, fader*2) : 1;
// Older projects and direct callers store a single `amount` instead of params.
const effectParams = effect => effect.params || (effect.amount !== undefined ? { amount: effect.amount } : {});
// Capture devices and screen capture behave like video media without a file.
const liveSource = clip => clip?.kind === 'source' && ['capture', 'screen'].includes(sourceDefinition(clip.source)?.kind);
const hasMedia = clip => (clip.kind !== 'source' && clip.kind !== 'effect') || liveSource(clip);
const mediaURL = clip => liveSource(clip)
  ? `capture:${clip.source}:${clip.params?.device || ''}:${clip.params?.width || 1280}x${clip.params?.height || 720}:${clip.params?.cursor !== false}` : clip.url || clip.path;
const LOG_BINS = 64;
const auxiliaryId = (role, ownerId) => JSON.stringify([role, ownerId]);
const voiceMediaId = (clipId, voiceId) => voiceId && voiceId !== clipId ? auxiliaryId('voice', voiceId) : clipId;

// A camera looking at the composition center with a 60 degree vertical field
// of view. Invert the projected plane so every fragment samples the actual
// perspective surface, including rotations around a displaced local anchor.
function inverseSurface(transform, width, height, scaleX, scaleY) {
  const angle = value => number(value)*Math.PI/180;
  const rx = angle(transform.rotationX), ry = angle(transform.rotationY), rz = angle(transform.rotation);
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  const rotation = [cz*cy, cz*sy*sx-sz*cx, cz*sy*cx+sz*sx,
    sz*cy, sz*sy*sx+cz*cx, sz*sy*cx-cz*sx, -sy, cy*sx, cy*cx];
  const anchor = [number(transform.anchorX)*scaleX, -number(transform.anchorY)*scaleY, number(transform.anchorZ)*number(transform.scale, 1)];
  const offset = [number(transform.x)*width, -number(transform.y)*height, 0].map((position, row) => position-rotation[row*3]*anchor[0]-rotation[row*3+1]*anchor[1]-rotation[row*3+2]*anchor[2]);
  const distance = height/(2*Math.tan(Math.PI/6));
  const [a,b,c,d,e,f,g,h,i] = [distance*rotation[0]*scaleX, distance*rotation[1]*scaleY, distance*offset[0],
    distance*rotation[3]*scaleX, distance*rotation[4]*scaleY, distance*offset[1],
    -rotation[6]*scaleX, -rotation[7]*scaleY, distance-offset[2]];
  const determinant = a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return null;
  return new Float32Array([e*i-f*h, f*g-d*i, d*h-e*g, c*h-b*i, a*i-c*g, b*g-a*h, b*f-c*e, c*d-a*f, a*e-b*d].map(value => value/determinant));
}

export class LiveEngine {
  constructor(canvas, { onError = () => {}, maxMedia = 64 } = {}) {
    this.canvas = canvas;
    this.onError = onError;
    this.media = new Map();
    this.audioLayers = new Map();
    this.audioGroups = new Map();
    // Lazily compiled catalog programs, per-instance feedback buffers, canvas
    // sources (Text Animator) and cached layer outputs for routers/outputs.
    this.fxPrograms = new Map();
    this.feedback = new Map();
    this.canvasSources = new Map();
    this.layerCache = new Map();
    this.cacheRequests = new Set();
    this.analysers = new Map();
    this.spectra = new Map();
    this.audioBands = [0, 0, 0, 0];
    this.frameIndex = 0;
    this.beat = 0;
    this.maxMedia = Math.round(clamp(maxMedia, 1, 256));
    this.mediaClock = 0;
    this.protectedMedia = new Set();
    this.errors = new Set();
    this.targets = [];
    this.programs = [];
    this.streams = new Set();
    this.disposed = false;
    this.lost = false;
    this._audioContext = null;
    this.stats = { fps: 0, frameMs: 0, frames: 0, mediaCount: 0, activeClips: 0, droppedFrames: 0, width: canvas.width, height: canvas.height, renderer: 'WebGL2' };
    this.lastRender = 0;
    this.lastFinished = null;
    this.onContextLost = (event) => {
      event.preventDefault();
      this.lost = true;
      this._error('context', 'Graphics context interrupted. Waiting for the GPU to recover.');
    };
    this.onContextRestored = () => {
      if (this.disposed) return;
      this.lost = false;
      this.errors.delete('context');
      this.targets = [];
      this.lastFinished = null;
      this.programs = [];
      this.fxPrograms.clear();
      this.feedback.clear();
      this.layerCache.clear();
      for (const source of this.canvasSources.values()) source.texture = null;
      try {
        this._initGL();
        for (const entry of this.media.values()) {
          entry.texture = null;
          entry.dirty = true;
          entry.lastUpload = -1;
        }
      } catch (error) { this._error('restore', error.message); }
    };
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!this.gl) throw new Error('WebGL 2 is unavailable. Enable hardware acceleration or update the graphics driver.');
    this._initGL();
  }

  get audioContext() { this._ensureAudio(); return this._audioContext; }

  _error(key, message) {
    if (this.errors.has(key) || this.disposed) return;
    this.errors.add(key);
    this.onError(String(message));
  }

  _ensureAudio() {
    if (this._audioContext || this.disposed) return;
    try {
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextClass) return;
      this._audioContext = new AudioContextClass({ latencyHint: 'interactive' });
      this.masterGain = this._audioContext.createGain();
      this.masterPanner = this._audioContext.createStereoPanner();
      this.limiter = this._audioContext.createDynamicsCompressor();
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.1;
      this.audioDestination = this._audioContext.createMediaStreamDestination();
      this.masterGain.connect(this.masterPanner);
      this.masterPanner.connect(this.limiter);
      this.limiter.connect(this._audioContext.destination);
      this.limiter.connect(this.audioDestination);
      this.masterMeter = this._createMeter(this.limiter);
    } catch (error) { this._error('audio-context', `Audio output unavailable: ${error.message}`); }
  }

  _connectAudio(entry) {
    this._ensureAudio();
    if (!this._audioContext || entry.audioNode || entry.kind === 'image') return;
    try {
      entry.audioNode = this._audioContext.createMediaElementSource(entry.element);
      entry.gainNode = this._audioContext.createGain();
      entry.gainNode.gain.value = 0;
      entry.panNode = this._audioContext.createStereoPanner();
      entry.audioNode.connect(entry.gainNode);
      entry.gainNode.connect(entry.panNode);
      entry.panNode.connect(this.masterGain);
    } catch (error) { this._error(`audio-${entry.id}`, `Cannot route audio for ${entry.name}: ${error.message}`); }
  }

  _createMeter(source) {
    const splitter = this._audioContext.createChannelSplitter(2);
    const analysers = [this._audioContext.createAnalyser(), this._audioContext.createAnalyser()];
    source.connect(splitter);
    for (let channel = 0; channel < 2; channel++) {
      analysers[channel].fftSize = 512;
      splitter.connect(analysers[channel], channel);
    }
    return { splitter, analysers, samples: [new Float32Array(512), new Float32Array(512)] };
  }

  _readMeter(meter) {
    const peak = [0, 0], rms = [0, 0];
    if (meter) for (let channel = 0; channel < 2; channel++) {
      const values = meter.samples[channel];
      meter.analysers[channel].getFloatTimeDomainData(values);
      let energy = 0;
      for (const value of values) { peak[channel] = Math.max(peak[channel], Math.abs(value)); energy += value*value; }
      rms[channel] = Math.sqrt(energy/values.length);
    }
    return { peak, rms };
  }

  _disposeMeter(meter) {
    meter?.splitter.disconnect();
    for (const analyser of meter?.analysers || []) analyser.disconnect();
  }

  // Splice an audio effect chain between two connected nodes on first use.
  _audioInsert(holder, from, to, effects, bpm) {
    if (!holder.fxChain) {
      if (!effects?.length || !this._audioContext) return;
      holder.fxChain = new AudioEffectChain(this._audioContext);
      from.disconnect(to); from.connect(holder.fxChain.input); holder.fxChain.output.connect(to);
    }
    holder.fxChain.sync(effects || [], { bpm });
  }

  // Group audio bus (manual p. 43): layers in a group mix into it, then into
  // the composition, so group volume/pan/crossfader apply to all its layers.
  _groupAudio(group, project) {
    let bus = this.audioGroups.get(group.id);
    if (!bus) {
      const gain = this._audioContext.createGain(), panner = this._audioContext.createStereoPanner();
      gain.connect(panner); panner.connect(this.masterGain);
      bus = { gain, panner, input: gain, level: 1, pan: 0 };
      this.audioGroups.set(group.id, bus);
    }
    const level = group.bypass ? 0 : clamp(group.volume ?? 1)*groupGain(group.crossfader, clamp(project?.crossfader ?? 0.5));
    if (bus.level !== level) { bus.gain.gain.setTargetAtTime(level, this._audioContext.currentTime, 0.012); bus.level = level; }
    const pan = clamp(group.pan ?? 0, -1, 1);
    if (bus.pan !== pan) { bus.panner.pan.setTargetAtTime(pan, this._audioContext.currentTime, 0.012); bus.pan = pan; }
    if (bus.frame !== this.frameIndex) { bus.frame = this.frameIndex; this._audioInsert(bus, bus.gain, bus.panner, group.audioEffects, project?.bpm); }
    return bus;
  }

  _layerAudio(layer, project) {
    if (!this._audioContext) return null;
    let bus = this.audioLayers.get(layer.id);
    if (!bus) {
      const input = this._audioContext.createGain(), panner = this._audioContext.createStereoPanner();
      input.connect(panner);
      panner.connect(this.masterGain);
      bus = { input, panner, pan: 0, meter: this._createMeter(panner), destination: this.masterGain };
      this.audioLayers.set(layer.id, bus);
    }
    if (bus.frame !== this.frameIndex) { bus.frame = this.frameIndex; this._audioInsert(bus, bus.input, bus.panner, layer.audioEffects, project?.bpm); }
    const group = layer.groupId ? project?.groups?.find(item => item.id === layer.groupId) : null;
    const destination = group ? this._groupAudio(group, project).input : this.masterGain;
    if (bus.destination !== destination) {
      bus.panner.disconnect(); bus.panner.connect(destination); bus.panner.connect(bus.meter.splitter);
      bus.destination = destination;
    }
    const pan = clamp(layer.pan ?? 0, -1, 1);
    if (bus.pan !== pan) {
      bus.panner.pan.setTargetAtTime(pan, this._audioContext.currentTime, 0.012);
      bus.pan = pan;
    }
    return bus;
  }

  _program(fragment, names) {
    const gl = this.gl;
    const shaders = [];
    const program = gl.createProgram();
    try {
      for (const [type, code] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]]) {
        const shader = gl.createShader(type);
        shaders.push(shader);
        gl.shaderSource(shader, code);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`GPU shader failed: ${gl.getShaderInfoLog(shader)}`);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`GPU program failed: ${gl.getProgramInfoLog(program)}`);
      const result = { program, uniforms: Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)])) };
      this.programs.push(program);
      return result;
    } catch (error) { gl.deleteProgram(program); throw error; }
    finally { for (const shader of shaders) gl.deleteShader(shader); }
  }

  _initGL() {
    const gl = this.gl;
    const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
    this.stats.renderer = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    this.sourceProgram = this._program(SOURCE, ['uImage', 'uSource', 'uTime', 'uColor', 'uFit', 'uAspect', 'uChannels', 'uIgnoreAlpha']);
    this.effectProgram = this._program(EFFECT, ['uImage', 'uEffect', 'uAmount', 'uTime', 'uResolution']);
    this.transformProgram = this._program(TRANSFORM, ['uImage', 'uInverse', 'uResolution', 'uValid']);
    this.compositeProgram = this._program(COMPOSITE_FRAGMENT, ['uBase', 'uTop', 'uBlend', 'uOpacity', 'uTime', 'uResolution', 'uTransition']);
    this.copyProgram = this._program(COPY, ['uImage', 'uOpacity', 'uOpaque']);
    this.maskProgram = this._program(MASK, ['uImage', 'uMask', 'uAlpha', 'uInvert', 'uLuma']);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    this.blankTexture = this._texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    this.resize(this.canvas.width || 1280, this.canvas.height || 720, true);
  }

  _texture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  resize(width, height, force = false) {
    if (this.disposed || this.lost) return;
    const gl = this.gl;
    this.requestedWidth = width;
    this.requestedHeight = height;
    const max = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    width = Math.round(clamp(width, 16, max));
    height = Math.round(clamp(height, 16, max));
    if (!force && this.canvas.width === width && this.canvas.height === height) return;
    const allocated = [];
    try {
      // 0, 1, 5: scratch; 2: layer; 3/4: composition; 6/7: group accumulation.
      for (let i = 0; i < 8; i++) {
        const texture = this._texture();
        const framebuffer = gl.createFramebuffer();
        allocated.push({ texture, framebuffer });
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('The GPU cannot allocate the requested output resolution. Choose a smaller composition size.');
      }
    } catch (error) {
      for (const target of allocated) { gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.framebuffer); }
      if (!this.targets.length) throw error;
      this._error(`resize-${width}-${height}`, error.message);
      return;
    } finally { gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    for (const target of this.targets) { gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.framebuffer); }
    this.targets = allocated;
    this.scratchTargets = [allocated[0], allocated[1], allocated[5]];
    this._clearCaches();
    this.lastFinished = null;
    this.canvas.width = width;
    this.canvas.height = height;
    gl.viewport(0, 0, width, height);
    this.stats.width = width;
    this.stats.height = height;
  }

  async prepare(clip, voiceId = clip?.id) {
    if (this.disposed) throw new Error('The engine has been disposed.');
    if (!clip) return null;
    const mediaId = voiceMediaId(clip.id, voiceId), pairId = auxiliaryId('audio', mediaId), reverseId = auxiliaryId('reverse', mediaId), audioAsset = clip.audio;
    if (!audioAsset) this.remove(pairId);
    const reversedURL = reverseMediaURL(clip);
    if (!reversedURL) this.remove(reverseId);
    // Decode both tracks independently. The audio defines the shared timeline;
    // the video's native duration is retained for stretching it onto that clock.
    const mainAsset = audioAsset ? { ...clip } : clip;
    const main = liveSource(clip) ? this._prepareCapture(clip, mediaId) : !hasMedia(clip) ? Promise.resolve(null) : this._prepareMedia(mainAsset, mediaId, 'main', clip.id, mediaId);
    const paired = audioAsset ? this._prepareMedia({ ...audioAsset, kind: 'audio', name: audioAsset.name || `${clip.name || 'Clip'} audio` }, pairId, 'audio', clip.id, mediaId) : Promise.resolve(null);
    const reversed = reversedURL ? this._prepareMedia({ ...mainAsset, url: reversedURL }, reverseId, 'reverse', clip.id, mediaId) : Promise.resolve(null);
    const [element, audio, reverseElement] = await Promise.all([main, paired, reversed]);
    if (clip.audio !== audioAsset) return element;
    if (element && clip.kind !== 'image') element.muted = !!clip.audio || clip.useAudio === false;
    if (reverseElement) reverseElement.muted = !!clip.audio || clip.useAudio === false;
    if (element && clip.kind === 'video' && Number.isFinite(element.duration)) clip.videoDuration = element.duration;
    const animation = this.media.get(mediaId)?.animation;
    if (animation) clip.videoDuration = animation.duration;
    if (element && clip.kind !== 'audio') {
      clip.nativeWidth = element.videoWidth || element.naturalWidth || 0;
      clip.nativeHeight = element.videoHeight || element.naturalHeight || 0;
      clip.hasAlpha = !!this.media.get(mediaId)?.hasAlpha;
    }
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      clip.audio.duration = audio.duration;
      clip.duration = audio.duration;
    } else if (animation) clip.duration = animation.duration;
    else if (element && clip.kind !== 'image' && Number.isFinite(element.duration) && element.duration > 0) clip.duration = element.duration;
    return element;
  }

  // Capture devices / screens (manual pp. 72–75) as live video entries.
  _prepareCapture(clip, key) {
    const url = mediaURL(clip), previous = this.media.get(key);
    if (previous && previous.url === url) { previous.lastUsed = ++this.mediaClock; return previous.promise; }
    if (previous) this._removeMedia(key);
    const element = document.createElement('video');
    element.muted = true; element.playsInline = true;
    const entry = { id: key, ownerId: clip.id, cacheGroup: key, role: 'main', name: clip.name || 'Capture', kind: 'video', live: true, url, element, texture: null,
      ready: false, failed: false, dirty: true, hasAlpha: false, alphaKnown: true, lastUpload: -1, lastTarget: null, lastNow: null, gain: 0, active: false, cancel: null, lastUsed: ++this.mediaClock };
    this.media.set(key, entry);
    const params = clip.params || {};
    entry.promise = (async () => {
      try {
        const stream = clip.source === 'screen'
          ? await (this.captureProvider?.screen?.(params) || navigator.mediaDevices.getDisplayMedia({ video: { cursor: params.cursor === false ? 'never' : 'always' }, audio: false }))
          : await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...(params.device ? { deviceId: { exact: params.device } } : {}),
            width: { ideal: params.width || 1280 }, height: { ideal: params.height || 720 } } });
        if (this.disposed || this.media.get(key) !== entry) { stream.getTracks().forEach(track => track.stop()); throw new Error('Capture was closed.'); }
        entry.stream = stream;
        element.srcObject = stream;
        await element.play();
        entry.ready = true;
        if (element.requestVideoFrameCallback) {
          const decoded = () => { entry.dirty = true; entry.videoFrameReady = true; if (!this.disposed && this.media.get(key) === entry) entry.videoCallback = element.requestVideoFrameCallback(decoded); };
          entry.videoCallback = element.requestVideoFrameCallback(decoded);
        }
        return element;
      } catch (error) {
        entry.failed = true;
        this._error(`media-${key}`, `Cannot open ${entry.name}: ${error.message}`);
        throw error;
      }
    })();
    return entry.promise;
  }

  async prepareMask(owner) {
    if (this.disposed) throw new Error('The engine has been disposed.');
    if (!owner.mask) return null;
    const key = auxiliaryId('mask', owner.mask.id);
    return this._prepareMedia({ ...owner.mask, kind: 'image', name: owner.mask.name || 'Mask' }, key, 'mask', owner.id);
  }

  removeMask(maskId) { this.remove(auxiliaryId('mask', maskId)); }

  async _prepareMedia(clip, key = clip.id, role = 'main', ownerId = clip.id, cacheGroup = key) {
    const url = clip.url || clip.path;
    const previous = this.media.get(key);
    if (previous && previous.url === url && previous.kind === clip.kind) {
      previous.lastUsed = ++this.mediaClock;
      if (clip.hasAlpha === true) previous.hasAlpha = true;
      return previous.promise;
    }
    if (previous) this.remove(key);
    if (!url) {
      const error = new Error(`No media path is available for ${clip.name || 'this clip'}.`);
      this._error(`media-${key}`, error.message);
      throw error;
    }
    const element = clip.kind === 'image' ? new Image() : document.createElement(clip.kind === 'audio' ? 'audio' : 'video');
    // The model defaults hasAlpha to false even for uninspected browser media.
    // Only native MOV registration (or an explicit caller) has verified it.
    const alphaKnown = clip.alphaKnown === true || (/\.mov$/i.test(clip.path || '') && /^prism-media:/i.test(url));
    const entry = { id: key, ownerId, cacheGroup, role, name: clip.name || 'Media', kind: clip.kind, url, element, texture: null, ready: false, failed: false, dirty: true, hasAlpha: clip.hasAlpha === true, alphaKnown, lastUpload: -1, lastTarget: null, lastNow: null, gain: 0, active: false, cancel: null, lastUsed: ++this.mediaClock };
    this.media.set(key, entry);
    this._pruneMedia(key);
    if (!url.startsWith('file:')) element.crossOrigin = 'anonymous';
    if (clip.kind !== 'image') {
      element.preload = 'metadata';
      element.playsInline = true;
      element.loop = false;
      element.preservesPitch = false;
      this._connectAudio(entry);
    }
    entry.promise = new Promise((resolve, reject) => {
      let done = false, loading = false;
      const event = clip.kind === 'image' ? 'load' : 'loadedmetadata';
      const cleanup = () => { clearTimeout(timer); element.removeEventListener(event, loaded); entry.cancel = null; };
      const loaded = async () => {
        if (done || loading) return;
        loading = true;
        if (clip.kind === 'image' && isGifAsset(clip, url)) {
          entry.gifController = new AbortController();
          try {
            const animation = await GifPlayback.open(url, entry.gifController.signal, error => this._error(`gif-${entry.id}`, `Cannot animate ${entry.name}: ${error.message}`));
            if (done || this.disposed || this.media.get(key) !== entry) { animation?.close(); return; }
            entry.animation = animation;
          } catch (error) { if (!done) failed(error); return; }
        }
        if (done) return;
        entry.ready = true;
        if (clip.kind === 'image') entry.hasAlpha = entry.animation?.hasAlpha || this._hasTransparency(element);
        if (role === 'mask') entry.alphaMask = entry.hasAlpha;
        this._pruneMedia(key);
        if (clip.kind !== 'image' && Number.isFinite(element.duration) && element.duration > 0) clip.duration = element.duration;
        if (clip.kind === 'video' && element.requestVideoFrameCallback) {
          const decoded = () => {
            entry.dirty = true;
            entry.videoFrameReady = true;
            if (!this.disposed && this.media.get(entry.id) === entry) entry.videoCallback = element.requestVideoFrameCallback(decoded);
          };
          entry.videoCallback = element.requestVideoFrameCallback(decoded);
        }
        done = true;
        cleanup();
        resolve(element);
      };
      const failed = failure => {
        entry.failed = true;
        entry.ready = false;
        entry.gifController?.abort();
        this._pruneMedia(entry.id);
        const reason = failure instanceof Error ? failure.message : element.error?.message || (element.error?.code === 4 ? 'unsupported format or missing file' : 'file is missing, damaged, or unsupported');
        const error = new Error(`Cannot load ${entry.name}: ${reason}.`);
        this._error(`media-${entry.id}`, error.message);
        if (!done) { done = true; cleanup(); reject(error); }
        if (clip.kind !== 'image') element.pause();
      };
      entry.onError = failed;
      element.addEventListener(event, loaded);
      element.addEventListener('error', failed);
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        entry.failed = true;
        entry.gifController?.abort();
        cleanup();
        const error = new Error(`Loading ${entry.name} timed out. Check that its file is accessible.`);
        this._error(`media-${entry.id}`, error.message);
        reject(error);
      }, 20000);
      entry.cancel = () => { if (!done) { done = true; entry.gifController?.abort(); cleanup(); reject(new Error('Media loading cancelled.')); } };
      element.src = url;
      if (clip.kind !== 'image') element.load();
    });
    return entry.promise;
  }

  getMedia(clipId, voiceId) {
    const key = voiceMediaId(clipId, voiceId);
    const reversed = this.media.get(auxiliaryId('reverse', key));
    return (reversed?.active ? reversed : this.media.get(key))?.element || null;
  }
  getAudio(clipId, voiceId) { return this.media.get(auxiliaryId('audio', voiceMediaId(clipId, voiceId)))?.element || null; }
  getMediaInfo(clip) {
    const entry = this.media.get(clip.id), element = entry?.element;
    return { nativeWidth: element?.videoWidth || element?.naturalWidth || clip.nativeWidth || 0,
      nativeHeight: element?.videoHeight || element?.naturalHeight || clip.nativeHeight || 0, hasAlpha: !!entry?.hasAlpha };
  }

  _hasTransparency(image) {
    // Inspect strips, keeping readback memory bounded even for large masks.
    const canvas = document.createElement('canvas');
    const width = image.naturalWidth || image.videoWidth, fullHeight = image.naturalHeight || image.videoHeight;
    if (!width || !fullHeight) return false;
    canvas.width = width;
    canvas.height = Math.min(128, fullHeight);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    try {
      for (let y = 0; y < fullHeight; y += canvas.height) {
        const height = Math.min(canvas.height, fullHeight-y);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, y, canvas.width, height, 0, 0, canvas.width, height);
        const pixels = context.getImageData(0, 0, canvas.width, height).data;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) return true;
      }
    } catch (error) { this._error(`mask-alpha-${image.src}`, `Cannot inspect mask transparency: ${error.message}`); }
    finally { canvas.width = canvas.height = 0; }
    return false;
  }

  _pruneMedia(preparingId = null) {
    if (this.media.size <= this.maxMedia) return;
    const preparingGroup = this.media.get(preparingId)?.cacheGroup;
    const protectedGroups = new Set([...this.media.values()].filter(entry => entry.active || this.protectedMedia.has(entry.id) || (!entry.ready && !entry.failed)).map(entry => entry.cacheGroup));
    const idle = [...this.media.values()].filter(entry => entry.id !== preparingId && entry.cacheGroup !== preparingGroup && !protectedGroups.has(entry.cacheGroup) && (entry.ready || entry.failed));
    idle.sort((a, b) => a.lastUsed-b.lastUsed);
    for (const entry of idle) {
      if (this.media.size <= this.maxMedia) break;
      for (const linked of [...this.media.values()]) if (linked.cacheGroup === entry.cacheGroup) this._removeMedia(linked.id);
    }
  }

  _bind(target, clear = false) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer || null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  }

  _use(shader) { this.gl.useProgram(shader.program); return shader.uniforms; }
  _sample(texture, uniform, unit = 0) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture || this.blankTexture);
    gl.uniform1i(uniform, unit);
  }
  _draw() { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3); }

  _upload(entry, time = 0) {
    const gl = this.gl;
    if (!entry.ready || entry.failed || entry.kind === 'audio') return null;
    const element = entry.animation?.frameAt(time) || entry.element;
    if (entry.kind === 'video' && element.readyState < 2) return entry.texture;
    if (!entry.texture) { entry.texture = this._texture(); entry.dirty = true; }
    const videoChanged = entry.kind === 'video' && entry.lastUpload !== element.currentTime;
    const animationChanged = entry.animation && entry.lastAnimationFrame !== element;
    if (entry.dirty || videoChanged || animationChanged) {
      // Native imports can identify alpha before the first decoded frame. Keep
      // that information: a transparent movie may start with an opaque frame.
      // For browser imports without metadata, inspect advancing frames at a
      // bounded rate until alpha appears, including after a seek. Canvas can
      // return an empty image before the first presented video frame.
      if (entry.kind === 'video' && !entry.alphaKnown && !entry.hasAlpha && !element.seeking && (entry.videoFrameReady || !element.requestVideoFrameCallback)) {
        const now = performance.now();
        if (entry.lastAlphaCheck == null || now-entry.lastAlphaCheck >= 500 || entry.alphaSeek) {
          entry.hasAlpha = this._hasTransparency(element);
          entry.lastAlphaCheck = now;
          entry.alphaSeek = false;
        }
      }
      try {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
        entry.dirty = false;
        entry.lastUpload = element.currentTime || 0;
        entry.lastAnimationFrame = element;
      } catch (error) {
        entry.failed = true;
        this._error(`texture-${entry.id}`, `Cannot display ${entry.name}: ${error.message}`);
        return null;
      }
    }
    return entry.texture;
  }

  _sourceParams(clip, definition) {
    const params = { ...(clip.params || {}) };
    // The clip colour (also shown on its slot) is the source's colour parameter.
    if (definition.params?.some(param => param.key === 'color' && param.type === 'color') && /^#[0-9a-f]{6}$/i.test(clip.color || '')) params.color = clip.color;
    return params;
  }

  _fullFrame(target) {
    target.contentWidth = target.fitWidth = this.canvas.width;
    target.contentHeight = target.fitHeight = this.canvas.height;
    return target;
  }

  _shaderSource(clip, definition, time) {
    const shader = this._catalogProgram(`src:${definition.id}`, () => buildSourceShader(definition), definition);
    if (!shader) return null;
    const gl = this.gl;
    this._bind(this.targets[0], true);
    const u = this._use(shader);
    this._builtins(u, number(time));
    bindParams(gl, u, definition, this._sourceParams(clip, definition));
    this._draw();
    return this._fullFrame(this.targets[0]);
  }

  _canvasSource(clip, definition, time) {
    let source = this.canvasSources.get(clip.id);
    if (!source || source.definition !== definition) {
      source?.instance?.dispose?.();
      if (source?.texture && !this.lost) this.gl.deleteTexture(source.texture);
      source = { definition, instance: definition.create(), texture: null, used: 0 };
      this.canvasSources.set(clip.id, source);
    }
    source.used = this.frameIndex;
    const gl = this.gl, image = source.instance.render(this._sourceParams(clip, definition), number(time), this.canvas.width, this.canvas.height);
    if (!image) return null;
    if (!source.texture) source.texture = this._texture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this._bind(this.targets[0], true);
    const u = this._use(this.sourceProgram);
    this._sample(source.texture, u.uImage);
    gl.uniform1i(u.uSource, 0);
    gl.uniform2f(u.uFit, 1, 1);
    gl.uniform3f(u.uChannels, clip.red === false ? 0 : 1, clip.green === false ? 0 : 1, clip.blue === false ? 0 : 1);
    gl.uniform1i(u.uIgnoreAlpha, 0);
    this._draw();
    return this._fullFrame(this.targets[0]);
  }

  // Video Router (manual p. 79): the composition below this layer, or a
  // cached layer/group output requested earlier in the frame.
  _routerSource(clip) {
    const input = typeof clip.params?.input === 'string' ? clip.params.input : 'below';
    const routed = input === 'below' ? this.routerBase : this.layerCache.get(input.replace(/^(layer|group):/, ''));
    if (!routed) return null;
    this._copy(routed, this.targets[0]);
    return this._fullFrame(this.targets[0]);
  }

  _source(clip, entry, time) {
    const gl = this.gl;
    if (clip.kind === 'source') {
      const definition = sourceDefinition(clip.source);
      if (definition?.kind === 'canvas' && typeof definition.create === 'function') return this._canvasSource(clip, definition, time);
      if (definition?.kind === 'router') return this._routerSource(clip);
      if (definition?.glsl) return this._shaderSource(clip, definition, time);
    }
    const generated = clip.kind === 'source' && !liveSource(clip);
    const imageTime = entry?.animation && clip.audio ? number(time) * entry.animation.duration / Math.max(0.001, number(clip.duration, 1)) : time;
    const texture = generated ? this.blankTexture : this._upload(entry, imageTime);
    if (!texture) return null;
    this._bind(this.targets[0], true);
    const u = this._use(this.sourceProgram);
    this._sample(texture, u.uImage);
    gl.uniform1i(u.uSource, generated ? (SOURCES[clip.source] || 1) : 0);
    gl.uniform1f(u.uTime, number(time));
    const hex = /^#[0-9a-f]{6}$/i.test(clip.color) ? clip.color.slice(1) : 'ff6a38';
    gl.uniform3f(u.uColor, parseInt(hex.slice(0, 2), 16)/255, parseInt(hex.slice(2, 4), 16)/255, parseInt(hex.slice(4, 6), 16)/255);
    gl.uniform3f(u.uChannels, clip.red === false ? 0 : 1, clip.green === false ? 0 : 1, clip.blue === false ? 0 : 1);
    gl.uniform1i(u.uIgnoreAlpha, entry?.hasAlpha && clip.alpha === false ? 1 : 0);
    if (!generated) clip.hasAlpha = !!entry.hasAlpha;
    const aspect = this.canvas.width/this.canvas.height;
    const width = generated ? this.canvas.width : entry.element.videoWidth || entry.element.naturalWidth || this.canvas.width;
    const height = generated ? this.canvas.height : entry.element.videoHeight || entry.element.naturalHeight || this.canvas.height;
    const sourceAspect = width/height;
    let fit = [Math.min(1, sourceAspect/aspect), Math.min(1, aspect/sourceAspect)];
    if (clip.fit === 'cover') fit = [Math.max(1, sourceAspect/aspect), Math.max(1, aspect/sourceAspect)];
    else if (clip.fit === 'width') fit = [1, aspect/sourceAspect];
    else if (clip.fit === 'height') fit = [sourceAspect/aspect, 1];
    else if (clip.fit === 'stretch') fit = [1, 1];
    else if (clip.fit === 'original') fit = [width/this.canvas.width, height/this.canvas.height];
    // Keep the complete source for effects/masks, then size its surface in the
    // transform stage. A later shrink/rotation must not reveal a cropped source.
    gl.uniform2f(u.uFit, 1, 1);
    gl.uniform1f(u.uAspect, aspect);
    this._draw();
    this.targets[0].contentWidth = this.canvas.width;
    this.targets[0].contentHeight = this.canvas.height;
    this.targets[0].fitWidth = fit[0]*this.canvas.width;
    this.targets[0].fitHeight = fit[1]*this.canvas.height;
    return this.targets[0];
  }

  _effects(input, effects, now) {
    let current = input;
    for (const effect of effects || []) {
      if (effect.enabled === false) continue;
      const opacity = clamp(effect.opacity ?? 1);
      if (opacity <= 0) continue;
      const definition = effectDefinition(effect.type);
      const output = definition ? this._runEffect(current, effect, definition, now) : EFFECTS[effect.type] ? this._legacyEffect(current, effect, now) : null;
      if (!output) continue;
      const blend = normalizeBlend(effect.blend);
      if (opacity >= 1 && blend === 'normal') { current = output; continue; }
      // Resolume mixes each effect with its input by its own opacity/blend.
      // Alpha blend crossfades so a full-opacity key still shows only the key.
      const mixed = this._scratch(current, output);
      this._composite(current, output, mixed, blend, opacity, now, blend === 'normal');
      this._copySize(current, mixed);
      current = mixed;
    }
    return current;
  }

  _legacyEffect(current, effect, now) {
    const target = this._scratch(current);
    this._bind(target);
    const gl = this.gl;
    const u = this._use(this.effectProgram);
    this._sample(current.texture, u.uImage);
    gl.uniform1i(u.uEffect, EFFECTS[effect.type]);
    gl.uniform1f(u.uAmount, number(effectParams(effect).amount, 0.5));
    gl.uniform1f(u.uTime, now);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    this._draw();
    this._copySize(current, target);
    return target;
  }

  _scratch(...exclude) { return this.scratchTargets.find(target => !exclude.includes(target)); }

  _catalogProgram(key, build, definition) {
    let entry = this.fxPrograms.get(key);
    if (entry?.definition !== definition) {
      if (entry?.shader) { this.gl.deleteProgram(entry.shader.program); this.programs = this.programs.filter(program => program !== entry.shader.program); }
      try { entry = { definition, shader: this._program(build(), uniformNames(definition)) }; }
      catch (error) { entry = { definition, shader: null }; this._error(`program-${key}`, `${definition.name || definition.id} could not compile: ${error.message}`); }
      this.fxPrograms.set(key, entry);
    }
    return entry.shader;
  }

  _builtins(u, now) {
    const gl = this.gl, width = this.canvas.width, height = this.canvas.height;
    gl.uniform2f(u.uResolution, width, height);
    gl.uniform1f(u.uAspect, width/height);
    gl.uniform1f(u.uTime, now);
    gl.uniform1f(u.uBeat, this.beat);
    gl.uniform4f(u.uAudio, ...this.audioBands);
  }

  _runEffect(input, effect, definition, now) {
    const passes = effectPasses(definition), params = effectParams(effect), gl = this.gl;
    const history = definition.feedback ? this._feedbackTarget(effect.id) : null;
    let source = input;
    for (let pass = 0; pass < passes.length; pass++) {
      const shader = this._catalogProgram(`fx:${definition.id}:${pass}`, () => buildEffectShader(definition, pass), definition);
      if (!shader) return null;
      const target = this._scratch(input, source);
      this._bind(target);
      const u = this._use(shader);
      this._sample(source.texture, u.uImage, 0);
      this._sample(input.texture, u.uOriginal, 1);
      this._sample(history?.texture, u.uPrevious, 2);
      this._builtins(u, now);
      gl.uniform1i(u.uPass, pass);
      bindParams(gl, u, definition, params);
      this._draw();
      this._copySize(input, target);
      source = target;
    }
    if (history) { this._copy(source, history); history.used = this.frameIndex; }
    return source;
  }

  _allocTarget(width = this.canvas.width, height = this.canvas.height) {
    const gl = this.gl, texture = this._texture(), framebuffer = gl.createFramebuffer();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer, width, height, used: this.frameIndex };
  }

  _freeTarget(target) { if (target && !this.lost) { this.gl.deleteTexture(target.texture); this.gl.deleteFramebuffer(target.framebuffer); } }

  _feedbackTarget(id) {
    let target = this.feedback.get(id);
    if (!target) { target = this._allocTarget(); this.feedback.set(id, target); }
    return target;
  }

  // Cached copy of a processed layer/group for routers and output slices.
  _cacheOutput(id, input) {
    let target = this.layerCache.get(id);
    if (!target) { target = this._allocTarget(); this.layerCache.set(id, target); }
    this._copy(input, target);
    target.used = this.frameIndex;
  }

  layerTexture(id) { return this.layerCache.get(id) || null; }

  _clearCaches() {
    for (const target of [...this.feedback.values(), ...this.layerCache.values()]) this._freeTarget(target);
    this.feedback.clear();
    this.layerCache.clear();
  }

  _pruneTargets() {
    // Free buffers of removed effects or unrouted layers after ~2 s unused.
    for (const map of [this.feedback, this.layerCache]) for (const [id, target] of map) {
      if (this.frameIndex - target.used > 120) { this._freeTarget(target); map.delete(id); }
    }
  }

  _copy(input, target, opacity = 1, opaque = false) {
    this._bind(target);
    const gl = this.gl;
    const u = this._use(this.copyProgram);
    this._sample(input.texture, u.uImage);
    gl.uniform1f(u.uOpacity, opacity);
    gl.uniform1i(u.uOpaque, opaque ? 1 : 0);
    this._draw();
    if (target) this._copySize(input, target);
  }

  _copySize(input, target) {
    for (const key of ['contentWidth', 'contentHeight', 'fitWidth', 'fitHeight']) target[key] = input[key];
  }

  _composite(base, top, target, mode, opacity, now, transition = false) {
    this._bind(target);
    const gl = this.gl, u = this._use(this.compositeProgram);
    this._sample(base.texture, u.uBase, 0);
    this._sample(top.texture, u.uTop, 1);
    gl.uniform1i(u.uBlend, blendIndex(mode));
    gl.uniform1f(u.uOpacity, opacity);
    gl.uniform1f(u.uTime, now);
    gl.uniform2f(u.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform1i(u.uTransition, transition ? 1 : 0);
    this._draw();
    this._copySize(top, target);
  }

  _mask(input, owner) {
    const mask = owner.mask;
    if (!mask || mask.enabled === false) return input;
    const key = auxiliaryId('mask', mask.id);
    let entry = this.media.get(key);
    if (!entry || entry.url !== (mask.url || mask.path)) {
      this.prepareMask(owner).catch(() => {});
      entry = this.media.get(key);
    }
    if (!entry) return input;
    entry.lastUsed = ++this.mediaClock;
    const texture = this._upload(entry);
    if (!texture) return input;
    const target = input === this.targets[0] ? this.targets[1] : this.targets[0];
    this._bind(target);
    const gl = this.gl, u = this._use(this.maskProgram);
    this._sample(input.texture, u.uImage);
    this._sample(texture, u.uMask, 1);
    gl.uniform1i(u.uAlpha, entry.alphaMask ? 1 : 0);
    gl.uniform1i(u.uInvert, mask.invert ? 1 : 0);
    gl.uniform1i(u.uLuma, 0);
    this._draw();
    this._copySize(input, target);
    return target;
  }

  _stageOrder(owner) { return [...new Set([...(Array.isArray(owner.renderOrder) ? owner.renderOrder : []), 'effects', 'mask', 'transform'])]; }

  _process(input, owner, now, scope = 'clip', stages = this._stageOrder(owner)) {
    for (const stage of stages) {
      if (stage === 'effects') input = this._effects(input, owner.effects, now);
      else if (stage === 'mask') input = this._mask(input, owner);
      else if (stage === 'transform') input = this._transform(input, owner, scope);
    }
    return input;
  }

  _transform(input, transform, scope = 'clip') {
    const width = this.canvas.width, height = this.canvas.height, scale = number(transform.scale, 1);
    let scaleX = scale, scaleY = scale;
    if (scope === 'clip') {
      scaleX *= (transform.width != null ? number(transform.width, width) : input.fitWidth || width)/width;
      scaleY *= (transform.height != null ? number(transform.height, height) : input.fitHeight || height)/height;
    } else if (scope === 'layer') {
      if (transform.widthEnabled && transform.width != null) scaleX *= number(transform.width, width)/Math.max(0.001, input.contentWidth || width);
      if (transform.heightEnabled && transform.height != null) scaleY *= number(transform.height, height)/Math.max(0.001, input.contentHeight || height);
    }
    if (scaleX === 1 && scaleY === 1 && !['x', 'y', 'anchorX', 'anchorY', 'anchorZ'].some(key => number(transform[key])) && !['rotation', 'rotationX', 'rotationY'].some(key => number(transform[key])%360)) return input;
    const target = input === this.targets[0] ? this.targets[1] : this.targets[0];
    this._bind(target);
    const gl = this.gl;
    const u = this._use(this.transformProgram);
    this._sample(input.texture, u.uImage);
    const inverse = inverseSurface(transform, width, height, scaleX, scaleY);
    gl.uniform1i(u.uValid, inverse ? 1 : 0);
    if (inverse) gl.uniformMatrix3fv(u.uInverse, false, inverse);
    gl.uniform2f(u.uResolution, width, height);
    this._draw();
    this._copySize(input, target);
    target.contentWidth = (input.contentWidth || width)*scaleX;
    target.contentHeight = (input.contentHeight || height)*scaleY;
    return target;
  }

  _syncMedia(entry, clip, frame, project, now, gain, timeScale = 1, reverse = false) {
    if (!entry.ready || entry.failed || entry.kind === 'image') return;
    const media = entry.element;
    if (entry.live) { if (media.paused && !entry.playPending) { entry.playPending = true; media.play().catch(() => {}).finally(() => { entry.playPending = false; }); } return; }
    const bus = this._layerAudio(frame.layer, project);
    if (bus && entry.panNode && entry.layerBus !== bus) {
      entry.panNode.disconnect();
      entry.panNode.connect(bus.input);
      entry.layerId = frame.layer.id;
      entry.layerBus = bus;
    }
    if (entry.gainNode && (entry.fxChain || clip.audioEffects?.length)) this._audioInsert(entry, entry.gainNode, entry.panNode, clip.audioEffects, project.bpm);
    const pan = clamp(clip.pan ?? 0, -1, 1);
    if (entry.panNode && entry.pan !== pan) {
      entry.panNode.pan.setTargetAtTime(pan, this._audioContext.currentTime, 0.012);
      entry.pan = pan;
    }
    const duration = Number.isFinite(media.duration) ? media.duration : number(clip.duration, 1);
    const timelineDuration = number(clip.duration, duration);
    const sourceTime = (frame.time ?? frame.position*timelineDuration)*timeScale;
    const target = clamp(reverse ? duration-sourceTime : sourceTime, 0, Math.max(0, duration-0.001));
    const elapsed = entry.lastNow === null ? 0 : now-entry.lastNow;
    const looping = (clip.loop || 'loop') === 'loop' && !clip.random && !(clip.beatSync && clip.beatLoop) && number(clip.inPoint) === 0 && number(clip.outPoint, 1) === 1;
    // Native full-length loops avoid a seek/pause at every boundary. Trimmed,
    // random and reverse playback remain driven by the transport's playhead.
    media.loop = looping;
    let delta = entry.lastTarget === null ? 0 : target-entry.lastTarget;
    if (looping && delta < -duration/2 && (reverse || number(clip.direction, 1) > 0)) delta += duration;
    const baseRate = (clip.beatSync ? timelineDuration*number(project.bpm, 120)/(60*Math.max(0.03125, number(clip.beats, 16))) : number(project.speed, 1)*number(clip.speed, 1))*number(clip.direction, 1)*timeScale;
    const inferredRate = elapsed > 0.001 && elapsed < 0.5 && Math.abs(delta) < elapsed*20 ? delta/elapsed : baseRate;
    const rate = frame.rate !== undefined ? number(frame.rate)*(reverse ? 1 : number(frame.direction, 1))*timeScale : inferredRate;
    const moving = !project.paused && !clip.paused && frame.playing !== false && clip.direction !== 0 && !(clip.loop === 'random' && !clip.beatSync) && rate >= 0.0625 && rate <= 16;
    const absoluteDrift = Math.abs(media.currentTime-target);
    const drift = moving && looping ? Math.min(absoluteDrift, Math.abs(duration-absoluteDrift)) : absoluteDrift;
    if (drift > (moving ? 0.18 : 0.025) && !media.seeking) {
      try { media.currentTime = target; entry.dirty = true; entry.alphaSeek = true; }
      catch (error) { this._error(`seek-${entry.id}`, `Cannot seek ${entry.name}: ${error.message}`); }
    }
    if (moving) {
      const playbackRate = clamp(rate, 0.0625, 16);
      if (Math.abs(media.playbackRate-playbackRate) > 0.015) media.playbackRate = playbackRate;
      if (media.paused && !entry.playPending && now >= (entry.retryPlayAt || 0)) {
        entry.playPending = true;
        Promise.resolve(media.play()).catch(error => {
          entry.retryPlayAt = now+2;
          if (error.name !== 'AbortError') this._error(`play-${entry.id}`, `Playback of ${entry.name} could not start: ${error.message}`);
        }).finally(() => { entry.playPending = false; });
      }
    } else if (!media.paused) media.pause();
    const audioGain = moving ? clamp(gain, 0, 8) : 0;
    if (entry.gainNode) {
      if (Math.abs(entry.gain-audioGain) > 0.001) entry.gainNode.gain.setTargetAtTime(audioGain, this._audioContext.currentTime, 0.012);
    } else media.volume = clamp(audioGain*number(project.masterVolume, 1)*number(project.av, 1));
    entry.gain = audioGain;
    entry.lastTarget = target;
    entry.lastNow = now;
  }

  render(project, frames = [], now = performance.now()/1000, { beat } = {}) {
    if (this.disposed) return;
    const started = performance.now();
    this.frameIndex++;
    this.beat = Number.isFinite(beat) ? beat : now*number(project.bpm, 120)/60;
    this._analyseAudio();
    const delta = this.lastRender ? now-this.lastRender : 0;
    if (delta > 0 && delta < 1) this.stats.fps = this.stats.fps ? this.stats.fps*0.92+(1/delta)*0.08 : 1/delta;
    this.lastRender = now;
    this.stats.frames++;
    this.stats.activeClips = frames.length;
    this.stats.mediaCount = this.media.size;
    const groups = new Map((project.groups || []).map(group => [group.id, group]));
    const groupOf = layer => layer.groupId ? groups.get(layer.groupId) || null : null;
    const hasSolo = project.layers.some(layer => layer.solo) || [...groups.values()].some(group => group.solo);
    const visible = layer => {
      const group = groupOf(layer);
      return !project.bypass && !layer.bypass && !group?.bypass && (!hasSolo || layer.solo || !!group?.solo);
    };
    const active = new Set();
    this.protectedMedia = new Set();
    for (const owner of [project, ...groups.values(), ...project.layers, ...frames.map(frame => frame.clip).filter(Boolean)]) {
      if (owner.mask?.enabled !== false && owner.mask) this.protectedMedia.add(auxiliaryId('mask', owner.mask.id));
    }
    for (const frame of frames) if (frame.clip) {
      const key = voiceMediaId(frame.clip.id, frame.sourceLayerId && frame.sourceLayerId !== frame.layer?.id ? frame.voiceId : frame.clip.id);
      this.protectedMedia.add(key);
      if (reverseMediaURL(frame.clip)) this.protectedMedia.add(auxiliaryId('reverse', key));
      if (frame.clip.audio) this.protectedMedia.add(auxiliaryId('audio', key));
    }
    const byLayer = new Map();
    for (const frame of frames) {
      if (!frame.clip || !frame.layer) continue;
      const { clip, layer } = frame;
      const audible = visible(layer);
      const fader = groupGain(layer.group, clamp(project.crossfader ?? 0.5));
      const gain = audible && clip.useAudio !== false ? number(clip.volume, 1)*number(layer.volume, 1)*clamp(layer.av ?? 1)*number(frame.weight, 1)*fader : 0;
      const voiceId = frame.sourceLayerId && frame.sourceLayerId !== layer.id ? frame.voiceId : clip.id;
      const mediaId = voiceMediaId(clip.id, voiceId);
      let entry = this.media.get(mediaId);
      const reverseId = auxiliaryId('reverse', mediaId);
      let reverseEntry = this.media.get(reverseId);
      const reversedURL = reverseMediaURL(clip);
      const pairId = auxiliaryId('audio', mediaId);
      let pair = this.media.get(pairId);
      const live = liveSource(clip), media = hasMedia(clip);
      const mainChanged = media && (!entry || entry.url !== mediaURL(clip) || entry.kind !== (live ? 'video' : clip.kind));
      const reverseChanged = reversedURL && (!reverseEntry || reverseEntry.url !== reversedURL);
      const pairChanged = clip.audio && (!pair || pair.url !== (clip.audio.url || clip.audio.path));
      if (mainChanged || reverseChanged || pairChanged) {
        this.prepare(clip, voiceId).catch(() => {});
        entry = this.media.get(mediaId);
        reverseEntry = this.media.get(reverseId);
        pair = this.media.get(pairId);
      }
      if (!reversedURL && reverseEntry) { this.remove(reverseId); reverseEntry = null; }
      if (!clip.audio && pair) { this.remove(pairId); pair = null; }
      if (media) {
        const reverse = frame.direction < 0 && !!reverseEntry?.ready;
        const selectedEntry = reverse ? reverseEntry : entry;
        if (selectedEntry) {
          active.add(selectedEntry.id);
          selectedEntry.active = true;
          selectedEntry.lastUsed = ++this.mediaClock;
          if (clip.kind !== 'image') selectedEntry.element.muted = !!clip.audio || clip.useAudio === false;
          const scale = clip.audio && clip.kind === 'video' && selectedEntry.element.duration > 0 ? selectedEntry.element.duration/Math.max(0.001, number(clip.duration, 1)) : 1;
          this._syncMedia(selectedEntry, clip, frame, project, now, clip.audio ? 0 : gain, scale, reverse);
        }
        entry = selectedEntry;
      }
      if (pair) {
        active.add(pairId);
        pair.active = true;
        pair.lastUsed = ++this.mediaClock;
        pair.element.muted = clip.useAudio === false;
        this._syncMedia(pair, clip, frame, project, now, gain);
      }
      if (audible && clip.kind !== 'audio' && clip.useVideo !== false) {
        if (!byLayer.has(layer.id)) byLayer.set(layer.id, []);
        byLayer.get(layer.id).push({ frame, entry });
      }
    }
    for (const entry of this.media.values()) {
      if (!active.has(entry.id) && entry.active) {
        entry.active = false;
        if (entry.kind !== 'image') entry.element.pause();
        if (entry.gainNode) entry.gainNode.gain.setTargetAtTime(0, this._audioContext.currentTime, 0.012);
        entry.gain = 0;
        entry.lastNow = null;
        entry.lastTarget = null;
      }
    }
    this._pruneMedia();
    const masterVolume = clamp(project.masterVolume ?? 1, 0, 4)*clamp(project.av ?? 1);
    if (this.masterGain && this.masterVolume !== masterVolume) {
      this.masterVolume = masterVolume;
      this.masterGain.gain.setTargetAtTime(masterVolume, this._audioContext.currentTime, 0.012);
    }
    if (this.masterPanner && this.masterPan !== (project.pan ?? 0)) {
      this.masterPan = project.pan ?? 0;
      this.masterPanner.pan.setTargetAtTime(clamp(this.masterPan, -1, 1), this._audioContext.currentTime, 0.012);
    }
    for (const [id, bus] of this.audioLayers) {
      if (!project.layers.some(layer => layer.id === id)) {
        bus.panner.disconnect(); bus.input.disconnect(); bus.fxChain?.dispose();
        this._disposeMeter(bus.meter);
        this.audioLayers.delete(id);
      }
    }
    for (const [id, bus] of this.audioGroups) {
      const group = groups.get(id);
      if (group) this._groupAudio(group, project);
      else { bus.gain.disconnect(); bus.panner.disconnect(); bus.fxChain?.dispose(); this.audioGroups.delete(id); }
    }
    if (this.masterGain) {
      this.masterFx ||= {};
      this._audioInsert(this.masterFx, this.masterGain, this.masterPanner, project.audioEffects, project.bpm);
    }
    if (this.lost) return;
    const gl = this.gl;
    if (project.width !== this.requestedWidth || project.height !== this.requestedHeight) this.resize(project.width, project.height);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    // Routers reading a specific layer/group and outputs reading one need a
    // cached copy of that output; collect this frame's requests up front.
    const cached = new Set(this.cacheRequests);
    for (const { frame } of [...byLayer.values()].flat()) {
      const input = frame.clip.kind === 'source' && sourceDefinition(frame.clip.source)?.kind === 'router' ? frame.clip.params?.input : null;
      if (typeof input === 'string' && input !== 'below') cached.add(input.replace(/^(layer|group):/, ''));
    }
    const crossfader = clamp(project.crossfader ?? 0.5);
    let composition = this.targets[3];
    this._bind(composition, true);
    const layers = project.layers;
    for (let index = 0; index < layers.length;) {
      const group = groupOf(layers[index]);
      if (!group) {
        this.routerBase = composition;
        const processed = this._renderLayer(layers[index], byLayer, now);
        if (processed) {
          const next = composition === this.targets[3] ? this.targets[4] : this.targets[3];
          composition = this._mixLayer(composition, processed, next, layers[index], crossfader, now);
          if (cached.has(layers[index].id)) this._cacheOutput(layers[index].id, processed);
        }
        index++;
        continue;
      }
      // Groups render their layers on transparent black, then mix as one layer.
      let end = index;
      while (end < layers.length && layers[end].groupId === group.id) end++;
      let accumulated = this.targets[6], drawn = false;
      this._bind(accumulated, true);
      for (let item = index; item < end; item++) {
        this.routerBase = accumulated;
        const processed = this._renderLayer(layers[item], byLayer, now);
        if (!processed) continue;
        const next = accumulated === this.targets[6] ? this.targets[7] : this.targets[6];
        accumulated = this._mixLayer(accumulated, processed, next, layers[item], crossfader, now);
        if (cached.has(layers[item].id)) this._cacheOutput(layers[item].id, processed);
        drawn = true;
      }
      if (drawn) {
        const processed = this._process(accumulated, group, now, 'layer');
        if (cached.has(group.id)) this._cacheOutput(group.id, processed);
        const next = composition === this.targets[3] ? this.targets[4] : this.targets[3];
        this._composite(composition, processed, next, group.blend, clamp(group.opacity ?? 1)*groupGain(group.crossfader, crossfader), now);
        composition = next;
      }
      index = end;
    }
    this.routerBase = null;
    const finished = this._process(composition, project, now, 'composition');
    this.lastFinished = finished;
    this._copy(finished, null, project.blackout || project.bypass ? 0 : clamp(project.masterOpacity ?? 1)*clamp(project.av ?? 1), true);
    this._pruneTargets();
    this._pruneCanvasSources();
    this.stats.frameMs = performance.now()-started;
  }

  // Mix a processed layer into `base`, honouring the layer's mask mode.
  _mixLayer(base, processed, next, layer, crossfader, now) {
    const opacity = clamp(layer.opacity ?? 1)*clamp(layer.av ?? 1)*groupGain(layer.group, crossfader);
    if (layer.maskMode && layer.maskMode !== 'none') {
      // Mask layer (manual p. 39): its luminance or alpha cuts the layers below.
      const masked = opacity < 1 ? this._scratch(processed) : next;
      this._bind(masked);
      const gl = this.gl, u = this._use(this.maskProgram);
      this._sample(base.texture, u.uImage);
      this._sample(processed.texture, u.uMask, 1);
      gl.uniform1i(u.uAlpha, layer.maskMode.startsWith('alpha') ? 1 : 0);
      gl.uniform1i(u.uInvert, layer.maskMode.endsWith('invert') ? 1 : 0);
      gl.uniform1i(u.uLuma, 1);
      this._draw();
      if (opacity < 1) this._composite(base, masked, next, 'normal', opacity, now, true);
      return next;
    }
    this._composite(base, processed, next, layer.blend, opacity, now);
    return next;
  }

  _pruneCanvasSources() {
    for (const [id, source] of this.canvasSources) if (this.frameIndex - source.used > 300) {
      source.instance?.dispose?.();
      if (source.texture && !this.lost) this.gl.deleteTexture(source.texture);
      this.canvasSources.delete(id);
    }
  }

  _renderLayer(layer, byLayer, now) {
      const gl = this.gl;
      const layerFrames = byLayer.get(layer.id);
      if (!layerFrames?.length) return null;
      const layerTarget = this.targets[2];
      this._bind(layerTarget, true);
      // Layer width/height are content-size overrides: normalize every source
      // before mixing, including outside transitions, so endpoints do not jump.
      // Effects, masks and the common XYZ transform still process the mixed
      // layer in its selected render order.
      const normalizeDimensions = layer.widthEnabled || layer.heightEnabled;
      let drawn = false;
      for (const { frame, entry } of layerFrames) {
        if (hasMedia(frame.clip) && (!entry?.ready || entry.failed)) continue;
        // Effect clips process everything beneath them (an adjustment layer).
        const source = frame.clip.kind === 'effect' ? (this.routerBase ? (this._copy(this.routerBase, this.targets[0]), this._fullFrame(this.targets[0])) : null)
          : this._source(frame.clip, entry, frame.time);
        if (!source) continue;
        let processed = this._process(source, frame.clip, now);
        if (normalizeDimensions) {
          processed = this._transform(processed, { width: layer.width, height: layer.height, widthEnabled: layer.widthEnabled,
            heightEnabled: layer.heightEnabled }, 'layer');
        }
        const transitioning = Number.isFinite(frame.transitionProgress);
        if (transitioning && frame.transitionIncoming) {
          if (frame.clip.opacity !== undefined && frame.clip.opacity !== 1) {
            const faded = processed === this.targets[0] ? this.targets[1] : this.targets[0];
            this._copy(processed, faded, clamp(frame.clip.opacity));
            processed = faded;
          }
          const blended = processed === this.targets[0] ? this.targets[1] : this.targets[0];
          this._composite(layerTarget, processed, blended, frame.transitionMode || 'alpha', clamp(frame.transitionProgress), now, true);
          this._copy(blended, layerTarget);
        } else {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          this._copy(processed, layerTarget, (transitioning ? 1 : clamp(frame.weight ?? 1))*clamp(frame.clip.opacity ?? 1));
          gl.disable(gl.BLEND);
        }
        drawn = true;
      }
      if (!drawn) return null;
      const layerTransform = normalizeDimensions ? { ...layer, widthEnabled: false, heightEnabled: false } : layer;
      return this._process(layerTarget, layerTransform, now, 'layer');
  }

  // Audio analysis for FFT-driven parameters and the shaders' uAudio input
  // (manual p. 143). Spectra are 64 log-spaced bands from 20 Hz to 20 kHz,
  // read at most once per rendered frame and only for requested sources.
  _analyser(key, sourceNode) {
    let analyser = this.analysers.get(key);
    if (analyser && analyser.sourceNode !== sourceNode) { analyser.node.disconnect(); try { analyser.sourceNode?.disconnect(analyser.node); } catch { /* already gone */ } this.analysers.delete(key); analyser = null; }
    if (!analyser) {
      if (!sourceNode || !this._audioContext) return null;
      const node = this._audioContext.createAnalyser();
      node.fftSize = 2048; node.smoothingTimeConstant = 0.5; node.minDecibels = -90; node.maxDecibels = -15;
      const count = node.frequencyBinCount, nyquist = this._audioContext.sampleRate/2, ranges = new Uint16Array(LOG_BINS*2);
      for (let i = 0; i < LOG_BINS; i++) {
        const start = Math.min(count-1, Math.floor(20*Math.pow(1000, i/LOG_BINS)/nyquist*count));
        ranges[i*2] = start; ranges[i*2+1] = Math.min(count, Math.max(start+1, Math.ceil(20*Math.pow(1000, (i+1)/LOG_BINS)/nyquist*count)));
      }
      sourceNode.connect(node);
      analyser = { node, sourceNode, ranges, bins: new Uint8Array(count), log: new Float32Array(LOG_BINS), frame: -1, used: this.frameIndex };
      this.analysers.set(key, analyser);
    }
    analyser.used = this.frameIndex;
    return analyser;
  }

  _readSpectrum(analyser) {
    if (analyser.frame !== this.frameIndex) {
      analyser.frame = this.frameIndex;
      analyser.node.getByteFrequencyData(analyser.bins);
      for (let i = 0; i < LOG_BINS; i++) {
        let peak = 0;
        for (let j = analyser.ranges[i*2]; j < analyser.ranges[i*2+1]; j++) if (analyser.bins[j] > peak) peak = analyser.bins[j];
        analyser.log[i] = peak/255;
      }
    }
    return analyser.log;
  }

  // source: 'composition' | 'group' | 'layer' | 'clip' | 'external'.
  spectrum(source = 'composition', id = null) {
    if (!this._audioContext) return null;
    let node = null;
    if (source === 'composition') node = this.limiter;
    else if (source === 'layer') node = this.audioLayers.get(id)?.panner;
    else if (source === 'group') node = this.audioGroups.get(id)?.panner;
    else if (source === 'clip') node = this.media.get(id)?.panNode || this.media.get(auxiliaryId('audio', id))?.panNode;
    else if (source === 'external') node = this.externalSource;
    const analyser = this._analyser(`${source}:${id ?? ''}`, node);
    return analyser ? this._readSpectrum(analyser) : null;
  }

  _analyseAudio() {
    const spectrum = this._audioContext?.state === 'running' ? this.spectrum('composition') : null;
    if (!spectrum) { this.audioBands.fill(0); return; }
    const band = (from, to) => { let sum = 0; for (let i = from; i < to; i++) sum += spectrum[i]; return sum/(to-from); };
    const third = Math.round(LOG_BINS*0.3), upper = Math.round(LOG_BINS*0.7);
    this.audioBands[0] = band(0, third); this.audioBands[1] = band(third, upper); this.audioBands[2] = band(upper, LOG_BINS); this.audioBands[3] = band(0, LOG_BINS);
    for (const [key, analyser] of this.analysers) if (key !== 'composition:' && this.frameIndex - analyser.used > 120) {
      analyser.node.disconnect(); try { analyser.sourceNode?.disconnect(analyser.node); } catch { /* already gone */ }
      this.analysers.delete(key);
    }
  }

  // External FFT input (manual p. 151): an audio input device, analysed only.
  async setExternalAudioInput(deviceId) {
    this._ensureAudio();
    this.externalStream?.getTracks().forEach(track => track.stop());
    this.externalSource?.disconnect();
    this.externalStream = this.externalSource = null;
    if (deviceId === null || deviceId === undefined || !this._audioContext) return false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return false; }
    this.externalStream = stream;
    this.externalSource = this._audioContext.createMediaStreamSource(stream);
    return true;
  }

  getStats() {
    let dropped = 0;
    for (const entry of this.media.values()) if (entry.kind === 'video') dropped += entry.element.getVideoPlaybackQuality?.().droppedVideoFrames || 0;
    const audio = this._readMeter(this.masterMeter);
    const layerAudio = Object.fromEntries([...this.audioLayers].map(([id, bus]) => [id, this._readMeter(bus.meter)]));
    return { ...this.stats, droppedFrames: dropped, mediaCount: this.media.size, contextLost: this.lost,
      audioState: this._audioContext?.state || 'idle', audio, audioPeak: Math.max(...audio.peak), audioRms: Math.max(...audio.rms), layerAudio, mediaCacheLimit: this.maxMedia };
  }

  // RGBA rows (bottom-up) of a region of the visible output, for DMX fixture
  // sampling. The buffer is reused between calls; copy it to keep it.
  readRegion(x, y, width, height) {
    if (this.disposed || this.lost || !this.lastFinished) return null;
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    width = Math.min(this.canvas.width - x, Math.ceil(width)); height = Math.min(this.canvas.height - y, Math.ceil(height));
    if (width <= 0 || height <= 0) return null;
    const size = width*height*4;
    if (!this.readBuffer || this.readBuffer.length !== size) this.readBuffer = new Uint8Array(size);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, this.canvas.height-y-height, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.readBuffer);
    return this.readBuffer;
  }

  async capturePNG({ transparent = false } = {}) {
    if (this.disposed || this.lost || !this.lastFinished) throw new Error('Wait for a rendered frame before taking a snapshot.');
    const width = this.canvas.width, height = this.canvas.height;
    if (width * height > 16_777_216) throw new Error('Snapshot exceeds the current 16 megapixel limit.');
    const gl = this.gl, previous = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const pixels = new Uint8Array(width * height * 4);
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, transparent ? this.lastFinished.framebuffer : null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Could not read the rendered snapshot.');
    } finally { gl.bindFramebuffer(gl.FRAMEBUFFER, previous); }
    const rgba = new Uint8ClampedArray(pixels.length), stride = width * 4;
    for (let y = 0; y < height; y++) for (let x = 0; x < stride; x += 4) {
      const source = (height - 1 - y) * stride + x, destination = y * stride + x, alpha = transparent ? pixels[source + 3] : 255;
      rgba[destination + 3] = alpha;
      for (let channel = 0; channel < 3; channel++) rgba[destination + channel] = transparent && alpha > 0
        ? Math.min(255, Math.round(pixels[source + channel] * 255 / alpha)) : pixels[source + channel];
    }
    const image = document.createElement('canvas');image.width = width;image.height = height;
    const context = image.getContext('2d');
    if (!context) throw new Error('PNG encoding is unavailable.');
    context.putImageData(new ImageData(rgba, width, height), 0, 0);
    const blob = await new Promise(resolve => image.toBlob(resolve, 'image/png'));
    image.width = image.height = 0;
    if (!blob) throw new Error('PNG encoding failed.');
    return blob;
  }

  recordingStream(frameRate = 60) {
    if (this.disposed) throw new Error('The engine has been disposed.');
    this._ensureAudio();
    const stream = this.canvas.captureStream(clamp(frameRate, 1, 60));
    if (this.audioDestination) for (const track of this.audioDestination.stream.getAudioTracks()) stream.addTrack(track.clone());
    this.streams.add(stream);
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.streams.delete(stream), { once: true });
    this._audioContext?.resume().catch(() => {});
    return stream;
  }

  remove(clipId) {
    // A source can have audio/mask resources without a primary media element.
    for (const child of [...this.media.values()]) if (child.id === clipId || child.ownerId === clipId || child.cacheGroup === clipId) this._removeMedia(child.id);
  }

  _removeMedia(clipId) {
    const entry = this.media.get(clipId);
    if (!entry) return;
    this.media.delete(clipId);
    entry.cancel?.();
    entry.stream?.getTracks().forEach(track => track.stop());
    entry.fxChain?.dispose();
    if (entry.live) entry.element.srcObject = null;
    entry.gifController?.abort();
    entry.animation?.close();
    entry.element.removeEventListener('error', entry.onError);
    if (entry.videoCallback !== undefined) entry.element.cancelVideoFrameCallback?.(entry.videoCallback);
    if (entry.kind !== 'image') {
      entry.element.pause();
      entry.element.removeAttribute('src');
      entry.element.load();
    } else entry.element.removeAttribute('src');
    entry.audioNode?.disconnect();
    entry.gainNode?.disconnect();
    entry.panNode?.disconnect();
    if (entry.texture && !this.lost) this.gl.deleteTexture(entry.texture);
    for (const key of [...this.errors]) if (key.endsWith(`-${clipId}`)) this.errors.delete(key);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const clipId of [...this.media.keys()]) this.remove(clipId);
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    this.streams.clear();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    if (!this.lost) {
      const gl = this.gl;
      for (const target of this.targets) { gl.deleteTexture(target.texture); gl.deleteFramebuffer(target.framebuffer); }
      for (const program of this.programs) gl.deleteProgram(program);
      gl.deleteTexture(this.blankTexture);
      gl.deleteVertexArray(this.vao);
    }
    this.masterGain?.disconnect();
    this.masterPanner?.disconnect();
    this.limiter?.disconnect();
    this._disposeMeter(this.masterMeter);
    this.masterMeter = null;
    for (const bus of this.audioLayers.values()) { bus.panner.disconnect(); bus.fxChain?.dispose(); this._disposeMeter(bus.meter); }
    for (const bus of this.audioGroups.values()) { bus.gain.disconnect(); bus.panner.disconnect(); bus.fxChain?.dispose(); }
    this.audioGroups.clear();
    this.masterFx?.fxChain?.dispose();
    this.externalStream?.getTracks().forEach(track => track.stop());
    for (const source of this.canvasSources.values()) source.instance?.dispose?.();
    this.audioLayers.clear();
    this._audioContext?.close().catch(() => {});
    this.targets = [];
    this.programs = [];
  }
}
