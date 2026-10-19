import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrackTriggers, triggerMatches, playerFor, clipPosition, trackLabel } from '../src/track-triggers.js';
import { createProject, Transport } from '../src/model.js';

const player = (overrides = {}) => ({ number: 2, trackId: 1234, playing: true, onAir: true, master: false, pitch: 0, position: 12, track: { title: 'Strobe', artist: 'deadmau5' }, ...overrides });

test('track triggers normalize, keep bounds and drop invalid entries', () => {
  const triggers = normalizeTrackTriggers([
    { id: 'a', clipId: 'clip1', title: '  Strobe ', artist: 'deadmau5', offset: 99999, sync: false },
    { id: 'b', clipId: 'clip2', trackId: 77 },
    { id: 'a', clipId: 'clip3', title: 'duplicate id' },
    { id: 'c', clipId: 'bad id!', title: 'x' },
    { id: 'd', clipId: 'clip4' },
    null, 'junk',
  ]);
  assert.deepEqual(triggers, [
    { id: 'a', title: 'Strobe', artist: 'deadmau5', trackId: 0, clipId: 'clip1', sync: false, offset: 3600, stopWithTrack: true },
    { id: 'b', title: '', artist: '', trackId: 77, clipId: 'clip2', sync: true, offset: 0, stopWithTrack: true },
  ]);
  assert.deepEqual(normalizeTrackTriggers('nope'), []);
  assert.equal(trackLabel(triggers[0]), 'Strobe — deadmau5');
  assert.equal(trackLabel(triggers[1]), 'Track #77');
});

test('triggers match by title and artist (any export) or by track id', () => {
  const [byTitle, byId] = normalizeTrackTriggers([{ id: 'a', clipId: 'c', title: 'STROBE', artist: 'Deadmau5' }, { id: 'b', clipId: 'c', trackId: 1234 }]);
  assert.equal(triggerMatches(byTitle, player()), true);
  assert.equal(triggerMatches(byTitle, player({ trackId: 9, track: { title: 'strobe', artist: 'deadmau5' } })), true);
  assert.equal(triggerMatches(byTitle, player({ track: { title: 'Strobe', artist: 'Someone else' } })), false);
  assert.equal(triggerMatches(byTitle, player({ track: null })), false);
  assert.equal(triggerMatches(byId, player({ track: null })), true);
  assert.equal(triggerMatches(byId, player({ trackId: 0 })), false);
});

test('playerFor prefers a live player, then the master', () => {
  const [trigger] = normalizeTrackTriggers([{ id: 'a', clipId: 'c', title: 'Strobe' }]);
  const paused = player({ number: 1, playing: false }), live = player({ number: 3 }), master = player({ number: 4, master: true });
  assert.equal(playerFor(trigger, [paused, live]).player.number, 3);
  assert.equal(playerFor(trigger, [paused, live, master]).player.number, 4);
  assert.deepEqual(playerFor(trigger, [paused]), { player: paused, live: false });
  // On-air required: a playing but faded-down channel is not live.
  assert.equal(playerFor(trigger, [player({ onAir: false })], { requireOnAir: true }).live, false);
  assert.equal(playerFor(trigger, []), null);
});

test('clipPosition follows the track, loops the clip and applies offset and pitch', () => {
  const [trigger] = normalizeTrackTriggers([{ id: 'a', clipId: 'c', title: 'Strobe', offset: 0 }]);
  const clip = { duration: 10, inPoint: 0, outPoint: 1 };
  assert.ok(Math.abs(clipPosition(trigger, player({ position: 12 }), clip) - 0.2) < 1e-9);
  // 0.5 s old snapshot at +10% pitch: 12 + 0.55 s.
  assert.ok(Math.abs(clipPosition(trigger, player({ position: 12, pitch: 10 }), clip, 0.5) - 0.255) < 1e-9);
  assert.ok(Math.abs(clipPosition({ ...trigger, offset: -2 }, player({ position: 1 }), clip) - 0.9) < 1e-9);
  // Loops inside the in/out range.
  assert.ok(Math.abs(clipPosition(trigger, player({ position: 7 }), { duration: 10, inPoint: 0.2, outPoint: 0.6 }) - 0.3) < 1e-9);
  // A paused player is not extrapolated.
  assert.ok(Math.abs(clipPosition(trigger, player({ position: 12, playing: false }), clip, 0.5) - 0.2) < 1e-9);
});

test('an external rate scales or holds a layer\'s playback', () => {
  const project = createProject();
  const layer = project.layers[0], clip = layer.clips[project.decks[0].id][0];
  clip.duration = 10;
  const transport = new Transport(project);
  transport.trigger(layer.id, clip.id, 0);
  transport.tick(0);
  transport.seek(layer.id, 0);
  transport.setExternalRate(layer.id, 0);
  transport.tick(1);
  assert.equal(transport.getState(layer.id).position, 0);
  transport.setExternalRate(layer.id, 2);
  transport.tick(2);
  assert.ok(Math.abs(transport.getState(layer.id).position - 0.2) < 1e-6, String(transport.getState(layer.id).position));
  transport.setExternalRate(layer.id, null);
  transport.tick(3);
  assert.ok(Math.abs(transport.getState(layer.id).position - 0.3) < 1e-6);
});