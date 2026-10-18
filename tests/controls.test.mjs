import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, serializeProject, validateProject, Transport } from '../src/model.js';
import { applyOSC } from '../src/controls.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `Expected ${expected}, got ${actual}`);
function fixture() {
  const project = createProject(), transport = new Transport(project), calls = [];
  transport.tick(0);
  const context = {
    project, transport,
    triggerClip: (layer, clip) => { calls.push(['clip', layer.id, clip.id]); transport.trigger(layer.id, clip.id, 0); },
    triggerColumn: index => { calls.push(['column', index]); for (const layer of project.layers) {
      const clip = layer.clips[project.selectedDeckId][index]; if (clip) transport.trigger(layer.id, clip.id, 0);
    } },
    selectLayer: id => calls.push(['layer-select', id]), selectClip: id => calls.push(['clip-preview', id]),
  };
  return { project, transport, calls, context, layer: project.layers[0], clip: project.layers[0].clips[project.selectedDeckId][0],
    send: (address, ...args) => applyOSC(context, { address, args }) };
}

test('documented column and clip addresses invoke the correct callbacks in the selected deck', () => {
  const f = fixture(); assert.equal(f.send('/track3/connect', 1), true);
  assert.deepEqual(f.calls[0], ['column', 2]);
  assert.ok(f.project.layers.every(layer => layer.activeClipId === layer.clips[f.project.selectedDeckId][2].id));
  f.project.selectedDeckId = f.project.decks[1].id;
  assert.equal(f.send('/layer2/clip4/connect', 1), true);
  assert.deepEqual(f.calls[1], ['clip', f.project.layers[1].id, f.project.layers[1].clips[f.project.selectedDeckId][3].id]);
  assert.equal(f.send('/track9/connect', 1), false);
  assert.equal(f.send('/layer1/clip8/connect', 1), false);
});

test('XYZ rotations, anchors and clip dimensions use documented OSC units and survive validation', () => {
  const f=fixture();
  for(const [scope,target] of [['composition',f.project],['layer1',f.layer],['layer1/clip1',f.clip]]){
    assert.equal(f.send(`/${scope}/video/rotatex/values`,.75),true);close(target.rotationX,90);
    assert.equal(f.send(`/${scope}/video/rotatey/textvalue`,'-45'),true);close(target.rotationY,-45);
    assert.equal(f.send(`/${scope}/video/rotatez/values`,.25),true);close(target.rotation,-90);
  }
  for(const [scope,target] of [['layer1',f.layer],['layer1/clip1',f.clip]]){
    for(const [axis,value] of [['x',-1024],['y',128],['z',2048]]){
      assert.equal(f.send(`/${scope}/video/anchor${axis}/textvalue`,String(value)),true);
      close(target['anchor'+axis.toUpperCase()],value);
    }
  }
  assert.equal(f.send('/layer1/clip1/video/width/values',.5),true);close(f.clip.width,2048);
  assert.equal(f.send('/layer1/clip1/video/height/textvalue','0'),true);close(f.clip.height,0);
  const saved=validateProject(serializeProject(f.project));
  close(saved.rotationX,90);close(saved.layers[0].anchorZ,2048);
  const clip=saved.layers[0].clips[saved.selectedDeckId][0];close(clip.width,2048);close(clip.height,0);close(clip.rotationY,-45);
});

test('clip connect zero releases a piano voice and leaves a normal clip playing', () => {
  const f = fixture(); f.clip.trigger = 'piano';
  f.send('/layer1/clip1/connect', 1); f.send('/layer1/clip1/connect', 0);
  assert.equal(f.layer.activeClipId, null);
  f.clip.trigger = 'restart'; f.send('/layer1/clip1/connect', 1); f.send('/layer1/clip1/connect', 0);
  assert.equal(f.layer.activeClipId, f.clip.id);
});

test('stop and release callbacks let the UI cancel asynchronously loading media', () => {
  const f = fixture(); const events = [];
  f.context.stopLayer = id => events.push(['stop', id]);
  f.context.releaseClip = (layer, clip) => events.push(['release', layer.id, clip.id]);
  f.send('/layer1/clear', 1); f.send('/layer1/clip1/connect', 0); f.send('/composition/disconnectall', 1);
  assert.deepEqual(events.slice(0, 2), [['stop', f.layer.id], ['release', f.layer.id, f.clip.id]]);
  assert.equal(events.length, 5);
});

test('composition bypass does not rewrite layer settings or stop transport', () => {
  const f = fixture(); f.project.layers[1].bypass = true;
  assert.equal(f.send('/composition/bypassed', 1), true);
  assert.equal(f.project.bypass, true); assert.equal(f.layer.bypass, false);
  close(f.transport.tick(1)[0].position, 0.2);
  f.send('/composition/bypassed', 0); assert.equal(f.project.layers[1].bypass, true);
  f.send('/composition/disconnectall', 1); assert.ok(f.project.layers.every(layer => layer.activeClipId === null));
});

test('layer clear zero never mutes or clears audio', () => {
  const f = fixture(); f.layer.volume = 0.6;
  assert.equal(f.send('/layer1/clear', 0), false);
  assert.equal(f.layer.activeClipId, f.clip.id); close(f.layer.volume, 0.6);
  assert.equal(f.send('/layer1/clear', 1), true); assert.equal(f.layer.activeClipId, null);
});

test('layer names, selection, solo, group and ordering use the manual integer encoding', () => {
  const f = fixture(); f.send('/layer1/name', 'Low frequencies'); assert.equal(f.layer.name, 'Low frequencies');
  f.send('/layer1/select', 1); assert.deepEqual(f.calls[0], ['layer-select', f.layer.id]);
  f.send('/layer1/solo', 1); assert.equal(f.layer.solo, true);
  f.send('/layer1/bypassed', 1); assert.equal(f.layer.bypass, true);
  for (const [value, group] of [[0, 'none'], [1, 'A'], [2, 'B']]) { f.send('/layer1/group', value); assert.equal(f.layer.group, group); }
  f.send('/layer1/moveup', 1); assert.equal(f.project.layers[1].id, f.layer.id);
  f.send('/layer2/movedown', 1); assert.equal(f.project.layers[0].id, f.layer.id);
});

test('clip name and preview select the addressed clip without triggering it', () => {
  const f = fixture(); const other = f.layer.clips[f.project.selectedDeckId][1];
  f.send('/layer1/clip2/name', 'Ambient texture'); assert.equal(other.name, 'Ambient texture');
  f.send('/layer1/clip2/preview', 1); assert.deepEqual(f.calls, [['clip-preview', other.id]]);
  assert.equal(f.layer.activeClipId, f.clip.id);
});

test('composition and clip volume map to decibels while layer volume remains linear', () => {
  const f = fixture();
  f.send('/composition/audio/volume/values', 0); close(f.project.masterVolume, 0.01);
  f.send('/composition/audio/volume/values', 0.5); close(f.project.masterVolume, 10 ** (-14 / 20));
  f.send('/composition/audio/volume/values', 40 / 52); close(f.project.masterVolume, 1);
  f.send('/composition/audio/volume/values', 1); close(f.project.masterVolume, 10 ** (12 / 20));
  f.send('/layer1/clip1/audio/volume/values', 1); close(f.clip.volume, 10 ** (12 / 20));
  f.send('/layer1/audio/volume/values', 0.5); close(f.layer.volume, 0.5);
  const loaded = validateProject(serializeProject(f.project));
  close(loaded.masterVolume, f.project.masterVolume); close(loaded.layers[0].clips[loaded.selectedDeckId][0].volume, f.clip.volume);
});

test('pan is normalized to the full stereo range at every scope', () => {
  const f = fixture();
  for (const [path, target] of [['/composition', f.project], ['/layer1', f.layer], ['/layer1/clip1', f.clip]]) {
    f.send(`${path}/audio/pan/values`, 0); close(target.pan, -1);
    f.send(`${path}/audio/pan/values`, 0.5); close(target.pan, 0);
    f.send(`${path}/audio/pan/values`, 1); close(target.pan, 1);
  }
});

test('video parameters use percent scale, degrees and pixel displacement', () => {
  const f = fixture();
  f.send('/composition/video/fadeout/values', 0.3); close(f.project.masterOpacity, 0.3);
  f.send('/composition/video/scale/values', 0.1); close(f.project.scale, 1);
  f.send('/layer1/video/scale/values', 1); close(f.layer.scale, 10);
  f.send('/layer1/clip1/video/scale/values', 0); close(f.clip.scale, 0);
  f.send('/layer1/video/rotatez/values', 0.75); close(f.layer.rotation, 90);
  f.send('/layer1/clip1/video/positionx/values', 1); close(f.clip.x, 4096 / f.project.width);
  f.send('/layer1/clip1/video/positiony/values', 0); close(f.clip.y, -4096 / f.project.height);
  f.send('/layer1/video/opacity/values', 0.7); close(f.layer.opacity, 0.7);
});

test('numeric textvalue uses each documented internal unit', () => {
  const f = fixture();
  f.send('/composition/audio/volume/textvalue', '0'); close(f.project.masterVolume, 1);
  f.send('/layer1/clip1/audio/volume/textvalue', '-20'); close(f.clip.volume, 0.1);
  f.send('/layer1/audio/pan/textvalue', '-0.5'); close(f.layer.pan, -0.5);
  f.send('/composition/video/scale/textvalue', '150'); close(f.project.scale, 1.5);
  f.send('/layer1/video/positionx/textvalue', '640'); close(f.layer.x, 0.5);
  f.send('/layer1/clip1/video/rotatez/textvalue', '-90'); close(f.clip.rotation, -90);
  f.send('/layer1/clip1/video/position/textvalue', '2500'); close(f.transport.getState(f.layer.id).position, 0.5);
  assert.equal(f.send('/composition/audio/volume/textvalue', '0 dB'), false);
});

test('position values accept one normalized value or in/current/out triple', () => {
  const f = fixture();
  assert.equal(f.send('/layer1/clip1/video/position/values', 0.5), true);
  close(f.transport.getState(f.layer.id).position, 0.5);
  assert.equal(f.send('/layer1/clip1/audio/position/values', 0.2, 0.4, 0.8), true);
  close(f.clip.inPoint, 0.2); close(f.clip.outPoint, 0.8); close(f.transport.getState(f.layer.id).position, 0.4);
  const before = serializeProject(f.project);
  assert.equal(f.send('/layer1/clip1/video/position/values', 0.8, 0.6, 0.2), false);
  assert.deepEqual(serializeProject(f.project), before);
});

test('an inactive clip position never scrubs another active clip on the same layer', () => {
  const f = fixture();
  assert.equal(f.send('/layer1/clip2/video/position/values', 0.5), false);
  close(f.transport.getState(f.layer.id).position, 0);
});

test('source-slot OSC position seeks all active routed voices and leaves unrelated source playback alone', () => {
  const f = fixture();
  const other = f.layer.clips[f.project.selectedDeckId][1];
  const destinations = f.project.layers.slice(1);
  for (const destination of destinations) f.transport.triggerRouted(f.layer.id, f.clip.id, 0, { target: 'selected', selectedLayerId: destination.id });
  f.transport.trigger(f.layer.id, other.id, 0, { target: 'own' });
  f.transport.seek(f.layer.id, 0.3);
  f.transport.seek(destinations[0].id, 0.1);
  f.transport.seek(destinations[1].id, 0.6);
  assert.equal(f.send('/layer1/clip1/video/position/values', 0.7), true);
  for (const destination of destinations) close(f.transport.getState(destination.id).position, 0.7);
  close(f.transport.getState(f.layer.id).position, 0.3);
  assert.equal(f.send('/layer1/clip1/audio/position/textvalue', '1250'), true);
  for (const destination of destinations) close(f.transport.getState(destination.id).position, 0.25);
  assert.equal(f.send('/layer1/clip1/video/position/values', 0.2, 0.5, 0.8), true);
  close(f.clip.inPoint, 0.2); close(f.clip.outPoint, 0.8);
  for (const destination of destinations) close(f.transport.getState(destination.id).position, 0.5);
  close(f.transport.getState(f.layer.id).position, 0.3);
  close(other.inPoint, 0); close(other.outPoint, 1);
  for (const destination of destinations) f.transport.stop(destination.id);
  const before = serializeProject(f.project);
  assert.equal(f.send('/layer1/clip1/video/position/values', 0.1, 0.4, 0.9), false);
  assert.deepEqual(serializeProject(f.project), before);
  close(f.transport.getState(f.layer.id).position, 0.3);
  // A queued route has no active decoder to seek and must not scrub its current
  // destination clip or silently alter the queued clip's in/out points.
  f.clip.quantize = 4;
  f.transport.triggerRouted(f.layer.id, f.clip.id, 1, { target: 'selected', selectedLayerId: destinations[0].id });
  assert.equal(f.transport.getState(destinations[0].id).pendingClipId, f.clip.id);
  assert.equal(f.send('/layer1/clip1/video/position/values', 0.4), false);
  assert.equal(f.transport.getState(destinations[0].id).pendingClipId, f.clip.id);
});

test('transport parameter direction uses reverse0 forward1 pause2 random3', () => {
  const f = fixture();
  f.send('/layer1/clip1/video/position/direction', 0); assert.equal(f.clip.direction, -1); assert.equal(f.clip.paused, false);
  f.send('/layer1/clip1/video/position/direction', 2); assert.equal(f.clip.paused, true);
  f.send('/layer1/clip1/video/position/direction', 1); assert.equal(f.clip.direction, 1); assert.equal(f.clip.paused, false);
  f.send('/layer1/clip1/video/position/direction', 3); assert.equal(f.clip.random, true);
  assert.equal(f.transport.tick(1)[0].playing, false);
  f.send('/layer1/clip1/video/position/direction', 1); assert.equal(f.clip.random, false);
  assert.equal(f.transport.tick(2)[0].playing, true);
});

test('playmode and playmodeaway use their own encoding and preserve random direction', () => {
  const f = fixture();
  for (const [value, mode] of [[0, 'once'], [1, 'loop'], [2, 'pingpong']]) {
    f.send('/layer1/clip1/video/position/playmode', value); assert.equal(f.clip.loop, mode);
  }
  f.send('/layer1/clip1/video/position/direction', 3);
  f.send('/layer1/clip1/video/position/playmode', 1); assert.equal(f.clip.random, true); assert.equal(f.clip.loop, 'loop');
  f.send('/layer1/clip1/video/position/playmodeaway', 1); assert.equal(f.clip.trigger, 'continue');
  f.send('/layer1/clip1/video/position/playmodeaway', 0); assert.equal(f.clip.trigger, 'restart');
  f.send('/layer1/clip1/video/position/speed', 0.5); close(f.clip.speed, 0.5);
});

test('reverse and loop commands resume a completed once-and-hold clip', () => {
  const f = fixture(); f.clip.loop = 'once'; f.transport.tick(5);
  assert.equal(f.transport.getState(f.layer.id).completed, true);
  f.send('/layer1/clip1/video/position/direction', 0); close(f.transport.tick(6)[0].position, 0.8);
  f.transport.tick(10); assert.equal(f.transport.getState(f.layer.id).completed, true);
  f.send('/layer1/clip1/video/position/playmode', 1); close(f.transport.tick(11)[0].position, 0.8);
});

test('direction and loop commands resume completed routed voices without restarting another source clip', () => {
  const f = fixture(); f.clip.loop = 'once';
  const other = f.layer.clips[f.project.selectedDeckId][1];
  const destinations = f.project.layers.slice(1);
  for (const destination of destinations) f.transport.triggerRouted(f.layer.id, f.clip.id, 0, { target: 'selected', selectedLayerId: destination.id });
  f.transport.trigger(f.layer.id, other.id, 0, { target: 'own' });
  f.transport.tick(5); f.transport.seek(f.layer.id, 0.3);
  assert.ok(destinations.every(destination => f.transport.getState(destination.id).completed));
  assert.equal(f.send('/layer1/clip1/video/position/direction', 0), true);
  assert.ok(destinations.every(destination => !f.transport.getState(destination.id).completed));
  f.transport.tick(6);
  for (const destination of destinations) close(f.transport.getState(destination.id).position, 0.8);
  close(f.transport.getState(f.layer.id).position, 0.5); assert.equal(other.direction, 1);
  f.transport.tick(10); f.transport.seek(f.layer.id, 0.45);
  assert.ok(destinations.every(destination => f.transport.getState(destination.id).completed));
  assert.equal(f.send('/layer1/clip1/video/position/playmode', 1), true);
  f.transport.tick(11);
  for (const destination of destinations) close(f.transport.getState(destination.id).position, 0.8);
  close(f.transport.getState(f.layer.id).position, 0.65); assert.equal(other.loop, 'loop');
});

test('video effect bypass addresses the effect order within its composition, layer or clip', () => {
  const f = fixture();
  for (const [path, target] of [['/composition', f.project], ['/layer1', f.layer], ['/layer1/clip1', f.clip]]) {
    target.effects = [{ id: 'invert', type: 'invert', enabled: true, amount: 0.5 }, { id: 'gray', type: 'grayscale', enabled: true, amount: 0.5 }];
    assert.equal(f.send(`${path}/video/effect2/bypassed`, 1), true);
    assert.equal(target.effects[0].enabled, true); assert.equal(target.effects[1].enabled, false);
    f.send(`${path}/video/effect2/bypassed`, 0); assert.equal(target.effects[1].enabled, true);
  }
});

test('typed OSC values and the native message path/value form are accepted', () => {
  const f = fixture();
  assert.equal(applyOSC(f.context, { path: '/layer1/video/opacity/values', value: { type: 'f', value: 0.3 } }), true);
  close(f.layer.opacity, 0.3);
  assert.equal(applyOSC(f.context, { address: '/layer1/name', args: [{ type: 's', value: 'Renamed' }] }), true);
  assert.equal(f.layer.name, 'Renamed');
});

test('unsupported namespaces and malformed payloads leave all project data unchanged', () => {
  const f = fixture(); const before = serializeProject(f.project);
  for (const [path, args] of [
    ['/composition/opacity', [0]], ['/composition/video/rotatex/values', ['invalid']], ['/composition/audio/volume/direction', [1]],
    ['/composition/video/anchorx/values', [1]], ['/layer1/video/width/values', [1]], ['/layer1/video/effect1/param1/values', [1]],
    ['/layer1/audio/effect1/drywet/values', [1]], ['/layer1/group', [0.5]], ['/layer0/clear', [1]], ['/layer999999999/clear', [1]],
    ['/track1/connect', []], ['/layer1/solo', [true]], ['/layer1/bypassed', ['1']], ['/layer1/name', ['x'.repeat(257)]],
    ['/layer1/video/opacity/values', [NaN]], ['/layer1/video/opacity/values', [Infinity]], ['/layer1/video/opacity/values', [{}]],
    ['/composition/__proto__/polluted', [1]], ['/layer1/video/opacity/values', [0, 0.5, 1]],
  ]) assert.equal(f.send(path, ...args), false, path);
  assert.deepEqual(serializeProject(f.project), before); assert.equal(Object.prototype.polluted, undefined);
  assert.equal(applyOSC(f.context, { address: '/layer1/name', args: 'not-array' }), false);
});

test('documented pixel range remains representable at the minimum composition size', () => {
  const f = fixture(); f.project.width = 64; f.project.height = 64;
  f.send('/layer1/video/positionx/values', 1); f.send('/layer1/clip1/video/positiony/values', 0);
  const saved = serializeProject(f.project);
  close(saved.layers[0].x, 64); close(saved.layers[0].clips[saved.selectedDeckId][0].y, -64);
});
