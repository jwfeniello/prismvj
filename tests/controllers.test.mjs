// Akai APC40 (first generation) and APC20 support against a simulated Web MIDI device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchModel, introduction, identityDeviceId, IDENTITY_REQUEST, decode, ledFrame, ringSetup, MODELS, NOTE, CC, LED } from '../src/controllers/apc.js';
import { ControllerManager } from '../src/controllers/manager.js';
import { ShortcutManager } from '../src/ui/shortcuts.js';
import { createProject, createLayer, createClip, Transport } from '../src/model.js';

function fakeAccess(names, { sysex = true } = {}) {
  const sent = new Map();
  const port = (name, type) => ({ id: `${type}-${name}`, name, state: 'connected', type,
    send: message => { if (message[0] === 0xf0 && !sysex) throw new Error('SysEx not allowed'); (sent.get(name) || sent.set(name, []).get(name)).push([...message]); } });
  const access = { inputs: new Map(names.map(name => [name, port(name, 'input')])), outputs: new Map(names.map(name => [name, port(name, 'output')])),
    addEventListener() {}, removeEventListener() {} };
  return { access, sent };
}

function setup({ layers = 3, columns = 8, names = ['Akai APC40'], sysex = true, disabled = [] } = {}) {
  const project = createProject();
  while (project.layers.length < layers) project.layers.push(createLayer(`Layer ${project.layers.length + 1}`));
  project.columns = columns;
  const transport = new Transport(project);
  const calls = [];
  const actions = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, ...args]); } });
  const selection = { layerId: project.layers[0].id, clipId: null };
  const manager = new ControllerManager({
    getProject: () => project, clipsOf: layer => layer.clips[project.selectedDeckId] || [], layerState: id => transport.getState(id),
    selection: () => selection, findClip: () => null, recording: () => false, isEnabled: model => !disabled.includes(model), actions,
  });
  const { access, sent } = fakeAccess(names, { sysex });
  manager.attach(access);
  return { project, transport, manager, calls, sent, selection };
}
const notes = (messages, channel, number) => messages.filter(message => message[0] === (0x90 | channel) && message[1] === number).map(message => message[2]);
const deck = project => project.selectedDeckId;

test('ports are matched by name; the APC40 mkII is left alone', () => {
  assert.equal(matchModel('Akai APC40'), MODELS.apc40);
  assert.equal(matchModel('2- APC40'), MODELS.apc40);
  assert.equal(matchModel('APC40 mkII'), null);
  assert.equal(matchModel('APC40 mk2'), null);
  assert.equal(matchModel('Akai APC20'), MODELS.apc20);
  assert.equal(matchModel('Launchpad X'), null);
  assert.deepEqual(introduction(MODELS.apc40), [0xf0, 0x47, 0x7f, 0x73, 0x60, 0x00, 0x04, 0x41, 0x08, 0x02, 0x01, 0xf7]);
  assert.deepEqual(introduction(MODELS.apc20, 0x41, 3).slice(0, 4), [0xf0, 0x47, 3, 0x7b]);
  // Identity reply: F0 7E <id> 06 02 47 <model> <family> <version x4> <device id> ... F7
  const reply = [0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x7b, 0x00, 0x19, 0x00, 0x01, 0x00, 0x01, 0x05, 0x00, 0xf7];
  assert.equal(identityDeviceId(MODELS.apc20, reply), 5);
  assert.equal(identityDeviceId(MODELS.apc40, reply), null);
  assert.equal(ringSetup(MODELS.apc20).length, 0);
  assert.equal(ringSetup(MODELS.apc40).length, 16);
});

test('controls decode per model: the APC20 Shift is note 0x51, Note Mode is ignored', () => {
  assert.deepEqual(decode([0x93, 0x37, 127]), { kind: 'pad', column: 3, row: 2, pressed: true });
  assert.deepEqual(decode([0x83, 0x37, 0]), { kind: 'pad', column: 3, row: 2, pressed: false });
  assert.deepEqual(decode([0x95, 0x34, 127]), { kind: 'clipStop', column: 5, pressed: true });
  assert.deepEqual(decode([0x90, 0x54, 127]), { kind: 'scene', row: 2, pressed: true });
  assert.equal(decode([0x92, 0x54, 127]), null);
  assert.deepEqual(decode([0x91, 0x33, 127]), { kind: 'trackSelect', strip: 1, pressed: true });
  assert.equal(decode([0x92, 0x32, 127]).kind, 'activator');
  assert.equal(decode([0x92, 0x31, 127]).kind, 'solo');
  assert.equal(decode([0x92, 0x30, 127]).kind, 'arm');
  assert.deepEqual(decode([0x90, 0x51, 127], MODELS.apc40), { kind: 'button', name: 'stopAll', pressed: true });
  assert.deepEqual(decode([0x90, 0x51, 127], MODELS.apc20), { kind: 'button', name: 'shift', pressed: true });
  assert.deepEqual(decode([0x90, 0x62, 127], MODELS.apc40), { kind: 'button', name: 'shift', pressed: true });
  assert.equal(decode([0x90, 0x62, 127], MODELS.apc20)?.name, undefined);
  // APC20 Note Mode: the grid sends channel 10 notes 36-75.
  for (const number of [36, 53, 58, 75]) assert.equal(decode([0x99, number, 127], MODELS.apc20), null);
  assert.deepEqual(decode([0xb4, 0x07, 127]), { kind: 'fader', strip: 4, value: 1 });
  assert.deepEqual(decode([0xb0, 0x0e, 0]), { kind: 'master', value: 0 });
  assert.equal(decode([0xb0, 0x0f, 64], MODELS.apc40).kind, 'crossfader');
  assert.equal(decode([0xb0, 0x0f, 64], MODELS.apc20), null);
  assert.deepEqual(decode([0xb0, 0x2f, 0x7e]), { kind: 'cueLevel', delta: -2 });
  assert.deepEqual(decode([0xb0, 0x32, 127]), { kind: 'trackKnob', index: 2, value: 1 });
  assert.deepEqual(decode([0xb2, 0x17, 0]), { kind: 'deviceKnob', index: 7, value: 0 });
  assert.equal(decode([0xb0, 0x32, 127], MODELS.apc20), null);
  assert.equal(decode([0xe0, 0, 0]), null);
});

test('LED frames: grid rows and columns, the clip stop row, scene buttons and strips', () => {
  const view = { pads: [['empty', 'loaded', 'playing', 'queued', 'missing']], columns: ['loaded', 'empty', 'live'], rows: [{ playing: true }],
    strips: [{ exists: true, active: true, selected: true, solo: false, bus: 'b' }], playing: true, trackRings: [0.5] };
  const frame = ledFrame(MODELS.apc40, view);
  // Top row, columns 0-4 (channel = column).
  assert.deepEqual([0, 1, 2, 3, 4].map(column => frame.get(`${0x90 | column}:${NOTE.pad}`)[2]), [LED.off, LED.amber, LED.green, LED.greenBlink, LED.red]);
  assert.deepEqual([0, 1, 2].map(column => frame.get(`${0x90 | column}:${NOTE.clipStop}`)[2]), [LED.on, LED.off, LED.blink]);
  assert.equal(frame.get(`144:${NOTE.scene}`)[2], LED.on);
  assert.equal(frame.get(`144:${NOTE.trackSelect}`)[2], LED.on);
  assert.equal(frame.get(`144:${NOTE.activator}`)[2], LED.on);
  assert.equal(frame.get(`144:${NOTE.arm}`)[2], LED.blink);
  assert.equal(frame.get(`144:${NOTE.play}`)[2], LED.on);
  assert.equal(frame.get(`176:${CC.trackKnob}`)[2], 64);
  const apc20 = ledFrame(MODELS.apc20, view);
  assert.equal(apc20.has(`144:${NOTE.play}`), false);
  assert.equal(apc20.has(`176:${CC.trackKnob}`), false);
  assert.equal(apc20.size, 8 * 10 + 5 + 1);
});

test('the handshake asks for identity, then uses the reported device id', () => {
  const { manager, sent } = setup({ names: ['Akai APC20'] });
  const messages = sent.get('Akai APC20');
  assert.deepEqual(messages[0], [...IDENTITY_REQUEST]);
  assert.deepEqual(messages[1], introduction(MODELS.apc20, 0x41, 0x7f));
  assert.equal(manager.status()[0].hostMode, true);
  messages.length = 0;
  assert.equal(manager.handle([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x7b, 0x00, 0x19, 0x00, 0x01, 0x00, 0x01, 0x05, 0x00, 0xf7], 'Akai APC20'), true);
  assert.deepEqual(messages[0], introduction(MODELS.apc20, 0x41, 5));
  assert.equal(manager.devices.get('Akai APC20').deviceId, 5);
});

test('the pad grid mirrors the clip bank: top row is the top layer, columns are columns', () => {
  const { project, transport, manager, sent } = setup();
  const messages = sent.get('Akai APC40');
  const [bottom, middle, top] = project.layers;
  // The demo starts with every layer playing column 1; stop them, then play one clip.
  for (const layer of project.layers) transport.stop(layer.id);
  const clip = middle.clips[deck(project)][0];
  transport.trigger(middle.id, clip.id, 0);
  transport.tick(0);
  messages.length = 0;
  manager.sync();
  // Row 2 (middle layer), column 1: playing; the rest of its row has clips in columns 2-4 (amber).
  assert.deepEqual(notes(messages, 0, NOTE.pad + 1), [LED.green]);
  assert.deepEqual(notes(messages, 1, NOTE.pad + 1), [LED.amber]);
  assert.deepEqual(notes(messages, 0, NOTE.pad), [LED.amber]);
  assert.deepEqual(notes(messages, 4, NOTE.pad), [LED.off]);
  assert.deepEqual(notes(messages, 0, NOTE.pad + 3), [LED.off]);
  // Clip stop row lights under columns that have clips; Scene Launch lights for the playing row.
  assert.deepEqual([0, 3, 4].map(column => notes(messages, column, NOTE.clipStop)[0]), [LED.on, LED.on, LED.off]);
  assert.deepEqual([0, 1, 2].map(row => notes(messages, 0, NOTE.scene + row)[0]), [LED.off, LED.on, LED.off]);
  // Unchanged state sends nothing; a change sends only what changed.
  messages.length = 0;
  manager.sync();
  assert.equal(messages.length, 0);
  bottom.bypass = true;
  manager.sync();
  assert.deepEqual(messages, [[0x90, NOTE.activator, LED.off]]);
  assert.ok(top);
});

test('pads, the clip stop row, scene buttons and strips drive PrismVJ; banks scroll', () => {
  const { project, manager, calls } = setup({ layers: 10, columns: 12 });
  const name = 'Akai APC40', topDown = [...project.layers].reverse();
  const topClip = createClip('source', { name: 'Top', source: 'plasma' });
  topDown[0].clips[deck(project)] = [null, topClip];
  // Top row, column 2 = top layer's clip in column 2.
  manager.handle([0x91, NOTE.pad, 127], name);
  manager.handle([0x81, NOTE.pad, 0], name);
  const [press, release] = calls.filter(call => call[0] === 'clip');
  assert.deepEqual(press.slice(0, 4), ['clip', topDown[0].id, topClip.id, true]);
  assert.deepEqual(release.slice(0, 2), ['clip', topDown[0].id]);
  assert.equal(press[4], release[4]);
  // Clip stop row: column trigger with a hold.
  manager.handle([0x92, NOTE.clipStop, 127], name);
  assert.deepEqual(calls.at(-1).slice(0, 3), ['column', 2, true]);
  manager.handle([0x82, NOTE.clipStop, 0], name);
  assert.deepEqual(calls.at(-1).slice(0, 3), ['column', 2, false]);
  // Scene Launch row 2 clears the second layer from the top.
  manager.handle([0x90, NOTE.scene + 1, 127], name);
  assert.deepEqual(calls.at(-1), ['clearLayer', topDown[1].id]);
  // Strips are layers 1-8 from the bottom.
  manager.handle([0xb0, CC.fader, 127], name);
  assert.deepEqual(calls.at(-1), ['setParam', `layer/${project.layers[0].id}/opacity`, 1]);
  manager.handle([0x91, NOTE.trackSelect, 127], name);
  assert.deepEqual(calls.at(-1), ['selectLayer', project.layers[1].id]);
  manager.handle([0x92, NOTE.arm, 127], name);
  assert.deepEqual(calls.at(-1), ['setBus', project.layers[2].id, 'a']);
  // Shift + pad selects without triggering.
  manager.handle([0x90, NOTE.shift, 127], name);
  manager.handle([0x91, NOTE.pad, 127], name);
  assert.deepEqual(calls.at(-1), ['selectClip', topDown[0].id, topClip.id]);
  manager.handle([0x80, NOTE.shift, 0], name);
  manager.handle([0x90, NOTE.stopAll, 127], name);
  assert.deepEqual(calls.at(-1), ['clearAll']);
  // Bank down scrolls rows (10 layers, 5 rows: offsets 0-5); right scrolls columns (12 columns: 0-4).
  manager.handle([0x90, NOTE.down, 127], name);
  manager.handle([0x90, NOTE.right, 127], name);
  assert.deepEqual([manager.devices.get(name).rowOffset, manager.devices.get(name).columnOffset], [1, 1]);
  manager.handle([0x90, NOTE.scene, 127], name);
  assert.deepEqual(calls.at(-1), ['clearLayer', topDown[1].id]);
  manager.handle([0x90, NOTE.shift, 127], name);
  manager.handle([0x90, NOTE.down, 127], name);
  manager.handle([0x90, NOTE.right, 127], name);
  manager.handle([0x80, NOTE.shift, 0], name);
  assert.deepEqual([manager.devices.get(name).rowOffset, manager.devices.get(name).columnOffset], [5, 4]);
  assert.deepEqual(manager.status()[0].window, { top: 5, bottom: 1, firstColumn: 5, lastColumn: 12 });
});

test('an APC20: Shift is note 0x51 (no Stop All), Shift + scene scrolls, no knobs or transport', () => {
  const { manager, sent, calls } = setup({ names: ['Akai APC20'], layers: 12, columns: 10 });
  const name = 'Akai APC20';
  manager.sync();
  assert.equal(sent.get(name).some(message => message[0] === 0x90 && message[1] === NOTE.play), false);
  assert.equal(sent.get(name).some(message => message[0] === 0xb0), false);
  manager.handle([0x90, 0x51, 127], name);
  assert.equal(calls.some(call => call[0] === 'clearAll'), false);
  manager.handle([0x90, NOTE.scene + 1, 127], name);
  manager.handle([0x90, NOTE.scene + 3, 127], name);
  assert.deepEqual([manager.devices.get(name).rowOffset, manager.devices.get(name).columnOffset], [1, 1]);
  manager.handle([0x90, NOTE.scene + 4, 127], name);
  assert.deepEqual([manager.devices.get(name).rowOffset, manager.devices.get(name).columnOffset], [0, 0]);
  manager.handle([0x80, 0x51, 0], name);
  manager.handle([0x90, NOTE.scene, 127], name);
  assert.equal(calls.at(-1)[0], 'clearLayer');
  // Note Mode messages are not consumed by the mapping.
  assert.equal(manager.handle([0x99, 40, 127], name), false);
});

test('without SysEx the LEDs are still driven; disabled models are ignored', () => {
  const blocked = setup({ sysex: false });
  assert.equal(blocked.manager.status()[0].hostMode, false);
  blocked.manager.sync();
  assert.ok(blocked.sent.get('Akai APC40').some(message => message[1] === NOTE.pad));
  const off = setup({ disabled: ['apc40'] });
  assert.equal(off.sent.get('Akai APC40'), undefined);
  assert.equal(off.manager.handle([0x90, NOTE.pad, 127], 'Akai APC40'), false);
});

test('learned MIDI shortcuts take priority; SysEx reaches the controller mapping', () => {
  const project = createProject();
  const routed = [];
  const shortcuts = new ShortcutManager({ getProject: () => project, toast() {}, changed() {}, runAction(path) { routed.push(path); }, onControllerMidi: data => { routed.push(`controller:${data[0] === 0xf0 ? 'sysex' : data[1]}`); return true; } });
  project.shortcuts = [{ id: 's1', source: 'midi', target: 'action/composition/tap', mode: 'trigger', min: 0, max: 1, input: { type: 'note', channel: 0, number: NOTE.pad, device: '' } }];
  shortcuts.handleMidi(new Uint8Array([0x90, NOTE.pad, 127]), 'Akai APC40');
  shortcuts.handleMidi(new Uint8Array([0x90, NOTE.pad + 1, 127]), 'Akai APC40');
  shortcuts.handleMidi(new Uint8Array([0xf0, 0x7e, 0x00, 0x06, 0x02, 0xf7]), 'Akai APC40');
  assert.deepEqual(routed, ['action/composition/tap', `controller:${NOTE.pad + 1}`, 'controller:sysex']);
});