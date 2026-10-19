// Effects from the Resolume manual's effect list (Appendix 3) that the main
// catalog did not have. Most follow the shader-template contract; Stop Motion,
// Delay RGB and Freeze need real frame history, so they are built-in ISF
// shaders with persistent buffers (see isf.js / isf-runtime.js).

const num = (key, label, min, max, value) => ({ key, label, type: 'float', min, max, default: value });
const int = (key, label, min, max, value) => ({ key, label, type: 'int', min, max, default: value, step: 1 });
const bool = (key, label, value) => ({ key, label, type: 'bool', default: value });
const choice = (key, label, options, value = 0) => ({ key, label, type: 'choice', options, default: value });
const color = (key, label, value) => ({ key, label, type: 'color', default: value });
const point = (key, label, value = [0.5, 0.5]) => ({ key, label, type: 'point', min: 0, max: 1, default: value });
const def = (id, name, category, params, glsl, extra = {}) => ({ id, name, category, params, glsl, ...extra });

const QUAD = `
float side(vec2 a, vec2 b, vec2 p) { return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x); }
float inTriangle(vec2 p, vec2 a, vec2 b, vec2 c) {
  float d1 = side(a, b, p), d2 = side(b, c, p), d3 = side(c, a, p);
  bool negative = d1 < 0.0 || d2 < 0.0 || d3 < 0.0, positive = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
  return negative && positive ? 0.0 : 1.0;
}
float inQuad(vec2 p) { return max(inTriangle(p, p_topLeft, p_topRight, p_bottomRight), inTriangle(p, p_topLeft, p_bottomRight, p_bottomLeft)); }
`;
const CORNERS = [point('topLeft', 'Top left', [0.1, 0.9]), point('topRight', 'Top right', [0.9, 0.9]), point('bottomRight', 'Bottom right', [0.9, 0.1]), point('bottomLeft', 'Bottom left', [0.1, 0.1])];
const ROTATE = `
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
`;

export const MANUAL_EFFECTS = [
  def('cube-tiles', 'Cube Tiles', 'Mirror & Tile', [int('tiles', 'Tiles', 1, 8, 1), num('zoom', 'Zoom', 0.4, 3, 1.4), num('rotX', 'Rotate X', -180, 180, 25), num('rotY', 'Rotate Y', -180, 180, 35), num('rotZ', 'Rotate Z', -180, 180, 0), num('spin', 'Spin (turns/bar)', -2, 2, 0.25)], `${ROTATE}
vec4 fx(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  mat3 r = rotX(radians(p_rotX)) * rotY(radians(p_rotY) + uBeat * 0.25 * p_spin * TAU) * rotZ(radians(p_rotZ));
  vec3 o = transpose(r) * vec3(0.0, 0.0, -3.4 / p_zoom), d = transpose(r) * normalize(vec3(p, 1.4));
  vec3 inv = 1.0 / d, t0 = (-1.0 - o) * inv, t1 = (1.0 - o) * inv, lo = min(t0, t1), hi = max(t0, t1);
  float tn = max(max(lo.x, lo.y), lo.z), tf = min(min(hi.x, hi.y), hi.z);
  if (tn > tf || tf < 0.0) return vec4(0.0);
  vec3 h = o + d * tn, a = abs(h), n;
  vec2 f;
  if (a.x > a.y && a.x > a.z) { f = vec2(h.z * sign(h.x), h.y); n = vec3(sign(h.x), 0.0, 0.0); }
  else if (a.y > a.z) { f = vec2(h.x, h.z * sign(h.y)); n = vec3(0.0, sign(h.y), 0.0); }
  else { f = vec2(-h.x * sign(h.z), h.y); n = vec3(0.0, 0.0, sign(h.z)); }
  vec4 c = src(fract((f * 0.5 + 0.5) * float(p_tiles)));
  float shade = 0.5 + 0.5 * abs(dot(r * n, normalize(vec3(0.3, 0.5, -1.0))));
  return vec4(c.rgb * shade, c.a);
}`),
  def('drop-shadow', 'Drop Shadow', 'Stylize', [num('distance', 'Distance', 0, 0.2, 0.03), num('angle', 'Angle', -180, 180, -45), num('blur', 'Blur', 0, 0.06, 0.012), color('color', 'Colour', '#000000ff'), num('opacity', 'Opacity', 0, 1, 0.75)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec2 aspect = vec2(1.0 / uAspect, 1.0);
  vec2 offset = vec2(cos(radians(p_angle)), sin(radians(p_angle))) * p_distance * aspect;
  float a = 0.0, w = 0.0;
  for (int j = -3; j <= 3; j++) for (int i = -3; i <= 3; i++) {
    float k = exp(-float(i * i + j * j) / 8.0);
    a += src(uv - offset + vec2(float(i), float(j)) * p_blur / 3.0 * aspect).a * k;
    w += k;
  }
  a = a / w * p_opacity * p_color.a;
  float alpha = c.a + a * (1.0 - c.a);
  return alpha > 0.0 ? vec4((c.rgb * c.a + p_color.rgb * a * (1.0 - c.a)) / alpha, alpha) : vec4(0.0);
}`),
  def('heat', 'Heat', 'Color', [num('amount', 'Amount', 0, 1, 1), num('offset', 'Offset', 0, 1, 0), num('cycle', 'Cycle speed', -2, 2, 0)], `
vec3 thermal(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.2) return mix(vec3(0.0), vec3(0.0, 0.0, 0.6), t / 0.2);
  if (t < 0.4) return mix(vec3(0.0, 0.0, 0.6), vec3(0.75, 0.0, 0.75), (t - 0.2) / 0.2);
  if (t < 0.6) return mix(vec3(0.75, 0.0, 0.75), vec3(1.0, 0.15, 0.0), (t - 0.4) / 0.2);
  if (t < 0.8) return mix(vec3(1.0, 0.15, 0.0), vec3(1.0, 0.9, 0.0), (t - 0.6) / 0.2);
  return mix(vec3(1.0, 0.9, 0.0), vec3(1.0), (t - 0.8) / 0.2);
}
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float t = luma(c.rgb) + p_offset + uTime * p_cycle * 0.1;
  if (t > 1.0) t = fract(t);
  return vec4(mix(c.rgb, thermal(t), p_amount), c.a);
}`),
  def('keystone-crop', 'Keystone Crop', 'Keying', [...CORNERS, bool('invert', 'Invert', false)], `${QUAD}
vec4 fx(vec2 uv) {
  float inside = inQuad(uv);
  vec4 c = src(uv);
  return vec4(c.rgb, c.a * (p_invert ? 1.0 - inside : inside));
}`),
  def('keystone-mask', 'Keystone Mask', 'Keying', [...CORNERS], `${QUAD}
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  return vec4(c.rgb, c.a * (1.0 - inQuad(uv)));
}`),
  def('luma-waves', 'Luma Waves', 'Stylize', [int('lines', 'Lines', 8, 160, 48), num('height', 'Height', 0, 0.6, 0.18), num('thickness', 'Thickness (px)', 0.5, 6, 1.5), choice('colour', 'Colour', ['Video', 'Luma', 'White'])], `
vec4 fx(vec2 uv) {
  float n = float(p_lines), px = p_thickness / uResolution.y;
  vec4 outColor = vec4(0.0);
  int top = int(floor((uv.y + px) * n));
  // Far lines (higher on screen) first; nearer lines hide what is behind them.
  for (int k = 0; k < 128; k++) {
    int i = top - k;
    if (i < 0) break;
    float base = (float(i) + 0.5) / n;
    if (base + p_height + px < uv.y) break;
    vec4 s = src(vec2(uv.x, base));
    float l = luma(s.rgb) * s.a;
    float y = base + l * p_height;
    if (uv.y < y && uv.y > base - 0.5 / n) outColor = vec4(0.0);
    float a = clamp(1.0 - abs(uv.y - y) / px, 0.0, 1.0);
    vec3 line = p_colour == 0 ? s.rgb : p_colour == 1 ? vec3(l) : vec3(1.0);
    if (a > 0.0) outColor = vec4(mix(outColor.rgb, line, a), max(outColor.a, a));
  }
  return outColor;
}`),
  def('particles-fx', 'Particles', 'Stylize', [int('count', 'Grid', 8, 160, 48), num('density', 'Density', 0, 1, 0.6), num('speed', 'Speed', -2, 2, 0.3), num('size', 'Size', 0.2, 2, 1), num('direction', 'Direction', -180, 180, 90), num('wobble', 'Wobble', 0, 1, 0.5), num('background', 'Background', 0, 1, 0)], `
vec4 fx(vec2 uv) {
  float n = float(p_count);
  vec2 aspect = vec2(uAspect, 1.0), dir = vec2(cos(radians(p_direction)), sin(radians(p_direction)));
  vec2 drift = dir * uTime * p_speed * n * 0.25;
  vec2 q = uv * aspect * n - drift;
  vec2 cell = floor(q);
  vec4 particles = vec4(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(float(i), float(j));
    float h = hash12(c);
    if (h > p_density) continue;
    vec2 center = c + vec2(hash12(c + 17.3), hash12(c + 41.7)) + p_wobble * 0.3 * vec2(sin(uTime * 1.3 + h * TAU), cos(uTime * 1.7 + h * TAU));
    float radius = 0.35 * p_size * (0.5 + h);
    float a = smoothstep(radius, radius * 0.55, length(q - center));
    if (a <= 0.0) continue;
    vec4 s = src(fract((center + drift) / n / aspect));
    particles = vec4(mix(particles.rgb, s.rgb, a), max(particles.a, a * s.a));
  }
  vec4 bg = src(uv);
  bg.a *= p_background;
  return vec4(mix(bg.rgb, particles.rgb, particles.a), particles.a + bg.a * (1.0 - particles.a));
}`),
  def('pixel-high-pass', 'Pixel High Pass', 'Blur & Sharpen', [num('red', 'Red', 0, 1, 1), num('green', 'Green', 0, 1, 1), num('blue', 'Blue', 0, 1, 1), num('radius', 'Radius', 0.5, 8, 2), num('gain', 'Gain', 0.5, 8, 2)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec2 d = p_radius / uResolution;
  vec3 blurred = vec3(0.0);
  float w = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    float k = exp(-float(i * i + j * j) / 4.0);
    blurred += src(uv + vec2(float(i), float(j)) * d).rgb * k;
    w += k;
  }
  vec3 highPass = clamp(0.5 + (c.rgb - blurred / w) * p_gain, 0.0, 1.0);
  return vec4(mix(c.rgb, highPass, vec3(p_red, p_green, p_blue)), c.a);
}`),  def('pixels-in-space', 'Pixels In Space', 'Stylize', [int('resolution', 'Resolution', 8, 128, 40), num('height', 'Height', 0, 0.5, 0.15), num('gap', 'Gap', 0, 0.4, 0.08)], `
vec4 fx(vec2 uv) {
  float n = float(p_resolution);
  vec2 cells = vec2(max(1.0, floor(n * uAspect)), n);
  float column = floor(uv.x * cells.x), across = fract(uv.x * cells.x), cell = 1.0 / cells.y;
  float edge = step(p_gap * 0.5, across) * step(across, 1.0 - p_gap * 0.5);
  vec4 outColor = vec4(0.0);
  int top = int(floor(uv.y * cells.y));
  // Far rows first; nearer blocks are extruded up over them.
  for (int k = 0; k < 128; k++) {
    int row = top - k;
    if (row < 0) break;
    float base = float(row) * cell;
    if (base + cell + p_height < uv.y) break;
    vec4 s = src(vec2((column + 0.5) / cells.x, (float(row) + 0.5) * cell));
    float h = luma(s.rgb) * s.a * p_height;
    if (edge > 0.0 && uv.y >= base && uv.y <= base + h + cell * (1.0 - p_gap)) {
      float face = uv.y >= base + h ? 1.0 : 0.55;
      outColor = vec4(s.rgb * face, 1.0);
    }
  }
  return outColor;
}`),
  def('recolour', 'Recolour', 'Color', [choice('palette', 'Palette', ['Rainbow', 'Fire', 'Ice', 'Toxic', 'Sunset', 'Ocean', 'Neon', 'Gold']), num('floor', 'Floor', 0, 1, 0), num('ceiling', 'Ceiling', 0, 1, 1), num('cycle', 'Cycle speed', -2, 2, 0), num('amount', 'Amount', 0, 1, 1)], `
vec3 cosine(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d)); }
vec3 palette(float t) {
  if (p_palette == 0) return cosine(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.33, 0.67));
  if (p_palette == 1) return clamp(vec3(t * 3.0, t * 3.0 - 1.0, t * 3.0 - 2.0), 0.0, 1.0);
  if (p_palette == 2) return clamp(vec3(t * t, t, t * 1.5 + 0.2), 0.0, 1.0);
  if (p_palette == 3) return cosine(t, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 0.5), vec3(0.8, 0.9, 0.3));
  if (p_palette == 4) return cosine(t, vec3(0.5), vec3(0.5), vec3(1.0, 0.7, 0.4), vec3(0.0, 0.15, 0.2));
  if (p_palette == 5) return cosine(t, vec3(0.1, 0.35, 0.55), vec3(0.1, 0.3, 0.4), vec3(1.0), vec3(0.0, 0.1, 0.2));
  if (p_palette == 6) return cosine(t, vec3(0.5), vec3(0.5), vec3(2.0, 1.0, 0.0), vec3(0.5, 0.2, 0.25));
  return clamp(mix(vec3(0.15, 0.08, 0.0), vec3(1.0, 0.8, 0.3), t) + vec3(smoothstep(0.8, 1.0, t)) * 0.4, 0.0, 1.0);
}
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float t = clamp((luma(c.rgb) - p_floor) / max(0.001, p_ceiling - p_floor), 0.0, 1.0);
  t = fract(t * 0.999 + uTime * p_cycle * 0.1);
  return vec4(mix(c.rgb, palette(t), p_amount), c.a);
}`),
  def('snow', 'Snow', 'Stylize', [num('amount', 'Amount', 0, 1, 0.6), num('speed', 'Speed', 0, 2, 0.4), num('size', 'Flake size', 0.2, 3, 1), num('wind', 'Wind', -1, 1, 0.1), num('background', 'Background', 0, 1, 0.25), bool('textured', 'Textured', true)], `
vec4 fx(vec2 uv) {
  vec4 under = src(uv);
  vec3 color = under.rgb;
  float alpha = under.a * p_background;
  for (int layer = 0; layer < 3; layer++) {
    float scale = 18.0 + float(layer) * 14.0, depth = 1.0 - float(layer) * 0.25;
    vec2 q = uv * vec2(uAspect, 1.0) * scale + vec2(-p_wind, 1.0) * uTime * p_speed * scale * 0.15 * depth;
    vec2 cell = floor(q), f = fract(q) - 0.5;
    float h = hash12(cell + float(layer) * 31.7);
    if (h > p_amount) continue;
    vec2 offset = (vec2(hash12(cell + 7.1), hash12(cell + 3.3)) - 0.5) * 0.6;
    offset.x += sin(uTime * 1.5 + h * TAU) * 0.15;
    float radius = 0.12 * p_size * depth * (0.6 + 0.8 * fract(h * 13.0));
    float a = smoothstep(radius, radius * 0.4, length(f - offset));
    if (a <= 0.0) continue;
    vec3 flake = p_textured ? under.rgb : vec3(0.6 + 0.4 * luma(under.rgb));
    color = mix(alpha > 0.0 ? color : flake, flake, a);
    alpha = max(alpha, a);
  }
  return vec4(color, alpha);
}`),
  def('static', 'Static', 'Glitch', [num('amount', 'Amount', 0, 1, 0.5), choice('mode', 'Mode', ['Mix', 'Add', 'Multiply', 'Replace']), bool('colour', 'Colour', false), num('grain', 'Grain size', 1, 8, 1), num('speed', 'Speed', 0, 2, 1)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec2 g = floor(uv * uResolution / p_grain);
  float t = floor(uTime * 60.0 * p_speed);
  float n = hash12(g + t * 17.31);
  vec3 noise = p_colour ? vec3(n, hash12(g + t * 7.7 + 3.1), hash12(g + t * 3.3 + 9.2)) : vec3(n);
  noise *= 0.88 + 0.12 * sin((uv.y + uTime * 0.3 * p_speed) * TAU * 2.0);
  vec3 o;
  if (p_mode == 0) o = mix(c.rgb, noise, p_amount);
  else if (p_mode == 1) o = c.rgb + noise * p_amount;
  else if (p_mode == 2) o = c.rgb * mix(vec3(1.0), noise, p_amount);
  else o = noise;
  float a = p_mode == 3 ? 1.0 : p_mode == 0 ? max(c.a, p_amount) : c.a;
  return vec4(clamp(o, 0.0, 1.0), a);
}`),
  def('stripper', 'Stripper', 'Glitch', [choice('mode', 'Mode', ['Slide Horizontal', 'Slide Vertical', 'Alternate', 'Stretch', 'Shuffle']), int('strips', 'Strips', 2, 64, 12), num('amount', 'Amount', 0, 1, 0.5), num('speed', 'Speed (per bar)', -4, 4, 1)], `
vec4 fx(vec2 uv) {
  float n = float(p_strips), phase = uBeat * 0.25 * p_speed;
  vec2 q = uv;
  if (p_mode == 0 || p_mode == 2) {
    float row = floor(uv.y * n);
    float direction = p_mode == 2 ? (mod(row, 2.0) < 0.5 ? 1.0 : -1.0) : sin(row * 1.7 + 0.5);
    q.x = fract(uv.x + direction * p_amount * (p_mode == 2 ? fract(phase) : sin(phase * TAU + row * 0.9)));
  } else if (p_mode == 1) {
    float column = floor(uv.x * n);
    q.y = fract(uv.y + p_amount * sin(phase * TAU + column * 0.9));
  } else if (p_mode == 3) {
    float row = floor(uv.y * n);
    float scale = 1.0 + p_amount * sin(phase * TAU + row * 0.7);
    q.x = (uv.x - 0.5) / scale + 0.5;
    if (q.x < 0.0 || q.x > 1.0) return vec4(0.0);
  } else {
    float row = floor(uv.y * n);
    float shuffled = floor(hash12(vec2(row, floor(phase * 4.0))) * n);
    q.y = mix(uv.y, (shuffled + fract(uv.y * n)) / n, step(1.0 - p_amount, hash12(vec2(row + 3.0, floor(phase * 4.0)))));
  }
  return src(q);
}`),
  def('suckr', 'Suckr', 'Distort', [num('amount', 'Amount', 0, 1, 0.5), point('center', 'Center'), num('radius', 'Radius', 0.1, 1.5, 0.7), num('swirl', 'Swirl', -1, 1, 0.2), num('speed', 'Pulse speed', 0, 2, 0.5)], `
vec4 fx(vec2 uv) {
  vec2 aspect = vec2(uAspect, 1.0), p = (uv - p_center) * aspect;
  float r = length(p), k = smoothstep(p_radius, 0.0, r);
  float pull = p_amount * k * (0.75 + 0.25 * sin(uTime * p_speed * TAU));
  float angle = atan(p.y, p.x) + p_swirl * k * 3.0;
  vec2 q = vec2(cos(angle), sin(angle)) * r * (1.0 + pull * 2.0) / aspect + p_center;
  return q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0 ? vec4(0.0) : src(q);
}`),
  def('videowall', 'Videowall', 'Mirror & Tile', [int('columns', 'Columns', 1, 16, 4), int('rows', 'Rows', 1, 16, 3), num('bezel', 'Bezel', 0, 0.08, 0.012), color('bezelColor', 'Bezel colour', '#0d0d0dff'), choice('mode', 'Content', ['Span', 'Repeat']), num('variation', 'Screen variation', 0, 0.5, 0.08), bool('scanlines', 'Scanlines', false)], `
vec4 fx(vec2 uv) {
  vec2 grid = vec2(float(p_columns), float(p_rows));
  vec2 g = uv * grid, cell = floor(g), f = fract(g);
  vec2 bezel = vec2(p_bezel * grid.x / uAspect, p_bezel * grid.y);
  if (any(lessThan(f, bezel)) || any(greaterThan(f, 1.0 - bezel))) return p_bezelColor;
  vec2 inner = (f - bezel) / max(vec2(0.001), 1.0 - 2.0 * bezel);
  vec4 c = src(p_mode == 0 ? (cell + inner) / grid : inner);
  c.rgb *= 1.0 + (hash12(cell + 0.5) - 0.5) * 2.0 * p_variation;
  if (p_scanlines) c.rgb *= 0.82 + 0.18 * sin(inner.y * uResolution.y / grid.y * PI);
  return vec4(clamp(c.rgb, 0.0, 1.0), c.a);
}`),
];

// Stop Motion, Delay RGB and Freeze keep whole earlier frames, so they are ISF
// shaders: persistent buffers hold the frames and FRAMEINDEX counts them.
const DELAY_TAPS = [1, 2, 3, 4, 5, 6];
export const MANUAL_ISF_EFFECTS = [
  { id: 'stop-motion', name: 'Stop Motion', text: `/*{
  "DESCRIPTION": "Holds each grabbed frame for a number of frames, for a stuttered stop-motion look.",
  "CATEGORIES": ["Time & Feedback"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "hold", "LABEL": "Hold (frames)", "TYPE": "float", "MIN": 1.0, "MAX": 30.0, "DEFAULT": 4.0 }
  ],
  "PASSES": [{ "TARGET": "held", "PERSISTENT": true }, {}]
}*/
void main() {
  if (PASSINDEX == 0) {
    bool grab = int(mod(float(FRAMEINDEX), floor(hold))) == 0;
    gl_FragColor = grab ? IMG_THIS_PIXEL(inputImage) : IMG_THIS_PIXEL(held);
  } else gl_FragColor = IMG_THIS_PIXEL(held);
}` },
  { id: 'delay-rgb', name: 'Delay RGB', text: `/*{
  "DESCRIPTION": "Delays the red, green and blue channels separately by up to six frames.",
  "CATEGORIES": ["Time & Feedback"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "red", "LABEL": "Red delay", "TYPE": "float", "MIN": 0.0, "MAX": 6.0, "DEFAULT": 0.0 },
    { "NAME": "green", "LABEL": "Green delay", "TYPE": "float", "MIN": 0.0, "MAX": 6.0, "DEFAULT": 2.0 },
    { "NAME": "blue", "LABEL": "Blue delay", "TYPE": "float", "MIN": 0.0, "MAX": 6.0, "DEFAULT": 4.0 }
  ],
  "PASSES": [{ "TARGET": "mixed" }, ${DELAY_TAPS.slice(1).reverse().map(tap => `{ "TARGET": "d${tap}", "PERSISTENT": true }`).join(', ')}, { "TARGET": "d1", "PERSISTENT": true }, {}]
}*/
vec4 frameAt(float delay) {
  int k = int(floor(delay + 0.5));
  if (k <= 0) return IMG_THIS_PIXEL(inputImage);
${DELAY_TAPS.slice(0, -1).map(tap => `  if (k == ${tap}) return IMG_THIS_PIXEL(d${tap});`).join('\n')}
  return IMG_THIS_PIXEL(d6);
}
void main() {
  // Pass 0 mixes from the stored frames, passes 1-5 shift the history one
  // frame older, pass 6 stores this frame, the last pass shows the mix.
  if (PASSINDEX == 0) {
    vec4 r = frameAt(red), g = frameAt(green), b = frameAt(blue);
    gl_FragColor = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
  }
${DELAY_TAPS.slice(1).reverse().map((tap, index) => `  else if (PASSINDEX == ${index + 1}) gl_FragColor = IMG_THIS_PIXEL(d${tap - 1});`).join('\n')}
  else if (PASSINDEX == 6) gl_FragColor = IMG_THIS_PIXEL(inputImage);
  else gl_FragColor = IMG_THIS_PIXEL(mixed);
}` },
  { id: 'freeze', name: 'Freeze', text: `/*{
  "DESCRIPTION": "Freezes the whole frame (Frozen Solid) or the area left of X and above Y.",
  "CATEGORIES": ["Time & Feedback"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "solid", "LABEL": "Frozen Solid", "TYPE": "bool", "DEFAULT": false },
    { "NAME": "areaX", "LABEL": "X", "TYPE": "float", "MIN": 0.0, "MAX": 1.0, "DEFAULT": 0.5 },
    { "NAME": "areaY", "LABEL": "Y", "TYPE": "float", "MIN": 0.0, "MAX": 1.0, "DEFAULT": 0.0 }
  ],
  "PASSES": [{ "TARGET": "frozen", "PERSISTENT": true }, {}]
}*/
void main() {
  if (PASSINDEX == 0) {
    vec2 p = isf_FragNormCoord;
    bool hold = solid || p.x < areaX || p.y > 1.0 - areaY;
    // Frame 0 has nothing stored yet, so it always takes the live frame.
    gl_FragColor = hold && FRAMEINDEX > 0 ? IMG_THIS_PIXEL(frozen) : IMG_THIS_PIXEL(inputImage);
  } else gl_FragColor = IMG_THIS_PIXEL(frozen);
}` },
];