import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createClip, validateProject, serializeProject, Transport, LIMITS } from '../src/model.js';
import { columnCount, addDeck, removeDeck, renameDeck, moveDeck, addLayer, removeLayer, moveLayer,
  setColumnCount, insertColumn, removeColumn, getSlot, findClipSlot, moveClip, copyClip, cutClip, pasteClip } from '../src/composition.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ~= ${expected}`);

function fixture() {
  const project = createProject();
  for (const layer of project.layers) {
    layer.activeClipId = null;
    for (const deck of project.decks) layer.clips[deck.id].fill(null);
  }
  const address = (layer = 0, column = 0, deck = 0) => ({ layerId: project.layers[layer].id, deckId: project.decks[deck].id, column });
  const a = createClip('video', { name: 'A', duration: 10, audio: { id: 'audio-a', url: 'blob:audio', duration: 10 },
    mask: { id: 'mask-a', url: 'blob:mask' }, effects: [{ id: 'effect-a', type: 'invert', amount: 0.3 }] });
  const b = createClip('source', { name: 'B', duration: 5 });
  project.layers[0].clips[project.decks[0].id][0] = a;
  project.layers[1].clips[project.decks[0].id][1] = b;
  const transport = new Transport(project);
  return { project, a, b, address, transport };
}

test('deck insert, rename, reorder and delete preserve unrelated running clips', () => {
  const { project, a, address, transport } = fixture();
  transport.trigger(address().layerId, a.id, 0); transport.tick(2);
  const currentDeckId = project.selectedDeckId;
  const inserted = addDeck(project, 'Inserted', 0);
  assert.equal(project.decks[0], inserted);
  for (const layer of project.layers) assert.deepEqual(layer.clips[inserted.id], Array(8).fill(null));
  renameDeck(project, inserted.id, '  New title  '); assert.equal(inserted.name, 'New title');
  moveDeck(project, inserted.id, 2); assert.equal(project.decks[2], inserted);
  removeDeck(project, inserted.id);
  assert.equal(project.selectedDeckId, currentDeckId);
  close(transport.tick(3)[0].position, 0.3);
  removeDeck(project, currentDeckId);
  assert.equal(transport.tick(4).length, 0);
  assert.ok(project.decks.some(deck => deck.id === project.selectedDeckId));
  assert.throws(() => removeDeck(project, project.decks[0].id), /at least one deck/);
  assert.doesNotThrow(() => validateProject(project));
});

test('layer insertion and reordering keep object identity and active playheads', () => {
  const { project, a, address, transport } = fixture();
  const playing = project.layers[0];
  transport.trigger(playing.id, a.id, 0); transport.tick(1);
  const layer = addLayer(project, 'Inserted', 1);
  assert.equal(project.layers[1], layer);
  assert.ok(project.decks.every(deck => layer.clips[deck.id].length === project.columns));
  moveLayer(project, playing.id, 3); assert.equal(project.layers[3], playing);
  close(transport.tick(2)[0].position, 0.2);
  removeLayer(project, layer.id); assert.equal(transport.getState(layer.id), null);
  close(transport.getState(playing.id).position, 0.2);
  while (project.layers.length > 1) removeLayer(project, project.layers[0].id);
  assert.throws(() => removeLayer(project, address().layerId), /at least one layer/);
});

test('column resizing and insertion apply across all decks without truncating live clips', () => {
  const { project, a, address, transport } = fixture();
  transport.trigger(address().layerId, a.id, 0); transport.tick(1);
  setColumnCount(project, 12); insertColumn(project, 0);
  assert.equal(project.columns, 13);
  assert.equal(getSlot(project, address(0, 1)).clip, a);
  for (const layer of project.layers) for (const deck of project.decks) assert.equal(layer.clips[deck.id].length, 13);
  close(transport.tick(2)[0].position, 0.2);
  const snapshot = JSON.stringify(project);
  assert.throws(() => setColumnCount(project, 1), /contain clips/);
  assert.equal(JSON.stringify(project), snapshot);
  const removed = removeColumn(project, 1);
  assert.equal(removed[0].clip, a); assert.equal(project.layers[0].activeClipId, null);
  assert.equal(transport.tick(3).length, 0);
  setColumnCount(project, 2);
  assert.equal(columnCount(project), 2);
  assert.equal(validateProject(project).columns, 2);
});

test('column boundary failures are atomic and cannot remove the last column', () => {
  const { project } = fixture();
  setColumnCount(project, LIMITS.columns);
  const snapshot = JSON.stringify(project);
  for (const action of [() => insertColumn(project), () => setColumnCount(project, 0), () => removeColumn(project, -1), () => setColumnCount(project, 2.5)]) assert.throws(action, RangeError);
  assert.equal(JSON.stringify(project), snapshot);
  for (const layer of project.layers) for (const deck of project.decks) layer.clips[deck.id].fill(null);
  setColumnCount(project, 1);
  assert.throws(() => removeColumn(project, 0), /at least one column/);
});

test('moves within or between decks retain active object and transport time', () => {
  const { project, a, address, transport } = fixture();
  transport.trigger(address().layerId, a.id, 0); transport.tick(2);
  moveClip(project, address(), address(0, 4, 1));
  assert.equal(getSlot(project, address()).clip, null);
  assert.equal(getSlot(project, address(0, 4, 1)).clip, a);
  assert.deepEqual(findClipSlot(project, a.id), address(0, 4, 1));
  close(transport.tick(3)[0].position, 0.3);
});

test('swapping two playing clips between layers preserves both playheads in either order', () => {
  for (const backwards of [false, true]) {
    const { project, a, b, address, transport } = fixture();
    transport.trigger(address().layerId, a.id, 0); transport.trigger(address(1).layerId, b.id, 0);
    transport.tick(2);
    moveClip(project, backwards ? address(1, 1) : address(), backwards ? address() : address(1, 1));
    transport.tick(3);
    assert.equal(transport.getState(address().layerId).clipId, b.id);
    assert.equal(transport.getState(address(1).layerId).clipId, a.id);
    close(transport.getState(address().layerId).position, 0.6);
    close(transport.getState(address(1).layerId).position, 0.3);
  }
});

test('moving an active clip to an idle layer follows playback without restart', () => {
  const { project, a, address, transport } = fixture();
  transport.trigger(address().layerId, a.id, 0); transport.tick(2);
  moveClip(project, address(), address(2, 3));
  const frames = transport.tick(3);
  assert.equal(frames.length, 1); assert.equal(frames[0].layer.id, address(2).layerId); close(frames[0].position, 0.3);
});

test('an unrelated playing destination clip is not interrupted by clip editing', () => {
  const { project, a, b, address, transport } = fixture();
  transport.trigger(address().layerId, a.id, 0); transport.trigger(address(1).layerId, b.id, 0); transport.tick(2);
  moveClip(project, address(), address(1, 4));
  const frames = transport.tick(3);
  assert.equal(frames.length, 1); assert.equal(frames[0].clip.id, b.id); close(frames[0].position, 0.6);
});

test('moving a quantized queued clip preserves its launch beat on the new layer', () => {
  const { project, a, address, transport } = fixture();
  a.quantize = 4;
  transport.trigger(address().layerId, a.id, 0.2);
  moveClip(project, address(), address(2, 3));
  assert.equal(transport.getState(address().layerId).pendingClipId, null);
  assert.equal(transport.getState(address(2).layerId).pendingClipId, a.id);
  const frames = transport.tick(2.5);
  assert.equal(frames.length, 1); assert.equal(frames[0].layer.id, address(2).layerId);
  close(frames[0].position, 0.05);
});

test('copy paste makes independent clip, media, cue, and effect identities', () => {
  const { project, a, address } = fixture();
  const clipboard = copyClip(project, address());
  a.name = 'Changed after copy'; a.effects[0].amount = 0.7;
  const pasted = pasteClip(project, address(0, 2), clipboard);
  assert.notEqual(pasted.id, a.id); assert.equal(pasted.name, 'A');
  assert.notEqual(pasted.audio.id, a.audio.id); assert.equal(pasted.audio.url, a.audio.url);
  assert.notEqual(pasted.mask.id, a.mask.id); assert.notEqual(pasted.effects[0].id, a.effects[0].id);
  assert.equal(pasted.effects[0].amount, 0.3);
  pasted.cues[0] = 0.9; pasted.effects[0].amount = 0.1; pasted.mask.invert = true;
  assert.equal(a.cues[0], 0); assert.equal(a.effects[0].amount, 0.7); assert.equal(a.mask.invert, false);
  const again = pasteClip(project, address(1, 5), clipboard);
  assert.notEqual(again.audio.id, pasted.audio.id); assert.equal(again.cues[0], 0);
  assert.doesNotThrow(() => validateProject(serializeProject(project)));
});

test('cut keeps playing until paste, tracks moves, swaps occupied cells, and then copies', () => {
  const { project, a, b, address, transport } = fixture();
  transport.trigger(address().layerId, a.id, 0); transport.tick(1);
  const clipboard = cutClip(project, address());
  close(transport.tick(2)[0].position, 0.2);
  moveClip(project, address(), address(0, 7, 1));
  assert.equal(pasteClip(project, address(1, 1), clipboard), a);
  assert.equal(getSlot(project, address(0, 7, 1)).clip, b);
  close(transport.tick(3)[0].position, 0.3);
  const second = pasteClip(project, address(2, 6), clipboard);
  assert.notEqual(second.id, a.id); assert.equal(getSlot(project, address(1, 1)).clip, a);
});

test('cut snapshot can be pasted after its deck is deleted or in another composition', () => {
  const f = fixture(); const clipboard = cutClip(f.project, f.address());
  removeDeck(f.project, f.project.decks[0].id);
  const pasted = pasteClip(f.project, f.address(0, 0), clipboard);
  assert.equal(pasted.name, f.a.name); assert.notEqual(pasted.id, f.a.id);
  const other = fixture(); const cross = cutClip(other.project, other.address());
  const copy = pasteClip(f.project, f.address(0, 1), cross);
  assert.notEqual(copy.id, other.a.id); assert.equal(getSlot(other.project, other.address()).clip, other.a);
});

test('invalid addresses and operations do not lose clips', () => {
  const { project, address } = fixture();
  const snapshot = JSON.stringify(project);
  const invalid = { ...address(), column: LIMITS.columns };
  assert.throws(() => moveClip(project, address(), invalid));
  assert.throws(() => pasteClip(project, invalid, cutClip(project, address())));
  assert.throws(() => moveClip(project, address(0, 6), address()));
  assert.throws(() => moveLayer(project, address().layerId, 99));
  assert.throws(() => addDeck(project, 'Bad', -1));
  assert.equal(JSON.stringify(project), snapshot);
});
