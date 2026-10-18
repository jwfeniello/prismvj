// ISF (Interactive Shader Format, https://github.com/mrRay/ISF_Spec) import.
// parseISF turns one .fs file into an effect or source definition for
// shader-template.js: the JSON header becomes params and passes, and the GLSL
// body is rewritten token by token (ISF built-ins, inputs, GLSL 1.x idioms)
// and wrapped in fx()/gen(). Shaders come from untrusted files, so every size
// is bounded and nothing is evaluated.
import { uniformName } from './shader-template.js';

export const ISF_LIMITS = Object.freeze({ text: 256 * 1024, header: 64 * 1024, inputs: 64, passes: 8, values: 256, depth: 128 });
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// point2D values are render-target pixels; defaults are normalized against MAX
// when it looks like a canvas size, otherwise against this reference size.
const POINT_REFERENCE = [640, 480];
const FRAG_NORM = new Set(['isf_FragNormCoord', 'vv_FragNormCoord']);
const BUILTINS = new Set(['RENDERSIZE', 'TIME', 'TIMEDELTA', 'FRAMEINDEX', 'DATE', 'PASSINDEX', ...FRAG_NORM]);
// Identifiers the template already defines; user code using them is renamed.
const TEMPLATE_NAMES = new Set(['PI', 'TAU', 'luma', 'rgb2hsv', 'hsv2rgb', 'hash12', 'noise2', 'rotate2', 'unpremultiply',
  'src', 'orig', 'prev', 'uv', 'frag', 'fx', 'gen', 'uImage', 'uOriginal', 'uPrevious', 'uResolution', 'uAspect', 'uTime',
  'uBeat', 'uAudio', 'uPass']);
// Legal identifiers in GLSL 1.x that GLSL ES 3.00 reserves.
const ES3_RESERVED = new Set(['sample', 'input', 'output', 'filter', 'smooth', 'flat', 'layout', 'centroid', 'active', 'common',
  'partition', 'half', 'fixed', 'patch', 'resource', 'union', 'enum', 'class', 'template', 'this', 'inline', 'noinline', 'public',
  'static', 'extern', 'external', 'interface', 'long', 'short', 'double', 'unsigned', 'superp', 'namespace', 'using', 'sizeof',
  'cast', 'goto', 'asm', 'volatile', 'coherent', 'restrict', 'readonly', 'writeonly', 'noperspective', 'subroutine', 'buffer',
  'shared', 'packed', 'uint', 'switch', 'case']);
// GLSL ES 3.00 built-ins that GLSL 1.x shaders often define themselves.
const ES3_FUNCTIONS = new Set(['round', 'roundEven', 'trunc', 'inverse', 'transpose', 'determinant', 'outerProduct', 'isnan',
  'isinf', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh', 'modf', 'textureSize', 'texelFetch', 'textureOffset',
  'textureProj', 'textureLod', 'textureGrad', 'dFdx', 'dFdy', 'fwidth', 'floatBitsToInt', 'intBitsToFloat', 'packHalf2x16',
  'unpackHalf2x16']);
const TYPES = new Set(['void', 'float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3',
  'bvec4', 'mat2', 'mat3', 'mat4', 'highp', 'mediump', 'lowp']);
const QUALIFIERS = new Set(['uniform', 'varying', 'attribute', 'const', 'highp', 'mediump', 'lowp', 'in', 'out', 'flat', 'smooth', 'invariant', 'centroid']);
const SAMPLE_CALLS = {
  IMG_PIXEL: 'pixel', IMG_PIXEL_2D: 'pixel', IMG_PIXEL_RECT: 'pixel',
  IMG_NORM_PIXEL: 'norm', IMG_NORM_PIXEL_2D: 'norm', IMG_NORM_PIXEL_RECT: 'norm',
  IMG_THIS_PIXEL: 'this', IMG_THIS_NORM_PIXEL: 'this', IMG_THIS_PIXEL_2D: 'this', IMG_THIS_NORM_PIXEL_2D: 'this',
  IMG_SIZE: 'size',
  texture2D: 'norm', texture: 'norm', texture2DLod: 'norm', textureLod: 'norm', texture2DRect: 'pixel',
};
const GLSL1_FUNCTIONS = { texture2D: 'texture', texture2DLod: 'textureLod', texture2DProj: 'textureProj', texture2DProjLod: 'textureProjLod',
  texture2DRect: 'texture', textureCube: 'texture', textureCubeLod: 'textureLod', texture2DLodEXT: 'textureLod', texture2DGradEXT: 'textureGrad' };
const NOTES = { DATE: 'DATE is approximated (fixed date; seconds follow TIME).', TIMEDELTA: 'TIMEDELTA is approximated as 1/60 s.' };

const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const bound = value => clamp(value, -1e6, 1e6);
const truthy = value => value === true || (finite(value) && value > 0) || value === 'true' || value === '1';

// ---------------------------------------------------------------- header

function stripJSONComments(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1;
      out += raw.slice(i, j + 1);
      i = j;
    } else if (c === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2);
      i = end < 0 ? raw.length : end + 1;
      out += ' ';
    } else out += c;
  }
  return out;
}

function stripTrailingCommas(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j += raw[j] === '\\' ? 2 : 1;
      out += raw.slice(i, j + 1);
      i = j;
    } else if (c === ',') {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      if (raw[j] !== '}' && raw[j] !== ']') out += c;
    } else out += c;
  }
  return out;
}

function splitHeader(text) {
  const start = text.search(/[^\s\uFEFF]/);
  if (start < 0 || !text.startsWith('/*', start)) throw new Error('Not an ISF shader: missing the leading /*{ JSON }*/ header.');
  const end = text.indexOf('*/', start + 2);
  if (end < 0) throw new Error('ISF header comment is not closed.');
  const raw = text.slice(start + 2, end);
  if (raw.length > ISF_LIMITS.header) throw new Error('ISF JSON header is too large.');
  let header;
  try { header = JSON.parse(stripTrailingCommas(stripJSONComments(raw))); }
  catch (error) { throw new Error(`Invalid ISF JSON header: ${error.message}`); }
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('ISF JSON header must be an object.');
  return { header, body: text.slice(end + 2) };
}

// ---------------------------------------------------------------- inputs

const pair = value => Array.isArray(value) && value.length >= 2 && finite(value[0]) && finite(value[1]) ? [bound(value[0]), bound(value[1])] : null;
const hexByte = value => Math.round(clamp(finite(value) ? value : 1, 0, 1) * 255).toString(16).padStart(2, '0');

function checkName(name, what) {
  if (typeof name !== 'string' || !NAME.test(name) || name.startsWith('gl_') || name.startsWith('isf_')) {
    throw new Error(`Invalid ISF ${what} name ${JSON.stringify(String(name).slice(0, 40))}.`);
  }
  if (BUILTINS.has(name)) throw new Error(`ISF ${what} name "${name}" clashes with an ISF built-in.`);
}

function longInput(input, name, label, helpers) {
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
  const uniform = uniformName(name);
  let replacement = uniform;
  if (!values.every((value, index) => value === index)) {
    // The stored param is the option index; the shader sees the ISF VALUE.
    const n = values.length;
    helpers.push(`int isf_long_${name}() {\n  const int values[${n}] = int[${n}](${values.join(', ')});\n  return values[clamp(${uniform}, 0, ${n - 1})];\n}`);
    replacement = `isf_long_${name}()`;
  }
  return { param: { key: name, label, type: 'choice', options, default: Math.max(0, found), isfValues: values }, replacement };
}

function pointInput(input, name, label, warn) {
  const def = pair(input.DEFAULT), min = pair(input.MIN), max = pair(input.MAX);
  const uniform = uniformName(name);
  if (max && max[0] <= 1 && max[1] <= 1) {
    // Authored with normalized coordinates (MAX <= 1): pass through unchanged.
    const lo = min ? Math.min(min[0], min[1]) : 0, hi = Math.max(max[0], max[1], lo);
    const value = def ? def.map(item => clamp(item, lo, hi)) : [(lo + hi) / 2, (lo + hi) / 2];
    return { param: { key: name, label, type: 'point', min: lo, max: hi, default: value, isfPoint: 'normalized' }, replacement: uniform };
  }
  // Pixel coordinates: the param stores a 0..1 fraction of the frame and the
  // shader sees it scaled back to pixels of the current render size.
  const reference = max && max[0] > 1 && max[1] > 1 ? max : POINT_REFERENCE;
  if (def && reference === POINT_REFERENCE && (def[0] || def[1])) warn(`point2D "${name}" default assumed relative to a ${POINT_REFERENCE.join('x')} canvas.`);
  const lo = min ? clamp(Math.min(min[0] / reference[0], min[1] / reference[1]), -1, 0) : 0;
  const value = def ? [clamp(def[0] / reference[0], lo, 1), clamp(def[1] / reference[1], lo, 1)] : [0.5, 0.5];
  return { param: { key: name, label, type: 'point', min: lo, max: 1, default: value, isfPoint: 'pixels', isfReference: [...reference] }, replacement: `(${uniform} * uResolution)` };
}

function readInputs(header, warn) {
  const raw = header.INPUTS ?? [];
  if (!Array.isArray(raw)) throw new Error('ISF INPUTS must be an array.');
  if (raw.length > ISF_LIMITS.inputs) throw new Error(`ISF shader has too many inputs (limit ${ISF_LIMITS.inputs}).`);
  const params = [], helpers = [], replacements = new Map(), images = new Map();
  let hasInputImage = false;
  for (const input of raw) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ISF inputs must be objects.');
    const { NAME: name, TYPE: type } = input;
    checkName(name, 'input');
    if (replacements.has(name) || images.has(name)) throw new Error(`Duplicate ISF input "${name}".`);
    const label = typeof input.LABEL === 'string' && input.LABEL.trim() ? input.LABEL.trim().slice(0, 64) : name;
    const uniform = uniformName(name);
    if (type === 'float') {
      const fallback = finite(input.DEFAULT) ? bound(input.DEFAULT) : 0;
      const lo = finite(input.MIN) ? bound(input.MIN) : Math.min(0, fallback);
      const hi = finite(input.MAX) ? bound(input.MAX) : Math.max(lo + 1, fallback, 1);
      const min = Math.min(lo, hi), max = Math.max(lo, hi);
      params.push({ key: name, label, type: 'float', min, max, default: clamp(finite(input.DEFAULT) ? bound(input.DEFAULT) : min, min, max) });
      replacements.set(name, uniform);
    } else if (type === 'bool') {
      params.push({ key: name, label, type: 'bool', default: truthy(input.DEFAULT) });
      replacements.set(name, uniform);
    } else if (type === 'event') {
      params.push({ key: name, label, type: 'bool', default: false, momentary: true });
      replacements.set(name, uniform);
    } else if (type === 'long') {
      const { param, replacement } = longInput(input, name, label, helpers);
      params.push(param);
      replacements.set(name, replacement);
    } else if (type === 'color') {
      const rgba = Array.isArray(input.DEFAULT) && input.DEFAULT.length >= 3 && input.DEFAULT.slice(0, 4).every(finite) ? input.DEFAULT : [1, 1, 1, 1];
      params.push({ key: name, label, type: 'color', default: `#${[0, 1, 2, 3].map(index => hexByte(rgba[index])).join('')}` });
      replacements.set(name, uniform);
    } else if (type === 'point2D') {
      const { param, replacement } = pointInput(input, name, label, warn);
      params.push(param);
      replacements.set(name, replacement);
    } else if (type === 'image') {
      if (name === 'inputImage') { hasInputImage = true; images.set(name, { kind: 'input' }); continue; }
      warn(`Image input "${name}" is not supported and reads as transparent black.`);
      images.set(name, { kind: 'blank' });
    } else if (type === 'audio' || type === 'audioFFT') {
      const count = finite(input.MAX) ? clamp(Math.trunc(input.MAX), 1, 4096) : 256;
      warn(`${type} input "${name}" is approximated from the live audio levels.`);
      images.set(name, { kind: type === 'audio' ? 'wave' : 'fft', size: `vec2(${count}.0, 1.0)` });
    } else {
      throw new Error(`Unsupported ISF input type ${JSON.stringify(String(type).slice(0, 20))} for "${name}".`);
    }
  }
  if (images.has('startImage') && images.has('endImage')) throw new Error('ISF transitions (startImage/endImage) are not supported.');
  return { params, helpers, replacements, images, hasInputImage };
}

// ---------------------------------------------------------------- passes

function readPasses(header, inputs, warn) {
  let raw = header.PASSES ?? [{}];
  if (!Array.isArray(raw)) throw new Error('ISF PASSES must be an array.');
  if (!raw.length) raw = [{}];
  if (raw.length > ISF_LIMITS.passes) throw new Error(`ISF shader has too many passes (limit ${ISF_LIMITS.passes}).`);
  // ISF v1 declared persistence in PERSISTENT_BUFFERS (array of names or object).
  const legacy = header.PERSISTENT_BUFFERS;
  const legacyObject = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy : null;
  const legacyNames = new Set(Array.isArray(legacy) ? legacy.filter(item => typeof item === 'string') : legacyObject ? Object.keys(legacyObject) : []);
  const targets = new Map();
  const passes = raw.map((pass, index) => {
    if (!pass || typeof pass !== 'object' || Array.isArray(pass)) throw new Error('ISF passes must be objects.');
    const target = pass.TARGET === undefined || pass.TARGET === null || pass.TARGET === '' ? null : pass.TARGET;
    if (target !== null) {
      checkName(target, 'pass target');
      if (inputs.images.has(target) || inputs.replacements.has(target)) throw new Error(`ISF pass target "${target}" clashes with an input.`);
      if (targets.has(target)) throw new Error(`ISF pass target "${target}" is written by more than one pass.`);
      targets.set(target, index);
    }
    const entry = target && legacyObject && Object.hasOwn(legacyObject, target) ? legacyObject[target] : null;
    const legacyEntry = entry && typeof entry === 'object' ? entry : {};
    if (truthy(pass.FLOAT) || truthy(legacyEntry.FLOAT)) warn(`Pass ${index + 1} asks for a FLOAT target; it renders at 8-bit precision.`);
    if (pass.WIDTH !== undefined || pass.HEIGHT !== undefined || legacyEntry.WIDTH !== undefined || legacyEntry.HEIGHT !== undefined) {
      warn(`Pass ${index + 1} has a custom WIDTH/HEIGHT; it renders at full resolution.`);
    }
    return { target, persistent: target !== null && (truthy(pass.PERSISTENT) || legacyNames.has(target)) };
  });
  return { passes, targets };
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

function matching(tokens, open) {
  const opener = textAt(tokens, open), closer = PAIRS[opener];
  if (!closer) throw new Error('Malformed GLSL in ISF shader (expected a bracket).');
  for (let j = open, depth = 0; j < tokens.length; j++) {
    if (tokens[j].type !== 'punct') continue;
    if (tokens[j].text === opener) depth++;
    else if (tokens[j].text === closer && --depth === 0) return j;
  }
  throw new Error('Unbalanced brackets in ISF shader.');
}

function checkBalance(tokens) {
  const stack = [];
  for (const token of tokens) {
    if (token.type !== 'punct') continue;
    if (PAIRS[token.text]) stack.push(PAIRS[token.text]);
    else if (CLOSERS.has(token.text) && stack.pop() !== token.text) throw new Error('Unbalanced brackets in ISF shader.');
  }
  if (stack.length) throw new Error('Unbalanced brackets in ISF shader.');
}

// Drop #version and #extension lines: the template supplies its own header.
function stripDirectives(tokens, warn) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const directive = tokens[i].text === '#' ? textAt(tokens, nextSig(tokens, i)) : '';
    if (directive === 'version' || directive === 'extension') {
      if (directive === 'extension') warn('#extension directives are ignored.');
      while (i + 1 < tokens.length && !(tokens[i + 1].type === 'ws' && tokens[i + 1].text.includes('\n'))) i++;
      continue;
    }
    out.push(tokens[i]);
  }
  return out;
}

// Remove declarations the host provides (ISF built-ins, inputs, the normalized
// coordinate varying) and reject vertex-shader dependencies.
function stripDeclarations(tokens, known, images, warn) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'id' && (token.text === 'uniform' || token.text === 'varying' || token.text === 'attribute')) {
      let end = i;
      while (end < tokens.length && tokens[end].text !== ';') end++;
      if (end >= tokens.length) throw new Error(`Unterminated ${token.text} declaration in ISF shader.`);
      const ids = tokens.slice(i, end).filter(item => item.type === 'id' && !QUALIFIERS.has(item.text)).map(item => item.text);
      const [type, ...names] = ids;
      if (!type || !names.length) throw new Error(`Malformed ${token.text} declaration in ISF shader.`);
      if (token.text === 'attribute') throw new Error('ISF shader declares vertex attributes; custom vertex shaders (.vs) are not supported.');
      if (token.text === 'varying') {
        const custom = names.filter(name => !FRAG_NORM.has(name));
        if (custom.length) throw new Error(`ISF shader relies on custom varyings (${custom.join(', ')}) from a vertex shader (.vs), which is not supported.`);
        i = end;
        continue;
      }
      const unknown = names.filter(name => !known.has(name));
      if (unknown.length && /^sampler/.test(type)) {
        for (const name of unknown) images.set(name, { kind: 'blank' });
        warn(`Sampler uniform ${unknown.join(', ')} is not bound and reads as transparent black.`);
        i = end;
        continue;
      }
      if (!unknown.length) { i = end; continue; }
      warn(`Custom uniform ${unknown.join(', ')} is not bound and reads as zero.`);
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

// ---------------------------------------------------------------- PASSINDEX branches

const FLIP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==', '!=': '!=' };
function passCondition(tokens, passIndex) {
  let text = tokens.filter(significant).map(token => token.text).join('');
  while (/^\(.*\)$/.test(text)) text = text.slice(1, -1);
  let match = /^PASSINDEX(==|!=|<=|>=|<|>)(\d+)$/.exec(text), op, value;
  if (match) [, op, value] = match;
  else if ((match = /^(\d+)(==|!=|<=|>=|<|>)PASSINDEX$/.exec(text))) { value = match[1]; op = FLIP[match[2]]; }
  else return null;
  value = Number(value);
  return { '==': passIndex === value, '!=': passIndex !== value, '<': passIndex < value, '>': passIndex > value, '<=': passIndex <= value, '>=': passIndex >= value }[op];
}

// Index of the last token of the statement starting at `start`.
function statementEnd(tokens, start, depth = 0) {
  if (start < 0 || depth > ISF_LIMITS.depth) throw new Error('Malformed or too deeply nested GLSL in ISF shader.');
  const text = tokens[start].text;
  if (text === '{') return matching(tokens, start);
  if (text === 'if' || text === 'for' || text === 'while') {
    const close = matching(tokens, nextSig(tokens, start));
    let end = statementEnd(tokens, nextSig(tokens, close), depth + 1);
    const next = nextSig(tokens, end);
    if (text === 'if' && textAt(tokens, next) === 'else') end = statementEnd(tokens, nextSig(tokens, next), depth + 1);
    return end;
  }
  for (let j = start, nest = 0; j < tokens.length; j++) {
    const item = tokens[j];
    if (item.type !== 'punct') continue;
    if (PAIRS[item.text]) nest++;
    else if (CLOSERS.has(item.text)) nest--;
    else if (item.text === ';' && nest === 0) return j;
  }
  throw new Error('Unterminated statement in ISF shader.');
}

// Resolve `if (PASSINDEX == n)` style branches for one pass, so each pass body
// only contains (and is validated against) the code it actually runs.
function pruneBranches(tokens, passIndex, depth = 0) {
  if (depth > ISF_LIMITS.depth) throw new Error('ISF shader nests PASSINDEX branches too deeply.');
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'id' && token.text === 'if' && textAt(tokens, prevSig(tokens, i)) !== '#') {
      const open = nextSig(tokens, i);
      if (textAt(tokens, open) === '(') {
        const close = matching(tokens, open);
        const result = passCondition(tokens.slice(open + 1, close), passIndex);
        if (result !== null) {
          const thenStart = nextSig(tokens, close), thenEnd = statementEnd(tokens, thenStart);
          let end = thenEnd, keep = result ? [thenStart, thenEnd] : null;
          const next = nextSig(tokens, thenEnd);
          if (textAt(tokens, next) === 'else') {
            const elseStart = nextSig(tokens, next);
            end = statementEnd(tokens, elseStart);
            if (!result) keep = [elseStart, end];
          }
          if (keep) for (const item of pruneBranches(tokens.slice(keep[0], keep[1] + 1), passIndex, depth + 1)) out.push(item);
          else out.push({ type: 'punct', text: ';' });
          i = end;
          continue;
        }
      }
    }
    out.push(token);
  }
  return out;
}
// ---------------------------------------------------------------- translation

function splitArgs(tokens, open) {
  const close = matching(tokens, open);
  const args = [[]];
  for (let j = open + 1, nest = 0; j < close; j++) {
    const text = tokens[j].type === 'punct' ? tokens[j].text : '';
    if (PAIRS[text]) nest++;
    else if (CLOSERS.has(text)) nest--;
    if (text === ',' && nest === 0) { args.push([]); continue; }
    args[args.length - 1].push(tokens[j]);
  }
  return { args: args.length === 1 && !args[0].some(significant) ? [] : args, close };
}

function sampleExpression(image, mode, coord, used) {
  const size = image.size || 'uResolution';
  if (mode === 'size') return size;
  const p = mode === 'this' ? 'uv' : mode === 'pixel' ? `((${coord}) / ${size})` : `(${coord})`;
  if (image.kind === 'src' || image.kind === 'orig' || image.kind === 'prev') return `${image.kind}(${p})`;
  if (image.kind === 'fft' || image.kind === 'wave') { used.add(image.kind); return `isf_audio_${image.kind}(${p})`; }
  return 'vec4(0.0)';
}

function translate(tokens, ctx, depth = 0) {
  if (depth > ISF_LIMITS.depth) throw new Error('ISF shader nests image lookups too deeply.');
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'id') { out += token.text; continue; }
    const name = token.text;
    // Member access / swizzles keep their name (only clashing names are renamed).
    if (textAt(tokens, prevSig(tokens, i)) === '.') { out += ctx.rename(name) ? `isf_u_${name}` : name; continue; }
    const next = nextSig(tokens, i);
    const call = textAt(tokens, next) === '(';
    if (call && Object.hasOwn(SAMPLE_CALLS, name)) {
      const { args, close } = splitArgs(tokens, next);
      const first = args[0]?.filter(significant) || [];
      const image = first.length === 1 && first[0].type === 'id' ? ctx.image(first[0].text) : null;
      if (image) {
        const mode = SAMPLE_CALLS[name];
        const wanted = mode === 'this' || mode === 'size' ? 1 : 2;
        if (args.length < wanted || (wanted === 1 && args.length > 1)) throw new Error(`${name}() called with the wrong number of arguments.`);
        out += sampleExpression(image, mode, wanted === 2 ? translate(args[1], ctx, depth + 1).trim() : '', ctx.used);
        i = close;
        continue;
      }
      if (name.startsWith('IMG_')) throw new Error(`${name}() must name an image input directly.`);
    }
    if (ctx.image(name)) throw new Error(`Image "${name}" can only be read through IMG_PIXEL/IMG_NORM_PIXEL/IMG_THIS_PIXEL/IMG_SIZE.`);
    if (name === 'gl_FragData') {
      const a = nextSig(tokens, i), b = nextSig(tokens, a), c = nextSig(tokens, b);
      if (textAt(tokens, a) !== '[' || textAt(tokens, b) !== '0' || textAt(tokens, c) !== ']') throw new Error('gl_FragData with multiple render targets is not supported.');
      out += 'isf_FragColor';
      i = c;
      continue;
    }
    if (Object.hasOwn(NOTES, name)) ctx.warn(NOTES[name]);
    if (name === 'texture' && !call) out += 'isf_u_texture';
    else if (ctx.replacements.has(name)) out += ctx.replacements.get(name);
    else out += ctx.rename(name) ? `isf_u_${name}` : name;
  }
  return out;
}

const AUDIO_HELPERS = {
  fft: 'vec4 isf_audio_fft(vec2 p) {\n  float x = clamp(p.x, 0.0, 1.0);\n  float v = x < 0.5 ? mix(uAudio.x, uAudio.y, x * 2.0) : mix(uAudio.y, uAudio.z, x * 2.0 - 1.0);\n  return vec4(vec3(v), 1.0);\n}',
  wave: 'vec4 isf_audio_wave(vec2 p) {\n  return vec4(vec3(0.5 + 0.5 * uAudio.w * sin(p.x * 62.83185 + uTime * 12.0)), 1.0);\n}',
};

function passContext(shared, passIndex) {
  const { kind, inputs, passes, targets, warn } = shared;
  const last = passes.length - 1;
  const replacements = new Map([
    ['RENDERSIZE', 'uResolution'], ['TIME', 'uTime'], ['TIMEDELTA', '(1.0 / 60.0)'], ['FRAMEINDEX', 'int(uTime * 60.0)'],
    ['DATE', 'vec4(2024.0, 1.0, 1.0, mod(uTime, 86400.0))'], ['PASSINDEX', String(passIndex)],
    ['isf_FragNormCoord', 'uv'], ['vv_FragNormCoord', 'uv'], ['gl_FragCoord', 'vec4(uv * uResolution, 0.0, 1.0)'],
    ['gl_FragColor', 'isf_FragColor'], ['main', 'isf_main'], ...Object.entries(GLSL1_FUNCTIONS), ...inputs.replacements,
  ]);
  const image = name => {
    const input = inputs.images.get(name);
    if (input) return input.kind === 'input' ? { kind: passIndex === 0 ? 'src' : 'orig' } : input;
    if (!targets.has(name)) return null;
    const writer = targets.get(name), pass = passes[writer];
    if (kind === 'source') {
      if (pass.persistent) throw new Error('Feedback (PERSISTENT buffer) ISF generators are not supported.');
      warn(`Buffer "${name}" is read before it is rendered and reads as transparent black.`);
      return { kind: 'blank' };
    }
    if (writer === passIndex - 1) return { kind: 'src' };
    if (passIndex <= writer) {
      if (!pass.persistent) {
        warn(`Pass ${passIndex + 1} reads buffer "${name}" before it is rendered; it reads as transparent black.`);
        return { kind: 'blank' };
      }
      if (writer !== last) warn(`Persistent buffer "${name}" is approximated by the effect's previous output.`);
      shared.feedbackTargets.add(name);
      return { kind: 'prev' };
    }
    throw new Error(`Pass ${passIndex + 1} reads buffer "${name}" written by pass ${writer + 1}; only the immediately preceding pass can be read.`);
  };
  return { replacements, image, rename: shared.rename, used: shared.used, warn };
}

function wrap(kind, helpers, body) {
  return `// Imported ISF shader.\nvec4 isf_FragColor;\n${helpers.map(item => `${item}\n`).join('')}${body.trim()}\nvec4 ${kind === 'effect' ? 'fx' : 'gen'}(vec2 isf_uv) {\n  isf_FragColor = vec4(0.0);\n  isf_main();\n  return isf_FragColor;\n}\n`;
}

function baseName(fileName) {
  return String(fileName ?? '').slice(0, 512).split(/[\\/]/).pop().replace(/\.(fs|frag|glsl|isf|txt)$/i, '');
}

// ---------------------------------------------------------------- entry point

// Parse one ISF fragment shader. Returns { definition, kind, warnings } where
// definition follows shader-template.js; throws Error for invalid or
// unsupported shaders.
export function parseISF(text, { fileName = '' } = {}) {
  if (typeof text !== 'string') throw new TypeError('ISF source must be a string.');
  if (text.length > ISF_LIMITS.text) throw new Error(`ISF shader is too large (limit ${ISF_LIMITS.text / 1024} KB).`);
  if (text.includes('\0')) throw new Error('ISF shader contains binary data.');
  const warnings = new Set();
  const warn = message => { if (warnings.size < 64) warnings.add(message); };
  const { header, body } = splitHeader(text);
  const inputs = readInputs(header, warn);
  const { passes, targets } = readPasses(header, inputs, warn);
  let kind = inputs.hasInputImage ? 'effect' : 'source';
  if (kind === 'source' && /\binputImage\b/.test(body)) {
    kind = 'effect';
    inputs.images.set('inputImage', { kind: 'input' });
    warn('inputImage is used without being declared; it is treated as the effect input.');
  }
  if (kind === 'source' && passes.length > 1) throw new Error('Multi-pass ISF generators are not supported; only effects (with an inputImage) can use PASSES.');
  if (header.IMPORTED && typeof header.IMPORTED === 'object' && !Array.isArray(header.IMPORTED)) {
    for (const name of Object.keys(header.IMPORTED).slice(0, ISF_LIMITS.inputs)) {
      checkName(name, 'imported image');
      inputs.images.set(name, { kind: 'blank' });
      warn(`Imported image "${name}" is not supported and reads as transparent black.`);
    }
  }

  const known = new Set([...BUILTINS, ...inputs.replacements.keys(), ...inputs.images.keys(), ...targets.keys()]);
  let tokens = stripDirectives(tokenize(body), warn);
  checkBalance(tokens);
  tokens = stripDeclarations(tokens, known, inputs.images, warn);
  if (!tokens.some((token, index) => token.type === 'id' && token.text === 'main' && textAt(tokens, nextSig(tokens, index)) === '(')) {
    throw new Error('ISF shader has no main() function.');
  }
  const overrides = builtinOverrides(tokens);
  const rename = name => TEMPLATE_NAMES.has(name) || ES3_RESERVED.has(name) || overrides.has(name) || name.startsWith('p_');
  const shared = { kind, inputs, passes, targets, warn, rename, used: new Set(), feedbackTargets: new Set() };
  const bodies = passes.map((_, index) => translate(pruneBranches(tokens, index), passContext(shared, index)));
  if (shared.feedbackTargets.size > 1) throw new Error(`Only one persistent buffer can be read for feedback (found ${[...shared.feedbackTargets].join(', ')}).`);
  const helpers = [...inputs.helpers, ...[...shared.used].map(name => AUDIO_HELPERS[name])];
  const glsl = bodies.map(item => wrap(kind, helpers, item));

  const base = baseName(fileName);
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'shader';
  const category = Array.isArray(header.CATEGORIES) && typeof header.CATEGORIES[0] === 'string' && header.CATEGORIES[0].trim()
    ? header.CATEGORIES[0].trim().slice(0, 40) : 'ISF';
  const definition = {
    id: `isf:${slug}`,
    name: base.replace(/_+/g, ' ').trim().slice(0, 80) || 'ISF Shader',
    category,
    params: inputs.params,
    glsl: glsl[0],
  };
  if (kind === 'effect' && glsl.length > 1) definition.passes = glsl;
  if (shared.feedbackTargets.size) definition.feedback = true;
  if (typeof header.DESCRIPTION === 'string' && header.DESCRIPTION.trim()) definition.description = header.DESCRIPTION.trim().slice(0, 500);
  return { definition, kind, warnings: [...warnings] };
}