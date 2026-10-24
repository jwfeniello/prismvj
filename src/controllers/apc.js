// Akai APC40 (first generation) and APC20 support. Both share the clip-launch
// layout: an 8x5 pad grid with a Scene Launch button at the end of each row,
// a Clip Stop row under the grid, and a channel strip (Track Select,
// Activator, Solo, Record Arm and a fader) per column. A SysEx introduction
// puts them in Ableton Live mode, where the host lights every LED (green,
// red or amber, steady or blinking). Note numbers, model ids and the
// handshake follow Akai's APC40 protocol and Ableton's APC/APC20 scripts.
//
// PrismVJ layout: the pad grid mirrors the clip bank. Rows are layers (top
// row = top visible layer), columns are columns. The Clip Stop row triggers
// columns, Scene Launch clears its row's layer, and channel strip N controls
// layer N (fader = opacity).

export const MODELS = Object.freeze({
  apc40: Object.freeze({ id: 'apc40', name: 'Akai APC40', modelId: 0x73, shiftNote: 0x62, stopAll: true, knobs: true, crossfader: true, transport: true, bankButtons: true }),
  // The APC20's Shift sends note 0x51, which is Stop All Clips on the APC40.
  apc20: Object.freeze({ id: 'apc20', name: 'Akai APC20', modelId: 0x7b, shiftNote: 0x51, stopAll: false, knobs: false, crossfader: false, transport: false, bankButtons: false }),
});

// Port names: "Akai APC40", "APC40", "2- APC20"... The APC40 mkII ("APC40 mkII")
// uses a different protocol and is not matched here.
export function matchModel(name) {
  const text = String(name || '');
  if (/apc\s*40/i.test(text) && !/mk\s*(ii|2)/i.test(text)) return MODELS.apc40;
  if (/apc\s*20/i.test(text)) return MODELS.apc20;
  return null;
}

export const COLUMNS = 8, ROWS = 5, STRIPS = 8;
export const NOTE = Object.freeze({
  pad: 0x35,            // + row (0-4), channel = column
  clipStop: 0x34, trackSelect: 0x33, activator: 0x32, solo: 0x31, arm: 0x30, // channel = column / strip
  scene: 0x52,          // + row (0-4), channel 0
  stopAll: 0x51, master: 0x50,
  clipTrack: 0x3a, deviceOnOff: 0x3b, deviceLeft: 0x3c, deviceRight: 0x3d, detail: 0x3e, quantize: 0x3f, overdub: 0x40, metronome: 0x41,
  pan: 0x57, sendA: 0x58, sendB: 0x59, sendC: 0x5a,
  play: 0x5b, stop: 0x5c, record: 0x5d,
  up: 0x5e, down: 0x5f, right: 0x60, left: 0x61,
  shift: 0x62, tap: 0x63, nudgeUp: 0x64, nudgeDown: 0x65,
});
export const CC = Object.freeze({ fader: 0x07, master: 0x0e, crossfader: 0x0f, cueLevel: 0x2f, trackKnob: 0x30, trackRing: 0x38, deviceKnob: 0x10, deviceRing: 0x18, footswitch: 0x40 });
export const LED = Object.freeze({ off: 0, green: 1, greenBlink: 2, red: 3, redBlink: 4, amber: 5, amberBlink: 6, on: 1, blink: 2 });
const GLOBAL_BUTTONS = new Map(Object.entries(NOTE).filter(([name]) => !['pad', 'scene', 'clipStop', 'trackSelect', 'activator', 'solo', 'arm', 'shift', 'stopAll'].includes(name)).map(([name, note]) => [note, name]));

// MIDI identity request; the reply carries the device id for the introduction.
export const IDENTITY_REQUEST = Object.freeze([0xf0, 0x7e, 0x00, 0x06, 0x01, 0xf7]);
// Device id from an identity reply for this model, or null.
export function identityDeviceId(model, data) {
  return data?.[0] === 0xf0 && data[3] === 0x06 && data[4] === 0x02 && data[5] === 0x47 && data[6] === model.modelId && data.length > 13 ? data[13] : null;
}
// Mode byte: 0x40 generic, 0x41 Ableton Live, 0x42 alternate Ableton Live.
export function introduction(model, mode = 0x41, deviceId = 0x7f) {
  return [0xf0, 0x47, deviceId & 0x7f, model.modelId, 0x60, 0x00, 0x04, mode, 0x08, 0x02, 0x01, 0xf7];
}

// One incoming MIDI message -> a control event, or null. Note Mode on the
// APC20 sends the grid on channel 10; those notes are ignored here.
export function decode(data, model = MODELS.apc40) {
  const [status, a = 0, b = 0] = data || [];
  const kind = status & 0xf0, channel = status & 0x0f;
  if (kind === 0x90 || kind === 0x80) {
    const pressed = kind === 0x90 && b > 0;
    if (channel < COLUMNS) {
      if (a >= NOTE.pad && a < NOTE.pad + ROWS) return { kind: 'pad', column: channel, row: a - NOTE.pad, pressed };
      if (a === NOTE.clipStop) return { kind: 'clipStop', column: channel, pressed };
      if (a === NOTE.trackSelect) return { kind: 'trackSelect', strip: channel, pressed };
      if (a === NOTE.activator) return { kind: 'activator', strip: channel, pressed };
      if (a === NOTE.solo) return { kind: 'solo', strip: channel, pressed };
      if (a === NOTE.arm) return { kind: 'arm', strip: channel, pressed };
    }
    if (channel !== 0) return null;
    if (a >= NOTE.scene && a < NOTE.scene + ROWS) return { kind: 'scene', row: a - NOTE.scene, pressed };
    if (a === model.shiftNote) return { kind: 'button', name: 'shift', pressed };
    if (a === NOTE.stopAll && model.stopAll) return { kind: 'button', name: 'stopAll', pressed };
    const name = GLOBAL_BUTTONS.get(a);
    return name ? { kind: 'button', name, pressed } : null;
  }
  if (kind === 0xb0) {
    const value = b / 127;
    if (a === CC.fader && channel < STRIPS) return { kind: 'fader', strip: channel, value };
    if (channel !== 0 && !(a >= CC.deviceKnob && a < CC.deviceKnob + 8)) return null;
    if (a === CC.master) return { kind: 'master', value };
    if (a === CC.crossfader && model.crossfader) return { kind: 'crossfader', value };
    if (a === CC.cueLevel) return { kind: 'cueLevel', delta: b < 64 ? b : b - 128 };
    if (model.knobs && a >= CC.trackKnob && a < CC.trackKnob + 8) return { kind: 'trackKnob', index: a - CC.trackKnob, value };
    if (model.knobs && a >= CC.deviceKnob && a < CC.deviceKnob + 8) return { kind: 'deviceKnob', index: a - CC.deviceKnob, value };
    if (a === CC.footswitch) return { kind: 'footswitch', pressed: b > 63 };
  }
  return null;
}

const PAD_LED = { empty: LED.off, loaded: LED.amber, playing: LED.green, queued: LED.greenBlink, missing: LED.red };

// The full LED picture for a view of PrismVJ's state, as MIDI messages keyed
// by "status:number" so only changes need sending.
// view: { pads[row][column]: 'empty'|'loaded'|'playing'|'queued'|'missing',
//   rows[row]: { playing }  (Scene Launch: lit while the row's layer plays),
//   columns[column]: 'empty'|'loaded'|'live' (Clip Stop: column has clips / last triggered),
//   strips[strip]: { exists, active, selected, solo, bus: 'none'|'a'|'b' },
//   decks[0-3]: bool, playing, recording, blackout, deviceLayer, trackRings[8], deviceRings[8] (0..1) }
export function ledFrame(model, view) {
  const frame = new Map();
  const note = (channel, number, value) => frame.set(`${0x90 | channel}:${number}`, [0x90 | channel, number, value]);
  const cc = (channel, number, value) => frame.set(`${0xb0 | channel}:${number}`, [0xb0 | channel, number, value]);
  for (let column = 0; column < COLUMNS; column++) {
    for (let row = 0; row < ROWS; row++) note(column, NOTE.pad + row, PAD_LED[view.pads?.[row]?.[column]] ?? LED.off);
    const state = view.columns?.[column];
    note(column, NOTE.clipStop, state === 'live' ? LED.blink : state === 'loaded' ? LED.on : LED.off);
    const strip = view.strips?.[column] || {};
    note(column, NOTE.trackSelect, strip.selected ? LED.on : LED.off);
    note(column, NOTE.activator, strip.exists && strip.active ? LED.on : LED.off);
    note(column, NOTE.solo, strip.solo ? LED.on : LED.off);
    note(column, NOTE.arm, strip.bus === 'a' ? LED.on : strip.bus === 'b' ? LED.blink : LED.off);
  }
  for (let row = 0; row < ROWS; row++) note(0, NOTE.scene + row, view.rows?.[row]?.playing ? LED.on : LED.off);
  note(0, NOTE.master, LED.off);
  if (model.transport) {
    note(0, NOTE.play, view.playing ? LED.on : LED.off);
    note(0, NOTE.stop, view.playing ? LED.off : LED.on);
    note(0, NOTE.record, view.recording ? LED.on : LED.off);
    note(0, NOTE.overdub, view.blackout ? LED.blink : LED.off);
    note(0, NOTE.clipTrack, view.deviceLayer ? LED.on : LED.off);
    [NOTE.pan, NOTE.sendA, NOTE.sendB, NOTE.sendC].forEach((number, index) => note(0, number, view.decks?.[index] ? LED.on : LED.off));
  }
  if (model.knobs) {
    for (let index = 0; index < 8; index++) {
      cc(0, CC.trackKnob + index, Math.round((view.trackRings?.[index] ?? 0) * 127));
      cc(0, CC.deviceKnob + index, Math.round((view.deviceRings?.[index] ?? 0) * 127));
    }
  }
  return frame;
}

// Knob LED ring styles, sent once after the introduction: 1 = single dot.
export function ringSetup(model) {
  if (!model.knobs) return [];
  const messages = [];
  for (let index = 0; index < 8; index++) messages.push([0xb0, CC.trackRing + index, 1], [0xb0, CC.deviceRing + index, 1]);
  return messages;
}