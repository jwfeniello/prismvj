import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

let browser;
let server;
let baseURL;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browserAvailable = existsSync(chrome);
const FILES = ['output-model.js', 'geometry.js', 'mapper.js', 'editor.js', 'output-editor.css'];

before(async () => {
  if (!browserAvailable) return;
  const files = new Map();
  for (const name of FILES) {
    const url = new URL(`../src/output/${name}`, import.meta.url);
    if (existsSync(url)) files.set(`/output/${name}`, await readFile(url));
  }
  server = createServer((request, response) => {
    const file = files.get(request.url);
    response.setHeader('Content-Type', request.url.endsWith('.js') ? 'text/javascript' : request.url.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(file || '<!doctype html><body style="margin:0;background:#000"><canvas id="out" width="160" height="90"></canvas></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function setup() {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error('page error:', error.message));
  await page.goto(baseURL);
  await page.evaluate(async () => {
    const model = await import('/output/output-model.js');
    const geometry = await import('/output/geometry.js');
    const { OutputMapper } = await import('/output/mapper.js');
    Object.assign(window, model, geometry);
    window.errors = [];
    const make = paint => { const c = document.createElement('canvas'); c.width = 160; c.height = 90; paint(c.getContext('2d')); return c; };
    // Gradient: red follows x, green follows y; unique colour per pixel column/row.
    window.src = make(ctx => {
      const image = ctx.createImageData(160, 90);
      for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) image.data.set([Math.round(x * 255 / 159), Math.round(y * 255 / 89), 128, 255], (y * 160 + x) * 4);
      ctx.putImageData(image, 0, 0);
    });
    window.srcData = src.getContext('2d').getImageData(0, 0, 160, 90).data;
    window.srcPixel = (x, y) => [...srcData.slice((y * 160 + x) * 4, (y * 160 + x) * 4 + 4)];
    window.white = make(ctx => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 160, 90); });
    window.mapper = new OutputMapper(document.querySelector('#out'), { onError: error => errors.push(error) });
    mapper.setSource('composition', src);
    mapper.setSource('layer:white', white);
    window.ctx = { compositionWidth: 160, compositionHeight: 90 };
    window.screenWith = (slices, extra = {}) => createScreen({ slices, ...extra }, ctx);
    window.renderAndRead = (screen, options = {}) => {
      const result = mapper.render(screen, { time: 0, ...options });
      const gl = mapper.gl, data = new Uint8Array(160 * 90 * 4);
      gl.readPixels(0, 0, 160, 90, gl.RGBA, gl.UNSIGNED_BYTE, data);
      // Flip to top-down rows.
      const out = new Uint8Array(data.length);
      for (let y = 0; y < 90; y++) out.set(data.subarray((89 - y) * 640, (90 - y) * 640), y * 640);
      window.last = out;
      return result;
    };
    window.at = (x, y) => [...last.slice((y * 160 + x) * 4, (y * 160 + x) * 4 + 4)];
  });
  return page;
}

const near = (actual, expected, tolerance, label = '') => {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= tolerance, `${label} expected ${expected} got ${actual}`);
};

test('default screen reproduces the composition pixels exactly', { skip: !browserAvailable }, async () => {
  const page = await setup();
  const result = await page.evaluate(() => {
    const config = createOutputConfig(ctx);
    const { drawn } = renderAndRead(config.screens[0]);
    let maxDiff = 0;
    for (let i = 0; i < last.length; i++) if (i % 4 !== 3) maxDiff = Math.max(maxDiff, Math.abs(last[i] - srcData[i]));
    return { drawn, maxDiff, errors };
  });
  assert.equal(result.drawn, 1);
  assert.equal(result.maxDiff, 0);
  assert.deepEqual(result.errors, []);
  await page.close();
});

test('cropping the left half maps it to the full output and flipH mirrors it', { skip: !browserAvailable }, async () => {
  const page = await setup();
  const result = await page.evaluate(() => {
    const crop = screenWith([{ input: { rect: { x: 0, y: 0, width: 80, height: 90 } }, output: { corners: rectCorners({ x: 0, y: 0, width: 160, height: 90 }) } }]);
    renderAndRead(crop);
    const cropped = [at(0, 10), at(80, 45), at(159, 80)];
    const flipped = screenWith([{ input: { flipH: true } }]);
    renderAndRead(flipped);
    const mirror = [at(10, 45), at(150, 20)];
    const flippedV = screenWith([{ input: { flipV: true } }]);
    renderAndRead(flippedV);
    return { cropped, mirror, flipV: at(30, 5), expected: [srcPixel(0, 10), srcPixel(40, 45), srcPixel(79, 80), srcPixel(149, 45), srcPixel(9, 20), srcPixel(30, 84)] };
  });
  near(result.cropped[0], result.expected[0], 2, 'left edge');
  near(result.cropped[1], result.expected[1], 2, 'centre maps to x=40');
  near(result.cropped[2], result.expected[2], 2, 'right edge maps to x=79');
  near(result.mirror[0], result.expected[3], 0, 'flipH');
  near(result.mirror[1], result.expected[4], 0, 'flipH');
  near(result.flipV, result.expected[5], 0, 'flipV');
  await page.close();
});

test('corner pin moves content with exact perspective', { skip: !browserAvailable }, async () => {
  const page = await setup();
  const result = await page.evaluate(() => {
    const right = screenWith([{ output: { corners: rectCorners({ x: 80, y: 0, width: 80, height: 90 }) } }]);
    renderAndRead(right);
    const moved = { black: at(40, 45), content: at(120, 45), expect: srcPixel(80, 45) };
    const corners = [{ x: 20, y: 10 }, { x: 150, y: 0 }, { x: 130, y: 85 }, { x: 5, y: 70 }];
    const slice = createSlice({ output: { corners } }, ctx);
    renderAndRead(screenWith([slice]));
    const inv = invertHomography(quadHomography(corners));
    const samples = [[60, 30], [100, 50], [40, 55], [120, 20]].map(([x, y]) => {
      const uv = applyHomography(inv, x + 0.5, y + 0.5);
      const sx = Math.min(159, Math.max(0, Math.floor(uv.x * 160))), sy = Math.min(89, Math.max(0, Math.floor(uv.y * 90)));
      return { got: at(x, y), expect: srcPixel(sx, sy) };
    });
    return { moved, samples, outside: at(2, 2) };
  });
  assert.deepEqual(result.moved.black.slice(0, 3), [0, 0, 0]);
  near(result.moved.content, result.moved.expect, 2, 'shifted content');
  for (const sample of result.samples) near(sample.got, sample.expect, 4, 'perspective sample');
  assert.deepEqual(result.outside.slice(0, 3), [0, 0, 0]);
  await page.close();
});

test('soft edge darkens the blend region monotonically', { skip: !browserAvailable }, async () => {
  const page = await setup();
  const row = await page.evaluate(() => {
    renderAndRead(screenWith([{ input: { source: 'layer:white' }, softEdge: { left: 0.5, power: 2, gamma: 1.8 } }]));
    return Array.from({ length: 160 }, (_, x) => at(x, 45)[0]);
  });
  assert.ok(row[0] < 20, `left edge is dark (${row[0]})`);
  assert.ok(row[100] === 255 && row[159] === 255, 'outside the blend region stays full');
  for (let x = 1; x < 80; x++) assert.ok(row[x] >= row[x - 1], `monotonic at ${x}: ${row[x - 1]} -> ${row[x]}`);
  assert.ok(row[40] > 30 && row[40] < 230, `mid ramp (${row[40]})`);
  await page.close();
});

test('slice input masks and screen output masks hide pixels', { skip: !browserAvailable }, async () => {
  const page = await setup();
  const result = await page.evaluate(() => {
    const triangle = [{ x: 80, y: 5 }, { x: 150, y: 85 }, { x: 10, y: 85 }];
    renderAndRead(screenWith([{ mask: { enabled: true, points: triangle } }]));
    const masked = { inside: at(80, 60), outside: at(5, 5), outsideRight: at(155, 10), expect: srcPixel(80, 60) };
    renderAndRead(screenWith([{ mask: { enabled: true, invert: true, points: triangle } }]));
    const inverted = { inside: at(80, 60), outside: at(5, 5), expect: srcPixel(5, 5) };
    renderAndRead(screenWith([{}], { masks: [createMask({ rect: { x: 0, y: 0, width: 80, height: 90 } }, ctx)] }));
    const screenMask = { kept: at(40, 45), cut: at(120, 45), expect: srcPixel(40, 45) };
    renderAndRead(screenWith([{}], { masks: [createMask({ rect: { x: 0, y: 0, width: 80, height: 90 }, invert: true }, ctx)] }));
    const hole = { cut: at(40, 45), kept: at(120, 45), expect: srcPixel(120, 45) };
    const poly = createPolygonSlice({ input: { points: triangle } }, ctx);
    renderAndRead(screenWith([poly]));
    const polygon = { inside: at(80, 60), outside: at(5, 5), expect: srcPixel(80, 60) };
    return { masked, inverted, screenMask, hole, polygon };
  });
  near(result.masked.inside, result.masked.expect, 1, 'mask inside');
  assert.deepEqual(result.masked.outside.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(result.masked.outsideRight.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(result.inverted.inside.slice(0, 3), [0, 0, 0]);
  near(result.inverted.outside, result.inverted.expect, 1, 'inverted outside');
  near(result.screenMask.kept, result.screenMask.expect, 1, 'screen mask keeps inside');
  assert.deepEqual(result.screenMask.cut.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(result.hole.cut.slice(0, 3), [0, 0, 0]);
  near(result.hole.kept, result.hole.expect, 1, 'hole keeps outside');
  near(result.polygon.inside, result.polygon.expect, 1, 'polygon inside');
  assert.deepEqual(result.polygon.outside.slice(0, 3), [0, 0, 0]);
  await page.close();
});

test('disabled, bypassed and non-solo slices are not drawn; colour correction applies', { skip: !browserAvailable }, async () => {
  const page = await setup();
  const result = await page.evaluate(() => {
    const blank = screen => { const r = renderAndRead(screen); return { drawn: r.drawn, max: Math.max(...last.filter((_, i) => i % 4 !== 3)) }; };
    const disabled = blank(screenWith([{ enabled: false }]));
    const bypassed = blank(screenWith([{ bypass: true }]));
    const screenOff = blank(screenWith([{}], { enabled: false }));
    renderAndRead(screenWith([{ input: { source: 'layer:white' }, output: { corners: rectCorners({ x: 0, y: 0, width: 80, height: 90 }) } },
      { solo: true, input: { source: 'layer:white' }, output: { corners: rectCorners({ x: 80, y: 0, width: 80, height: 90 }) } }]));
    const solo = { left: at(40, 45), right: at(120, 45) };
    renderAndRead(screenWith([{ input: { source: 'layer:white' }, red: -1, brightness: 0 }], { opacity: 0.5 }));
    const colour = at(40, 45);
    renderAndRead(screenWith([{ input: { source: 'layer:missing' } }]));
    const missing = at(40, 45);
    return { disabled, bypassed, screenOff, solo, colour, missing, errors };
  });
  assert.deepEqual(result.disabled, { drawn: 0, max: 0 });
  assert.deepEqual(result.bypassed, { drawn: 0, max: 0 });
  assert.deepEqual(result.screenOff, { drawn: 0, max: 0 });
  assert.deepEqual(result.solo.left.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(result.solo.right.slice(0, 3), [255, 255, 255]);
  near(result.colour, [0, 128, 128], 2, 'red removed, half opacity');
  assert.deepEqual(result.missing.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(result.errors, []);
  await page.close();
});

test('identity warp grids match the plain slice and moved warp points bend the output', { skip: !browserAvailable }, async () => {
  const page = await setup();
  const result = await page.evaluate(() => {
    const diff = () => { let m = 0; for (let i = 0; i < last.length; i++) if (i % 4 !== 3) m = Math.max(m, Math.abs(last[i] - srcData[i])); return m; };
    renderAndRead(screenWith([{ output: { warp: { mode: 'grid', cols: 4, rows: 3 } } }]));
    const grid = diff();
    renderAndRead(screenWith([{ output: { warp: { mode: 'bezier', cols: 3, rows: 3 } } }]));
    const bezier = diff();
    const points = identityWarpPoints(3, 3); points[4] = { x: 0.7, y: 0.5 };
    renderAndRead(screenWith([{ output: { warp: { mode: 'bezier', cols: 3, rows: 3, points } } }]));
    return { grid, bezier, moved: diff() };
  });
  assert.ok(result.grid <= 2, `grid identity diff ${result.grid}`);
  assert.ok(result.bezier <= 2, `bezier identity diff ${result.bezier}`);
  assert.ok(result.moved > 20, 'moved warp point changes the image');
  await page.close();
});

test('test card, identify and info overlays render', { skip: !browserAvailable }, async () => {
  const page = await setup();
  const result = await page.evaluate(() => {
    const screen = createOutputConfig(ctx).screens[0];
    renderAndRead(screen, { testCard: true });
    const bar = at(53, 35), firstBar = at(38, 35);
    renderAndRead(screen, { identify: true, label: '1', identifyColor: '#ff0000' });
    const identify = at(2, 88);
    renderAndRead(screen, { showFPS: true, showInfo: true });
    return { bar, firstBar, identify, plain: srcPixel(2, 88), errors };
  });
  near(result.bar, [192, 192, 0], 12, 'yellow colour bar');
  near(result.firstBar, [192, 192, 192], 12, 'grey colour bar');
  assert.ok(result.identify[0] > result.plain[0] + 60, 'identify tints the screen');
  assert.deepEqual(result.errors, []);
  await page.close();
});

test('context loss is survived and rendering recovers after restore', { skip: !browserAvailable }, async () => {
  const page = await setup();
  const result = await page.evaluate(async () => {
    const screen = createOutputConfig(ctx).screens[0];
    renderAndRead(screen);
    const ext = mapper.gl.getExtension('WEBGL_lose_context');
    const restored = new Promise(resolve => mapper.canvas.addEventListener('webglcontextrestored', resolve, { once: true }));
    ext.loseContext();
    await new Promise(resolve => setTimeout(resolve, 20));
    const whileLost = mapper.render(screen, { testCard: true, showFPS: true });
    ext.restoreContext();
    await restored;
    renderAndRead(screen);
    const after = at(100, 30);
    mapper.dispose();
    mapper.dispose();
    return { whileLost, after, expect: srcPixel(100, 30), errors };
  });
  assert.deepEqual(result.whileLost, { drawn: 0 });
  assert.deepEqual(result.after, result.expect);
  assert.equal(result.errors.length, 1, 'one context-loss notice');
  await page.close();
});

test('advanced output editor: add slice, drag handles, numeric math, undo, presets and close', { skip: !browserAvailable }, async () => {
  const page = await setup();
  await page.setViewportSize({ width: 1280, height: 800 });
  const result = await page.evaluate(async () => {
    const { openAdvancedOutput } = await import('/output/editor.js');
    const pageErrors = [];
    window.addEventListener('error', event => pageErrors.push(event.message));
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:5';
    document.body.append(host);
    const changes = [];
    let closedByUser = 0, options = null;
    const api = openAdvancedOutput({ host, config: createOutputConfig(ctx), compositionCanvas: src, compositionSize: { width: 160, height: 90 },
      displays: [{ id: 'd1', label: 'Projector', width: 1920, height: 1080 }], layers: [{ id: 'l1', name: 'Layer 1' }], groups: [{ id: 'g1', name: 'Group A' }],
      onChange: config => changes.push(config), onClose: () => closedByUser++, onOutputOptions: value => { options = value; } });
    const root = host.querySelector('#ao-root');
    for (let i = 0; i < 100 && getComputedStyle(root).display !== 'grid'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const overlay = host.querySelector('#ao-stage-overlay');
    const pointer = (type, x, y, extra = {}) => {
      const p = api.contentToClient(x, y);
      overlay.dispatchEvent(new PointerEvent(type, { clientX: p.x, clientY: p.y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, bubbles: true, ...extra }));
    };
    const dragContent = (from, to) => { pointer('pointerdown', ...from); pointer('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2); pointer('pointermove', ...to); pointer('pointerup', ...to); };
    const last = () => changes[changes.length - 1];
    const sliceOf = config => config.screens[0].slices.find(s => s.id === api.selection[0]);

    host.querySelector('[data-action="add-slice"]').click();
    const added = { count: last().screens[0].slices.length, selected: api.selection.length, isFirst: last().screens[0].slices[0].id === api.selection[0] };

    dragContent([80, 45], [100, 45]);
    const moved = { ...sliceOf(last()).input.rect };

    dragContent([180, 90], [150, 80]);
    const scaled = { ...sliceOf(last()).input.rect };

    const width = host.querySelector('[data-path="input.rect.width"]');
    width.value = '/2'; width.dispatchEvent(new Event('change', { bubbles: true }));
    const halved = sliceOf(last()).input.rect.width;

    api.setTab('output');
    host.querySelector('[data-mode="points"]').click();
    dragContent([0, 0], [10, 5]);
    const corner = { ...sliceOf(last()).output.corners[0] };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    const undone = { ...sliceOf(last()).output.corners[0] };
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
    const redone = { ...sliceOf(last()).output.corners[0] };
    host.querySelector('[data-mode="transform"]').click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    const nudged = { ...sliceOf(last()).output.corners[0] };

    host.querySelector('[data-option="testCard"]').click();
    host.querySelector('#ao-preset-name').value = 'Venue';
    host.querySelector('[data-action="save-preset"]').click();
    const presets = JSON.parse(localStorage.getItem('prism-output-presets') || '{}');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    api.close();
    const cleaned = { children: host.children.length, stylesheet: !!document.getElementById('ao-stylesheet'), closedByUser };
    const api2 = openAdvancedOutput({ host, config: last(), compositionCanvas: src, compositionSize: { width: 160, height: 90 }, onClose: () => closedByUser++ });
    const reopenedSlices = api2.getConfig().screens[0].slices.length;
    host.querySelector('[data-action="close"]').click();
    return { added, moved, scaled, halved, corner, undone, redone, nudged, options, presetSaved: !!presets.Venue && presets.Venue.screens[0].slices.length === 2,
      cleaned, reopenedSlices, closedAfterButton: closedByUser, hostEmpty: host.children.length === 0, pageErrors, mapperErrors: errors };
  });
  assert.deepEqual(result.added, { count: 2, selected: 1, isFirst: true });
  assert.ok(Math.abs(result.moved.x - 20) < 0.6 && Math.abs(result.moved.y) < 0.6, `moved rect ${JSON.stringify(result.moved)}`);
  assert.ok(Math.abs(result.scaled.x - 20) < 0.6 && Math.abs(result.scaled.width - 130) < 0.6 && Math.abs(result.scaled.height - 80) < 0.6, `scaled rect ${JSON.stringify(result.scaled)}`);
  assert.ok(Math.abs(result.halved - result.scaled.width / 2) < 0.01, 'numeric "/2" halves the width');
  assert.ok(Math.abs(result.corner.x - 10) < 0.6 && Math.abs(result.corner.y - 5) < 0.6, `dragged corner ${JSON.stringify(result.corner)}`);
  assert.deepEqual(result.undone, { x: 0, y: 0 });
  assert.deepEqual(result.redone, result.corner);
  assert.ok(Math.abs(result.nudged.x - result.corner.x - 10) < 1e-6, 'shift+arrow nudges 10px');
  assert.equal(result.options.testCard, true);
  assert.equal(result.presetSaved, true);
  assert.deepEqual(result.cleaned, { children: 0, stylesheet: false, closedByUser: 0 });
  assert.equal(result.reopenedSlices, 2);
  assert.equal(result.closedAfterButton, 1);
  assert.equal(result.hostEmpty, true);
  assert.deepEqual(result.pageErrors, []);
  await page.close();
});
