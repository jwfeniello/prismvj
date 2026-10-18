import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { BLEND_MODES, BLEND_IDS, TRANSITION_IDS, normalizeBlend } from '../src/blends.js';
import { sourceFile } from './src-server.mjs';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const gpuOptions = { skip: !existsSync(chrome), timeout: 60000 };
let browser, server, baseURL;
before(async () => {
  if (!existsSync(chrome)) return;
  const files = new Map(await Promise.all(['engine.js', 'blends.js', 'gif-playback.js'].map(async name => [`/${name}`, await readFile(new URL(`../src/${name}`, import.meta.url))])));
  server = createServer((request, response) => {
    const source = sourceFile(request.url);
    if (source) { response.setHeader('Content-Type', source.type); response.end(source.body); return; }
    response.setHeader('Content-Type', files.has(request.url) ? 'text/javascript' : 'text/html');
    response.end(files.get(request.url) || '<!doctype html><canvas width="96" height="64"></canvas>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function setup() {
  const page = await browser.newPage();
  await page.goto(baseURL);
  await page.evaluate(async () => {
    const { LiveEngine } = await import('/engine.js');
    const catalog = await import('/blends.js');
    Object.assign(window, { blendIds: catalog.BLEND_IDS, transitionIds: catalog.TRANSITION_IDS });
    window.errors = [];
    window.engine = new LiveEngine(document.querySelector('canvas'), { onError: error => errors.push(error) });
    window.project = { id: 'blend-project', width: 96, height: 64, speed: 1, bpm: 120, av: 1, masterOpacity: 1, masterVolume: 0, crossfader: 0.5, layers: [], effects: [] };
    window.layer = (id, extra = {}) => ({ id, opacity: 1, av: 1, volume: 0, blend: 'normal', group: 'none', effects: [], ...extra });
    window.clip = (id, color, extra = {}) => ({ id, name: id, kind: 'source', source: 'solid', color, duration: 8, opacity: 1, volume: 0, useAudio: false, speed: 1, direction: 1, scale: 1, effects: [], ...extra });
    window.frame = (layer, clip, extra = {}) => ({ layer, clip, position: 0, time: 0, weight: 1, ...extra });
    window.read = () => {
      const bytes = new Uint8Array(96 * 64 * 4);
      engine.gl.readPixels(0, 0, 96, 64, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE, bytes);
      return bytes;
    };
    window.pixel = (bytes, x = 48, y = 32) => [...bytes.slice((y * 96 + x) * 4, (y * 96 + x) * 4 + 4)];
    window.signature = bytes => {
      let hash = 2166136261;
      for (const value of bytes) hash = Math.imul(hash ^ value, 16777619);
      return hash >>> 0;
    };
    window.pattern = async (id, phase) => {
      const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
      const context = canvas.getContext('2d'); const data = context.createImageData(96, 64);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 96; x++) {
        const i = (y * 96 + x) * 4;
        data.data[i] = (x * 7 + y * 3 + phase * 67) % 256;
        data.data[i + 1] = (x * 2 + y * 9 + phase * 131) % 256;
        data.data[i + 2] = ((Math.floor(x / 8) + Math.floor(y / 8) + phase) % 2) ? 230 : 25;
        data.data[i + 3] = 255;
      }
      context.putImageData(data, 0, 0);
      const image = clip(id, '#000000', { kind: 'image', url: canvas.toDataURL(), fit: 'stretch' });
      await engine.prepare(image); return image;
    };
    window.oldClip = await pattern('old-pattern', 0);
    window.newClip = await pattern('new-pattern', 1);
    window.renderLayer = (mode, opacity, time = 1, old = oldClip, next = newClip) => {
      const bottom = layer('bottom'), top = layer('top', { blend: mode, opacity });
      project.layers = [bottom, top];
      engine.render(project, [frame(bottom, old), frame(top, next)], time);
      return read();
    };
    window.renderTransition = (mode, progress, time = 1, old = oldClip, next = newClip) => {
      const channel = layer('transition'); project.layers = [channel];
      engine.render(project, [
        frame(channel, old, { weight: 1 - progress, transitionMode: mode, transitionProgress: progress, transitionIncoming: false }),
        frame(channel, next, { weight: progress, transitionMode: mode, transitionProgress: progress, transitionIncoming: true }),
      ], time);
      return read();
    };
  });
  return page;
}

test('manual catalog is complete and 50 Mask remains explicitly unresolved', () => {
  const names = ['50 Add', '50 Lighten', 'Add', 'Alpha', 'Burn', 'Cube', 'Darken', 'Difference', 'Difference I', 'Displace', 'Dodge', 'HardLight', 'Lighten', 'LoRez', 'Luma is Alpha', 'Luma Key', 'Luma Key I', 'MetaMix', 'MultiTask', 'Multiply', 'Parts', 'RGB', 'Rotate X', 'Rotate Y', 'Screen', 'Shift RGB', 'SoftLight', 'Static', 'Subtract', 'Tile', 'TimeSwitcher', 'Wipe Down', 'Wipe Ellipse', 'Wipe Left', 'Wipe Right', 'Wipe Up', 'Zoom In', 'Zoom Out'];
  for (const name of names) assert.ok(BLEND_MODES.some(mode => mode.label === name && mode.supported), name);
  assert.equal(new Set(BLEND_IDS).size, 39);
  assert.equal(TRANSITION_IDS.length, 37);
  assert.ok(!TRANSITION_IDS.includes('50-add') && !TRANSITION_IDS.includes('50-lighten') && !TRANSITION_IDS.includes('50-mask'));
  assert.equal(BLEND_MODES.find(mode => mode.id === '50-mask').supported, false);
  assert.equal(normalizeBlend('Alpha'), 'normal');
  assert.equal(normalizeBlend('HardLight'), 'hard-light');
  assert.equal(normalizeBlend('Difference I'), 'difference-invert');
  assert.equal(normalizeBlend('50 Mask'), 'normal');
});

test('all catalog modes render distinct images and every clip transition has exact endpoints', gpuOptions, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(() => {
      const old = renderLayer('normal', 0), next = renderLayer('normal', 1);
      const identical = (actual, expected) => actual.every((value, index) => value === expected[index]);
      const signatures = {}, endpoints = [], transitionSignatures = {};
      for (const mode of blendIds) {
        signatures[mode] = [0.23, 0.5, 0.77].map(progress => signature(renderLayer(mode, progress))).join(':');
        if (!identical(renderLayer(mode, 0), old)) endpoints.push(`${mode}: layer zero`);
      }
      for (const mode of transitionIds) {
        if (!identical(renderTransition(mode, 0), old)) endpoints.push(`${mode}: old`);
        if (!identical(renderTransition(mode, 1), next)) endpoints.push(`${mode}: new`);
        transitionSignatures[mode] = [0.23, 0.5, 0.77].map(progress => signature(renderTransition(mode, progress))).join(':');
      }
      return { signatures, transitionSignatures, endpoints, errors, glError: engine.gl.getError() };
    });
    assert.deepEqual(result.endpoints, []);
    const unique = new Map();
    for (const [mode, signature] of Object.entries(result.signatures)) {
      assert.ok(!unique.has(signature), `${mode} unexpectedly matches ${unique.get(signature)} across three pattern renders`);
      unique.set(signature, mode);
    }
    const transitions = new Map();
    for (const [mode, signature] of Object.entries(result.transitionSignatures)) {
      assert.ok(!transitions.has(signature), `${mode} unexpectedly matches ${transitions.get(signature)} as a clip transition`);
      transitions.set(signature, mode);
    }
    assert.deepEqual(result.errors, []);
    assert.equal(result.glError, 0);
  } finally { await page.close(); }
});

test('manual midpoint modes and conventional blends produce known color values', gpuOptions, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(() => {
      const old = clip('old-color', '#50a0e0'), next = clip('new-color', '#b0c040');
      const sample = (mode, amount) => pixel(renderLayer(mode, amount, 1, old, next));
      return {
        midpoint: Object.fromEntries(['add', 'darken', 'difference', 'difference-invert', 'lighten', 'subtract'].map(mode => [mode, [sample(mode, 0), sample(mode, 0.5), sample(mode, 1)]])),
        full: Object.fromEntries(['50-add', '50-lighten', 'multiply', 'screen', 'burn', 'hard-light', 'overlay'].map(mode => [mode, sample(mode, 1)])),
        alpha: sample('normal', 0.5), addQuarter: sample('add', 0.25), fiftyAddQuarter: sample('50-add', 0.25),
      };
    });
    const middle = { add: [255, 255, 255, 255], darken: [80, 160, 64, 255], difference: [96, 32, 160, 255], 'difference-invert': [159, 223, 95, 255], lighten: [176, 192, 224, 255], subtract: [1, 97, 33, 255] };
    for (const [mode, expected] of Object.entries(middle)) assert.deepEqual(result.midpoint[mode], [[80, 160, 224, 255], expected, [176, 192, 64, 255]], mode);
    assert.deepEqual(result.full['50-add'], middle.add);
    assert.deepEqual(result.full['50-lighten'], middle.lighten);
    assert.deepEqual(result.full.multiply, [55, 120, 56, 255]);
    assert.deepEqual(result.full.screen, [201, 232, 232, 255]);
    assert.deepEqual(result.full.burn, [1, 129, 131, 255]);
    assert.deepEqual(result.full['hard-light'], [147, 208, 112, 255]);
    assert.deepEqual(result.full.overlay, [110, 208, 209, 255]);
    assert.deepEqual(result.alpha, [128, 176, 144, 255]);
    assert.notDeepEqual(result.addQuarter, result.fiftyAddQuarter);
  } finally { await page.close(); }
});

test('directional wipes push sampled image content in the named direction', gpuOptions, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(() => {
      const old = renderLayer('normal', 0), next = renderLayer('normal', 1), failures = [];
      const cases = [
        ['wipe-left', 8, 20, 32, 20, false], ['wipe-left', 80, 20, 8, 20, true],
        ['wipe-right', 80, 20, 56, 20, false], ['wipe-right', 8, 20, 80, 20, true],
        ['wipe-down', 32, 8, 32, 24, false], ['wipe-down', 32, 56, 32, 8, true],
        ['wipe-up', 32, 56, 32, 40, false], ['wipe-up', 32, 8, 32, 56, true],
      ];
      for (const [mode, x, y, sourceX, sourceY, incoming] of cases) {
        const actual = pixel(renderTransition(mode, 0.25), x, y);
        const expected = pixel(incoming ? next : old, sourceX, sourceY);
        if (actual.some((value, index) => Math.abs(value - expected[index]) > 1)) failures.push({ mode, actual, expected, incoming });
      }
      return failures;
    });
    assert.deepEqual(result, []);
  } finally { await page.close(); }
});

test('perspective panels, zoom, pixelation and repeated tiles change spatial content', gpuOptions, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(() => {
      const colors = bytes => new Set(Array.from({ length: bytes.length / 4 }, (_, i) => `${bytes[i * 4]},${bytes[i * 4 + 1]},${bytes[i * 4 + 2]}`)).size;
      const black = bytes => { let count = 0; for (let i = 0; i < bytes.length; i += 4) if (bytes[i] + bytes[i + 1] + bytes[i + 2] === 0) count++; return count; };
      const old = renderTransition('normal', 0);
      return {
        oldColors: colors(old), lowColors: colors(renderTransition('lorez', 0.25)),
        oldSample: pixel(old, 20, 20), zoomSample: pixel(renderTransition('zoom-in', 0.25), 20, 20),
        rotateXBlack: black(renderTransition('rotate-x', 0.5)), rotateYBlack: black(renderTransition('rotate-y', 0.5)),
        cubeBlack: black(renderTransition('cube', 0.5)), multitaskBlack: black(renderTransition('multitask', 0.5)),
        zoomOutBlack: black(renderTransition('zoom-out', 0.5)),
        tile: signature(renderTransition('tile', 0.25)), meta: signature(renderTransition('metamix', 0.25)),
        unchanged: signature(old), alpha: signature(renderTransition('normal', 0.25)),
      };
    });
    assert.ok(result.lowColors < result.oldColors / 8, JSON.stringify(result));
    assert.notDeepEqual(result.zoomSample, result.oldSample);
    assert.ok(result.rotateXBlack > 96 * 64 * 0.95);
    assert.ok(result.rotateYBlack > 96 * 64 * 0.95);
    assert.ok(result.cubeBlack > 0 && result.cubeBlack < 96 * 64 * 0.8);
    assert.ok(result.multitaskBlack > 0 && result.multitaskBlack < 96 * 64 * 0.95);
    assert.ok(result.zoomOutBlack > 96 * 64 * 0.8);
    assert.ok(new Set([result.tile, result.meta, result.unchanged, result.alpha]).size === 4);
  } finally { await page.close(); }
});

test('luminance key direction, luma transparency, channel order and timed switching are observable', gpuOptions, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
      const context = canvas.getContext('2d');
      for (let index = 0; index < 4; index++) { context.fillStyle = ['#000000', '#404040', '#c0c0c0', '#ffffff'][index]; context.fillRect(index * 24, 0, 24, 64); }
      const keyed = clip('key-strip', '#000000', { kind: 'image', url: canvas.toDataURL(), fit: 'stretch' });
      await engine.prepare(keyed);
      const red = clip('key-red', '#ff0000');
      const samples = mode => { const bytes = renderLayer(mode, mode === 'luma-alpha' ? 1 : 0.5, 1, red, keyed); return [12, 36, 60, 84].map(x => pixel(bytes, x, 32)); };
      const old = clip('channel-old', '#50a0e0'), next = clip('channel-new', '#b0c040');
      return {
        key: samples('luma-key'), inverse: samples('luma-key-invert'), alpha: samples('luma-alpha'),
        channels: pixel(renderTransition('rgb', 0.5, 1, old, next)),
        slow: pixel(renderLayer('time-switcher', 0.2, 0.1, old, next)), fast: pixel(renderLayer('time-switcher', 0.8, 0.1, old, next)),
        staticA: signature(renderTransition('static', 0.5, 0.1)), staticSame: signature(renderTransition('static', 0.5, 0.1)), staticB: signature(renderTransition('static', 0.5, 0.2)),
      };
    });
    assert.deepEqual(result.key, [[255, 0, 0, 255], [255, 0, 0, 255], [192, 192, 192, 255], [255, 255, 255, 255]]);
    assert.deepEqual(result.inverse, [[0, 0, 0, 255], [64, 64, 64, 255], [255, 0, 0, 255], [255, 0, 0, 255]]);
    assert.deepEqual(result.alpha[0], [255, 0, 0, 255]);
    assert.deepEqual(result.alpha[3], [255, 255, 255, 255]);
    assert.ok(result.alpha[1][0] > result.alpha[1][1] && result.alpha[1][1] > 0);
    assert.deepEqual(result.channels, [80, 176, 64, 255]);
    assert.deepEqual(result.slow, [80, 160, 224, 255]);
    assert.deepEqual(result.fast, [176, 192, 64, 255]);
    assert.equal(result.staticA, result.staticSame);
    assert.notEqual(result.staticA, result.staticB);
  } finally { await page.close(); }
});
