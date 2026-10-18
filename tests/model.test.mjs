import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createClip, createLayer, validateProject, serializeProject, crossfadeGain, effectiveTriggerStyle, Transport, LIMITS } from '../src/model.js';
import { BLEND_IDS, TRANSITION_IDS } from '../src/blends.js';

const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: expected ${expected}, got ${actual}`);
function fixture(options = {}, second = {}) {
  const project = createProject();
  const layer = createLayer('Performance');
  const a = createClip('source', { id: 'a', duration: 4, ...options });
  const b = createClip('source', { id: 'b', duration: 2, ...second });
  layer.clips[project.decks[0].id] = [a, null, b, null];
  layer.clips[project.decks[1].id] = [createClip('source', { id: 'other-deck' })];
  project.layers = [layer];
  const transport = new Transport(project);
  return { project, layer, a, b, transport, trigger: (clip = a, time = 0) => transport.trigger(layer.id, clip.id, time),
    state: () => transport.getState(layer.id), position: time => transport.tick(time)[0]?.position };
}

function routingFixture(options = {}, second = {}) {
  const f = fixture(options, second);
  for (let index = 0; index < 2; index++) {
    const layer = createLayer(`Destination ${index + 1}`);
    for (const deck of f.project.decks) layer.clips[deck.id] = Array(8).fill(null);
    f.project.layers.push(layer);
  }
  return f;
}

test('spatial transforms, dimensions, channels, description and blend choices round trip', () => {
  const f = fixture({ rotationX: 30, rotationY: -40, rotation: 75, anchorX: 120, anchorY: -70, anchorZ: 350,
    width: 640, height: 200, nativeWidth: 1920, nativeHeight: 1080, fit: 'width', red: false, green: true, blue: false, alpha: false, hasAlpha: true });
  Object.assign(f.layer, { width: 320, height: 480, widthEnabled: true, heightEnabled: false, rotationX: -25,
    rotationY: 60, anchorZ: -100, blend: 'dodge', blendFavorites: ['dodge', 'wipe-left', 'screen'], transitionMode: 'wipe-right' });
  Object.assign(f.project, { description: 'A live projection composition.\nTwo displays.', rotationX: 15, rotationY: 20, anchorX: 45,
    triggerStyle: 'piano', clipTarget: 'free', directionPin: 'random' });
  const restored = validateProject(serializeProject(f.project));
  const clip = restored.layers[0].clips[restored.decks[0].id][0];
  for (const key of ['rotationX', 'rotationY', 'rotation', 'anchorX', 'anchorY', 'anchorZ', 'width', 'height', 'nativeWidth', 'nativeHeight', 'fit', 'red', 'green', 'blue', 'alpha', 'hasAlpha']) assert.equal(clip[key], f.a[key], key);
  for (const key of ['width', 'height', 'widthEnabled', 'heightEnabled', 'rotationX', 'rotationY', 'anchorZ', 'blend', 'transitionMode']) assert.equal(restored.layers[0][key], f.layer[key], key);
  assert.deepEqual(restored.layers[0].blendFavorites, f.layer.blendFavorites);
  for (const key of ['description', 'rotationX', 'rotationY', 'anchorX', 'triggerStyle', 'clipTarget', 'directionPin']) assert.equal(restored[key], f.project[key], key);
});

test('optional spatial settings default safely and reject invalid dimensions and modes', () => {
  const clip = createClip('video', { width: -1, height: Infinity, nativeWidth: NaN, rotationX: Infinity, anchorZ: 1e12, fit: 'height', red: 'false' });
  assert.equal(clip.width, null); assert.equal(clip.height, null); assert.equal(clip.nativeWidth, 0);
  assert.equal(clip.rotationX, 0); assert.equal(clip.anchorZ, 65536); assert.equal(clip.fit, 'height');
  assert.equal(clip.red, true); assert.equal(clip.alpha, true); assert.equal(clip.hasAlpha, false);
  assert.equal(createClip('video', { width: 0, height: 0 }).width, 0);
  const layer = createLayer(); assert.equal(layer.width, null); assert.equal(layer.heightEnabled, false);
  const f = fixture(); Object.assign(f.layer, { blend: 'alpha', blendFavorites: ['alpha', 'normal', 'missing', 'dodge', 'cube', 'screen'], transitionMode: '50-add' });
  f.project.directionPin = 'explode'; f.project.description = 'x'.repeat(10000);
  const restored = validateProject(f.project);
  assert.equal(restored.layers[0].blend, 'normal'); assert.deepEqual(restored.layers[0].blendFavorites, ['normal', 'dodge', 'cube']);
  assert.equal(restored.layers[0].transitionMode, 'normal'); assert.equal(restored.directionPin, null); assert.equal(restored.description.length, 8192);
  for (const mode of BLEND_IDS) { f.layer.blend = mode; assert.equal(validateProject(f.project).layers[0].blend, mode); }
});

test('piano style inherits composition settings independently of restart and continue', () => {
  const f = fixture({ trigger: 'continue' }, { triggerStyle: 'normal' }); f.project.triggerStyle = 'piano';
  assert.equal(effectiveTriggerStyle(f.project, f.a), 'piano'); assert.equal(f.transport.isPiano(f.b), false);
  f.trigger(); close(f.position(1), 0.25);
  assert.equal(f.transport.release(f.layer.id, f.a.id), true); assert.equal(f.state().clipId, null);
  f.trigger(f.a, 2); close(f.state().position, 0.25);
  f.trigger(f.b, 2); assert.equal(f.transport.release(f.layer.id, f.b.id), false); assert.equal(f.state().clipId, f.b.id);
  f.b.trigger = 'piano'; assert.equal(effectiveTriggerStyle(f.project, f.b), 'normal');
  f.b.triggerStyle = 'inherit'; f.project.triggerStyle = 'normal'; assert.equal(effectiveTriggerStyle(f.project, f.b), 'piano');
});

test('selected-layer routing retains source slots and advances on its destination', () => {
  const f = routingFixture(); f.project.clipTarget = 'selected';
  const destination = f.project.layers[2];
  const receipt = f.transport.triggerRouted(f.layer.id, f.a.id, 0, { selectedLayerId: destination.id, inputId: 'keyboard-a' });
  assert.equal(receipt.layerId, destination.id); assert.equal(receipt.sourceLayerId, f.layer.id);
  assert.equal(f.layer.clips[f.project.decks[0].id][0], f.a); assert.equal(destination.clips[f.project.decks[0].id][0], null);
  assert.equal(f.layer.activeClipId, null); assert.equal(destination.activeClipId, f.a.id);
  const [frame] = f.transport.tick(1); close(frame.position, 0.25); assert.equal(frame.layer, destination);
  assert.equal(frame.sourceLayerId, f.layer.id); assert.equal(frame.voiceId, receipt.voiceId);
  assert.equal(f.transport.getState(destination.id).clipId, f.a.id);
  const restored = validateProject(serializeProject(f.project));
  assert.equal(restored.layers[2].activeClipId, f.a.id); assert.equal(new Transport(restored).tick(0)[0].layer.id, destination.id);
});

test('target overrides select own layer and free targeting refuses occupied destinations', () => {
  const f = routingFixture({ clipTarget: 'own' }); f.project.clipTarget = 'selected';
  const own = f.transport.triggerRouted(f.layer.id, f.a.id, 0, { selectedLayerId: f.project.layers[2].id });
  assert.equal(own.layerId, f.layer.id);
  f.a.clipTarget = 'inherit'; f.project.clipTarget = 'free';
  assert.equal(f.transport.triggerRouted(f.layer.id, f.b.id, 0).layerId, f.project.layers[1].id);
  assert.equal(f.transport.triggerRouted(f.layer.id, f.a.id, 0).layerId, f.project.layers[2].id);
  assert.equal(f.transport.triggerRouted(f.layer.id, f.b.id, 0), null);
  assert.equal(f.transport.tick(1).length, 3);
  assert.equal(f.transport.triggerRouted(f.layer.id, f.b.id, 1, { target: 'own' }).layerId, f.layer.id);
  assert.equal(f.transport.triggerRouted('missing', f.a.id, 1), null);
});

test('free-layer piano chords preserve independent clocks for simultaneous instances of one clip', () => {
  const f = routingFixture(); f.project.clipTarget = 'free'; f.project.triggerStyle = 'piano';
  const first = f.transport.triggerRouted(f.layer.id, f.a.id, 0, { inputId: 'first-note' });
  const second = f.transport.triggerRouted(f.layer.id, f.a.id, 1, { inputId: 'second-note' });
  assert.notEqual(first.layerId, second.layerId); assert.notEqual(first.voiceId, second.voiceId);
  let frames = f.transport.tick(2); assert.equal(frames.length, 2);
  close(frames.find(frame => frame.voiceId === first.voiceId).position, 0.5);
  close(frames.find(frame => frame.voiceId === second.voiceId).position, 0.25);
  assert.equal(f.transport.release(f.layer.id, f.a.id, { inputId: 'first-note' }), true);
  frames = f.transport.tick(2); assert.equal(frames.length, 1); assert.equal(frames[0].voiceId, second.voiceId); close(frames[0].position, 0.25);
  assert.equal(f.transport.release(f.layer.id, f.a.id, { inputId: 'old-note' }), false);
  assert.equal(f.transport.release(f.layer.id, f.a.id, { inputId: 'second-note' }), true); assert.equal(f.transport.tick(2).length, 0);
});

test('quantized free piano voices reserve separate layers and release only their matching queued input', () => {
  const f = routingFixture(); f.project.clipTarget = 'free'; f.project.triggerStyle = 'piano'; f.project.quantize = 4;
  const first = f.transport.triggerRouted(f.layer.id, f.a.id, 0.1, { inputId: 'a-one' });
  const second = f.transport.triggerRouted(f.layer.id, f.b.id, 0.2, { inputId: 'b-one' });
  assert.notEqual(first.layerId, second.layerId); assert.equal(f.transport.tick(0.3).length, 0);
  assert.equal(f.transport.release(f.layer.id, f.b.id, { inputId: 'b-one' }), true);
  const third = f.transport.triggerRouted(f.layer.id, f.a.id, 0.3, { inputId: 'a-two' }); assert.equal(third.layerId, second.layerId);
  assert.equal(f.transport.release(f.layer.id, f.b.id, { inputId: 'b-one' }), false);
  const frames = f.transport.tick(2.5); assert.equal(frames.length, 2); for (const frame of frames) close(frame.position, 0.125);
});

test('resync retains queued piano input ownership and releases cannot clear newer voices', () => {
  const f = routingFixture(); f.project.clipTarget = 'selected'; f.project.triggerStyle = 'piano'; f.project.quantize = 4;
  const selectedLayerId = f.project.layers[1].id;
  f.transport.triggerRouted(f.layer.id, f.a.id, 0.1, { selectedLayerId, inputId: 'old' });
  f.transport.resync(0.2); assert.equal(f.transport.getState(selectedLayerId).inputId, 'old');
  f.a.quantize = 0; f.transport.triggerRouted(f.layer.id, f.a.id, 0.2, { selectedLayerId, inputId: 'new' });
  assert.equal(f.transport.release(f.layer.id, f.a.id, { inputId: 'old' }), false);
  assert.equal(f.transport.getState(selectedLayerId).inputId, 'new');
  assert.equal(f.transport.release(f.layer.id, f.a.id, { inputId: 'new' }), true);
});

test('autopilot follows the source sequence on its current destination without applying clip targets again', () => {
  const f = routingFixture({ autoPilot: 'next' }, { clipTarget: 'free', autoPilot: 'next' }); f.project.clipTarget = 'free';
  const destination = f.project.layers[2];
  f.transport.triggerRouted(f.layer.id, f.a.id, 0, { target: 'selected', selectedLayerId: destination.id });
  let frames = f.transport.tick(5); assert.equal(frames.length, 1); assert.equal(frames[0].layer.id, destination.id);
  assert.equal(frames[0].clip.id, f.b.id); close(frames[0].position, 0.5);
  frames = f.transport.tick(7); assert.equal(frames[0].clip.id, f.a.id); assert.equal(frames[0].layer.id, destination.id);
  assert.equal(f.layer.activeClipId, null); assert.equal(f.project.layers[1].activeClipId, null);
});

test('deleting source content stops all routed instances without leaving dangling active IDs', () => {
  const f = routingFixture(); f.project.clipTarget = 'free';
  f.transport.triggerRouted(f.layer.id, f.a.id, 0); f.transport.triggerRouted(f.layer.id, f.a.id, 1);
  f.layer.clips[f.project.decks[0].id][0] = null;
  assert.equal(f.transport.tick(2).length, 0); assert.ok(f.project.layers.every(layer => layer.activeClipId === null));
  const restored = validateProject(f.project); assert.ok(restored.layers.every(layer => layer.activeClipId === null));
});

test('global direction commands affect current voices while unpinned future clips keep their settings', () => {
  const f = fixture(); f.trigger(); close(f.position(1), 0.25);
  f.transport.setGlobalDirection('backward'); close(f.position(1.5), 0.125); assert.equal(f.state().direction, -1);
  f.transport.setGlobalDirection('pause'); close(f.position(3), 0.125);
  f.transport.setGlobalDirection('random'); assert.equal(f.a.random, true); assert.equal(f.a.paused, false);
  f.transport.setGlobalDirection('forward'); assert.equal(f.a.random, false); close(f.position(3.5), 0.25);
  f.trigger(f.b, 3.5); assert.equal(f.b.direction, 1); assert.equal(f.b.random, false); assert.equal(f.project.directionPin, null);
  assert.throws(() => f.transport.setGlobalDirection('invalid'), /Invalid/);
});

test('pinned direction applies at queued activation and remains pinned across temporary commands', () => {
  const f = fixture(); f.project.quantize = 4;
  f.transport.trigger(f.layer.id, f.a.id, 0.1); f.transport.setGlobalDirection('backward', { pin: true });
  const [frame] = f.transport.tick(2.5); assert.equal(frame.direction, -1); close(frame.position, 0.875);
  f.transport.setGlobalDirection('forward'); assert.equal(f.project.directionPin, 'backward');
  f.b.quantize = 0; f.trigger(f.b, 2.5); close(f.state().position, 1); assert.equal(f.state().direction, -1);
  f.project.directionPin = null; f.a.direction = 1; f.a.quantize = 0; f.trigger(f.a, 2.5); close(f.state().position, 0);
});

test('pinned random and pause modes also apply to new clips and continue retains its playhead', () => {
  const f = fixture({ trigger: 'continue' }); f.trigger(); f.position(1); f.transport.stop(f.layer.id);
  f.transport.setGlobalDirection('backward', { pin: true }); f.trigger(f.a, 1); close(f.state().position, 0.25); assert.equal(f.state().direction, -1);
  f.transport.setGlobalDirection('random', { pin: true }); f.trigger(f.b, 1); assert.equal(f.b.random, true);
  f.transport.setGlobalDirection('pause', { pin: true }); f.trigger(f.a, 1); close(f.position(10), 0.25); assert.equal(f.state().paused, true);
});

test('transition modes are frozen for each fade and random selection is deterministic', () => {
  const first = fixture(), second = fixture();
  for (const f of [first, second]) {
    f.layer.transition = 2; f.layer.transitionMode = 'random'; f.trigger(); f.trigger(f.b, 1);
  }
  const frames = first.transport.tick(1.5), comparison = second.transport.tick(1.5);
  assert.equal(frames.length, 2); assert.ok(TRANSITION_IDS.includes(frames[1].transitionMode));
  assert.equal(frames[1].transitionMode, comparison[1].transitionMode);
  assert.equal(frames[0].transitionMode, frames[1].transitionMode);
  close(frames[0].transitionProgress, 0.25); close(frames[1].transitionProgress, 0.25);
  assert.equal(frames[0].transitionIncoming, false); assert.equal(frames[1].transitionIncoming, true);
  first.layer.transitionMode = 'wipe-right'; assert.equal(first.transport.tick(2)[1].transitionMode, frames[1].transitionMode);
  const ended = first.transport.tick(3); assert.equal(ended.length, 1); assert.equal(ended[0].transitionMode, 'normal'); assert.equal(ended[0].transitionProgress, undefined);
});

test('demo is usable, bounded, and round trips with three active layers', () => {
  const project = createProject();
  assert.equal(project.layers.length, 3); assert.equal(project.decks.length, 2);
  for (const layer of project.layers) {
    assert.equal(layer.clips[project.decks[0].id].length, 8);
    assert.ok(layer.clips[project.decks[0].id].some(clip => clip?.id === layer.activeClipId));
  }
  const saved = serializeProject(project);
  const loaded = validateProject(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded, saved);
  assert.equal(new Transport(loaded).tick(0).length, 3);
  assert.equal(createClip('source').duration, 5);
});

test('validation rejects malformed or oversized structure before expensive work', () => {
  assert.throws(() => validateProject(null), /object/);
  assert.throws(() => validateProject({ version: 100 }), /version/);
  assert.throws(() => validateProject({ version: 1, decks: {} }), /array/);
  const project = createProject();
  project.layers = Array(LIMITS.layers + 1).fill({});
  assert.throws(() => validateProject(project), /limit/);
  project.layers = [createLayer()];
  project.layers[0].clips[project.decks[0].id] = Array(LIMITS.columns + 1).fill(null);
  assert.throws(() => validateProject(project), /limit/);
});

test('validation normalizes values, drops unknown fields and repairs dangling active IDs', () => {
  const { project, layer, a } = fixture();
  project.width = Infinity; project.height = 4; project.bpm = -1; project.masterOpacity = 4;
  project.speed = NaN; project.secret = { script: 'evil' }; layer.activeClipId = 'missing';
  a.inPoint = 0.9; a.outPoint = 0.1; a.duration = 0; a.effects = [{ type: 'unknown' }, { type: 'invert', amount: Infinity }];
  const result = validateProject(project);
  assert.equal(result.width, 1280); assert.equal(result.height, 64); assert.equal(result.bpm, 20);
  assert.equal(result.masterOpacity, 1); assert.equal(result.speed, 1); assert.ok(!('secret' in result));
  const clip = result.layers[0].clips[result.decks[0].id][0];
  assert.ok(clip.outPoint > clip.inPoint); assert.equal(clip.duration, 0.01);
  assert.equal(clip.effects.length, 1); assert.equal(clip.effects[0].params.amount, 0.5);
  assert.equal(result.layers[0].activeClipId, null);
});

test('duplicate clip IDs cannot collide in the media engine', () => {
  const { project, a, b } = fixture(); b.id = a.id;
  assert.throws(() => validateProject(project), /Duplicate clip/);
});

test('prototype fields are not copied from imported projects', () => {
  const project = createProject();
  const input = JSON.parse(JSON.stringify(project));
  Object.assign(input, JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad"}'));
  const clean = validateProject(input);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(clean, '__proto__'), false);
  assert.equal(Object.hasOwn(clean, 'constructor'), false);
});

test('serialization removes process-local URLs without mutating live clips', () => {
  const { project, a } = fixture();
  a.path = 'E:\\Media\\clip.mp4'; a.url = 'blob:transient';
  const saved = serializeProject(project);
  const savedClip = saved.layers[0].clips[saved.decks[0].id][0];
  assert.equal(savedClip.path, a.path); assert.equal(savedClip.url, ''); assert.equal(a.url, 'blob:transient');
});

test('paired audio, independent components, masks and render order survive persistence', () => {
  const f = fixture({ kind: 'video' });
  const clip = createClip('video', {
    duration: 12, audio: { id: 'pair-audio', path: 'E:\\Media\\track.wav', url: 'blob:audio', duration: 20 },
    mask: { id: 'clip-mask', path: 'E:\\Media\\mask.png', url: 'blob:mask', enabled: false, invert: true },
    useVideo: false, useAudio: true, fit: 'cover', ignoreColumn: true, renderOrder: ['transform', 'mask', 'effects'],
  });
  f.layer.clips[f.project.decks[0].id][0] = clip;
  f.layer.mask = { id: 'layer-mask', url: 'blob:layer-mask', enabled: true };
  f.project.mask = { id: 'project-mask', path: 'E:\\Media\\global.png', url: 'prism-media://mask' };
  f.project.av = 0.6; f.layer.av = 0.3; f.layer.ignoreColumn = true;
  const loaded = validateProject(serializeProject(f.project));
  const savedClip = loaded.layers[0].clips[loaded.decks[0].id][0];
  assert.equal(savedClip.duration, 20); assert.equal(savedClip.videoDuration, 12);
  assert.equal(savedClip.audio.path, clip.audio.path); assert.equal(savedClip.audio.url, '');
  assert.equal(savedClip.mask.url, ''); assert.equal(savedClip.mask.invert, true); assert.equal(savedClip.mask.enabled, false);
  assert.equal(loaded.layers[0].mask.url, ''); assert.equal(loaded.mask.url, '');
  assert.equal(savedClip.useVideo, false); assert.equal(savedClip.useAudio, true); assert.equal(savedClip.fit, 'cover');
  assert.equal(savedClip.ignoreColumn, true); assert.equal(loaded.layers[0].ignoreColumn, true);
  assert.equal(loaded.av, 0.6); assert.equal(loaded.layers[0].av, 0.3);
  assert.deepEqual(savedClip.renderOrder, ['transform', 'mask', 'effects']);
  assert.equal(clip.audio.url, 'blob:audio'); assert.equal(clip.mask.url, 'blob:mask');
});

test('component defaults reflect media kind and paired source/image audio', () => {
  for (const kind of ['source', 'image']) {
    const clip = createClip(kind); assert.equal(clip.useVideo, true); assert.equal(clip.useAudio, false);
    assert.equal(createClip(kind, { audio: { duration: 7 } }).useAudio, true);
  }
  assert.equal(createClip('audio').useVideo, false); assert.equal(createClip('audio').useAudio, true);
  assert.equal(createClip('video').useVideo, true); assert.equal(createClip('video').useAudio, true);
  const clip = createClip('video', { fit: 'bogus', renderOrder: ['mask', 'mask', 'bogus'], audio: { duration: Infinity }, mask: {} });
  assert.equal(clip.fit, 'contain'); assert.equal(clip.audio.duration, 8); assert.equal(clip.duration, 8);
  assert.deepEqual(clip.renderOrder, ['mask', 'effects', 'transform']);
  assert.equal(clip.mask.enabled, true); assert.equal(clip.mask.invert, false);
});

test('column migration preserves wide legacy decks and fills every row consistently', () => {
  const project = createProject(); delete project.columns;
  const deckId = project.decks[1].id;
  const last = createClip('source', { name: 'Last old column' });
  project.layers[2].clips[deckId][20] = last;
  let restored = validateProject(project);
  assert.equal(restored.columns, 21);
  for (const layer of restored.layers) for (const deck of restored.decks) assert.equal(layer.clips[deck.id].length, 21);
  assert.equal(restored.layers[2].clips[deckId][20].id, last.id);
  assert.equal(restored.layers[2].clips[deckId][19], null);
  project.columns = 2; restored = validateProject(project);
  assert.equal(restored.columns, 21); assert.equal(restored.layers[2].clips[deckId][20].id, last.id);
  assert.equal(validateProject(createProject()).columns, 8);
  delete project.columns;
  for (const layer of project.layers) for (const deck of project.decks) layer.clips[deck.id] = Array(3).fill(null);
  assert.equal(validateProject(project).columns, 3);
  for (const layer of project.layers) layer.clips = {};
  assert.equal(validateProject(project).columns, 8);
});

test('duplicated nested media IDs cannot collide in decoder and mask caches', () => {
  const f = fixture();
  f.a.audio = { id: 'same-audio', duration: 3 }; f.b.audio = { id: 'same-audio', duration: 4 };
  assert.throws(() => validateProject(f.project), /Duplicate audio/);
  f.b.audio.id = 'other-audio'; f.project.mask = { id: 'same-mask' }; f.layer.mask = { id: 'same-mask' };
  assert.throws(() => validateProject(f.project), /Duplicate mask/);
});

test('learned MIDI note and CC numbers survive save and reload', () => {
  const { project } = fixture();
  project.mappings = [{ type: 'cc', channel: 15, number: 127, target: 'crossfader' }, { type: 'note', channel: 0, number: 60, target: 'column:3' }];
  const restored = validateProject(JSON.parse(JSON.stringify(serializeProject(project))));
  assert.deepEqual(restored.mappings, project.mappings);
});

test('clip, layer, and composition audio pan and transforms survive persistence with bounded values', () => {
  const f = fixture({ pan: -0.75 });
  Object.assign(f.layer, { pan: 0.5, scale: 2, x: -0.25, y: 0.75, rotation: 90 });
  Object.assign(f.project, { pan: -1, scale: 0.5, x: 0.5, y: -0.5, rotation: -45 });
  let loaded = validateProject(serializeProject(f.project));
  assert.equal(loaded.pan, -1); assert.equal(loaded.scale, 0.5); assert.equal(loaded.rotation, -45);
  assert.equal(loaded.layers[0].pan, 0.5); assert.equal(loaded.layers[0].x, -0.25);
  assert.equal(loaded.layers[0].clips[loaded.decks[0].id][0].pan, -0.75);
  f.layer.scale = Infinity; f.layer.pan = 3; f.project.x = -100; f.a.pan = -50;
  loaded = validateProject(f.project);
  assert.equal(loaded.layers[0].scale, 1); assert.equal(loaded.layers[0].pan, 1); assert.equal(loaded.x, -64);
  assert.equal(loaded.layers[0].clips[loaded.decks[0].id][0].pan, -1);
});

test('clips provide six cue slots and old four-cue compositions preserve their points', () => {
  assert.equal(createClip('source').cues.length, 6);
  assert.deepEqual(createClip('video', { cues: [0.1, 0.3, 0.6, 0.9] }).cues, [0.1, 0.3, 0.6, 0.9, null, null]);
  const f = fixture(); f.trigger(); f.transport.seek(f.layer.id, 0.8);
  assert.equal(f.transport.setCue(f.layer.id, 5), true);
  f.transport.seek(f.layer.id, 0.1); f.transport.cue(f.layer.id, 5); close(f.state().position, 0.8);
  assert.equal(f.transport.setCue(f.layer.id, 6), false);
});

test('crossfader preserves both assigned layer maxima at center', () => {
  close(crossfadeGain('A', 0), 1); close(crossfadeGain('B', 0), 0);
  close(crossfadeGain('A', 0.5), 1); close(crossfadeGain('B', 0.5), 1);
  close(crossfadeGain('A', 1), 0); close(crossfadeGain('B', 1), 1);
  close(crossfadeGain('none', 0), 1); close(crossfadeGain('A', 0.75), 0.5);
});

test('loop transport advances media time and wraps inside trim points', () => {
  const f = fixture({ inPoint: 0.25, outPoint: 0.75 }); f.trigger();
  close(f.position(1), 0.5); close(f.position(2), 0.25); close(f.position(3), 0.5);
  close(f.transport.tick(3)[0].time, 2);
});

test('reverse transport starts at out point and wraps backwards', () => {
  const f = fixture({ direction: -1, inPoint: 0.25, outPoint: 0.75 }); f.trigger();
  close(f.position(0), 0.75); close(f.position(1), 0.5); close(f.position(2.5), 0.625);
});

test('ping pong bounces repeatedly and is independent of tick frequency', () => {
  const f = fixture({ loop: 'pingpong' }); f.trigger();
  close(f.position(4), 1); assert.equal(f.state().direction, -1);
  close(f.position(6), 0.5); close(f.position(8), 0); assert.equal(f.state().direction, 1);
  const g = fixture({ loop: 'pingpong' }); g.trigger();
  for (let i = 1; i <= 137; i++) g.position(i / 10);
  close(f.position(13.7), g.position(13.7));
});

test('play once holds its last frame and play once clear clears its layer', () => {
  const hold = fixture({ loop: 'once' }); hold.trigger();
  close(hold.position(4), 1); close(hold.position(100), 1); assert.equal(hold.state().completed, true);
  hold.transport.seek(hold.layer.id, 0.5); close(hold.position(101), 0.75);
  const clear = fixture({ loop: 'once-clear' }); clear.trigger();
  assert.equal(clear.transport.tick(4).length, 0); assert.equal(clear.layer.activeClipId, null);
  const reverse = fixture({ loop: 'once', direction: -1 }); reverse.trigger(); close(reverse.position(4), 0);
});

test('composition and individual pause freeze playback without catch up', () => {
  const f = fixture(); f.trigger(); close(f.position(1), 0.25);
  f.project.paused = true; close(f.position(10), 0.25);
  f.project.paused = false; close(f.position(11), 0.5);
  f.a.paused = true; close(f.position(20), 0.5);
  f.a.paused = false; close(f.position(21), 0.75);
  f.a.direction = 0; close(f.position(22), 0.75);
});

test('BPM clips ignore global and timeline speed and follow tempo changes', () => {
  const f = fixture({ beatSync: true, beats: 8, speed: 0.1, duration: 100 });
  f.project.speed = 16; f.trigger(); close(f.position(1), 0.25);
  f.project.bpm = 60; close(f.position(3), 0.5);
  f.project.speed = 0; close(f.position(4), 0.625);
});

test('timeline clip speed multiplies composition speed', () => {
  const f = fixture({ speed: 0.5 }); f.project.speed = 2; f.trigger(); close(f.position(1), 0.25);
  f.project.speed = 0; close(f.position(2), 0.25);
});

test('quantized triggering starts on the beat and accounts for late frames', () => {
  const f = fixture(); f.project.quantize = 1; f.trigger(f.a, 0.2);
  assert.equal(f.position(0.4), undefined); assert.equal(f.state().pendingClipId, f.a.id);
  close(f.position(0.7), 0.05); assert.equal(f.state().pendingClipId, null);
});

test('quantization tracks integrated tempo changes and per clip overrides', () => {
  const f = fixture(); f.project.quantize = 4; f.trigger(f.a, 0);
  f.trigger(f.b, 0.25); f.project.bpm = 60;
  f.position(3.74); assert.equal(f.state().clipId, f.a.id);
  close(f.position(3.85), 0.05); assert.equal(f.state().clipId, f.b.id);
  f.a.quantize = 0; f.trigger(f.a, 3.85); assert.equal(f.state().clipId, f.a.id);
});

test('queued piano triggers can be released before their beat and old releases cannot stop newer clips', () => {
  const f = fixture({ trigger: 'piano' }); f.project.quantize = 4;
  f.trigger(f.a, 0.1); f.transport.release(f.layer.id, f.a.id);
  assert.equal(f.position(3), undefined);
  f.a.quantize = 0; f.b.quantize = 0;
  f.trigger(f.a, 3); assert.equal(f.state().clipId, f.a.id);
  f.trigger(f.b, 3); f.transport.release(f.layer.id, f.a.id); assert.equal(f.state().clipId, f.b.id);
  f.trigger(f.a, 3); f.transport.release(f.layer.id, f.a.id); assert.equal(f.state().clipId, null);
});

test('continue remembers stopped position and restart resets it', () => {
  const f = fixture({ trigger: 'continue' }); f.trigger(); close(f.position(1), 0.25);
  f.trigger(f.b, 1); f.position(2); f.trigger(f.a, 2); close(f.position(2), 0.25);
  f.transport.stop(f.layer.id); f.trigger(f.a, 3); close(f.position(3), 0.25);
  f.a.trigger = 'restart'; f.trigger(f.a, 3); close(f.position(3), 0);
});

test('deck switching preserves active playback and stop cancels queued clips', () => {
  const f = fixture(); f.trigger(); close(f.position(1), 0.25);
  f.project.selectedDeckId = f.project.decks[1].id; close(f.position(2), 0.5);
  f.project.quantize = 4; f.trigger(f.b, 2.1); f.transport.stop(f.layer.id);
  assert.equal(f.position(5), undefined);
});

test('cue points can be set while paused and jump inside the trimmed range', () => {
  const f = fixture({ inPoint: 0.2, outPoint: 0.8 }); f.trigger(); f.a.paused = true;
  assert.equal(f.transport.seek(f.layer.id, 0.6), true);
  assert.equal(f.transport.setCue(f.layer.id, 2), true);
  f.transport.seek(f.layer.id, 0.3); f.transport.cue(f.layer.id, 2); close(f.state().position, 0.6);
  f.transport.cue(f.layer.id, 0); close(f.state().position, 0.2);
  assert.equal(f.transport.setCue(f.layer.id, 20), false);
  assert.equal(f.transport.seek(f.layer.id, NaN), false);
});

test('BeatLoopr captures the current beat subdivision and remains there', () => {
  const f = fixture({ beatSync: true, beats: 8 }); f.trigger();
  close(f.position(1.3), 0.325); // Beat 2.6 of 8.
  f.a.beatLoop = 1;
  close(f.position(1.6), 0.275); // Loops beats 2..3, continuing the existing phase.
  close(f.position(5.6), 0.275);
  f.a.beatLoop = 0;
  close(f.position(6.1), 0.4);
});

test('changing BeatLoopr subdivisions captures a smaller loop around the current frame', () => {
  const f = fixture({ beatSync: true, beats: 8 }); f.trigger(); f.position(1.3);
  f.a.beatLoop = 1; f.position(1.6);
  f.a.beatLoop = 0.25; close(f.position(1.7), 0.26875);
  for (const t of [1.8, 2, 5, 8]) {
    const position = f.position(t); assert.ok(position >= 0.25 && position < 0.28125);
  }
});

test('BeatLoopr is disabled by a valid cue jump and is ignored in timeline mode', () => {
  const f = fixture({ beatSync: true, beats: 8, beatLoop: 1 }); f.trigger(); f.position(2);
  assert.equal(f.transport.cue(f.layer.id, 5), false); assert.equal(f.a.beatLoop, 1);
  assert.equal(f.transport.cue(f.layer.id, 2), true); assert.equal(f.a.beatLoop, 0);
  close(f.state().position, 0.5); close(f.position(2.5), 0.625);
  const g = fixture({ beatSync: false, beatLoop: 0.25 }); g.trigger(); close(g.position(2), 0.5);
});

test('BeatLoopr obeys trim points and holds the sequence until switched off', () => {
  const f = fixture({ beatSync: true, beats: 8, inPoint: 0.25, outPoint: 0.6, beatLoop: 4, loop: 'once-clear' });
  f.layer.autoPilot = 'next'; f.trigger();
  for (const t of [1, 2, 8]) { const position = f.position(t); assert.ok(position >= 0.25 && position < 0.6); }
  assert.equal(f.state().clipId, f.a.id);
  f.a.beatLoop = 0; f.position(10); assert.equal(f.state().clipId, f.b.id);
});

test('BeatLoopr follows tempo and reverse playback without frame-rate dependence', () => {
  const f = fixture({ beatSync: true, beats: 8, direction: -1, beatLoop: 2 });
  const g = fixture({ beatSync: true, beats: 8, direction: -1, beatLoop: 2 });
  f.trigger(); g.trigger();
  close(f.position(0.5), 0.875);
  for (let i = 1; i <= 30; i++) g.position(i / 10);
  close(f.position(3), g.state().position);
  f.project.bpm = 60; close(f.position(3.5), 0.6875 + 0.25);
});

test('BeatLoopr setting survives serialization and rejects unsupported subdivisions', () => {
  const f = fixture({ beatLoop: 0.5 });
  const loaded = validateProject(serializeProject(f.project));
  assert.equal(loaded.layers[0].clips[loaded.decks[0].id][0].beatLoop, 0.5);
  assert.equal(createClip('source', { beatLoop: -2 }).beatLoop, 0);
});

test('published beat clock follows tempo, pause, and resync', () => {
  const f = fixture(); f.trigger(); f.position(1); close(f.transport.beat, 2);
  f.project.bpm = 60; f.position(2); close(f.transport.beat, 3);
  f.project.paused = true; f.position(20); close(f.transport.beat, 3);
  f.transport.resync(20); close(f.transport.beat, 0);
  f.project.paused = false; f.position(21); close(f.transport.beat, 1);
});

test('engine frames report actual playback direction, rate, and stopped transport', () => {
  const f = fixture({ beatSync: true, beats: 8, duration: 100, direction: -1 }); f.trigger();
  let frame = f.transport.tick(1)[0]; close(frame.rate, 25); assert.equal(frame.direction, -1); assert.equal(frame.playing, true);
  f.a.paused = true; frame = f.transport.tick(2)[0]; assert.equal(frame.playing, false); close(frame.rate, 0);
  f.a.paused = false; f.a.beatSync = false; f.a.loop = 'random';
  frame = f.transport.tick(3)[0]; assert.equal(frame.playing, false);
  const g = fixture({ loop: 'once' }); g.trigger(); frame = g.transport.tick(10)[0];
  assert.equal(frame.playing, false); close(frame.rate, 0);
  g.layer.transition = 2; g.trigger(g.b, 10); frame = g.transport.tick(11)[0];
  close(frame.position, 1); close(frame.rate, 0); assert.equal(frame.playing, false);
});

test('transitions advance both clips with complementary weights and freeze on pause', () => {
  const f = fixture(); f.layer.transition = 2; f.trigger(); f.position(1); f.trigger(f.b, 1);
  let frames = f.transport.tick(2);
  assert.equal(frames.length, 2); close(frames[0].weight, 0.5); close(frames[1].weight, 0.5);
  close(frames[0].position, 0.5); close(frames[1].position, 0.5);
  f.project.paused = true; frames = f.transport.tick(20); close(frames[1].weight, 0.5);
  f.project.paused = false; frames = f.transport.tick(21);
  assert.equal(frames.length, 1); close(frames[0].weight, 1);
});

test('autopilot skips empty slots and preserves overshoot across clips', () => {
  const f = fixture(); f.layer.autoPilot = 'next'; f.trigger();
  close(f.position(5), 0.5); assert.equal(f.state().clipId, f.b.id);
  close(f.position(7), 0.25); assert.equal(f.state().clipId, f.a.id);
  f.layer.autoPilot = 'previous'; close(f.position(11), 0.5); assert.equal(f.state().clipId, f.b.id);
});

test('autopilot continues the active deck after another deck is selected', () => {
  const f = fixture(); f.layer.autoPilot = 'next'; f.trigger();
  f.project.selectedDeckId = f.project.decks[1].id;
  f.position(4); assert.equal(f.state().clipId, f.b.id);
});

test('autopilot loops the current clip while waiting for the next snapped trigger', () => {
  const f = fixture({ duration: 1.25 }, { quantize: 4 }); f.layer.autoPilot = 'next'; f.trigger();
  close(f.position(1.5), 0.2); assert.equal(f.state().clipId, f.a.id);
  assert.equal(f.state().pendingClipId, f.b.id);
  close(f.position(2.5), 0.25); assert.equal(f.state().clipId, f.b.id);
});

test('per clip autopilot can stop a layer sequence or start it independently', () => {
  const f = fixture({ autoPilot: 'next' }, { autoPilot: 'off', loop: 'once' });
  f.trigger(); f.position(5); assert.equal(f.state().clipId, f.b.id);
  f.position(10); assert.equal(f.state().clipId, f.b.id); close(f.state().position, 1);
});

test('random frame mode is deterministic across frame rates and remains in range', () => {
  for (const beatSync of [false, true]) {
    const f = fixture({ loop: 'random', beatSync, inPoint: 0.25, outPoint: 0.75 });
    const g = fixture({ loop: 'random', beatSync, inPoint: 0.25, outPoint: 0.75 });
    f.trigger(); g.trigger();
    for (let i = 1; i <= 200; i++) {
      const p = g.position(i / 100); assert.ok(p >= 0.25 && p < 0.75);
    }
    close(f.position(2), g.position(2));
  }
});

test('random playback autopilot uses clip duration independently of sampled positions', () => {
  const f = fixture({ loop: 'random', duration: 1 });
  const g = fixture({ loop: 'random', duration: 1 });
  f.layer.autoPilot = 'next'; g.layer.autoPilot = 'next'; f.trigger(); g.trigger();
  for (let i = 1; i <= 15; i++) g.position(i / 10);
  close(f.position(1.5), 0.25); close(f.state().position, g.state().position);
  assert.equal(f.state().clipId, f.b.id); assert.equal(g.state().clipId, g.b.id);
});

test('project replacement and removed clips clean transport state', () => {
  const f = fixture(); f.trigger(); f.position(1);
  f.layer.clips[f.project.decks[0].id][0] = null;
  assert.equal(f.transport.tick(2).length, 0); assert.equal(f.layer.activeClipId, null);
  f.transport.project = createProject(); assert.equal(f.transport.tick(10).length, 3);
  assert.equal(f.transport.getState(f.layer.id), null);
});

test('invalid or backwards timestamps do not corrupt playback', () => {
  const f = fixture(); f.trigger(); close(f.position(1), 0.25);
  close(f.position(NaN), 0.25); close(f.position(0.5), 0.25); close(f.position(2), 0.5);
});

test('suspended-machine catch up has a bounded amount of autopilot work', () => {
  const f = fixture({ duration: 0.01 }, { duration: 0.01 }); f.layer.autoPilot = 'next'; f.trigger();
  const started = performance.now(); const frames = f.transport.tick(86400);
  assert.ok(performance.now() - started < 500);
  assert.equal(frames.length, 1); assert.ok(Number.isFinite(frames[0].position));
});
