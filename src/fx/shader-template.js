// Shared GLSL contract for catalog effects and generated sources. Catalog
// entries supply only a body; this module wraps it with the uniforms the engine
// binds so every definition, built-in or imported, renders the same way.
//
// Effect definition:
//   { id, name, category, params: [param...], glsl, passes?, feedback? }
//   glsl defines `vec4 fx(vec2 uv)` returning UNPREMULTIPLIED rgba.
//   `passes` (optional) is an array of glsl bodies run in order; pass N reads
//   the previous pass with src() and the effect input with orig().
//   `feedback: true` makes prev(uv) return the previous output of the instance.
// Source definition:
//   { id, name, category, params: [param...], glsl }
//   glsl defines `vec4 gen(vec2 uv)` returning UNPREMULTIPLIED rgba.
// Param: { key, label, type: 'float'|'int'|'bool'|'choice'|'color'|'point',
//          min, max, default, options? (choice labels), step? }
//   float -> uniform float p_key      int/choice -> uniform int p_key
//   bool  -> uniform bool p_key       color -> uniform vec4 p_key (rgba 0..1)
//   point -> uniform vec2 p_key
// Built-ins available to every body:
//   uv (0..1, origin bottom-left), uResolution (px), uAspect (w/h), uTime (s),
//   uBeat (beats since start), uAudio (vec4 low, mid, high, level 0..1),
//   src(p) / orig(p) / prev(p) unpremultiplied samplers (effects only),
//   luma(rgb), rgb2hsv/hsv2rgb, hash12(p), noise2(p), rotate2(p, radians), PI, TAU.

// 'text' params (e.g. Text Animator content, capture device ids) hold strings
// and never become uniforms.
export const PARAM_TYPES = Object.freeze(['float', 'int', 'bool', 'choice', 'color', 'point', 'text']);

export const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `
const float PI = 3.14159265359;
const float TAU = 6.28318530718;
uniform vec2 uResolution;
uniform float uAspect;
uniform float uTime;
uniform float uBeat;
uniform vec4 uAudio;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec2 rotate2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
`;

const SAMPLERS = `
uniform sampler2D uImage;
uniform sampler2D uOriginal;
uniform sampler2D uPrevious;
vec4 unpremultiply(vec4 c) { return c.a > 0.00001 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 src(vec2 p) { return unpremultiply(texture(uImage, p)); }
vec4 orig(vec2 p) { return unpremultiply(texture(uOriginal, p)); }
vec4 prev(vec2 p) { return unpremultiply(texture(uPrevious, p)); }
`;

export const uniformName = key => `p_${String(key).replace(/[^a-zA-Z0-9_]/g, '_')}`;

function uniformType(param) {
  if (param.type === 'int' || param.type === 'choice') return 'int';
  if (param.type === 'bool') return 'bool';
  if (param.type === 'color') return 'vec4';
  if (param.type === 'point') return 'vec2';
  return 'float';
}

function paramUniforms(params = []) {
  return params.filter(param => param.type !== 'text').map(param => `uniform ${uniformType(param)} ${uniformName(param.key)};`).join('\n');
}

export function effectPasses(definition) {
  return Array.isArray(definition.passes) && definition.passes.length ? definition.passes : [definition.glsl];
}

export function buildEffectShader(definition, passIndex = 0) {
  const body = effectPasses(definition)[passIndex];
  if (typeof body !== 'string') throw new Error(`Effect ${definition.id} has no pass ${passIndex}.`);
  return `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
${COMMON}
${SAMPLERS}
uniform int uPass;
${paramUniforms(definition.params)}
${body}
void main() {
  vec4 c = clamp(fx(uv), 0.0, 1.0);
  frag = vec4(c.rgb * c.a, c.a);
}`;
}

export function buildSourceShader(definition) {
  return `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
${COMMON}
${paramUniforms(definition.params)}
${definition.glsl}
void main() {
  vec4 c = clamp(gen(uv), 0.0, 1.0);
  frag = vec4(c.rgb * c.a, c.a);
}`;
}

export const BUILTIN_UNIFORMS = Object.freeze(['uImage', 'uOriginal', 'uPrevious', 'uResolution', 'uAspect', 'uTime', 'uBeat', 'uAudio', 'uPass']);

const hexColor = value => typeof value === 'string' && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value);

export function colorToVec4(value) {
  const hex = hexColor(value) ? value.slice(1) : 'ffffffff';
  const channel = index => index * 2 < hex.length ? parseInt(hex.slice(index * 2, index * 2 + 2), 16) / 255 : 1;
  return [channel(0), channel(1), channel(2), channel(3)];
}

// Normalize one stored parameter value against its definition.
export function normalizeParam(param, value) {
  const fallback = param.default;
  if (param.type === 'text') return typeof value === 'string' ? value.slice(0, param.maxLength || 4096) : typeof fallback === 'string' ? fallback : '';
  if (param.type === 'bool') return typeof value === 'boolean' ? value : !!fallback;
  if (param.type === 'color') return hexColor(value) ? value : (hexColor(fallback) ? fallback : '#ffffff');
  if (param.type === 'point') {
    const pair = Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) ? value : Array.isArray(fallback) ? fallback : [0.5, 0.5];
    return pair.map(item => Math.min(param.max ?? 1, Math.max(param.min ?? 0, item)));
  }
  if (param.type === 'choice') {
    const count = Math.max(1, param.options?.length || 1);
    return Number.isInteger(value) && value >= 0 && value < count ? value : Math.min(count - 1, Math.max(0, Math.round(Number(fallback) || 0)));
  }
  const min = Number.isFinite(param.min) ? param.min : 0, max = Number.isFinite(param.max) ? param.max : 1;
  const number = Number.isFinite(value) ? value : Number.isFinite(fallback) ? fallback : min;
  const clamped = Math.min(max, Math.max(min, number));
  return param.type === 'int' ? Math.round(clamped) : clamped;
}

export function defaultParams(definition) {
  return Object.fromEntries((definition?.params || []).map(param => [param.key, normalizeParam(param, undefined)]));
}

export function normalizeParams(definition, values) {
  const input = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  return Object.fromEntries((definition?.params || []).map(param => [param.key, normalizeParam(param, input[param.key])]));
}

// Set uniforms for a compiled program. `locations` maps uniform names to
// WebGLUniformLocation (missing names are skipped: the compiler may drop them).
export function bindParams(gl, locations, definition, values) {
  for (const param of definition.params || []) {
    if (param.type === 'text') continue;
    const location = locations[uniformName(param.key)];
    if (!location) continue;
    const value = normalizeParam(param, values?.[param.key]);
    if (param.type === 'int' || param.type === 'choice') gl.uniform1i(location, value);
    else if (param.type === 'bool') gl.uniform1i(location, value ? 1 : 0);
    else if (param.type === 'color') gl.uniform4fv(location, colorToVec4(value));
    else if (param.type === 'point') gl.uniform2f(location, value[0], value[1]);
    else gl.uniform1f(location, value);
  }
}

export function uniformNames(definition) {
  return [...BUILTIN_UNIFORMS, ...(definition.params || []).filter(param => param.type !== 'text').map(param => uniformName(param.key))];
}
