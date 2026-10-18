// SMPTE / LTC timecode input (manual: "SMPTE", Arena only) and timecode math.
// TimecodeInput decodes LTC from any Web Audio source in an AudioWorklet
// (public/ltc-worklet.js) and exposes a smoothly interpolated clock that clips
// in SMPTE transport mode follow via clipTimeFromTimecode().

const EVENTS = ['lock', 'unlock', 'timecode'];
const SYNC_WORD = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]; // bits 64..79
export const SMPTE_FRAME_RATES = Object.freeze([23.976, 24, 25, 29.97, 30]);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const int = (value, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(finite(value))));
const pad = value => String(value).padStart(2, '0');

function nominalRate(fps) {
  const n = Math.round(finite(fps, 25));
  return n >= 1 && n <= 120 ? n : 25;
}

// Drop-frame only exists for the NTSC family (29.97, 59.94).
function dropCapable(fps) { return nominalRate(fps) % 30 === 0; }

// Real frames per second: 29.97 -> 30000/1001, 23.976 -> 24000/1001.
export function frameRate(fps, dropFrame = false) {
  const value = finite(fps, 25), nominal = nominalRate(value);
  if ((dropFrame && dropCapable(value)) || Math.abs(value - nominal * 1000 / 1001) < 0.005) return nominal * 1000 / 1001;
  return value >= 1 && value <= 120 ? value : nominal;
}

function dropCount(fps) { return Math.round(nominalRate(fps) / 15); } // 2 at 29.97, 4 at 59.94

function normalize(timecode = {}) {
  const fps = finite(timecode.fps, 25) > 0 ? finite(timecode.fps, 25) : 25;
  const dropFrame = !!timecode.dropFrame && dropCapable(fps);
  const nominal = nominalRate(fps);
  return { hours: int(timecode.hours, 0, 23), minutes: int(timecode.minutes, 0, 59), seconds: int(timecode.seconds, 0, 59),
    frames: int(timecode.frames, 0, nominal - 1), fps, dropFrame };
}

// Frame count since 00:00:00:00 (drop-frame labels skipped).
export function timecodeToFrames(timecode) {
  const { hours, minutes, seconds, frames, fps, dropFrame } = normalize(timecode);
  const nominal = nominalRate(fps), totalMinutes = hours * 60 + minutes;
  let count = (hours * 3600 + minutes * 60 + seconds) * nominal + frames;
  if (dropFrame) count -= dropCount(fps) * (totalMinutes - Math.floor(totalMinutes / 10));
  return count;
}

export function framesToTimecode(count, fps = 25, dropFrame = false) {
  const nominal = nominalRate(fps), drop = dropFrame && dropCapable(fps);
  const d = dropCount(fps), per10 = nominal * 600 - (drop ? 9 * d : 0);
  const perDay = per10 * 6 * 24;
  let n = Math.floor(finite(count));
  n = ((n % perDay) + perDay) % perDay;
  if (drop) {
    const blocks = Math.floor(n / per10), rest = n % per10;
    n += 9 * d * blocks + (rest > d ? d * Math.floor((rest - d) / (nominal * 60 - d)) : 0);
  }
  return { hours: Math.floor(n / (nominal * 3600)) % 24, minutes: Math.floor(n / (nominal * 60)) % 60,
    seconds: Math.floor(n / nominal) % 60, frames: n % nominal, fps: finite(fps, 25), dropFrame: drop };
}

// Real elapsed seconds at the start of the frame (drop-frame accounts for 29.97).
export function timecodeToSeconds(timecode) {
  const { fps, dropFrame } = normalize(timecode);
  return timecodeToFrames(timecode) / frameRate(fps, dropFrame);
}

export function secondsToTimecode(seconds, fps = 25, dropFrame = false) {
  return framesToTimecode(Math.floor(finite(seconds) * frameRate(fps, dropFrame) + 1e-6), fps, dropFrame);
}

// '01:02:03:04' or '01:02:03;04' (';' = drop-frame). '.' also separates. Frames
// may be omitted. Returns null for malformed or out-of-range input; dropped
// drop-frame labels (e.g. 00:01:00;00) round up to the first valid frame.
export function parseTimecode(text, fps = 25, dropFrame = false) {
  const match = /^\s*(\d{1,2})[:.;](\d{1,2})[:.;](\d{1,2})(?:([:.;])(\d{1,3}))?\s*$/.exec(String(text ?? '').slice(0, 32));
  if (!match) return null;
  let rate = finite(fps, 25) > 0 ? finite(fps, 25) : 25;
  const drop = (match[4] === ';' || !!dropFrame) && dropCapable(rate);
  if (drop && Math.abs(rate - nominalRate(rate)) < 0.005) rate = Math.round(nominalRate(rate) * 100000 / 1001) / 100;
  const [hours, minutes, seconds, frames] = [match[1], match[2], match[3], match[5] ?? '0'].map(Number);
  if (hours > 23 || minutes > 59 || seconds > 59 || frames >= nominalRate(rate)) return null;
  const skipped = drop && seconds === 0 && minutes % 10 !== 0 && frames < dropCount(rate);
  return { hours, minutes, seconds, frames: skipped ? dropCount(rate) : frames, fps: rate, dropFrame: drop };
}

// formatTimecode({hours,...}) or formatTimecode(seconds, fps, dropFrame).
export function formatTimecode(value, fps = 25, dropFrame = false) {
  const tc = typeof value === 'number' ? secondsToTimecode(value, fps, dropFrame) : normalize(value || {});
  return `${pad(tc.hours)}:${pad(tc.minutes)}:${pad(tc.seconds)}${tc.dropFrame ? ';' : ':'}${pad(tc.frames)}`;
}

function toTimecode(value, fps, dropFrame) {
  if (typeof value === 'number') return secondsToTimecode(value, fps, dropFrame);
  if (typeof value === 'string') return parseTimecode(value, fps, dropFrame) || secondsToTimecode(0, fps, dropFrame);
  return normalize({ fps, dropFrame, ...(value || {}) });
}

// The 80 LTC bits of one frame, in transmission order.
export function ltcBits(timecode, { userBits = 0 } = {}) {
  const tc = normalize(timecode), bits = new Uint8Array(80);
  const put = (start, length, value) => { for (let i = 0; i < length; i++) bits[start + i] = (value >> i) & 1; };
  put(0, 4, tc.frames % 10); put(8, 2, Math.floor(tc.frames / 10));
  bits[10] = tc.dropFrame ? 1 : 0;
  put(16, 4, tc.seconds % 10); put(24, 3, Math.floor(tc.seconds / 10));
  put(32, 4, tc.minutes % 10); put(40, 3, Math.floor(tc.minutes / 10));
  put(48, 4, tc.hours % 10); put(56, 2, Math.floor(tc.hours / 10));
  for (let g = 0; g < 8; g++) put(4 + g * 8, 4, (finite(userBits) >>> (g * 4)) & 15);
  SYNC_WORD.forEach((bit, i) => { bits[64 + i] = bit; });
  // Polarity correction bit (59 at 25 fps, 27 otherwise) keeps the number of
  // ones even, so every frame starts with the same edge polarity.
  const polarity = nominalRate(tc.fps) === 25 ? 59 : 27;
  bits[polarity] = bits.reduce((sum, bit) => sum + bit, 0) & 1;
  return bits;
}

// Continuous biphase-mark LTC audio for `frames` consecutive frames.
export function generateLTC({ start = 0, frames = 1, fps = 25, dropFrame = false, sampleRate = 48000, amplitude = 0.5, userBits = 0 } = {}) {
  const sr = Math.min(768000, Math.max(8000, finite(sampleRate, 48000)));
  const first = toTimecode(start, fps, dropFrame);
  const rate = frameRate(first.fps, first.dropFrame), count = int(frames, 0, 100000);
  const out = new Float32Array(Math.round(count * sr / rate));
  const halves = new Float32Array(160), amp = Math.min(1, Math.abs(finite(amplitude, 0.5)));
  const base = timecodeToFrames(first);
  let level = -1, current = -1;
  for (let i = 0; i < out.length; i++) {
    const half = Math.min(count * 160 - 1, Math.floor((i + 0.5) * rate * 160 / sr));
    const frame = Math.floor(half / 160);
    if (frame !== current) {
      current = frame;
      const bits = ltcBits(framesToTimecode(base + frame, first.fps, first.dropFrame), { userBits });
      for (let b = 0; b < 80; b++) {
        level = -level; halves[b * 2] = level;
        if (bits[b]) level = -level;
        halves[b * 2 + 1] = level;
      }
    }
    out[i] = halves[half - frame * 160] * amp;
  }
  return out;
}

// One frame of LTC audio (round(sampleRate / fps) samples); concatenating
// consecutive frames yields a valid stream.
export function encodeLTC(timecode, fps = 25, sampleRate = 48000, { amplitude = 0.5, userBits = 0, dropFrame } = {}) {
  const drop = dropFrame ?? (typeof timecode === 'object' ? timecode?.dropFrame : false);
  return generateLTC({ start: timecode, frames: 1, fps, dropFrame: !!drop, sampleRate, amplitude, userBits });
}

// SMPTE clip transport: composition timecode -> normalized clip position.
// The clip's offset is the timecode at which clip time 0 plays, so the video
// stays locked to the audio it was made for. The in/out window clamps that:
// before inPoint holds inPoint; past outPoint 'hold' keeps the out frame,
// 'loop' wraps inside the window and 'stop' returns null (eject/hide). Before
// the offset the clip has nothing to show: null.
export function clipTimeFromTimecode({ timecodeSeconds, clipOffsetSeconds = 0, clipDuration, inPoint = 0, outPoint = 1, mode = 'hold' } = {}) {
  const time = Number(timecodeSeconds), duration = Number(clipDuration);
  if (!Number.isFinite(time) || !(duration > 0) || !Number.isFinite(duration)) return null;
  const lo = Math.min(1, Math.max(0, finite(inPoint, 0))), hi = Math.min(1, Math.max(lo, finite(outPoint, 1)));
  const local = time - finite(clipOffsetSeconds);
  if (local < 0) return null;
  const position = local / duration;
  if (position < lo) return lo;
  if (position < hi) return position;
  if (mode === 'loop') return hi > lo ? lo + (position - lo) % (hi - lo) : lo;
  if (mode === 'stop') return null;
  return hi;
}

const modules = new WeakMap();
function loadWorklet(context, url) {
  let urls = modules.get(context);
  if (!urls) modules.set(context, urls = new Map());
  if (!urls.has(url)) urls.set(url, context.audioWorklet.addModule(url).catch(error => { urls.delete(url); throw error; }));
  return urls.get(url);
}

function defaultWorkletURL() {
  // Relative so it resolves both under the dev server and from file:// (dist).
  return typeof location === 'undefined' ? 'ltc-worklet.js' : new URL('ltc-worklet.js', location.href).href;
}

export class TimecodeInput {
  constructor(audioContext, { workletURL = defaultWorkletURL(), fps = 'auto', delayFrames = 0, offset = 0,
    lockFrames = 2, jumpThreshold = 0.25, timeout = 0.25 } = {}) {
    if (!audioContext || typeof audioContext.createGain !== 'function') throw new TypeError('TimecodeInput needs an AudioContext');
    this.context = audioContext;
    this.workletURL = String(workletURL);
    this.fps = fps; // 'auto' or a rate from SMPTE_FRAME_RATES (Preferences > Audio framerate)
    this.delayFrames = delayFrames; // manual "Delay": frames of compensation, negative holds video back
    this.offset = offset; // seconds added to the reported clock
    this.lockFrames = Math.max(1, int(lockFrames, 1, 25));
    this.jumpThreshold = Math.max(0.05, finite(jumpThreshold, 0.25));
    this.timeout = Math.max(0.05, finite(timeout, 0.25));
    this.listeners = new Map(EVENTS.map(name => [name, new Set()]));
    this.offline = typeof OfflineAudioContext !== 'undefined' && audioContext instanceof OfflineAudioContext;
    this._nodes = null;
    this._reset();
    this._held = 0;
    this._last = { fps: 25, dropFrame: false, userBits: 0 };
  }

  _reset() {
    this._locked = false; this._good = 0; this._prev = null; this._jump = false;
    this._anchorT = 0; this._anchorPos = 0; this._rate = 1; this._floor = -Infinity; this._lastFrameT = -Infinity;
  }

  on(event, callback) {
    const set = this.listeners.get(event);
    if (!set || typeof callback !== 'function') return () => {};
    set.add(callback);
    return () => set.delete(callback);
  }

  _emit(event, detail) {
    for (const callback of this.listeners.get(event) || []) {
      try { callback(detail); } catch (error) { console.error(error); }
    }
  }

  async start(source, { channel = 0 } = {}) {
    this.stop();
    const context = this.context;
    let input = source, owned = null;
    if (source && typeof source.getAudioTracks === 'function') {
      if (!source.getAudioTracks().length) throw new Error('MediaStream has no audio track');
      input = owned = context.createMediaStreamSource(source);
    }
    if (!input || typeof input.connect !== 'function') throw new TypeError('TimecodeInput.start needs an AudioNode or MediaStream');
    if (input.context && input.context !== context) throw new Error('Source belongs to a different AudioContext');
    await loadWorklet(context, this.workletURL);
    const ch = int(channel, 0, 31);
    const node = new AudioWorkletNode(context, 'prism-ltc', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    const splitter = context.createChannelSplitter(ch + 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    input.connect(splitter);
    splitter.connect(node, ch, 0);
    node.connect(mute).connect(context.destination); // keeps the worklet pulled
    node.port.onmessage = event => this._message(event.data);
    this._nodes = { input, owned, splitter, node, mute };
    this._reset();
    return this;
  }

  stop() {
    const nodes = this._nodes;
    this._nodes = null;
    if (nodes) {
      nodes.node.port.onmessage = null;
      try { nodes.node.port.postMessage({ type: 'stop' }); } catch {}
      for (const [from, to] of [[nodes.input, nodes.splitter], [nodes.splitter, null], [nodes.node, null], [nodes.mute, null]]) {
        try { to ? from.disconnect(to) : from.disconnect(); } catch {}
      }
    }
    this._unlock();
  }

  get running() { return !!this._nodes; }


  _now() {
    const ct = this.context.currentTime;
    if (this.offline || typeof performance === 'undefined') return ct;
    const wall = performance.now() / 1000;
    if (ct !== this._ct) { this._ct = ct; this._wall = wall; return ct; }
    return ct + Math.min(0.03, Math.max(0, wall - this._wall)); // currentTime moves in audio-callback steps
  }

  _clock(t) { return this._anchorPos + (t - this._anchorT) * this._rate; }

  _message(data) {
    if (!data || typeof data !== 'object') return;
    if (data.signal === false) { this._unlock(); return; }
    const fields = ['hours', 'minutes', 'seconds', 'frames', 'sampleTime'];
    if (fields.some(key => !Number.isFinite(data[key]))) return;
    const auto = this.fps === 'auto' || !(finite(this.fps) > 0);
    const fps = auto ? (SMPTE_FRAME_RATES.includes(data.fps) ? data.fps : 25) : finite(this.fps);
    const dropFrame = !!data.dropFrame && dropCapable(fps);
    if (data.frames >= nominalRate(fps) || data.hours > 23 || data.minutes > 59 || data.seconds > 59) return;
    const tc = { hours: data.hours | 0, minutes: data.minutes | 0, seconds: data.seconds | 0, frames: data.frames | 0, fps, dropFrame };
    const frameStart = timecodeToSeconds(tc), duration = 1 / frameRate(fps, dropFrame);
    const t = data.sampleTime / this.context.sampleRate;
    // Forward, the sync word ends where the next frame starts; backwards it is
    // detected 16 bits into the previous frame.
    const pos = frameStart + (data.reverse ? -0.2 * duration : duration);
    this._last = { fps, dropFrame, userBits: finite(data.userBits) >>> 0 };
    this._lastFrameT = t;
    this._emit('timecode', { ...tc, timecode: formatTimecode(tc), seconds: frameStart, userBits: this._last.userBits, reverse: !!data.reverse });

    const prev = this._prev;
    this._prev = { t, pos };
    let rate = NaN;
    if (prev) {
      const dt = t - prev.t;
      if (dt > 1e-4 && dt < 0.5) rate = (pos - prev.pos) / dt;
    }
    const consistent = Math.abs(rate) >= 0.2 && Math.abs(rate) <= 4;
    if (!this._locked) {
      this._good = consistent ? this._good + 1 : 0;
      if (this._good + 1 >= this.lockFrames) this._lock(t, pos, consistent ? rate : 1, false);
      return;
    }
    const error = pos - this._clock(t);
    if (Math.abs(error) > this.jumpThreshold) {
      // A jump (cue, scrub, new track) must be confirmed by a second frame
      // that agrees with it, so one corrupt frame cannot move the playhead.
      if (this._jump && consistent) this._lock(t, pos, rate, true);
      else this._jump = true;
      return;
    }
    this._jump = false;
    if (consistent) this._rate += (rate - this._rate) * 0.15;
    this._anchorPos = this._clock(t) + error * 0.25;
    this._anchorT = t;
  }

  _lock(t, pos, rate, jump) {
    this._anchorT = t; this._anchorPos = pos;
    this._rate = Math.abs(rate - 1) < 0.01 ? 1 : Math.max(-4, Math.min(4, rate));
    this._floor = -Infinity; this._jump = false;
    const wasLocked = this._locked;
    this._locked = true;
    if (!wasLocked || jump) this._emit('lock', { ...this._snapshot(t), jump });
  }

  _unlock() {
    if (this._locked) this._held = this._clock(Math.min(this._now(), this._lastFrameT + this.timeout));
    const wasLocked = this._locked;
    this._reset();
    if (wasLocked) this._emit('unlock', { seconds: this._held });
  }

  // Offline contexts render ahead of the main thread, so only the worklet's
  // { signal: false } message unlocks them.
  get state() {
    const now = this._now();
    if (this._locked && !this.offline && now - this._lastFrameT > this.timeout + 0.05) this._unlock();
    return this._snapshot(now);
  }

  _snapshot(now) {
    const { fps, dropFrame, userBits } = this._last;
    let raw = this._held;
    if (this._locked) {
      raw = this._clock(now);
      if (this._rate >= 0) { raw = Math.max(raw, this._floor); this._floor = raw; }
      this._held = raw;
    }
    const seconds = raw + finite(this.delayFrames) / frameRate(fps, dropFrame) + finite(this.offset);
    return { locked: this._locked, seconds, timecode: formatTimecode(seconds, fps, dropFrame), fps, dropFrame, userBits, rate: this._locked ? this._rate : 0 };
  }
}
