// Frame-accurate playback of GPU-compressed movies (HAP, DXV). A small worker
// pool fetches and decompresses frames into DXT/BC blocks; the compositor
// uploads them as compressed textures. The transport chooses every frame, so
// forward, reverse, scrubbing and speed changes need no second file.
import { frameAt } from './mov.js';

class DecoderPool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.nextId = 1;
    this.inline = typeof Worker === 'undefined';
  }

  run(message, priority = 0) {
    const job = { id: this.nextId++, message, priority, cancelled: false, started: false };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.cancel = () => {
      if (job.started || job.cancelled) return;
      job.cancelled = true;
      this.queue.splice(this.queue.indexOf(job), 1);
      job.reject(Object.assign(new Error('Decode cancelled.'), { name: 'AbortError' }));
    };
    this.queue.push(job);
    this._pump();
    return job;
  }

  _spawn() {
    const slot = { busy: false, job: null, answered: false,
      worker: new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) };
    slot.worker.onmessage = ({ data }) => {
      slot.answered = true;
      const job = slot.job;
      slot.busy = false; slot.job = null;
      if (job?.id === data.id) { if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result); }
      this._pump();
    };
    slot.worker.onerror = event => {
      event.preventDefault?.();
      // A worker that cannot start (blocked script or module) falls back to
      // decoding in this thread rather than leaving the clip blank.
      const job = slot.job;
      slot.worker.terminate();
      this.workers.splice(this.workers.indexOf(slot), 1);
      if (!slot.answered) this.inline = true;
      if (job) { job.started = false; this.queue.unshift(job); }
      this._pump();
    };
    this.workers.push(slot);
    return slot;
  }

  _next() {
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[best].priority) best = i;
    return this.queue.splice(best, 1)[0];
  }

  _pump() {
    while (this.queue.length) {
      if (this.inline) {
        if (this.inlineBusy) return;
        const job = this._next();
        job.started = true;
        this.inlineBusy = true;
        import('./decode.js').then(module => module.handle(job.message)).then(({ result }) => job.resolve(result), job.reject)
          .finally(() => { this.inlineBusy = false; this._pump(); });
        return;
      }
      let slot = this.workers.find(worker => !worker.busy);
      if (!slot && this.workers.length < this.size) {
        try { slot = this._spawn(); } catch { this.inline = true; continue; }
      }
      if (!slot) return;
      const job = this._next();
      job.started = true;
      slot.busy = true; slot.job = job;
      slot.worker.postMessage({ ...job.message, id: job.id });
    }
  }
}

let sharedPool = null;
export function decoderPool() {
  const cores = globalThis.navigator?.hardwareConcurrency || 4;
  return sharedPool ||= new DecoderPool(Math.max(2, Math.min(4, Math.floor(cores / 2))));
}

// Stand-in for HTMLVideoElement where the engine and app read playback state.
export class GpuVideoElement extends EventTarget {
  constructor(player) {
    super();
    this.player = player;
    this.paused = true;
    this.muted = true;
    this.volume = 1;
    this.playbackRate = 1;
    this.loop = false;
    this.seeking = false;
  }
  get videoWidth() { return this.player.info?.width || 0; }
  get videoHeight() { return this.player.info?.height || 0; }
  get duration() { return this.player.info?.duration ?? NaN; }
  get currentTime() { return this.player.presentedTime; }
  get readyState() { return this.player.presented ? 4 : this.player.info ? 1 : 0; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  removeAttribute() {}
  getVideoPlaybackQuality() { return { droppedVideoFrames: this.player.late, totalVideoFrames: this.player.presentedCount }; }
}

export class GpuVideoPlayer {
  constructor(url, { pool = decoderPool(), rgtc = true, maxFrames = 12 } = {}) {
    this.url = url;
    this.pool = pool;
    this.rgtc = rgtc;
    this.maxFrames = maxFrames;
    this.info = null;
    this.frames = new Map();
    this.pending = new Map();
    this.wanted = new Set();
    this.presented = null;
    this.presentedTime = 0;
    this.presentedCount = 0;
    this.late = 0;
    this.error = null;
    this.timing = { fetchMs: 0, decodeMs: 0, uploadMs: 0, frames: 0 };
    this.element = new GpuVideoElement(this);
    this.disposed = false;
  }

  async open() {
    this.openJob = this.pool.run({ type: 'open', url: this.url }, -1);
    this.info = await this.openJob.promise;
    return this.info;
  }

  frameAt(time) { return frameAt(this.info.times, this.info.count, time); }

  // Decode `index` now and `ahead` frames after it in playback direction.
  request(index, { direction = 1, step = 1, ahead = 0, first = 0, last = this.info.count - 1, wrap = true } = {}) {
    if (this.disposed || !this.info) return;
    const span = last - first + 1, wanted = [index];
    for (let k = 1; k <= ahead; k++) {
      let next = index + direction * step * k;
      if (next < first || next > last) {
        if (!wrap || span <= 0) break;
        next = first + (((next - first) % span) + span) % span;
      }
      if (!wanted.includes(next)) wanted.push(next);
    }
    this.wanted = new Set(wanted);
    for (const [frame, job] of this.pending) if (!this.wanted.has(frame)) job.cancel();
    wanted.forEach((frame, order) => { if (!this.frames.has(frame) && !this.pending.has(frame)) this._decode(frame, order); });
    this._evict();
  }

  _decode(index, priority) {
    const { info } = this;
    const job = this.pool.run({ type: 'decode', url: this.url, codec: info.codec, fourcc: info.fourcc, width: info.width, height: info.height,
      offset: info.offsets[index], size: info.sizes[index], rgtc: this.rgtc }, priority);
    this.pending.set(index, job);
    job.promise.then(result => {
      if (this.pending.get(index) === job) this.pending.delete(index);
      if (this.disposed) return;
      const timing = this.timing, weight = timing.frames < 30 ? 1 / (timing.frames + 1) : 1 / 30;
      timing.fetchMs += (result.fetchMs - timing.fetchMs) * weight;
      timing.decodeMs += (result.decodeMs - timing.decodeMs) * weight;
      timing.frames++;
      this.frames.set(index, { index, layout: result.layout, textures: result.textures });
      this.error = null;
      this._evict();
    }, error => {
      if (this.pending.get(index) === job) this.pending.delete(index);
      if (error.name !== 'AbortError' && !this.disposed) this.error = error;
    });
  }

  _evict() {
    if (this.frames.size <= this.maxFrames) return;
    for (const index of [...this.frames.keys()]) {
      if (this.frames.size <= this.maxFrames) break;
      if (!this.wanted.has(index) && index !== this.presented?.index) this.frames.delete(index);
    }
  }

  frame(index) { return this.frames.get(index) || null; }

  // While `index` is still decoding: the decoded frame the playhead passed
  // most recently in `direction`, so a slow decode lags instead of freezing.
  closest(index, direction = 1) {
    let best = null, bestDistance = Infinity;
    for (const frame of [...this.frames.values(), this.presented]) {
      if (!frame) continue;
      const passed = (index - frame.index) * direction, distance = passed >= 0 ? passed : this.info.count - passed;
      if (distance < bestDistance) { best = frame; bestDistance = distance; }
    }
    return best;
  }

  dispose() {
    this.disposed = true;
    this.openJob?.cancel();
    for (const job of this.pending.values()) job.cancel();
    this.pending.clear();
    this.frames.clear();
    this.presented = null;
  }
}
