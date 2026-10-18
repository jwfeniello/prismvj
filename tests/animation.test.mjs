import test from 'node:test';
import assert from 'node:assert/strict';
import { Animator, createAnimation, normalizeAnimation, foldPhase, shapeValue, outputValue, bandLevel } from '../src/animation.js';
import { applyAnimations } from '../src/automation.js';
import { createProject, createClip, validateProject, Transport } from '../src/model.js';
import { resolvePath, getPath, setPathNormalized, getPathNormalized, describePath } from '../src/params.js';

const close = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≉ ${expected}`);

test('timeline animation advances with dt, loops, ping-pongs and plays once', () => {
  const animator = new Animator();
  const loop = createAnimation('timeline', { min: 0, max: 10 });
  Object.assign(loop, { loop: 'loop', duration: 2 });
  close(animator.evaluate(loop, { dt: 0.5 }), 2.5);
  close(animator.evaluate(loop, { dt: 1 }), 7.5);
  close(animator.evaluate(loop, { dt: 1 }), 2.5);
  const pingpong = { ...createAnimation('timeline', { min: 0, max: 1 }), duration: 1, loop: 'pingpong' };
  close(animator.evaluate(pingpong, { dt: 0.75 }), 0.75);
  close(animator.evaluate(pingpong, { dt: 0.5 }), 0.75);
  const once = { ...createAnimation('timeline', { min: 0, max: 1 }), duration: 1, loop: 'once' };
  close(animator.evaluate(once, { dt: 5 }), 1);
  close(animator.evaluate(once, { dt: 5 }), 1);
  const reverse = { ...once, direction: -1 };
  close(animator.evaluate(reverse, { dt: 0.25 }), 0.75);
  close(animator.evaluate(reverse, { dt: 5 }), 0);
  const paused = { ...loop, direction: 0 };
  const first = animator.evaluate(paused, { dt: 0.3 });
  assert.equal(animator.evaluate(paused, { dt: 0.3 }), first);
});

test('BPM sync locks to the composition beat grid', () => {
  const animator = new Animator();
  const animation = { ...createAnimation('bpm', { min: 0, max: 1 }), beats: 4, loop: 'loop' };
  close(animator.evaluate(animation, { beat: 8 }), 0);
  close(animator.evaluate(animation, { beat: 9 }), 0.25);
  close(animator.evaluate(animation, { beat: 11 }), 0.75);
  close(animator.evaluate(animation, { beat: 12 }), 0);
});

test('clip position, shapes, envelopes, inversion and value types', () => {
  const animator = new Animator();
  const clip = { ...createAnimation('clip', { min: 0, max: 100 }) };
  close(animator.evaluate(clip, { clipPosition: 0.3 }), 30);
  close(shapeValue({ shape: 'sine' }, 0.5), 1);
  close(shapeValue({ shape: 'triangle' }, 0.25), 0.5);
  assert.equal(shapeValue({ shape: 'square' }, 0.6), 1);
  const envelope = normalizeAnimation({ mode: 'clip', shape: 'envelope', points: [[0, 0], [0.5, 1], [1, 0]] });
  close(shapeValue(envelope, 0.25), 0.5);
  close(shapeValue({ ...envelope, stepped: true }, 0.75), 1);
  assert.equal(outputValue({ ...envelope, valueType: 'bool' }, 0.6), true);
  assert.equal(outputValue({ ...envelope, valueType: 'choice', count: 4 }, 0.6), 2);
  assert.equal(outputValue({ ...envelope, valueType: 'float', min: 0, max: 10, invert: true }, 0.2), 8);
  assert.deepEqual(foldPhase({ inPoint: 0.2, outPoint: 0.6, loop: 'loop' }, 0.5).phase.toFixed(3), '0.400');
});

test('audio analysis rises instantly, falls with the fall control and drives speed modes', () => {
  const animator = new Animator();
  const spectrum = new Float32Array(64);
  const animation = normalizeAnimation({ mode: 'fft', min: 0, max: 1, fft: { lo: 0, hi: 0.3, gain: 1, fall: 0.8, response: 'up' } });
  spectrum.fill(0.9, 0, 20);
  close(bandLevel(spectrum, 0, 0.3), 0.9, 0.02);
  const peak = animator.evaluate(animation, { dt: 1 / 60, spectrum: () => spectrum });
  assert.ok(peak > 0.85);
  spectrum.fill(0);
  const falling = animator.evaluate(animation, { dt: 1 / 60, spectrum: () => spectrum });
  assert.ok(falling < peak && falling > 0.5, `slow fall ${falling}`);
  const instant = normalizeAnimation({ mode: 'fft', fft: { fall: 0, response: 'down' } });
  assert.equal(animator.evaluate(instant, { dt: 1 / 60, spectrum: () => spectrum }), 1);
});

test('dashboard links move several parameters, each with its own range', () => {
  const project = createProject();
  const layer = project.layers[0];
  layer.dashboard[2].value = 0.5;
  layer.animations = { opacity: normalizeAnimation({ mode: 'dashboard', dial: 2, min: 0, max: 1 }), rotation: normalizeAnimation({ mode: 'dashboard', dial: 2, min: -90, max: 90, invert: true }) };
  applyAnimations(project, [], new Animator(), { dt: 0.016 });
  close(layer.opacity, 0.5);
  close(layer.rotation, 0);
  layer.dashboard[2].value = 1;
  applyAnimations(project, [], new Animator(), { dt: 0.016 });
  close(layer.opacity, 1); close(layer.rotation, -90);
});

test('animations on playing clips, effects and source parameters apply each frame and survive validation', () => {
  const project = createProject();
  const deck = project.selectedDeckId, layer = project.layers[0];
  const clip = createClip('source', { source: 'rings' });
  clip.effects.push({ id: 'fx-1', type: 'hue-rotate', enabled: true, opacity: 1, blend: 'normal', params: {}, animations: {} });
  layer.clips[deck][5] = clip;
  clip.animations['source.count'] = normalizeAnimation({ mode: 'clip', valueType: 'int', min: 2, max: 12 });
  clip.effects[0].animations.opacity = normalizeAnimation({ mode: 'clip', min: 0, max: 1 });
  const transport = new Transport(project);
  transport.trigger(layer.id, clip.id, 0);
  const frames = transport.tick(1);
  applyAnimations(project, frames.map(frame => frame.clip.id === clip.id ? { ...frame, position: 0.5 } : frame), new Animator(), { dt: 1 });
  assert.equal(clip.params.count, 7);
  close(clip.effects[0].opacity, 0.5);
  const saved = validateProject(JSON.parse(JSON.stringify(project)));
  const restored = saved.layers[0].clips[deck][5];
  assert.equal(restored.animations['source.count'].mode, 'clip');
  assert.equal(restored.effects[0].animations.opacity.mode, 'clip');
  assert.equal(restored.effects[0].type, 'hue-rotate');
  assert.ok('hue' in restored.effects[0].params || Object.keys(restored.effects[0].params).length > 0);
});

test('parameter paths resolve, normalize and describe values across scopes', () => {
  const project = createProject();
  const layer = project.layers[1];
  layer.effects.push({ id: 'fx-path', type: 'blur', enabled: true, opacity: 1, blend: 'normal', params: { radius: 0 }, animations: {} });
  assert.equal(resolvePath(project, 'composition/masterOpacity').param.max, 1);
  assert.ok(setPathNormalized(project, `layer/${layer.id}/opacity`, 0.25));
  close(layer.opacity, 0.25);
  assert.ok(setPathNormalized(project, 'composition/bpm', 1));
  assert.equal(project.bpm, 300);
  assert.ok(setPathNormalized(project, 'composition/blackout', 1));
  assert.equal(project.blackout, true);
  assert.ok(resolvePath(project, 'effect/fx-path/opacity'));
  assert.equal(getPathNormalized(project, 'effect/fx-path/opacity'), 1);
  assert.equal(getPath(project, 'nonsense/path'), undefined);
  assert.equal(resolvePath(project, 'layer/missing/opacity'), null);
  assert.match(describePath(project, `layer/${layer.id}/opacity`), /Video/);
});

test('invalid animation data is rejected or clamped', () => {
  assert.equal(normalizeAnimation({ mode: 'warp' }), null);
  const animation = normalizeAnimation({ mode: 'timeline', duration: -5, speed: 1e9, points: [[2, 2], [NaN, 1], [0, 0]], fft: { gain: 99 } }, { min: 0, max: 1 });
  assert.equal(animation.duration, 0.01); assert.equal(animation.speed, 16); assert.equal(animation.fft.gain, 16);
  assert.deepEqual(animation.points, [[0, 0], [1, 1]]);
  const project = validateProject({ ...createProject(), animations: { __proto__: { mode: 'timeline' }, 'bad key!': { mode: 'timeline' }, bpm: { mode: 'timeline', min: -5, max: 5000 } } });
  assert.deepEqual(Object.keys(project.animations), ['bpm']);
  assert.equal(project.animations.bpm.min, 20); assert.equal(project.animations.bpm.max, 300);
});

test('BPM Sync speed steps and Timeline Duration change clip rate independently', () => {
  const project = createProject();
  const deck = project.selectedDeckId, [a, b] = project.layers;
  const synced = a.clips[deck][0], timed = b.clips[deck][0];
  Object.assign(synced, { beatSync: true, beats: 4, bpmSpeed: 2, speed: 3 });
  project.bpm = 120;
  Object.assign(timed, { duration: 8, stretch: 2, speed: 1 });
  const transport = new Transport(project);
  transport.trigger(a.id, synced.id, 0); transport.trigger(b.id, timed.id, 0);
  transport.tick(0); transport.tick(0.5);
  // 4 beats at 120 BPM take 2 s; double speed covers half the clip in 0.5 s.
  close(transport.getState(a.id).position, 0.5);
  // Duration stretch 2 plays the 8 s clip in 4 s.
  close(transport.getState(b.id).position, 0.125);
  const saved = validateProject(JSON.parse(JSON.stringify(project)));
  assert.equal(saved.layers[0].clips[deck][0].bpmSpeed, 2);
  assert.equal(saved.layers[1].clips[deck][0].stretch, 2);
  synced.bpmSpeed = 3;
  assert.equal(validateProject(JSON.parse(JSON.stringify(project))).layers[0].clips[deck][0].bpmSpeed, 1, 'off-grid BPM speeds fall back to 1');
});
test('random play mode jumps every interval within the distance, and relative pick-up keeps position', () => {
  const project = createProject();
  const deck = project.selectedDeckId, layer = project.layers[0];
  const clip = layer.clips[deck][0];
  Object.assign(clip, { duration: 10, loop: 'random', randomInterval: 0.5, randomDistance: 1 });
  const transport = new Transport(project);
  transport.trigger(layer.id, clip.id, 0);
  transport.tick(0);
  let previous = transport.getState(layer.id).position, jumps = 0;
  for (let t = 0.1; t <= 5.0001; t += 0.1) {
    transport.tick(t);
    const position = transport.getState(layer.id).position;
    const step = Math.abs(position - previous);
    // Between jumps it plays at normal speed (0.01 per 0.1 s); jumps stay within 1 s (0.1).
    if (step > 0.011 && step < 0.9) jumps++;
    assert.ok(step <= 0.1 + 0.0101 || step >= 0.9, `jump ${step} exceeds distance`);
    previous = position;
  }
  assert.ok(jumps >= 6 && jumps <= 11, `about one jump per 0.5 s, got ${jumps}`);

  const other = layer.clips[deck][1];
  Object.assign(other, { trigger: 'relative', inPoint: 0.5, outPoint: 1, duration: 10, loop: 'loop' });
  Object.assign(clip, { loop: 'loop', randomInterval: null });
  transport.trigger(layer.id, clip.id, 6);
  transport.seek(layer.id, 0.4);
  transport.trigger(layer.id, other.id, 6);
  close(transport.getState(layer.id).position, 0.5 + 0.4 * 0.5);
});
test('Link beat sync aligns the phase within a bar and eases small drift', () => {
  const transport = new Transport(createProject());
  transport.tick(10);
  const before = transport.beat;
  // Session is 1.5 beats ahead in the bar: jump.
  close(transport.syncBeat(before + 1.5 + 64, 4, 10), 1.5);
  close(transport.beat % 4, (before + 1.5) % 4);
  // 0.1 beat of drift is eased in by 20 %.
  const eased = transport.beat;
  transport.syncBeat(eased + 0.1, 4, 10);
  close(transport.beat - eased, 0.02);
  // Offsets wrap to the nearest bar edge (3.9 ahead is 0.1 behind).
  const wrapped = transport.beat;
  close(transport.syncBeat(wrapped + 3.9, 4, 10), -0.1);
});