// Generated-source catalog. Each entry follows the source contract in
// shader-template.js: `glsl` defines `vec4 gen(vec2 uv)` returning straight
// alpha. Entries marked `legacy` keep the ids and default look of the engine's
// original built-in generators so older projects render unchanged.

export const SOURCE_CATEGORIES = Object.freeze(['Basic', 'Pattern', 'Geometric', 'Organic', 'Fractal', 'Motion', 'Audio', 'Utility']);

const num = (key, label, def, min = 0, max = 1, step) => ({ key, label, type: 'float', min, max, default: def, ...(step ? { step } : {}) });
const int = (key, label, def, min, max) => ({ key, label, type: 'int', min, max, default: def, step: 1 });
const flag = (key, label, def = false) => ({ key, label, type: 'bool', default: def });
const color = (key, label, def) => ({ key, label, type: 'color', default: def });
const pick = (key, label, options, def = 0) => ({ key, label, type: 'choice', options, default: def });
const point = (key, label, def = [0.5, 0.5]) => ({ key, label, type: 'point', min: 0, max: 1, default: def });

const background = (def = '#00000000') => color('background', 'Background', def);
const speed = (def, min = -4, max = 4) => num('speed', 'Speed', def, min, max);

// Helpers shared by every generator body.
const HEAD = `
const mat2 FBM_ROT = mat2(0.8, 0.6, -0.6, 0.8);
vec2 centered(vec2 q) { return (q - 0.5) * vec2(uAspect, 1.0); }
float pxSize() { return 1.0 / max(uResolution.y, 1.0); }
float edge(float d, float soft) { float w = max(soft, pxSize()); return 1.0 - smoothstep(-w, w, d); }
vec4 over(vec4 top, vec4 base) {
  float a = top.a + base.a * (1.0 - top.a);
  return a > 0.00001 ? vec4((top.rgb * top.a + base.rgb * base.a * (1.0 - top.a)) / a, a) : vec4(0.0);
}
vec4 paint(vec4 base, vec4 tint, float mask) { return over(vec4(tint.rgb, tint.a * clamp(mask, 0.0, 1.0)), base); }
float fbm(vec2 p, int octaves) {
  float v = 0.0, a = 0.5, total = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    v += a * noise2(p);
    total += a;
    p = FBM_ROT * p * 2.02 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v / max(total, 0.0001);
}
vec3 cosPalette(float t) { return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67))); }
`;

const SHAPE = `
vec4 shapeLayer(float d) {
  vec4 col = p_background;
  if (p_style != 1) col = paint(col, p_fill, edge(d, p_softness));
  if (p_style != 0) col = paint(col, p_stroke, edge(abs(d) - p_strokeWidth * 0.5, p_softness));
  return col;
}
`;

const shapeParams = [
  num('rotation', 'Rotation', 0, 0, 360),
  num('spin', 'Spin', 0.05, -2, 2),
  point('position', 'Position'),
  pick('style', 'Style', ['Fill', 'Stroke', 'Fill + Stroke']),
  color('fill', 'Fill Color', '#ff6a38'),
  color('stroke', 'Stroke Color', '#ffffff'),
  num('strokeWidth', 'Stroke Width', 0.02, 0.001, 0.2),
  num('softness', 'Softness', 0, 0, 0.2),
  background(),
];

const BAR_COLORS = 'vec3[8](vec3(1.0), vec3(1.0, 1.0, 0.0), vec3(0.0, 1.0, 1.0), vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), vec3(0.0))';

const freezeParam = param => Object.freeze({
  ...param,
  ...(param.options ? { options: Object.freeze([...param.options]) } : {}),
  ...(Array.isArray(param.default) ? { default: Object.freeze([...param.default]) } : {}),
});

const source = (id, name, category, params, glsl, extra = {}) => Object.freeze({
  id, name, category, ...extra, params: Object.freeze(params.map(freezeParam)), glsl: HEAD + glsl,
});

const LEGACY = { legacy: true };
const legacyColor = color('color', 'Color', '#ff6a38');

export const SOURCES = Object.freeze([
  // Basic
  source('solid', 'Solid Color', 'Basic', [legacyColor], `
vec4 gen(vec2 uv) { return p_color; }
`, LEGACY),

  source('gradient', 'Gradient', 'Basic', [
    pick('style', 'Style', ['Linear', 'Radial', 'Angular', 'Diamond']),
    color('colorA', 'Color A', '#ff6a38'),
    color('colorB', 'Color B', '#2b1d8f'),
    num('angle', 'Angle', 0, 0, 360),
    point('center', 'Center'),
    num('scale', 'Scale', 1, 0.1, 4),
    pick('repeat', 'Repeat', ['Clamp', 'Repeat', 'Mirror']),
    speed(0, -2, 2),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = (uv - p_center) * vec2(uAspect, 1.0);
  float a = radians(p_angle);
  vec2 dir = vec2(cos(a), sin(a));
  float t;
  if (p_style == 0) t = dot(p, dir) / ((abs(dir.x) * uAspect + abs(dir.y)) * p_scale) + 0.5;
  else if (p_style == 1) t = length(p) * 2.0 / p_scale;
  else if (p_style == 2) t = fract(atan(p.y, p.x) / TAU - p_angle / 360.0 + 1.0);
  else { vec2 q = abs(rotate2(p, -a)); t = (q.x + q.y) * 2.0 / p_scale; }
  t += uTime * p_speed;
  if (p_repeat == 1) t = fract(t);
  else if (p_repeat == 2) t = 1.0 - abs(mod(t, 2.0) - 1.0);
  return mix(p_colorA, p_colorB, clamp(t, 0.0, 1.0));
}
`),

  source('strobe', 'Strobe', 'Basic', [
    color('color', 'Color', '#ffffff'),
    background('#000000'),
    pick('sync', 'Sync', ['Beats', 'Seconds']),
    num('rate', 'Rate', 2, 0.25, 16),
    num('duty', 'Duty Cycle', 0.5, 0.01, 1),
    num('fade', 'Fade', 0, 0, 1),
  ], `
vec4 gen(vec2 uv) {
  float phase = fract((p_sync == 0 ? uBeat : uTime) * p_rate);
  float on = 1.0 - smoothstep(p_duty * (1.0 - p_fade) - 0.0001, p_duty, phase);
  return mix(p_background, p_color, on);
}
`),
  // Pattern
  source('grid', 'Grid', 'Pattern', [
    legacyColor,
    int('cells', 'Cells', 12, 1, 64),
    num('width', 'Line Width', 0.05, 0.005, 0.5),
    num('dim', 'Background Level', 0.07, 0, 1),
    flag('transparent', 'Transparent Background'),
    speed(1),
  ], `
vec4 gen(vec2 uv) {
  vec2 v = centered(uv);
  float t = uTime * p_speed;
  vec2 g = abs(fract((v + vec2(t * 0.04, t * 0.02)) * float(p_cells)) - 0.5);
  float line = 1.0 - smoothstep(p_width - 0.015, p_width + 0.015, min(g.x, g.y));
  if (p_transparent) return vec4(p_color.rgb, line);
  return vec4(p_color.rgb * (p_dim + line * (1.0 - p_dim)), 1.0);
}
`, LEGACY),

  source('checkered', 'Checkered', 'Pattern', [
    color('colorA', 'Color A', '#ffffff'),
    color('colorB', 'Color B', '#000000'),
    int('size', 'Cells', 8, 1, 64),
    num('rotation', 'Rotation', 0, 0, 360),
    num('softness', 'Softness', 0, 0, 1),
    speed(0, -2, 2),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = rotate2(centered(uv), radians(p_rotation)) * float(p_size) + vec2(uTime * p_speed, 0.0);
  float k = sin(p.x * PI) * sin(p.y * PI);
  float w = fwidth(k) + p_softness + 0.0001;
  return mix(p_colorB, p_colorA, smoothstep(-w, w, k));
}
`),

  source('lines', 'Lines', 'Pattern', [
    color('color', 'Color', '#ffffff'),
    background(),
    int('count', 'Count', 10, 1, 100),
    num('width', 'Width', 0.25, 0.01, 1),
    num('angle', 'Angle', 0, 0, 360),
    num('softness', 'Softness', 0, 0, 1),
    speed(0.25),
  ], `
vec4 gen(vec2 uv) {
  float n = float(p_count);
  vec2 p = rotate2(centered(uv), radians(p_angle));
  float x = p.y * n + uTime * p_speed;
  float d = (abs(fract(x) - 0.5) - p_width * 0.5) / n;
  return paint(p_background, p_color, edge(d, p_softness * 0.5 / n));
}
`),

  source('stripes', 'Stripes', 'Pattern', [
    pick('colors', 'Colors', ['2 Colors', '3 Colors'], 1),
    color('colorA', 'Color A', '#ff6a38'),
    color('colorB', 'Color B', '#141414'),
    color('colorC', 'Color C', '#2a9dff'),
    int('count', 'Count', 6, 1, 64),
    num('angle', 'Angle', 45, 0, 360),
    num('blend', 'Blend', 0, 0, 1),
    speed(0.25),
  ], `
vec4 stripeColor(float k) {
  k = mod(k, p_colors == 0 ? 2.0 : 3.0);
  return k < 0.5 ? p_colorA : k < 1.5 ? p_colorB : p_colorC;
}
vec4 gen(vec2 uv) {
  vec2 p = rotate2(centered(uv), radians(p_angle));
  float x = p.x * float(p_count) + uTime * p_speed;
  float w = max(max(fwidth(x), p_blend), 0.0001);
  float b = smoothstep(1.0 - w, 1.0, fract(x));
  return mix(stripeColor(floor(x)), stripeColor(floor(x) + 1.0), b);
}
`),

  source('line-scape', 'Line Scape', 'Pattern', [
    color('color', 'Color', '#ffffff'),
    background('#000000'),
    int('lines', 'Lines', 32, 4, 64),
    num('amplitude', 'Amplitude', 0.25, 0, 0.5),
    num('frequency', 'Frequency', 4, 0.5, 16),
    num('width', 'Line Width', 0.12, 0.01, 1),
    num('focus', 'Focus', 0.6, 0, 1),
    speed(0.5),
  ], `
float scapeHeight(float x, float j) {
  float env = mix(1.0, exp(-pow((x - 0.5) * 5.0, 2.0)), p_focus);
  float fx = (x - 0.5) * uAspect * p_frequency;
  float n = 0.7 * noise2(vec2(fx, j * 0.73 - uTime * p_speed)) + 0.3 * noise2(vec2(fx * 2.7, j * 1.31 + uTime * p_speed));
  return p_amplitude * env * n * n;
}
vec4 gen(vec2 uv) {
  float n = float(p_lines), spacing = 1.0 / n;
  float w = spacing * p_width * 0.5, px = pxSize();
  float first = max(0.0, ceil((uv.y - p_amplitude - w) * n - 0.5));
  for (int k = 0; k < 40; k++) {
    float j = first + float(k);
    float base = (j + 0.5) * spacing;
    if (j >= n || base > uv.y + w + px) break;
    float h = base + scapeHeight(uv.x, j);
    float d = abs(uv.y - h) - w;
    if (d < px) return paint(p_background, p_color, edge(d, 0.0));
    if (uv.y < h) break;
  }
  return p_background;
}
`),

  source('dot-grid', 'Dots', 'Pattern', [
    color('color', 'Color', '#ffffff'),
    background(),
    int('count', 'Count', 16, 2, 64),
    num('size', 'Dot Size', 0.6, 0, 1),
    num('pulse', 'Pulse', 0.5, 0, 1),
    pick('wave', 'Wave', ['Radial', 'Horizontal', 'Random']),
    flag('stagger', 'Stagger Rows'),
    speed(0.5),
  ], `
vec4 gen(vec2 uv) {
  float n = float(p_count);
  vec2 p = centered(uv) * n;
  if (p_stagger) p.x += 0.5 * mod(floor(p.y), 2.0);
  vec2 cell = floor(p), f = fract(p) - 0.5;
  float ph = p_wave == 0 ? length(cell) * 0.6 : p_wave == 1 ? cell.x * 0.5 : hash12(cell) * TAU;
  float r = 0.5 * p_size * (1.0 - p_pulse * (0.5 + 0.5 * sin(uTime * p_speed * TAU - ph)));
  return paint(p_background, p_color, edge((length(f) - r) / n, 0.0));
}
`),

  source('truchet', 'Truchet', 'Pattern', [
    color('color', 'Color', '#ffffff'),
    background(),
    int('scale', 'Tiles', 10, 2, 64),
    num('width', 'Width', 0.15, 0.01, 0.5),
    pick('style', 'Style', ['Arcs', 'Diagonals']),
    speed(0.3, 0, 4),
  ], `
vec4 gen(vec2 uv) {
  float n = float(p_scale);
  vec2 p = centered(uv) * n;
  vec2 cell = floor(p), f = fract(p) - 0.5;
  float flip = floor(uTime * p_speed + hash12(cell + 3.7) * 8.0);
  if (hash12(cell + flip * 7.31) > 0.5) f.x = -f.x;
  float d = p_style == 0 ? min(abs(length(f - 0.5) - 0.5), abs(length(f + 0.5) - 0.5)) : abs(f.x + f.y) * 0.70710678;
  return paint(p_background, p_color, edge((d - p_width * 0.5) / n, 0.0));
}
`),
  // Geometric
  source('rings', 'Rings', 'Geometric', [
    legacyColor,
    num('frequency', 'Frequency', 70, 5, 200),
    num('dim', 'Background Level', 0.025, 0, 1),
    speed(5, -20, 20),
  ], `
vec4 gen(vec2 uv) {
  float r = length(centered(uv));
  float rings = 0.5 + 0.5 * sin(r * p_frequency - uTime * p_speed);
  return vec4(mix(p_color.rgb * p_dim, p_color.rgb, rings * rings), 1.0);
}
`, LEGACY),

  source('concentric-rings', 'Concentric Rings', 'Geometric', [
    color('color', 'Color', '#ffffff'),
    color('color2', 'Alternate Color', '#ff6a38'),
    background(),
    int('count', 'Rings', 6, 1, 32),
    num('size', 'Size', 0.45, 0.05, 1),
    num('width', 'Width', 0.5, 0.02, 1),
    num('gap', 'Arc Gap', 0, 0, 0.95),
    pick('style', 'Style', ['Solid', 'Fade Out', 'Fade In', 'Alternate']),
    speed(0.25),
    num('spin', 'Spin', 0.1, -2, 2),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv);
  float r = length(p);
  float spacing = p_size / float(p_count);
  float x = r / spacing - uTime * p_speed;
  float idx = floor(x);
  float m = edge((abs(fract(x) - 0.5) - p_width * 0.5) * spacing, 0.0);
  m *= 1.0 - smoothstep(p_size - spacing * 0.5, p_size + spacing * 0.5, r);
  if (p_gap > 0.0) {
    float dir = mod(idx, 2.0) * 2.0 - 1.0;
    float ga = fract(atan(p.y, p.x) / TAU + uTime * p_spin * dir + idx * 0.137);
    m *= smoothstep(0.0, 2.0 * pxSize() / max(r * TAU, 0.001), ga - p_gap);
  }
  vec4 c = p_color;
  if (p_style == 1) m *= 1.0 - clamp(r / p_size, 0.0, 1.0);
  else if (p_style == 2) m *= clamp(r / p_size, 0.0, 1.0);
  else if (p_style == 3 && mod(idx, 2.0) >= 1.0) c = p_color2;
  return paint(p_background, c, m);
}
`),

  source('circles', 'Circles', 'Geometric', [
    color('color', 'Color', '#ffffff'),
    color('color2', 'Color 2', '#ff6a38'),
    background(),
    int('count', 'Count', 8, 1, 32),
    num('orbit', 'Orbit', 0.3, 0, 0.5),
    num('radius', 'Radius', 0.06, 0.005, 0.3),
    pick('style', 'Style', ['Filled', 'Outline']),
    num('strokeWidth', 'Stroke Width', 0.01, 0.001, 0.1),
    num('wobble', 'Wobble', 0.2, 0, 1),
    speed(0.1, -2, 2),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv);
  float n = float(p_count), t = uTime * p_speed * TAU;
  vec4 col = p_background;
  for (int i = 0; i < 32; i++) {
    if (i >= p_count) break;
    float k = float(i) / n;
    float a = TAU * k + t;
    vec2 c = p_orbit * vec2(cos(a), sin(a)) * (1.0 + p_wobble * 0.5 * sin(t * 2.0 + k * TAU * 2.0));
    float d = length(p - c) - p_radius;
    float m = p_style == 0 ? edge(d, 0.0) : edge(abs(d) - p_strokeWidth * 0.5, 0.0);
    col = paint(col, mix(p_color, p_color2, k), m);
  }
  return col;
}
`),

  source('polygon', 'Shape', 'Geometric', [
    int('sides', 'Sides', 6, 3, 16),
    num('size', 'Size', 0.3, 0.01, 1),
    ...shapeParams,
  ], SHAPE + `
float sdPolygon(vec2 p, float r, int n) {
  float an = PI / float(n);
  vec2 acs = vec2(cos(an), sin(an));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p.y += clamp(-p.y, 0.0, r * acs.y);
  return length(p) * sign(p.x);
}
vec4 gen(vec2 uv) {
  vec2 p = rotate2((uv - p_position) * vec2(uAspect, 1.0), -radians(p_rotation) - uTime * p_spin * TAU);
  return shapeLayer(sdPolygon(p, p_size, p_sides));
}
`),

  source('star', 'Star', 'Geometric', [
    int('points', 'Points', 5, 2, 16),
    num('size', 'Size', 0.35, 0.01, 1),
    num('sharpness', 'Sharpness', 0.6, 0, 1),
    ...shapeParams,
  ], SHAPE + `
float sdStar(vec2 p, float r, int n, float m) {
  float an = PI / float(n), en = PI / m;
  vec2 acs = vec2(cos(an), sin(an)), ecs = vec2(cos(en), sin(en));
  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}
vec4 gen(vec2 uv) {
  vec2 p = rotate2((uv - p_position) * vec2(uAspect, 1.0), -radians(p_rotation) - uTime * p_spin * TAU);
  return shapeLayer(sdStar(p, p_size, p_points, mix(float(p_points), 2.0, p_sharpness)));
}
`),

  source('spiral', 'Spiral', 'Geometric', [
    color('color', 'Color', '#ffffff'),
    color('color2', 'Outer Color', '#ff6a38'),
    background(),
    int('arms', 'Arms', 3, 1, 12),
    num('twist', 'Twist', 8, 0, 40),
    num('width', 'Width', 0.5, 0.02, 1),
    pick('style', 'Style', ['Archimedean', 'Logarithmic']),
    speed(0.3),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv);
  float r = length(p), arms = float(p_arms);
  float s = p_style == 0 ? r * p_twist : log(max(r, 0.0001)) * p_twist * 0.25;
  float x = atan(p.y, p.x) / TAU * arms + s - uTime * p_speed;
  float w = fwidth(s) + arms / (TAU * max(r, 0.001)) * pxSize() + 0.0001;
  float m = 1.0 - smoothstep(p_width * 0.5 - w, p_width * 0.5 + w, abs(fract(x) - 0.5));
  m *= smoothstep(0.0, 0.03, r);
  return paint(p_background, mix(p_color, p_color2, clamp(r * 2.0, 0.0, 1.0)), m);
}
`),

  source('kaleido-flower', 'Kaleido Flower', 'Geometric', [
    color('colorA', 'Outer Color', '#ff6a38'),
    color('colorB', 'Inner Color', '#ffd25a'),
    background(),
    int('petals', 'Petals', 8, 3, 24),
    int('layers', 'Layers', 4, 1, 8),
    num('size', 'Size', 0.42, 0.05, 1),
    num('depth', 'Petal Depth', 0.5, 0, 1),
    num('roundness', 'Roundness', 0.7, 0.1, 4),
    speed(0.15, -2, 2),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv);
  float r = length(p), a = atan(p.y, p.x);
  float petals = float(p_petals), n = float(p_layers), t = uTime * p_speed;
  vec4 col = p_background;
  for (int i = 0; i < 8; i++) {
    if (i >= p_layers) break;
    float k = float(i) / max(n - 1.0, 1.0);
    float ph = t * (mod(float(i), 2.0) * 2.0 - 1.0) + k * PI / petals;
    float rr = p_size * (1.0 - k * 0.7) * (1.0 + 0.06 * sin(t * 2.0 + k * TAU));
    float shape = pow(abs(cos((a + ph) * petals * 0.5)), p_roundness);
    float outer = rr * (1.0 - p_depth + p_depth * shape);
    vec4 c = mix(p_colorA, p_colorB, k);
    c.rgb *= 0.6 + 0.4 * clamp(r / max(outer, 0.001), 0.0, 1.0);
    col = paint(col, c, edge(r - outer, 0.0));
  }
  return col;
}
`),

  source('hex-grid', 'Hexagons', 'Geometric', [
    color('color', 'Line Color', '#ffffff'),
    color('fillColor', 'Fill Color', '#ff6a38'),
    background(),
    int('size', 'Cells', 8, 2, 48),
    num('border', 'Border', 0.08, 0, 0.5),
    num('fill', 'Fill', 0.6, 0, 1),
    speed(0.3),
  ], `
vec4 gen(vec2 uv) {
  float n = float(p_size);
  vec2 p = centered(uv) * n;
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5;
  vec2 b = mod(p - s * 0.5, s) - s * 0.5;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = p - g, q = abs(g);
  float hd = 0.5 - max(dot(q, vec2(0.5, 0.8660254)), q.x);
  float pulse = 0.5 + 0.5 * sin(uTime * p_speed * TAU - length(id) * 0.8);
  float line = edge((hd - p_border * 0.5) / n, 0.0);
  vec4 col = paint(p_background, p_fillColor, (1.0 - line) * p_fill * pulse);
  return paint(col, p_color, line);
}
`),
  // Organic
  source('plasma', 'Plasma', 'Organic', [
    legacyColor,
    num('scale', 'Scale', 1, 0.1, 4),
    speed(1),
  ], `
vec4 gen(vec2 uv) {
  vec2 v = centered(uv) * p_scale;
  float t = uTime * p_speed;
  float f = sin(v.x * 9.0 + t) + sin(v.y * 11.0 - t * 1.3) + sin(length(v) * 16.0 - t * 1.8);
  return vec4(0.5 + 0.5 * cos(f + vec3(0.0, 2.1, 4.2) + p_color.rgb * 3.0), 1.0);
}
`, LEGACY),

  source('noise', 'Noise', 'Organic', [
    legacyColor,
    num('fps', 'Frame Rate', 24, 1, 60),
    num('grain', 'Grain Size', 1, 1, 16),
    flag('colored', 'Colored'),
  ], `
float legacyHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec4 gen(vec2 uv) {
  vec2 cell = floor(uv * vec2(640.0, 360.0) / p_grain) + floor(uTime * p_fps);
  float n = legacyHash(cell);
  if (p_colored) return vec4(p_color.rgb * vec3(n, legacyHash(cell + 17.0), legacyHash(cell + 41.0)), 1.0);
  return vec4(p_color.rgb * n, 1.0);
}
`, LEGACY),

  source('fractal-noise', 'Fractal Noise', 'Organic', [
    color('colorA', 'Color A', '#000000'),
    color('colorB', 'Color B', '#ffffff'),
    num('scale', 'Scale', 4, 0.1, 20),
    int('octaves', 'Octaves', 5, 1, 6),
    pick('style', 'Style', ['Smooth', 'Ridged', 'Turbulent']),
    num('contrast', 'Contrast', 1.5, 0.1, 5),
    num('brightness', 'Brightness', 0, -1, 1),
    num('warp', 'Warp', 0, 0, 3),
    speed(0.2),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv) * p_scale;
  float t = uTime * p_speed;
  if (p_warp > 0.0) p += p_warp * (vec2(fbm(p + vec2(t, 0.0), 3), fbm(p + vec2(5.2, 1.3 - t), 3)) - 0.5) * 2.0;
  float n = fbm(p + vec2(t * 0.5, -t * 0.3), p_octaves);
  if (p_style == 1) n = 1.0 - abs(n * 2.0 - 1.0);
  else if (p_style == 2) n = abs(n * 2.0 - 1.0);
  n = clamp((n - 0.5) * p_contrast + 0.5 + p_brightness, 0.0, 1.0);
  return mix(p_colorA, p_colorB, n);
}
`),

  source('clouds', 'Clouds', 'Organic', [
    color('sky', 'Sky Color', '#3a78d8'),
    color('cloud', 'Cloud Color', '#ffffff'),
    color('shade', 'Shade Color', '#9aa8c0'),
    num('scale', 'Scale', 2.5, 0.2, 10),
    num('coverage', 'Coverage', 0.5, 0, 1),
    num('softness', 'Softness', 0.25, 0, 1),
    int('detail', 'Detail', 6, 1, 6),
    speed(0.08, -2, 2),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv) * p_scale + vec2(uTime * p_speed, 0.0);
  float n = fbm(p + 0.6 * vec2(fbm(p * 0.7 + uTime * p_speed * 0.3, 3)), p_detail);
  float th = mix(0.72, 0.3, p_coverage);
  float c = smoothstep(th - p_softness * 0.5, th + p_softness * 0.5 + 0.001, n);
  vec3 rgb = mix(p_shade.rgb, p_cloud.rgb, smoothstep(th, th + 0.25, n));
  return paint(p_sky, vec4(rgb, p_cloud.a), c);
}
`),

  source('voronoi', 'Cells', 'Organic', [
    pick('style', 'Style', ['Cells', 'Edges', 'Distance']),
    color('colorA', 'Color A', '#ff6a38'),
    color('colorB', 'Color B', '#1d2a6b'),
    color('edgeColor', 'Edge Color', '#000000'),
    flag('random', 'Random Colors', true),
    num('scale', 'Scale', 6, 1, 40),
    num('edge', 'Edge Width', 0.04, 0, 0.5),
    speed(0.5),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv) * p_scale;
  vec2 ip = floor(p), fp = fract(p), id = vec2(0.0);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 h = vec2(hash12(ip + g), hash12(ip + g + 19.19));
      float d = length(g + 0.5 + 0.42 * sin(uTime * p_speed + TAU * h) - fp);
      if (d < d1) { d2 = d1; d1 = d; id = ip + g; }
      else if (d < d2) d2 = d;
    }
  }
  float e = d2 - d1;
  float em = 1.0 - smoothstep(p_edge, p_edge + fwidth(e) * 1.5 + 0.0001, e);
  if (p_style == 1) return vec4(p_colorA.rgb, p_colorA.a * em);
  if (p_style == 2) return mix(p_colorB, p_colorA, clamp(d1, 0.0, 1.0));
  float hc = hash12(id * 1.31 + 4.7);
  vec4 cell = p_random ? vec4(hsv2rgb(vec3(hc, 0.65, 0.95)), 1.0) : mix(p_colorA, p_colorB, hc);
  return paint(cell, p_edgeColor, em);
}
`),

  source('metaballs', 'Lava Lamp', 'Organic', [
    color('colorA', 'Color A', '#ff3a1a'),
    color('colorB', 'Color B', '#ffd23a'),
    background('#000000'),
    int('blobs', 'Blobs', 6, 1, 12),
    num('size', 'Size', 0.15, 0.02, 0.4),
    num('threshold', 'Threshold', 1, 0.2, 4),
    num('glow', 'Glow', 0.35, 0, 1),
    speed(0.4),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv);
  float t = uTime * p_speed, field = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= p_blobs) break;
    float fi = float(i);
    vec4 h = vec4(hash12(vec2(fi, 1.0)), hash12(vec2(fi, 2.0)), hash12(vec2(fi, 3.0)), hash12(vec2(fi, 4.0)));
    vec2 c = vec2(sin(t * (0.6 + h.x) + h.y * TAU) * uAspect * 0.38, sin(t * (0.4 + h.z * 0.8) + h.w * TAU) * 0.38);
    vec2 d = p - c;
    field += p_size * p_size * (0.6 + h.x * 0.8) / max(dot(d, d), 0.00001);
  }
  float w = min(fwidth(field), p_threshold * 0.5) + 0.0001;
  float m = smoothstep(p_threshold - w, p_threshold + w, field);
  vec4 c = mix(p_colorA, p_colorB, clamp((field - p_threshold) / (p_threshold * 3.0), 0.0, 1.0));
  vec4 col = paint(p_background, p_colorA, p_glow * smoothstep(p_threshold * 0.3, p_threshold, field) * (1.0 - m));
  return paint(col, c, m);
}
`),

  source('liquid', 'Liquid', 'Organic', [
    num('scale', 'Scale', 1, 0.1, 5),
    num('warp', 'Warp', 1, 0, 3),
    num('hue', 'Hue', 0, 0, 1),
    num('saturation', 'Saturation', 1, 0, 2),
    speed(0.15, -2, 2),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv) * p_scale * 3.0;
  float t = uTime * p_speed;
  vec2 q = vec2(fbm(p + vec2(0.0, t), 4), fbm(p + vec2(5.2, 1.3 - t), 4));
  vec2 r = vec2(fbm(p + p_warp * 4.0 * q + vec2(1.7, 9.2) + t * 0.5, 4), fbm(p + p_warp * 4.0 * q + vec2(8.3, 2.8), 4));
  float n = fbm(p + p_warp * 4.0 * r, 4);
  vec3 c = cosPalette(n * 1.6 + length(q) * 0.6 + p_hue);
  return vec4(mix(vec3(luma(c)), c, p_saturation) * (0.4 + 0.8 * n), 1.0);
}
`),

  // Fractal
  source('julia', 'Julia', 'Fractal', [
    num('real', 'C Real', -0.8, -1.5, 1.5),
    num('imag', 'C Imaginary', 0.156, -1.5, 1.5),
    num('zoom', 'Zoom', 1, 0.2, 50),
    int('iterations', 'Iterations', 48, 8, 64),
    num('morph', 'Morph', 1, 0, 4),
    num('spin', 'Spin', 0, -2, 2),
    num('density', 'Color Density', 2, 0.2, 8),
    num('hue', 'Hue', 0, 0, 1),
    num('cycle', 'Color Cycle', 0.1, -2, 2),
    color('inside', 'Inside Color', '#000000'),
  ], `
vec4 gen(vec2 uv) {
  vec2 z = rotate2(centered(uv), uTime * p_spin) * 3.0 / p_zoom;
  vec2 c = vec2(p_real, p_imag) + p_morph * 0.06 * vec2(cos(uTime * 0.7), sin(uTime * 0.53));
  float n = 0.0, escaped = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= p_iterations) break;
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 256.0) { escaped = 1.0; break; }
    n += 1.0;
  }
  if (escaped < 0.5) return p_inside;
  float sn = (n - log2(log2(dot(z, z))) + 4.0) / float(p_iterations);
  return vec4(cosPalette(sn * p_density + p_hue + uTime * p_cycle), 1.0);
}
`),

  source('mandelbrot', 'Mandelbrot', 'Fractal', [
    num('x', 'Center X', -0.7436, -2.5, 1),
    num('y', 'Center Y', 0.1318, -1.5, 1.5),
    num('zoom', 'Zoom', 1, 0.2, 1000),
    num('zoomSpeed', 'Zoom Speed', 0.2, 0, 2),
    num('depth', 'Zoom Depth', 7, 1, 10),
    int('iterations', 'Iterations', 64, 8, 64),
    num('spin', 'Spin', 0, -2, 2),
    num('density', 'Color Density', 1.5, 0.2, 8),
    num('hue', 'Hue', 0.6, 0, 1),
    num('cycle', 'Color Cycle', 0, -2, 2),
    color('inside', 'Inside Color', '#000000'),
  ], `
vec4 gen(vec2 uv) {
  float zoom = p_zoom * exp(mod(uTime * p_zoomSpeed, p_depth));
  vec2 c = vec2(p_x, p_y) + rotate2(centered(uv), uTime * p_spin) * 3.0 / zoom;
  vec2 z = vec2(0.0);
  float n = 0.0, escaped = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= p_iterations) break;
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    if (dot(z, z) > 256.0) { escaped = 1.0; break; }
    n += 1.0;
  }
  if (escaped < 0.5) return p_inside;
  float sn = (n - log2(log2(dot(z, z))) + 4.0) / float(p_iterations);
  return vec4(cosPalette(sn * p_density + p_hue + uTime * p_cycle), 1.0);
}
`),
  // Motion
  source('starfield', 'Starfield', 'Motion', [
    color('color', 'Color', '#ffffff'),
    background('#000000'),
    num('density', 'Density', 0.35, 0, 1),
    num('size', 'Star Size', 1, 0.1, 4),
    num('twinkle', 'Twinkle', 0.3, 0, 1),
    point('center', 'Center'),
    speed(0.5),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = (uv - p_center) * vec2(uAspect, 1.0);
  float glow = 0.0;
  for (int i = 0; i < 4; i++) {
    float depth = fract(float(i) * 0.25 + uTime * p_speed * 0.1);
    float scale = mix(24.0, 1.5, depth);
    float fade = smoothstep(0.0, 0.3, depth) * (1.0 - smoothstep(0.9, 1.0, depth));
    vec2 q = p * scale + float(i) * 37.13;
    vec2 id = floor(q), f = fract(q) - 0.5;
    float h = hash12(id);
    vec2 o = (vec2(hash12(id + 1.7), hash12(id + 9.2)) - 0.5) * 0.7;
    float d = length(f - o) / scale;
    float rad = p_size * 0.004 * (0.5 + h) * mix(0.5, 2.0, depth);
    float tw = 1.0 - p_twinkle * (0.5 + 0.5 * sin(uTime * 5.0 + h * 60.0));
    glow += step(h, p_density) * fade * tw * (edge(d - rad, 0.0) + 0.4 * exp(-d / (rad * 2.0 + 0.0001)));
  }
  return over(vec4(p_color.rgb, clamp(glow, 0.0, 1.0) * p_color.a), p_background);
}
`),

  source('particles', 'Particles', 'Motion', [
    color('color', 'Color', '#ffffff'),
    color('color2', 'Color 2', '#ff6a38'),
    background(),
    int('density', 'Density', 8, 2, 40),
    num('size', 'Size', 0.5, 0.05, 1),
    num('direction', 'Direction', 90, 0, 360),
    num('wobble', 'Wobble', 0.5, 0, 1),
    speed(0.3),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = rotate2(centered(uv), -radians(p_direction - 90.0));
  float m = 0.0, tone = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float scale = float(p_density) * (1.0 + fi * 0.6);
    vec2 q = p * scale + vec2(fi * 11.3, -uTime * p_speed * scale * (0.6 + fi * 0.25));
    vec2 id = floor(q), f = fract(q) - 0.5;
    float h = hash12(id + fi * 5.1);
    float r = p_size * 0.25 * (0.4 + 0.6 * h);
    vec2 o = vec2(sin(uTime * (1.0 + h * 2.0) + h * TAU) * p_wobble, hash12(id + 2.3) * 2.0 - 1.0) * (0.5 - r);
    float life = sin(PI * fract(uTime * 0.25 + h));
    float v = edge((length(f - o) - r) / scale, r / scale * 0.5) * life * step(0.3, h);
    if (v > m) { m = v; tone = h; }
  }
  return paint(p_background, mix(p_color, p_color2, tone), m);
}
`),

  source('tunnel', 'Tunnel', 'Motion', [
    pick('style', 'Style', ['Round', 'Square']),
    color('colorA', 'Color A', '#ff6a38'),
    color('colorB', 'Color B', '#140a2a'),
    num('depth', 'Depth', 0.4, 0.05, 2),
    int('segments', 'Segments', 6, 1, 32),
    num('twist', 'Twist', 0.05, -2, 2),
    num('fog', 'Fog', 0.7, 0, 1),
    point('center', 'Center'),
    speed(0.6),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = (uv - p_center) * vec2(uAspect, 1.0);
  float r = max(p_style == 0 ? length(p) : max(abs(p.x), abs(p.y)), 0.0001);
  float depth = p_depth / r + uTime * p_speed;
  float around = atan(p.y, p.x) / TAU * float(p_segments) + uTime * p_twist;
  float k = sin(depth * TAU) * sin(around * TAU);
  float w = fwidth(k) + 0.0001;
  vec4 c = mix(p_colorB, p_colorA, smoothstep(-w, w, k));
  return vec4(c.rgb * mix(1.0, smoothstep(0.0, 0.5, r), p_fog), c.a);
}
`),

  source('lasers', 'Laser Beams', 'Motion', [
    color('color', 'Color', '#38ff6a'),
    background(),
    int('beams', 'Beams', 8, 1, 32),
    point('origin', 'Origin', [0.5, 0]),
    num('direction', 'Direction', 90, 0, 360),
    num('spread', 'Spread', 70, 0, 360),
    num('sweep', 'Sweep', 20, 0, 90),
    num('width', 'Width', 0.006, 0.001, 0.05),
    num('glow', 'Glow', 0.5, 0, 2),
    flag('rainbow', 'Rainbow'),
    speed(0.25),
  ], `
vec4 gen(vec2 uv) {
  vec2 q = centered(uv) - (p_origin - 0.5) * vec2(uAspect, 1.0);
  float n = float(p_beams), t = uTime * p_speed * TAU, total = 0.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 32; i++) {
    if (i >= p_beams) break;
    float k = n > 1.0 ? float(i) / (n - 1.0) - 0.5 : 0.0;
    float ang = radians(p_direction + k * p_spread + sin(t + float(i) * 0.9) * p_sweep);
    vec2 dir = vec2(cos(ang), sin(ang));
    float dist = abs(q.x * dir.y - q.y * dir.x);
    float beam = (edge(dist - p_width * 0.5, 0.0) + p_glow * exp(-dist / (p_width * 4.0 + 0.002))) * step(0.0, dot(q, dir));
    vec3 c = p_rainbow ? hsv2rgb(vec3(fract(float(i) / n + uTime * 0.1), 0.8, 1.0)) : p_color.rgb;
    acc += c * beam;
    total += beam;
  }
  return over(vec4(acc / max(total, 0.0001), clamp(total, 0.0, 1.0) * p_color.a), p_background);
}
`),

  source('lightning', 'Lightning', 'Motion', [
    color('color', 'Color', '#a8c8ff'),
    background(),
    point('start', 'Start', [0.5, 1]),
    point('end', 'End', [0.5, 0]),
    int('bolts', 'Bolts', 2, 1, 6),
    num('jagged', 'Jaggedness', 0.3, 0, 1),
    num('rate', 'Strike Rate', 4, 0.1, 20),
    num('width', 'Width', 0.006, 0.001, 0.05),
    num('glow', 'Glow', 0.6, 0, 2),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv);
  vec2 a = (p_start - 0.5) * vec2(uAspect, 1.0);
  vec2 ab = (p_end - 0.5) * vec2(uAspect, 1.0) - a;
  float len = max(length(ab), 0.001);
  vec2 dir = ab / len, nrm = vec2(-dir.y, dir.x);
  float along = dot(p - a, dir), y = dot(p - a, nrm);
  float s = clamp(along / len, 0.0, 1.0);
  float beyond = max(along - len, 0.0) + max(-along, 0.0);
  float total = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= p_bolts) break;
    float strike = uTime * p_rate + float(i) * 0.37;
    float seed = floor(strike) * 13.7 + float(i) * 71.3;
    float disp = (fbm(vec2(s * 6.0, seed), 5) - 0.5) * 2.0 * p_jagged * len * sin(PI * s);
    float dist = length(vec2(y - disp, beyond));
    float flash = pow(1.0 - fract(strike), 2.0);
    total += flash * (edge(dist - p_width * 0.5, 0.0) + p_glow * exp(-dist / (p_width * 6.0 + 0.002)));
  }
  vec3 rgb = mix(p_color.rgb, vec3(1.0), clamp(total - 1.0, 0.0, 1.0) * 0.5);
  return over(vec4(rgb, clamp(total, 0.0, 1.0) * p_color.a), p_background);
}
`),

  source('matrix-rain', 'Matrix Rain', 'Motion', [
    color('color', 'Color', '#35ff6a'),
    color('headColor', 'Head Color', '#e0ffe8'),
    background('#000000'),
    int('columns', 'Columns', 48, 8, 160),
    num('trail', 'Trail', 0.4, 0.05, 1),
    num('flicker', 'Flicker', 3, 0, 20),
    speed(1, 0, 4),
  ], `
vec4 gen(vec2 uv) {
  float cols = float(p_columns);
  float rows = max(1.0, floor(cols / (uAspect * 1.5)));
  vec2 g = vec2(uv.x * cols, (1.0 - uv.y) * rows);
  vec2 cell = floor(g), f = fract(g);
  float h = hash12(vec2(cell.x, 1.7));
  float trail = max(1.0, p_trail * rows);
  float head = mod(uTime * (0.4 + h) * p_speed * rows * 0.35 + h * 97.0, rows + trail);
  float dist = head - cell.y;
  if (dist < 0.0 || dist > trail) return p_background;
  float flick = floor(uTime * p_flicker + hash12(cell) * 10.0);
  float on = step(0.45, hash12(floor(f * vec2(3.0, 5.0)) + cell * 3.1 + vec2(flick * 0.913, flick * 1.7)));
  vec2 inner = abs(f - 0.5);
  on *= step(inner.x, 0.42) * step(inner.y, 0.44);
  return paint(p_background, dist < 1.0 ? p_headColor : p_color, on * (1.0 - dist / trail));
}
`),
  // Audio
  source('waveform', 'Waveform', 'Audio', [
    color('color', 'Color', '#38ffd8'),
    background(),
    pick('style', 'Style', ['Line', 'Mirror', 'Circle']),
    num('gain', 'Gain', 1, 0, 4),
    num('idle', 'Idle Motion', 0.15, 0, 1),
    num('frequency', 'Frequency', 2, 1, 12),
    num('width', 'Width', 0.006, 0.001, 0.05),
    num('glow', 'Glow', 0.4, 0, 2),
    speed(1),
  ], `
float wave(float x) {
  float k = max(1.0, floor(p_frequency)), t = uTime * p_speed;
  vec3 amp = p_idle * vec3(1.0, 0.5, 0.3) + uAudio.xyz * p_gain;
  return 0.15 * (amp.x * sin(TAU * (x * k + t * 0.5)) + 0.6 * amp.y * sin(TAU * (x * k * 3.0 - t * 1.3)) + 0.35 * amp.z * sin(TAU * (x * k * 7.0 + t * 2.1)));
}
vec4 gen(vec2 uv) {
  vec2 p = centered(uv);
  float dist;
  if (p_style == 2) {
    float x = atan(p.y, p.x) / TAU + 0.5;
    dist = abs(length(p) - (0.25 + uAudio.w * p_gain * 0.1 + wave(x) * 0.6));
  } else {
    float y = wave(uv.x);
    float slope = (wave(uv.x + 0.002) - wave(uv.x - 0.002)) / (0.004 * uAspect);
    float norm = inversesqrt(1.0 + slope * slope);
    dist = abs(p.y - y) * norm;
    if (p_style == 1) dist = min(dist, abs(p.y + y) * norm);
  }
  float core = edge(dist - p_width * 0.5, 0.0);
  float glow = p_glow * exp(-dist / (p_width * 5.0 + 0.002));
  return over(vec4(mix(p_color.rgb, vec3(1.0), core * 0.3), clamp(core + glow, 0.0, 1.0) * p_color.a), p_background);
}
`),

  source('spectrum-bars', 'Spectrum Bars', 'Audio', [
    color('colorLow', 'Low Color', '#ff3a6a'),
    color('colorHigh', 'High Color', '#3ad0ff'),
    background(),
    int('bars', 'Bars', 32, 4, 128),
    num('gap', 'Gap', 0.25, 0, 0.9),
    num('gain', 'Gain', 1, 0, 4),
    num('idle', 'Idle Motion', 0.12, 0, 1),
    pick('style', 'Style', ['Bottom', 'Center']),
    pick('gradient', 'Gradient', ['Across', 'Up']),
    int('segments', 'Segments', 0, 0, 64),
    speed(1, 0, 4),
  ], `
vec4 gen(vec2 uv) {
  float n = float(p_bars), x = uv.x * n, i = floor(x), u = (i + 0.5) / n;
  float lvl = u < 0.5 ? mix(uAudio.x, uAudio.y, u * 2.0) : mix(uAudio.y, uAudio.z, u * 2.0 - 1.0);
  float t = uTime * p_speed;
  float h = lvl * p_gain * (0.6 + 0.4 * noise2(vec2(i * 0.73, t * 4.0))) + p_idle * (0.4 + 0.6 * noise2(vec2(i * 1.37 + 9.0, t * 2.0)));
  h = clamp(h, 0.0, 1.0);
  float fx = fract(x), w = fwidth(x) + 0.0001, g = p_gap * 0.5;
  float m = smoothstep(g - w, g + w, fx) * (1.0 - smoothstep(1.0 - g - w, 1.0 - g + w, fx));
  float y = p_style == 1 ? abs(uv.y - 0.5) * 2.0 : uv.y;
  float hw = fwidth(y) + 0.0001;
  m *= 1.0 - smoothstep(h - hw, h + hw, y);
  if (p_segments > 0) m *= step(0.2, fract(y * float(p_segments)));
  return paint(p_background, mix(p_colorLow, p_colorHigh, p_gradient == 0 ? u : y), m);
}
`),

  source('audio-pulse', 'Pulse', 'Audio', [
    color('color', 'Color', '#ff6a38'),
    color('color2', 'Ring Color', '#ffffff'),
    background(),
    pick('band', 'Band', ['Level', 'Low', 'Mid', 'High']),
    num('radius', 'Radius', 0.12, 0.01, 0.5),
    num('gain', 'Gain', 1, 0, 4),
    int('rings', 'Rings', 4, 0, 8),
    num('spread', 'Spread', 0.4, 0, 1),
    num('width', 'Ring Width', 0.01, 0.001, 0.1),
    speed(0.5, 0, 4),
  ], `
vec4 gen(vec2 uv) {
  float r = length(centered(uv));
  float lvl = p_band == 0 ? uAudio.w : p_band == 1 ? uAudio.x : p_band == 2 ? uAudio.y : uAudio.z;
  float radius = p_radius * (1.0 + lvl * p_gain);
  vec4 col = p_background;
  for (int i = 0; i < 8; i++) {
    if (i >= p_rings) break;
    float ph = fract(uTime * p_speed + float(i) / float(p_rings));
    float m = edge(abs(r - radius - ph * p_spread) - p_width * 0.5, 0.0);
    col = paint(col, p_color2, (1.0 - ph) * (0.35 + 0.65 * lvl) * m);
  }
  return paint(col, p_color, edge(r - radius, 0.0));
}
`),

  // Utility
  source('color-bars', 'Color Bars', 'Utility', [
    pick('style', 'Style', ['SMPTE', '75% Bars', '100% Bars']),
  ], `
vec3 bar(int i, float level) {
  vec3 c[8] = ${BAR_COLORS};
  return c[i] * level;
}
vec4 gen(vec2 uv) {
  if (p_style == 2) return vec4(bar(int(min(uv.x * 8.0, 7.0)), 1.0), 1.0);
  int i = int(min(uv.x * 7.0, 6.0));
  if (p_style == 1 || uv.y > 1.0 / 3.0) return vec4(bar(i, 0.75), 1.0);
  if (uv.y > 0.25) return vec4(bar(i % 2 == 1 ? 7 : 6 - i, 0.75), 1.0);
  float bx = uv.x * 7.0;
  vec3 c = vec3(0.0);
  if (bx < 1.25) c = vec3(0.0, 0.129, 0.298);
  else if (bx < 2.5) c = vec3(1.0);
  else if (bx < 3.75) c = vec3(0.196, 0.0, 0.416);
  else if (bx >= 5.0 && bx < 6.0) c = vec3(bx < 5.333 ? 0.0 : bx < 5.667 ? 0.02 : 0.04);
  return vec4(c, 1.0);
}
`),

  source('test-card', 'Test Card', 'Utility', [
    background('#1c1c1c'),
    color('lines', 'Line Color', '#d8d8d8'),
    color('accent', 'Accent Color', '#ff6a38'),
    int('grid', 'Grid', 10, 2, 40),
    flag('bars', 'Color Bars', true),
    flag('sweep', 'Sweep', true),
    speed(0.25, -2, 2),
  ], `
vec4 gen(vec2 uv) {
  vec2 p = centered(uv), hs = vec2(uAspect, 1.0) * 0.5;
  float px = pxSize(), n = float(p_grid), r = length(p);
  const float R = 0.42;
  vec3 col = p_background.rgb;
  vec2 g = abs(fract(p * n + 0.5) - 0.5) / n;
  col = mix(col, p_lines.rgb, 0.45 * edge(min(g.x, g.y) - px * 0.5, 0.0));
  if (p_bars && r < R) {
    float bx = clamp((p.x + R) / (2.0 * R), 0.0, 0.9999);
    vec3 c[8] = ${BAR_COLORS};
    if (p.y > 0.0 && p.y < 0.14) col = c[int(bx * 8.0)];
    else if (p.y <= 0.0 && p.y > -0.14) col = vec3(floor(bx * 8.0) / 7.0);
    else if (p.y <= -0.14 && p.y > -0.26) col = vec3(0.5 + 0.5 * sin(p.x * 20.0 * exp2(floor(bx * 5.0)) * TAU));
  }
  if (p_sweep) col = mix(col, p_accent.rgb, step(r, R) * 0.5 * exp(-fract(uTime * p_speed - atan(p.y, p.x) / TAU) * 10.0));
  col = mix(col, p_lines.rgb, edge(abs(r - R) - px, 0.0));
  col = mix(col, p_lines.rgb, edge(abs(r - 0.1) - px * 0.75, 0.0));
  col = mix(col, p_lines.rgb, edge(min(abs(p.x), abs(p.y)) - px * 0.5, 0.0) * step(r, R));
  vec2 e = hs - abs(p);
  col = mix(col, p_accent.rgb, edge(min(e.x, e.y) - 2.0 * px, 0.0));
  vec2 q = abs(p) - (hs - 0.05);
  float bracket = max(edge(abs(q.y) - px, 0.0) * step(-0.08, q.x) * step(q.x, 0.0), edge(abs(q.x) - px, 0.0) * step(-0.08, q.y) * step(q.y, 0.0));
  return vec4(mix(col, p_accent.rgb, bracket), 1.0);
}
`),

  source('ramp', 'Ramp', 'Utility', [
    color('colorA', 'Start Color', '#000000'),
    color('colorB', 'End Color', '#ffffff'),
    pick('direction', 'Direction', ['Horizontal', 'Vertical']),
    int('steps', 'Steps', 11, 0, 64),
    flag('invert', 'Invert'),
  ], `
vec4 gen(vec2 uv) {
  float t = p_direction == 0 ? uv.x : uv.y;
  if (p_steps > 1) t = min(floor(t * float(p_steps)), float(p_steps - 1)) / float(p_steps - 1);
  if (p_invert) t = 1.0 - t;
  return mix(p_colorA, p_colorB, t);
}
`),

  source('color-wheel', 'Color Wheel', 'Utility', [
    pick('style', 'Style', ['Wheel', 'Disc', 'Spectrum']),
    num('saturation', 'Saturation', 1, 0, 1),
    num('value', 'Brightness', 1, 0, 1),
    background(),
    speed(0, -2, 2),
  ], `
vec4 gen(vec2 uv) {
  if (p_style == 2) {
    vec3 hsv = vec3(fract(uv.x + uTime * p_speed), p_saturation * clamp((1.0 - uv.y) * 2.0, 0.0, 1.0), p_value * clamp(uv.y * 2.0, 0.0, 1.0));
    return vec4(hsv2rgb(hsv), 1.0);
  }
  vec2 p = centered(uv);
  float r = length(p);
  float hue = fract(atan(p.y, p.x) / TAU + uTime * p_speed);
  float sat = p_style == 1 ? p_saturation * clamp(r / 0.45, 0.0, 1.0) : p_saturation;
  float m = p_style == 1 ? edge(r - 0.45, 0.0) : edge(abs(r - 0.365) - 0.085, 0.0);
  return paint(p_background, vec4(hsv2rgb(vec3(hue, sat, p_value)), 1.0), m);
}
`),
]);

const BY_ID = new Map(SOURCES.map(definition => [definition.id, definition]));

export function sourceDefinition(id) {
  return BY_ID.get(id) || null;
}