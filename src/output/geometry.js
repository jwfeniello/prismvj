// Pure projection-mapping math: homographies, warp grids, slice meshes,
// polygon triangulation and snapping. No DOM or WebGL lives here.
const EPS = 1e-9;
export const UNIT_SQUARE = Object.freeze([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
export const IDENTITY3 = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

// Gaussian elimination with partial pivoting. Returns null when singular.
export function solveLinear(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = col + 1; row < n; row++) {
      const factor = a[row][col] / a[col][col];
      if (!factor) continue;
      for (let k = col; k <= n; k++) a[row][k] -= factor * a[col][k];
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = a[row][n];
    for (let k = row + 1; k < n; k++) sum -= a[row][k] * x[k];
    x[row] = sum / a[row][row];
  }
  return x;
}

// 3×3 row-major homography H with H·[src,1] ∝ [dst,1] for four point pairs.
export function homographyFromPoints(src, dst) {
  if (src?.length !== 4 || dst?.length !== 4) return null;
  const rows = [], values = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); values.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); values.push(v);
  }
  const h = solveLinear(rows, values);
  if (!h || ![...h].every(Number.isFinite)) return null;
  const H = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // Keep w positive inside the source quad so clip-space w is never negative.
  const c = src.reduce((acc, p) => ({ x: acc.x + p.x / 4, y: acc.y + p.y / 4 }), { x: 0, y: 0 });
  if (H[6] * c.x + H[7] * c.y + H[8] < 0) for (let i = 0; i < 9; i++) H[i] = -H[i];
  return H;
}

// Unit square (u,v) → output corners [TL, TR, BR, BL].
export const quadHomography = corners => homographyFromPoints(UNIT_SQUARE, corners);

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

export function multiplyMat3(A, B) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return out;
}

export function invertHomography(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g;
  const det = a * A + b * B + c * Cc;
  if (Math.abs(det) < 1e-15) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

// ---- Warp grids (unit-square space) ------------------------------------
const bern = t => { const s = 1 - t; return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]; };

// Returns (u, v) => {x, y}. Grid = bilinear cells, bezier = bicubic patches whose
// tangents come from explicit `hu`/`hv` handles or Catmull-Rom style neighbours.
export function createWarpEvaluator(warp) {
  const mode = warp?.mode;
  if (mode !== 'grid' && mode !== 'bezier') return (u, v) => ({ x: u, y: v });
  const { cols, rows, points } = warp;
  const P = (i, j) => points[j * cols + i];
  const cell = (t, count) => { const f = Math.min(Math.max(t, 0), 1) * (count - 1); const i = Math.min(count - 2, Math.floor(f)); return [i, t * (count - 1) - i]; };
  if (mode === 'grid') return (u, v) => {
    const [i, s] = cell(u, cols), [j, t] = cell(v, rows);
    const a = P(i, j), b = P(i + 1, j), c = P(i, j + 1), d = P(i + 1, j + 1);
    return { x: (1 - t) * ((1 - s) * a.x + s * b.x) + t * ((1 - s) * c.x + s * d.x), y: (1 - t) * ((1 - s) * a.y + s * b.y) + t * ((1 - s) * c.y + s * d.y) };
  };
  const tangent = (i, j, axis) => {
    const p = P(i, j), handle = axis === 'u' ? p.hu : p.hv;
    if (handle) return handle;
    const count = axis === 'u' ? cols : rows, k = axis === 'u' ? i : j;
    const at = n => axis === 'u' ? P(n, j) : P(i, n);
    const prev = at(Math.max(0, k - 1)), next = at(Math.min(count - 1, k + 1));
    const span = (Math.min(count - 1, k + 1) - Math.max(0, k - 1)) * 3;
    return { x: (next.x - prev.x) / span, y: (next.y - prev.y) / span };
  };
  const hu = points.map((_, n) => tangent(n % cols, Math.floor(n / cols), 'u'));
  const hv = points.map((_, n) => tangent(n % cols, Math.floor(n / cols), 'v'));
  const patches = new Map();
  const patch = (i, j) => {
    const key = j * cols + i;
    let net = patches.get(key);
    if (net) return net;
    const k00 = j * cols + i, k10 = k00 + 1, k01 = k00 + cols, k11 = k01 + 1;
    const p = k => points[k], add = (a, ...vs) => vs.reduce((acc, [s, vec]) => ({ x: acc.x + s * vec.x, y: acc.y + s * vec.y }), a);
    net = [
      [p(k00), add(p(k00), [1, hv[k00]]), add(p(k01), [-1, hv[k01]]), p(k01)],
      [add(p(k00), [1, hu[k00]]), add(p(k00), [1, hu[k00]], [1, hv[k00]]), add(p(k01), [1, hu[k01]], [-1, hv[k01]]), add(p(k01), [1, hu[k01]])],
      [add(p(k10), [-1, hu[k10]]), add(p(k10), [-1, hu[k10]], [1, hv[k10]]), add(p(k11), [-1, hu[k11]], [-1, hv[k11]]), add(p(k11), [-1, hu[k11]])],
      [p(k10), add(p(k10), [1, hv[k10]]), add(p(k11), [-1, hv[k11]]), p(k11)],
    ];
    patches.set(key, net);
    return net;
  };
  return (u, v) => {
    const [i, s] = cell(u, cols), [j, t] = cell(v, rows);
    const net = patch(i, j), bu = bern(s), bv = bern(t);
    let x = 0, y = 0;
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) { const w = bu[a] * bv[b]; x += w * net[a][b].x; y += w * net[a][b].y; }
    return { x, y };
  };
}
export const evaluateWarp = (warp, u, v) => createWarpEvaluator(warp)(u, v);

// ---- Input mapping -----------------------------------------------------
// Slice-local (u,v) in [0,1]² → composition pixel inside the rotated input rect.
export function inputPoint(input, u, v) {
  const fu = input.flipH ? 1 - u : u, fv = input.flipV ? 1 - v : v;
  const { x, y, width, height } = input.rect;
  const rad = (input.rotation || 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = (fu - 0.5) * width, dy = (fv - 0.5) * height;
  return { x: x + width / 2 + dx * cos - dy * sin, y: y + height / 2 + dx * sin + dy * cos };
}

export function rectToPolygon(rect, rotation = 0) {
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => inputPoint({ rect, rotation }, u, v));
}

export function polygonBounds(points) {
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ---- Polygons ----------------------------------------------------------
export function polygonArea(points) {
  let area = 0;
  for (let i = 0, n = points.length; i < n; i++) { const a = points[i], b = points[(i + 1) % n]; area += a.x * b.y - b.x * a.y; }
  return area / 2;
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
export function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

export function isSimplePolygon(points) {
  const n = points.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;
    if (segmentsIntersect(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return false;
  }
  return true;
}

const inTriangle = (p, a, b, c) => cross(a, b, p) >= -EPS && cross(b, c, p) >= -EPS && cross(c, a, p) >= -EPS;

// Ear clipping. Returns triangle indices into `points` (any winding), or null
// for self-intersecting / degenerate shapes ("not triangulatable").
export function triangulate(points) {
  const n = points.length;
  if (n < 3 || !isSimplePolygon(points) || Math.abs(polygonArea(points)) < EPS) return null;
  const ring = [...Array(n).keys()];
  if (polygonArea(points) < 0) ring.reverse();
  const out = [];
  let guard = 0;
  while (ring.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let k = 0; k < ring.length; k++) {
      const ia = ring[(k + ring.length - 1) % ring.length], ib = ring[k], ic = ring[(k + 1) % ring.length];
      const a = points[ia], b = points[ib], c = points[ic];
      if (cross(a, b, c) <= EPS) continue;
      let ear = true;
      for (const other of ring) {
        if (other === ia || other === ib || other === ic) continue;
        if (inTriangle(points[other], a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push(ia, ib, ic); ring.splice(k, 1); clipped = true; break;
    }
    if (!clipped) {
      // Remove a collinear vertex (zero-area ear) or give up.
      const k = ring.findIndex((ib, idx) => Math.abs(cross(points[ring[(idx + ring.length - 1) % ring.length]], points[ib], points[ring[(idx + 1) % ring.length]])) <= EPS);
      if (k < 0) return null;
      ring.splice(k, 1);
    }
  }
  if (ring.length === 3 && Math.abs(cross(points[ring[0]], points[ring[1]], points[ring[2]])) > EPS) out.push(ring[0], ring[1], ring[2]);
  return out.length ? out : null;
}

export function triangleArea(points, indices) {
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) area += Math.abs(cross(points[indices[i]], points[indices[i + 1]], points[indices[i + 2]])) / 2;
  return area;
}

// Linear or bezier path (points with optional in/out handle offsets) → polyline.
export function flattenPath(points, mode = 'linear', segments = 16) {
  if (mode !== 'bezier') return points.map(p => ({ x: p.x, y: p.y }));
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const c1 = { x: a.x + (a.out?.x || 0), y: a.y + (a.out?.y || 0) }, c2 = { x: b.x + (b.in?.x || 0), y: b.y + (b.in?.y || 0) };
    const straight = !a.out && !b.in;
    const steps = straight ? 1 : segments;
    for (let s = 0; s < steps; s++) {
      const t = s / steps, w = bern(t);
      out.push({ x: w[0] * a.x + w[1] * c1.x + w[2] * c2.x + w[3] * b.x, y: w[0] * a.y + w[1] * c1.y + w[2] * c2.y + w[3] * b.y });
    }
  }
  return out;
}

// ---- Snapping ----------------------------------------------------------
export function snapValue(value, targets, threshold) {
  let best = null;
  for (const target of targets) if (Math.abs(target - value) <= threshold && (best === null || Math.abs(target - value) < Math.abs(best - value))) best = target;
  return best === null ? { value, snapped: false } : { value: best, snapped: true };
}

export function snapPoint(point, { xs = [], ys = [], threshold = 8 } = {}) {
  return { x: snapValue(point.x, xs, threshold).value, y: snapValue(point.y, ys, threshold).value };
}

// Snap a moving rect by its left/centre/right and top/middle/bottom edges.
export function snapRect(rect, { xs = [], ys = [], threshold = 8 } = {}) {
  const pick = (start, size, targets) => {
    let best = null;
    for (const offset of [0, size / 2, size]) {
      const r = snapValue(start + offset, targets, threshold);
      if (r.snapped && (best === null || Math.abs(r.value - start - offset) < Math.abs(best.delta))) best = { delta: r.value - start - offset };
    }
    return best ? start + best.delta : start;
  };
  return { ...rect, x: pick(rect.x, rect.width, xs), y: pick(rect.y, rect.height, ys) };
}

export const roundTo = (value, step = 1) => Math.round(value / step) * step;

// ---- Slice meshes ------------------------------------------------------
export function sliceSignature(slice) {
  const { input, output } = slice;
  return JSON.stringify([slice.type, input.rect, input.rotation, input.flipH, input.flipV, input.points, output.corners, output.points, output.warp]);
}
export const maskSignature = mask => JSON.stringify([mask.enabled, mask.invert, mask.mode, mask.points]);

// Mesh for one slice. `positions` are pre-transform coordinates that `matrix`
// (row-major 3×3) maps to screen pixels: unit-square coordinates through the
// corner-pin homography for rect slices (drawn with homogeneous w for exact
// perspective), or screen pixels for polygon slices. `uvs` are source pixels;
// `locals` are slice-local [0,1]² coordinates for soft edges and masks.
export function buildSliceMesh(slice, { subdivisions = 8 } = {}) {
  const signature = sliceSignature(slice);
  if (slice.type === 'polygon') {
    const pts = slice.input.points, outPts = slice.output.points;
    const indices = triangulate(pts);
    const b = polygonBounds(pts), w = b.width || 1, h = b.height || 1;
    const n = pts.length;
    const positions = new Float32Array(n * 2), uvs = new Float32Array(n * 2), locals = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const lu = (pts[i].x - b.x) / w, lv = (pts[i].y - b.y) / h;
      positions[i * 2] = outPts[i].x; positions[i * 2 + 1] = outPts[i].y;
      uvs[i * 2] = slice.input.flipH ? b.x + b.width - (pts[i].x - b.x) : pts[i].x;
      uvs[i * 2 + 1] = slice.input.flipV ? b.y + b.height - (pts[i].y - b.y) : pts[i].y;
      locals[i * 2] = lu; locals[i * 2 + 1] = lv;
    }
    return { valid: !!indices, positions, uvs, locals, indices: new Uint16Array(indices || []), matrix: [...IDENTITY3], vertexCount: n, signature };
  }
  const H = quadHomography(slice.output.corners);
  const warp = slice.output.warp;
  const warped = warp && (warp.mode === 'grid' || warp.mode === 'bezier');
  const sub = Math.max(1, Math.min(32, Math.round(subdivisions)));
  const nu = warped ? (warp.cols - 1) * sub : 1, nv = warped ? (warp.rows - 1) * sub : 1;
  const evaluate = createWarpEvaluator(warp);
  const count = (nu + 1) * (nv + 1);
  const positions = new Float32Array(count * 2), uvs = new Float32Array(count * 2), locals = new Float32Array(count * 2);
  let k = 0;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++, k++) {
    const u = i / nu, v = j / nv, p = evaluate(u, v), q = inputPoint(slice.input, u, v);
    positions[k * 2] = p.x; positions[k * 2 + 1] = p.y; uvs[k * 2] = q.x; uvs[k * 2 + 1] = q.y; locals[k * 2] = u; locals[k * 2 + 1] = v;
  }
  const indices = new (count > 65535 ? Uint32Array : Uint16Array)(nu * nv * 6);
  k = 0;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    indices.set([a, b, d, a, d, c], k); k += 6;
  }
  return { valid: !!H, positions, uvs, locals, indices, matrix: H || [...IDENTITY3], vertexCount: count, signature };
}

// Screen-pixel positions of a mesh (editor overlays, tests).
export function meshScreenPositions(mesh) {
  const out = new Float32Array(mesh.positions.length);
  for (let i = 0; i < out.length; i += 2) { const p = applyHomography(mesh.matrix, mesh.positions[i], mesh.positions[i + 1]); out[i] = p.x; out[i + 1] = p.y; }
  return out;
}

// Output outline in screen pixels (follows warp grids along the border).
export function sliceOutputOutline(slice, steps = 8) {
  if (slice.type === 'polygon') return slice.output.points.map(p => ({ ...p }));
  const H = quadHomography(slice.output.corners);
  if (!H) return slice.output.corners.map(p => ({ ...p }));
  const evaluate = createWarpEvaluator(slice.output.warp);
  const warped = slice.output.warp?.mode === 'grid' || slice.output.warp?.mode === 'bezier';
  const n = warped ? Math.max(steps, (Math.max(slice.output.warp.cols, slice.output.warp.rows) - 1) * 4) : 1;
  const border = [];
  for (let i = 0; i < n; i++) border.push([i / n, 0]);
  for (let i = 0; i < n; i++) border.push([1, i / n]);
  for (let i = 0; i < n; i++) border.push([1 - i / n, 1]);
  for (let i = 0; i < n; i++) border.push([0, 1 - i / n]);
  return border.map(([u, v]) => { const p = evaluate(u, v); return applyHomography(H, p.x, p.y); });
}

export function sliceInputOutline(slice) {
  return slice.type === 'polygon' ? slice.input.points.map(p => ({ ...p })) : rectToPolygon(slice.input.rect, slice.input.rotation);
}
