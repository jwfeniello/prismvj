import test from 'node:test';
import assert from 'node:assert/strict';
import { homographyFromPoints, quadHomography, applyHomography, invertHomography, multiplyMat3, evaluateWarp, createWarpEvaluator, triangulate, triangleArea, polygonArea, pointInPolygon, isSimplePolygon,
  buildSliceMesh, meshScreenPositions, sliceSignature, rectToPolygon, inputPoint, snapValue, snapRect, flattenPath, sliceOutputOutline, solveLinear } from '../src/output/geometry.js';
import { createSlice, createPolygonSlice, identityWarpPoints, shapePoints } from '../src/output/output-model.js';

const near = (a, b, eps = 1e-6, message = '') => assert.ok(Math.abs(a - b) < eps, `${message} expected ${b}, got ${a}`);
const corners = [{ x: 10, y: 20 }, { x: 300, y: 5 }, { x: 280, y: 260 }, { x: 30, y: 200 }];

test('linear solver solves and reports singular systems', () => {
  assert.deepEqual([...solveLinear([[2, 1], [1, 3]], [3, 5])].map(v => Math.round(v * 1e9) / 1e9), [0.8, 1.4]);
  assert.equal(solveLinear([[1, 2], [2, 4]], [1, 2]), null);
});

test('homography maps the four corners exactly and is invertible', () => {
  const H = quadHomography(corners);
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const p = applyHomography(H, u, v);
    near(p.x, corners[i].x, 1e-6); near(p.y, corners[i].y, 1e-6);
  });
  const inv = invertHomography(H);
  for (const [u, v] of [[0.25, 0.75], [0.5, 0.5], [0.9, 0.1]]) {
    const p = applyHomography(H, u, v), back = applyHomography(inv, p.x, p.y);
    near(back.x, u); near(back.y, v);
  }
  const I = multiplyMat3(H, inv).map(v => v / multiplyMat3(H, inv)[8]);
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => near(I[i], v, 1e-9));
  const src = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }];
  const G = homographyFromPoints(src, corners);
  near(applyHomography(G, 4, 2).x, 280, 1e-6);
  assert.equal(quadHomography([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]), null);
  // w stays positive inside the quad.
  assert.ok(H[6] * 0.5 + H[7] * 0.5 + H[8] > 0);
});

test('identity warp grids (linear and bezier) are the identity, moved points warp', () => {
  for (const mode of ['grid', 'bezier']) for (const [cols, rows] of [[2, 2], [4, 3], [16, 16]]) {
    const warp = { mode, cols, rows, points: identityWarpPoints(cols, rows) };
    const evaluate = createWarpEvaluator(warp);
    for (const [u, v] of [[0, 0], [1, 1], [0.13, 0.77], [0.5, 0.5], [0.99, 0.01]]) {
      const p = evaluate(u, v);
      near(p.x, u, 1e-9, `${mode} ${cols}x${rows} x`); near(p.y, v, 1e-9, `${mode} ${cols}x${rows} y`);
    }
  }
  const points = identityWarpPoints(3, 3);
  points[4] = { x: 0.6, y: 0.5 };
  near(evaluateWarp({ mode: 'grid', cols: 3, rows: 3, points }, 0.5, 0.5).x, 0.6);
  near(evaluateWarp({ mode: 'grid', cols: 3, rows: 3, points }, 0.25, 0.5).x, 0.3);
  const curved = evaluateWarp({ mode: 'bezier', cols: 3, rows: 3, points }, 0.25, 0.5).x;
  assert.ok(curved > 0.25 && curved < 0.36, `bezier bends smoothly (${curved})`);
  near(evaluateWarp({ mode: 'none' }, 0.3, 0.4).y, 0.4);
});

test('ear clipping covers concave polygons exactly and rejects self-intersections', () => {
  const concave = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 4 }, { x: 0, y: 10 }];
  for (const shape of [concave, [...concave].reverse()]) {
    const indices = triangulate(shape);
    assert.equal(indices.length, (shape.length - 2) * 3);
    near(triangleArea(shape, indices), Math.abs(polygonArea(shape)));
  }
  const star = Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 4 : 10, a = i * Math.PI / 5; return { x: r * Math.cos(a), y: r * Math.sin(a) }; });
  near(triangleArea(star, triangulate(star)), Math.abs(polygonArea(star)), 1e-6);
  const withCollinear = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  near(triangleArea(withCollinear, triangulate(withCollinear)), 100);
  const bowtie = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
  assert.equal(isSimplePolygon(bowtie), false);
  assert.equal(triangulate(bowtie), null);
  assert.equal(triangulate([{ x: 0, y: 0 }, { x: 1, y: 1 }]), null);
});

test('point in polygon handles concave shapes', () => {
  const concave = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 4 }, { x: 0, y: 10 }];
  assert.equal(pointInPolygon({ x: 2, y: 2 }, concave), true);
  assert.equal(pointInPolygon({ x: 5, y: 8 }, concave), false);
  assert.equal(pointInPolygon({ x: -1, y: 5 }, concave), false);
});

test('rect slice mesh maps unit space through the corner pin and samples the input rect', () => {
  const slice = createSlice({ input: { rect: { x: 100, y: 50, width: 200, height: 100 } }, output: { corners } }, { compositionWidth: 400, compositionHeight: 300 });
  const mesh = buildSliceMesh(slice);
  assert.equal(mesh.valid, true);
  assert.equal(mesh.vertexCount, 4);
  assert.deepEqual([...mesh.uvs], [100, 50, 300, 50, 100, 150, 300, 150]);
  const screen = meshScreenPositions(mesh);
  near(screen[2], 300, 1e-3); near(screen[3], 5, 1e-3);
  near(screen[6], 280, 1e-3); near(screen[7], 260, 1e-3);
  const flipped = buildSliceMesh({ ...slice, input: { ...slice.input, flipH: true } });
  assert.deepEqual([...flipped.uvs.slice(0, 2)], [300, 50]);
  const warped = buildSliceMesh({ ...slice, output: { ...slice.output, warp: { mode: 'bezier', cols: 3, rows: 2, points: identityWarpPoints(3, 2) } } }, { subdivisions: 4 });
  assert.equal(warped.vertexCount, 9 * 5);
  assert.equal(warped.indices.length, 8 * 4 * 6);
  const rotated = inputPoint({ rect: { x: 0, y: 0, width: 100, height: 100 }, rotation: 90 }, 0, 0);
  near(rotated.x, 100); near(rotated.y, 0);
  assert.equal(rectToPolygon({ x: 0, y: 0, width: 10, height: 10 }).length, 4);
  assert.equal(sliceOutputOutline(slice).length, 4);
});

test('polygon slice mesh triangulates input points and maps to output points', () => {
  const poly = createPolygonSlice({ input: { points: shapePoints('rect', { x: 0, y: 0, width: 100, height: 100 }) } }, { compositionWidth: 100, compositionHeight: 100 });
  const mesh = buildSliceMesh(poly);
  assert.equal(mesh.valid, true);
  assert.equal(mesh.indices.length, 6);
  assert.deepEqual([...mesh.locals.slice(4, 6)], [1, 1]);
  const bad = buildSliceMesh({ ...poly, input: { ...poly.input, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }] }, output: { ...poly.output, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }] } });
  assert.equal(bad.valid, false);
});

test('slice signatures change only with geometry', () => {
  const slice = createSlice({}, { compositionWidth: 100, compositionHeight: 100 });
  const sig = sliceSignature(slice);
  assert.equal(sliceSignature({ ...slice, name: 'Renamed', brightness: 0.5 }), sig);
  assert.notEqual(sliceSignature({ ...slice, input: { ...slice.input, rotation: 5 } }), sig);
  assert.notEqual(sliceSignature({ ...slice, output: { ...slice.output, corners: corners } }), sig);
  assert.equal(buildSliceMesh(slice).signature, sig);
});

test('snapping and bezier path flattening', () => {
  assert.deepEqual(snapValue(98, [0, 100], 5), { value: 100, snapped: true });
  assert.deepEqual(snapValue(50, [0, 100], 5), { value: 50, snapped: false });
  assert.equal(snapRect({ x: 3, y: 47, width: 50, height: 50 }, { xs: [0], ys: [100], threshold: 5 }).x, 0);
  assert.equal(snapRect({ x: 3, y: 47, width: 50, height: 50 }, { xs: [0], ys: [100], threshold: 5 }).y, 50);
  const circle = flattenPath(shapePoints('ellipse', { x: -1, y: -1, width: 2, height: 2 }), 'bezier', 16);
  assert.equal(circle.length, 64);
  for (const p of circle) near(Math.hypot(p.x, p.y), 1, 0.01);
  assert.equal(flattenPath(shapePoints('rect'), 'linear').length, 4);
});
