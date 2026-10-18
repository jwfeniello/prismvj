// Keyboard, MIDI, OSC and DMX shortcuts (manual pp. 149–216). In edit mode
// every assignable control is highlighted; click one, then press a key, move
// a MIDI control, send an OSC message or change a DMX channel to assign it.
import { resolvePath, readOwner, writeOwner, normalizedValue, denormalizedValue, describePath } from '../params.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PRESET_KEY = 'prism-shortcut-presets';
const id = () => `shortcut-${crypto.randomUUID()}`;
export const SOURCE_LABELS = { key: 'Keyboard', midi: 'MIDI', osc: 'OSC', dmx: 'DMX' };

export function describeInput(shortcut) {
  const input = shortcut.input;
  if (shortcut.source === 'key') return [input.ctrl && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift', input.code.replace(/^Key|^Digit/, '')].filter(Boolean).join('+');
  if (shortcut.source === 'midi') return `${input.type === 'note' ? 'Note' : input.type === 'pitch' ? 'Pitch' : 'CC'} ${input.type === 'pitch' ? '' : input.number} · ch ${input.channel + 1}${input.device ? ` · ${input.device}` : ''}`;
  if (shortcut.source === 'osc') return input.address;
  return `Universe ${input.universe} · ch ${input.dmxChannel}`;
}

const defaultMode = (target, param) => target.startsWith('action/') ? 'trigger' : param?.type === 'bool' ? 'toggle' : 'value';

export class ShortcutManager {
  // ctx: { getProject, changed(structural), toast, runAction(path, pressed, inputId), targetFor(element) → path|null, onEditChange(mode) }
  constructor(ctx) {
    this.ctx = ctx;
    this.editing = null;
    this.selected = null;
    this.held = new Map();
    this.midiAccess = null;
    this.feedbackSent = new Map();
    this.dmxLast = new Map();
    this.clock = { ticks: [], enabled: false };
    this.onClick = this.onClick.bind(this);
  }

  get list() { return this.ctx.getProject().shortcuts ||= []; }

  enter(source) {
    this.editing = source;
    this.selected = null;
    document.documentElement.dataset.shortcutEdit = source;
    document.addEventListener('click', this.onClick, true);
    this.ctx.onEditChange?.(source);
    this.ctx.toast(`${SOURCE_LABELS[source]} shortcut mode: click a highlighted control, then ${source === 'key' ? 'press a key' : source === 'midi' ? 'move a MIDI control' : source === 'osc' ? 'send an OSC message' : 'change a DMX channel'}. Escape exits.`);
  }

  exit() {
    if (!this.editing) return;
    this.editing = null;
    this.selected = null;
    delete document.documentElement.dataset.shortcutEdit;
    document.removeEventListener('click', this.onClick, true);
    for (const element of document.querySelectorAll('.shortcut-selected')) element.classList.remove('shortcut-selected');
    this.ctx.onEditChange?.(null);
  }

  onClick(event) {
    if (event.target.closest('.browser-panel, dialog, .animation-editor, [data-shortcut-ui]')) return;
    const path = this.ctx.targetFor(event.target);
    if (!path) return;
    event.preventDefault(); event.stopPropagation();
    for (const element of document.querySelectorAll('.shortcut-selected')) element.classList.remove('shortcut-selected');
    event.target.closest('button, input, select, [data-slot], [data-column], [data-deck]')?.classList.add('shortcut-selected');
    this.selected = path;
    this.ctx.onEditChange?.(this.editing, path);
  }

  assign(source, input) {
    if (!this.selected || this.editing !== source) return false;
    const target = this.selected, resolved = target.startsWith('action/') ? null : resolvePath(this.ctx.getProject(), target);
    const list = this.list;
    // One input drives one target per source; re-assigning moves it.
    const same = item => item.source === source && JSON.stringify(this._inputKey(item)) === JSON.stringify(this._inputKey({ source, input }));
    for (let i = list.length - 1; i >= 0; i--) if (same(list[i])) list.splice(i, 1);
    list.push({ id: id(), source, target, mode: defaultMode(target, resolved?.param), input: { code: '', shift: false, ctrl: false, alt: false, type: 'cc', channel: 0, number: 0, device: '', address: '', universe: 0, dmxChannel: 1, ...input },
      min: 0, max: 1, invert: false, feedback: true, value: 1, group: '', enabled: true });
    this.ctx.changed(true);
    this.ctx.toast(`${describeInput(list.at(-1))} → ${describePath(this.ctx.getProject(), target)}`);
    return true;
  }

  _inputKey({ source, input }) {
    if (source === 'key') return [input.code, !!input.shift, !!input.ctrl, !!input.alt];
    if (source === 'midi') return [input.type, input.channel, input.type === 'pitch' ? 0 : input.number, input.device || ''];
    if (source === 'osc') return [input.address];
    return [input.universe, input.dmxChannel];
  }

  // 'selected' shortcuts follow the selected layer/clip (manual p. 152).
  targetOf(shortcut) {
    return shortcut.targetMode === 'selected' && this.ctx.retarget ? this.ctx.retarget(shortcut.target) || shortcut.target : shortcut.target;
  }

  // Apply a normalized controller value (0..1). `pressed` distinguishes key/note down/up.
  execute(shortcut, normalized, pressed, inputId) {
    if (shortcut.enabled === false) return;
    const project = this.ctx.getProject(), path = this.targetOf(shortcut);
    let value = shortcut.invert ? 1 - normalized : normalized;
    if (path.startsWith('action/')) {
      if (shortcut.mode === 'momentary' || shortcut.mode === 'trigger' || shortcut.mode === 'toggle') this.ctx.runAction(path, pressed, inputId);
      else if (pressed) this.ctx.runAction(path, true, inputId);
      return;
    }
    const target = resolvePath(project, path);
    if (!target || ['color', 'point', 'text'].includes(target.param.type)) return;
    const current = normalizedValue(target.param, readOwner(target.scope, target.owner, target.key));
    const ranged = v => shortcut.min + (shortcut.max - shortcut.min) * v;
    let next = current;
    if (shortcut.mode === 'toggle') { if (!pressed) return; next = current > (shortcut.min + shortcut.max) / 2 ? shortcut.min : shortcut.max; }
    else if (shortcut.mode === 'momentary') next = pressed ? shortcut.max : shortcut.min;
    else if (shortcut.mode === 'set' || shortcut.mode === 'trigger') { if (!pressed) return; next = shortcut.value; }
    else if (shortcut.mode === 'relative') next = Math.min(1, Math.max(0, current + value));
    else next = ranged(value);
    writeOwner(target.scope, target.owner, target.key, denormalizedValue(target.param, next));
    this.ctx.changed(false, target);
  }

  handleKey(event, down) {
    if (this.editing === 'key' && down) {
      if (event.code === 'Escape') { this.exit(); return true; }
      if (!this.selected || ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(event.code)) return true;
      event.preventDefault();
      return this.assign('key', { code: event.code, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey });
    }
    if (this.editing && down && event.code === 'Escape') { this.exit(); return true; }
    if (event.repeat) return this.list.some(item => item.source === 'key' && item.input.code === event.code);
    let handled = false;
    for (const shortcut of this.list) {
      if (shortcut.source !== 'key' || shortcut.input.code !== event.code) continue;
      if (down && (!!shortcut.input.shift !== event.shiftKey || !!shortcut.input.ctrl !== event.ctrlKey || !!shortcut.input.alt !== event.altKey)) continue;
      if (!down && !this.held.has(`${shortcut.id}`)) continue;
      const inputId = down ? `key:${event.code}:${performance.now()}` : this.held.get(shortcut.id);
      if (down) this.held.set(shortcut.id, inputId); else this.held.delete(shortcut.id);
      this.execute(shortcut, down ? 1 : 0, down, inputId);
      handled = true;
    }
    return handled;
  }

  async enableMidi() {
    if (this.midiAccess) return this.midiAccess;
    this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    const bind = () => { for (const input of this.midiAccess.inputs.values()) input.onmidimessage = event => this.handleMidi(event.data, input.name || ''); };
    bind();
    this.midiAccess.onstatechange = () => { bind(); this.ctx.onDevicesChange?.(); };
    return this.midiAccess;
  }

  handleMidi(data, device) {
    this.ctx.onRawMidi?.(data);
    const [status, a = 0, b = 0] = data, kind = status & 0xf0, channel = status & 15;
    if (status === 0xf8 || status === 0xfa || status === 0xfc) { this._clock(status); return; }
    let type = null, number = a, value = 0, pressed = true;
    if (kind === 0x90 || kind === 0x80) { type = 'note'; value = kind === 0x90 ? b / 127 : 0; pressed = kind === 0x90 && b > 0; }
    else if (kind === 0xb0) { type = 'cc'; value = b / 127; pressed = b > 0; }
    else if (kind === 0xe0) { type = 'pitch'; number = 0; value = ((b << 7) | a) / 16383; }
    if (!type) return;
    if (this.editing === 'midi') { if (pressed || type !== 'note') this.assign('midi', { type, channel, number, device: '' }); return; }
    for (const shortcut of this.list) {
      const input = shortcut.input;
      if (shortcut.source !== 'midi' || input.type !== type || input.channel !== channel || (type !== 'pitch' && input.number !== number) || (input.device && input.device !== device)) continue;
      if (shortcut.mode === 'relative') {
        // Two's complement encoders: 1..63 up, 65..127 down.
        const step = b < 64 ? b : b - 128;
        this.execute(shortcut, step / 127, true);
        continue;
      }
      if (type === 'note' && shortcut.mode === 'value') { if (pressed) this.execute(shortcut, value, true); continue; }
      const inputId = `midi:${device}:${channel}:${number}`;
      this.execute(shortcut, value, type === 'note' ? pressed : value > 0.5 || shortcut.mode === 'value', inputId);
    }
  }

  // MIDI clock: 24 pulses per quarter note → BPM (averaged over 2 beats).
  _clock(status) {
    if (!this.clock.enabled) return;
    if (status === 0xfa) { this.clock.ticks = []; this.ctx.onClockStart?.(); return; }
    if (status === 0xfc) { this.clock.ticks = []; return; }
    const now = performance.now(), ticks = this.clock.ticks;
    ticks.push(now);
    if (ticks.length > 49) ticks.shift();
    if (ticks.length === 49) {
      const bpm = 60000 / ((now - ticks[0]) / 2);
      if (bpm >= 20 && bpm <= 300) this.ctx.onClockBPM?.(Math.round(bpm * 10) / 10);
    }
  }

  handleOSC(address, args) {
    if (this.editing === 'osc') return this.assign('osc', { address: String(address).slice(0, 256) });
    let handled = false;
    const value = typeof args?.[0] === 'number' ? Math.min(1, Math.max(0, args[0])) : 1;
    for (const shortcut of this.list) if (shortcut.source === 'osc' && shortcut.input.address === address) {
      this.execute(shortcut, value, value > 0, `osc:${address}`); handled = true;
    }
    return handled;
  }

  handleDmx(universe, data) {
    const previous = this.dmxLast.get(universe);
    this.dmxLast.set(universe, Uint8Array.from(data));
    if (this.editing === 'dmx' && previous) {
      for (let channel = 0; channel < data.length; channel++) if (Math.abs(data[channel] - previous[channel]) > 8) return this.assign('dmx', { universe, dmxChannel: channel + 1 });
      return false;
    }
    for (const shortcut of this.list) {
      if (shortcut.source !== 'dmx' || shortcut.input.universe !== universe) continue;
      const index = shortcut.input.dmxChannel - 1, value = data[index] ?? 0;
      if (previous && previous[index] === value) continue;
      this.execute(shortcut, value / 255, value >= 128, `dmx:${universe}:${index}`);
    }
    return true;
  }

  // MIDI feedback (manual p. 168): echo current values to controllers that
  // have an output with the same name, only when they change.
  syncFeedback() {
    if (!this.midiAccess) return;
    const project = this.ctx.getProject(), outputs = [...this.midiAccess.outputs.values()];
    if (!outputs.length) return;
    for (const shortcut of this.list) {
      if (shortcut.source !== 'midi' || !shortcut.feedback || shortcut.input.type === 'pitch') continue;
      let normalized;
      const path = this.targetOf(shortcut);
      if (path.startsWith('action/')) normalized = this.ctx.actionState?.(path) ? 1 : 0;
      else { const target = resolvePath(project, path); if (!target || ['color', 'point', 'text'].includes(target.param.type)) continue; normalized = normalizedValue(target.param, readOwner(target.scope, target.owner, target.key)); }
      const byte = Math.round((shortcut.invert ? 1 - normalized : normalized) * 127);
      if (this.feedbackSent.get(shortcut.id) === byte) continue;
      this.feedbackSent.set(shortcut.id, byte);
      const status = (shortcut.input.type === 'note' ? 0x90 : 0xb0) | shortcut.input.channel;
      for (const output of outputs) if (!shortcut.input.device || output.name === shortcut.input.device) { try { output.send([status, shortcut.input.number, byte]); } catch { /* device gone */ } }
    }
  }

  remove(shortcutId) { const list = this.list, index = list.findIndex(item => item.id === shortcutId); if (index >= 0) { list.splice(index, 1); this.ctx.changed(true); } }

  readPresets() { try { const value = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
  savePreset(name) { const all = this.readPresets(); all[String(name).slice(0, 80)] = structuredClone(this.list); try { localStorage.setItem(PRESET_KEY, JSON.stringify(all)); } catch { this.ctx.toast('Presets could not be saved.', true); } }
  loadPreset(name) { const preset = this.readPresets()[name]; if (!preset) return false; this.ctx.getProject().shortcuts = structuredClone(preset); this.ctx.changed(true); return true; }
  deletePreset(name) { const all = this.readPresets(); delete all[name]; try { localStorage.setItem(PRESET_KEY, JSON.stringify(all)); } catch { /* ignore */ } }

  panelHTML() {
    const project = this.ctx.getProject(), presets = Object.keys(this.readPresets());
    const rows = this.list.map(shortcut => `<div class="shortcut-row" data-shortcut-id="${esc(shortcut.id)}"><span class="pill">${SOURCE_LABELS[shortcut.source]}</span>
      <span class="shortcut-input" title="${esc(describeInput(shortcut))}">${esc(describeInput(shortcut))}</span><span class="shortcut-target grow" title="${esc(shortcut.target)}">${esc(describePath(project, shortcut.target))}</span>
      ${/^(layer|clip|group|action\/(clip|layer|group))\//.test(shortcut.target) ? `<select data-shortcut-field="targetMode" aria-label="Target" title="This: always the assigned item. Selected: whatever layer/clip is selected."><option value="fixed" ${shortcut.targetMode !== 'selected' ? 'selected' : ''}>This</option><option value="selected" ${shortcut.targetMode === 'selected' ? 'selected' : ''}>Selected</option></select>` : ''}
      <select data-shortcut-field="mode" aria-label="Mode">${['value', 'toggle', 'momentary', 'trigger', 'set', 'relative'].map(mode => `<option ${mode === shortcut.mode ? 'selected' : ''}>${mode}</option>`).join('')}</select>
      <input type="number" data-shortcut-field="min" min="0" max="1" step="0.01" value="${shortcut.min}" title="Range min" aria-label="Min"><input type="number" data-shortcut-field="max" min="0" max="1" step="0.01" value="${shortcut.max}" title="Range max" aria-label="Max">
      <label title="Invert"><input type="checkbox" data-shortcut-field="invert" ${shortcut.invert ? 'checked' : ''}>Inv</label>${shortcut.source === 'midi' ? `<label title="Send MIDI feedback"><input type="checkbox" data-shortcut-field="feedback" ${shortcut.feedback ? 'checked' : ''}>Out</label>` : ''}
      <button data-shortcut-remove title="Delete shortcut">×</button></div>`).join('');
    return `<div class="section" data-shortcut-ui><h3>Shortcuts</h3><div class="row wrap">${Object.entries(SOURCE_LABELS).map(([source, label]) => `<button data-shortcut-edit="${source}" class="${this.editing === source ? 'active' : ''}">${this.editing === source ? `Exit ${label}` : `Edit ${label}`}</button>`).join('')}</div>
      <p class="browser-note">${this.editing ? (this.selected ? `Selected: <strong>${esc(describePath(project, this.selected))}</strong>. Now give the input.` : 'Click a highlighted control in the interface.') : 'Ctrl+Shift+K enters keyboard shortcut mode, Ctrl+Shift+M MIDI mode.'}</p>
      <div class="row wrap"><select data-shortcut-preset aria-label="Shortcut preset"><option value="">Presets…</option>${presets.map(name => `<option>${esc(name)}</option>`).join('')}</select><button data-shortcut-save>Save preset</button><button data-shortcut-delete-preset>Delete preset</button>
      <label class="anim-check"><input type="checkbox" data-midi-clock ${this.clock.enabled ? 'checked' : ''}> Sync BPM to MIDI clock</label></div>
      <div class="shortcut-list">${rows || '<small>No shortcuts yet.</small>'}</div></div>`;
  }

  bindPanel(host, { prompt, render }) {
    for (const button of host.querySelectorAll('[data-shortcut-edit]')) button.onclick = async () => {
      const source = button.dataset.shortcutEdit;
      if (this.editing === source) this.exit();
      else {
        if (source === 'midi') { try { await this.enableMidi(); } catch (error) { this.ctx.toast(`MIDI unavailable: ${error.message}`, true); return; } }
        this.exit(); this.enter(source);
      }
      render();
    };
    for (const row of host.querySelectorAll('[data-shortcut-id]')) {
      const shortcut = this.list.find(item => item.id === row.dataset.shortcutId);
      if (!shortcut) continue;
      for (const input of row.querySelectorAll('[data-shortcut-field]')) input.onchange = () => {
        const field = input.dataset.shortcutField;
        shortcut[field] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Math.min(1, Math.max(0, Number(input.value) || 0)) : input.value;
        this.feedbackSent.delete(shortcut.id);
        this.ctx.changed(true);
      };
      row.querySelector('[data-shortcut-remove]').onclick = () => { this.remove(shortcut.id); render(); };
    }
    const preset = host.querySelector('[data-shortcut-preset]');
    if (preset) preset.onchange = () => { if (preset.value && this.loadPreset(preset.value)) { this.ctx.toast(`Loaded shortcut preset ${preset.value}.`); render(); } };
    host.querySelector('[data-shortcut-save]')?.addEventListener('click', async () => { const name = await prompt('Save shortcut preset', 'My controller'); if (name) { this.savePreset(name); render(); } });
    host.querySelector('[data-shortcut-delete-preset]')?.addEventListener('click', () => { if (preset?.value) { this.deletePreset(preset.value); render(); } else this.ctx.toast('Choose a preset first.'); });
    const clock = host.querySelector('[data-midi-clock]');
    if (clock) clock.onchange = async () => { this.clock.enabled = clock.checked; if (clock.checked) { try { await this.enableMidi(); } catch (error) { this.ctx.toast(`MIDI unavailable: ${error.message}`, true); } } };
  }
}
