// GPU checks for catalog effects/sources, groups, mask layers, effect clips
// and the video router through the real LiveEngine.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { sourceFile } from './src-server.mjs';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const options = { skip: !existsSync(chrome), timeout: 60000 };
let browser, server, baseURL;

before(async () => {
  if (!existsSync(chrome)) return;
  server = createServer((request, response) => {
    const source = sourceFile(request.url);
    if (source) { response.setHeader('Content-Type', source.type); response.end(source.body); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><canvas width="96" height="54"></canvas>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function page() {
  const tab = await browser.newPage();
  await tab.goto(baseURL);
  await tab.evaluate(async () => {
    await import('/fx/builtins.js');
    const { LiveEngine } = await import('/engine.js');
    window.errors = [];
    window.engine = new LiveEngine(document.querySelector('canvas'), { onError: error => errors.push(error) });
    window.project = () => ({ id: 'p', width: 96, height: 54, speed: 1, bpm: 120, masterOpacity: 1, masterVolume: 0, crossfader: 0.5, layers: [], groups: [], effects: [] });
    window.layer = (id, extra = {}) => ({ id, opacity: 1, volume: 0, blend: 'normal', group: 'none', effects: [], ...extra });
    window.clip = (id, color, extra = {}) => ({ id, name: id, kind: 'source', source: 'solid', color, params: {}, duration: 8, opacity: 1, volume: 0, useAudio: false, speed: 1, direction: 1, scale: 1, effects: [], ...extra });
    window.frame = (layer, clip, time = 0) => ({ layer, clip, time, position: time / clip.duration, weight: 1 });
    window.pixel = (x = 48, y = 27) => { const value = new Uint8Array(4); engine.gl.readPixels(x, y, 1, 1, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE, value); return [...value]; };
    window.near = (a, b, tolerance = 3) => a.every((value, i) => Math.abs(value - b[i]) <= tolerance);
  });
  return tab;
}

test('catalog effects render with their parameters, opacity and blend', options, async () => {
  const tab = await page();
  const result = await tab.evaluate(() => {
    const p = project(), l = layer('l'), c = clip('c', '#ffffff');
    p.layers = [l];
    c.effects = [{ id: 'inv', type: 'invert-rgb', enabled: true, opacity: 1, blend: 'normal', params: {} }];
    engine.render(p, [frame(l, c)], 1); const full = pixel();
    c.effects[0].opacity = 0.5;
    engine.render(p, [frame(l, c)], 1); const half = pixel();
    c.effects[0].enabled = false;
    engine.render(p, [frame(l, c)], 1); const bypassed = pixel();
    c.effects = [{ id: 'legacy', type: 'invert', amount: 1 }];
    engine.render(p, [frame(l, c)], 1); const legacy = pixel();
    c.effects = [{ id: 'blur', type: 'blur', enabled: true, opacity: 1, blend: 'normal', params: {} }];
    engine.render(p, [frame(l, c)], 1); const blurred = pixel();
    return { full, half, bypassed, legacy, blurred, errors };
  });
  assert.ok(near(result.full, [0, 0, 0, 255]), JSON.stringify(result.full));
  assert.ok(near(result.half, [128, 128, 128, 255], 4), JSON.stringify(result.half));
  assert.ok(near(result.bypassed, [255, 255, 255, 255]));
  assert.ok(near(result.legacy, [0, 0, 0, 255]));
  assert.ok(near(result.blurred, [255, 255, 255, 255], 2), 'blur keeps a flat colour');
  assert.deepEqual(result.errors, []);
  await tab.close();
});
function near(a, b, tolerance = 3) { return a.every((value, i) => Math.abs(value - b[i]) <= tolerance); }

test('feedback effects keep per-instance history and free it when unused', options, async () => {
  const tab = await page();
  const result = await tab.evaluate(() => {
    const p = project(), l = layer('l'), c = clip('c', '#ff0000');
    p.layers = [l];
    c.effects = [{ id: 'trails', type: 'trails', enabled: true, opacity: 1, blend: 'normal', params: {} }];
    engine.render(p, [frame(l, c)], 1);
    const allocated = engine.feedback.has('trails');
    c.effects = [];
    for (let i = 0; i < 130; i++) engine.render(p, [frame(l, c)], 1 + i / 60);
    return { allocated, freed: !engine.feedback.has('trails'), errors };
  });
  assert.ok(result.allocated); assert.ok(result.freed); assert.deepEqual(result.errors, []);
  await tab.close();
});

test('catalog and canvas sources render, and legacy solid keeps its clip colour', options, async () => {
  const tab = await page();
  const result = await tab.evaluate(async () => {
    const p = project(), l = layer('l');
    p.layers = [l];
    const solid = clip('s', '#12ab7f');
    engine.render(p, [frame(l, solid)], 1); const legacySolid = pixel();
    const gradient = clip('g', '#ffffff', { source: 'gradient', params: {} });
    engine.render(p, [frame(l, gradient)], 1); const left = pixel(4, 27), right = pixel(92, 27);
    const text = clip('t', '#ff0000', { source: 'text-animator', params: { text: '██████', size: 0.9 } });
    engine.render(p, [frame(l, text)], 1);
    let red = 0; const data = new Uint8Array(96 * 54 * 4); engine.gl.readPixels(0, 0, 96, 54, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE, data);
    for (let i = 0; i < data.length; i += 4) if (data[i] > 150 && data[i + 1] < 80) red++;
    return { legacySolid, left, right, red, canvasSources: engine.canvasSources.size, errors };
  });
  assert.ok(near(result.legacySolid, [0x12, 0xab, 0x7f, 255], 1), JSON.stringify(result.legacySolid));
  assert.notDeepEqual(result.left, result.right);
  assert.ok(result.red > 50, `text pixels ${result.red}`);
  assert.equal(result.canvasSources, 1);
  assert.deepEqual(result.errors, []);
  await tab.close();
});

test('groups render on transparent black, then mix with the group opacity and blend', options, async () => {
  const tab = await page();
  const result = await tab.evaluate(() => {
    const p = project();
    const base = layer('base'), inner = layer('inner', { groupId: 'g', blend: 'multiply' }), other = layer('other', { groupId: 'g', opacity: 0 });
    p.layers = [base, inner, other];
    p.groups = [{ id: 'g', name: 'G', opacity: 1, blend: 'normal', effects: [], bypass: false, solo: false, crossfader: 'none', scale: 1 }];
    const frames = [frame(base, clip('b', '#0000ff')), frame(inner, clip('i', '#ff0000')), frame(other, clip('o', '#00ff00'))];
    engine.render(p, frames, 1); const grouped = pixel();
    p.groups[0].opacity = 0.5;
    engine.render(p, frames, 1); const half = pixel();
    p.groups[0].bypass = true;
    engine.render(p, frames, 1); const bypassed = pixel();
    p.groups[0].bypass = false; p.groups[0].opacity = 1; p.groups[0].effects = [{ id: 'ginv', type: 'invert-rgb', enabled: true, opacity: 1, blend: 'normal', params: {} }];
    engine.render(p, frames, 1); const effected = pixel();
    return { grouped, half, bypassed, effected, errors };
  });
  // Multiply inside the group sees only transparent black, so red stays red.
  assert.ok(near(result.grouped, [255, 0, 0, 255]), JSON.stringify(result.grouped));
  assert.ok(near(result.half, [128, 0, 127, 255], 4), JSON.stringify(result.half));
  assert.ok(near(result.bypassed, [0, 0, 255, 255]));
  assert.ok(near(result.effected, [0, 255, 255, 255]), JSON.stringify(result.effected));
  assert.deepEqual(result.errors, []);
  await tab.close();
});

test('mask layers cut the layers below, effect clips adjust them, routers copy them', options, async () => {
  const tab = await page();
  const result = await tab.evaluate(() => {
    const p = project(), base = layer('base'), top = layer('top', { maskMode: 'luma' });
    p.layers = [base, top];
    engine.render(p, [frame(base, clip('b', '#ff0000')), frame(top, clip('m', '#000000'))], 1); const masked = pixel();
    engine.render(p, [frame(base, clip('b', '#ff0000')), frame(top, clip('m', '#ffffff'))], 1); const shown = pixel();
    top.maskMode = 'luma-invert';
    engine.render(p, [frame(base, clip('b', '#ff0000')), frame(top, clip('m', '#ffffff'))], 1); const inverted = pixel();
    top.maskMode = 'none';
    const effectClip = { ...clip('fx', '#000000'), kind: 'effect', effects: [{ id: 'e', type: 'invert-rgb', enabled: true, opacity: 1, blend: 'normal', params: {} }] };
    engine.render(p, [frame(base, clip('b', '#ff0000')), frame(top, effectClip)], 1); const adjusted = pixel();
    const router = clip('r', '#000000', { source: 'router', params: { input: 'below' }, effects: [{ id: 'g', type: 'invert-rgb', enabled: true, opacity: 1, blend: 'normal', params: {} }], scale: 1 });
    engine.render(p, [frame(base, clip('b', '#ff0000')), frame(top, router)], 1); const routed = pixel();
    return { masked, shown, inverted, adjusted, routed, errors };
  });
  assert.ok(near(result.masked, [0, 0, 0, 255]), JSON.stringify(result.masked));
  assert.ok(near(result.shown, [255, 0, 0, 255]));
  assert.ok(near(result.inverted, [0, 0, 0, 255]));
  assert.ok(near(result.adjusted, [0, 255, 255, 255]), JSON.stringify(result.adjusted));
  assert.ok(near(result.routed, [0, 255, 255, 255]), JSON.stringify(result.routed));
  assert.deepEqual(result.errors, []);
  await tab.close();
});

test('audio spectrum is available per source and region readback returns output pixels', options, async () => {
  const tab = await page();
  const result = await tab.evaluate(async () => {
    const p = project(), l = layer('l'); p.layers = [l];
    engine.render(p, [frame(l, clip('c', '#00ff00'))], 1);
    const region = engine.readRegion(10, 10, 4, 2);
    engine.audioContext;
    return { length: region.length, first: [...region.slice(0, 4)], spectrum: engine.spectrum('composition')?.length ?? null };
  });
  assert.equal(result.length, 32);
  assert.ok(near(result.first, [0, 255, 0, 255]));
  assert.equal(result.spectrum, 64);
  await tab.close();
});

test('generators keep animating across the clip loop point instead of jumping back', options, async () => {
  const tab = await page();
  const result = await tab.evaluate(() => {
    const p = project(), l = layer('l'); p.layers = [l];
    const grid = clip('g', '#46d9c4', { source: 'grid', duration: 5 });
    const at = (voiceId, time, rate, direction = 1) => ({ ...frame(l, grid, time), voiceId, rate, direction });
    const grab = () => { const data = new Uint8Array(96 * 54 * 4); engine.gl.readPixels(0, 0, 96, 54, engine.gl.RGBA, engine.gl.UNSIGNED_BYTE, data); return data; };
    // What a restart would look like: the pattern at transport time 0.1 s.
    engine.render(p, [at('restart', 0.1, 1)], 1);
    const restarted = grab();
    // The transport wraps from 4.9 s to 0.1 s; the generator clock continues to 5.1 s.
    engine.render(p, [at('live', 4.9, 1)], 10);
    engine.render(p, [at('live', 0.1, 1)], 10.2);
    const continued = engine.generatorClocks.get('live').time, wrapped = grab();
    engine.render(p, [at('live', 0.1, 0)], 11);
    const paused = engine.generatorClocks.get('live').time;
    engine.render(p, [at('live', 0.1, 1, -1)], 11.5);
    const reversed = engine.generatorClocks.get('live').time;
    return { continued, paused, reversed, differs: wrapped.some((value, index) => value !== restarted[index]) };
  });
  assert.ok(Math.abs(result.continued - 5.1) < 1e-6, `clock ${result.continued}`);
  assert.ok(result.differs, 'the wrapped frame must not show the restarted pattern');
  assert.ok(Math.abs(result.paused - 5.1) < 1e-6, 'a paused clip holds its generator');
  assert.ok(Math.abs(result.reversed - 4.6) < 1e-6, `reverse runs the clock backwards: ${result.reversed}`);
  await tab.close();
});