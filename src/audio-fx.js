// Web Audio effect catalog for clips, layers and the composition. Every effect
// is a native node graph (no AudioWorklet/ScriptProcessor: the CSP forbids
// worklet modules from blob URLs) wrapped with a parallel Dry/Wet mix:
//   input -> [latency comp] -> dry(1 - mix) ----> output
//   input -> [effect graph] -> wet(mix) ---------> output
// Definitions use the same param shape as video effects (see fx/shader-template.js).
import { normalizeParams, defaultParams } from './fx/shader-template.js';

export { defaultParams };

const SMOOTH = 0.012; // setTargetAtTime time constant (s)
const MAX_DELAY = 4; // s
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const dbToGain = db => Math.pow(10, db / 20);

// Beat divisions in quarter-note beats, shared by delays and LFO sync.
export const DIVISIONS = Object.freeze([
  ['1/64', 1 / 16], ['1/32', 1 / 8], ['1/16T', 1 / 6], ['1/16', 1 / 4], ['1/8T', 1 / 3], ['1/16D', 3 / 8],
  ['1/8', 1 / 2], ['1/4T', 2 / 3], ['1/8D', 3 / 4], ['1/4', 1], ['1/2T', 4 / 3], ['1/4D', 3 / 2], ['1/2', 2],
  ['1 Bar', 4], ['2 Bars', 8], ['4 Bars', 16], ['8 Bars', 32],
].map(entry => Object.freeze(entry)));
const DIVISION_LABELS = DIVISIONS.map(([label]) => label);
const division = label => DIVISION_LABELS.indexOf(label);

const safeBpm = bpm => clamp(Number(bpm) || 120, 20, 999);
// Duration in seconds of DIVISIONS[divisionIndex] at `bpm`.
export function syncSeconds(bpm, divisionIndex) {
  return 60 / safeBpm(bpm) * DIVISIONS[clamp(Math.round(divisionIndex), 0, DIVISIONS.length - 1)][1];
}
const lfoRate = (p, bpm) => clamp(p.sync ? 1 / syncSeconds(bpm, p.division) : p.rate, 0.01, 40);
const delaySeconds = (p, bpm) => clamp(p.sync ? syncSeconds(bpm, p.division) : p.time / 1000, 0.001, MAX_DELAY - 0.01);

// ---- param helpers -------------------------------------------------------------
const f = (key, label, min, max, def, unit, extra) => ({ key, label, type: 'float', min, max, default: def, ...(unit ? { unit } : {}), ...extra });
const int = (key, label, min, max, def, unit) => ({ key, label, type: 'int', min, max, default: def, ...(unit ? { unit } : {}) });
const bool = (key, label, def = false) => ({ key, label, type: 'bool', default: def });
const choice = (key, label, options, def = 0) => ({ key, label, type: 'choice', options, default: def });
const mix = (def = 1) => f('dryWet', 'Dry/Wet', 0, 1, def);
const freq = (def, label = 'Frequency') => f('frequency', label, 20, 20000, def, 'Hz', { scale: 'log' });
const SHAPES = ['Sine', 'Triangle', 'Square', 'Sawtooth'];
const OSC_TYPES = ['sine', 'triangle', 'square', 'sawtooth'];
const syncParams = (rate, div) => [f('rate', 'Rate', 0.01, 20, rate, 'Hz', { scale: 'log' }), bool('sync', 'BPM Sync'), choice('division', 'Division', DIVISION_LABELS, division(div))];
const delayParams = (time, div) => [f('time', 'Time', 1, 2000, time, 'ms'), f('feedback', 'Feedback', 0, 0.95, 0.35), bool('sync', 'BPM Sync'), choice('division', 'Division', DIVISION_LABELS, division(div))];

// ---- cached curves & impulses -----------------------------------------------------
const SOFT_CLIP = (() => {
  const curve = new Float32Array(4096), norm = Math.tanh(3);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(3 * (i / (curve.length - 1) * 2 - 1)) / norm;
  return curve;
})();
const stairCurves = new Map();
function stairCurve(bits) {
  if (!stairCurves.has(bits)) {
    const curve = new Float32Array(65536), levels = Math.pow(2, bits - 1);
    for (let i = 0; i < curve.length; i++) curve[i] = clamp(Math.round((i / (curve.length - 1) * 2 - 1) * levels) / levels, -1, 1);
    stairCurves.set(bits, curve);
  }
  return stairCurves.get(bits);
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Procedural stereo reverb IR: decaying noise whose high end is progressively
// damped, preceded by `preDelay` seconds of silence. LRU-cached by quantized args.
const impulses = new Map();
const IMPULSE_CACHE = 12;
export function reverbImpulse(sampleRate, { size = 2.5, decay = 0.6, preDelay = 0.01, damping = 0.4 } = {}) {
  const q = (value, step) => Math.round(value / step) * step;
  size = q(clamp(size, 0.1, 10), 0.05); decay = q(clamp(decay, 0, 1), 0.01);
  preDelay = q(clamp(preDelay, 0, 0.5), 0.001); damping = q(clamp(damping, 0, 1), 0.01);
  const key = `${sampleRate}|${size}|${decay}|${preDelay}|${damping}`;
  const cached = impulses.get(key);
  if (cached) { impulses.delete(key); impulses.set(key, cached); return cached; }
  const pre = Math.round(preDelay * sampleRate), length = Math.max(1, Math.round(size * sampleRate));
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: pre + length, sampleRate });
  const exponent = 0.5 + (1 - decay) * 7.5;
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel), random = mulberry32(channel ? 0x85ebca6b : 0x9e3779b9);
    let smooth = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length, a = damping * 0.97 * Math.sqrt(t);
      smooth += (1 - a) * (random() * 2 - 1 - smooth);
      data[pre + i] = smooth * Math.pow(1 - t, exponent);
    }
  }
  impulses.set(key, buffer);
  if (impulses.size > IMPULSE_CACHE) impulses.delete(impulses.keys().next().value);
  return buffer;
}

// Chrome's DynamicsCompressor look-ahead (6 ms, floored to samples). The dry path
// is delayed by the same amount so parallel (Dry/Wet) compression doesn't comb.
const compressorLatency = ctx => Math.floor(0.006 * ctx.sampleRate) / ctx.sampleRate;
// Chromium adds one render quantum (128 frames) to every feedback cycle, so loop
// delays are shortened by that much to keep repeats on time.
const loopTime = (ctx, seconds) => Math.max(0, seconds - 128 / ctx.sampleRate);

// ---- builders ------------------------------------------------------------------
// build(ctx, h) -> { input, output, apply(p, bpm), latency? }
// h.node(node) tracks a node for dispose, h.set(audioParam, value) applies a
// smoothed, de-duplicated value, h.lfo() returns a started OscillatorNode.

function filterBuilder(type) {
  return (ctx, h) => {
    const filter = h.node(ctx.createBiquadFilter());
    filter.type = type;
    const resonant = type === 'lowpass' || type === 'highpass';
    return {
      input: filter, output: filter,
      apply(p) {
        h.set(filter.frequency, clamp(p.frequency, 20, Math.min(20000, ctx.sampleRate / 2 - 1)));
        // LP/HP Q is in dB in Web Audio: resonance 0..1 maps Butterworth (-3 dB) .. +24 dB.
        h.set(filter.Q, resonant ? -3 + clamp(p.resonance, 0, 1) * 27 : clamp(p.q, 0.1, 30));
      },
    };
  };
}

function setShape(osc, shape) {
  const type = OSC_TYPES[clamp(Math.round(shape), 0, OSC_TYPES.length - 1)];
  if (osc.type !== type) osc.type = type;
}

const BUILDERS = {
  eq(ctx, h) {
    const low = h.node(ctx.createBiquadFilter()), mid = h.node(ctx.createBiquadFilter()), high = h.node(ctx.createBiquadFilter());
    low.type = 'lowshelf'; low.frequency.value = 250;
    mid.type = 'peaking'; mid.Q.value = 0.8;
    high.type = 'highshelf'; high.frequency.value = 4000;
    low.connect(mid).connect(high);
    return {
      input: low, output: high,
      apply(p) {
        h.set(low.gain, clamp(p.low, -24, 12)); h.set(mid.gain, clamp(p.mid, -24, 12)); h.set(high.gain, clamp(p.high, -24, 12));
        h.set(mid.frequency, clamp(p.midFrequency, 100, 10000));
      },
    };
  },
  lowpass: filterBuilder('lowpass'),
  highpass: filterBuilder('highpass'),
  bandpass: filterBuilder('bandpass'),
  notch: filterBuilder('notch'),

  delay(ctx, h) {
    // out = A[-t] with A = in + fb * A[-t] (loop kept separate from the tap).
    const input = h.node(ctx.createGain()), loop = h.node(ctx.createDelay(MAX_DELAY)), feedback = h.node(ctx.createGain());
    const delay = h.node(ctx.createDelay(MAX_DELAY));
    input.connect(loop).connect(feedback).connect(input);
    input.connect(delay);
    return {
      input, output: delay,
      apply(p, bpm) {
        const time = delaySeconds(p, bpm);
        h.set(delay.delayTime, time); h.set(loop.delayTime, loopTime(ctx, time)); h.set(feedback.gain, clamp(p.feedback, 0, 0.95));
      },
    };
  },
  pingpong(ctx, h) {
    // Echoes alternate L (t, 3t, ...) and R (2t, 4t, ...), losing `feedback` per bounce.
    // Built around a single 2t self-loop A = in + fb^2 * A[-2t]; L = A[-t], R = fb * A[-2t].
    const input = h.node(ctx.createGain());
    input.channelCount = 1; input.channelCountMode = 'explicit';
    const loop = h.node(ctx.createDelay(MAX_DELAY * 2)), loopGain = h.node(ctx.createGain());
    const left = h.node(ctx.createDelay(MAX_DELAY)), right = h.node(ctx.createDelay(MAX_DELAY * 2));
    const rightGain = h.node(ctx.createGain()), merger = h.node(ctx.createChannelMerger(2));
    input.connect(loop).connect(loopGain).connect(input);
    input.connect(left).connect(merger, 0, 0);
    input.connect(right).connect(rightGain).connect(merger, 0, 1);
    return {
      input, output: merger,
      apply(p, bpm) {
        const time = delaySeconds(p, bpm), fb = clamp(p.feedback, 0, 0.95);
        h.set(left.delayTime, time); h.set(right.delayTime, time * 2); h.set(loop.delayTime, loopTime(ctx, time * 2));
        h.set(rightGain.gain, fb); h.set(loopGain.gain, fb * fb);
      },
    };
  },
  reverb(ctx, h) {
    // Two convolvers crossfade when the IR changes so regeneration never clicks.
    const input = h.node(ctx.createGain()), output = h.node(ctx.createGain());
    const convolvers = [h.node(ctx.createConvolver()), h.node(ctx.createConvolver())];
    const gains = [h.node(ctx.createGain()), h.node(ctx.createGain())];
    convolvers.forEach((convolver, i) => { input.connect(convolver).connect(gains[i]).connect(output); gains[i].gain.value = 0; });
    let active = -1, current = null;
    return {
      input, output,
      get impulse() { return current; },
      apply(p) {
        const buffer = reverbImpulse(ctx.sampleRate, { size: p.size, decay: p.decay, preDelay: p.preDelay / 1000, damping: p.damping });
        if (buffer === current) return;
        current = buffer;
        active = active < 0 ? 0 : 1 - active;
        convolvers[active].buffer = buffer;
        gains.forEach((gain, i) => h.set(gain.gain, i === active ? 1 : 0));
      },
    };
  },

  distortion(ctx, h) {
    // Drive pushes the signal into a fixed soft-clip curve (smooth AudioParam,
    // no curve rebuilds while animating), then a tone low pass and level trim.
    const drive = h.node(ctx.createGain()), shaper = h.node(ctx.createWaveShaper());
    const tone = h.node(ctx.createBiquadFilter()), level = h.node(ctx.createGain());
    shaper.curve = SOFT_CLIP; shaper.oversample = '4x'; tone.type = 'lowpass';
    drive.connect(shaper).connect(tone).connect(level);
    return {
      input: drive, output: level,
      apply(p) {
        const amount = clamp(p.drive, 0, 1);
        h.set(drive.gain, dbToGain(amount * 36));
        h.set(tone.frequency, Math.min(800 * Math.pow(25, clamp(p.tone, 0, 1)), ctx.sampleRate / 2 - 1));
        h.set(level.gain, dbToGain(clamp(p.output, -24, 12) - amount * 12));
      },
    };
  },
  bitcrusher(ctx, h) {
    // Quantizer: staircase WaveShaper. Rate reduction: exact sample-and-hold built
    // from a looping one-sample pulse train (multiplied in via gain.gain) convolved
    // with a box kernel of the same period (short ConvolverNodes are zero-latency).
    const shaper = h.node(ctx.createWaveShaper()), hold = h.node(ctx.createGain()), box = h.node(ctx.createConvolver());
    shaper.oversample = 'none'; hold.gain.value = 0; box.normalize = false;
    shaper.connect(hold).connect(box);
    let bits = 0, factor = 0, pulse = null;
    return {
      input: shaper, output: box,
      apply(p) {
        const nextBits = clamp(Math.round(p.bits), 1, 16), nextFactor = clamp(Math.round(p.downsample), 1, 64);
        if (nextBits !== bits) { bits = nextBits; shaper.curve = stairCurve(bits); }
        if (nextFactor === factor) return;
        factor = nextFactor;
        if (pulse) { pulse.stop(); pulse.disconnect(); h.forget(pulse); }
        const train = new AudioBuffer({ numberOfChannels: 1, length: factor, sampleRate: ctx.sampleRate });
        const kernel = new AudioBuffer({ numberOfChannels: 1, length: factor, sampleRate: ctx.sampleRate });
        train.getChannelData(0)[0] = 1; kernel.getChannelData(0).fill(1);
        box.buffer = kernel;
        pulse = h.node(ctx.createBufferSource());
        pulse.buffer = train; pulse.loop = true; pulse.connect(hold.gain); pulse.start();
      },
    };
  },

  compressor(ctx, h) {
    const comp = h.node(ctx.createDynamicsCompressor()), makeup = h.node(ctx.createGain());
    comp.connect(makeup);
    return {
      input: comp, output: makeup, latency: compressorLatency(ctx),
      apply(p) {
        h.set(comp.threshold, clamp(p.threshold, -60, 0)); h.set(comp.ratio, clamp(p.ratio, 1, 20)); h.set(comp.knee, clamp(p.knee, 0, 40));
        h.set(comp.attack, clamp(p.attack / 1000, 0, 1)); h.set(comp.release, clamp(p.release / 1000, 0.01, 1));
        h.set(makeup.gain, dbToGain(clamp(p.makeup, 0, 24)));
      },
    };
  },
  limiter(ctx, h) {
    const gain = h.node(ctx.createGain()), comp = h.node(ctx.createDynamicsCompressor());
    comp.knee.value = 0; comp.ratio.value = 20; comp.attack.value = 0.001;
    gain.connect(comp);
    return {
      input: gain, output: comp, latency: compressorLatency(ctx),
      apply(p) {
        h.set(gain.gain, dbToGain(clamp(p.gain, 0, 24))); h.set(comp.threshold, clamp(p.threshold, -30, 0));
        h.set(comp.release, clamp(p.release / 1000, 0.01, 1));
      },
    };
  },

  flanger(ctx, h) {
    // Same tap/loop split as Delay; both delays follow the LFO. (The loop cannot
    // recirculate faster than one render quantum, ~2.7 ms.)
    const input = h.node(ctx.createGain()), delay = h.node(ctx.createDelay(0.05)), loop = h.node(ctx.createDelay(0.05));
    const feedback = h.node(ctx.createGain()), depth = h.node(ctx.createGain()), lfo = h.lfo();
    input.connect(loop).connect(feedback).connect(input);
    input.connect(delay);
    lfo.connect(depth); depth.connect(delay.delayTime); depth.connect(loop.delayTime);
    return {
      input, output: delay,
      apply(p, bpm) {
        const center = clamp(p.delay, 1, 20) / 1000;
        h.set(delay.delayTime, center); h.set(loop.delayTime, loopTime(ctx, center)); h.set(depth.gain, center * clamp(p.depth, 0, 0.95));
        h.set(feedback.gain, clamp(p.feedback, -0.95, 0.95)); h.set(lfo.frequency, lfoRate(p, bpm));
      },
    };
  },
  chorus(ctx, h) {
    // One modulated delay per channel, LFO inverted on the right for stereo spread.
    const splitter = h.node(ctx.createChannelSplitter(2)), merger = h.node(ctx.createChannelMerger(2)), lfo = h.lfo();
    const delays = [h.node(ctx.createDelay(0.1)), h.node(ctx.createDelay(0.1))], depths = [h.node(ctx.createGain()), h.node(ctx.createGain())];
    delays.forEach((delay, i) => { splitter.connect(delay, i); delay.connect(merger, 0, i); lfo.connect(depths[i]).connect(delay.delayTime); });
    return {
      input: splitter, output: merger,
      apply(p, bpm) {
        const center = clamp(p.delay, 5, 40) / 1000, amount = center * 0.5 * clamp(p.depth, 0, 1);
        delays.forEach(delay => h.set(delay.delayTime, center));
        h.set(depths[0].gain, amount); h.set(depths[1].gain, -amount); h.set(lfo.frequency, lfoRate(p, bpm));
      },
    };
  },
  phaser(ctx, h) {
    const input = h.node(ctx.createGain()), output = h.node(ctx.createGain()), lfo = h.lfo(), depth = h.node(ctx.createGain());
    const feedback = h.node(ctx.createGain()), loop = h.node(ctx.createDelay(0.01));
    lfo.connect(depth);
    const stages = Array.from({ length: 8 }, () => {
      const stage = h.node(ctx.createBiquadFilter());
      stage.type = 'allpass'; stage.Q.value = 0.7; depth.connect(stage.frequency);
      return stage;
    });
    input.connect(stages[0]); feedback.connect(loop).connect(stages[0]);
    let count = 0;
    return {
      input, output,
      apply(p, bpm) {
        const next = clamp(Math.round(p.stages), 4, 8);
        if (next !== count) {
          stages.forEach(stage => stage.disconnect());
          for (let i = 0; i < next - 1; i++) stages[i].connect(stages[i + 1]);
          stages[next - 1].connect(output); stages[next - 1].connect(feedback);
          count = next;
        }
        const center = clamp(p.frequency, 100, 8000);
        stages.forEach(stage => h.set(stage.frequency, center));
        h.set(depth.gain, center * 0.9 * clamp(p.depth, 0, 1)); h.set(feedback.gain, clamp(p.feedback, 0, 0.9));
        h.set(lfo.frequency, lfoRate(p, bpm));
      },
    };
  },
  tremolo(ctx, h) {
    const vca = h.node(ctx.createGain()), depth = h.node(ctx.createGain()), lfo = h.lfo();
    lfo.connect(depth).connect(vca.gain);
    return {
      input: vca, output: vca,
      apply(p, bpm) {
        const amount = clamp(p.depth, 0, 1);
        setShape(lfo, p.shape);
        h.set(vca.gain, 1 - amount / 2); h.set(depth.gain, amount / 2); h.set(lfo.frequency, lfoRate(p, bpm));
      },
    };
  },
  autopan(ctx, h) {
    const panner = h.node(ctx.createStereoPanner()), depth = h.node(ctx.createGain()), lfo = h.lfo();
    lfo.connect(depth).connect(panner.pan);
    return {
      input: panner, output: panner,
      apply(p, bpm) { setShape(lfo, p.shape); h.set(depth.gain, clamp(p.depth, 0, 1)); h.set(lfo.frequency, lfoRate(p, bpm)); },
    };
  },
  width(ctx, h) {
    // M = (L + R) / 2, S = (L - R) / 2 * width; L' = M + S, R' = M - S.
    const splitter = h.node(ctx.createChannelSplitter(2)), merger = h.node(ctx.createChannelMerger(2));
    const mid = h.node(ctx.createGain()), side = h.node(ctx.createGain()), invert = h.node(ctx.createGain());
    const gain = value => { const node = h.node(ctx.createGain()); node.gain.value = value; return node; };
    splitter.connect(gain(0.5), 0).connect(mid); splitter.connect(gain(0.5), 1).connect(mid);
    splitter.connect(gain(0.5), 0).connect(side); splitter.connect(gain(-0.5), 1).connect(side);
    invert.gain.value = -1;
    mid.connect(merger, 0, 0); mid.connect(merger, 0, 1);
    side.connect(merger, 0, 0); side.connect(invert).connect(merger, 0, 1);
    return { input: splitter, output: merger, apply(p) { h.set(side.gain, clamp(p.width, 0, 2)); } };
  },
  gain(ctx, h) {
    const gain = h.node(ctx.createGain());
    return { input: gain, output: gain, apply(p) { h.set(gain.gain, dbToGain(clamp(p.gain, -60, 24)) * (p.invert ? -1 : 1)); } };
  },
};

// ---- catalog -------------------------------------------------------------------
const def = (id, name, category, params) => Object.freeze({ id, name, category, params: Object.freeze(params.map(param => Object.freeze(param))) });

export const AUDIO_EFFECTS = Object.freeze([
  def('eq', 'EQ', 'Filter', [f('low', 'Low', -24, 12, 0, 'dB'), f('mid', 'Mid', -24, 12, 0, 'dB'), f('midFrequency', 'Mid Frequency', 100, 10000, 1000, 'Hz', { scale: 'log' }), f('high', 'High', -24, 12, 0, 'dB'), mix()]),
  def('lowpass', 'Low Pass', 'Filter', [freq(2000, 'Cutoff'), f('resonance', 'Resonance', 0, 1, 0), mix()]),
  def('highpass', 'High Pass', 'Filter', [freq(200, 'Cutoff'), f('resonance', 'Resonance', 0, 1, 0), mix()]),
  def('bandpass', 'Band Pass', 'Filter', [freq(1000), f('q', 'Q', 0.1, 30, 1), mix()]),
  def('notch', 'Notch', 'Filter', [freq(1000), f('q', 'Q', 0.1, 30, 2), mix()]),
  def('delay', 'Delay', 'Delay & Reverb', [...delayParams(375, '1/8D'), mix(0.5)]),
  def('pingpong', 'Ping Pong Delay', 'Delay & Reverb', [...delayParams(250, '1/8'), mix(0.5)]),
  def('reverb', 'Reverb', 'Delay & Reverb', [f('size', 'Size', 0.1, 10, 2.5, 's'), f('decay', 'Decay', 0, 1, 0.6), f('preDelay', 'Pre-Delay', 0, 250, 10, 'ms'), f('damping', 'Damping', 0, 1, 0.4), mix(0.35)]),
  def('distortion', 'Distortion', 'Distortion', [f('drive', 'Drive', 0, 1, 0.5), f('tone', 'Tone', 0, 1, 0.7), f('output', 'Output', -24, 12, 0, 'dB'), mix()]),
  def('bitcrusher', 'Bit Crusher', 'Distortion', [int('bits', 'Bit Depth', 1, 16, 8, 'bits'), int('downsample', 'Downsample', 1, 64, 4, 'x'), mix()]),
  def('compressor', 'Compressor', 'Dynamics', [f('threshold', 'Threshold', -60, 0, -24, 'dB'), f('ratio', 'Ratio', 1, 20, 4, ':1'), f('knee', 'Knee', 0, 40, 6, 'dB'), f('attack', 'Attack', 0, 1000, 10, 'ms'), f('release', 'Release', 10, 1000, 250, 'ms'), f('makeup', 'Makeup', 0, 24, 0, 'dB'), mix()]),
  def('limiter', 'Limiter', 'Dynamics', [f('gain', 'Input Gain', 0, 24, 0, 'dB'), f('threshold', 'Threshold', -30, 0, -1, 'dB'), f('release', 'Release', 10, 1000, 100, 'ms'), mix()]),
  def('flanger', 'Flanger', 'Modulation', [...syncParams(0.25, '1 Bar'), f('depth', 'Depth', 0, 0.95, 0.7), f('delay', 'Delay', 1, 20, 6, 'ms'), f('feedback', 'Feedback', -0.95, 0.95, 0.5), mix(0.5)]),
  def('chorus', 'Chorus', 'Modulation', [...syncParams(0.8, '1/2'), f('depth', 'Depth', 0, 1, 0.4), f('delay', 'Delay', 5, 40, 18, 'ms'), mix(0.5)]),
  def('phaser', 'Phaser', 'Modulation', [...syncParams(0.5, '1 Bar'), f('depth', 'Depth', 0, 1, 0.7), f('frequency', 'Frequency', 100, 8000, 800, 'Hz', { scale: 'log' }), f('feedback', 'Feedback', 0, 0.9, 0.4), int('stages', 'Stages', 4, 8, 6), mix(0.5)]),
  def('tremolo', 'Tremolo', 'Modulation', [...syncParams(4, '1/8'), f('depth', 'Depth', 0, 1, 0.6), choice('shape', 'Shape', SHAPES), mix()]),
  def('autopan', 'Auto Pan', 'Modulation', [...syncParams(0.5, '1/2'), f('depth', 'Depth', 0, 1, 0.8), choice('shape', 'Shape', SHAPES), mix()]),
  def('width', 'Stereo Width', 'Utility', [f('width', 'Width', 0, 2, 1), mix()]),
  def('gain', 'Gain', 'Utility', [f('gain', 'Gain', -60, 24, 0, 'dB'), bool('invert', 'Invert Phase'), mix()]),
]);

const BY_ID = new Map(AUDIO_EFFECTS.map(effect => [effect.id, effect]));
export const audioEffectDefinition = id => BY_ID.get(id) || null;

// ---- effect instance -------------------------------------------------------------
export function createAudioEffect(context, id, params, { bpm = 120 } = {}) {
  const definition = BY_ID.get(id);
  if (!definition) throw new Error(`Unknown audio effect: ${id}`);
  const nodes = new Set(), sources = new Set(), cache = new Map();
  let instant = true;
  const h = {
    node(node) { nodes.add(node); if (typeof node.start === 'function') sources.add(node); return node; },
    forget(node) { nodes.delete(node); sources.delete(node); },
    set(param, value) {
      if (!Number.isFinite(value) || cache.get(param) === value) return;
      cache.set(param, value);
      const v = clamp(value, param.minValue, param.maxValue);
      if (instant) param.value = v;
      else param.setTargetAtTime(v, context.currentTime, SMOOTH);
    },
    lfo() { const osc = h.node(context.createOscillator()); osc.frequency.value = 1; osc.start(); return osc; },
  };
  const input = h.node(context.createGain()), output = h.node(context.createGain());
  input.channelCount = 2; input.channelCountMode = 'explicit'; input.channelInterpretation = 'speakers';
  const dry = h.node(context.createGain()), wet = h.node(context.createGain());
  const graph = BUILDERS[id](context, h);
  const latency = graph.latency || 0;
  if (latency > 0) {
    const compensation = h.node(context.createDelay(Math.max(0.05, latency * 2)));
    compensation.delayTime.value = latency;
    input.connect(compensation).connect(dry);
  } else input.connect(dry);
  dry.connect(output);
  input.connect(graph.input);
  graph.output.connect(wet).connect(output);

  const usesBpm = definition.params.some(param => param.key === 'sync');
  let last = null, lastBpm = safeBpm(bpm), disposed = false;
  // Cheap and idempotent: unchanged values (and unchanged BPM while synced) are skipped.
  function update(values, options = {}) {
    if (disposed) return;
    const p = normalizeParams(definition, values), nextBpm = safeBpm(options.bpm ?? lastBpm);
    if (last && (!usesBpm || !p.sync || nextBpm === lastBpm) && definition.params.every(param => p[param.key] === last[param.key])) return;
    last = p; lastBpm = nextBpm;
    const amount = clamp(p.dryWet, 0, 1);
    h.set(dry.gain, 1 - amount); h.set(wet.gain, amount);
    graph.apply(p, nextBpm);
  }
  update(params, { bpm });
  instant = false;

  return {
    id, definition, input, output, latency, update, graph,
    get params() { return last; },
    get disposed() { return disposed; },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const source of sources) try { source.stop(); } catch { /* never started */ }
      for (const node of nodes) node.disconnect();
      nodes.clear(); sources.clear(); cache.clear();
    },
  };
}

// ---- chain -----------------------------------------------------------------------
// Keeps a live chain in sync with stored effect instances [{ id, type, enabled, params }].
// Unchanged instances keep their nodes (disabled ones are kept but unwired), and
// only the connections that actually change are made or broken.
export class AudioEffectChain {
  constructor(context) {
    this.context = context;
    this._input = context.createGain();
    this._output = context.createGain();
    this._entries = new Map(); // instance id -> { type, effect }
    this._edges = [];
    this._order = [];
    this._rewire([]);
  }
  get input() { return this._input; }
  get output() { return this._output; }
  // Inspection hooks (used by tests and UI meters).
  getEffect(id) { return this._entries.get(id)?.effect; }
  get activeIds() { return [...this._order]; }

  sync(effects, { bpm = 120 } = {}) {
    const seen = new Set(), active = [];
    for (const item of Array.isArray(effects) ? effects : []) {
      if (!item || item.id == null || seen.has(item.id) || !BY_ID.has(item.type)) continue;
      seen.add(item.id);
      let entry = this._entries.get(item.id);
      if (entry && entry.type !== item.type) { entry.effect.dispose(); this._entries.delete(item.id); entry = null; }
      if (item.enabled === false) continue;
      if (entry) entry.effect.update(item.params, { bpm });
      else this._entries.set(item.id, entry = { type: item.type, effect: createAudioEffect(this.context, item.type, item.params, { bpm }) });
      active.push(item.id);
    }
    const inputs = active.map(id => this._entries.get(id).effect.input);
    if (inputs.length !== this._order.length || inputs.some((node, i) => this._edges[i][1] !== node)) this._rewire(active);
    for (const [id, entry] of [...this._entries]) if (!seen.has(id)) { this._entries.delete(id); entry.effect.dispose(); }
  }

  // Connect new edges before breaking old ones so the signal is never fully cut.
  _rewire(ids) {
    const nodes = [this._input, ...ids.flatMap(id => { const { effect } = this._entries.get(id); return [effect.input, effect.output]; }), this._output];
    const edges = [];
    for (let i = 0; i < nodes.length; i += 2) edges.push([nodes[i], nodes[i + 1]]);
    const has = (list, [a, b]) => list.some(([x, y]) => x === a && y === b);
    for (const edge of edges) if (!has(this._edges, edge)) edge[0].connect(edge[1]);
    for (const edge of this._edges) if (!has(edges, edge)) try { edge[0].disconnect(edge[1]); } catch { /* already disconnected */ }
    this._edges = edges;
    this._order = [...ids];
  }

  dispose() {
    for (const { effect } of this._entries.values()) effect.dispose();
    this._entries.clear();
    this._input.disconnect(); this._output.disconnect();
    this._edges = []; this._order = [];
  }
}
