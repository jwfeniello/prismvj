// ISF (Interactive Shader Format, https://github.com/mrRay/ISF_Spec) import.
// parseISF turns one .fs file (plus its optional .vs) into a definition that
// the ISF runtime (isf-runtime.js) renders as a standalone GLSL ES 3.00
// program: the JSON header becomes params, uniforms, images and passes, and
// the GLSL is translated token by token from GLSL 1.x idioms. ISF image
// functions are preprocessor macros and PASSINDEX is a live uniform, so
// multi-pass, persistent, FLOAT and custom-size buffers, vertex shaders, audio
// inputs, imported images and transitions all run as written. Shaders come
// from untrusted files, so every size is bounded and nothing is evaluated.

export const ISF_LIMITS = Object.freeze({ text: 512 * 1024, header: 64 * 1024, inputs: 64, passes: 16, values: 256, images: 12, expression: 256 });
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// point2D values are pixels; defaults are normalized against MAX when it looks
// like a canvas size, otherwise against this reference size.
const POINT_REFERENCE = [640, 480];
const BUILTINS = new Set(['RENDERSIZE', 'TIME', 'TIMEDELTA', 'FRAMEINDEX', 'DATE', 'PASSINDEX', 'isf_FragNormCoord', 'vv_FragNormCoord']);
// Legal identifiers in GLSL 1.x that GLSL ES 3.00 reserves.
const ES3_RESERVED = new Set(['sample', 'input', 'output', 'filter', 'smooth', 'flat', 'layout', 'centroid', 'active', 'common',
  'partition', 'half', 'fixed', 'patch', 'resource', 'union', 'enum', 'class', 'template', 'this', 'inline', 'noinline', 'public',
  'static', 'extern', 'external', 'interface', 'long', 'short', 'double', 'unsigned', 'superp', 'namespace', 'using', 'sizeof',
  'cast', 'goto', 'asm', 'volatile', 'coherent', 'restrict', 'readonly', 'writeonly', 'noperspective', 'subroutine', 'buffer',
  'shared', 'packed', 'uint', 'switch', 'case', 'default', 'sampler3D', 'samplerCube']);
// GLSL ES 3.00 built-ins that GLSL 1.x shaders often define themselves.
const ES3_FUNCTIONS = new Set(['round', 'roundEven', 'trunc', 'inverse', 'transpose', 'determinant', 'outerProduct', 'isnan',
  'isinf', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'modf', 'textureSize', 'texelFetch', 'textureOffset',
  'textureProj', 'textureLod', 'textureGrad', 'floatBitsToInt', 'intBitsToFloat', 'packHalf2x16', 'unpackHalf2x16',
  // GLSL 1.x built-ins that desktop drivers let shaders redefine.
  'radians', 'degrees', 'sign', 'mod', 'fract', 'smoothstep', 'step', 'mix', 'clamp', 'saturate', 'length', 'distance', 'normalize',
  'reflect', 'refract', 'faceforward', 'cross', 'dot', 'atan', 'pow', 'exp', 'log', 'exp2', 'log2', 'inversesqrt', 'matrixCompMult']);
const TYPES = new Set(['void', 'float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3',
  'bvec4', 'mat2', 'mat3', 'mat4', 'highp', 'mediump', 'lowp']);
const QUALIFIERS = new Set(['uniform', 'varying', 'attribute', 'const', 'highp', 'mediump', 'lowp', 'in', 'out', 'flat', 'smooth', 'invariant', 'centroid']);
const GLSL1_FUNCTIONS = { texture2D: 'texture', texture2DLod: 'textureLod', texture2DProj: 'textureProj', texture2DProjLod: 'textureProjLod',
  textureCube: 'texture', textureCubeLod: 'textureLod', texture2DLodEXT: 'textureLod', texture2DGradEXT: 'textureGrad', texture2DRect: 'IMG_PIXEL' };
// Choices for image inputs other than the effect input.
export const ISF_IMAGE_SOURCES = Object.freeze(['None', 'This input', 'Below this layer', 'Bundled image']);

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const bound = value => clamp(value, -1e6, 1e6);
const truthy = value => value === true || (finite(value) && value > 0) || value === 'true' || value === '1';

// ---------------------------------------------------------------- header

function skipString(raw, i) {
  let j = i + 1;
  while (j < raw.length && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1;
  return j;
}

function stripJSONComments(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') { const j = skipString(raw, i); out += raw.slice(i, j + 1); i = j; }
    else if (c === '/' && raw[i + 1] === '/') { while (i < raw.length && raw[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && raw[i + 1] === '*') { const end = raw.indexOf('*/', i + 2); i = end < 0 ? raw.length : end + 1; out += ' '; }
    else out += c;
  }
  return out;
}

function stripTrailingCommas(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') { const j = skipString(raw, i); out += raw.slice(i, j + 1); i = j; }
    else if (c === ',') {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      if (raw[j] !== '}' && raw[j] !== ']') out += c;
    } else out += c;
  }
  return out;
}

// The JSON header is the first /* */ comment whose text starts with "{";
// line comments and other block comments may come before it.
function findHeader(text) {
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const space = /^[\s\uFEFF]+/.exec(rest);
    if (space) { i += space[0].length; continue; }
    if (rest.startsWith('//')) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
    if (rest.startsWith('/*')) {
      if (/^\/\*\s*\{/.test(rest)) return i;
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 2;
      continue;
    }
    return -1;
  }
  return -1;
}

export function splitHeader(text) {
  const start = findHeader(text);
  if (start < 0) throw new Error('Not an ISF shader: missing the leading /*{ JSON }*/ header.');
  const end = text.indexOf('*/', start + 2);
  if (end < 0) throw new Error('ISF header comment is not closed.');
  const raw = text.slice(start + 2, end);
  if (raw.length > ISF_LIMITS.header) throw new Error('ISF JSON header is too large.');
  let header;
  try { header = JSON.parse(stripTrailingCommas(stripJSONComments(raw))); }
  catch (error) { throw new Error(`Invalid ISF JSON header: ${error.message}`); }
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('ISF JSON header must be an object.');
  return { header, body: text.slice(0, start) + text.slice(end + 2) };
}

// ---------------------------------------------------------------- size expressions

// WIDTH/HEIGHT pass sizes ("$WIDTH/4.0", "floor($HEIGHT*0.5)", "$blurAmount").
// Parsed into a tiny AST at import; evaluated per frame by evaluateSize.
const FUNCTIONS = { floor: 1, ceil: 1, round: 1, abs: 1, sqrt: 1, sin: 1, cos: 1, max: 2, min: 2, pow: 2, clamp: 3 };
export function parseSizeExpression(source, variables) {
  if (finite(source)) return { n: source };
  if (typeof source !== 'string' || !source.trim() || source.length > ISF_LIMITS.expression) throw new Error('Invalid pass size expression.');
  const tokens = source.match(/\$?[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|&&|\|\||[<>=!]=|[-+*/%(),?:<>]|\S/g) || [];
  let i = 0;
  const peek = () => tokens[i], take = () => tokens[i++];
  const fail = () => { throw new Error(`Invalid pass size expression "${source}".`); };
  const expect = token => { if (take() !== token) fail(); };
  const primary = () => {
    const token = take();
    if (token === undefined) fail();
    if (token === '(') { const node = ternary(); expect(')'); return node; }
    if (token === '-') return { op: 'neg', a: primary() };
    if (token === '+') return primary();
    if (/^[\d.]/.test(token)) return { n: Number(token) };
    if (token.startsWith('$')) {
      const name = token.slice(1);
      if (!variables.has(name)) throw new Error(`Pass size uses unknown variable ${token}.`);
      return { v: name };
    }
    if (Object.hasOwn(FUNCTIONS, token)) {
      expect('(');
      const args = [ternary()];
      while (peek() === ',') { take(); args.push(ternary()); }
      expect(')');
      if (args.length !== FUNCTIONS[token]) throw new Error(`${token}() takes ${FUNCTIONS[token]} argument(s) in a pass size.`);
      return { f: token, args };
    }
    return fail();
  };
  const binary = (next, ops) => () => { let a = next(); while (ops.includes(peek())) { const op = take(); a = { op, a, b: next() }; } return a; };
  const product = binary(primary, ['*', '/', '%']);
  const sum = binary(product, ['+', '-']);
  const compare = binary(sum, ['<', '>', '<=', '>=', '==', '!=']);
  const logic = binary(compare, ['&&', '||']);
  const ternary = () => { const c = logic(); if (peek() !== '?') return c; take(); const a = ternary(); expect(':'); return { op: '?', c, a, b: ternary() }; };
  const tree = ternary();
  if (i !== tokens.length) fail();
  return tree;
}

export function evaluateSize(node, values, depth = 0) {
  if (!node || depth > 64) return 0;
  if (Object.hasOwn(node, 'n')) return node.n;
  if (Object.hasOwn(node, 'v')) return Number(values[node.v]) || 0;
  if (node.f) {
    const args = node.args.map(arg => evaluateSize(arg, values, depth + 1));
    if (node.f === 'clamp') return clamp(args[0], args[1], args[2]);
    return Math[node.f](...args);
  }
  const a = evaluateSize(node.a, values, depth + 1);
  if (node.op === 'neg') return -a;
  if (node.op === '?') return evaluateSize(node.c, values, depth + 1) ? a : evaluateSize(node.b, values, depth + 1);
  const b = evaluateSize(node.b, values, depth + 1);
  switch (node.op) {
    case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return b ? a / b : 0; case '%': return b ? a % b : 0;
    case '<': return +(a < b); case '>': return +(a > b); case '<=': return +(a <= b); case '>=': return +(a >= b);
    case '==': return +(a === b); case '!=': return +(a !== b); case '&&': return +(a && b); case '||': return +(a || b);
    default: return 0;
  }
}
// ---------------------------------------------------------------- inputs

const pair = value => Array.isArray(value) && value.length >= 2 && finite(value[0]) && finite(value[1]) ? [bound(value[0]), bound(value[1])] : null;
const hexByte = value => Math.round(clamp(finite(value) ? value : 1, 0, 1) * 255).toString(16).padStart(2, '0');

function checkName(name, what) {
  if (typeof name !== 'string' || !NAME.test(name) || name.startsWith('gl_') || name.startsWith('isf_') || name.startsWith('_')) {
    throw new Error(`Invalid ISF ${what} name ${JSON.stringify(String(name).slice(0, 40))}.`);
  }
  if (BUILTINS.has(name)) throw new Error(`ISF ${what} name "${name}" clashes with an ISF built-in.`);
}

function longInput(input, name, label) {
  let values;
  if (Array.isArray(input.VALUES)) {
    if (!input.VALUES.length || input.VALUES.length > ISF_LIMITS.values || !input.VALUES.every(finite)) throw new Error(`ISF long input "${name}" has invalid VALUES.`);
    values = input.VALUES.map(value => clamp(Math.trunc(value), -2147483647, 2147483647));
  } else {
    const labelCount = Array.isArray(input.LABELS) ? input.LABELS.length : 0;
    const min = finite(input.MIN) ? Math.trunc(input.MIN) : 0;
    const max = finite(input.MAX) ? Math.trunc(input.MAX) : labelCount ? min + labelCount - 1 : Math.max(min + 1, finite(input.DEFAULT) ? Math.trunc(input.DEFAULT) : 0);
    if (max < min || max - min >= ISF_LIMITS.values) throw new Error(`ISF long input "${name}" has an invalid MIN/MAX range.`);
    values = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  }
  const labels = Array.isArray(input.LABELS) ? input.LABELS.slice(0, values.length) : [];
  const options = values.map((value, index) => typeof labels[index] === 'string' || finite(labels[index]) ? String(labels[index]).slice(0, 64) : String(value));
  const found = values.indexOf(finite(input.DEFAULT) ? Math.trunc(input.DEFAULT) : values[0]);
  return { key: name, label, type: 'choice', options, default: Math.max(0, found), isfValues: values };
}

function pointInput(input, name, label, warn) {
  const def = pair(input.DEFAULT), min = pair(input.MIN), max = pair(input.MAX);
  if (max && max[0] <= 1 && max[1] <= 1) {
    // Authored with normalized coordinates (MAX <= 1): passed through unchanged.
    const lo = min ? Math.min(min[0], min[1]) : 0, hi = Math.max(max[0], max[1], lo);
    const value = def ? def.map(item => clamp(item, lo, hi)) : [(lo + hi) / 2, (lo + hi) / 2];
    return { key: name, label, type: 'point', min: lo, max: hi, default: value, isfPoint: 'normalized' };
  }
  // Pixel coordinates: the param stores a 0..1 fraction of the frame and the
  // shader sees it scaled to pixels of the render size.
  const reference = max && max[0] > 1 && max[1] > 1 ? max : POINT_REFERENCE;
  if (def && reference === POINT_REFERENCE && (def[0] || def[1])) warn(`point2D "${name}" default assumed relative to a ${POINT_REFERENCE.join('x')} canvas.`);
  const lo = min ? clamp(Math.min(min[0] / reference[0], min[1] / reference[1]), -1, 0) : 0;
  const value = def ? [clamp(def[0] / reference[0], lo, 1), clamp(def[1] / reference[1], lo, 1)] : [0.5, 0.5];
  return { key: name, label, type: 'point', min: lo, max: 1, default: value, isfPoint: 'pixels' };
}

function importedImages(header) {
  const raw = header.IMPORTED;
  const entries = Array.isArray(raw) ? raw.map(item => [item?.NAME, item]) : raw && typeof raw === 'object' ? Object.entries(raw) : [];
  return entries.slice(0, ISF_LIMITS.images).map(([name, item]) => {
    checkName(name, 'imported image');
    const path = typeof item?.PATH === 'string' ? item.PATH.slice(0, 512) : '';
    return { name, path };
  });
}

function readInputs(header, warn) {
  const raw = header.INPUTS ?? [];
  if (!Array.isArray(raw)) throw new Error('ISF INPUTS must be an array.');
  if (raw.length > ISF_LIMITS.inputs) throw new Error(`ISF shader has too many inputs (limit ${ISF_LIMITS.inputs}).`);
  const params = [], uniforms = [], images = [], names = new Set();
  const transition = isfKind(header) === 'transition';
  for (const input of raw) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ISF inputs must be objects.');
    const { NAME: name, TYPE: type } = input;
    checkName(name, 'input');
    if (names.has(name)) throw new Error(`Duplicate ISF input "${name}".`);
    names.add(name);
    const label = typeof input.LABEL === 'string' && input.LABEL.trim() ? input.LABEL.trim().slice(0, 64) : name;
    if (type === 'float') {
      // A transition's progress is driven by the mix, not shown as a control.
      if (name === 'progress' && transition) { uniforms.push({ name, type: 'float', role: 'progress' }); continue; }
      const fallback = finite(input.DEFAULT) ? bound(input.DEFAULT) : 0;
      const lo = finite(input.MIN) ? bound(input.MIN) : Math.min(0, fallback);
      const hi = finite(input.MAX) ? bound(input.MAX) : Math.max(lo + 1, fallback, 1);
      const min = Math.min(lo, hi), max = Math.max(lo, hi);
      params.push({ key: name, label, type: 'float', min, max, default: clamp(finite(input.DEFAULT) ? bound(input.DEFAULT) : min, min, max) });
      uniforms.push({ name, type: 'float', key: name });
    } else if (type === 'bool') {
      params.push({ key: name, label, type: 'bool', default: truthy(input.DEFAULT) });
      uniforms.push({ name, type: 'bool', key: name });
    } else if (type === 'event') {
      params.push({ key: name, label, type: 'bool', default: false, momentary: true });
      uniforms.push({ name, type: 'bool', key: name });
    } else if (type === 'long') {
      const param = longInput(input, name, label);
      params.push(param);
      uniforms.push({ name, type: 'long', key: name, values: param.isfValues });
    } else if (type === 'color') {
      const rgba = Array.isArray(input.DEFAULT) && input.DEFAULT.length >= 3 && input.DEFAULT.slice(0, 4).every(finite) ? input.DEFAULT : [1, 1, 1, 1];
      params.push({ key: name, label, type: 'color', default: `#${[0, 1, 2, 3].map(index => hexByte(rgba[index])).join('')}` });
      uniforms.push({ name, type: 'color', key: name });
    } else if (type === 'point2D') {
      const param = pointInput(input, name, label, warn);
      params.push(param);
      uniforms.push({ name, type: 'point', key: name, mode: param.isfPoint });
    } else if (type === 'image') {
      if (name === 'inputImage') images.push({ name, role: 'input' });
      else if (name === 'startImage' && transition) images.push({ name, role: 'start' });
      else if (name === 'endImage' && transition) images.push({ name, role: 'end' });
      else {
        params.push({ key: name, label, type: 'choice', options: [...ISF_IMAGE_SOURCES], default: 1, isfImage: true });
        images.push({ name, role: 'param', key: name });
      }
    } else if (type === 'audio' || type === 'audioFFT') {
      const count = finite(input.MAX) ? clamp(Math.trunc(input.MAX), 4, 4096) : 256;
      images.push({ name, role: type === 'audio' ? 'wave' : 'fft', count });
    } else {
      throw new Error(`Unsupported ISF input type ${JSON.stringify(String(type).slice(0, 20))} for "${name}".`);
    }
  }
  return { params, uniforms, images, names };
}

function readPasses(header, names, warn) {
  let raw = header.PASSES ?? [{}];
  if (!Array.isArray(raw)) throw new Error('ISF PASSES must be an array.');
  if (!raw.length) raw = [{}];
  if (raw.length > ISF_LIMITS.passes) throw new Error(`ISF shader has too many passes (limit ${ISF_LIMITS.passes}).`);
  // ISF v1 declared persistence in PERSISTENT_BUFFERS (array of names or object).
  const legacy = header.PERSISTENT_BUFFERS;
  const legacyObject = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy : null;
  const legacyNames = new Set(Array.isArray(legacy) ? legacy.filter(item => typeof item === 'string') : legacyObject ? Object.keys(legacyObject) : []);
  const variables = new Set(['WIDTH', 'HEIGHT', ...names]);
  const size = (value, index, axis) => {
    if (value === undefined || value === null || value === '') return null;
    try { return parseSizeExpression(value, variables); }
    catch (error) { warn(`Pass ${index + 1} ${axis}: ${error.message} It renders at full size.`); return null; }
  };
  return raw.map((pass, index) => {
    if (!pass || typeof pass !== 'object' || Array.isArray(pass)) throw new Error('ISF passes must be objects.');
    const target = pass.TARGET === undefined || pass.TARGET === null || pass.TARGET === '' ? null : pass.TARGET;
    if (target !== null) {
      checkName(target, 'pass target');
      if (names.has(target)) throw new Error(`ISF pass target "${target}" clashes with an input.`);
    }
    const entry = target && legacyObject && legacyObject[target] && typeof legacyObject[target] === 'object' ? legacyObject[target] : {};
    return {
      target, persistent: target !== null && (truthy(pass.PERSISTENT) || legacyNames.has(target)),
      float: truthy(pass.FLOAT) || truthy(entry.FLOAT),
      width: size(pass.WIDTH ?? entry.WIDTH, index, 'WIDTH'), height: size(pass.HEIGHT ?? entry.HEIGHT, index, 'HEIGHT'),
    };
  });
}
// ---------------------------------------------------------------- tokens

const TOKEN = /\s+|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[A-Za-z_][A-Za-z0-9_]*|0[xX][0-9a-fA-F]+[uU]?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFuU]?|[\s\S]/y;

function tokenize(code) {
  const tokens = [];
  for (let index = 0; index < code.length;) {
    TOKEN.lastIndex = index;
    const text = TOKEN.exec(code)[0];
    const type = /^\s/.test(text) ? 'ws' : text.startsWith('//') || text.startsWith('/*') ? 'comment'
      : /^[A-Za-z_]/.test(text) ? 'id' : /^\.?\d/.test(text) ? 'num' : 'punct';
    tokens.push({ type, text });
    index += text.length;
  }
  return tokens;
}

const significant = token => token.type !== 'ws' && token.type !== 'comment';
function nextSig(tokens, index) { for (let j = index + 1; j < tokens.length; j++) if (significant(tokens[j])) return j; return -1; }
function prevSig(tokens, index) { for (let j = index - 1; j >= 0; j--) if (significant(tokens[j])) return j; return -1; }
const textAt = (tokens, index) => index >= 0 && index < tokens.length ? tokens[index].text : '';
const PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

function checkBalance(tokens) {
  const stack = [];
  for (const token of tokens) {
    if (token.type !== 'punct') continue;
    if (PAIRS[token.text]) stack.push(PAIRS[token.text]);
    else if (CLOSERS.has(token.text) && stack.pop() !== token.text) throw new Error('Unbalanced brackets in ISF shader.');
  }
  if (stack.length) throw new Error('Unbalanced brackets in ISF shader.');
}

// Drop #version and #extension lines: the runtime supplies its own header.
function stripDirectives(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const directive = tokens[i].text === '#' ? textAt(tokens, nextSig(tokens, i)) : '';
    if (directive === 'version' || directive === 'extension') {
      while (i + 1 < tokens.length && !(tokens[i + 1].type === 'ws' && tokens[i + 1].text.includes('\n'))) i++;
      continue;
    }
    out.push(tokens[i]);
  }
  return out;
}

// Removes declarations the runtime provides (built-ins, inputs, buffers) and
// turns varyings into in/out. Custom uniforms are kept (they read as zero).
function rewriteDeclarations(tokens, { known, stage, hasVertex, warn }) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'id' && ['uniform', 'varying', 'attribute'].includes(token.text) && textAt(tokens, prevSig(tokens, i)) !== '.') {
      let end = i;
      while (end < tokens.length && tokens[end].text !== ';') end++;
      if (end >= tokens.length) throw new Error(`Unterminated ${token.text} declaration in ISF shader.`);
      const ids = tokens.slice(i, end).filter(item => item.type === 'id' && !QUALIFIERS.has(item.text)).map(item => item.text);
      const [type, ...names] = ids;
      if (!type || !names.length) throw new Error(`Malformed ${token.text} declaration in ISF shader.`);
      if (token.text === 'uniform') {
        const unknown = names.filter(name => !known.has(name));
        if (!unknown.length) { i = end; continue; }
        warn(`Custom uniform ${unknown.join(', ')} is not set by ISF and reads as zero.`);
        out.push(token);
        continue;
      }
      if (token.text === 'attribute') {
        if (stage === 'vertex') warn('Vertex attributes are not supplied; isf_vertShaderInit() sets the position.');
        i = end;
        continue;
      }
      const custom = names.filter(name => !BUILTINS.has(name));
      if (!custom.length) { i = end; continue; }
      if (stage === 'fragment' && !hasVertex) {
        // No vertex shader sets it: the declaration stays as a plain global.
        warn(`Varying ${custom.join(', ')} has no vertex shader to set it and reads as zero.`);
        continue;
      }
      out.push({ type: 'id', text: stage === 'vertex' ? 'out' : 'in' });
      continue;
    }
    out.push(token);
  }
  return out;
}

// User definitions of functions that GLSL ES 3.00 made built-in must be renamed.
function builtinOverrides(tokens) {
  const names = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'id' && ES3_FUNCTIONS.has(tokens[i].text) && textAt(tokens, nextSig(tokens, i)) === '(' && TYPES.has(textAt(tokens, prevSig(tokens, i)))) names.add(tokens[i].text);
  }
  return names;
}

function translate(tokens, rename, stage) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'id') { out += token.text; continue; }
    const name = token.text;
    if (textAt(tokens, prevSig(tokens, i)) === '.') { out += name; continue; } // swizzles and struct members
    const call = textAt(tokens, nextSig(tokens, i)) === '(';
    if (name === 'gl_FragData' && stage === 'fragment') {
      const a = nextSig(tokens, i), b = nextSig(tokens, a), c = nextSig(tokens, b);
      if (textAt(tokens, a) !== '[' || textAt(tokens, b) !== '0' || textAt(tokens, c) !== ']') throw new Error('gl_FragData with multiple render targets is not supported.');
      out += 'isf_FragColor';
      i = c;
      continue;
    }
    if (name === 'gl_FragColor' && stage === 'fragment') { out += 'isf_FragColor'; continue; }
    if (name === 'vv_FragNormCoord') { out += 'isf_FragNormCoord'; continue; }
    if (call && Object.hasOwn(GLSL1_FUNCTIONS, name)) { out += GLSL1_FUNCTIONS[name]; continue; }
    // A variable called "texture" would hide the ES3 texture() function.
    if (name === 'texture') { out += call ? name : 'isf_u_texture'; continue; }
    out += rename(name);
  }
  return out;
}

// ---------------------------------------------------------------- program text

const VERTEX_INIT = `void isf_vertShaderInit() {
  vec2 isf_p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  isf_FragNormCoord = isf_p;
  gl_Position = vec4(isf_p * 2.0 - 1.0, 0.0, 1.0);
}
`;
const UNIFORM_TYPES = { float: 'float', bool: 'bool', long: 'int', color: 'vec4', point: 'vec2' };

function preamble(stage, uniforms, samplers) {
  const lines = ['#version 300 es', 'precision highp float;', 'precision highp int;', 'precision highp sampler2D;',
    'uniform int PASSINDEX;', 'uniform vec2 RENDERSIZE;', 'uniform float TIME;', 'uniform float TIMEDELTA;', 'uniform vec4 DATE;', 'uniform int FRAMEINDEX;'];
  for (const uniform of uniforms) lines.push(`uniform ${UNIFORM_TYPES[uniform.type]} ${uniform.glsl};`);
  for (const name of samplers) lines.push(`uniform sampler2D ${name};`, `uniform vec2 _${name}_imgSize;`);
  lines.push(
    // textureSize gives the bound image's real size for any sampler,
    // including samplers passed into user functions.
    '#define IMG_SIZE(img) vec2(textureSize(img, 0))',
    '#define IMG_NORM_PIXEL(img, c) texture(img, c)',
    '#define IMG_PIXEL(img, c) texture(img, (c) / vec2(textureSize(img, 0)))',
    '#define IMG_THIS_PIXEL(img) texture(img, isf_FragNormCoord)',
    '#define IMG_THIS_NORM_PIXEL(img) texture(img, isf_FragNormCoord)',
    '#define IMG_NORM_PIXEL_2D(img, s, c) texture(img, c)',
    '#define IMG_PIXEL_2D(img, s, c) texture(img, (c) / (s))',
    '#define IMG_THIS_PIXEL_2D(img, s) texture(img, isf_FragNormCoord)',
    '#define IMG_THIS_NORM_PIXEL_2D(img, s) texture(img, isf_FragNormCoord)',
    '#define IMG_NORM_PIXEL_RECT(img, s, c) texture(img, c)',
    '#define IMG_PIXEL_RECT(img, s, c) texture(img, (c) / (s))',
    '#define IMG_THIS_PIXEL_RECT(img, s) texture(img, isf_FragNormCoord)',
    '#define ISF_PRISMVJ 1');
  if (stage === 'vertex') lines.push('out vec2 isf_FragNormCoord;', VERTEX_INIT, '#define vv_vertShaderInit isf_vertShaderInit');
  else lines.push('in vec2 isf_FragNormCoord;', 'out vec4 isf_FragColor;');
  return `${lines.join('\n')}\n`;
}

// GLSL ES only allows constant global initializers; desktop ISF shaders often
// write "vec2 center = RENDERSIZE * 0.5;". Such globals are declared without
// the initializer and assigned at the top of main(), which runs first.
const DECLARATION_START = new Set([...TYPES, 'mat2x2', 'mat3x3', 'mat4x4']);
function hoistGlobals(tokens) {
  const assignments = [];
  const out = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'punct' && token.text === '{') depth++;
    if (token.type === 'punct' && token.text === '}') depth--;
    // A global declaration: at file scope, starts with a type (after any precision qualifier).
    const lineStart = i === 0 || /\n/.test(tokens[i - 1]?.text || '') || [';', '}'].includes(textAt(tokens, prevSig(tokens, i))) || prevSig(tokens, i) < 0;
    if (depth === 0 && token.type === 'id' && DECLARATION_START.has(token.text) && lineStart && textAt(tokens, prevSig(tokens, i)) !== '#') {
      let end = i, nest = 0, isFunction = false;
      for (; end < tokens.length; end++) {
        const text = tokens[end].type === 'punct' ? tokens[end].text : '';
        if (text === '(' || text === '[') { if (text === '(' && nest === 0 && !tokens.slice(i, end).some(item => item.text === '=')) { isFunction = true; break; } nest++; }
        else if (text === ')' || text === ']') nest--;
        else if (text === ';' && nest === 0) break;
        else if (text === '{' && nest === 0) { isFunction = true; break; }
      }
      const statement = tokens.slice(i, end);
      if (!isFunction && end < tokens.length && statement.some(item => item.type === 'punct' && item.text === '=')) {
        // Split top-level declarators: "float a = 1.0, b = x;".
        const parts = [[]];
        let level = 0;
        for (const item of statement) {
          if (item.type === 'punct' && ['(', '['].includes(item.text)) level++;
          if (item.type === 'punct' && [')', ']'].includes(item.text)) level--;
          if (item.type === 'punct' && item.text === ',' && level === 0) { parts.push([]); continue; }
          parts[parts.length - 1].push(item);
        }
        const declared = [];
        let type = null;
        parts.forEach((part, index) => {
          const equals = part.findIndex(item => item.type === 'punct' && item.text === '=');
          const head = equals < 0 ? part : part.slice(0, equals);
          if (index === 0) {
            const names = head.filter(significant);
            const nameIndex = names.findIndex((item, at) => item.type === 'id' && !QUALIFIERS.has(item.text) && !DECLARATION_START.has(item.text) && at > 0);
            type = names.slice(0, nameIndex).map(item => item.text).join(' ');
            declared.push(names.slice(nameIndex).map(item => item.text).join(''));
          } else declared.push(head.filter(significant).map(item => item.text).join(''));
          const target = declared[declared.length - 1].replace(/\[.*$/, '');
          if (equals >= 0) assignments.push(`${target} = ${part.slice(equals + 1).map(item => item.text).join('').trim()};`);
        });
        out.push(...tokenize(`${type} ${declared.join(', ')};`));
        i = end;
        continue;
      }
    }
    out.push(token);
  }
  if (!assignments.length) return tokens;
  // Insert after main's opening brace.
  for (let i = 0; i < out.length; i++) {
    if (out[i].type === 'id' && out[i].text === 'main' && textAt(out, nextSig(out, i)) === '(') {
      const close = out.findIndex((item, index) => index > i && item.text === ')');
      const brace = nextSig(out, close);
      if (textAt(out, brace) !== '{') continue;
      out.splice(brace + 1, 0, ...tokenize(`\n  ${assignments.join('\n  ')}\n`));
      return out;
    }
  }
  return tokens;
}

function prepareStage(code, stage, ctx) {
  let tokens = stripDirectives(tokenize(code));
  checkBalance(tokens);
  tokens = hoistGlobals(rewriteDeclarations(tokens, { ...ctx, stage }));
  if (!tokens.some((token, index) => token.type === 'id' && token.text === 'main' && textAt(tokens, nextSig(tokens, index)) === '(')) {
    throw new Error(`ISF ${stage} shader has no main() function.`);
  }
  for (const name of builtinOverrides(tokens)) ctx.overrides.add(name);
  return tokens;
}

function baseName(fileName) {
  return String(fileName ?? '').slice(0, 512).split(/[\\/]/).pop().replace(/\.(fs|frag|glsl|isf|txt)$/i, '');
}

export function isfKind(header) {
  const inputs = Array.isArray(header?.INPUTS) ? header.INPUTS : [];
  const names = new Set(inputs.map(input => input?.NAME));
  if (names.has('startImage') && names.has('endImage')) return 'transition';
  return names.has('inputImage') ? 'effect' : 'source';
}

// ---------------------------------------------------------------- entry point

// Parse one ISF fragment shader (and optional vertex shader). Returns
// { definition, kind: 'effect'|'source'|'transition', warnings }; throws for
// invalid or unsupported shaders. `id` overrides the id derived from the file
// name; `assets` maps imported/bundled image names or paths to data: URLs;
// `link`/`author` describe where an online shader came from.
export function parseISF(text, { fileName = '', vertex = '', id = '', assets = null, link = '', author = '' } = {}) {
  if (typeof text !== 'string') throw new TypeError('ISF source must be a string.');
  if (text.length > ISF_LIMITS.text) throw new Error(`ISF shader is too large (limit ${ISF_LIMITS.text / 1024} KB).`);
  if (typeof vertex !== 'string' || vertex.length > ISF_LIMITS.text) throw new Error('ISF vertex shader is invalid or too large.');
  if (text.includes('\0') || vertex.includes('\0')) throw new Error('ISF shader contains binary data.');
  const warnings = new Set();
  const warn = message => { if (warnings.size < 64) warnings.add(message); };
  const { header, body } = splitHeader(text);
  const inputs = readInputs(header, warn);
  const passes = readPasses(header, inputs.names, warn);
  let kind = isfKind(header);
  if (kind === 'source' && /\binputImage\b/.test(body)) {
    kind = 'effect';
    inputs.images.push({ name: 'inputImage', role: 'input' });
    warn('inputImage is used without being declared; it is treated as the effect input.');
  }
  if (kind === 'transition' && !inputs.uniforms.some(uniform => uniform.role === 'progress')) {
    if (inputs.names.has('progress')) throw new Error('A transition\'s "progress" input must be a float.');
    inputs.uniforms.push({ name: 'progress', type: 'float', role: 'progress' });
    warn('Transition has no "progress" input; one is supplied.');
  }
  for (const image of importedImages(header)) {
    if (inputs.names.has(image.name)) throw new Error(`Imported image "${image.name}" clashes with an input.`);
    inputs.images.push({ name: image.name, role: 'imported', path: image.path });
  }
  for (const name of new Set(passes.map(pass => pass.target).filter(Boolean))) {
    if (inputs.images.some(image => image.name === name)) throw new Error(`ISF pass target "${name}" clashes with an image.`);
    inputs.images.push({ name, role: 'buffer' });
  }
  if (inputs.images.length > ISF_LIMITS.images) throw new Error(`ISF shader uses too many images and buffers (limit ${ISF_LIMITS.images}).`);

  const known = new Set([...BUILTINS, ...inputs.names, ...inputs.images.map(image => image.name)]);
  const hasVertex = /\bmain\s*\(/.test(vertex);
  const overrides = new Set();
  const ctx = { known, hasVertex, warn, overrides };
  // Built-in overrides found in either stage are renamed in both.
  const fragmentTokens = prepareStage(body, 'fragment', ctx);
  const vertexTokens = hasVertex ? prepareStage(vertex, 'vertex', ctx) : null;
  const rename = name => ES3_RESERVED.has(name) || overrides.has(name) ? `isf_u_${name}` : name;
  for (const uniform of inputs.uniforms) uniform.glsl = rename(uniform.name);
  for (const image of inputs.images) image.glsl = rename(image.name);
  const samplers = inputs.images.map(image => image.glsl);
  const program = {
    fragment: preamble('fragment', inputs.uniforms, samplers) + translate(fragmentTokens, rename, 'fragment'),
    vertex: preamble('vertex', inputs.uniforms, samplers) + (vertexTokens ? translate(vertexTokens, rename, 'vertex') : 'void main() {\n  isf_vertShaderInit();\n}\n'),
  };

  const base = baseName(fileName);
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'shader';
  const categories = Array.isArray(header.CATEGORIES) ? header.CATEGORIES.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 40)).slice(0, 8) : [];
  const definition = {
    id: id || `isf:${slug}`,
    name: base.replace(/_+/g, ' ').trim().slice(0, 80) || 'ISF Shader',
    category: categories[0] || 'ISF',
    categories,
    params: inputs.params,
    isf: Object.freeze({
      kind, program, passes, uniforms: inputs.uniforms, images: inputs.images,
      assets: assets && typeof assets === 'object' ? Object.freeze({ ...assets }) : null,
    }),
  };
  if (typeof header.DESCRIPTION === 'string' && header.DESCRIPTION.trim()) definition.description = header.DESCRIPTION.trim().slice(0, 500);
  const credit = typeof header.CREDIT === 'string' ? header.CREDIT.trim().slice(0, 200) : '';
  if (credit || author) definition.credit = (credit || String(author)).slice(0, 200);
  if (typeof link === 'string' && /^https:\/\/editor\.isf\.video\/shaders\/[a-f0-9]{24}$/.test(link)) definition.link = link;
  return { definition, kind, warnings: [...warnings] };
}