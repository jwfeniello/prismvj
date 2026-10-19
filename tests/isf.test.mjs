import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parseISF, parseSizeExpression, evaluateSize, isfKind } from '../src/fx/isf.js';

const { scanISFFolder } = createRequire(import.meta.url)('../electron/isf-library.cjs');
const isf = (header, body = 'void main() { gl_FragColor = vec4(1.0); }') => `/*${typeof header === 'string' ? header : JSON.stringify(header)}*/\n${body}`;
const image = { NAME: 'inputImage', TYPE: 'image' };
const userCode = definition => definition.isf.program.fragment.split('#define ISF_PRISMVJ 1')[1];

test('parses the JSON header, tolerating comments, trailing commas and leading line comments', () => {
  const text = `// Week 25 by someone
// 2016
/*{
    // ISF v2 header with a comment
    "ISFVSN": "2",
    "DESCRIPTION": "Tint, with \\"quotes\\" // not a comment",
    "CREDIT": "Someone",
    "CATEGORIES": ["Color Effect", "Stylize",],
    "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" }, ],
  }*/
  void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }`;
  const { definition, kind, warnings } = parseISF(text, { fileName: 'C:\\Shaders\\Tint.fs' });
  assert.equal(kind, 'effect');
  assert.deepEqual(warnings, []);
  assert.equal(definition.category, 'Color Effect');
  assert.deepEqual(definition.categories, ['Color Effect', 'Stylize']);
  assert.equal(definition.description, 'Tint, with "quotes" // not a comment');
  assert.equal(definition.credit, 'Someone');
  assert.match(userCode(definition), /isf_FragColor = IMG_THIS_PIXEL\(inputImage\);/);
  assert.match(definition.isf.program.fragment, /^#version 300 es\n/);
  assert.match(definition.isf.program.fragment, /uniform sampler2D inputImage;/);
  assert.match(definition.isf.program.vertex, /void main\(\) \{\n  isf_vertShaderInit\(\);/);
});

test('generates stable ids, names and categories; online ids and links are kept', () => {
  const { definition, kind } = parseISF(isf({ INPUTS: [] }), { fileName: '/lib/My Cool_Shader v2.fs' });
  assert.equal(kind, 'source');
  assert.equal(definition.id, 'isf:my-cool-shader-v2');
  assert.equal(definition.name, 'My Cool Shader v2');
  assert.equal(definition.category, 'ISF');
  assert.equal(parseISF(isf({}), { fileName: '!!!.fs' }).definition.id, 'isf:shader');
  const online = parseISF(isf({}), { fileName: 'Tunnel', id: 'isf:web-5e7a7fdd7c113618206de5d9', link: 'https://editor.isf.video/shaders/5e7a7fdd7c113618206de5d9', author: 'joshpbatty' }).definition;
  assert.equal(online.id, 'isf:web-5e7a7fdd7c113618206de5d9');
  assert.equal(online.link, 'https://editor.isf.video/shaders/5e7a7fdd7c113618206de5d9');
  assert.equal(online.credit, 'joshpbatty');
  assert.equal(parseISF(isf({}), { link: 'https://evil.example/x' }).definition.link, undefined);
});

test('maps float, bool, event, color, point2D and long inputs to params and uniforms', () => {
  const { definition, warnings } = parseISF(isf({ INPUTS: [
    { NAME: 'amount', TYPE: 'float', MIN: -2, MAX: 4, DEFAULT: 9, LABEL: 'Amount' },
    { NAME: 'loose', TYPE: 'float', DEFAULT: 3 },
    { NAME: 'flip', TYPE: 'bool', DEFAULT: 1 },
    { NAME: 'flash', TYPE: 'event' },
    { NAME: 'tint', TYPE: 'color', DEFAULT: [1, 0.5, 0, 0.25] },
    { NAME: 'center', TYPE: 'point2D', DEFAULT: [320, 120], MIN: [0, 0], MAX: [640, 480] },
    { NAME: 'unit', TYPE: 'point2D', DEFAULT: [0.25, 0.75], MIN: [0, 0], MAX: [1, 1] },
    { NAME: 'mode', TYPE: 'long', VALUES: [10, 20, -5], LABELS: ['Ten', 'Twenty'], DEFAULT: 20 },
    { NAME: 'ranged', TYPE: 'long', MIN: 2, MAX: 4, DEFAULT: 3 },
  ] }));
  const params = Object.fromEntries(definition.params.map(param => [param.key, param]));
  assert.deepEqual(params.amount, { key: 'amount', label: 'Amount', type: 'float', min: -2, max: 4, default: 4 });
  assert.equal(params.loose.max, 3);
  assert.deepEqual([params.flip.type, params.flip.default], ['bool', true]);
  assert.deepEqual([params.flash.type, params.flash.default, params.flash.momentary], ['bool', false, true]);
  assert.equal(params.tint.default, '#ff800040');
  assert.deepEqual([params.center.type, params.center.default, params.center.isfPoint], ['point', [0.5, 0.25], 'pixels']);
  assert.deepEqual([params.unit.default, params.unit.isfPoint], [[0.25, 0.75], 'normalized']);
  assert.deepEqual([params.mode.type, params.mode.options, params.mode.default, params.mode.isfValues], ['choice', ['Ten', 'Twenty', '-5'], 1, [10, 20, -5]]);
  assert.deepEqual([params.ranged.options, params.ranged.default], [['2', '3', '4'], 1]);
  assert.deepEqual(warnings, []);
  const declared = definition.isf.program.fragment;
  for (const line of ['uniform float amount;', 'uniform bool flip;', 'uniform bool flash;', 'uniform vec4 tint;', 'uniform vec2 center;', 'uniform int mode;']) assert.ok(declared.includes(line), line);
  assert.deepEqual(definition.isf.uniforms.find(uniform => uniform.key === 'mode').values, [10, 20, -5]);
});

test('extra image inputs become a source choice; audio inputs become textures', () => {
  const { definition, warnings } = parseISF(isf({ INPUTS: [image, { NAME: 'mask', TYPE: 'image' }, { NAME: 'fft', TYPE: 'audioFFT', MAX: 64 }, { NAME: 'wave', TYPE: 'audio' }] },
    'void main() { gl_FragColor = IMG_THIS_PIXEL(mask) + IMG_NORM_PIXEL(fft, vec2(0.5, 0.0)) + IMG_PIXEL(wave, vec2(3.0, 0.0)) * IMG_SIZE(fft).x; }'));
  assert.deepEqual(warnings, []);
  assert.deepEqual(definition.params[0].options, ['None', 'This input', 'Below this layer', 'Bundled image']);
  assert.deepEqual(definition.isf.images.map(item => [item.name, item.role, item.count]), [['inputImage', 'input', undefined], ['mask', 'param', undefined], ['fft', 'fft', 64], ['wave', 'wave', 256]]);
  assert.match(definition.isf.program.fragment, /#define IMG_SIZE\(img\) vec2\(textureSize\(img, 0\)\)/);
  assert.doesNotMatch(definition.isf.program.fragment, /##/);
});

test('translates GLSL 1.x idioms, reserved words and redefined built-ins', () => {
  const body = `#version 110
#extension GL_OES_standard_derivatives : enable
varying vec2 vv_FragNormCoord;
uniform float TIME;
uniform sampler2D inputImage;
float round(float x) { return floor(x + 0.5); }
float sign(float x) { return x < 0.0 ? -1.0 : 1.0; }
void main(void) {
  vec2 uv = vv_FragNormCoord;
  vec4 c = texture2D(inputImage, uv) + IMG_PIXEL(inputImage, gl_FragCoord.xy) * IMG_SIZE(inputImage).x;
  float sample = round(TIMEDELTA) + sign(-1.0) + float(FRAMEINDEX) + DATE.w + float(PASSINDEX);
  gl_FragData[0] = vec4(c.rgb * sample, c.a) + vec4(TIME);
}`;
  const { definition } = parseISF(isf({ INPUTS: [image] }, body));
  const code = userCode(definition);
  assert.doesNotMatch(code, /#version|#extension|varying|uniform|texture2D|gl_FragColor|gl_FragData|vv_FragNormCoord/);
  assert.match(code, /float isf_u_round\(float x\)/);
  assert.match(code, /float isf_u_sign\(float x\)/);
  assert.match(code, /vec2 uv = isf_FragNormCoord;/);
  assert.match(code, /texture\(inputImage, uv\)/);
  assert.match(code, /float isf_u_sample = isf_u_round\(TIMEDELTA\) \+ isf_u_sign\(-1\.0\) \+ float\(FRAMEINDEX\) \+ DATE\.w \+ float\(PASSINDEX\);/);
  assert.match(code, /isf_FragColor = vec4\(c\.rgb \* isf_u_sample, c\.a\) \+ vec4\(TIME\);/);
});

test('inputs named after reserved words are renamed in uniforms and code', () => {
  const { definition } = parseISF(isf({ INPUTS: [image, { NAME: 'filter', TYPE: 'float' }, { NAME: 'sample', TYPE: 'image' }] },
    'void main() { gl_FragColor = IMG_THIS_PIXEL(sample) * filter; }'));
  assert.match(definition.isf.program.fragment, /uniform float isf_u_filter;/);
  assert.match(definition.isf.program.fragment, /uniform sampler2D isf_u_sample;/);
  assert.match(userCode(definition), /IMG_THIS_PIXEL\(isf_u_sample\) \* isf_u_filter/);
  assert.equal(definition.params.find(param => param.key === 'filter').key, 'filter');
});

test('non-constant global initializers move into main()', () => {
  const { definition } = parseISF(isf({ INPUTS: [{ NAME: 'scale', TYPE: 'float', DEFAULT: 2 }] }, `vec2 center = RENDERSIZE * 0.5, offset = vec2(scale);
const float k = 2.0;
float helper(float x) { return x * k; }
void main() {
  gl_FragColor = vec4(center / RENDERSIZE + offset, helper(1.0), 1.0);
}`));
  const code = userCode(definition);
  assert.match(code, /vec2 center, offset;/);
  assert.match(code, /void main\(\) \{\s*center = RENDERSIZE \* 0\.5;\s*offset = vec2\(scale\);/);
  assert.match(code, /const float k = 2\.0;/);
  assert.match(code, /float helper\(float x\)/);
});

test('passes keep targets, persistence, FLOAT and size expressions', () => {
  const { definition, warnings } = parseISF(isf({
    INPUTS: [image, { NAME: 'blur', TYPE: 'float', DEFAULT: 4 }],
    PERSISTENT_BUFFERS: ['legacy'],
    PASSES: [{ TARGET: 'half', WIDTH: '$WIDTH/2.0', HEIGHT: 'floor($HEIGHT/$blur)', FLOAT: true }, { TARGET: 'trail', PERSISTENT: true }, { TARGET: 'legacy' }, { WIDTH: 'nonsense(' }],
  }, 'void main() { gl_FragColor = IMG_THIS_PIXEL(half) + IMG_THIS_PIXEL(trail) + IMG_THIS_PIXEL(legacy); }'));
  const [half, trail, legacy, last] = definition.isf.passes;
  assert.deepEqual([half.target, half.persistent, half.float], ['half', false, true]);
  assert.equal(evaluateSize(half.width, { WIDTH: 1280, HEIGHT: 720, blur: 4 }), 640);
  assert.equal(evaluateSize(half.height, { WIDTH: 1280, HEIGHT: 720, blur: 4 }), 180);
  assert.deepEqual([trail.persistent, legacy.persistent, last.target, last.width], [true, true, null, null]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(definition.isf.images.filter(item => item.role === 'buffer').map(item => item.name), ['half', 'trail', 'legacy']);
});

test('size expressions support math, functions, comparisons and reject unknowns', () => {
  const variables = new Set(['WIDTH', 'HEIGHT', 'amount']);
  const run = (text, values = { WIDTH: 100, HEIGHT: 50, amount: 3 }) => evaluateSize(parseSizeExpression(text, variables), values);
  assert.equal(run('max($WIDTH, $HEIGHT) * 2.0'), 200);
  assert.equal(run('clamp($amount, 1.0, 2.0)'), 2);
  assert.equal(run('$amount > 2.0 ? $WIDTH : $HEIGHT'), 100);
  assert.equal(run('-$HEIGHT + 60 % 7'), -46);
  assert.equal(run(320), 320);
  assert.throws(() => parseSizeExpression('$nope', variables), /unknown variable/);
  assert.throws(() => parseSizeExpression('alert(1)', variables), /Invalid/);
  assert.throws(() => parseSizeExpression('$WIDTH +', variables), /Invalid/);
});

test('transitions: start/end images and a driven progress uniform', () => {
  const { definition, kind, warnings } = parseISF(isf({ INPUTS: [{ NAME: 'startImage', TYPE: 'image' }, { NAME: 'endImage', TYPE: 'image' }, { NAME: 'progress', TYPE: 'float' }, { NAME: 'softness', TYPE: 'float', DEFAULT: 0.2 }] },
    'void main() { gl_FragColor = mix(IMG_THIS_PIXEL(startImage), IMG_THIS_PIXEL(endImage), smoothstep(progress - softness, progress + softness, isf_FragNormCoord.x)); }'));
  assert.equal(kind, 'transition');
  assert.equal(isfKind({ INPUTS: [{ NAME: 'startImage' }, { NAME: 'endImage' }] }), 'transition');
  assert.deepEqual(warnings, []);
  assert.deepEqual(definition.params.map(param => param.key), ['softness']);
  assert.deepEqual(definition.isf.uniforms.find(uniform => uniform.name === 'progress').role, 'progress');
  assert.deepEqual(definition.isf.images.map(item => item.role), ['start', 'end']);
  const supplied = parseISF(isf({ INPUTS: [{ NAME: 'startImage', TYPE: 'image' }, { NAME: 'endImage', TYPE: 'image' }] }));
  assert.equal(supplied.kind, 'transition');
  assert.equal(supplied.warnings.length, 1);
});

test('vertex shaders: varyings become out/in and the legacy init name works', () => {
  const vertex = 'varying vec2 offset;\nvoid main() {\n  vv_vertShaderInit();\n  offset = isf_FragNormCoord + vec2(0.1);\n}';
  const { definition, warnings } = parseISF(isf({ INPUTS: [image] }, 'varying vec2 offset;\nvoid main() { gl_FragColor = IMG_NORM_PIXEL(inputImage, offset); }'), { vertex });
  assert.deepEqual(warnings, []);
  assert.match(definition.isf.program.vertex, /out vec2 offset;/);
  assert.match(definition.isf.program.vertex, /#define vv_vertShaderInit isf_vertShaderInit/);
  assert.match(definition.isf.program.fragment, /in vec2 offset;/);
  const missing = parseISF(isf({ INPUTS: [image] }, 'varying vec2 offset;\nvoid main() { gl_FragColor = IMG_NORM_PIXEL(inputImage, offset); }'));
  assert.ok(missing.warnings.some(message => /no vertex shader/.test(message)));
  assert.match(userCode(missing.definition), /\s vec2 offset;/);
});

test('imported images and bundled assets are kept', () => {
  const assets = { 'noise.png': 'data:image/png;base64,AAAA', logo: 'data:image/png;base64,BBBB' };
  const { definition } = parseISF(isf({ INPUTS: [image, { NAME: 'logo', TYPE: 'image' }], IMPORTED: { noiseTex: { PATH: 'noise.png' } } },
    'void main() { gl_FragColor = IMG_THIS_PIXEL(noiseTex) + IMG_THIS_PIXEL(logo); }'), { assets });
  assert.deepEqual(definition.isf.images.find(item => item.name === 'noiseTex'), { name: 'noiseTex', role: 'imported', path: 'noise.png', glsl: 'noiseTex' });
  assert.equal(definition.isf.assets.logo, assets.logo);
  assert.equal(parseISF(isf({ INPUTS: [image], IMPORTED: [{ NAME: 'arr', PATH: 'a.jpg' }] })).definition.isf.images[1].path, 'a.jpg');
});

test('invalid shaders throw clear errors', () => {
  const cases = [
    ['void main() {}', /missing the leading/],
    ['/* plain comment */ void main() {}', /missing the leading/],
    ['/*{ "INPUTS": [ }*/ void main() {}', /Invalid ISF JSON header/],
    [isf({}, 'void notMain() {}'), /no main\(\)/],
    [isf({ INPUTS: [{ NAME: 'bad name', TYPE: 'float' }] }), /Invalid ISF input name/],
    [isf({ INPUTS: [{ NAME: 'TIME', TYPE: 'float' }] }), /clashes with an ISF built-in/],
    [isf({ INPUTS: [{ NAME: 'a', TYPE: 'float' }, { NAME: 'a', TYPE: 'bool' }] }), /Duplicate/],
    [isf({ INPUTS: [{ NAME: 'cube', TYPE: 'cube' }] }), /Unsupported ISF input type/],
    [isf({ INPUTS: [{ NAME: 'm', TYPE: 'long', VALUES: ['x'] }] }), /invalid VALUES/],
    [isf({ INPUTS: [image, { NAME: 'a', TYPE: 'float' }], PASSES: [{ TARGET: 'a' }] }), /clashes with an input/],
    [isf({ INPUTS: [image], PASSES: Array.from({ length: 17 }, () => ({})) }), /too many passes/],
    [isf({ INPUTS: [image] }, 'void main() { gl_FragColor = vec4(1.0); { }'), /Unbalanced|Unterminated/],
    [isf({ INPUTS: [image] }, 'void main() { gl_FragData[1] = vec4(1.0); }'), /multiple render targets/],
    [`/*{}*/${' '.repeat(600 * 1024)}`, /too large/],
  ];
  for (const [text, pattern] of cases) assert.throws(() => parseISF(text), pattern, String(text).slice(0, 120));
  assert.throws(() => parseISF(null), TypeError);
  assert.throws(() => parseISF(isf({}), { vertex: 'x\0' }), /binary/);
});

test('inputImage used without a declaration still makes an effect', () => {
  const { kind, warnings } = parseISF(isf({ INPUTS: [] }, 'void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }'));
  assert.equal(kind, 'effect');
  assert.equal(warnings.length, 1);
});

test('scanISFFolder reads .fs files one level deep with their .vs and imported images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isf-scan-'));
  try {
    await mkdir(join(root, 'Sub', 'Deeper'), { recursive: true });
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'b.fs'), 'B');
    await writeFile(join(root, 'A.FS'), 'A');
    await writeFile(join(root, 'notes.txt'), 'x');
    await writeFile(join(root, 'big.fs'), 'x'.repeat(2048));
    await writeFile(join(root, 'Sub', 'c.fs'), '/*{"IMPORTED":{"tex":{"PATH":"tex.png"},"escape":{"PATH":"../../secret.png"}}}*/ void main(){}');
    await writeFile(join(root, 'Sub', 'c.vs'), 'void main(){ isf_vertShaderInit(); }');
    await writeFile(join(root, 'Sub', 'tex.png'), Buffer.from([137, 80, 78, 71]));
    await writeFile(join(root, 'secret.png'), Buffer.from([1]));
    await writeFile(join(root, 'Sub', 'Deeper', 'd.fs'), 'D');
    await writeFile(join(root, '.hidden', 'e.fs'), 'E');
    // A link back to the root (a junction on Windows) must not be followed.
    await symlink(root, join(root, 'loop'), 'junction').catch(() => {});
    const results = await scanISFFolder(root, { maxBytes: 1024 });
    assert.deepEqual(results.map(item => item.name), ['A.FS', 'b.fs', 'c.fs']);
    assert.deepEqual(results.map(item => item.text.slice(0, 1)), ['A', 'B', '/']);
    assert.equal(results[2].path, join(root, 'Sub', 'c.fs'));
    assert.equal(results[2].vertex, 'void main(){ isf_vertShaderInit(); }');
    assert.deepEqual(Object.keys(results[2].assets), ['tex.png']);
    assert.equal(results[2].assets['tex.png'], 'data:image/png;base64,iVBORw==');
    assert.equal(results[0].vertex, '');
    assert.equal((await scanISFFolder(root, { maxFiles: 1, maxBytes: 1024 })).length, 1);
    assert.equal((await scanISFFolder(root)).length, 4);
    assert.deepEqual(await scanISFFolder(join(root, 'missing')), []);
    await assert.rejects(scanISFFolder(''), TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});