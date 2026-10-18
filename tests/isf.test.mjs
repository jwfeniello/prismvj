import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parseISF } from '../src/fx/isf.js';
import { buildEffectShader, buildSourceShader, defaultParams } from '../src/fx/shader-template.js';

const { scanISFFolder } = createRequire(import.meta.url)('../electron/isf-library.cjs');
const isf = (header, body = 'void main() { gl_FragColor = vec4(1.0); }') => `/*${typeof header === 'string' ? header : JSON.stringify(header)}*/\n${body}`;
const image = { NAME: 'inputImage', TYPE: 'image' };

test('parses the JSON header, tolerating comments and trailing commas', () => {
  const text = `/*{
    // ISF v2 header with a comment
    "ISFVSN": "2",
    "DESCRIPTION": "Tint, with \\"quotes\\" // not a comment",
    "CATEGORIES": ["Color Effect", "Stylize",],
    "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" }, ],
  }*/
  void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }`;
  const { definition, kind, warnings } = parseISF(text, { fileName: 'C:\\Shaders\\Tint.fs' });
  assert.equal(kind, 'effect');
  assert.deepEqual(warnings, []);
  assert.equal(definition.category, 'Color Effect');
  assert.equal(definition.description, 'Tint, with "quotes" // not a comment');
  assert.match(definition.glsl, /isf_FragColor = src\(uv\);/);
  assert.match(definition.glsl, /vec4 fx\(vec2 isf_uv\)/);
  assert.match(buildEffectShader(definition), /void isf_main\(\)/);
});

test('generates stable ids, names and categories from the file name', () => {
  const { definition, kind } = parseISF(isf({ INPUTS: [] }), { fileName: '/lib/My Cool_Shader v2.fs' });
  assert.equal(kind, 'source');
  assert.equal(definition.id, 'isf:my-cool-shader-v2');
  assert.equal(definition.name, 'My Cool Shader v2');
  assert.equal(definition.category, 'ISF');
  assert.match(definition.glsl, /vec4 gen\(vec2 isf_uv\)/);
  assert.match(buildSourceShader(definition), /isf_main\(\);/);
  assert.equal(parseISF(isf({}), { fileName: '!!!.fs' }).definition.id, 'isf:shader');
  assert.equal(parseISF(isf({})).definition.name, 'ISF Shader');
});

test('maps float, bool, event, color and point2D inputs to params', () => {
  const { definition, warnings } = parseISF(isf({ INPUTS: [
    { NAME: 'amount', TYPE: 'float', MIN: -2, MAX: 4, DEFAULT: 9, LABEL: 'Amount' },
    { NAME: 'loose', TYPE: 'float', DEFAULT: 3 },
    { NAME: 'flip', TYPE: 'bool', DEFAULT: 1 },
    { NAME: 'flash', TYPE: 'event' },
    { NAME: 'tint', TYPE: 'color', DEFAULT: [1, 0.5, 0, 0.25] },
    { NAME: 'center', TYPE: 'point2D', DEFAULT: [320, 120], MIN: [0, 0], MAX: [640, 480] },
    { NAME: 'unit', TYPE: 'point2D', DEFAULT: [0.25, 0.75], MIN: [0, 0], MAX: [1, 1] },
  ] }, 'void main() { gl_FragColor = flip || flash ? tint : vec4(amount + loose, center / RENDERSIZE + unit); }'));
  const params = Object.fromEntries(definition.params.map(param => [param.key, param]));
  assert.deepEqual(params.amount, { key: 'amount', label: 'Amount', type: 'float', min: -2, max: 4, default: 4 });
  assert.equal(params.loose.max, 3);
  assert.equal(params.loose.default, 3);
  assert.equal(params.flip.type, 'bool');
  assert.equal(params.flip.default, true);
  assert.deepEqual([params.flash.type, params.flash.default, params.flash.momentary], ['bool', false, true]);
  assert.equal(params.tint.default, '#ff800040');
  assert.deepEqual([params.center.type, params.center.default, params.center.isfPoint], ['point', [0.5, 0.25], 'pixels']);
  assert.deepEqual([params.unit.default, params.unit.isfPoint], [[0.25, 0.75], 'normalized']);
  assert.deepEqual(warnings, []);
  assert.match(definition.glsl, /p_flip \|\| p_flash \? p_tint : vec4\(p_amount \+ p_loose, \(p_center \* uResolution\) \/ uResolution \+ p_unit\)/);
  assert.deepEqual(defaultParams(definition).center, [0.5, 0.25]);
});

test('point2D without a canvas-sized MAX uses the reference size and warns', () => {
  const { definition, warnings } = parseISF(isf({ INPUTS: [{ NAME: 'pos', TYPE: 'point2D', DEFAULT: [320, 240] }] }));
  assert.deepEqual(definition.params[0].default, [0.5, 0.5]);
  assert.equal(warnings.length, 1);
});

test('long inputs become choices whose index maps to the ISF VALUES in GLSL', () => {
  const { definition } = parseISF(isf({ INPUTS: [
    { NAME: 'mode', TYPE: 'long', VALUES: [10, 20, -5], LABELS: ['Ten', 'Twenty'], DEFAULT: 20 },
    { NAME: 'plain', TYPE: 'long', VALUES: [0, 1, 2], LABELS: ['A', 'B', 'C'], DEFAULT: 2 },
    { NAME: 'ranged', TYPE: 'long', MIN: 2, MAX: 4, DEFAULT: 3 },
  ] }, 'void main() { gl_FragColor = vec4(float(mode + plain + ranged)); }'));
  const [mode, plain, ranged] = definition.params;
  assert.deepEqual([mode.type, mode.options, mode.default, mode.isfValues], ['choice', ['Ten', 'Twenty', '-5'], 1, [10, 20, -5]]);
  assert.deepEqual([plain.options, plain.default], [['A', 'B', 'C'], 2]);
  assert.deepEqual([ranged.options, ranged.default], [['2', '3', '4'], 1]);
  assert.match(definition.glsl, /const int values\[3\] = int\[3\]\(10, 20, -5\);\n  return values\[clamp\(p_mode, 0, 2\)\];/);
  assert.match(definition.glsl, /float\(isf_long_mode\(\) \+ p_plain \+ isf_long_ranged\(\)\)/);
  assert.doesNotMatch(definition.glsl, /isf_long_plain/);
});

test('translates ISF built-ins and GLSL 1.x idioms', () => {
  const body = `#version 110
#extension GL_OES_standard_derivatives : enable
varying vec2 vv_FragNormCoord;
uniform float TIME;
uniform sampler2D inputImage;
float luma(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
float round(float x) { return floor(x + 0.5); }
void main(void) {
  vec2 uv = vv_FragNormCoord;
  vec4 c = texture2D(inputImage, uv) + IMG_PIXEL(inputImage, gl_FragCoord.xy) * IMG_SIZE(inputImage).x;
  float sample = luma(c.rgb) + round(TIMEDELTA) + float(FRAMEINDEX) + DATE.w + float(PASSINDEX);
  gl_FragData[0] = vec4(c.rgb * sample, c.a) + vec4(TIME);
}`;
  const { definition, warnings } = parseISF(isf({ INPUTS: [image] }, body));
  const glsl = definition.glsl;
  assert.doesNotMatch(glsl, /#version|#extension|varying|uniform|texture2D|gl_Frag|vv_FragNormCoord|\bmain\(/);
  assert.match(glsl, /float isf_u_luma\(vec3 c\)/);
  assert.match(glsl, /float isf_u_round\(float x\)/);
  assert.match(glsl, /vec2 isf_u_uv = uv;/);
  assert.match(glsl, /src\(\(isf_u_uv\)\)/);
  assert.match(glsl, /src\(\(\(vec4\(uv \* uResolution, 0\.0, 1\.0\)\.xy\) \/ uResolution\)\) \* uResolution\.x/);
  assert.match(glsl, /float isf_u_sample = isf_u_luma\(c\.rgb\) \+ isf_u_round\(\(1\.0 \/ 60\.0\)\) \+ float\(int\(uTime \* 60\.0\)\) \+ vec4\(2024\.0, 1\.0, 1\.0, mod\(uTime, 86400\.0\)\)\.w \+ float\(0\)/);
  assert.match(glsl, /isf_FragColor = vec4\(c\.rgb \* isf_u_sample, c\.a\) \+ vec4\(uTime\);/);
  assert.ok(warnings.some(message => /extension/.test(message)));
  assert.ok(warnings.some(message => /DATE/.test(message)));
});

test('unsupported images and audio inputs degrade with warnings', () => {
  const { definition, warnings } = parseISF(isf({ INPUTS: [image, { NAME: 'mask', TYPE: 'image' }, { NAME: 'fft', TYPE: 'audioFFT', MAX: 64 }, { NAME: 'wave', TYPE: 'audio' }] },
    'void main() { gl_FragColor = IMG_THIS_PIXEL(mask) + IMG_NORM_PIXEL(fft, vec2(0.5, 0.0)) + IMG_PIXEL(wave, vec2(3.0, 0.0)) * IMG_SIZE(fft).x; }'));
  assert.equal(warnings.length, 3);
  assert.match(definition.glsl, /vec4\(0\.0\) \+ isf_audio_fft\(\(vec2\(0\.5, 0\.0\)\)\) \+ isf_audio_wave\(\(\(vec2\(3\.0, 0\.0\)\) \/ vec2\(256\.0, 1\.0\)\)\) \* vec2\(64\.0, 1\.0\)\.x/);
  assert.match(definition.glsl, /vec4 isf_audio_fft\(vec2 p\)/);
});

test('sequential passes map to template passes and prune PASSINDEX branches', () => {
  const { definition, warnings } = parseISF(isf({
    INPUTS: [image],
    PASSES: [{ TARGET: 'first', FLOAT: true }, { TARGET: 'second', WIDTH: '$WIDTH/2', HEIGHT: '$HEIGHT/2' }, {}],
  }, `void main() {
  if (PASSINDEX == 0) gl_FragColor = IMG_THIS_PIXEL(inputImage);
  else if (PASSINDEX == 1) { gl_FragColor = IMG_THIS_PIXEL(first) * 0.5; }
  else { gl_FragColor = IMG_THIS_PIXEL(second) + IMG_THIS_PIXEL(inputImage); }
}`));
  assert.equal(definition.passes.length, 3);
  assert.equal(definition.glsl, definition.passes[0]);
  assert.equal(definition.feedback, undefined);
  assert.match(definition.passes[0], /isf_FragColor = src\(uv\);/);
  assert.doesNotMatch(definition.passes[0], /PASSINDEX|\* 0\.5/);
  assert.match(definition.passes[1], /\{ isf_FragColor = src\(uv\) \* 0\.5; \}/);
  assert.match(definition.passes[2], /isf_FragColor = src\(uv\) \+ orig\(uv\);/);
  assert.equal(warnings.length, 2);
  for (let pass = 0; pass < 3; pass++) assert.match(buildEffectShader(definition, pass), /vec4 fx\(/);
});

test('a persistent buffer maps to feedback and prev()', () => {
  const single = parseISF(isf({ INPUTS: [image, { NAME: 'decay', TYPE: 'float', DEFAULT: 0.9 }], PASSES: [{ TARGET: 'trail', PERSISTENT: true }] },
    'void main() { gl_FragColor = max(IMG_THIS_PIXEL(inputImage), IMG_NORM_PIXEL(trail, isf_FragNormCoord) * decay); }'));
  assert.equal(single.definition.feedback, true);
  assert.equal(single.definition.passes, undefined);
  assert.match(single.definition.glsl, /max\(src\(uv\), prev\(\(uv\)\) \* p_decay\)/);
  assert.deepEqual(single.warnings, []);

  const twoPass = parseISF(isf({ INPUTS: [image], PASSES: [{ TARGET: 'buf', PERSISTENT: 1 }, {}] },
    'void main() { if (PASSINDEX == 0) gl_FragColor = mix(IMG_THIS_PIXEL(inputImage), IMG_THIS_PIXEL(buf), 0.5); else gl_FragColor = IMG_THIS_PIXEL(buf); }'));
  assert.equal(twoPass.definition.feedback, true);
  assert.match(twoPass.definition.passes[0], /mix\(src\(uv\), prev\(uv\), 0\.5\)/);
  assert.match(twoPass.definition.passes[1], /isf_FragColor = src\(uv\);/);
  assert.ok(twoPass.warnings.some(message => /approximated/.test(message)));

  const legacy = parseISF(isf({ INPUTS: [image], PERSISTENT_BUFFERS: ['old'], PASSES: [{ TARGET: 'old' }] },
    'void main() { gl_FragColor = IMG_THIS_PIXEL(old) + IMG_THIS_PIXEL(inputImage); }'));
  assert.equal(legacy.definition.feedback, true);
});

test('unsupported topologies and invalid shaders throw clear errors', () => {
  const cases = [
    ['void main() {}', /missing the leading/],
    ['/*{ "INPUTS": [ }*/ void main() {}', /Invalid ISF JSON header/],
    ['/*[1, 2]*/ void main() {}', /must be an object/],
    [isf({}, 'void notMain() {}'), /no main\(\)/],
    [isf({ INPUTS: [{ NAME: 'bad name', TYPE: 'float' }] }), /Invalid ISF input name/],
    [isf({ INPUTS: [{ NAME: 'TIME', TYPE: 'float' }] }), /clashes with an ISF built-in/],
    [isf({ INPUTS: [{ NAME: 'a', TYPE: 'float' }, { NAME: 'a', TYPE: 'bool' }] }), /Duplicate/],
    [isf({ INPUTS: [{ NAME: 'cube', TYPE: 'cube' }] }), /Unsupported ISF input type/],
    [isf({ INPUTS: [{ NAME: 'm', TYPE: 'long', VALUES: ['x'] }] }), /invalid VALUES/],
    [isf({ INPUTS: [{ NAME: 'startImage', TYPE: 'image' }, { NAME: 'endImage', TYPE: 'image' }, { NAME: 'progress', TYPE: 'float' }] }), /transitions/],
    [isf({ INPUTS: [image] }, 'varying vec2 texOffset;\nvoid main() { gl_FragColor = IMG_NORM_PIXEL(inputImage, texOffset); }'), /custom varyings \(texOffset\).*vertex shader/],
    [isf({ INPUTS: [image] }, 'attribute vec2 position;\nvoid main() {}'), /vertex/],
    [isf({ INPUTS: [image], PASSES: [{ TARGET: 'a' }, { TARGET: 'b' }, {}] }, 'void main() { gl_FragColor = IMG_THIS_PIXEL(a); }'), /Pass 3 reads buffer "a" written by pass 1/],
    [isf({ INPUTS: [image], PASSES: [{ TARGET: 'a', PERSISTENT: true }, { TARGET: 'b', PERSISTENT: true }] }, 'void main() { gl_FragColor = IMG_THIS_PIXEL(a) + IMG_THIS_PIXEL(b); }'), /Only one persistent buffer/],
    [isf({ PASSES: [{ TARGET: 'a' }, {}] }), /Multi-pass ISF generators/],
    [isf({ PASSES: [{ TARGET: 'a', PERSISTENT: true }] }, 'void main() { gl_FragColor = IMG_THIS_PIXEL(a); }'), /Feedback.*generators/],
    [isf({ INPUTS: [image], PASSES: [{ TARGET: 'a' }, { TARGET: 'a' }] }), /more than one pass/],
    [isf({ INPUTS: [image], PASSES: Array.from({ length: 9 }, () => ({})) }), /too many passes/],
    [isf({ INPUTS: [image] }, 'vec4 f(sampler2D s) { return IMG_THIS_PIXEL(s); } void main() { gl_FragColor = f(inputImage); }'), /must name an image input directly/],
    [isf({ INPUTS: [image] }, 'void main() { gl_FragColor = vec4(1.0); { }'), /Unbalanced|Unterminated/],
    [`/*{}*/${' '.repeat(300 * 1024)}`, /too large/],
  ];
  for (const [text, pattern] of cases) assert.throws(() => parseISF(text), pattern, String(text).slice(0, 120));
  assert.throws(() => parseISF(null), TypeError);
});

test('reading a later buffer before it is rendered falls back to blank with a warning', () => {
  const { definition, warnings } = parseISF(isf({ INPUTS: [image], PASSES: [{ TARGET: 'a' }, {}] },
    'void main() { gl_FragColor = IMG_THIS_PIXEL(a) + IMG_THIS_PIXEL(inputImage); }'));
  assert.match(definition.passes[0], /vec4\(0\.0\) \+ src\(uv\)/);
  assert.match(definition.passes[1], /src\(uv\) \+ orig\(uv\)/);
  assert.equal(warnings.length, 1);
});

test('inputImage used without a declaration still makes an effect', () => {
  const { kind, warnings } = parseISF(isf({ INPUTS: [] }, 'void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }'));
  assert.equal(kind, 'effect');
  assert.equal(warnings.length, 1);
});

test('scanISFFolder reads .fs files one level deep, skipping oversized files and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'isf-scan-'));
  try {
    await mkdir(join(root, 'Sub', 'Deeper'), { recursive: true });
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'b.fs'), 'B');
    await writeFile(join(root, 'A.FS'), 'A');
    await writeFile(join(root, 'notes.txt'), 'x');
    await writeFile(join(root, 'big.fs'), 'x'.repeat(2048));
    await writeFile(join(root, 'Sub', 'c.fs'), 'C');
    await writeFile(join(root, 'Sub', 'Deeper', 'd.fs'), 'D');
    await writeFile(join(root, '.hidden', 'e.fs'), 'E');
    // A link back to the root (a junction on Windows) must not be followed.
    await symlink(root, join(root, 'loop'), 'junction').catch(() => {});
    const results = await scanISFFolder(root, { maxBytes: 1024 });
    assert.deepEqual(results.map(item => item.name), ['A.FS', 'b.fs', 'c.fs']);
    assert.deepEqual(results.map(item => item.text), ['A', 'B', 'C']);
    assert.equal(results[2].path, join(root, 'Sub', 'c.fs'));
    assert.equal((await scanISFFolder(root, { maxFiles: 1, maxBytes: 1024 })).length, 1);
    assert.equal((await scanISFFolder(root)).length, 4);
    assert.deepEqual(await scanISFFolder(join(root, 'missing')), []);
    await assert.rejects(scanISFFolder(''), TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
