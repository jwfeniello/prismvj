// Native MIDI controller support: finds connected controllers that have a
// built-in mapping (Akai APC40 first generation and APC20), puts them in host
// mode, maps their controls onto PrismVJ, and keeps their LEDs mirroring the
// clip bank. Manual MIDI shortcuts still take priority (see shortcuts.js).
import { matchModel, decode, ledFrame, ringSetup, introduction, identityDeviceId, IDENTITY_REQUEST, COLUMNS, ROWS, STRIPS } from './apc.js';

const BUS_ORDER = ['none', 'a', 'b'];

export class ControllerManager {
  // ctx: { getProject, clipsOf(layer), layerState(layerId), selection() -> { layerId, clipId },
  //   findClip(clipId), recording(), isEnabled(modelId), actions: {...}, onDevicesChange() }
  constructor(ctx) {
    this.ctx = ctx;
    this.devices = new Map();
    this.access = null;
    this.onState = () => this.scan();
  }

  attach(access) {
    if (!access || this.access === access) return;
    this.access?.removeEventListener?.('statechange', this.onState);
    this.access = access;
    access.addEventListener?.('statechange', this.onState);
    this.scan();
  }

  // Pairs each controller input with its output port and introduces it.
  scan() {
    if (!this.access) return;
    const live = port => port && port.state !== 'disconnected';
    const inputs = [...this.access.inputs.values()].filter(live), outputs = [...this.access.outputs.values()].filter(live);
    const seen = new Set();
    for (const input of inputs) {
      const model = matchModel(input.name);
      if (!model) continue;
      const key = input.name || input.id;
      seen.add(key);
      const taken = new Set([...this.devices.values()].filter(device => device.key !== key).map(device => device.output));
      const output = outputs.find(port => port.name === input.name && !taken.has(port)) || outputs.find(port => matchModel(port.name) === model && !taken.has(port)) || null;
      let device = this.devices.get(key);
      if (!device) {
        device = { key, name: input.name || model.name, model, input, output, rowOffset: 0, columnOffset: 0, shift: false, deviceLayer: false, sent: new Map(), ready: false, hostMode: false, deviceId: null, holds: new Map() };
        this.devices.set(key, device);
      } else if (device.output !== output) { device.output = output; device.ready = false; }
      device.input = input;
      if (this.ctx.isEnabled(model.id) && !device.ready && device.output) this.introduce(device);
    }
    for (const key of [...this.devices.keys()]) if (!seen.has(key)) this.devices.delete(key);
    this.ctx.onDevicesChange?.();
  }

  // Asks for the device's identity (its reply carries the device id Ableton
  // uses) and introduces it right away with the all-devices id meanwhile.
  introduce(device) {
    this.send(device, IDENTITY_REQUEST);
    this.enterHostMode(device, device.deviceId ?? 0x7f);
  }

  enterHostMode(device, deviceId) {
    device.hostMode = this.send(device, introduction(device.model, 0x41, deviceId));
    for (const message of ringSetup(device.model)) this.send(device, message);
    device.sent.clear();
    device.ready = true;
    this.ctx.onDevicesChange?.();
  }

  send(device, message) {
    try { device.output?.send(message); return !!device.output; } catch { return false; }
  }

  setEnabled(modelId, enabled) {
    for (const device of this.devices.values()) {
      if (device.model.id !== modelId) continue;
      if (enabled) { device.ready = false; if (device.output) this.introduce(device); }
      else this.blank(device);
    }
  }

  // Raw MIDI from an input; true when a controller mapping used it.
  handle(data, inputName) {
    const device = this.devices.get(inputName);
    if (!device || !this.ctx.isEnabled(device.model.id)) return false;
    if (data?.[0] === 0xf0) {
      const id = identityDeviceId(device.model, data);
      if (id !== null) { device.deviceId = id; this.enterHostMode(device, id); }
      return true;
    }
    const event = decode(data, device.model);
    if (!event) return false;
    this.dispatch(device, event);
    return true;
  }

  // Grid rows are layers from the top of the clip bank down, like the screen.
  topDown() { return [...this.ctx.getProject().layers].reverse(); }
  layerForRow(device, row) { return this.topDown()[device.rowOffset + row] || null; }
  stripLayer(strip) { return this.ctx.getProject().layers[strip] || null; }

  scroll(device, rows, columns) {
    const project = this.ctx.getProject();
    device.rowOffset = Math.max(0, Math.min(Math.max(0, project.layers.length - ROWS), device.rowOffset + rows));
    device.columnOffset = Math.max(0, Math.min(Math.max(0, (project.columns || 8) - COLUMNS), device.columnOffset + columns));
    this.ctx.onDevicesChange?.();
  }

  dispatch(device, event) {
    const actions = this.ctx.actions;
    const holdId = key => `apc:${device.key}:${key}:${performance.now()}`;
    switch (event.kind) {
      case 'pad': {
        const layer = this.layerForRow(device, event.row);
        if (!layer) return;
        const key = `pad:${event.column}:${event.row}`;
        if (!event.pressed) {
          const hold = device.holds.get(key);
          if (hold) { device.holds.delete(key); actions.clip(layer.id, hold.clipId, false, hold.inputId); }
          return;
        }
        const clip = this.ctx.clipsOf(layer)[device.columnOffset + event.column];
        if (device.shift) { if (clip) actions.selectClip(layer.id, clip.id); return; }
        // An empty slot clears the layer, as in Resolume.
        if (!clip) { actions.clearLayer(layer.id); return; }
        const inputId = holdId(key);
        device.holds.set(key, { clipId: clip.id, inputId });
        actions.clip(layer.id, clip.id, true, inputId);
        return;
      }
      case 'clipStop': {
        // The row under the grid triggers the column above it.
        const key = `column:${event.column}`, column = device.columnOffset + event.column;
        if (event.pressed) { const inputId = holdId(key); device.holds.set(key, { inputId }); actions.column(column, true, inputId); }
        else { const hold = device.holds.get(key); if (hold) { device.holds.delete(key); actions.column(column, false, hold.inputId); } }
        return;
      }
      case 'scene': {
        if (!event.pressed) return;
        if (device.shift) {
          // Shift + scene 1-4 scrolls the window (the APC20 has no bank buttons); 5 resets it.
          if (event.row === 0) this.scroll(device, -1, 0);
          else if (event.row === 1) this.scroll(device, 1, 0);
          else if (event.row === 2) this.scroll(device, 0, -1);
          else if (event.row === 3) this.scroll(device, 0, 1);
          else this.scroll(device, -device.rowOffset, -device.columnOffset);
          return;
        }
        // Scene Launch at the end of a row clears that row's layer.
        const layer = this.layerForRow(device, event.row);
        if (layer) actions.clearLayer(layer.id);
        return;
      }
      case 'trackSelect': { const layer = this.stripLayer(event.strip); if (layer && event.pressed) actions.selectLayer(layer.id); return; }
      case 'activator': { const layer = this.stripLayer(event.strip); if (layer && event.pressed) actions.setParam(`layer/${layer.id}/bypass`, layer.bypass ? 0 : 1); return; }
      case 'solo': { const layer = this.stripLayer(event.strip); if (layer && event.pressed) actions.setParam(`layer/${layer.id}/solo`, layer.solo ? 0 : 1); return; }
      case 'arm': { const layer = this.stripLayer(event.strip); if (layer && event.pressed) actions.setBus(layer.id, BUS_ORDER[(BUS_ORDER.indexOf(layer.crossfader || 'none') + 1) % BUS_ORDER.length]); return; }
      case 'fader': { const layer = this.stripLayer(event.strip); if (layer) actions.setParam(`layer/${layer.id}/opacity`, event.value); return; }
      case 'master': actions.setParam('composition/masterOpacity', event.value); return;
      case 'crossfader': actions.setParam('composition/crossfader', event.value); return;
      case 'cueLevel': actions.adjust('composition/speed', event.delta * (device.shift ? 0.05 : 0.01)); return;
      case 'trackKnob': actions.dashboard('composition', null, event.index, event.value); return;
      case 'deviceKnob': {
        const selection = this.ctx.selection();
        if (device.deviceLayer) actions.dashboard('layer', selection.layerId, event.index, event.value);
        else actions.dashboard('clip', selection.clipId, event.index, event.value);
        return;
      }
      case 'footswitch': if (event.pressed) actions.stepColumn(1); return;
      case 'button': return this.button(device, event.name, event.pressed);
      default:
    }
  }

  button(device, name, pressed) {
    const actions = this.ctx.actions;
    if (name === 'shift') { device.shift = pressed; return; }
    if (!pressed) return;
    const page = device.shift;
    switch (name) {
      case 'up': return this.scroll(device, page ? -ROWS : -1, 0);
      case 'down': return this.scroll(device, page ? ROWS : 1, 0);
      case 'left': return this.scroll(device, 0, page ? -COLUMNS : -1);
      case 'right': return this.scroll(device, 0, page ? COLUMNS : 1);
      case 'stopAll': return actions.clearAll();
      case 'master': return actions.selectComposition();
      case 'play': return actions.setPaused(false);
      case 'stop': return page ? actions.resync() : actions.setPaused(true);
      case 'record': return actions.toggleRecording();
      case 'tap': return actions.tap();
      case 'nudgeUp': return actions.nudgeBpm(page ? 1 : 0.1);
      case 'nudgeDown': return actions.nudgeBpm(page ? -1 : -0.1);
      case 'metronome': return actions.resync();
      case 'clipTrack': device.deviceLayer = !device.deviceLayer; return;
      case 'deviceLeft': return actions.stepColumn(-1);
      case 'deviceRight': return actions.stepColumn(1);
      case 'overdub': return actions.toggleBlackout();
      case 'pan': return actions.selectDeck(0);
      case 'sendA': return actions.selectDeck(1);
      case 'sendB': return actions.selectDeck(2);
      case 'sendC': return actions.selectDeck(3);
      default:
    }
  }

  // What the LEDs should show for one controller's window.
  view(device) {
    const project = this.ctx.getProject(), selection = this.ctx.selection();
    const columnCount = project.columns || 8;
    const pads = [], rows = [], columns = new Array(COLUMNS).fill('empty'), strips = [];
    for (let row = 0; row < ROWS; row++) {
      const layer = this.layerForRow(device, row);
      const state = layer ? this.ctx.layerState(layer.id) : null;
      const clips = layer ? this.ctx.clipsOf(layer) : [];
      pads.push(Array.from({ length: COLUMNS }, (_, offset) => {
        const column = device.columnOffset + offset, clip = column < columnCount ? clips[column] : null;
        if (!clip) return 'empty';
        columns[offset] = 'loaded';
        if (state?.clipId === clip.id) return 'playing';
        if (state?.pendingClipId === clip.id) return 'queued';
        return 'loaded';
      }));
      rows.push({ playing: !!state?.clipId });
    }
    for (let strip = 0; strip < STRIPS; strip++) {
      const layer = this.stripLayer(strip);
      strips.push(layer ? { exists: true, active: !layer.bypass, selected: layer.id === selection.layerId, solo: !!layer.solo, bus: layer.crossfader || 'none' } : { exists: false });
    }
    const dials = owner => Array.from({ length: 8 }, (_, index) => Number(owner?.dashboard?.[index]?.value) || 0);
    const deviceOwner = device.deviceLayer ? project.layers.find(layer => layer.id === selection.layerId) : this.ctx.findClip?.(selection.clipId);
    return {
      pads, rows, columns, strips, decks: project.decks.slice(0, 4).map(deck => deck.id === project.selectedDeckId),
      playing: !project.paused, recording: !!this.ctx.recording(), blackout: !!project.blackout, deviceLayer: device.deviceLayer,
      trackRings: dials(project), deviceRings: dials(deviceOwner),
    };
  }

  // Sends only the LEDs that changed since the last call.
  sync() {
    for (const device of this.devices.values()) {
      if (!device.ready || !device.output || !this.ctx.isEnabled(device.model.id)) continue;
      for (const [key, message] of ledFrame(device.model, this.view(device))) {
        if (device.sent.get(key) === message[2]) continue;
        if (this.send(device, message)) device.sent.set(key, message[2]);
      }
    }
  }

  // All LEDs off (on quit or when a controller is turned off in PrismVJ).
  blank(device) {
    const list = device ? [device] : [...this.devices.values()];
    for (const item of list) {
      if (!item.output) continue;
      for (const message of ledFrame(item.model, {}).values()) this.send(item, message);
      item.sent.clear();
      item.ready = false;
    }
  }

  // Layer numbers (1 = bottom) shown on the grid's top and bottom rows.
  window(device) {
    const total = this.ctx.getProject().layers.length;
    const top = total - device.rowOffset, bottom = Math.max(1, top - ROWS + 1);
    return { top: Math.max(0, top), bottom, firstColumn: device.columnOffset + 1, lastColumn: device.columnOffset + COLUMNS };
  }

  status() {
    return [...this.devices.values()].map(device => ({
      key: device.key, name: device.name, model: device.model.id, modelName: device.model.name, connected: !!device.output, hostMode: device.hostMode,
      enabled: this.ctx.isEnabled(device.model.id), rowOffset: device.rowOffset, columnOffset: device.columnOffset, window: this.window(device),
    }));
  }
}