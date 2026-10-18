// In-place composition editing keeps the live transport and decoder references
// intact. Validate every destination before changing a source or a row.
import { createClip, createLayer, createGroup, LIMITS } from './model.js';
import { visibleSlot, reconcilePersistent } from './persistent-clips.js';

let sequence = 0;
const uid = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${++sequence}`}`;
const nameOf = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : fallback;
const indexOf = (items, id, label) => {
  const index = items.findIndex(item => item.id === id);
  if (index < 0) throw new RangeError(`${label} does not exist.`);
  return index;
};
const indexIn = (index, end, label = 'Position') => {
  if (!Number.isInteger(index) || index < 0 || index > end) throw new RangeError(`${label} must be between 0 and ${end}.`);
  return index;
};

export function columnCount(project) {
  let count = Number.isInteger(project.columns) ? project.columns : 8;
  for (const layer of project.layers) for (const deck of project.decks) count = Math.max(count, layer.clips[deck.id]?.length || 0);
  if (count < 1 || count > LIMITS.columns) throw new RangeError(`Column count must be between 1 and ${LIMITS.columns}.`);
  return count;
}

function rows(project) {
  return project.layers.flatMap(layer => project.decks.map(deck => ({ layer, deckId: deck.id, slots: layer.clips[deck.id] || [] })));
}

function alignRows(project, count) {
  for (const { layer, deckId, slots } of rows(project)) {
    while (slots.length < count) slots.push(null);
    layer.clips[deckId] = slots;
  }
  project.columns = count;
}

export function setColumnCount(project, count) {
  indexIn(count, LIMITS.columns, 'Column count');
  if (!count) throw new RangeError('A composition needs at least one column.');
  const entries = rows(project);
  if (entries.some(({ slots }) => slots.slice(count).some(Boolean))) throw new RangeError('Columns contain clips. Remove those columns explicitly before reducing their count.');
  for (const { layer, deckId, slots } of entries) {
    slots.length = Math.min(slots.length, count);
    while (slots.length < count) slots.push(null);
    layer.clips[deckId] = slots;
  }
  project.columns = count;
  return count;
}

export function insertColumn(project, index = columnCount(project)) {
  const count = columnCount(project);
  indexIn(index, count, 'Column');
  if (count >= LIMITS.columns) throw new RangeError(`A composition can have at most ${LIMITS.columns} columns.`);
  alignRows(project, count);
  for (const { slots } of rows(project)) slots.splice(index, 0, null);
  project.columns++;
  return index;
}

export function removeColumn(project, index) {
  const count = columnCount(project);
  indexIn(index, count - 1, 'Column');
  if (count === 1) throw new RangeError('A composition needs at least one column.');
  alignRows(project, count);
  const removed = [];
  for (const { layer, deckId, slots } of rows(project)) {
    const [clip] = slots.splice(index, 1);
    if (clip) {
      removed.push({ layerId: layer.id, deckId, column: index, clip });
      if (layer.activeClipId === clip.id) layer.activeClipId = null;
    }
  }
  project.columns--;
  return removed;
}

export function addDeck(project, name, index = project.decks.length) {
  indexIn(index, project.decks.length);
  if (project.decks.length >= LIMITS.decks) throw new RangeError(`A composition can have at most ${LIMITS.decks} decks.`);
  const count = columnCount(project);
  const deck = { id: uid('deck'), name: nameOf(name, `Deck ${project.decks.length + 1}`) };
  alignRows(project, count);
  project.decks.splice(index, 0, deck);
  for (const layer of project.layers) layer.clips[deck.id] = Array(count).fill(null);
  return deck;
}

export function removeDeck(project, deckId) {
  const index = indexOf(project.decks, deckId, 'Deck');
  if (project.decks.length === 1) throw new RangeError('A composition needs at least one deck.');
  const [deck] = project.decks.splice(index, 1);
  for (const layer of project.layers) {
    if (layer.clips[deckId]?.some(clip => clip?.id === layer.activeClipId)) layer.activeClipId = null;
    delete layer.clips[deckId];
  }
  if (project.selectedDeckId === deckId) project.selectedDeckId = project.decks[Math.min(index, project.decks.length - 1)].id;
  return deck;
}

export function renameDeck(project, deckId, name) {
  const deck = project.decks[indexOf(project.decks, deckId, 'Deck')];
  deck.name = nameOf(name, deck.name);
  return deck;
}

function moveItem(items, id, targetIndex, label) {
  const sourceIndex = indexOf(items, id, label);
  indexIn(targetIndex, items.length - 1);
  const [item] = items.splice(sourceIndex, 1);
  items.splice(targetIndex, 0, item);
  return item;
}

export function moveDeck(project, deckId, targetIndex) { return moveItem(project.decks, deckId, targetIndex, 'Deck'); }

export function addLayer(project, name, index = project.layers.length) {
  indexIn(index, project.layers.length);
  if (project.layers.length >= LIMITS.layers) throw new RangeError(`A composition can have at most ${LIMITS.layers} layers.`);
  const count = columnCount(project);
  const layer = createLayer(nameOf(name, `Layer ${project.layers.length + 1}`));
  alignRows(project, count);
  for (const deck of project.decks) layer.clips[deck.id] = Array(count).fill(null);
  project.layers.splice(index, 0, layer);
  return layer;
}

export function removeLayer(project, layerId) {
  const index = indexOf(project.layers, layerId, 'Layer');
  if (project.layers.length === 1) throw new RangeError('A composition needs at least one layer.');
  return project.layers.splice(index, 1)[0];
}

export function moveLayer(project, layerId, targetIndex) { return moveItem(project.layers, layerId, targetIndex, 'Layer'); }

export function getSlot(project, address) {
  if (!address || typeof address !== 'object') throw new TypeError('A clip slot address is required.');
  const layer = project.layers[indexOf(project.layers, address.layerId, 'Layer')];
  indexOf(project.decks, address.deckId, 'Deck');
  indexIn(address.column, columnCount(project) - 1, 'Column');
  return { layer, deckId: address.deckId, column: address.column, clip: layer.clips[address.deckId]?.[address.column] || null };
}

export function findClipSlot(project, clipId) {
  for (const layer of project.layers) for (const deck of project.decks) {
    const column = layer.clips[deck.id]?.findIndex(clip => clip?.id === clipId) ?? -1;
    if (column >= 0) return { layerId: layer.id, deckId: deck.id, column };
  }
  return null;
}

function put(slot, clip) {
  if (!slot.layer.clips[slot.deckId]) slot.layer.clips[slot.deckId] = [];
  const slots = slot.layer.clips[slot.deckId];
  while (slots.length <= slot.column) slots.push(null);
  slots[slot.column] = clip;
}

export function moveClip(project, from, to, { swap = true } = {}) {
  const source = getSlot(project, from);
  const target = getSlot(project, to);
  if (!source.clip) throw new RangeError('The source clip slot is empty.');
  if (source.layer === target.layer && source.deckId === target.deckId && source.column === target.column) return source.clip;
  if (visibleSlot(project, target.layer, target.deckId, target.column).persistentFrom &&
      visibleSlot(project, target.layer, target.deckId, target.column).persistentFrom !== target.deckId)
    throw new RangeError('The destination is covered by a persistent clip. Move the covered clip or turn off persistence first.');
  const sourceActive = source.layer.activeClipId === source.clip.id;
  const targetActive = !!target.clip && target.layer.activeClipId === target.clip.id;
  put(source, swap ? target.clip : null);
  put(target, source.clip);
  reconcilePersistent(project, target.clip);
  reconcilePersistent(project, source.clip);
  if (source.layer === target.layer) {
    if (!swap && targetActive) target.layer.activeClipId = null;
  } else {
    // An already playing unrelated clip in the destination keeps playing. When
    // both swapped clips are active, both playheads migrate to their new layers.
    if (sourceActive) source.layer.activeClipId = null;
    if (targetActive) target.layer.activeClipId = null;
    if (sourceActive && !target.layer.activeClipId) target.layer.activeClipId = source.clip.id;
    if (swap && targetActive && !source.layer.activeClipId) source.layer.activeClipId = target.clip.id;
  }
  return source.clip;
}

function cloneClip(clip, freshIds = false) {
  const copy = createClip(clip.kind, clip);
  if (freshIds) {
    copy.persistent = false;
    copy.id = uid('clip');
    if (copy.audio) copy.audio.id = uid('audio');
    if (copy.mask) copy.mask.id = uid('mask');
    for (const effect of [...copy.effects, ...copy.audioEffects]) effect.id = uid('effect');
  }
  return copy;
}

export function copyClip(project, from) {
  const { clip } = getSlot(project, from);
  if (!clip) throw new RangeError('The source clip slot is empty.');
  return { version: 1, mode: 'copy', projectId: project.id, clipId: clip.id, from: { ...from }, clip: cloneClip(clip) };
}

export function cutClip(project, from) {
  const clipboard = copyClip(project, from);
  clipboard.mode = 'cut';
  return clipboard;
}

export function pasteClip(project, to, clipboard) {
  const target = getSlot(project, to);
  if (visibleSlot(project, target.layer, target.deckId, target.column).persistentFrom &&
      visibleSlot(project, target.layer, target.deckId, target.column).persistentFrom !== target.deckId)
    throw new RangeError('The destination is covered by a persistent clip. Move the covered clip or turn off persistence first.');
  if (!clipboard || clipboard.version !== 1 || !['copy', 'cut'].includes(clipboard.mode) || !clipboard.clip || !['audio', 'video', 'image', 'source', 'effect'].includes(clipboard.clip.kind)) throw new TypeError('The clip clipboard is invalid.');
  const current = clipboard.mode === 'cut' && clipboard.projectId === project.id ? findClipSlot(project, clipboard.clipId) : null;
  if (current) {
    const clip = moveClip(project, current, to);
    clipboard.mode = 'copy'; clipboard.clip = cloneClip(clip);
    return clip;
  }
  let count = 0;
  for (const { slots } of rows(project)) count += slots.filter(Boolean).length;
  if (!target.clip && count >= LIMITS.clips) throw new RangeError(`A composition can have at most ${LIMITS.clips} clips.`);
  const clip = cloneClip(clipboard.clip, true);
  put(target, clip);
  if (target.clip?.id === target.layer.activeClipId) target.layer.activeClipId = null;
  // Subsequent pastes create independent copies, including after a cut source
  // was removed or its original composition was closed.
  clipboard.mode = 'copy';
  return clip;
}

// Groups (manual pp. 41–44) hold contiguous layers. Moving a layer into a
// group places it at the top of that group's run; a group never stays empty.
function groupRun(project, groupId) {
  const indexes = project.layers.map((layer, index) => layer.groupId === groupId ? index : -1).filter(index => index >= 0);
  return indexes.length ? { first: indexes[0], last: indexes.at(-1) } : null;
}

export function pruneGroups(project) {
  project.groups = (project.groups || []).filter(group => project.layers.some(layer => layer.groupId === group.id));
}

export function setLayerGroup(project, layerId, groupId) {
  const layer = project.layers[indexOf(project.layers, layerId, 'Layer')];
  if (groupId !== null && !(project.groups || []).some(group => group.id === groupId)) throw new RangeError('Group does not exist.');
  if (layer.groupId === groupId) return layer;
  const run = groupId ? groupRun(project, groupId) : null;
  layer.groupId = groupId;
  if (run) {
    project.layers.splice(project.layers.indexOf(layer), 1);
    const again = groupRun(project, groupId);
    project.layers.splice(again ? again.last + 1 : run.first, 0, layer);
  } else if (!groupId) {
    // Leaving a group: step out above the group's remaining run.
    const previous = project.layers.indexOf(layer);
    const neighbours = project.layers.filter(item => item !== layer && item.groupId && (project.layers.indexOf(item) === previous - 1 || project.layers.indexOf(item) === previous + 1));
    if (neighbours.length === 2 && neighbours[0].groupId === neighbours[1].groupId) {
      project.layers.splice(previous, 1);
      const remaining = groupRun(project, neighbours[0].groupId);
      project.layers.splice(remaining.last + 1, 0, layer);
    }
  }
  pruneGroups(project);
  return layer;
}

export function createGroupForLayer(project, layerId, name) {
  if ((project.groups ||= []).length >= LIMITS.groups) throw new RangeError(`A composition can have at most ${LIMITS.groups} groups.`);
  const group = createGroup(nameOf(name, `Group ${project.groups.length + 1}`));
  project.groups.push(group);
  const layer = project.layers[indexOf(project.layers, layerId, 'Layer')];
  const previous = layer.groupId;
  layer.groupId = group.id;
  if (previous) {
    // Stepping out of the old group keeps both runs contiguous.
    layer.groupId = null;
    setLayerGroup(project, layerId, null);
    layer.groupId = group.id;
  }
  pruneGroups(project);
  return group;
}

export function ungroup(project, groupId) {
  for (const layer of project.layers) if (layer.groupId === groupId) layer.groupId = null;
  pruneGroups(project);
}

export function duplicateLayer(project, layerId) {
  const index = indexOf(project.layers, layerId, 'Layer');
  if (project.layers.length >= LIMITS.layers) throw new RangeError(`A composition can have at most ${LIMITS.layers} layers.`);
  const source = project.layers[index];
  let count = 0;
  for (const { slots } of rows(project)) count += slots.filter(Boolean).length;
  const copies = Object.values(source.clips).flat().filter(Boolean).length;
  if (count + copies > LIMITS.clips) throw new RangeError(`A composition can have at most ${LIMITS.clips} clips.`);
  const layer = { ...structuredClone({ ...source, clips: undefined }), id: uid('layer'), name: `${source.name} copy`, activeClipId: null, clips: Object.create(null) };
  if (layer.mask) layer.mask.id = uid('mask');
  for (const effect of [...(layer.effects || []), ...(layer.audioEffects || [])]) effect.id = uid('effect');
  for (const deck of project.decks) layer.clips[deck.id] = (source.clips[deck.id] || []).map(clip => clip ? cloneClip(clip, true) : null);
  project.layers.splice(index + 1, 0, layer);
  return layer;
}

export function clearLayerClips(project, layerId) {
  const layer = project.layers[indexOf(project.layers, layerId, 'Layer')];
  for (const deck of project.decks) layer.clips[deck.id] = (layer.clips[deck.id] || []).map(() => null);
  layer.activeClipId = null;
  return layer;
}