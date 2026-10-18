// Output windows (manual pp. 94–124). Each enabled screen gets its own window
// opened with window.open: it shares the editor's renderer process, so every
// frame the composition canvas is uploaded GPU-to-GPU into that window's
// OutputMapper (slices, warping, masks, soft edges) with no encoding step.
import { OutputMapper } from './mapper.js';

// Slice inputs that name a single layer or group ('layer:<id>', 'group:<id>').
export function routedSources(config) {
  return [...new Set((config?.screens || []).flatMap(screen => (screen.slices || []).map(slice => slice.input?.source)).filter(source => /^(layer|group):/.test(source || '')))];
}

const frameName = screen => `prism-output-${String(screen.id).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'screen'}`;

export class OutputWindows {
  // options: { source: HTMLCanvasElement, desktop, onError(message), onClosed(screenId) }
  constructor({ source, desktop, engine = null, onError = () => {}, onClosed = () => {} }) {
    this.source = source;
    this.engine = engine;
    this.desktop = desktop;
    this.onError = onError;
    this.onClosed = onClosed;
    this.windows = new Map();
    this.options = { testCard: false, identify: false, showFPS: false, showInfo: false };
    this.config = null;
    desktop?.onOutputWindowClosed?.(name => { for (const [id, entry] of this.windows) if (entry.name === name) this._forget(id); });
  }

  get active() { return this.windows.size > 0; }

  setOptions(options) { this.options = { ...this.options, ...options }; }

  // Open, move or close windows so they match the enabled screens of `config`.
  sync(config, { displays = [] } = {}) {
    this.config = config;
    // Slices fed by a single layer or group need that output read back.
    this.engine?.setReadbacks(routedSources(config).map(source => source.replace(/^(layer|group):/, '')));
    const wanted = (config?.screens || []).filter(screen => screen.enabled !== false && (screen.device?.type === 'display' || !this.desktop));
    for (const id of [...this.windows.keys()]) if (!wanted.some(screen => screen.id === id)) this.close(id);
    for (const screen of wanted) {
      const entry = this.windows.get(screen.id) || this._open(screen);
      if (!entry) continue;
      entry.screen = screen;
      const placement = `${screen.device?.displayId || ''}:${screen.device?.width}x${screen.device?.height}`;
      if (entry.placement !== placement) {
        entry.placement = placement;
        const display = displays.find(item => String(item.id) === String(screen.device?.displayId));
        this.desktop?.placeOutputWindow?.(entry.name, display?.id ?? screen.device?.displayId, !!display && displays.length > 1).catch?.(() => {});
      }
    }
    return this.windows.size;
  }

  _open(screen) {
    const name = frameName(screen), width = Math.max(160, screen.device?.width || 1280), height = Math.max(90, screen.device?.height || 720);
    const child = window.open('about:blank', name, `width=${Math.min(width, 1920)},height=${Math.min(height, 1080)}`);
    if (!child) { this.onError('The output window could not be opened.'); return null; }
    let doc;
    try { doc = child.document; } catch { child.close(); this.onError('The output window is isolated from the editor; using the compatibility output.'); return null; }
    doc.title = `PrismVJ — ${screen.name || 'Output'}`;
    doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden;cursor:none';
    const canvas = doc.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100vw;height:100vh;object-fit:contain;background:#000';
    canvas.width = width; canvas.height = height;
    doc.body.append(canvas);
    const entry = { name, child, canvas, screen, placement: '', mapper: null };
    try { entry.mapper = new OutputMapper(canvas, { onError: message => this.onError(`Output ${screen.name}: ${message}`) }); }
    catch (error) { child.close(); this.onError(`Output ${screen.name}: ${error.message}`); return null; }
    child.addEventListener('keydown', event => { if (event.key === 'Escape' && !doc.fullscreenElement) this.close(screen.id); });
    child.addEventListener('beforeunload', () => this._forget(screen.id));
    this.windows.set(screen.id, entry);
    return entry;
  }

  _forget(id) {
    const entry = this.windows.get(id);
    if (!entry) return;
    this.windows.delete(id);
    try { entry.mapper?.dispose(); } catch { /* window already gone */ }
    this.onClosed(id);
  }

  close(id) {
    const entry = this.windows.get(id);
    if (!entry) return;
    this._forget(id);
    if (this.desktop?.closeOutputWindow) this.desktop.closeOutputWindow(entry.name).catch(() => {});
    else try { entry.child.close(); } catch { /* already closed */ }
  }

  closeAll() { for (const id of [...this.windows.keys()]) this.close(id); }

  // Called from the editor frame loop right after the composition renders.
  present(time) {
    if (!this.windows.size) return;
    for (const [id, entry] of this.windows) {
      if (entry.child.closed) { this._forget(id); continue; }
      const screen = entry.screen, width = screen.device?.width || entry.canvas.width, height = screen.device?.height || entry.canvas.height;
      if (entry.canvas.width !== width || entry.canvas.height !== height) { entry.canvas.width = width; entry.canvas.height = height; entry.mapper.resize?.(width, height); }
      entry.mapper.setSource('composition', this.source);
      // Layer/group inputs arrive as asynchronous pixel readbacks from the
      // editor's engine; each new frame is uploaded once.
      entry.versions ||= new Map();
      for (const slice of screen.slices || []) {
        const source = slice.input?.source;
        if (!source || source === 'composition' || !/^(layer|group):/.test(source)) continue;
        const id = source.replace(/^(layer|group):/, ''), version = this.engine?.readbackVersion(id) || 0;
        if (entry.versions.get(source) === version) continue;
        const frame = this.engine?.readback(id);
        if (frame) { entry.mapper.setSource(source, frame); entry.versions.set(source, version); }
      }
      try { entry.mapper.render(screen, { ...this.options, label: screen.name, time }); }
      catch (error) { this.onError(`Output ${screen.name}: ${error.message}`); }
    }
  }
}
