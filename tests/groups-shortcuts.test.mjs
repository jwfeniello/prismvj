import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createGroup, validateProject, serializeProject, Transport, LIMITS } from '../src/model.js';
import { createGroupForLayer, setLayerGroup, ungroup, duplicateLayer, clearLayerClips, removeLayer, pruneGroups } from '../src/composition.js';
import { ShortcutManager, describeInput } from '../src/ui/shortcuts.js';

const contiguous = (project, groupId) => {
  const indexes = project.layers.map((layer, index) => layer.groupId === groupId ? index : -1).filter(index => index >= 0);
  return indexes.every((value, i) => i === 0 || value === indexes[i - 1] + 1);
};

test('groups stay contiguous as layers join and leave, and never stay empty', () => {
  const project = createProject();
  const [a, b, c] = project.layers;
  const group = createGroupForLayer(project, a.id);
  setLayerGroup(project, c.id, group.id);
  assert.ok(contiguous(project, group.id));
  assert.deepEqual(project.layers.filter(layer => layer.groupId === group.id).map(layer => layer.id), [a.id, c.id]);
  setLayerGroup(project, b.id, group.id);
  setLayerGroup(project, c.id, null);
  assert.ok(contiguous(project, group.id));
  setLayerGroup(project, a.id, null); setLayerGroup(project, b.id, null);
  assert.equal(project.groups.length, 0);
  const second = createGroupForLayer(project, b.id);
  ungroup(project, second.id);
  assert.equal(project.groups.length, 0);
  assert.throws(() => setLayerGroup(project, a.id, 'missing'), /does not exist/);
});

test('validation keeps groups with members, drops empty or dangling ones and enforces limits', () => {
  const project = createProject();
  const group = createGroup('Main'), empty = createGroup('Empty');
  project.groups.push(group, empty);
  project.layers[0].groupId = group.id; project.layers[1].groupId = 'ghost';
  group.opacity = 7; group.speed = -1; group.effects.push({ id: 'g-fx', type: 'blur', params: { radius: 2 } });
  const result = validateProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(result.groups.map(item => item.id), [group.id]);
  assert.equal(result.groups[0].opacity, 1); assert.equal(result.groups[0].speed, 0);
  assert.equal(result.layers[1].groupId, null);
  assert.equal(result.groups[0].effects[0].type, 'blur');
  assert.throws(() => validateProject({ ...createProject(), groups: Array.from({ length: LIMITS.groups + 1 }, () => createGroup()) }), /limit/);
  assert.ok(serializeProject(result).groups.length === 1);
});

test('group speed scales the transport of its layers only', () => {
  const project = createProject();
  const group = createGroup('Fast'); group.speed = 2; project.groups.push(group);
  const deck = project.selectedDeckId, [a, b] = project.layers;
  a.groupId = group.id;
  const transport = new Transport(project);
  transport.trigger(a.id, a.clips[deck][1].id, 0); transport.trigger(b.id, b.clips[deck][1].id, 0);
  transport.tick(0); transport.tick(1);
  const fast = transport.getState(a.id), normal = transport.getState(b.id);
  assert.ok(Math.abs(fast.time - 2 * normal.time) < 1e-6, `${fast.time} vs ${normal.time}`);
});

test('duplicate and clear layer keep identities independent', () => {
  const project = createProject();
  const source = project.layers[0], deck = project.selectedDeckId;
  const copy = duplicateLayer(project, source.id);
  assert.equal(project.layers[1], copy);
  assert.notEqual(copy.clips[deck][0].id, source.clips[deck][0].id);
  assert.equal(copy.activeClipId, null);
  clearLayerClips(project, copy.id);
  assert.ok(copy.clips[deck].every(clip => clip === null));
  assert.ok(source.clips[deck].some(Boolean));
  const ids = new Set(); for (const layer of project.layers) for (const clip of Object.values(layer.clips).flat()) if (clip) { assert.ok(!ids.has(clip.id)); ids.add(clip.id); }
  removeLayer(project, copy.id); pruneGroups(project);
  validateProject(project);
});

function manager(project, actions = []) {
  return new ShortcutManager({ getProject: () => project, toast: () => {}, changed: () => {}, runAction: (path, pressed) => actions.push([path, pressed]), targetFor: () => null });
}

test('keyboard shortcuts toggle, hold momentarily and trigger actions', () => {
  const project = createProject(), actions = [];
  const shortcuts = manager(project, actions);
  project.shortcuts = [
    { id: 's1', source: 'key', target: 'composition/blackout', mode: 'toggle', input: { code: 'Space' }, min: 0, max: 1, invert: false, enabled: true },
    { id: 's2', source: 'key', target: `layer/${project.layers[0].id}/opacity`, mode: 'momentary', input: { code: 'KeyM' }, min: 0, max: 1, invert: false, enabled: true },
    { id: 's3', source: 'key', target: 'action/column/2', mode: 'trigger', input: { code: 'KeyC', shift: true }, min: 0, max: 1, enabled: true },
  ];
  const key = (code, extra = {}) => ({ code, shiftKey: false, ctrlKey: false, altKey: false, repeat: false, preventDefault() {}, ...extra });
  assert.ok(shortcuts.handleKey(key('Space'), true)); shortcuts.handleKey(key('Space'), false);
  assert.equal(project.blackout, true);
  shortcuts.handleKey(key('Space'), true);
  assert.equal(project.blackout, false);
  shortcuts.handleKey(key('KeyM'), true); assert.equal(project.layers[0].opacity, 1);
  shortcuts.handleKey(key('KeyM'), false); assert.equal(project.layers[0].opacity, 0);
  assert.equal(shortcuts.handleKey(key('KeyC'), true), false);
  assert.ok(shortcuts.handleKey(key('KeyC', { shiftKey: true }), true));
  shortcuts.handleKey(key('KeyC'), false);
  assert.deepEqual(actions, [['action/column/2', true], ['action/column/2', false]]);
  assert.equal(describeInput(project.shortcuts[2]), 'Shift+C');
});

test('MIDI shortcuts map ranges, invert, relative encoders and clock tempo', () => {
  const project = createProject();
  const shortcuts = manager(project);
  let bpm = null;
  shortcuts.ctx.onClockBPM = value => { bpm = value; };
  project.shortcuts = [
    { id: 'm1', source: 'midi', target: 'composition/crossfader', mode: 'value', input: { type: 'cc', channel: 0, number: 7, device: '' }, min: 0.25, max: 0.75, invert: false, enabled: true },
    { id: 'm2', source: 'midi', target: 'composition/masterOpacity', mode: 'value', input: { type: 'cc', channel: 1, number: 7, device: '' }, min: 0, max: 1, invert: true, enabled: true },
    { id: 'm3', source: 'midi', target: 'composition/speed', mode: 'relative', input: { type: 'cc', channel: 0, number: 20, device: '' }, min: 0, max: 1, enabled: true },
  ];
  shortcuts.handleMidi([0xb0, 7, 127], 'APC');
  assert.equal(project.crossfader, 0.75);
  shortcuts.handleMidi([0xb1, 7, 127], 'APC');
  assert.equal(project.masterOpacity, 0);
  const before = project.speed;
  shortcuts.handleMidi([0xb0, 20, 1], 'APC'); assert.ok(project.speed > before);
  shortcuts.handleMidi([0xb0, 20, 127], 'APC'); assert.ok(Math.abs(project.speed - before) < 1e-9);
  shortcuts.clock.enabled = true;
  const original = performance.now;
  let now = 0; performance.now = () => now;
  try { for (let i = 0; i < 49; i++) { now = i * (500 / 24); shortcuts.handleMidi([0xf8]); } } finally { performance.now = original; }
  assert.equal(bpm, 120);
});

test('learn mode assigns the next input to the selected control and replaces duplicates', () => {
  const project = createProject();
  const shortcuts = manager(project);
  shortcuts.editing = 'midi'; shortcuts.selected = 'composition/masterVolume';
  shortcuts.handleMidi([0xb0, 10, 64], '');
  shortcuts.selected = 'composition/crossfader';
  shortcuts.handleMidi([0xb0, 10, 30], '');
  assert.equal(project.shortcuts.length, 1);
  assert.equal(project.shortcuts[0].target, 'composition/crossfader');
  assert.equal(project.shortcuts[0].mode, 'value');
  const saved = validateProject(JSON.parse(JSON.stringify(project)));
  assert.equal(saved.shortcuts[0].input.number, 10);
});
