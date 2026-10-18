import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutputConfig, createScreen, createSlice, createPolygonSlice, createMask, normalizeOutputConfig, screenFromComposition, duplicateSlice, shapePoints, OUTPUT_LIMITS } from '../src/output/output-model.js';

const comp = { compositionWidth: 1280, compositionHeight: 720 };

test('default config is one virtual screen with one full-frame identity slice', () => {
  const config = createOutputConfig(comp);
  assert.equal(config.version, 1);
  assert.equal(config.screens.length, 1);
  const [screen] = config.screens;
  assert.deepEqual(screen.device, { type: 'virtual', width: 1280, height: 720 });
  assert.equal(screen.slices.length, 1);
  const [slice] = screen.slices;
  assert.deepEqual(slice.input.rect, { x: 0, y: 0, width: 1280, height: 720 });
  assert.deepEqual(slice.output.corners, [{ x: 0, y: 0 }, { x: 1280, y: 0 }, { x: 1280, y: 720 }, { x: 0, y: 720 }]);
  assert.equal(slice.output.warp.mode, 'none');
  assert.equal(slice.input.source, 'composition');
  assert.equal(slice.enabled, true);
  assert.equal(slice.opacity, 1);
  assert.equal(screen.brightness, 0);
  assert.deepEqual(screenFromComposition(1280, 720).slices[0].output.corners, slice.output.corners);
});

test('normalization is an allow-list, clamps numbers and preserves valid data', () => {
  const config = createOutputConfig(comp);
  const raw = JSON.parse(JSON.stringify(config));
  raw.evil = 1;
  raw.screens[0].__proto__ = { polluted: true };
  raw.screens[0].extra = 'nope';
  raw.screens[0].opacity = 7;
  raw.screens[0].brightness = -9;
  raw.screens[0].device = { type: 'display', displayId: 'DISPLAY-1', width: 99999, height: 'x', hack: 1 };
  raw.screens[0].slices[0].softEdge = { left: 0.2, gamma: 99, junk: 2 };
  raw.screens[0].slices[0].input.source = 'javascript:alert(1)';
  raw.screens[0].slices[0].input.rect.width = -5;
  raw.screens[0].slices[0].blendMode = 'multiply';
  const result = normalizeOutputConfig(raw, comp);
  assert.equal(result.evil, undefined);
  const [screen] = result.screens;
  assert.equal(screen.extra, undefined);
  assert.equal(screen.polluted, undefined);
  assert.equal(screen.opacity, 1);
  assert.equal(screen.brightness, -1);
  assert.deepEqual(screen.device, { type: 'display', displayId: 'DISPLAY-1', width: OUTPUT_LIMITS.dimension, height: 720 });
  const [slice] = screen.slices;
  assert.deepEqual(Object.keys(slice.softEdge).sort(), ['bottom', 'gamma', 'left', 'luminance', 'power', 'right', 'top']);
  assert.equal(slice.softEdge.left, 0.2);
  assert.equal(slice.softEdge.gamma, 4);
  assert.equal(slice.input.source, 'composition');
  assert.equal(slice.input.rect.width, 1);
  assert.equal(slice.blendMode, 'normal');
  assert.deepEqual(normalizeOutputConfig(result, comp), result, 'normalization is idempotent');
});

test('limits and structural errors throw', () => {
  assert.throws(() => normalizeOutputConfig('x'), TypeError);
  assert.throws(() => normalizeOutputConfig({ version: 2, screens: [] }), TypeError);
  assert.throws(() => normalizeOutputConfig({ version: 1, screens: Array.from({ length: 17 }, () => ({})) }), RangeError);
  assert.throws(() => normalizeOutputConfig({ version: 1, screens: [{ slices: Array.from({ length: 257 }, () => ({})) }] }), RangeError);
  assert.throws(() => normalizeOutputConfig({ version: 1, screens: [{ slices: [{ type: 'polygon', input: { points: Array.from({ length: 65 }, (_, i) => ({ x: i, y: i })) } }] }] }), RangeError);
  assert.throws(() => normalizeOutputConfig({ version: 1, screens: [{ id: 'a' }, { id: 'a' }] }), /Duplicate/);
  assert.throws(() => normalizeOutputConfig({ version: 1, screens: [{ slices: [1] }] }), TypeError);
  assert.throws(() => normalizeOutputConfig({ version: 1, screens: [{ slices: [{ output: { warp: { cols: 16, rows: 16, points: Array(257).fill({ x: 0, y: 0 }) } } }] }] }), RangeError);
  assert.equal(normalizeOutputConfig(undefined, comp).screens.length, 1);
  assert.equal(normalizeOutputConfig({ version: 1, screens: [] }, comp).screens.length, 0);
});

test('warp grids are capped at 16x16 and invalid point arrays fall back to identity', () => {
  const slice = createSlice({ output: { warp: { mode: 'linear', cols: 40, rows: 3 } } }, comp);
  assert.equal(slice.output.warp.mode, 'grid');
  assert.equal(slice.output.warp.cols, 16);
  assert.equal(slice.output.warp.points.length, 48);
  assert.deepEqual(slice.output.warp.points[15], { x: 1, y: 0 });
  const bezier = createSlice({ output: { warp: { mode: 'bezier', cols: 2, rows: 2, points: [{ x: 0, y: 0, hu: { x: 0.5, y: 0 }, junk: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 9, y: 1 }] } } }, comp);
  assert.deepEqual(bezier.output.warp.points[0], { x: 0, y: 0, hu: { x: 0.5, y: 0 } });
  assert.equal(bezier.output.warp.points[3].x, 5);
});

test('polygon slices keep matching output points and masks keep bezier handles only in bezier mode', () => {
  const poly = createPolygonSlice({ input: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }] } }, { ...comp, screenWidth: 2560, screenHeight: 1440 });
  assert.equal(poly.type, 'polygon');
  assert.deepEqual(poly.output.points, [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 100, y: 160 }]);
  assert.deepEqual(poly.input.rect, { x: 0, y: 0, width: 100, height: 80 });
  const mismatch = normalizeOutputConfig({ version: 1, screens: [{ slices: [{ ...poly, output: { points: [{ x: 1, y: 1 }] } }] }] }, comp);
  assert.equal(mismatch.screens[0].slices[0].output.points.length, 3);
  const ellipse = createMask({ shape: 'ellipse', rect: { x: 0, y: 0, width: 100, height: 50 } }, comp);
  assert.equal(ellipse.mode, 'bezier');
  assert.ok(ellipse.points[0].out);
  const linear = normalizeOutputConfig({ version: 1, screens: [{ masks: [{ ...ellipse, mode: 'linear' }] }] }, comp).screens[0].masks[0];
  assert.equal(linear.points[0].out, undefined);
  assert.throws(() => normalizeOutputConfig({ version: 1, screens: [{ masks: [{ points: [{ x: 0, y: 0 }] }] }] }), /three points/);
  assert.equal(shapePoints('triangle', { x: 0, y: 0, width: 10, height: 10 }).length, 3);
});

test('a display can drive only one screen and screens resize their default slices', () => {
  const config = normalizeOutputConfig({ version: 1, screens: [
    { device: { type: 'display', displayId: 'd1', width: 800, height: 600 } },
    { device: { type: 'display', displayId: 'd1', width: 800, height: 600 } },
    { device: { type: 'display' } },
  ] }, comp);
  assert.equal(config.screens[0].device.type, 'display');
  assert.equal(config.screens[1].device.type, 'virtual');
  assert.equal(config.screens[2].device.type, 'virtual');
  const screen = createScreen({ device: { width: 640, height: 360 } }, comp);
  assert.deepEqual(screen.slices[0].output.corners[2], { x: 640, y: 360 });
  assert.deepEqual(screen.slices[0].input.rect, { x: 0, y: 0, width: 1280, height: 720 });
});

test('duplicate creates a deep copy with a new id', () => {
  const slice = createSlice({ name: 'Left', input: { rect: { x: 0, y: 0, width: 640, height: 720 } } }, comp);
  const copy = duplicateSlice(slice, comp);
  assert.notEqual(copy.id, slice.id);
  assert.equal(copy.name, 'Left copy');
  assert.deepEqual(copy.input, slice.input);
  copy.input.rect.x = 5;
  assert.equal(slice.input.rect.x, 0);
  assert.ok(['layer:abc', 'group:g1', 'screen:s-1'].every(source => createSlice({ input: { source } }).input.source === source));
});
