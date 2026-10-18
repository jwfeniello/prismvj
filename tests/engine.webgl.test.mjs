import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { GifPlayback } from '../src/gif-playback.js';
import { sourceFile } from './src-server.mjs';

let browser;
let server;
let baseURL;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browserAvailable = existsSync(chrome);

before(async () => {
  if (!browserAvailable) return;
  const engineSource = await readFile(new URL('../src/engine.js', import.meta.url));
  const blendSource = await readFile(new URL('../src/blends.js', import.meta.url));
  const gifSource = await readFile(new URL('../src/gif-playback.js', import.meta.url));
  const modelSource = await readFile(new URL('../src/model.js', import.meta.url));
  const dashboardSource = await readFile(new URL('../src/dashboard.js', import.meta.url));
  const videoFixtures = new Map([
    ['/fixture.webm', await readFile(new URL('./engine-fixture.webm', import.meta.url))],
    ['/alpha-fixture.webm', await readFile(new URL('./engine-alpha-fixture.webm', import.meta.url))],
  ]);
  server = createServer((request, response) => {
    const source = sourceFile(request.url);
    if (source) { response.setHeader('Content-Type', source.type); response.end(source.body); return; }
    const videoFixture = videoFixtures.get(request.url);
    response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : videoFixture ? 'video/webm' : 'text/html');
    if (videoFixture) {
      response.setHeader('Accept-Ranges', 'bytes');
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), videoFixture.length-1) : videoFixture.length-1;
        response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${videoFixture.length}`, 'Content-Length': end-start+1 });
        response.end(videoFixture.subarray(start, end+1));
        return;
      }
      response.setHeader('Content-Length', videoFixture.length);
    }
    response.end(request.url === '/engine.js' ? engineSource : request.url === '/blends.js' ? blendSource : request.url === '/gif-playback.js' ? gifSource : request.url === '/model.js' ? modelSource : request.url === '/dashboard.js' ? dashboardSource : videoFixture || '<canvas id="output" width="160" height="90"></canvas>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function setup() {
  const page = await browser.newPage();
  await page.goto(baseURL);
  await page.evaluate(async () => {
    const { LiveEngine } = await import('/engine.js');
    window.errors = [];
    window.engine = new LiveEngine(document.querySelector('canvas'), { onError: error => errors.push(error) });
    window.project = { id: 'project', width: 160, height: 90, speed: 1, bpm: 120, masterOpacity: 1, masterVolume: 1, crossfader: 0.5, paused: false, blackout: false, layers: [], effects: [] };
    window.layer = (id, extras = {}) => ({ id, opacity: 1, volume: 1, blend: 'normal', group: 'none', effects: [], ...extras });
    window.clip = (id, color, extras = {}) => ({ id, name: id, kind: 'source', source: 'solid', color, duration: 8, opacity: 1, volume: 1, speed: 1, direction: 1, x: 0, y: 0, scale: 1, rotation: 0, effects: [], ...extras });
    window.frame = (layer, clip, weight = 1, time = 0) => ({ layer, clip, time, position: time/clip.duration, weight });
    window.pixel = (x = 80, y = 45) => {
      const value = new Uint8Array(4);
      engine.gl.readPixels(x, y, 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE, value);
      return [...value];
    };
    window.gif = () => {
      // Original three-frame fixture: red, transparent/blue, then a green
      // subrectangle. Unequal delays and restore-background disposal exercise
      // timing and full compositing by the browser's GIF decoder.
      const bytes = [...new TextEncoder().encode('GIF89a'), 4, 0, 4, 0, 0x81, 0, 0,
        0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];
      for (const [delay, width, height, pixels] of [[10, 4, 4, Array(16).fill(1)], [30, 4, 4, Array.from({ length: 16 }, (_, i) => i % 4 < 2 ? 0 : 3)], [20, 2, 2, Array(4).fill(2)]]) {
        bytes.push(0x21, 0xf9, 4, 9, delay, 0, 0, 0, 0x2c, 0, 0, 0, 0, width, 0, height, 0, 0, 2);
        const codes = pixels.flatMap(value => [4, value]).concat(5), packed = [];
        let bits = 0, count = 0;
        for (const code of codes) { bits |= code << count; count += 3; while (count >= 8) { packed.push(bits & 255); bits >>>= 8; count -= 8; } }
        if (count) packed.push(bits & 255);
        bytes.push(packed.length, ...packed, 0);
      }
      bytes.push(0x3b);
      return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/gif' }));
    };
    window.wave = (duration = 6, amplitude = 6000) => {
      const sampleRate = 8000, count = Math.round(sampleRate*duration);
      const bytes = new ArrayBuffer(44+count*2), data = new DataView(bytes);
      const write = (offset, value) => { for (let i = 0; i < value.length; i++) data.setUint8(offset+i, value.charCodeAt(i)); };
      write(0, 'RIFF'); data.setUint32(4, 36+count*2, true); write(8, 'WAVE'); write(12, 'fmt ');
      data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
      data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate*2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
      write(36, 'data'); data.setUint32(40, count*2, true);
      for (let i = 0; i < count; i++) data.setInt16(44+i*2, Math.sin(i/sampleRate*440*2*Math.PI)*amplitude, true);
      return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    };
  });
  return page;
}

test('GPU layers compose bottom to top with opacity, blend modes and blackout', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(() => {
      const bottom = layer('bottom');
      const top = layer('top', { opacity: 0.5 });
      const red = clip('red', '#ff0000');
      const blue = clip('blue', '#0000ff');
      project.layers = [bottom, top];
      engine.render(project, [frame(top, blue), frame(bottom, red)], 1);
      const normal = pixel();
      top.opacity = 1;
      top.blend = '50-add';
      engine.render(project, [frame(bottom, red), frame(top, blue)], 2);
      const add = pixel();
      top.blend = 'multiply';
      engine.render(project, [frame(bottom, red), frame(top, blue)], 3);
      const multiply = pixel();
      top.blend = 'screen';
      engine.render(project, [frame(bottom, red), frame(top, blue)], 4);
      const screen = pixel();
      project.blackout = true;
      engine.render(project, [frame(bottom, red), frame(top, blue)], 5);
      const blackout = pixel();
      engine.render(project, [], 6);
      return { normal, add, multiply, screen, blackout, empty: pixel(), errors, glError: engine.gl.getError() };
    });
    assert.deepEqual(result.normal, [128, 0, 128, 255]);
    assert.deepEqual(result.add, [255, 0, 255, 255]);
    assert.deepEqual(result.multiply, [0, 0, 0, 255]);
    assert.deepEqual(result.screen, [255, 0, 255, 255]);
    assert.deepEqual(result.blackout, [0, 0, 0, 255]);
    assert.deepEqual(result.empty, [0, 0, 0, 255]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.glError, 0);
  } finally { await page.close(); }
});

test('GPU transition weights, effect order, transforms, crossfader and solo are visible', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(() => {
      const bottom = layer('bottom');
      const red = clip('red', '#ff0000');
      const blue = clip('blue', '#0000ff');
      project.layers = [bottom];
      engine.render(project, [frame(bottom, red, 0.25), frame(bottom, blue, 0.75)], 1);
      const transition = pixel();
      red.effects = [{ type: 'invert', amount: 1 }];
      bottom.effects = [{ type: 'grayscale', amount: 1 }];
      project.effects = [{ type: 'brightness', amount: 0.25 }];
      engine.render(project, [frame(bottom, red)], 2);
      const effects = pixel();
      red.effects = [];
      bottom.effects = [];
      project.effects = [];
      red.scale = 0.5;
      red.x = 0.25;
      engine.render(project, [frame(bottom, red)], 3);
      const transformed = [pixel(120, 45), pixel(10, 45), pixel(120, 5)];
      bottom.group = 'A';
      project.crossfader = 1;
      engine.render(project, [frame(bottom, red)], 4);
      const fader = pixel(120, 45);
      bottom.group = 'none';
      const top = layer('top', { solo: true });
      project.layers.push(top);
      engine.render(project, [frame(bottom, red)], 5);
      return { transition, effects, transformed, fader, solo: pixel(120, 45), errors, glError: engine.gl.getError() };
    });
    assert.deepEqual(result.transition, [64, 0, 191, 255]);
    for (const channel of result.effects.slice(0, 3)) assert.ok(Math.abs(channel-100) <= 1);
    assert.deepEqual(result.transformed, [[255, 0, 0, 255], [0, 0, 0, 255], [0, 0, 0, 255]]);
    assert.deepEqual(result.fader, [0, 0, 0, 255]);
    assert.deepEqual(result.solo, [0, 0, 0, 255]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.glError, 0);
  } finally { await page.close(); }
});

test('image texture orientation, aspect fit and removal release resources', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const source = document.createElement('canvas');
      source.width = source.height = 100;
      const context = source.getContext('2d');
      context.fillStyle = '#ff0000'; context.fillRect(0, 0, 100, 50);
      context.fillStyle = '#0000ff'; context.fillRect(0, 50, 100, 50);
      const image = clip('image', '#ffffff', { kind: 'image', url: source.toDataURL() });
      const l = layer('layer'); project.layers = [l];
      await engine.prepare(image);
      engine.render(project, [frame(l, image)], 1);
      const top = pixel(80, 70), bottom = pixel(80, 20), border = pixel(5, 45);
      engine.remove(image.id);
      return { top, bottom, border, remaining: engine.getStats().mediaCount, errors };
    });
    assert.deepEqual(result.top, [255, 0, 0, 255]);
    assert.deepEqual(result.bottom, [0, 0, 255, 255]);
    assert.deepEqual(result.border, [0, 0, 0, 255]);
    assert.equal(result.remaining, 0);
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('audio plays naturally, follows pause and seek, and recording includes the mix', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const sampleRate = 8000, count = sampleRate*3;
      const bytes = new ArrayBuffer(44+count*2), data = new DataView(bytes);
      const write = (offset, value) => { for (let i = 0; i < value.length; i++) data.setUint8(offset+i, value.charCodeAt(i)); };
      write(0, 'RIFF'); data.setUint32(4, 36+count*2, true); write(8, 'WAVE'); write(12, 'fmt ');
      data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
      data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate*2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
      write(36, 'data'); data.setUint32(40, count*2, true);
      for (let i = 0; i < count; i++) data.setInt16(44+i*2, Math.sin(i/sampleRate*440*2*Math.PI)*8000, true);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const audio = clip('audio', '#ffffff', { kind: 'audio', url });
      const l = layer('audio-layer'); project.layers = [l];
      const media = await engine.prepare(audio);
      await engine.audioContext.resume();
      let seeks = 0; media.addEventListener('seeking', () => seeks++);
      const start = performance.now()/1000;
      while (performance.now()/1000-start < 0.6) {
        const now = performance.now()/1000;
        engine.render(project, [frame(l, audio, 1, now-start)], now);
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      const playing = !media.paused, position = media.currentTime, naturalSeeks = seeks;
      project.paused = true;
      engine.render(project, [frame(l, audio, 1, 1.5)], performance.now()/1000);
      await new Promise(resolve => setTimeout(resolve, 80));
      const paused = media.paused, sought = media.currentTime;
      const stream = engine.recordingStream();
      const tracks = stream.getTracks().map(track => track.kind).sort();
      for (const track of stream.getTracks()) track.stop();
      const audioState = engine.audioContext.state;
      engine.dispose(); URL.revokeObjectURL(url);
      return { playing, position, naturalSeeks, paused, sought, tracks, duration: audio.duration, audioState, mediaCount: engine.getStats().mediaCount, errors };
    });
    assert.equal(result.playing, true);
    assert.ok(result.position > 0.35 && result.position < 0.85, String(result.position));
    assert.ok(result.naturalSeeks <= 1, `unexpected seeks: ${result.naturalSeeks}`);
    assert.equal(result.paused, true);
    assert.ok(Math.abs(result.sought-1.5) < 0.03);
    assert.deepEqual(result.tracks, ['audio', 'video']);
    assert.equal(result.duration, 3);
    assert.equal(result.audioState, 'running');
    assert.equal(result.mediaCount, 0);
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('context restoration rebuilds the compositor and resumes output', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const l = layer('layer'), red = clip('red', '#ff0000'); project.layers = [l];
      engine.render(project, [frame(l, red)], 1);
      const extension = engine.gl.getExtension('WEBGL_lose_context');
      const lost = new Promise(resolve => engine.canvas.addEventListener('webglcontextlost', resolve, { once: true }));
      extension.loseContext(); await lost;
      engine.render(project, [frame(l, red)], 2);
      const during = engine.getStats().contextLost;
      await new Promise(resolve => setTimeout(resolve, 120));
      const restored = new Promise(resolve => engine.canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
      extension.restoreContext(); await restored;
      engine.render(project, [frame(l, red)], 3);
      return { during, after: engine.getStats().contextLost, color: pixel(), errors, glError: engine.gl.getError() };
    });
    assert.equal(result.during, true);
    assert.equal(result.after, false);
    assert.deepEqual(result.color, [255, 0, 0, 255]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.glError, 0);
  } finally { await page.close(); }
});

test('real decoded video advances without repeated seeks and remains visible when paused', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const l = layer('video-layer'); project.layers = [l];
      const video = clip('video', '#ffffff', { kind: 'video', url: '/fixture.webm' });
      const media = await engine.prepare(video);
      await engine.audioContext.resume();
      let seeks = 0; media.addEventListener('seeking', () => seeks++);
      const start = performance.now()/1000;
      while (performance.now()/1000-start < 0.7) {
        const now = performance.now()/1000;
        engine.render(project, [frame(l, video, 1, now-start)], now);
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      const naturalSeeks = seeks;
      const decodedFrames = media.getVideoPlaybackQuality().totalVideoFrames;
      const playing = !media.paused;
      const playingPixels = pixel(40, 60);
      project.paused = true;
      engine.render(project, [frame(l, video, 1, 1.2)], performance.now()/1000);
      await new Promise(resolve => setTimeout(resolve, 100));
      engine.render(project, [frame(l, video, 1, 1.2)], performance.now()/1000);
      const pausedPixels = pixel(40, 60);
      const paused = media.paused;
      const position = media.currentTime;
      engine.render(project, [], performance.now()/1000);
      const stopped = media.paused && engine.media.get(video.id).gain === 0;
      return { naturalSeeks, decodedFrames, playing, playingPixels, pausedPixels, paused, position, stopped, errors, glError: engine.gl.getError() };
    });
    assert.ok(result.naturalSeeks <= 1, `unexpected seeks: ${result.naturalSeeks}`);
    assert.ok(result.decodedFrames >= 3, `decoded frames: ${result.decodedFrames}`);
    assert.equal(result.playing, true);
    assert.ok(result.playingPixels.some((value, index) => index < 3 && value > 10));
    assert.ok(result.pausedPixels.some((value, index) => index < 3 && value > 10));
    assert.equal(result.paused, true);
    assert.ok(Math.abs(result.position-1.2) < 0.03, JSON.stringify(result));
    assert.equal(result.stopped, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.glError, 0);
  } finally { await page.close(); }
});

test('known opaque video avoids repeated full-frame transparency scans', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const l = layer('known-opaque'); project.layers = [l];
      const video = clip('opaque', '#ffffff', { kind: 'video', url: '/fixture.webm', hasAlpha: false, alphaKnown: true });
      const original = engine._hasTransparency.bind(engine);
      let scans = 0;
      engine._hasTransparency = image => { scans++; return original(image); };
      const media = await engine.prepare(video);
      const start = performance.now()/1000;
      while (performance.now()/1000-start < 1.1) {
        const now = performance.now()/1000;
        engine.render(project, [frame(l, video, 1, now-start)], now);
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      return { scans, decodedFrames: media.getVideoPlaybackQuality().totalVideoFrames, errors };
    });
    assert.equal(result.scans, 0, 'The native importer already verified this clip is opaque.');
    assert.ok(result.decodedFrames >= 5, JSON.stringify(result));
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('invalid media reports a single useful error across repeated render attempts', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const l = layer('broken-layer'); project.layers = [l];
      const broken = clip('broken', '#ffffff', { kind: 'video', url: 'data:video/webm;base64,YnJva2Vu' });
      await engine.prepare(broken).catch(() => {});
      for (let i = 0; i < 100; i++) engine.render(project, [frame(l, broken)], i);
      return { errors, pixels: pixel(), ready: engine.getMedia(broken.id).readyState };
    });
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Cannot load broken/);
    assert.deepEqual(result.pixels, [0, 0, 0, 255]);
    assert.equal(result.ready, 0);
  } finally { await page.close(); }
});

test('clip, layer and composition effects run before their transforms', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(() => {
      const l = layer('layer'), red = clip('red', '#ff0000'); project.layers = [l];
      const stages = [];
      for (const stage of [red, l, project]) {
        stage.effects = [{ type: 'mirror', amount: 0.5 }]; stage.scale = 0.5; stage.x = 0.25;
        engine.render(project, [frame(l, red)], 1);
        stages.push([pixel(40, 45), pixel(120, 45)]);
        stage.effects = []; stage.scale = 1; stage.x = 0;
      }
      red.scale = 0.2; red.x = l.x = project.x = 0.1;
      engine.render(project, [frame(l, red)], 2);
      const hierarchy = [pixel(128, 45), pixel(80, 45)];
      red.x = l.x = project.x = 0; l.rotation = 90;
      engine.render(project, [frame(l, red)], 3);
      const rotation = [pixel(80, 57), pixel(92, 45)];
      project.scale = 0;
      engine.render(project, [frame(l, red)], 4);
      return { stages, hierarchy, rotation, zero: pixel(), errors, glError: engine.gl.getError() };
    });
    for (const stage of result.stages) assert.deepEqual(stage, [[0, 0, 0, 255], [255, 0, 0, 255]]);
    assert.deepEqual(result.hierarchy, [[255, 0, 0, 255], [0, 0, 0, 255]]);
    assert.deepEqual(result.rotation, [[255, 0, 0, 255], [0, 0, 0, 255]]);
    assert.deepEqual(result.zero, [0, 0, 0, 255]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.glError, 0);
  } finally { await page.close(); }
});

test('clip, layer and master pan route actual audio with measured stereo peak and RMS', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const l = layer('audio-layer'), audio = clip('audio', '#ffffff', { kind: 'audio', url: '/fixture.webm', pan: -1 });
      project.layers = [l]; await engine.prepare(audio); await engine.audioContext.resume();
      const start = performance.now()/1000;
      async function settle() {
        const until = performance.now()+230;
        while (performance.now() < until) {
          const now = performance.now()/1000;
          engine.render(project, [frame(l, audio, 1, now-start)], now);
          await new Promise(resolve => setTimeout(resolve, 16));
        }
        return engine.getStats();
      }
      const clipPan = await settle();
      l.pan = 1;
      const layerPan = await settle();
      project.pan = -1;
      const masterPan = await settle();
      project.bypass = true;
      const bypass = await settle();
      return { clipPan: clipPan.audio, layerPan: layerPan.audio, masterPan: masterPan.audio, layerMeter: masterPan.layerAudio[l.id], bypass: bypass.audio, errors };
    });
    for (const [label, reading, channel] of [['clip', result.clipPan, 0], ['layer', result.layerPan, 1], ['master', result.masterPan, 0]]) {
      assert.ok(reading.rms[channel] > 0.03, `${label}: ${JSON.stringify(reading)}`);
      assert.ok(reading.peak[channel] >= reading.rms[channel], `${label}: peak is below RMS`);
      assert.ok(reading.rms[1-channel] < 0.001, `${label}: opposite channel is audible`);
    }
    assert.ok(result.layerMeter.rms[1] > 0.03);
    assert.ok(Math.max(...result.bypass.rms) < 0.001);
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('idle decoder cache evicts least recently used media and preserves live playback', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      engine.maxMedia = 3;
      const l = layer('layer'); project.layers = [l];
      const clips = Array.from({ length: 7 }, (_, i) => clip(`audio-${i}`, '#ffffff', { kind: 'audio', url: '/fixture.webm' }));
      const live = await engine.prepare(clips[0]);
      await engine.audioContext.resume();
      engine.render(project, [frame(l, clips[0])], 1);
      const oldestIdle = await engine.prepare(clips[1]);
      for (const item of clips.slice(2)) await engine.prepare(item);
      const before = { count: engine.getStats().mediaCount, liveRetained: engine.getMedia(clips[0].id) === live, idleEvicted: !engine.getMedia(clips[1].id), idleReleased: !oldestIdle.getAttribute('src'), newestRetained: !!engine.getMedia(clips[6].id) };
      engine.render(project, [], 2);
      await engine.prepare(clips[1]);
      return { before, afterCount: engine.getStats().mediaCount, stoppedEvicted: !engine.getMedia(clips[0].id), errors };
    });
    assert.deepEqual(result.before, { count: 3, liveRetained: true, idleEvicted: true, idleReleased: true, newestRetained: true });
    assert.equal(result.afterCount, 3);
    assert.equal(result.stoppedEvicted, true);
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('separate audio defines the video clock, component toggles and linked AV levels reach output', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const url = wave(6), silentUrl = wave(6, 0);
      const l = layer('av-layer'); project.layers = [l];
      const av = clip('paired', '#ffffff', { kind: 'video', url: '/fixture.webm', audio: { id: 'soundtrack', url, duration: 1 } });
      const video = await engine.prepare(av), audio = engine.getAudio(av.id);
      await engine.audioContext.resume();
      let videoSeeks = 0, audioSeeks = 0;
      video.addEventListener('seeking', () => videoSeeks++);
      audio.addEventListener('seeking', () => audioSeeks++);
      const start = performance.now()/1000;
      async function settle(ms = 240) {
        const until = performance.now()+ms;
        while (performance.now() < until) {
          const now = performance.now()/1000;
          engine.render(project, [frame(l, av, 1, now-start)], now);
          await new Promise(resolve => setTimeout(resolve, 16));
        }
        return { rms: engine.getStats().audioRms, pixel: pixel(40, 60) };
      }
      const baseline = await settle(470);
      const clock = { duration: av.duration, audioDuration: av.audio.duration, nativeDuration: video.duration, savedVideoDuration: av.videoDuration, audioTime: audio.currentTime, videoTime: video.currentTime, videoRate: video.playbackRate, audioRate: audio.playbackRate, videoSeeks, audioSeeks, muted: video.muted, playing: !audio.paused && !video.paused };
      l.av = 0.5; project.av = 0.5;
      const attenuated = await settle();
      av.useAudio = false;
      const videoOnly = await settle();
      av.useAudio = true; av.useVideo = false;
      const audioOnly = await settle();
      av.useVideo = true;
      project.paused = true;
      engine.render(project, [frame(l, av, 1, 3)], performance.now()/1000);
      await new Promise(resolve => setTimeout(resolve, 120));
      engine.render(project, [frame(l, av, 1, 3)], performance.now()/1000);
      const seek = { video: video.currentTime, audio: audio.currentTime, paused: video.paused && audio.paused };
      project.paused = false;
      av.audio = { id: 'silence', url: silentUrl, duration: 6 };
      await engine.prepare(av);
      const silence = await settle();
      const oldAudioReleased = !audio.getAttribute('src');
      const currentAudio = engine.getAudio(av.id);
      engine.maxMedia = 3;
      for (let i = 0; i < 5; i++) await engine.prepare(clip(`idle-${i}`, '#ffffff', { kind: 'audio', url }));
      const retained = engine.getMedia(av.id) === video && engine.getAudio(av.id) === currentAudio;
      engine.remove(av.id);
      const removed = !engine.getMedia(av.id) && !engine.getAudio(av.id) && !video.getAttribute('src') && !currentAudio.getAttribute('src');
      engine.dispose(); URL.revokeObjectURL(url); URL.revokeObjectURL(silentUrl);
      return { baseline, attenuated, videoOnly, audioOnly, clock, seek, silence, oldAudioReleased, retained, removed, errors };
    });
    assert.equal(result.clock.duration, 6);
    assert.equal(result.clock.audioDuration, 6);
    assert.equal(result.clock.savedVideoDuration, result.clock.nativeDuration);
    assert.ok(Math.abs(result.clock.videoRate-result.clock.nativeDuration/6) < 0.015, JSON.stringify(result.clock));
    assert.ok(Math.abs(result.clock.audioRate-1) < 0.015);
    assert.ok(Math.abs(result.clock.videoTime/result.clock.nativeDuration-result.clock.audioTime/6) < 0.04, JSON.stringify(result.clock));
    assert.ok(result.clock.audioSeeks <= 1 && result.clock.videoSeeks <= 1, JSON.stringify(result.clock));
    assert.equal(result.clock.muted, true);
    assert.equal(result.clock.playing, true);
    assert.ok(result.baseline.rms > 0.04, JSON.stringify(result));
    assert.ok(Math.abs(result.attenuated.rms/result.baseline.rms-0.25) < 0.06, JSON.stringify(result));
    assert.ok(result.videoOnly.rms < 0.001);
    assert.ok(result.videoOnly.pixel.slice(0, 3).some(value => value > 5));
    assert.ok(result.audioOnly.rms > 0.01);
    assert.deepEqual(result.audioOnly.pixel, [0, 0, 0, 255]);
    assert.ok(Math.abs(result.seek.video-result.clock.nativeDuration/2) < 0.03);
    assert.ok(Math.abs(result.seek.audio-3) < 0.03);
    assert.equal(result.seek.paused, true);
    assert.ok(result.silence.rms < 0.001, 'embedded video audio leaked into the silent replacement soundtrack');
    assert.equal(result.oldAudioReleased, true);
    assert.equal(result.retained, true);
    assert.equal(result.removed, true);
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('fit modes and linked AV levels produce exact output pixels', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const source = document.createElement('canvas'); source.width = source.height = 40;
      const context = source.getContext('2d'); context.fillStyle = 'red'; context.fillRect(0, 0, 40, 40);
      context.fillStyle = 'blue'; context.fillRect(0, 0, 40, 10);
      const image = clip('fit', '#ffffff', { kind: 'image', url: source.toDataURL() });
      const l = layer('fit-layer'); project.layers = [l]; await engine.prepare(image);
      const modes = {};
      for (const fit of ['contain', 'cover', 'stretch', 'original']) {
        image.fit = fit; engine.render(project, [frame(l, image)], 1);
        modes[fit] = [pixel(10, 45), pixel(80, 80), pixel(80, 45), pixel(80, 65)];
      }
      image.fit = 'stretch'; l.av = 0.5; project.av = 0.5;
      engine.render(project, [frame(l, image)], 2);
      const linked = pixel();
      l.av = 0; engine.render(project, [frame(l, image)], 3);
      return { modes, linked, closed: pixel(), errors };
    });
    const black = [0, 0, 0, 255], red = [255, 0, 0, 255], blue = [0, 0, 255, 255];
    assert.deepEqual(result.modes.contain, [black, blue, red, red]);
    assert.deepEqual(result.modes.cover, [red, red, red, red]);
    assert.deepEqual(result.modes.stretch, [red, blue, red, red]);
    assert.deepEqual(result.modes.original, [black, black, red, black]);
    assert.deepEqual(result.linked, [64, 0, 0, 255]);
    assert.deepEqual(result.closed, black);
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('image masks use red or transparency, invert, bypass and follow three-scope render order', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const source = document.createElement('canvas'); source.width = 160; source.height = 90;
      const context = source.getContext('2d');
      context.fillStyle = 'red'; context.fillRect(0, 0, 80, 90);
      context.fillStyle = 'green'; context.fillRect(80, 0, 80, 90);
      const redMask = source.toDataURL();
      context.clearRect(0, 0, 160, 90); context.fillStyle = 'rgba(0,0,0,0.5)'; context.fillRect(0, 0, 80, 90);
      const alphaMask = source.toDataURL();
      const l = layer('masked-layer'), red = clip('red', '#ff0000'); project.layers = [l];
      const stages = [];
      for (const owner of [red, l, project]) {
        owner.mask = { id: `mask-${owner.id}`, url: redMask };
        await engine.prepareMask(owner);
        engine.render(project, [frame(l, red)], 1);
        const normal = [pixel(40), pixel(120)];
        owner.mask.invert = true;
        engine.render(project, [frame(l, red)], 2);
        const inverted = [pixel(40), pixel(120)];
        owner.mask.enabled = false;
        engine.render(project, [frame(l, red)], 3);
        const bypass = [pixel(40), pixel(120)];
        owner.mask.enabled = true; owner.mask.invert = false;
        owner.effects = [{ type: 'invert', amount: 1 }]; owner.scale = 0.5; owner.x = 0.25;
        engine.render(project, [frame(l, red)], 4);
        const beforeTransform = [pixel(100), pixel(140)];
        owner.renderOrder = ['effects', 'transform', 'mask'];
        engine.render(project, [frame(l, red)], 5);
        const afterTransform = [pixel(100), pixel(140)];
        owner.effects = []; owner.scale = 1; owner.x = 0; owner.renderOrder = ['effects', 'mask', 'transform'];
        owner.mask.url = alphaMask;
        await engine.prepareMask(owner);
        engine.render(project, [frame(l, red)], 6);
        const alpha = [pixel(40), pixel(120)];
        stages.push({ normal, inverted, bypass, beforeTransform, afterTransform, alpha });
        engine.removeMask(owner.mask.id); owner.mask = null;
      }
      project.mask = { id: 'restore-mask', url: redMask };
      await engine.prepareMask(project);
      engine.render(project, [frame(l, red)], 7);
      const extension = engine.gl.getExtension('WEBGL_lose_context');
      const lost = new Promise(resolve => engine.canvas.addEventListener('webglcontextlost', resolve, { once: true }));
      extension.loseContext(); await lost;
      await new Promise(resolve => setTimeout(resolve, 120));
      const restored = new Promise(resolve => engine.canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
      extension.restoreContext(); await restored;
      engine.render(project, [frame(l, red)], 8);
      const recovered = [pixel(40), pixel(120)], glError = engine.gl.getError();
      engine.removeMask(project.mask.id);
      const remaining = engine.getStats().mediaCount;
      engine.dispose();
      return { stages, recovered, remaining, errors, glError };
    });
    const black = [0, 0, 0, 255], red = [255, 0, 0, 255], cyan = [0, 255, 255, 255];
    for (const stage of result.stages) {
      assert.deepEqual(stage.normal, [red, black]);
      assert.deepEqual(stage.inverted, [black, red]);
      assert.deepEqual(stage.bypass, [red, red]);
      assert.deepEqual(stage.beforeTransform, [cyan, black]);
      assert.deepEqual(stage.afterTransform, [black, black]);
      assert.deepEqual(stage.alpha, [[128, 0, 0, 255], black]);
    }
    assert.deepEqual(result.recovered, [red, black]);
    assert.equal(result.remaining, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.glError, 0);
  } finally { await page.close(); }
});

test('paired tracks keep running through multiple full loops and restore embedded audio on detach', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const url = wave(0.8), l = layer('loop-layer'); project.layers = [l];
      const av = clip('loop-pair', '#ffffff', { kind: 'video', url: '/fixture.webm', loop: 'loop', audio: { id: 'loop-audio', url } });
      const video = await engine.prepare(av), audio = engine.getAudio(av.id);
      await engine.audioContext.resume();
      const start = performance.now()/1000;
      let boundaries = 0, previous = 0;
      const wrapStates = [];
      while (performance.now()/1000-start < 1.85) {
        const now = performance.now()/1000, time = (now-start)%av.duration;
        engine.render(project, [{ ...frame(l, av, 1, time), rate: 1, direction: 1, playing: true }], now);
        if (time < previous) { boundaries++; wrapStates.push({ gain: engine.media.get(JSON.stringify(['audio', av.id])).gain, running: !audio.paused && !video.paused }); }
        previous = time;
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      const paired = { boundaries, wrapStates, nativeLoops: video.loop && audio.loop, duration: av.duration, audioTime: audio.currentTime, videoTime: video.currentTime, nativeDuration: video.duration };
      av.audio = null;
      await engine.prepare(av);
      engine.render(project, [{ ...frame(l, av, 1, 0.3), rate: 1, direction: 1 }], performance.now()/1000);
      const detached = { restoredDuration: av.duration, videoMuted: video.muted, pairedReleased: !engine.getAudio(av.id) && !audio.getAttribute('src'), embeddedGain: engine.media.get(av.id).gain, rate: video.playbackRate };
      engine.dispose(); URL.revokeObjectURL(url);
      return { paired, detached, errors };
    });
    assert.equal(result.paired.boundaries, 2);
    assert.equal(result.paired.nativeLoops, true);
    assert.ok(result.paired.wrapStates.every(state => state.gain === 1 && state.running), JSON.stringify(result.paired));
    assert.ok(Math.abs(result.paired.videoTime/result.paired.nativeDuration-result.paired.audioTime/0.8) < 0.2, JSON.stringify(result.paired));
    assert.equal(result.detached.restoredDuration, result.paired.nativeDuration);
    assert.equal(result.detached.videoMuted, false);
    assert.equal(result.detached.pairedReleased, true);
    assert.equal(result.detached.embeddedGain, 1);
    assert.equal(result.detached.rate, 1);
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('generators and still images can carry audio and release both tracks on deletion', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const url = wave(2), source = document.createElement('canvas'); source.width = source.height = 20;
      const context = source.getContext('2d'); context.fillStyle = 'red'; context.fillRect(0, 0, 20, 20);
      const l = layer('layer'); project.layers = [l];
      const results = [];
      for (const kind of ['source', 'image']) {
        const av = clip(kind, '#ff0000', { kind, url: source.toDataURL(), audio: { id: `${kind}-audio`, url } });
        const main = await engine.prepare(av), audio = engine.getAudio(av.id);
        await engine.audioContext.resume();
        const start = performance.now()/1000;
        while (performance.now()/1000-start < 0.25) {
          const now = performance.now()/1000; engine.render(project, [frame(l, av, 1, now-start)], now);
          await new Promise(resolve => setTimeout(resolve, 16));
        }
        const playing = { duration: av.duration, hasMain: !!main, pixel: pixel(), rms: engine.getStats().audioRms };
        engine.remove(av.id);
        results.push({ ...playing, released: !engine.getAudio(av.id) && !audio.getAttribute('src'), count: engine.getStats().mediaCount });
      }
      engine.dispose(); URL.revokeObjectURL(url);
      return { results, errors };
    });
    assert.equal(result.results[0].hasMain, false);
    assert.equal(result.results[1].hasMain, true);
    for (const row of result.results) {
      assert.equal(row.duration, 2);
      assert.deepEqual(row.pixel, [255, 0, 0, 255]);
      assert.ok(row.rms > 0.04);
      assert.equal(row.released, true);
      assert.equal(row.count, 0);
    }
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('XYZ surface rotation projects perspective and local pixel anchors at every scope', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(() => {
      const l = layer('layer'), red = clip('red', '#ff0000'); project.layers = [l];
      const stages = [];
      for (const owner of [red, l, project]) {
        owner.scale = 0.5; owner.rotationY = 60;
        engine.render(project, [frame(l, red)], 1);
        const yaw = [pixel(50, 75), pixel(90, 70), pixel(94, 45)];
        owner.rotationY = 0; owner.rotationX = 60;
        engine.render(project, [frame(l, red)], 2);
        const pitch = [pixel(125, 56), pixel(125, 36), pixel(80, 59)];
        owner.rotationX = 0; owner.anchorX = 40;
        engine.render(project, [frame(l, red)], 3);
        const anchorShift = [pixel(25, 45), pixel(105, 45)];
        owner.rotation = 90;
        engine.render(project, [frame(l, red)], 4);
        const anchoredRotation = [pixel(80, 10), pixel(80, 70)];
        owner.rotation = 0; owner.anchorX = 0; owner.anchorZ = 40;
        engine.render(project, [frame(l, red)], 5);
        const depth = [pixel(110, 45), pixel(115, 45)];
        owner.anchorZ = 0; owner.rotationY = 90;
        engine.render(project, [frame(l, red)], 6);
        const edge = pixel();
        owner.rotationY = 0; owner.scale = 1;
        stages.push({ yaw, pitch, anchorShift, anchoredRotation, depth, edge });
      }
      return { stages, errors, glError: engine.gl.getError() };
    });
    const red = [255, 0, 0, 255], black = [0, 0, 0, 255];
    for (const stage of result.stages) {
      assert.deepEqual(stage.yaw, [red, black, black]);
      assert.deepEqual(stage.pitch, [red, black, red]);
      assert.deepEqual(stage.anchorShift, [red, black]);
      assert.deepEqual(stage.anchoredRotation, [red, black]);
      assert.deepEqual(stage.depth, [red, black]);
      assert.deepEqual(stage.edge, black);
    }
    assert.deepEqual(result.errors, []); assert.equal(result.glError, 0);
  } finally { await page.close(); }
});

test('native metadata, width/height fit and explicit dimensions obey scope and effect order', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const source = document.createElement('canvas'); source.width = 40; source.height = 20;
      const context = source.getContext('2d'); context.fillStyle = 'red'; context.fillRect(0, 0, 40, 20);
      const image = clip('size', '#ffffff', { kind: 'image', url: source.toDataURL(), fit: 'width' });
      const l = layer('layer'); project.layers = [l]; await engine.prepare(image);
      const metadata = { width: image.nativeWidth, height: image.nativeHeight, ...engine.getMediaInfo(image) };
      engine.render(project, [frame(l, image)], 1);
      const widthFit = [pixel(5, 45), pixel(80, 3), pixel(80, 8)];
      image.fit = 'height'; engine.render(project, [frame(l, image)], 2);
      const heightFit = [pixel(5, 45), pixel(80, 3)];
      image.width = 40; image.height = 20;
      l.width = 80; l.height = 40;
      engine.render(project, [frame(l, image)], 3);
      const disabled = [pixel(65, 45), pixel(50, 45), pixel(80, 60)];
      l.widthEnabled = l.heightEnabled = true;
      engine.render(project, [frame(l, image)], 4);
      const enabled = [pixel(50, 45), pixel(80, 60), pixel(30, 45)];
      l.width = 160; l.height = 90;
      engine.render(project, [frame(l, image)], 5);
      const fill = pixel(5, 5);
      l.widthEnabled = l.heightEnabled = false;
      image.width = 80; image.height = 90; image.x = 0.25; image.effects = [{ type: 'mirror', amount: 0.5 }];
      engine.render(project, [frame(l, image)], 6);
      const before = [pixel(20), pixel(140)];
      image.renderOrder = ['transform', 'effects', 'mask'];
      engine.render(project, [frame(l, image)], 7);
      const after = [pixel(20), pixel(140)];
      image.width = 0; engine.render(project, [frame(l, image)], 8);
      const collapsedClip = pixel(120);
      image.width = 80; l.widthEnabled = true; l.width = 0;
      engine.render(project, [frame(l, image)], 9);
      return { metadata, widthFit, heightFit, disabled, enabled, fill, before, after, collapsedClip, collapsedLayer: pixel(120), errors, glError: engine.gl.getError() };
    });
    const red = [255, 0, 0, 255], black = [0, 0, 0, 255];
    assert.deepEqual(result.metadata, { width: 40, height: 20, nativeWidth: 40, nativeHeight: 20, hasAlpha: false });
    assert.deepEqual(result.widthFit, [red, black, red]); assert.deepEqual(result.heightFit, [red, red]);
    assert.deepEqual(result.disabled, [red, black, black]); assert.deepEqual(result.enabled, [red, red, black]);
    assert.deepEqual(result.fill, red); assert.deepEqual(result.before, [black, red]); assert.deepEqual(result.after, [red, red]);
    assert.deepEqual(result.collapsedClip, black); assert.deepEqual(result.collapsedLayer, black);
    assert.deepEqual(result.errors, []); assert.equal(result.glError, 0);
  } finally { await page.close(); }
});

test('RGB channel switches and detected image alpha change rendered pixels', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const source = document.createElement('canvas'); source.width = source.height = 20;
      const context = source.getContext('2d'); context.fillStyle = 'rgba(200,100,50,0.5)'; context.fillRect(0, 0, 20, 20);
      const top = clip('alpha', '#ffffff', { kind: 'image', url: source.toDataURL() });
      const bottom = clip('blue', '#0000ff'), l1 = layer('bottom'), l2 = layer('top'); project.layers = [l1, l2];
      await engine.prepare(top);
      const frames = [frame(l1, bottom), frame(l2, top)];
      engine.render(project, frames, 1); const normal = pixel();
      top.green = false; engine.render(project, frames, 2); const greenOff = pixel();
      top.green = true; top.alpha = false; engine.render(project, frames, 3); const opaque = pixel();
      top.red = top.green = false; engine.render(project, frames, 4); const onlyBlue = pixel();
      const alpha = top.hasAlpha;
      const generated = clip('generated', '#abcdef', { red: false, green: false, alpha: false });
      engine.render(project, [frame(l2, generated)], 5);
      return { normal, greenOff, opaque, onlyBlue, alpha, generated: pixel(), errors };
    });
    const close = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value-expected[index]) <= 1, `${actual} ≠ ${expected}`));
    close(result.normal, [100, 50, 152, 255]); close(result.greenOff, [100, 0, 152, 255]);
    close(result.opaque, [200, 100, 50, 255]); close(result.onlyBlue, [0, 0, 50, 255]);
    assert.equal(result.alpha, true); assert.deepEqual(result.generated, [0, 0, 239, 255]); assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('transparent video preserves native alpha metadata and composites decoded animation exactly once', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      // Original 32x16 fixture, three frames at 2 fps encoded as lossless VP9
      // yuva420p. Frame 0 is opaque red. Frames 1/2 are red/green with alpha
      // 0, 128 and 255 across x=0..7, 8..23 and 24..31 respectively.
      const top = clip('alpha-video', '#ffffff', { kind: 'video', url: '/alpha-fixture.webm', hasAlpha: true, fit: 'stretch' });
      const bottom = clip('blue', '#0000ff'), l1 = layer('bottom'), l2 = layer('top');
      project.layers = [l1, l2]; project.paused = true;
      const video = await engine.prepare(top);
      const preparedAlpha = top.hasAlpha;
      const sample = async (asset, media, time) => {
        const frames = [frame(l1, bottom), frame(l2, asset, 1, time)];
        engine.render(project, frames, performance.now()/1000);
        if (media.seeking || media.readyState < 2) {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { cleanup(); reject(new Error('Video did not decode the requested frame.')); }, 5000);
            const done = () => { if (!media.seeking && media.readyState >= 2) { cleanup(); resolve(); } };
            const cleanup = () => { clearTimeout(timeout); media.removeEventListener('seeked', done); media.removeEventListener('loadeddata', done); };
            media.addEventListener('seeked', done); media.addEventListener('loadeddata', done); done();
          });
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        engine.render(project, frames, performance.now()/1000);
        return [pixel(20), pixel(80), pixel(140)];
      };
      const first = await sample(top, video, 0);
      const opaqueFrameAlpha = top.hasAlpha;
      const red = await sample(top, video, 0.75);
      top.alpha = false;
      const alphaOff = await sample(top, video, 0.75);
      top.alpha = true;
      const alphaOn = await sample(top, video, 0.75);
      const green = await sample(top, video, 1.25);
      const reverse = await sample(top, video, 0.75);
      await engine.prepare(top);
      const metadata = engine.getMediaInfo(top);

      // Browser imports do not have the native codec's alpha declaration.
      // An opaque initial frame must not permanently hide their alpha switch.
      const unknown = clip('unprobed-alpha', '#ffffff', { kind: 'video', url: '/alpha-fixture.webm', fit: 'stretch' });
      const unknownVideo = await engine.prepare(unknown);
      await sample(unknown, unknownVideo, 0);
      const initiallyOpaque = unknown.hasAlpha;
      const detected = await sample(unknown, unknownVideo, 0.75);
      const detectedAlpha = unknown.hasAlpha;
      engine.dispose();
      return { preparedAlpha, opaqueFrameAlpha, first, red, alphaOff, alphaOn, green, reverse, metadata, initiallyOpaque, detected, detectedAlpha, errors };
    });
    const close = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value-expected[index]) <= 3, `${actual} differs from ${expected}`));
    const closePixels = (actual, expected) => actual.forEach((value, index) => close(value, expected[index]));
    const red = [255, 0, 0, 255], green = [0, 255, 0, 255], blue = [0, 0, 255, 255];
    assert.equal(result.preparedAlpha, true); assert.equal(result.opaqueFrameAlpha, true);
    closePixels(result.first, [red, red, red]);
    closePixels(result.red, [blue, [128, 0, 127, 255], red]);
    close(result.alphaOff[1], red); close(result.alphaOff[2], red);
    assert.deepEqual(result.alphaOn, result.red);
    closePixels(result.green, [blue, [0, 128, 127, 255], green]);
    assert.deepEqual(result.reverse, result.red);
    assert.deepEqual(result.metadata, { nativeWidth: 32, nativeHeight: 16, hasAlpha: true });
    assert.equal(result.initiallyOpaque, false); assert.equal(result.detectedAlpha, true);
    closePixels(result.detected, result.red);
    assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('routed instances of one paired clip have independent decoders, clocks and cache lifetime', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const home = layer('home'), remote = layer('remote'), url = wave(6); project.layers = [home, remote];
      const av = clip('routed', '#ffffff', { kind: 'video', url: '/fixture.webm', audio: { id: 'pair', url } });
      const voiceId = 'remote:routed';
      const first = await engine.prepare(av), second = await engine.prepare(av, voiceId);
      const firstAudio = engine.getAudio(av.id), secondAudio = engine.getAudio(av.id, voiceId);
      const homeFrame = time => ({ ...frame(home, av, 1, time), sourceLayerId: home.id, voiceId: 'home:routed', rate: 1, direction: 1 });
      const remoteFrame = time => ({ ...frame(remote, av, 1, time), sourceLayerId: home.id, voiceId, rate: 1, direction: 1 });
      project.paused = true;
      engine.render(project, [homeFrame(0.5), remoteFrame(3)], 1);
      await new Promise(resolve => setTimeout(resolve, 140));
      engine.render(project, [homeFrame(0.5), remoteFrame(3)], 2);
      const seek = { first: first.currentTime, second: second.currentTime, firstAudio: firstAudio.currentTime, secondAudio: secondAudio.currentTime, duration: first.duration, independent: first !== second && firstAudio !== secondAudio };
      project.paused = false; await engine.audioContext.resume();
      engine.render(project, [remoteFrame(3)], 3);
      await new Promise(resolve => setTimeout(resolve, 80));
      engine.maxMedia = 2;
      await engine.prepare(clip('idle', '#fff', { kind: 'audio', url }));
      const eviction = { baseReleased: !first.getAttribute('src') && !firstAudio.getAttribute('src'), routedRetained: engine.getMedia(av.id, voiceId) === second && engine.getAudio(av.id, voiceId) === secondAudio, routedPlaying: !second.paused && !secondAudio.paused };
      engine.remove(av.id);
      const released = !second.getAttribute('src') && !secondAudio.getAttribute('src');
      engine.dispose(); URL.revokeObjectURL(url);
      return { seek, eviction, released, errors };
    });
    assert.equal(result.seek.independent, true);
    assert.ok(Math.abs(result.seek.first-result.seek.duration/12) < 0.03); assert.ok(Math.abs(result.seek.second-result.seek.duration/2) < 0.03);
    assert.ok(Math.abs(result.seek.firstAudio-0.5) < 0.03); assert.ok(Math.abs(result.seek.secondAudio-3) < 0.03);
    assert.deepEqual(result.eviction, { baseReleased: true, routedRetained: true, routedPlaying: true });
    assert.equal(result.released, true); assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('layer size overrides keep different-sized transition clips aligned without changing effect order', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(() => {
      const l = layer('layer', { width: 80, height: 40, widthEnabled: true, heightEnabled: true, effects: [{ type: 'invert', amount: 1 }] });
      const red = clip('small', '#ff0000', { width: 40, height: 20 }), blue = clip('large', '#0000ff', { width: 120, height: 70 });
      project.layers = [l];
      const snapshots = [];
      for (const progress of [0, 0.5, 1]) {
        engine.render(project, [
          { ...frame(l, red, 1-progress), transitionMode: 'alpha', transitionProgress: progress, transitionIncoming: false },
          { ...frame(l, blue, progress), transitionMode: 'alpha', transitionProgress: progress, transitionIncoming: true },
        ], 1+progress);
        snapshots.push([pixel(45, 45), pixel(115, 45), pixel(35, 45), pixel(80, 20)]);
      }
      l.effects = [{ type: 'mirror', amount: 0.5 }];
      const sample = frames => { engine.render(project, frames, 4); return [pixel(5), pixel(40), pixel(80), pixel(120), pixel(155)]; };
      const single = sample([frame(l, red)]);
      const pair = sample([{ ...frame(l, red), transitionMode: 'alpha', transitionProgress: 0, transitionIncoming: false },
        { ...frame(l, blue, 0), transitionMode: 'alpha', transitionProgress: 0, transitionIncoming: true }]);
      l.effects = [{ type: 'brightness', amount: 1 }];
      engine.render(project, [{ ...frame(l, red, 0.5), transitionMode: 'alpha', transitionProgress: 0.5, transitionIncoming: false },
        { ...frame(l, blue, 0.5), transitionMode: 'alpha', transitionProgress: 0.5, transitionIncoming: true }], 5);
      return { snapshots, single, pair, nonlinear: pixel(), errors, glError: engine.gl.getError() };
    });
    const black = [0, 0, 0, 255];
    for (const [index, color] of [[0, [0, 255, 255, 255]], [1, [127, 255, 127, 255]], [2, [255, 255, 0, 255]]]) {
      assert.deepEqual(result.snapshots[index], [color, color, black, black]);
    }
    assert.deepEqual(result.pair, result.single);
    assert.deepEqual(result.nonlinear, [255, 0, 255, 255]);
    assert.deepEqual(result.errors, []); assert.equal(result.glError, 0);
  } finally { await page.close(); }
});

test('GIF composition follows transport timing, pause, seeks, reverse, retrigger and transparent disposal', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const { createProject, createLayer, createClip, Transport } = await import('/model.js');
      const url = gif(), animation = createClip('image', { name: 'Animated fixture.gif', url, fit: 'stretch' });
      project = createProject(); project.width = 160; project.height = 90;
      const l = createLayer('GIF layer'); l.clips[project.selectedDeckId] = [animation]; project.layers = [l];
      await engine.prepare(animation);
      const transport = new Transport(project);
      transport.trigger(l.id, animation.id, 0);
      const sample = async now => {
        const frames = transport.tick(now);
        engine.render(project, frames, now);
        while (engine.media.get(animation.id).animation.pending) await engine.media.get(animation.id).animation.pending;
        engine.render(project, frames, now);
        return [pixel(20, 75), pixel(140, 75), pixel(20, 15), pixel(140, 15)];
      };
      const first = await sample(0.05), second = await sample(0.15), longFrame = await sample(0.35), third = await sample(0.45);
      project.paused = true;
      await new Promise(resolve => setTimeout(resolve, 140));
      const paused = await sample(1.5);
      transport.seek(l.id, 0.3);
      const seek = await sample(1.5);
      transport.trigger(l.id, animation.id, 1.5);
      const retrigger = await sample(1.5);
      project.paused = false;
      const looped = await sample(2.15);
      transport.setGlobalDirection('backward');
      const reverse = await sample(2.3);
      const duration = animation.duration, metadata = engine.getMediaInfo(animation), cache = engine.media.get(animation.id).animation;
      const savedFrames = [...cache.frames.values()];
      engine.remove(animation.id);
      const released = cache.closed && cache.frames.size === 0 && savedFrames.every(frame => frame.codedWidth === 0);
      engine.dispose(); URL.revokeObjectURL(url);
      return { first, second, longFrame, third, paused, seek, retrigger, looped, reverse, duration, metadata, released, errors };
    });
    const red = [255, 0, 0, 255], blue = [0, 0, 255, 255], green = [0, 255, 0, 255], black = [0, 0, 0, 255];
    assert.deepEqual(result.first, [red, red, red, red]);
    assert.deepEqual(result.second, [black, blue, black, blue]);
    assert.deepEqual(result.longFrame, result.second);
    assert.deepEqual(result.third, [green, black, black, black]);
    assert.deepEqual(result.paused, result.third);
    assert.deepEqual(result.seek, result.second);
    assert.deepEqual(result.retrigger, result.first);
    assert.deepEqual(result.looped, result.first);
    assert.deepEqual(result.reverse, result.third);
    assert.ok(Math.abs(result.duration - 0.6) < 0.000001);
    assert.deepEqual(result.metadata, { nativeWidth: 4, nativeHeight: 4, hasAlpha: true });
    assert.equal(result.released, true); assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('routed GIF voices display independent frames and release decoder resources', { skip: !browserAvailable }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const url = gif(), home = layer('home', { scale: 0.5, x: -0.25 }), remote = layer('remote', { scale: 0.5, x: 0.25 });
      const animation = clip('animation', '#ffffff', { kind: 'image', url, fit: 'stretch' });
      project.layers = [home, remote]; project.paused = true;
      await engine.prepare(animation); await engine.prepare(animation, 'remote-voice');
      const frames = [{ ...frame(home, animation, 1, 0.05), sourceLayerId: home.id }, { ...frame(remote, animation, 1, 0.45), sourceLayerId: home.id, voiceId: 'remote-voice' }];
      engine.render(project, frames, 1);
      const entries = [...engine.media.values()];
      await Promise.all(entries.map(entry => entry.animation.pending));
      engine.render(project, frames, 1);
      const composed = [pixel(25, 60), pixel(105, 60), pixel(135, 30)];
      const independent = entries[0].animation !== entries[1].animation && entries[0].animation.currentIndex !== entries[1].animation.currentIndex;
      engine.remove(animation.id);
      const released = entries.every(entry => entry.animation.closed && entry.animation.frames.size === 0) && engine.media.size === 0;
      engine.dispose(); URL.revokeObjectURL(url);
      return { composed, independent, released, errors };
    });
    assert.deepEqual(result.composed, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 0, 255]]);
    assert.equal(result.independent, true); assert.equal(result.released, true); assert.deepEqual(result.errors, []);
  } finally { await page.close(); }
});

test('GIF output keeps advancing when decode finishes after the transport requests later frames', async () => {
  const requests = [], decoded = [];
  const fakeDecoder = {
    decode({ frameIndex }) { return new Promise(resolve => requests.push({ frameIndex, resolve })); },
    close() {},
  };
  const playback = new GifPlayback(fakeDecoder, { ends: Array.from({ length: 30 }, (_, i) => (i + 1) * 0.02), duration: 0.6 }, error => { throw error; });
  playback.cacheLimit = 2;
  const complete = async () => {
    const request = requests.shift(), pending = playback.pending;
    const image = { index: request.frameIndex, closed: false, close() { this.closed = true; } };
    decoded.push(image); request.resolve({ image }); await pending;
  };
  const shown = [];
  try {
    playback.frameAt(0);
    await complete();
    for (let i = 1; i < 20; i += 2) {
      playback.frameAt(i * 0.02 + 0.001);
      // The live transport advances again before this decode completes.
      playback.frameAt((i + 1) * 0.02 + 0.001);
      await complete();
      shown.push(playback.frameAt((i + 1) * 0.02 + 0.001).index);
      assert.ok(playback.frames.size <= 2);
      assert.equal(playback.current.closed, false);
    }
    assert.ok(new Set(shown).size >= 8, `Slow decoding froze GIF output: ${shown}`);
    assert.ok(shown.at(-1) > 15);

    // With a one-frame cache, a completed old decode must not replace or
    // close an exact cached seek target. Resolve a decode in flight after
    // seeking back to the frame already on screen.
    playback.cacheLimit = 1;
    const seekIndex = playback.currentIndex, seekImage = playback.current;
    playback.frameAt(seekIndex * 0.02 + 0.001);
    await complete();
    assert.equal(playback.current, seekImage);
    assert.equal(playback.current.closed, false);
    assert.equal(playback.frames.size, 1);
    assert.equal(decoded.at(-1).closed, true);
  } finally {
    playback.close();
    if (requests.length) await complete();
  }
  assert.ok(decoded.every(image => image.closed));
});
