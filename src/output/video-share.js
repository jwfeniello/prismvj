// Spout and NDI® inputs and outputs (desktop app only). The native module
// lives in the preload (electron/preload.cjs); frames cross between this page
// and the preload over a MessageChannel, which moves buffers without copying.
//
// Outputs: VideoFrame(canvas) → share-worker.js reads it back as BGRA off the
// main thread → preload → Spout/NDI sender thread. At most six frames per
// output are in flight; a busier output drops frames instead of queueing.
// Inputs: receiver thread → preload copies the newest frame (bottom row first,
// ready for WebGL) → `latest` here; the engine uploads it when it changes.
import { OutputMapper } from './mapper.js';
import { feedSlices } from './windows.js';

export const SHARE_KINDS = Object.freeze(['spout', 'ndi']);
export const shareLabel = kind => kind === 'ndi' ? 'NDI®' : 'Spout';
const MAX_IN_FLIGHT = 6;

class ShareInput {
  constructor(share, id, kind, source) {
    Object.assign(this, { share, id, kind, source, latest: null, sequence: 0, closed: false });
  }

  info() { return this.closed ? null : this.share.api.info(this.id); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.share.api.close(this.id);
    this.share.handles.delete(this.id);
    this.latest = null;
  }
}

class ShareOutput {
  constructor(share, id, kind, name) {
    Object.assign(this, { share, id, kind, name, inFlight: 0, sent: 0, dropped: 0, readbackMs: 0, errors: 0, closed: false });
  }

  // Sends the canvas's current image. alpha: keep transparency (NDI sends BGRX otherwise).
  send(canvas, { alpha = false, fps = 60 } = {}) {
    if (this.closed || !canvas?.width || !canvas?.height) return false;
    if (this.inFlight >= MAX_IN_FLIGHT) { this.dropped++; return false; }
    let frame;
    try { frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000), alpha: alpha ? 'keep' : 'discard' }); }
    catch { this.errors++; return false; }
    this.inFlight++;
    this.alpha = alpha; this.fps = fps;
    this.share.worker.postMessage({ id: this.id, frame, started: performance.now() }, [frame]);
    return true;
  }

  info() {
    if (this.closed) return null;
    return { ...this.share.api.info(this.id), queued: this.sent, skipped: this.dropped, readbackMs: this.readbackMs };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.share.api.close(this.id);
    this.share.handles.delete(this.id);
    this.share.worker.postMessage({ forget: true, id: this.id });
  }
}

export class VideoShare {
  constructor(api) {
    this.api = api;
    this.handles = new Map();
    this.port = null;
    this.worker = new Worker(new URL('./share-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => this._readback(data);
  }

  // Resolves once the preload has handed over its end of the frame channel.
  connect() {
    return new Promise((resolve, reject) => {
      const listen = event => {
        if (event.source !== window || event.data !== 'prism-video-port' || !event.ports[0]) return;
        window.removeEventListener('message', listen);
        this.port = event.ports[0];
        this.port.onmessage = ({ data }) => this._message(data);
        resolve(this);
      };
      window.addEventListener('message', listen);
      if (!this.api.connect()) { window.removeEventListener('message', listen); reject(new Error(this.api.status().error || 'Spout and NDI are unavailable.')); }
    });
  }

  status() { return this.api.status(); }
  spoutSenders() { return this.api.spoutSenders(); }
  ndiSources() { return this.api.ndiSources(); }
  openNdiRuntimePage() { return this.api.openNdiRuntimePage(); }

  input(kind, source, url) {
    const id = this.api.openReceiver(kind, source, url);
    const handle = new ShareInput(this, id, kind, source);
    this.handles.set(id, handle);
    return handle;
  }

  output(kind, name) {
    const id = this.api.openSender(kind, name);
    const handle = new ShareOutput(this, id, kind, name);
    this.handles.set(id, handle);
    return handle;
  }

  _readback(data) {
    const handle = this.handles.get(data.id);
    if (!handle || data.error) {
      if (handle) { handle.inFlight--; handle.errors++; }
      if (data.buffer) this.worker.postMessage({ release: data.buffer, id: data.id }, [data.buffer]);
      return;
    }
    handle.readbackMs += ((performance.now() - data.started) - handle.readbackMs) * 0.1;
    handle.sent++;
    this.port.postMessage({ type: 'frame', id: data.id, buffer: data.buffer, width: data.width, height: data.height, alpha: handle.alpha, fps: handle.fps }, [data.buffer]);
  }

  _message(data) {
    const handle = this.handles.get(data?.id);
    if (data?.type === 'returned') {
      // An output frame was handed to its sender: its buffer goes back to the worker.
      if (handle instanceof ShareOutput) handle.inFlight = Math.max(0, handle.inFlight - 1);
      this.worker.postMessage({ release: data.buffer, id: data.id }, [data.buffer]);
    } else if (data?.type === 'input') {
      if (!(handle instanceof ShareInput)) { this.port.postMessage({ type: 'returned', id: data.id, buffer: data.buffer }, [data.buffer]); return; }
      const previous = handle.latest;
      handle.latest = { buffer: data.buffer, width: data.width, height: data.height, alpha: data.alpha, received: performance.now(), ageMs: data.ageMs };
      handle.sequence++;
      if (previous) this.port.postMessage({ type: 'returned', id: data.id, buffer: previous.buffer }, [previous.buffer]);
    }
  }

  dispose() {
    for (const handle of [...this.handles.values()]) handle.close();
    this.worker.terminate();
    this.port?.close();
  }
}

// Connects to the preload's Spout/NDI bridge; null outside the desktop app or
// when the native module is missing.
export async function connectVideoShare(api = globalThis.desktop?.videoShare) {
  if (!api || typeof VideoFrame === 'undefined') return null;
  try { return await new VideoShare(api).connect(); }
  catch { return null; }
}

// Senders for the composition (Output menu) and for Advanced Output screens
// whose device is a Spout or NDI sender. Called once per rendered frame.
export class ShareOutputs {
  // options: { share: VideoShare, source: composition canvas, engine, getOptions(), onError(message) }
  constructor({ share, source, engine = null, getOptions = () => ({}), onError = () => {} }) {
    Object.assign(this, { share, source, engine, getOptions, onError });
    this.composition = new Map();
    this.screens = new Map();
  }

  get active() { return this.composition.size + this.screens.size > 0; }

  // Composition senders, e.g. { spout: 'PrismVJ', ndi: null }.
  setComposition(names) {
    for (const kind of SHARE_KINDS) {
      const name = names?.[kind] || null, current = this.composition.get(kind);
      if (current && current.name === name) continue;
      current?.close(); this.composition.delete(kind);
      if (!name) continue;
      try { this.composition.set(kind, this.share.output(kind, name)); }
      catch (error) { this.onError(`${shareLabel(kind)} output: ${error.message}`); }
    }
  }

  // Advanced Output screens with a Spout or NDI device.
  sync(config) {
    const wanted = (config?.screens || []).filter(screen => screen.enabled !== false && SHARE_KINDS.includes(screen.device?.type));
    for (const [id, entry] of this.screens) {
      const screen = wanted.find(item => item.id === id);
      if (!screen || screen.device.type !== entry.kind || screen.device.name !== entry.name) { this._closeScreen(id); }
    }
    for (const screen of wanted) {
      if (this.screens.has(screen.id)) { this.screens.get(screen.id).screen = screen; continue; }
      const canvas = document.createElement('canvas');
      canvas.width = screen.device.width; canvas.height = screen.device.height;
      try {
        const mapper = new OutputMapper(canvas, { onError: message => this.onError(`${screen.name}: ${message}`) });
        const output = this.share.output(screen.device.type, screen.device.name || screen.name);
        this.screens.set(screen.id, { screen, canvas, mapper, output, kind: screen.device.type, name: screen.device.name, versions: new Map() });
      } catch (error) { this.onError(`${screen.name}: ${error.message}`); }
    }
    return this.screens.size;
  }

  _closeScreen(id) {
    const entry = this.screens.get(id);
    if (!entry) return;
    this.screens.delete(id);
    entry.output.close();
    try { entry.mapper.dispose(); } catch { /* context already lost */ }
  }

  present(time, fps = 60) {
    for (const output of this.composition.values()) output.send(this.source, { fps });
    for (const entry of this.screens.values()) {
      const { screen, canvas, mapper } = entry, width = screen.device.width, height = screen.device.height;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; mapper.resize?.(width, height); }
      feedSlices(entry, screen, this.source, this.engine);
      try { mapper.render(screen, { ...this.getOptions(), label: screen.name, time }); entry.output.send(canvas, { fps }); }
      catch (error) { this.onError(`${screen.name}: ${error.message}`); }
    }
  }

  stats() {
    return [...[...this.composition.values()].map(output => ({ target: 'composition', ...output.info() })),
      ...[...this.screens.values()].map(entry => ({ target: entry.screen.name, ...entry.output.info() }))];
  }

  closeAll() {
    for (const output of this.composition.values()) output.close();
    this.composition.clear();
    for (const id of [...this.screens.keys()]) this._closeScreen(id);
  }
}
