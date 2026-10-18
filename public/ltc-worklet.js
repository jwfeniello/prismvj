// SMPTE 12M linear timecode (LTC) decoder for the Web Audio graph.
// The decoder core is a plain class so it can be tested in Node:
//   import { PrismLTCDecoder } from '../public/ltc-worklet.js'
// The AudioWorkletProcessor is registered only inside AudioWorkletGlobalScope.
//
// Signal path per sample: DC blocker -> peak envelope -> hysteresis comparator
// -> edge times (sub-sample interpolated) -> biphase-mark bit slicer with an
// adaptive bit period -> 80-bit shift register -> sync word search.

const SYNC_FORWARD = 0x3ffd; // bits 64..79 as received: 0011 1111 1111 1101
const SYNC_REVERSE = 0xbffc; // the same word received backwards
const FPS_CANDIDATES = [23.976, 24, 25, 29.97, 30];

export class PrismLTCDecoder {
  constructor(sampleRate, { onFrame = null, onLoss = null, lossSeconds = 0.2 } = {}) {
    const sr = Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 768000 ? sampleRate : 48000;
    this.sampleRate = sr;
    this.onFrame = onFrame;
    this.onLoss = onLoss;
    this.minBit = sr / 9600; // ~120 fps
    this.maxBit = sr / 400; // ~5 fps
    this.dcCoef = 1 - Math.exp(-2 * Math.PI * 20 / sr);
    this.attack = 1 - Math.exp(-1 / (0.0005 * sr));
    this.release = 1 - Math.exp(-1 / (0.05 * sr));
    this.lossSamples = Math.max(1, Math.round(lossSeconds * sr));
    this.bits = new Uint8Array(80);
    // Reused for every decoded frame; consumers must copy what they keep.
    this.frame = { hours: 0, minutes: 0, seconds: 0, frames: 0, fps: 25, dropFrame: false, colorFrame: false,
      userBits: 0, sampleTime: 0, reverse: false, measuredFps: 0 };
    this.reset();
  }

  reset() {
    this.dc = 0; this.env = 0; this.prev = 0; this.level = 0;
    this.lastEdge = -1; this.period = this.sampleRate / 2160; // between 24 and 30 fps
    this.half = false; this.pos = 0; this.reg = 0; this.filled = 0;
    this.revSince = -1; this.fwdSince = -1; this.lastSync = -1; this.framePeriod = 0; this.measured = 0;
    this.maxFrame = 0; this.longRun = 0; this.shortRun = 0;
    this.lastFrameSample = -Infinity; this.signal = false; this.errors = 0;
  }

  // samples: Float32Array (one channel); startSample: absolute index of samples[0].
  process(samples, startSample = 0) {
    const n = samples ? samples.length | 0 : 0;
    let { dc, env, prev, level } = this;
    const { dcCoef, attack, release } = this;
    for (let i = 0; i < n; i++) {
      let x = samples[i];
      if (!(x > -16 && x < 16)) x = 0; // NaN / Infinity / absurd input
      dc += (x - dc) * dcCoef;
      const y = x - dc;
      const a = y < 0 ? -y : y;
      env += (a - env) * (a > env ? attack : release);
      if (env > 0.001) {
        const thr = env * 0.3;
        if (level <= 0 && y > thr) {
          if (level !== 0) this.edge(startSample + i - 1 + crossing(prev, y, thr));
          level = 1;
        } else if (level >= 0 && y < -thr) {
          if (level !== 0) this.edge(startSample + i - 1 + crossing(prev, y, -thr));
          level = -1;
        }
      }
      prev = y;
    }
    this.dc = dc; this.env = env; this.prev = prev; this.level = level;
    this.checkLoss(startSample + n);
  }

  checkLoss(nowSample) {
    if (this.signal && nowSample - this.lastFrameSample > this.lossSamples) {
      this.signal = false;
      this.maxFrame = 0;
      if (this.onLoss) this.onLoss();
    }
  }

  edge(t) {
    if (this.lastEdge < 0) { this.lastEdge = t; return; }
    const iv = t - this.lastEdge;
    this.lastEdge = t;
    const T = this.period;
    if (iv > 2.5 * T) {
      this.bitError();
      this.shortRun = 0;
      // A run of long intervals that still look like bits means the period is
      // far off (heavy varispeed); re-seed instead of rejecting forever.
      if (iv <= this.maxBit) { if (++this.longRun >= 3) { this.period = iv; this.longRun = 0; } } else this.longRun = 0;
      return;
    }
    if (iv < 0.25 * T) {
      this.bitError();
      this.longRun = 0;
      if (iv * 2 >= this.minBit) { if (++this.shortRun >= 3) { this.period = iv * 2; this.shortRun = 0; } } else this.shortRun = 0;
      return;
    }
    this.longRun = 0; this.shortRun = 0;
    if (iv > 0.75 * T) {
      if (this.half) this.bitError();
      this.adapt(iv);
      this.push(0, t);
    } else {
      this.adapt(iv * 2);
      if (this.half) { this.half = false; this.push(1, t); } else this.half = true;
    }
  }

  adapt(bitLength) {
    let p = this.period + (bitLength - this.period) * 0.08;
    if (p < this.minBit) p = this.minBit; else if (p > this.maxBit) p = this.maxBit;
    this.period = p;
  }

  bitError() {
    this.half = false;
    this.filled = 0;
    this.revSince = -1;
    this.fwdSince = -1;
    this.errors++;
  }

  push(bit, t) {
    this.bits[this.pos] = bit;
    this.pos = this.pos === 79 ? 0 : this.pos + 1;
    this.reg = ((this.reg << 1) | bit) & 0xffff;
    if (this.filled < 1000) this.filled++;
    if (this.fwdSince >= 0) this.fwdSince++;
    if (this.revSince >= 0) this.revSince++;
    if (this.reg === SYNC_FORWARD && this.filled >= 80) {
      if (this.decode(false, t)) {
        if (this.fwdSince === 80 && this.lastSync >= 0) this.measure(t - this.lastSync);
        this.lastSync = t;
      }
      this.fwdSince = 0;
    } else if (this.reg === SYNC_REVERSE) {
      // Backwards, a frame's data precedes its own sync, so require the
      // previous (reversed) sync exactly one frame earlier.
      if (this.revSince === 80 && this.filled >= 80 && this.decode(true, t)) this.lastSync = -1;
      this.revSince = 0;
    }
  }

  // Bit k (0..79, transmission order) of the frame in the ring buffer. In
  // reverse the newest 16 bits are the next frame's sync and bit 0 precedes it.
  bit(k, reverse) {
    return reverse ? this.bits[(this.pos + 143 - k) % 80] : this.bits[(this.pos + k) % 80];
  }

  field(start, length, reverse) {
    let v = 0;
    for (let i = 0; i < length; i++) v |= this.bit(start + i, reverse) << i;
    return v;
  }

  decode(reverse, t) {
    const fu = this.field(0, 4, reverse), su = this.field(16, 4, reverse), st = this.field(24, 3, reverse);
    const mu = this.field(32, 4, reverse), mt = this.field(40, 3, reverse), hu = this.field(48, 4, reverse);
    const frames = fu + 10 * this.field(8, 2, reverse);
    const hours = hu + 10 * this.field(56, 2, reverse);
    if (fu > 9 || su > 9 || st > 5 || mu > 9 || mt > 5 || hu > 9 || hours > 23 || frames > 29) return false;
    let userBits = 0;
    for (let g = 0; g < 8; g++) userBits |= this.field(4 + g * 8, 4, reverse) << (g * 4);
    const dropFrame = this.bit(10, reverse) === 1;
    if (frames > this.maxFrame) this.maxFrame = frames;
    const f = this.frame;
    f.hours = hours; f.minutes = mu + 10 * mt; f.seconds = su + 10 * st; f.frames = frames;
    f.dropFrame = dropFrame; f.colorFrame = this.bit(11, reverse) === 1; f.userBits = userBits >>> 0;
    f.sampleTime = t; f.reverse = reverse;
    f.measuredFps = this.sampleRate / (this.framePeriod || this.period * 80);
    f.fps = this.guessFps(f.measuredFps, dropFrame);
    this.lastFrameSample = t;
    this.signal = true;
    if (this.onFrame) this.onFrame(f);
    return true;
  }

  measure(samplesPerFrame) {
    if (!(samplesPerFrame > this.minBit * 80 && samplesPerFrame < this.maxBit * 80)) return;
    this.framePeriod = this.framePeriod ? this.framePeriod + (samplesPerFrame - this.framePeriod) * 0.1 : samplesPerFrame;
    if (this.measured < 1000) this.measured++;
  }

  // LTC carries no rate field: infer it from the bit rate, constrained by the
  // drop-frame flag and the highest frame number seen. The 0.1% pull-down
  // rates are only told apart once a dozen frame periods have been averaged.
  guessFps(measured, dropFrame) {
    if (dropFrame) return 29.97;
    let best = 30, bestErr = Infinity;
    for (let i = 0; i < FPS_CANDIDATES.length; i++) {
      const c = FPS_CANDIDATES[i];
      if (Math.round(c) <= this.maxFrame || (c % 1 && this.measured < 12)) continue;
      const err = Math.abs(Math.log(measured / c));
      if (err < bestErr) { bestErr = err; best = c; }
    }
    return best;
  }
}

function crossing(prev, y, thr) {
  const d = y - prev;
  if (d === 0) return 1;
  const f = (thr - prev) / d;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

if (typeof AudioWorkletProcessor === 'function' && typeof registerProcessor === 'function') {
  class PrismLTCProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.running = true;
      this.decoder = new PrismLTCDecoder(sampleRate, {
        onFrame: f => this.port.postMessage({ hours: f.hours, minutes: f.minutes, seconds: f.seconds, frames: f.frames,
          fps: f.fps, dropFrame: f.dropFrame, colorFrame: f.colorFrame, userBits: f.userBits, sampleTime: f.sampleTime,
          reverse: f.reverse, measuredFps: f.measuredFps }),
        onLoss: () => this.port.postMessage({ signal: false }),
      });
      this.port.onmessage = event => {
        const type = event.data && event.data.type;
        if (type === 'reset') this.decoder.reset();
        else if (type === 'stop') this.running = false;
      };
    }

    process(inputs) {
      const channel = inputs[0] && inputs[0][0];
      if (channel) this.decoder.process(channel, currentFrame);
      else this.decoder.checkLoss(currentFrame + 128);
      return this.running;
    }
  }
  registerProcessor('prism-ltc', PrismLTCProcessor);
}
