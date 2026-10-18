// Parameter animation (manual pp. 141–145): Timeline, BPM Sync, Clip Position,
// Audio Analysis (FFT) and Dashboard links, each shaped by an optional envelope.
// Animations live beside the value they drive (`owner.animations[key]`) so they
// survive copy/paste and saving. Runtime phase state is kept out of the project.

export const ANIMATION_MODES = Object.freeze(['timeline', 'bpm', 'clip', 'fft', 'dashboard']);
export const ANIMATION_LOOPS = Object.freeze(['loop', 'pingpong', 'once', 'random']);
export const ANIMATION_SHAPES = Object.freeze(['ramp', 'sine', 'triangle', 'square', 'random', 'envelope']);
export const FFT_SOURCES = Object.freeze(['composition', 'group', 'layer', 'clip', 'external']);
export const FFT_RESPONSES = Object.freeze(['up', 'down', 'speed+', 'speed-']);
// BPM Sync speeds stay on the beat grid (manual p. 60): powers of two only.
export const BPM_SPEEDS = Object.freeze([0, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16]);
// Spectra are log-frequency (20 Hz–20 kHz), so 0.3 ≈ 160 Hz and 0.7 ≈ 2.5 kHz.
export const FFT_BANDS = Object.freeze({ low: [0, 0.3], mid: [0.3, 0.7], high: [0.7, 1] });
const VALUE_TYPES = ['float', 'int', 'bool', 'choice'];
const MAX_POINTS = 64;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const number = (value, fallback, min, max) => finite(value) ? clamp(value, min, max) : fallback;
const choice = (value, values, fallback) => values.includes(value) ? value : fallback;
const fract = value => value - Math.floor(value);

function hash(step, seed) {
  let value = (Math.imul(step | 0, 0x9e3779b1) ^ seed) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function envelope(points) {
  const list = (Array.isArray(points) ? points : []).filter(point => Array.isArray(point) && point.length === 2 && point.every(finite))
    .slice(0, MAX_POINTS).map(([x, y]) => [clamp(x), clamp(y)]).sort((a, b) => a[0] - b[0]);
  return list.length >= 2 ? list : [[0, 0], [1, 1]];
}

// `param` supplies the controlled value's type and default range.
export function createAnimation(mode = 'timeline', param = {}) {
  const valueType = choice(param.type, VALUE_TYPES, 'float');
  const min = finite(param.min) ? param.min : 0, max = finite(param.max) ? param.max : 1;
  return normalizeAnimation({ mode, valueType, count: param.options?.length, min, max }, param);
}

export function normalizeAnimation(input, param = {}) {
  if (!input || typeof input !== 'object' || !ANIMATION_MODES.includes(input.mode)) return null;
  const valueType = choice(input.valueType, VALUE_TYPES, choice(param.type, VALUE_TYPES, 'float'));
  const low = finite(param.min) ? param.min : -65536, high = finite(param.max) ? param.max : 65536;
  const fft = input.fft && typeof input.fft === 'object' ? input.fft : {};
  return {
    mode: input.mode, valueType, count: Math.round(number(input.count, param.options?.length || 2, 1, 256)),
    min: number(input.min, finite(param.min) ? param.min : 0, low, high), max: number(input.max, finite(param.max) ? param.max : 1, low, high),
    duration: number(input.duration, 4, 0.01, 86400), beats: number(input.beats, 4, 0.03125, 4096),
    speed: number(input.speed, 1, 0, 16), direction: choice(input.direction, [-1, 0, 1], 1),
    loop: choice(input.loop, ANIMATION_LOOPS, 'pingpong'), shape: choice(input.shape, ANIMATION_SHAPES, 'ramp'),
    inPoint: number(input.inPoint, 0, 0, 0.999), outPoint: number(input.outPoint, 1, 0.001, 1), phase: number(input.phase, 0, 0, 1),
    points: envelope(input.points), stepped: valueType === 'bool' || valueType === 'choice' ? input.stepped !== false : !!input.stepped,
    dial: Math.round(number(input.dial, 0, 0, 7)), invert: !!input.invert,
    fft: { source: choice(fft.source, FFT_SOURCES, 'composition'), lo: number(fft.lo, 0, 0, 1), hi: number(fft.hi, FFT_BANDS.low[1], 0, 1),
      gain: number(fft.gain, 1, 0, 16), fall: number(fft.fall, 0.5, 0, 1), response: choice(fft.response, FFT_RESPONSES, 'up') },
  };
}

export function normalizeAnimations(input, paramFor = () => ({})) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result = {};
  for (const [key, value] of Object.entries(input).slice(0, 128)) {
    if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const animation = normalizeAnimation(value, paramFor(key) || {});
    if (animation) result[key] = animation;
  }
  return result;
}

export function shapeValue(animation, phase, cycle = 0) {
  const p = clamp(phase);
  switch (animation.shape) {
    case 'sine': return 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
    case 'triangle': return 1 - Math.abs(p * 2 - 1);
    case 'square': return p < 0.5 ? 0 : 1;
    case 'random': return hash(cycle * 64 + Math.floor(p * 16), 0x51ed27);
    case 'envelope': {
      const points = animation.points;
      if (p <= points[0][0]) return points[0][1];
      for (let i = 1; i < points.length; i++) {
        const [x1, y1] = points[i];
        if (p <= x1) {
          const [x0, y0] = points[i - 1];
          return animation.stepped || x1 - x0 < 1e-9 ? y0 : y0 + (y1 - y0) * (p - x0) / (x1 - x0);
        }
      }
      return points.at(-1)[1];
    }
    default: return p;
  }
}

// Fold an unbounded travel value into the in/out window per the loop mode.
export function foldPhase(animation, travel) {
  const lo = Math.min(animation.inPoint, animation.outPoint - 0.001), hi = Math.max(animation.outPoint, lo + 0.001), span = hi - lo;
  const cycle = Math.floor(travel);
  if (animation.loop === 'once') return { phase: lo + span * clamp(travel), cycle: 0 };
  if (animation.loop === 'pingpong') {
    const t = fract(travel / 2) * 2;
    return { phase: lo + span * (t <= 1 ? t : 2 - t), cycle: Math.floor(travel / 2) };
  }
  if (animation.loop === 'random') return { phase: lo + span * hash(cycle, 0x2545f491), cycle };
  return { phase: lo + span * fract(travel), cycle };
}

export function outputValue(animation, normalized) {
  const value = clamp(animation.invert ? 1 - normalized : normalized);
  if (animation.valueType === 'bool') return value >= 0.5;
  if (animation.valueType === 'choice') return Math.min(animation.count - 1, Math.floor(value * animation.count));
  const result = animation.min + (animation.max - animation.min) * value;
  return animation.valueType === 'int' ? Math.round(result) : result;
}

export function bandLevel(spectrum, lo, hi) {
  if (!spectrum?.length) return 0;
  const start = Math.min(spectrum.length - 1, Math.floor(Math.min(lo, hi) * spectrum.length));
  const end = Math.max(start + 1, Math.ceil(Math.max(lo, hi) * spectrum.length));
  let sum = 0;
  for (let i = start; i < end && i < spectrum.length; i++) sum += spectrum[i];
  return sum / Math.max(1, Math.min(end, spectrum.length) - start);
}

// Evaluates animations once per frame. `context` supplies time (s), dt (s),
// beat, clip positions, dashboard dial values and spectra for FFT sources.
export class Animator {
  constructor() { this.states = new WeakMap(); }

  _state(animation) {
    let state = this.states.get(animation);
    if (!state) { state = { travel: animation.phase || 0, level: 0, beatOrigin: null }; this.states.set(animation, state); }
    return state;
  }

  reset(animation) { this.states.delete(animation); }

  // Last evaluated position within the in/out window (0..1) for playheads,
  // and the smoothed audio level for FFT meters.
  phase(animation) { return this.states.get(animation)?.phase ?? 0; }
  level(animation) { return this.states.get(animation)?.level ?? 0; }

  evaluate(animation, context = {}) {
    const state = this._state(animation), dt = clamp(finite(context.dt) ? context.dt : 0, 0, 1);
    const direction = animation.direction, rate = animation.speed * direction;
    let normalized;
    if (animation.mode === 'dashboard') {
      normalized = clamp(context.dial?.(animation.dial) ?? 0);
      state.phase = normalized;
    } else if (animation.mode === 'clip') {
      state.phase = clamp(finite(context.clipPosition) ? context.clipPosition : 0);
      normalized = shapeValue(animation, state.phase);
    } else if (animation.mode === 'fft') {
      const spectrum = context.spectrum?.(animation.fft.source) || null;
      const level = clamp(bandLevel(spectrum, animation.fft.lo, animation.fft.hi) * animation.fft.gain);
      // Fall: 0 = instant release, 1 = slowest decay, framerate independent.
      const release = animation.fft.fall <= 0 ? 1 : 1 - Math.pow(0.0005, dt * (1.05 - animation.fft.fall) * 2);
      state.level = level >= state.level ? level : state.level + (level - state.level) * release;
      if (animation.fft.response === 'up' || animation.fft.response === 'down') {
        normalized = animation.fft.response === 'up' ? state.level : 1 - state.level;
        state.phase = normalized;
      } else {
        state.travel += dt * state.level * 2 * (animation.fft.response === 'speed-' ? -1 : 1) / Math.max(0.01, animation.duration / 4);
        const folded = foldPhase(animation, state.travel);
        state.phase = folded.phase;
        normalized = shapeValue(animation, folded.phase, folded.cycle);
      }
    } else {
      let travel;
      if (animation.mode === 'bpm' && finite(context.beat)) {
        // Lock to the composition beat grid so animations land on the downbeat;
        // speed/direction changes re-anchor without a jump.
        const beatRate = rate / animation.beats;
        if (state.beatOrigin === null || state.rate !== beatRate) {
          state.beatOrigin = { beat: context.beat, travel: state.travel }; state.rate = beatRate;
        }
        travel = state.beatOrigin.travel + (context.beat - state.beatOrigin.beat) * beatRate;
        state.travel = travel;
      } else {
        state.travel += dt * rate / animation.duration;
        travel = state.travel;
      }
      if (animation.loop === 'once') state.travel = travel = direction < 0 ? clamp(travel, -1, 0) : clamp(travel, 0, 1);
      const folded = foldPhase(animation, direction < 0 && animation.loop !== 'pingpong' ? 1 + travel : travel);
      state.phase = folded.phase;
      normalized = shapeValue(animation, folded.phase, folded.cycle);
    }
    return outputValue(animation, normalized);
  }
}
