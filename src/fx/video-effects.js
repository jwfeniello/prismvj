// Built-in video effect catalog, modelled on Resolume's effect list. Every
// entry follows the contract in shader-template.js. Legacy entries keep the
// ids and single-amount behaviour of the original engine effects so saved
// projects keep rendering the same.

import { MANUAL_EFFECTS } from './manual-effects.js';

const num = (key, label, min, max, value) => ({ key, label, type: 'float', min, max, default: value });
const int = (key, label, min, max, value) => ({ key, label, type: 'int', min, max, default: value, step: 1 });
const bool = (key, label, value) => ({ key, label, type: 'bool', default: value });
const choice = (key, label, options, value = 0) => ({ key, label, type: 'choice', options, default: value });
const color = (key, label, value) => ({ key, label, type: 'color', default: value });
const point = (key, label, value = [0.5, 0.5]) => ({ key, label, type: 'point', min: 0, max: 1, default: value });

const RATES = ['4 Bars', '2 Bars', '1 Bar', '1/2', '1/4', '1/8', '1/16'];
// BPM-synced timing: Beat Rate picks a note length, Free Speed is in Hz.
const sync = (rate = 4, speed = 4) => [choice('sync', 'Sync', ['BPM', 'Free']), choice('rate', 'Beat Rate', RATES, rate), num('speed', 'Free Speed (Hz)', 0, 30, speed)];

const def = (id, name, category, params, glsl, extra = {}) => ({ id, name, category, params, glsl, ...extra });
const multi = (id, name, category, params, passes, extra = {}) => def(id, name, category, params, passes[0], { passes, ...extra });

// Shared GLSL snippets, interpolated into bodies that need them.
const CENTER = `
vec2 toCentered(vec2 p) { return (p - 0.5) * vec2(uAspect, 1.0); }
vec2 fromCentered(vec2 p) { return p / vec2(uAspect, 1.0) + 0.5; }
`;
const EDGE = `
float inBounds(vec2 p) { return step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0); }
vec4 srcClip(vec2 p) { return src(p) * inBounds(p); }
vec2 mirrorRepeat(vec2 p) { return 1.0 - abs(1.0 - mod(p, 2.0)); }
`;
const SYNC = `
float beatLength(int rate) { return 16.0 / exp2(float(rate)); }
float syncPhase() { return p_sync == 0 ? uBeat / beatLength(p_rate) : uTime * p_speed; }
`;
const PREMUL = `
vec4 premul(vec4 c) { return vec4(c.rgb * c.a, c.a); }
vec4 over(vec4 top, vec4 bottom) { return top + bottom * (1.0 - top.a); }
`;
const SOBEL = `
vec3 tap(vec2 p) { vec4 c = src(p); return c.rgb * c.a; }
void sobel(vec2 uv, vec2 d, out vec3 gx, out vec3 gy) {
  vec3 tl = tap(uv + vec2(-d.x, d.y)), t = tap(uv + vec2(0.0, d.y)), tr = tap(uv + d);
  vec3 l = tap(uv - vec2(d.x, 0.0)), r = tap(uv + vec2(d.x, 0.0));
  vec3 bl = tap(uv - d), b = tap(uv - vec2(0.0, d.y)), br = tap(uv + vec2(d.x, -d.y));
  gx = tr + 2.0 * r + br - tl - 2.0 * l - bl;
  gy = tl + 2.0 * t + tr - bl - 2.0 * b - br;
}
`;
// 13-tap separable gaussian (sigma = 3 taps) in premultiplied space.
const gaussian = dir => `
vec4 fx(vec2 uv) {
  vec2 stepUv = ${dir} * (p_radius / 6.0) / uResolution;
  vec4 acc = vec4(0.0);
  float total = 0.0;
  for (int i = -6; i <= 6; i++) {
    float w = exp(-float(i * i) / 18.0);
    vec4 c = src(uv + stepUv * float(i));
    acc += vec4(c.rgb * c.a, c.a) * w;
    total += w;
  }
  return acc.a > 0.00001 ? vec4(acc.rgb / acc.a, acc.a / total) : vec4(0.0);
}`;

const COLOR = [
  def('add-subtract', 'Add Subtract', 'Color', [choice('mode', 'Mode', ['Add', 'Subtract']), color('color', 'Color', '#3366ff'), num('amount', 'Amount', 0, 1, 0.3)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec3 d = p_color.rgb * p_amount;
  c.rgb = p_mode == 0 ? c.rgb + d : c.rgb - d;
  return c;
}`),
  def('black-white', 'Black & White', 'Color', [choice('mode', 'Mode', ['Luminance', 'Average', 'Brightest']), num('contrast', 'Contrast', 0, 3, 1.2), num('brightness', 'Brightness', -1, 1, 0)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float g = p_mode == 0 ? luma(c.rgb) : p_mode == 1 ? dot(c.rgb, vec3(1.0 / 3.0)) : max(c.r, max(c.g, c.b));
  g = (g - 0.5) * p_contrast + 0.5 + p_brightness;
  return vec4(vec3(g), c.a);
}`),
  def('brightness-contrast', 'Brightness Contrast', 'Color', [num('brightness', 'Brightness', -1, 1, 0.05), num('contrast', 'Contrast', -1, 1, 0.25)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float k = p_contrast >= 0.0 ? 1.0 / max(1.0 - p_contrast, 0.01) : 1.0 + p_contrast;
  c.rgb = (c.rgb + p_brightness - 0.5) * k + 0.5;
  return c;
}`),
  def('color-balance', 'Color Balance', 'Color', [color('shadows', 'Shadows', '#6878a0'), color('midtones', 'Midtones', '#808080'), color('highlights', 'Highlights', '#a08868'), num('strength', 'Strength', 0, 2, 1), bool('preserve', 'Preserve Luminosity', true)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float l = luma(c.rgb);
  float sh = 1.0 - smoothstep(0.0, 0.5, l), hi = smoothstep(0.5, 1.0, l), mi = 1.0 - sh - hi;
  vec3 shift = (p_shadows.rgb - 0.5) * sh + (p_midtones.rgb - 0.5) * mi + (p_highlights.rgb - 0.5) * hi;
  c.rgb += shift * p_strength;
  if (p_preserve) c.rgb += l - luma(c.rgb);
  return c;
}`),
  def('colorize', 'Colorize', 'Color', [num('hue', 'Hue', 0, 1, 0.58), num('saturation', 'Saturation', 0, 1, 0.75), num('lightness', 'Lightness', -1, 1, 0)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float l = clamp(luma(c.rgb) + p_lightness, 0.0, 1.0);
  vec3 tint = hsv2rgb(vec3(p_hue, p_saturation, 1.0));
  c.rgb = l < 0.5 ? 2.0 * l * tint : 1.0 - 2.0 * (1.0 - l) * (1.0 - tint);
  return c;
}`),
  def('color-pass', 'Color Pass', 'Color', [num('hue', 'Hue', 0, 1, 0), num('range', 'Range', 0, 0.5, 0.08), num('softness', 'Softness', 0, 0.5, 0.06), bool('invert', 'Invert', false)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec3 hsv = rgb2hsv(c.rgb);
  float d = abs(fract(hsv.x - p_hue + 0.5) - 0.5);
  float keep = (1.0 - smoothstep(p_range, p_range + p_softness + 0.0001, d)) * smoothstep(0.05, 0.2, hsv.y);
  if (p_invert) keep = 1.0 - keep;
  c.rgb = mix(vec3(luma(c.rgb)), c.rgb, keep);
  return c;
}`),
  def('channel-swap', 'Channel Swap', 'Color', [
    choice('red', 'Red From', ['Red', 'Green', 'Blue', 'Luma', 'Zero', 'One'], 2),
    choice('green', 'Green From', ['Red', 'Green', 'Blue', 'Luma', 'Zero', 'One'], 0),
    choice('blue', 'Blue From', ['Red', 'Green', 'Blue', 'Luma', 'Zero', 'One'], 1),
  ], `
float pick(vec3 c, int i) { return i == 0 ? c.r : i == 1 ? c.g : i == 2 ? c.b : i == 3 ? luma(c) : i == 4 ? 0.0 : 1.0; }
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  return vec4(pick(c.rgb, p_red), pick(c.rgb, p_green), pick(c.rgb, p_blue), c.a);
}`),
  def('duotone', 'Duotone', 'Color', [color('shadow', 'Shadow Color', '#1d0b52'), color('highlight', 'Highlight Color', '#ff8a3d'), num('contrast', 'Contrast', 0, 3, 1)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float l = clamp((luma(c.rgb) - 0.5) * p_contrast + 0.5, 0.0, 1.0);
  c.rgb = mix(p_shadow.rgb, p_highlight.rgb, l);
  return c;
}`),
  def('exposure', 'Exposure', 'Color', [num('exposure', 'Exposure (stops)', -4, 4, 0.5), num('offset', 'Offset', -0.5, 0.5, 0), num('gamma', 'Gamma', 0.1, 4, 1)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  c.rgb = pow(max(c.rgb * exp2(p_exposure) + p_offset, 0.0), vec3(1.0 / p_gamma));
  return c;
}`),
  def('fill-color', 'Fill Color', 'Color', [color('color', 'Color', '#ff2266'), choice('mode', 'Mode', ['Solid', 'Multiply', 'Screen', 'Tint'])], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec3 f = p_color.rgb;
  if (p_mode == 0) c.rgb = f;
  else if (p_mode == 1) c.rgb *= f;
  else if (p_mode == 2) c.rgb = 1.0 - (1.0 - c.rgb) * (1.0 - f);
  else c.rgb = f * luma(c.rgb) / max(luma(f), 0.05);
  c.a *= p_color.a;
  return c;
}`),
  def('gradient-map', 'Gradient Map', 'Color', [color('color1', 'Dark', '#08001f'), color('color2', 'Mid', '#d4145a'), color('color3', 'Light', '#fbb03b'), num('offset', 'Offset', 0, 1, 0), num('repeat', 'Repeat', 1, 8, 1), num('speed', 'Cycle Speed', -2, 2, 0)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float tt = luma(c.rgb) * p_repeat + p_offset + uTime * p_speed;
  float t = 1.0 - abs(1.0 - 2.0 * fract(tt * 0.5));
  c.rgb = t < 0.5 ? mix(p_color1.rgb, p_color2.rgb, t * 2.0) : mix(p_color2.rgb, p_color3.rgb, t * 2.0 - 1.0);
  return c;
}`),
  def('hue-rotate', 'Hue Rotate', 'Color', [num('hue', 'Hue', 0, 1, 0.25), num('speed', 'Cycle Speed', -2, 2, 0)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec3 hsv = rgb2hsv(c.rgb);
  hsv.x = fract(hsv.x + p_hue + uTime * p_speed);
  c.rgb = hsv2rgb(hsv);
  return c;
}`),
  def('invert-rgb', 'Invert RGB', 'Color', [bool('red', 'Red', true), bool('green', 'Green', true), bool('blue', 'Blue', true)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec3 m = vec3(p_red ? 1.0 : 0.0, p_green ? 1.0 : 0.0, p_blue ? 1.0 : 0.0);
  c.rgb = mix(c.rgb, 1.0 - c.rgb, m);
  return c;
}`),
  def('levels', 'Levels', 'Color', [num('inBlack', 'Input Black', 0, 1, 0.06), num('inWhite', 'Input White', 0, 1, 0.94), num('gamma', 'Gamma', 0.1, 4, 1.1), num('outBlack', 'Output Black', 0, 1, 0), num('outWhite', 'Output White', 0, 1, 1)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec3 t = clamp((c.rgb - p_inBlack) / max(p_inWhite - p_inBlack, 0.001), 0.0, 1.0);
  t = pow(t, vec3(1.0 / p_gamma));
  c.rgb = mix(vec3(p_outBlack), vec3(p_outWhite), t);
  return c;
}`),
  def('posterize', 'Posterize', 'Color', [int('levels', 'Levels', 2, 32, 5), num('gamma', 'Gamma', 0.25, 4, 1)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float n = float(p_levels) - 1.0;
  vec3 g = pow(max(c.rgb, 0.0), vec3(p_gamma));
  c.rgb = pow(floor(g * n + 0.5) / n, vec3(1.0 / p_gamma));
  return c;
}`),
  def('saturation-fx', 'Saturation', 'Color', [num('saturation', 'Saturation', 0, 3, 1.5), num('vibrance', 'Vibrance', -1, 1, 0)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  c.rgb = mix(vec3(luma(c.rgb)), c.rgb, p_saturation);
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c.rgb = mix(vec3(luma(c.rgb)), c.rgb, 1.0 + p_vibrance * (1.0 - clamp(sat, 0.0, 1.0)));
  return c;
}`),
  def('sepia', 'Sepia', 'Color', [num('contrast', 'Contrast', 0, 2, 1.1), num('brightness', 'Brightness', -0.5, 0.5, 0)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec3 s = vec3(dot(c.rgb, vec3(0.393, 0.769, 0.189)), dot(c.rgb, vec3(0.349, 0.686, 0.168)), dot(c.rgb, vec3(0.272, 0.534, 0.131)));
  c.rgb = (s - 0.5) * p_contrast + 0.5 + p_brightness;
  return c;
}`),
  def('solarize', 'Solarize', 'Color', [num('threshold', 'Threshold', 0, 1, 0.5), choice('mode', 'Mode', ['Hard', 'Smooth'])], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec3 k = p_mode == 0 ? step(vec3(p_threshold), c.rgb) : smoothstep(vec3(p_threshold - 0.15), vec3(p_threshold + 0.15), c.rgb);
  c.rgb = mix(c.rgb, 1.0 - c.rgb, k);
  return c;
}`),
  def('threshold', 'Threshold', 'Color', [num('threshold', 'Threshold', 0, 1, 0.5), num('softness', 'Softness', 0, 0.5, 0), color('low', 'Low Color', '#000000'), color('high', 'High Color', '#ffffff')], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float l = luma(c.rgb);
  float t = p_softness > 0.0 ? smoothstep(p_threshold - p_softness, p_threshold + p_softness, l) : step(p_threshold, l);
  c.rgb = mix(p_low.rgb, p_high.rgb, t);
  return c;
}`),
];
const KEYING = [
  def('auto-mask', 'Auto Mask', 'Keying', [choice('source', 'Source', ['Luma', 'Red', 'Green', 'Blue', 'Max']), num('gain', 'Gain', 0, 4, 1.5), bool('invert', 'Invert', false)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float v = p_source == 0 ? luma(c.rgb) : p_source == 1 ? c.r : p_source == 2 ? c.g : p_source == 3 ? c.b : max(c.r, max(c.g, c.b));
  v = clamp(v * p_gain, 0.0, 1.0);
  c.a *= p_invert ? 1.0 - v : v;
  return c;
}`),
  def('chroma-key', 'Chroma Key', 'Keying', [color('color', 'Key Color', '#00ff00'), num('tolerance', 'Tolerance', 0, 1, 0.3), num('softness', 'Softness', 0, 1, 0.1), num('spill', 'Spill Suppression', 0, 1, 0.5)], `
vec2 chroma(vec3 c) { return vec2(dot(c, vec3(-0.1146, -0.3854, 0.5)), dot(c, vec3(0.5, -0.4542, -0.0458))); }
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float d = distance(chroma(c.rgb), chroma(p_color.rgb));
  float edge = p_tolerance * 0.5;
  float a = smoothstep(edge, edge + p_softness * 0.5 + 0.001, d);
  float spill = p_spill * (1.0 - smoothstep(edge, edge + p_softness * 0.5 + 0.25, d));
  c.rgb = mix(c.rgb, vec3(luma(c.rgb)), spill);
  c.a *= a;
  return c;
}`),
  def('luma-key', 'Luma Key', 'Keying', [num('threshold', 'Threshold', 0, 1, 0.25), num('softness', 'Softness', 0, 1, 0.1), bool('invert', 'Invert', false)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float k = smoothstep(p_threshold, p_threshold + p_softness + 0.0001, luma(c.rgb));
  c.a *= p_invert ? 1.0 - k : k;
  return c;
}`),
  def('wipe-ellipse', 'Wipe Ellipse', 'Keying', [num('progress', 'Progress', 0, 1, 0.35), point('center', 'Center'), num('softness', 'Softness', 0, 0.5, 0.05), bool('invert', 'Invert', false)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float r = p_progress * length(vec2(uAspect, 1.0));
  float k = 1.0 - smoothstep(r - p_softness - 0.0001, r, length((uv - p_center) * vec2(uAspect, 1.0)));
  c.a *= p_invert ? 1.0 - k : k;
  return c;
}`),
  def('wipe-linear', 'Wipe Linear', 'Keying', [num('progress', 'Progress', 0, 1, 0.5), num('angle', 'Angle', 0, 360, 0), num('softness', 'Softness', 0, 0.5, 0.05), bool('invert', 'Invert', false)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float a = radians(p_angle);
  vec2 dir = vec2(cos(a), sin(a));
  float lo = min(0.0, dir.x) + min(0.0, dir.y), hi = max(0.0, dir.x) + max(0.0, dir.y);
  float t = (dot(uv, dir) - lo) / max(hi - lo, 0.0001);
  float e = p_progress * (1.0 + p_softness);
  float k = 1.0 - smoothstep(e - p_softness - 0.0001, e, t);
  c.a *= p_invert ? 1.0 - k : k;
  return c;
}`),
];

const BLUR = [
  multi('blur', 'Blur', 'Blur & Sharpen', [num('radius', 'Radius (px)', 0, 40, 6)], [gaussian('vec2(1.0, 0.0)'), gaussian('vec2(0.0, 1.0)')]),
  def('bokeh', 'Bokeh', 'Blur & Sharpen', [num('radius', 'Radius (px)', 0, 30, 8), num('highlights', 'Highlights', 0, 4, 2)], `
vec4 fx(vec2 uv) {
  vec4 acc = vec4(0.0);
  float total = 0.0;
  for (int i = 0; i < 25; i++) {
    float r = sqrt((float(i) + 0.5) / 25.0);
    float th = float(i) * 2.39996323;
    vec4 c = src(uv + vec2(cos(th), sin(th)) * r * p_radius / uResolution);
    float l = luma(c.rgb);
    float w = 1.0 + p_highlights * 4.0 * l * l * l * l;
    acc += vec4(c.rgb * c.a, c.a) * w;
    total += w;
  }
  return acc.a > 0.00001 ? vec4(acc.rgb / acc.a, acc.a / total) : vec4(0.0);
}`),
  multi('glow', 'Glow', 'Blur & Sharpen', [num('threshold', 'Threshold', 0, 1, 0.55), num('radius', 'Radius (px)', 0, 40, 12), num('intensity', 'Intensity', 0, 4, 1.2), color('tint', 'Tint', '#ffffff')], [`
vec4 fx(vec2 uv) {
  vec2 stepUv = vec2(p_radius / 6.0, 0.0) / uResolution;
  vec3 acc = vec3(0.0);
  float total = 0.0;
  for (int i = -6; i <= 6; i++) {
    float w = exp(-float(i * i) / 18.0);
    vec4 c = src(uv + stepUv * float(i));
    acc += c.rgb * c.a * smoothstep(p_threshold, p_threshold + 0.15, luma(c.rgb)) * w;
    total += w;
  }
  return vec4(acc / total, 1.0);
}`, `
vec4 fx(vec2 uv) {
  vec2 stepUv = vec2(0.0, p_radius / 6.0) / uResolution;
  vec3 acc = vec3(0.0);
  float total = 0.0;
  for (int i = -6; i <= 6; i++) {
    float w = exp(-float(i * i) / 18.0);
    acc += src(uv + stepUv * float(i)).rgb * w;
    total += w;
  }
  vec3 g = acc / total * p_intensity * p_tint.rgb;
  vec4 o = orig(uv);
  float a = clamp(max(o.a, max(g.r, max(g.g, g.b))), 0.0, 1.0);
  return a > 0.00001 ? vec4((o.rgb * o.a + g) / a, a) : vec4(0.0);
}`]),
  def('radial-blur', 'Radial Blur', 'Blur & Sharpen', [point('center', 'Center'), num('angle', 'Angle', 0, 45, 8)], `
vec4 fx(vec2 uv) {
  vec2 p = (uv - p_center) * vec2(uAspect, 1.0);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    float t = (float(i) / 23.0 - 0.5) * radians(p_angle);
    vec4 c = src(rotate2(p, t) / vec2(uAspect, 1.0) + p_center);
    acc += vec4(c.rgb * c.a, c.a);
  }
  return unpremultiply(acc / 24.0);
}`),
  def('sharpen', 'Sharpen', 'Blur & Sharpen', [num('amount', 'Amount', 0, 4, 1), num('radius', 'Radius (px)', 0.5, 4, 1)], `
vec4 fx(vec2 uv) {
  vec2 d = p_radius / uResolution;
  vec4 c = src(uv);
  vec3 blur = (src(uv + vec2(d.x, 0.0)).rgb + src(uv - vec2(d.x, 0.0)).rgb + src(uv + vec2(0.0, d.y)).rgb + src(uv - vec2(0.0, d.y)).rgb) * 0.25;
  c.rgb += (c.rgb - blur) * p_amount;
  return c;
}`),
  def('zoom-blur', 'Zoom Blur', 'Blur & Sharpen', [point('center', 'Center'), num('amount', 'Amount', 0, 1, 0.25)], `
vec4 fx(vec2 uv) {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 24; i++) {
    vec4 c = src(p_center + (uv - p_center) * (1.0 - p_amount * float(i) / 23.0));
    acc += vec4(c.rgb * c.a, c.a);
  }
  return unpremultiply(acc / 24.0);
}`),
];
const DISTORT = [
  def('bendoscope', 'Bendoscope', 'Distort', [int('segments', 'Segments', 2, 16, 6), num('bend', 'Bend', 0, 2, 0.6), num('speed', 'Spin (turns/bar)', -2, 2, 0.125), num('zoom', 'Zoom', 0.25, 4, 1)], `${CENTER}${EDGE}
vec4 fx(vec2 uv) {
  vec2 p = toCentered(uv) / p_zoom;
  float seg = TAU / float(p_segments);
  float a = mod(atan(p.y, p.x) + uBeat * 0.25 * p_speed * TAU, seg);
  a = abs(a - seg * 0.5);
  float r = pow(length(p) * 1.5, 1.0 + p_bend) / 1.5;
  a += p_bend * r * 2.0;
  return src(mirrorRepeat(fromCentered(vec2(cos(a), sin(a)) * r)));
}`),
  def('blow', 'Blow', 'Distort', [point('center', 'Center'), num('amount', 'Amount', 0, 1, 0.3), num('turbulence', 'Turbulence', 0, 1, 0.4), num('speed', 'Speed', 0, 4, 1)], `
vec4 fx(vec2 uv) {
  vec2 p = (uv - p_center) * vec2(uAspect, 1.0);
  float d = length(p);
  vec2 dir = d > 0.0001 ? p / d : vec2(0.0);
  float n = noise2(dir * 3.0 + vec2(d * 4.0 - uTime * p_speed, uTime * p_speed * 0.3));
  float push = p_amount * (1.0 + p_turbulence * (n - 0.5) * 2.0) * smoothstep(0.0, 0.5, d);
  return src(p * max(1.0 - push, 0.0) / vec2(uAspect, 1.0) + p_center);
}`),
  def('displace', 'Displace', 'Distort', [choice('mode', 'Source', ['Luma', 'Noise']), num('amount', 'Amount', 0, 0.3, 0.05), num('angle', 'Angle', 0, 360, 45), num('scale', 'Noise Scale', 0.5, 20, 4), num('speed', 'Noise Speed', 0, 4, 0.5)], `${EDGE}
vec4 fx(vec2 uv) {
  vec2 off;
  if (p_mode == 0) {
    float a = radians(p_angle);
    off = vec2(cos(a), sin(a)) * (luma(src(uv).rgb) - 0.5) * 2.0 * p_amount;
  } else {
    vec2 n = uv * vec2(uAspect, 1.0) * p_scale + uTime * p_speed;
    off = (vec2(noise2(n), noise2(n + 17.3)) - 0.5) * 2.0 * p_amount;
  }
  return src(mirrorRepeat(uv + off));
}`),
  def('distortion', 'Distortion', 'Distort', [num('amount', 'Amount', -1, 1, 0.35), num('zoom', 'Zoom', 0.5, 2, 1)], `${CENTER}${EDGE}
vec4 fx(vec2 uv) {
  vec2 p = toCentered(uv);
  p *= (1.0 + p_amount * dot(p, p)) / p_zoom;
  return srcClip(fromCentered(p));
}`),
  def('fish-eye', 'Fish Eye', 'Distort', [point('center', 'Center'), num('radius', 'Radius', 0.1, 1.5, 0.6), num('amount', 'Amount', 0, 1, 0.5)], `
vec4 fx(vec2 uv) {
  vec2 p = (uv - p_center) * vec2(uAspect, 1.0);
  float r = length(p) / p_radius;
  if (r < 1.0) p *= pow(max(r, 0.0001), p_amount * 1.5);
  return src(p / vec2(uAspect, 1.0) + p_center);
}`),
  def('goo', 'Goo', 'Distort', [num('amount', 'Amount', 0, 0.3, 0.05), num('scale', 'Scale', 0.5, 20, 3), num('speed', 'Speed', 0, 4, 0.4), int('detail', 'Detail', 1, 4, 3)], `${EDGE}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5, norm = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= p_detail) break;
    v += a * noise2(p);
    norm += a;
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v / norm;
}
vec4 fx(vec2 uv) {
  vec2 p = uv * vec2(uAspect, 1.0) * p_scale;
  float t = uTime * p_speed;
  vec2 w = vec2(fbm(p + vec2(t, 0.0)), fbm(p + vec2(5.2, 1.3 - t)));
  vec2 w2 = vec2(fbm(p + w * 2.0 + vec2(1.7, 9.2)), fbm(p + w * 2.0 + vec2(8.3, 2.8) + t * 0.5));
  return src(mirrorRepeat(uv + (w2 - 0.5) * 2.0 * p_amount));
}`),
  def('iterate', 'Iterate', 'Distort', [int('count', 'Count', 1, 8, 4), num('scale', 'Scale', 0.3, 0.95, 0.7), num('rotation', 'Rotation', -180, 180, 15), point('center', 'Center')], `${CENTER}${EDGE}${PREMUL}
vec4 fx(vec2 uv) {
  vec4 acc = premul(src(uv));
  for (int i = 1; i <= 8; i++) {
    if (i > p_count) break;
    float k = float(i);
    vec2 p = rotate2((uv - p_center) * vec2(uAspect, 1.0), -radians(p_rotation) * k) / pow(p_scale, k);
    acc = over(premul(srcClip(fromCentered(p))), acc);
  }
  return unpremultiply(acc);
}`),
  def('keystone', 'Keystone', 'Distort', [num('horizontal', 'Horizontal', -1, 1, 0), num('vertical', 'Vertical', -1, 1, 0.3), num('scale', 'Scale', 0.25, 2, 1)], `${EDGE}
vec4 fx(vec2 uv) {
  vec2 p = (uv - 0.5) / p_scale;
  return srcClip(vec2(p.x * (1.0 + p.y * p_vertical), p.y * (1.0 + p.x * p_horizontal)) + 0.5);
}`),
  def('polar-coordinates', 'Polar Coordinates', 'Distort', [choice('mode', 'Mode', ['Rect to Polar', 'Polar to Rect']), num('rotation', 'Rotation', 0, 360, 0), num('zoom', 'Zoom', 0.25, 4, 1)], `${CENTER}
vec4 fx(vec2 uv) {
  if (p_mode == 0) {
    vec2 p = toCentered(uv);
    float a = fract(atan(p.y, p.x) / TAU + 0.5 + p_rotation / 360.0);
    return src(vec2(a, clamp(length(p) * 2.0 / p_zoom, 0.0, 1.0)));
  }
  float a = (uv.x + p_rotation / 360.0) * TAU;
  return src(fromCentered(vec2(cos(a), sin(a)) * uv.y * 0.5 * p_zoom));
}`),
  def('pulse-zoom', 'Pulse Zoom', 'Distort', [num('amount', 'Amount', 0, 1, 0.15), choice('source', 'Source', ['Beat', 'Audio']), choice('rate', 'Beat Rate', RATES, 4), num('decay', 'Decay', 1, 20, 6)], `
vec4 fx(vec2 uv) {
  float env = p_source == 0 ? exp(-fract(uBeat / (16.0 / exp2(float(p_rate)))) * p_decay) : uAudio.x;
  return src((uv - 0.5) / (1.0 + p_amount * env) + 0.5);
}`),
  def('ripple', 'Ripple', 'Distort', [point('center', 'Center'), num('frequency', 'Frequency', 1, 80, 25), num('amplitude', 'Amplitude', 0, 0.1, 0.015), num('speed', 'Speed', -20, 20, 4), num('decay', 'Decay', 0, 8, 1.5)], `${EDGE}
vec4 fx(vec2 uv) {
  vec2 p = (uv - p_center) * vec2(uAspect, 1.0);
  float d = length(p);
  float w = sin(d * p_frequency - uTime * p_speed) * p_amplitude * exp(-d * p_decay);
  vec2 dir = d > 0.0001 ? p / d : vec2(0.0);
  return src(mirrorRepeat(uv + dir * w / vec2(uAspect, 1.0)));
}`),
  def('slide', 'Slide', 'Distort', [num('speedX', 'Speed X', -4, 4, 0.25), num('speedY', 'Speed Y', -4, 4, 0), choice('sync', 'Sync', ['BPM (screens/bar)', 'Free (screens/s)']), num('offsetX', 'Offset X', -1, 1, 0), num('offsetY', 'Offset Y', -1, 1, 0)], `
vec4 fx(vec2 uv) {
  float t = p_sync == 0 ? uBeat * 0.25 : uTime;
  return src(fract(uv - vec2(p_speedX, p_speedY) * t - vec2(p_offsetX, p_offsetY)));
}`),
  def('sphere', 'Sphere', 'Distort', [num('radius', 'Radius', 0.1, 1, 0.45), num('speed', 'Spin Speed', -2, 2, 0.1), num('zoom', 'Zoom', 0.25, 4, 1), num('shading', 'Shading', 0, 1, 0.5)], `${CENTER}${EDGE}
vec4 fx(vec2 uv) {
  vec2 p = toCentered(uv) / p_radius;
  float r2 = dot(p, p);
  if (r2 >= 1.0) return vec4(0.0);
  vec3 n = vec3(p, sqrt(1.0 - r2));
  vec2 t = vec2(atan(n.x, n.z) / PI * 0.5 + uTime * p_speed, asin(n.y) / PI);
  vec4 c = src(mirrorRepeat(t * p_zoom + 0.5));
  float light = clamp(dot(n, normalize(vec3(-0.4, 0.5, 0.8))), 0.0, 1.0);
  c.rgb *= mix(1.0, 0.2 + 0.8 * light, p_shading);
  c.a *= 1.0 - smoothstep(0.97, 1.0, r2);
  return c;
}`),
  def('stingy-sphere', 'Stingy Sphere', 'Distort', [num('radius', 'Radius', 0.1, 1, 0.4), int('spikes', 'Spikes', 0, 32, 10), num('spikeAmount', 'Spike Amount', 0, 1, 0.3), num('speed', 'Speed', -4, 4, 0.5), num('audio', 'Audio React', 0, 1, 0.5)], `${CENTER}
vec4 fx(vec2 uv) {
  vec2 p = toCentered(uv);
  float spike = pow(abs(sin(atan(p.y, p.x) * float(p_spikes) * 0.5 + uTime * p_speed)), 6.0);
  float radius = p_radius * (1.0 + spike * (p_spikeAmount + uAudio.w * p_audio));
  float d = length(p) / radius;
  if (d >= 1.0) return vec4(0.0);
  vec4 c = src(fromCentered(p / radius * asin(d) / max(d, 0.0001) * 0.32));
  c.rgb *= 0.35 + 0.65 * sqrt(1.0 - d * d);
  c.a *= 1.0 - smoothstep(0.95, 1.0, d);
  return c;
}`),
  def('transform-2d', 'Transform 2D', 'Distort', [num('positionX', 'Position X', -1, 1, 0), num('positionY', 'Position Y', -1, 1, 0), num('scale', 'Scale', 0, 4, 1), num('scaleX', 'Scale X', 0, 4, 1), num('scaleY', 'Scale Y', 0, 4, 1), num('rotation', 'Rotation', -180, 180, 0), bool('tile', 'Tile', false)], `${CENTER}${EDGE}
vec4 fx(vec2 uv) {
  vec2 p = (uv - 0.5 - vec2(p_positionX, p_positionY)) * vec2(uAspect, 1.0);
  p = rotate2(p, -radians(p_rotation)) / max(vec2(p_scaleX, p_scaleY) * p_scale, vec2(0.0001));
  vec2 q = fromCentered(p);
  return p_tile ? src(fract(q)) : srcClip(q);
}`),
  def('tunnel', 'Tunnel', 'Distort', [num('speed', 'Speed', -4, 4, 0.5), num('rotation', 'Rotation', -2, 2, 0.1), num('radius', 'Radius', 0.05, 2, 0.4), num('fog', 'Depth Fade', 0, 1, 0.5)], `${CENTER}${EDGE}
vec4 fx(vec2 uv) {
  vec2 p = toCentered(uv);
  float r = max(length(p), 0.001);
  vec4 c = src(mirrorRepeat(vec2(atan(p.y, p.x) / PI + uTime * p_rotation, p_radius / r + uTime * p_speed)));
  c.rgb *= mix(1.0, clamp(r * 2.5, 0.0, 1.0), p_fog);
  return c;
}`),
  def('twist', 'Twist', 'Distort', [point('center', 'Center'), num('angle', 'Angle', -720, 720, 180), num('radius', 'Radius', 0.05, 1.5, 0.5)], `
vec4 fx(vec2 uv) {
  vec2 p = (uv - p_center) * vec2(uAspect, 1.0);
  float t = 1.0 - smoothstep(0.0, 1.0, length(p) / p_radius);
  return src(rotate2(p, radians(p_angle) * t * t) / vec2(uAspect, 1.0) + p_center);
}`),
  def('wave-warp', 'Wave Warp', 'Distort', [choice('direction', 'Direction', ['Horizontal', 'Vertical', 'Both']), num('amplitude', 'Amplitude', 0, 0.2, 0.02), num('frequency', 'Frequency', 0, 40, 6), num('speed', 'Speed', -10, 10, 2)], `${EDGE}
vec4 fx(vec2 uv) {
  vec2 q = uv;
  float ph = uTime * p_speed;
  if (p_direction != 1) q.x += sin(uv.y * TAU * p_frequency + ph) * p_amplitude;
  if (p_direction != 0) q.y += sin(uv.x * TAU * p_frequency + ph) * p_amplitude;
  return src(mirrorRepeat(q));
}`),
];

const MIRROR = [
  def('flip', 'Flip', 'Mirror & Tile', [bool('horizontal', 'Horizontal', true), bool('vertical', 'Vertical', false)], `
vec4 fx(vec2 uv) {
  return src(vec2(p_horizontal ? 1.0 - uv.x : uv.x, p_vertical ? 1.0 - uv.y : uv.y));
}`),
  def('fragment', 'Fragment', 'Mirror & Tile', [int('cells', 'Cells', 2, 40, 8), num('amount', 'Displace', 0, 0.5, 0.08), num('rotate', 'Rotate', 0, 1, 0.2), num('speed', 'Speed', 0, 4, 0.5)], `${CENTER}${EDGE}
vec4 fx(vec2 uv) {
  vec2 g = toCentered(uv) * float(p_cells);
  vec2 id = floor(g), f = fract(g), cell = id;
  float best = 9.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      float d = length(o + vec2(hash12(id + o), hash12(id + o + 31.7)) - f);
      if (d < best) { best = d; cell = id + o; }
    }
  }
  float t = uTime * p_speed, h = hash12(cell * 1.31 + 4.7);
  vec2 center = (cell + 0.5) / float(p_cells);
  vec2 shift = (vec2(hash12(cell * 1.7), hash12(cell * 2.3 + 5.0)) - 0.5) * p_amount * (0.6 + 0.4 * sin(t + h * TAU));
  vec2 p = center + rotate2(toCentered(uv) - center, (h - 0.5) * p_rotate * PI * sin(t * 0.7 + h * 9.0));
  return src(mirrorRepeat(fromCentered(p) + shift));
}`),
  def('kaleidoscope-fx', 'Kaleidoscope', 'Mirror & Tile', [int('segments', 'Segments', 2, 32, 6), num('rotation', 'Rotation', -180, 180, 0), num('speed', 'Spin (turns/bar)', -2, 2, 0.125), point('offset', 'Offset'), num('zoom', 'Zoom', 0.25, 4, 1)], `${CENTER}${EDGE}
vec4 fx(vec2 uv) {
  vec2 p = toCentered(uv) / p_zoom;
  float seg = TAU / float(p_segments);
  float a = mod(atan(p.y, p.x) + radians(p_rotation) + uBeat * 0.25 * p_speed * TAU, seg);
  a = abs(a - seg * 0.5);
  return src(mirrorRepeat(vec2(cos(a), sin(a)) * length(p) / vec2(uAspect, 1.0) + p_offset));
}`),
  def('mirror-fx', 'Mirror', 'Mirror & Tile', [choice('mode', 'Mode', ['Left to Right', 'Right to Left', 'Bottom to Top', 'Top to Bottom']), num('position', 'Position', 0, 1, 0.5)], `${EDGE}
vec4 fx(vec2 uv) {
  vec2 q = uv;
  float m = p_position;
  if (p_mode == 0 && q.x > m) q.x = 2.0 * m - q.x;
  if (p_mode == 1 && q.x < m) q.x = 2.0 * m - q.x;
  if (p_mode == 2 && q.y > m) q.y = 2.0 * m - q.y;
  if (p_mode == 3 && q.y < m) q.y = 2.0 * m - q.y;
  return src(mirrorRepeat(q));
}`),
  def('mirror-quad', 'Mirror Quad', 'Mirror & Tile', [point('center', 'Center'), choice('source', 'Source Quadrant', ['Bottom Left', 'Bottom Right', 'Top Left', 'Top Right'], 2)], `${EDGE}
vec4 fx(vec2 uv) {
  vec2 sgn = vec2(p_source == 1 || p_source == 3 ? 1.0 : -1.0, p_source >= 2 ? 1.0 : -1.0);
  return src(mirrorRepeat(p_center + abs(uv - p_center) * sgn));
}`),
  def('polar-kaleido', 'Polar Kaleido', 'Mirror & Tile', [int('segments', 'Segments', 1, 16, 4), num('twist', 'Twist', -4, 4, 0.5), num('zoom', 'Zoom', 0.25, 4, 1), num('speed', 'Speed (cycles/bar)', -2, 2, 0.25)], `${CENTER}${EDGE}
vec4 fx(vec2 uv) {
  vec2 p = toCentered(uv);
  float r = length(p);
  float s = abs(fract((atan(p.y, p.x) / TAU + 0.5) * float(p_segments)) * 2.0 - 1.0);
  return src(mirrorRepeat(vec2(s + r * p_twist, log(r + 0.001) * p_zoom * 0.5 - uBeat * 0.25 * p_speed)));
}`),
  def('tile', 'Tile', 'Mirror & Tile', [int('tilesX', 'Tiles X', 1, 16, 3), int('tilesY', 'Tiles Y', 1, 16, 3), bool('mirror', 'Mirror', true), num('gap', 'Gap', 0, 0.5, 0)], `${EDGE}
vec4 fx(vec2 uv) {
  vec2 g = uv * vec2(float(p_tilesX), float(p_tilesY));
  vec2 cell = floor(g), f = fract(g);
  if (p_mirror) f = mix(f, 1.0 - f, mod(cell, 2.0));
  return srcClip((f - p_gap * 0.5) / (1.0 - p_gap));
}`),
];
const STYLIZE = [
  def('cartoon', 'Cartoon', 'Stylize', [int('levels', 'Levels', 2, 12, 5), num('edgeThreshold', 'Edge Threshold', 0, 2, 0.4), num('width', 'Edge Width', 0.5, 4, 1), color('edgeColor', 'Edge Color', '#000000')], `${SOBEL}
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec3 gx, gy;
  sobel(uv, p_width / uResolution, gx, gy);
  float e = smoothstep(p_edgeThreshold, p_edgeThreshold + 0.2, length(vec2(luma(gx), luma(gy))));
  vec3 hsv = rgb2hsv(c.rgb);
  float n = float(p_levels);
  hsv.z = floor(hsv.z * n + 0.5) / n;
  hsv.y = min(hsv.y * 1.2, 1.0);
  c.rgb = mix(hsv2rgb(hsv), p_edgeColor.rgb, e);
  return c;
}`),
  def('circles', 'Circles', 'Stylize', [int('rings', 'Rings', 2, 80, 20), int('segments', 'Segments', 0, 128, 0), point('center', 'Center'), num('gap', 'Gap', 0, 0.9, 0.2)], `
vec4 fx(vec2 uv) {
  vec2 p = (uv - p_center) * vec2(uAspect, 1.0);
  float maxR = length(vec2(uAspect, 1.0)), n = float(p_rings);
  float rr = length(p) / maxR * n;
  float a = atan(p.y, p.x);
  if (p_segments > 0) { float s = TAU / float(p_segments); a = (floor(a / s) + 0.5) * s; }
  vec4 c = src(vec2(cos(a), sin(a)) * (floor(rr) + 0.5) / n * maxR / vec2(uAspect, 1.0) + p_center);
  float aa = 2.0 * n / (maxR * uResolution.y);
  float f = abs(fract(rr) - 0.5) * 2.0;
  if (p_gap > 0.0) c.a *= 1.0 - smoothstep(1.0 - p_gap - aa, 1.0 - p_gap + aa, f);
  return c;
}`),
  def('crt', 'CRT', 'Stylize', [num('curvature', 'Curvature', 0, 0.5, 0.15), num('scanlines', 'Scanlines', 0, 1, 0.4), num('mask', 'Shadow Mask', 0, 1, 0.3), num('vignette', 'Vignette', 0, 1, 0.4)], `${EDGE}
vec4 fx(vec2 uv) {
  vec2 p = uv * 2.0 - 1.0;
  p *= 1.0 + p_curvature * dot(p, p) * 0.5;
  vec2 q = p * 0.5 + 0.5;
  vec4 c = srcClip(q);
  c.rgb *= 1.0 - p_scanlines * (0.5 - 0.5 * cos(q.y * uResolution.y * TAU / 3.0));
  int column = int(mod(gl_FragCoord.x, 3.0));
  vec3 m = column == 0 ? vec3(1.0, 0.6, 0.6) : column == 1 ? vec3(0.6, 1.0, 0.6) : vec3(0.6, 0.6, 1.0);
  c.rgb *= mix(vec3(1.0), m * 1.25, p_mask);
  c.rgb *= 1.0 - p_vignette * smoothstep(0.5, 2.0, dot(p, p));
  return c;
}`),
  def('dot-screen', 'Dot Screen', 'Stylize', [num('size', 'Size (px)', 2, 40, 6), num('angle', 'Angle', 0, 90, 45), choice('mode', 'Mode', ['Mono', 'Color'])], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec2 p = rotate2((uv - 0.5) * uResolution, radians(p_angle)) * (PI / p_size);
  float pattern = sin(p.x) * sin(p.y) * 4.0;
  c.rgb = p_mode == 0 ? vec3(dot(c.rgb, vec3(1.0 / 3.0)) * 10.0 - 5.0 + pattern) : c.rgb * 10.0 - 5.0 + pattern;
  return c;
}`),
  def('edge-detection', 'Edge Detection', 'Stylize', [choice('mode', 'Mode', ['Color', 'Mono', 'Neon']), num('strength', 'Strength', 0.5, 8, 2), num('width', 'Width (px)', 0.5, 4, 1), bool('invert', 'Invert', false)], `${SOBEL}
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec3 gx, gy;
  sobel(uv, p_width / uResolution, gx, gy);
  vec3 e = sqrt(gx * gx + gy * gy) * p_strength * 0.25;
  vec3 col = p_mode == 0 ? e : p_mode == 1 ? vec3(luma(e)) : hsv2rgb(vec3(rgb2hsv(c.rgb).x, 0.85, 1.0)) * min(luma(e) * 2.0, 1.0);
  if (p_invert) col = 1.0 - col;
  return vec4(col, c.a);
}`),
  def('emboss', 'Emboss', 'Stylize', [num('strength', 'Strength', 0, 4, 1.5), num('angle', 'Light Angle', 0, 360, 135), num('distance', 'Distance (px)', 0.5, 4, 1), num('color', 'Keep Color', 0, 1, 0)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float a = radians(p_angle);
  vec2 d = vec2(cos(a), sin(a)) * p_distance / uResolution;
  float e = (luma(src(uv - d).rgb) - luma(src(uv + d).rgb)) * p_strength;
  c.rgb = mix(vec3(0.5 + e), c.rgb + e, p_color);
  return c;
}`),
  def('halftone', 'Halftone', 'Stylize', [num('size', 'Size (px)', 3, 40, 8), num('angle', 'Angle', 0, 90, 15), choice('mode', 'Mode', ['Mono', 'CMYK'], 1), num('softness', 'Softness', 0, 1, 0.3)], `
float dotAt(vec2 fc, float ang, int ch) {
  vec2 p = rotate2(fc, ang) / p_size;
  vec2 cell = floor(p) + 0.5;
  vec3 rgb = src(rotate2(cell * p_size, -ang) / uResolution).rgb;
  float k = 1.0 - max(rgb.r, max(rgb.g, rgb.b));
  vec3 cmy = (1.0 - rgb - k) / max(1.0 - k, 0.001);
  float v = clamp(ch == 0 ? cmy.x : ch == 1 ? cmy.y : ch == 2 ? cmy.z : ch == 3 ? k : 1.0 - luma(rgb), 0.0, 1.0);
  float r = sqrt(v) * 0.7071, aa = (0.5 + p_softness * 2.0) / p_size;
  return (1.0 - smoothstep(r - aa, r + aa, length(p - cell))) * min(v * 20.0, 1.0);
}
vec4 fx(vec2 uv) {
  vec2 fc = uv * uResolution;
  float a = radians(p_angle), alpha = src(uv).a;
  if (p_mode == 0) return vec4(vec3(1.0 - dotAt(fc, a + 0.7854, 4)), alpha);
  vec3 ink = vec3(dotAt(fc, a, 0), dotAt(fc, a + 1.0472, 1), dotAt(fc, a + 0.3491, 2));
  return vec4((1.0 - ink) * (1.0 - dotAt(fc, a + 0.5236, 3)), alpha);
}`),
  def('hex-pixelate', 'Hex Pixelate', 'Stylize', [num('size', 'Size (px)', 2, 100, 14)], `
vec4 fx(vec2 uv) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 p = uv * uResolution / p_size;
  vec4 hc = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
  vec2 a = hc.xy * s, b = (hc.zw + 0.5) * s;
  vec2 center = dot(p - a, p - a) < dot(p - b, p - b) ? a : b;
  return src(center * p_size / uResolution);
}`),
  def('lines', 'Lines', 'Stylize', [num('spacing', 'Spacing (px)', 2, 40, 6), num('angle', 'Angle', -90, 90, 30), num('thickness', 'Thickness', 0, 2, 1), choice('mode', 'Mode', ['Mono', 'Color'], 1)], `
vec4 fx(vec2 uv) {
  float a = radians(p_angle);
  vec2 p = rotate2(uv * uResolution, a);
  float row = p.y / p_spacing;
  vec4 c = src(rotate2(vec2(p.x, (floor(row) + 0.5) * p_spacing), -a) / uResolution);
  float w = clamp(luma(c.rgb) * p_thickness, 0.0, 1.0) * 0.5, aa = 1.0 / p_spacing;
  float m = (1.0 - smoothstep(w - aa, w + aa, abs(fract(row) - 0.5))) * min(w * 20.0, 1.0);
  return vec4(p_mode == 0 ? vec3(m) : c.rgb * m, src(uv).a);
}`),
  def('lorez', 'LoRez', 'Stylize', [num('size', 'Pixel Size', 1, 64, 6), int('bits', 'Color Bits', 1, 8, 3), bool('dither', 'Dither', true)], `
vec4 fx(vec2 uv) {
  vec2 cells = max(vec2(1.0), uResolution / p_size);
  vec2 cell = floor(uv * cells);
  vec4 c = src((cell + 0.5) / cells);
  float n = exp2(float(p_bits)) - 1.0;
  float d = p_dither ? (hash12(cell) - 0.5) / n : 0.0;
  c.rgb = floor((c.rgb + d) * n + 0.5) / n;
  return c;
}`),
  def('noise', 'Noise', 'Stylize', [num('amount', 'Amount', 0, 1, 0.25), num('size', 'Grain Size', 1, 8, 1), bool('color', 'Color Noise', false), num('speed', 'Rate (fps)', 0, 60, 24)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec2 cell = floor(uv * uResolution / p_size) + mod(floor(uTime * p_speed), 997.0) * vec2(17.13, 31.71);
  float n = hash12(cell);
  vec3 nn = p_color ? vec3(n, hash12(cell + 41.0), hash12(cell + 83.0)) : vec3(n);
  c.rgb += (nn - 0.5) * p_amount;
  return c;
}`),
  def('pixelate-fx', 'Pixelate', 'Stylize', [num('size', 'Size (px)', 1, 200, 16), num('ratio', 'Aspect', 0.25, 4, 1), choice('shape', 'Shape', ['Square', 'Circle', 'Diamond'])], `
vec4 fx(vec2 uv) {
  vec2 cs = vec2(p_size * p_ratio, p_size);
  vec2 g = uv * uResolution / cs;
  vec2 f = fract(g) - 0.5;
  vec4 c = src((floor(g) + 0.5) * cs / uResolution);
  float aa = 1.0 / p_size;
  if (p_shape == 1) c.a *= 1.0 - smoothstep(0.5 - aa, 0.5, length(f));
  if (p_shape == 2) c.a *= 1.0 - smoothstep(0.5 - aa, 0.5, abs(f.x) + abs(f.y));
  return c;
}`),
  def('point-grid', 'Point Grid', 'Stylize', [num('spacing', 'Spacing (px)', 4, 64, 12), num('size', 'Dot Size', 0, 1, 0.7), color('background', 'Background', '#000000')], `
vec4 fx(vec2 uv) {
  vec2 g = uv * uResolution / p_spacing;
  vec2 cell = floor(g) + 0.5;
  vec4 c = src(cell * p_spacing / uResolution);
  float r = p_size * 0.5, aa = 1.0 / p_spacing;
  float m = 1.0 - smoothstep(r - aa, r + aa, length(g - cell));
  return vec4(mix(p_background.rgb, c.rgb, m), mix(p_background.a, c.a, m));
}`),
  def('polka-dot', 'PolkaDot', 'Stylize', [num('spacing', 'Spacing (px)', 4, 64, 14), num('scale', 'Dot Scale', 0, 1.5, 1), choice('mode', 'Mode', ['Color', 'Mono']), bool('invert', 'Invert', false), color('background', 'Background', '#000000')], `
vec4 fx(vec2 uv) {
  vec2 g = uv * uResolution / p_spacing;
  float rowOffset = mod(floor(g.y), 2.0) * 0.5;
  vec2 cell = vec2(floor(g.x - rowOffset) + 0.5 + rowOffset, floor(g.y) + 0.5);
  vec4 c = src(cell * p_spacing / uResolution);
  float l = p_invert ? 1.0 - luma(c.rgb) : luma(c.rgb);
  float r = sqrt(l) * 0.6 * p_scale, aa = 1.0 / p_spacing;
  float m = (1.0 - smoothstep(r - aa, r + aa, length(g - cell))) * min(l * 20.0, 1.0);
  return vec4(mix(p_background.rgb, p_mode == 0 ? c.rgb : vec3(1.0), m), mix(p_background.a, c.a, m));
}`),
  def('scanlines', 'Scanlines', 'Stylize', [num('spacing', 'Spacing (px)', 2, 16, 4), num('thickness', 'Thickness', 0, 1, 0.5), num('darkness', 'Darkness', 0, 1, 0.5), num('speed', 'Scroll (px/s)', -50, 50, 0)], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float f = fract((uv.y * uResolution.y + uTime * p_speed) / p_spacing);
  float dark = 1.0 - smoothstep(p_thickness, p_thickness + 1.0 / p_spacing, f);
  c.rgb *= 1.0 - dark * p_darkness;
  return c;
}`),
  def('vignette', 'Vignette', 'Stylize', [num('amount', 'Amount', 0, 1, 0.6), num('size', 'Size', 0, 1.5, 0.55), num('softness', 'Softness', 0.01, 1, 0.45), num('roundness', 'Roundness', 0, 1, 1), color('color', 'Color', '#000000')], `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec2 scale = mix(vec2(1.0), vec2(uAspect, 1.0), p_roundness);
  float d = length((uv - 0.5) * scale) / (0.5 * length(scale));
  c.rgb = mix(c.rgb, p_color.rgb, smoothstep(p_size, p_size + p_softness, d) * p_amount);
  return c;
}`),
];
const GLITCH = [
  def('block-glitch', 'Block Glitch', 'Glitch', [num('amount', 'Amount', 0, 1, 0.3), num('blockSize', 'Block Size (px)', 4, 200, 32), bool('swap', 'Channel Swap', true), ...sync(5, 8)], `${SYNC}
vec4 fx(vec2 uv) {
  float t = mod(floor(syncPhase()), 1000.0);
  vec2 bs = vec2(p_blockSize * 2.0, p_blockSize) / uResolution;
  vec2 small = floor(uv / bs), big = floor(uv / (bs * 3.0));
  float r = hash12(small + vec2(t * 13.7, t)), rb = hash12(big + vec2(t, t * 7.1));
  bool on = r < p_amount * 0.35 || rb < p_amount * 0.2;
  vec2 q = on ? uv + (vec2(hash12(small + t), hash12(big - t)) - 0.5) * bs * 6.0 : uv;
  vec4 c = src(fract(q));
  if (p_swap && on && r < p_amount * 0.15) c.rgb = c.gbr;
  return c;
}`),
  def('chromatic-aberration', 'Chromatic Aberration', 'Glitch', [num('amount', 'Amount', 0, 0.05, 0.01), choice('mode', 'Mode', ['Radial', 'Linear']), num('angle', 'Angle', 0, 360, 0), point('center', 'Center')], `
vec4 fx(vec2 uv) {
  float a = radians(p_angle);
  vec2 off = p_mode == 0 ? (uv - p_center) * 2.0 * p_amount : vec2(cos(a), sin(a)) * p_amount;
  vec4 r = src(uv + off), g = src(uv), b = src(uv - off);
  return vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
}`),
  def('rgb-shift', 'Shift RGB', 'Glitch', [num('redX', 'Red X', -0.1, 0.1, 0.01), num('redY', 'Red Y', -0.1, 0.1, 0), num('blueX', 'Blue X', -0.1, 0.1, -0.01), num('blueY', 'Blue Y', -0.1, 0.1, 0), num('jitter', 'Beat Jitter', 0, 1, 0)], `
vec4 fx(vec2 uv) {
  float t = mod(floor(uBeat * 4.0), 1000.0);
  vec2 rnd = (vec2(hash12(vec2(t, 1.0)), hash12(vec2(t, 2.0))) - 0.5) * p_jitter * 0.04;
  vec4 r = src(uv - vec2(p_redX, p_redY) - rnd), g = src(uv), b = src(uv - vec2(p_blueX, p_blueY) + rnd);
  return vec4(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
}`),
  def('shift-glitch', 'Shift Glitch', 'Glitch', [num('amount', 'Amount', 0, 0.5, 0.06), num('blockSize', 'Block Height (px)', 1, 200, 24), num('density', 'Density', 0, 1, 0.4), num('chroma', 'Chroma Split', 0, 1, 0.4), ...sync(5, 10)], `${SYNC}
vec4 fx(vec2 uv) {
  float t = mod(floor(syncPhase()), 1000.0);
  float row = floor(uv.y * uResolution.y / p_blockSize);
  float hit = step(1.0 - p_density, hash12(vec2(row, t)));
  float shift = (hash12(vec2(row * 1.3, t + 7.0)) - 0.5) * 2.0 * p_amount * hit;
  float ch = shift * p_chroma * 0.5;
  vec4 c = src(fract(uv + vec2(shift, 0.0)));
  c.r = src(fract(uv + vec2(shift + ch, 0.0))).r;
  c.b = src(fract(uv + vec2(shift - ch, 0.0))).b;
  return c;
}`),
  def('vhs', 'VHS', 'Glitch', [num('wobble', 'Wobble', 0, 1, 0.3), num('bleed', 'Color Bleed', 0, 1, 0.5), num('noise', 'Noise', 0, 1, 0.25), num('tracking', 'Tracking', 0, 1, 0.2), num('saturation', 'Saturation', 0, 2, 0.8)], `
vec3 toYiq(vec3 c) { return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312))); }
vec3 fromYiq(vec3 c) { return vec3(c.x + 0.956 * c.y + 0.621 * c.z, c.x - 0.272 * c.y - 0.647 * c.z, c.x - 1.106 * c.y + 1.703 * c.z); }
vec4 fx(vec2 uv) {
  float t = uTime, frame = mod(floor(t * 30.0), 997.0);
  float line = floor(uv.y * uResolution.y);
  float band = 1.0 - smoothstep(0.0, 0.08, abs(uv.y - fract(t * 0.13)));
  float wob = ((noise2(vec2(uv.y * 6.0, t * 1.5)) - 0.5) * 0.008 + sin(uv.y * 90.0 + t * 8.0) * 0.0007) * p_wobble;
  wob += band * p_tracking * (hash12(vec2(line, frame)) - 0.5) * 0.06;
  vec2 q = vec2(uv.x + wob, uv.y);
  vec4 c = src(q);
  vec3 yiq = toYiq(c.rgb);
  vec2 chroma = vec2(0.0);
  for (int i = 0; i < 6; i++) chroma += toYiq(src(q - vec2(float(i) * p_bleed * 3.0 / uResolution.x, 0.0)).rgb).yz;
  yiq.yz = chroma / 6.0 * p_saturation;
  c.rgb = fromYiq(yiq);
  float n = hash12(vec2(floor(uv.x * uResolution.x), line) + frame * 13.1);
  c.rgb += (n - 0.5) * p_noise * 0.35 + band * p_tracking * n * 0.25;
  c.rgb *= 0.92 + 0.08 * sin(uv.y * uResolution.y * PI);
  return c;
}`),
];

const TIME = [
  def('chaser', 'Chaser', 'Time & Feedback', [int('steps', 'Steps', 2, 16, 4), choice('pattern', 'Pattern', ['Left to Right', 'Right to Left', 'Bottom to Top', 'Top to Bottom', 'Radial', 'Random', 'Ping Pong']), bool('invert', 'Invert', false), ...sync(4, 2)], `${SYNC}
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float n = float(p_steps), ph = floor(syncPhase());
  float current = mod(ph, n);
  vec2 q = clamp(uv, 0.0, 0.9999);
  float seg = floor(q.x * n);
  if (p_pattern == 1) seg = n - 1.0 - seg;
  else if (p_pattern == 2) seg = floor(q.y * n);
  else if (p_pattern == 3) seg = n - 1.0 - floor(q.y * n);
  else if (p_pattern == 4) seg = floor(min(length((uv - 0.5) * vec2(uAspect, 1.0)) / (0.5 * length(vec2(uAspect, 1.0))), 0.9999) * n);
  else if (p_pattern == 5) current = floor(hash12(vec2(mod(ph, 1000.0), 3.1)) * n);
  else if (p_pattern == 6) current = n - 1.0 - abs(mod(ph, 2.0 * n - 2.0) - (n - 1.0));
  float on = step(abs(seg - current), 0.5);
  c.a *= p_invert ? 1.0 - on : on;
  return c;
}`),
  def('feedback', 'Feedback', 'Time & Feedback', [num('amount', 'Feedback', 0, 1, 0.85), num('zoom', 'Zoom', 0.8, 1.25, 1.02), num('rotation', 'Rotation', -10, 10, 0.5), num('offsetX', 'Offset X', -0.05, 0.05, 0), num('offsetY', 'Offset Y', -0.05, 0.05, 0), num('hueShift', 'Hue Shift', -0.1, 0.1, 0.01), choice('mode', 'Mode', ['Mix', 'Add', 'Lighten', 'Behind'], 2)], `${CENTER}${EDGE}${PREMUL}
vec4 fx(vec2 uv) {
  vec4 c = premul(src(uv));
  vec2 q = fromCentered(rotate2(toCentered(uv - vec2(p_offsetX, p_offsetY)), radians(p_rotation)) / p_zoom);
  vec4 f = prev(q) * inBounds(q);
  if (p_hueShift != 0.0) { vec3 hsv = rgb2hsv(f.rgb); hsv.x = fract(hsv.x + p_hueShift); f.rgb = hsv2rgb(hsv); }
  f = premul(f);
  vec4 o;
  if (p_mode == 0) o = mix(c, f, p_amount);
  else if (p_mode == 1) o = min(c + f * p_amount, vec4(1.0));
  else if (p_mode == 2) o = max(c, f * p_amount);
  else o = over(c, f * p_amount);
  return unpremultiply(o);
}`, { feedback: true }),
  def('infinite-zoom', 'Infinite Zoom', 'Time & Feedback', [num('size', 'Size', 0.2, 0.95, 0.6), num('zoom', 'Zoom Speed', 1, 1.2, 1.03), num('rotation', 'Rotation', -10, 10, 0), num('decay', 'Persistence', 0, 1, 0.97)], `${CENTER}${EDGE}${PREMUL}
vec4 fx(vec2 uv) {
  vec4 c = premul(srcClip((uv - 0.5) / p_size + 0.5));
  vec2 q = fromCentered(rotate2(toCentered(uv), radians(p_rotation)) / p_zoom);
  vec4 f = premul(prev(q) * inBounds(q)) * p_decay;
  return unpremultiply(over(c, f));
}`, { feedback: true }),
  def('strobe-fx', 'Strobe', 'Time & Feedback', [...sync(5, 8), num('duty', 'Duty Cycle', 0.05, 0.95, 0.5), choice('mode', 'Off State', ['Transparent', 'Black', 'White', 'Invert', 'Color']), color('color', 'Color', '#ffffff')], `${SYNC}
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  if (fract(syncPhase()) < p_duty) return c;
  if (p_mode == 0) return vec4(c.rgb, 0.0);
  if (p_mode == 1) return vec4(0.0, 0.0, 0.0, c.a);
  if (p_mode == 2) return vec4(1.0, 1.0, 1.0, c.a);
  if (p_mode == 3) return vec4(1.0 - c.rgb, c.a);
  return vec4(p_color.rgb, c.a * p_color.a);
}`),
  def('trails', 'Trails', 'Time & Feedback', [num('persistence', 'Persistence', 0, 0.99, 0.85), choice('mode', 'Mode', ['Lighten', 'Mix', 'Add', 'Darken'])], `${PREMUL}
vec4 fx(vec2 uv) {
  vec4 c = premul(src(uv)), f = premul(prev(uv));
  vec4 o;
  if (p_mode == 0) o = max(c, f * p_persistence);
  else if (p_mode == 1) o = mix(c, f, p_persistence);
  else if (p_mode == 2) o = min(c + f * p_persistence * 0.6, vec4(1.0));
  else o = min(c, mix(c, f, p_persistence));
  return unpremultiply(o);
}`, { feedback: true }),
];

const GENERATE = [
  def('grid', 'Grid', 'Generate & Overlay', [int('cells', 'Cells', 1, 64, 8), bool('square', 'Square Cells', true), num('thickness', 'Thickness (px)', 0.5, 10, 2), color('color', 'Color', '#ffffff'), num('speed', 'Scroll (cells/bar)', -2, 2, 0)], `${PREMUL}
vec4 fx(vec2 uv) {
  vec2 n = p_square ? vec2(float(p_cells) * uAspect, float(p_cells)) : vec2(float(p_cells));
  vec2 g = uv * n + vec2(0.0, uBeat * 0.25 * p_speed);
  vec2 d = abs(fract(g + 0.5) - 0.5) * uResolution / n;
  float line = 1.0 - smoothstep(p_thickness * 0.5 - 0.5, p_thickness * 0.5 + 0.5, min(d.x, d.y));
  return unpremultiply(over(vec4(p_color.rgb, 1.0) * p_color.a * line, premul(src(uv))));
}`),
  def('radar', 'Radar', 'Generate & Overlay', [point('center', 'Center'), num('speed', 'Speed (turns/bar)', -4, 4, 1), num('trail', 'Trail', 0, 1, 0.35), int('rings', 'Rings', 0, 12, 4), color('color', 'Color', '#33ff66')], `${PREMUL}
vec4 fx(vec2 uv) {
  vec2 p = (uv - p_center) * vec2(uAspect, 1.0);
  float d = fract(uBeat * 0.25 * p_speed - atan(p.y, p.x) / TAU);
  float beam = pow(max(1.0 - d / max(p_trail, 0.001), 0.0), 2.0);
  float rings = float(p_rings), rc = length(p) * 2.0 * rings;
  float ring = p_rings > 0 ? 1.0 - smoothstep(0.0, 3.0 * rings / uResolution.y, abs(fract(rc + 0.5) - 0.5)) : 0.0;
  float glow = clamp(beam * 0.8 + ring * 0.5, 0.0, 1.0);
  return unpremultiply(over(vec4(p_color.rgb, 1.0) * p_color.a * glow, premul(src(uv))));
}`),
  def('stripes', 'Stripes', 'Generate & Overlay', [int('count', 'Count', 1, 64, 8), num('angle', 'Angle', -90, 90, 45), num('width', 'Width', 0, 1, 0.5), num('softness', 'Softness', 0, 1, 0.05), num('speed', 'Speed (cycles/bar)', -4, 4, 0.25), color('color', 'Color', '#000000'), choice('mode', 'Mode', ['Color', 'Transparent'])], `${CENTER}
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  vec2 p = rotate2(toCentered(uv), radians(p_angle));
  float d = abs(fract(p.x * float(p_count) - uBeat * 0.25 * p_speed) - 0.5) * 2.0;
  float aa = fwidth(d);
  float m = 1.0 - smoothstep(p_width - p_softness - aa, p_width + aa, d);
  if (p_mode == 0) c.rgb = mix(c.rgb, p_color.rgb, m * p_color.a);
  else c.a *= 1.0 - m;
  return c;
}`),
];

// Original single-amount engine effects (EFFECT shader in engine.js), kept
// bit-for-bit compatible for old projects.
const legacy = (id, name, glsl) => def(id, name, 'Legacy', [num('amount', 'Amount', 0, 1, 0.5)], glsl, { legacy: true });
const LEGACY = [
  legacy('invert', 'Invert (Legacy)', `
vec4 fx(vec2 uv) { vec4 c = src(uv); c.rgb = mix(c.rgb, 1.0 - c.rgb, p_amount); return c; }`),
  legacy('grayscale', 'Grayscale (Legacy)', `
vec4 fx(vec2 uv) { vec4 c = src(uv); c.rgb = mix(c.rgb, vec3(luma(c.rgb)), p_amount); return c; }`),
  legacy('brightness', 'Brightness (Legacy)', `
vec4 fx(vec2 uv) { vec4 c = src(uv); c.rgb *= p_amount * 2.0; return c; }`),
  legacy('contrast', 'Contrast (Legacy)', `
vec4 fx(vec2 uv) { vec4 c = src(uv); c.rgb = (c.rgb - 0.5) * (p_amount * 2.0) + 0.5; return c; }`),
  legacy('saturation', 'Saturation (Legacy)', `
vec4 fx(vec2 uv) { vec4 c = src(uv); c.rgb = mix(vec3(luma(c.rgb)), c.rgb, p_amount * 2.0); return c; }`),
  legacy('hue', 'Hue (Legacy)', `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  float angle = (p_amount - 0.5) * TAU;
  vec3 axis = normalize(vec3(1.0));
  c.rgb = c.rgb * cos(angle) + cross(axis, c.rgb) * sin(angle) + axis * dot(axis, c.rgb) * (1.0 - cos(angle));
  return c;
}`),
  legacy('pixelate', 'Pixelate (Legacy)', `
vec4 fx(vec2 uv) {
  if (p_amount <= 0.001) return src(uv);
  vec2 cells = max(vec2(1.0), uResolution / (1.0 + p_amount * p_amount * 90.0));
  return src((floor(uv * cells) + 0.5) / cells);
}`),
  legacy('mirror', 'Mirror (Legacy)', `
vec4 fx(vec2 uv) {
  vec2 q = uv;
  if (p_amount > 0.001) {
    q.x = abs(q.x - 0.5) * 2.0;
    if (p_amount > 0.66) q.y = abs(q.y - 0.5) * 2.0;
  }
  return src(q);
}`),
  legacy('kaleidoscope', 'Kaleidoscope (Legacy)', `
vec4 fx(vec2 uv) {
  vec2 q = uv;
  if (p_amount > 0.001) {
    float aspect = uResolution.x / uResolution.y;
    vec2 p = (q - 0.5) * vec2(aspect, 1.0);
    float sector = TAU / (2.0 + floor(p_amount * 14.0));
    float theta = abs(mod(atan(p.y, p.x), sector) - sector * 0.5);
    q = vec2(cos(theta), sin(theta)) * length(p);
    q.x /= aspect;
    q += 0.5;
  }
  return src(q);
}`),
  legacy('strobe', 'Strobe (Legacy)', `
vec4 fx(vec2 uv) {
  vec4 c = src(uv);
  if (p_amount > 0.001 && fract(uTime * (1.0 + p_amount * 24.0)) > 0.5) c.a = 0.0;
  return c;
}`),
];

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

export const VIDEO_EFFECTS = deepFreeze([...COLOR, ...KEYING, ...BLUR, ...DISTORT, ...MIRROR, ...STYLIZE, ...GLITCH, ...TIME, ...GENERATE, ...MANUAL_EFFECTS, ...LEGACY]);
export const VIDEO_EFFECT_CATEGORIES = Object.freeze([...new Set(VIDEO_EFFECTS.map(effect => effect.category))]);
export const LEGACY_EFFECT_IDS = Object.freeze(LEGACY.map(effect => effect.id));

const BY_ID = new Map(VIDEO_EFFECTS.map(effect => [effect.id, effect]));
export const videoEffect = id => BY_ID.get(id) || null;
