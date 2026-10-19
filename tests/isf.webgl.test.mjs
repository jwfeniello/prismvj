import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Renders ISF shaders through the real runtime (src/fx/isf-runtime.js) on
// SwiftShader WebGL2 and checks pixels of the premultiplied output.
let browser;
let server;
let baseURL;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browserAvailable = existsSync(chrome);
const SIZE = 8;

before(async () => {
  if (!browserAvailable) return;
  const files = new Map([
    ['/isf.js', await readFile(new URL('../src/fx/isf.js', import.meta.url))],
    ['/isf-runtime.js', await readFile(new URL('../src/fx/isf-runtime.js', import.meta.url))],
  ]);
  server = createServer((request, response) => {
    const file = files.get(request.url);
    response.setHeader('Content-Type', file ? 'text/javascript' : 'text/html');
    response.end(file || '<!doctype html><title>isf</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

// frames: [{ params, time, progress, input: [r,g,b,a] (premultiplied 0..1), end: [...], audio: { fft:[...], wave:[...] }, sample: [[x, y]] }]
// Returns { kind, warnings, errors, frames: [{ pixels: { 'x,y': [r,g,b,a] } | null }] }.
async function render(text, { vertex = '', frames = [{}], size = SIZE } = {}) {
  const page = await browser.newPage();
  try {
    await page.goto(baseURL);
    return await page.evaluate(async ({ text, vertex, frames, size }) => {
      const { parseISF } = await import('/isf.js');
      const { IsfRuntime } = await import('/isf-runtime.js');
      const { definition, kind, warnings } = parseISF(text, { fileName: 'fixture.fs', vertex });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const gl = canvas.getContext('webgl2');
      const errors = [];
      const runtime = new IsfRuntime(gl, { onError: (key, message) => errors.push(message) });
      let audio = null;
      runtime.audioProvider = () => audio;
      const filled = color => {
        const target = runtime._target(size, size);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.clearColor(...color);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return target;
      };
      const results = [];
      for (const frame of frames) {
        runtime.beginFrame();
        audio = frame.audio ? { wave: new Uint8Array(frame.audio.wave || []), fft: new Uint8Array(frame.audio.fft || []) } : null;
        const input = frame.input ? filled(frame.input) : null;
        const end = frame.end ? filled(frame.end) : null;
        runtime.prewarm(definition);
        runtime.flush();
        const output = runtime.run('instance', definition, { input, start: input, end, progress: frame.progress ?? 0, params: frame.params || {}, time: frame.time ?? 0, width: size, height: size });
        if (!output) { results.push({ pixels: null }); continue; }
        gl.bindFramebuffer(gl.FRAMEBUFFER, output.framebuffer);
        const data = new Uint8Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, data);
        const pixels = {};
        for (const [x, y] of frame.sample || [[size / 2, size / 2]]) pixels[`${x},${y}`] = [...data.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
        results.push({ pixels });
      }
      return { kind, warnings, errors, frames: results };
    }, { text, vertex, frames, size });
  } finally { await page.close(); }
}

const near = (actual, expected, tolerance = 3, message = '') => assert.ok(actual && actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance), `${message} expected ${expected}, got ${actual}`);
const at = (result, frame = 0, key = `${SIZE / 2},${SIZE / 2}`) => result.frames[frame].pixels?.[key];
const isf = (header, body) => `/*${JSON.stringify(header)}*/\n${body}`;
const image = { NAME: 'inputImage', TYPE: 'image' };

test('ISF filter sees straight alpha and its output is premultiplied', { skip: !browserAvailable }, async () => {
  const result = await render(isf({ INPUTS: [image] }, 'void main() { vec4 c = IMG_THIS_PIXEL(inputImage); gl_FragColor = vec4(1.0 - c.rgb, c.a); }'),
    { frames: [{ input: [0.2, 0.1, 0.0, 0.5] }] });
  assert.equal(result.kind, 'effect');
  assert.deepEqual(result.errors, []);
  // Straight input (0.4, 0.2, 0, 0.5) inverts to (0.6, 0.8, 1) at alpha 0.5.
  near(at(result), [77, 102, 128, 128]);
});

test('ISF generator uses isf_FragNormCoord, RENDERSIZE and TIME', { skip: !browserAvailable }, async () => {
  const result = await render(isf({}, 'void main() { gl_FragColor = vec4(isf_FragNormCoord.x, RENDERSIZE.y / 16.0, fract(TIME), 1.0); }'),
    { frames: [{ time: 2.25, sample: [[0, 0], [7, 7]] }] });
  assert.equal(result.kind, 'source');
  near(at(result, 0, '0,0'), [16, 128, 64, 255]);
  near(at(result, 0, '7,7'), [239, 128, 64, 255]);
});

test('ISF FRAMEINDEX counts frames and TIMEDELTA follows the clock', { skip: !browserAvailable }, async () => {
  const result = await render(isf({}, 'void main() { gl_FragColor = vec4(float(FRAMEINDEX) * 0.25, TIMEDELTA, 0.0, 1.0); }'),
    { frames: [{ time: 1 }, { time: 1.5 }, { time: 1.75 }] });
  near(at(result, 0), [0, 4, 0, 255]);
  near(at(result, 1), [64, 128, 0, 255]);
  near(at(result, 2), [128, 64, 0, 255]);
});

test('ISF long input: the choice index selects the matching VALUE', { skip: !browserAvailable }, async () => {
  const text = isf({ INPUTS: [{ NAME: 'mode', TYPE: 'long', VALUES: [10, 200, 50], DEFAULT: 10 }] }, 'void main() { gl_FragColor = vec4(float(mode) / 255.0, 0.0, 0.0, 1.0); }');
  const result = await render(text, { frames: [{}, { params: { mode: 1 } }, { params: { mode: 2 } }] });
  near(at(result, 0), [10, 0, 0, 255]);
  near(at(result, 1), [200, 0, 0, 255]);
  near(at(result, 2), [50, 0, 0, 255]);
});

test('ISF color and point2D (pixel) inputs', { skip: !browserAvailable }, async () => {
  const text = isf({ INPUTS: [{ NAME: 'tint', TYPE: 'color', DEFAULT: [0, 0, 1, 1] }, { NAME: 'p', TYPE: 'point2D', DEFAULT: [0, 0], MAX: [640, 480] }] },
    'void main() { gl_FragColor = gl_FragCoord.x < p.x ? tint : vec4(0.0, 1.0, 0.0, 1.0); }');
  const result = await render(text, { frames: [{ params: { tint: '#ff0000ff', p: [0.5, 0.5] }, sample: [[1, 1], [6, 1]] }] });
  near(at(result, 0, '1,1'), [255, 0, 0, 255]);
  near(at(result, 0, '6,1'), [0, 255, 0, 255]);
});

test('ISF passes: a half-size target sees its own RENDERSIZE and the next pass reads it', { skip: !browserAvailable }, async () => {
  const text = isf({ INPUTS: [image], PASSES: [{ TARGET: 'small', WIDTH: '$WIDTH/2.0', HEIGHT: '$HEIGHT/2.0' }, {}] }, `void main() {
  if (PASSINDEX == 0) gl_FragColor = vec4(RENDERSIZE / 16.0, 0.0, 1.0);
  else gl_FragColor = IMG_THIS_PIXEL(small) + vec4(0.0, 0.0, IMG_SIZE(small).x / 8.0, 0.0);
}`);
  const result = await render(text, { frames: [{ input: [0, 0, 0, 1] }] });
  // Pass 0 renders at 4x4: RENDERSIZE/16 = 0.25; IMG_SIZE(small).x = 4 -> 0.5.
  near(at(result), [64, 64, 128, 255]);
});

test('ISF persistent buffer accumulates across frames', { skip: !browserAvailable }, async () => {
  const text = isf({ INPUTS: [image], PASSES: [{ TARGET: 'acc', PERSISTENT: true }, {}] }, `void main() {
  if (PASSINDEX == 0) gl_FragColor = IMG_THIS_PIXEL(acc) + vec4(0.25, 0.0, 0.0, 0.25);
  else gl_FragColor = IMG_THIS_PIXEL(acc);
}`);
  const result = await render(text, { frames: [{ input: [0, 0, 0, 1] }, { input: [0, 0, 0, 1] }, { input: [0, 0, 0, 1] }] });
  // Straight colour accumulates 0.25 per frame; the output is premultiplied.
  near(at(result, 0), [16, 0, 0, 64], 4);
  near(at(result, 1), [64, 0, 0, 128], 4);
  near(at(result, 2), [143, 0, 0, 191], 5);
});

test('ISF transition mixes start and end by progress', { skip: !browserAvailable }, async () => {
  const text = isf({ INPUTS: [{ NAME: 'startImage', TYPE: 'image' }, { NAME: 'endImage', TYPE: 'image' }, { NAME: 'progress', TYPE: 'float' }] },
    'void main() { gl_FragColor = mix(IMG_THIS_PIXEL(startImage), IMG_THIS_PIXEL(endImage), progress); }');
  const result = await render(text, { frames: [{ input: [1, 0, 0, 1], end: [0, 0, 1, 1], progress: 0 }, { input: [1, 0, 0, 1], end: [0, 0, 1, 1], progress: 0.5 }, { input: [1, 0, 0, 1], end: [0, 0, 1, 1], progress: 1 }] });
  assert.equal(result.kind, 'transition');
  near(at(result, 0), [255, 0, 0, 255]);
  near(at(result, 1), [128, 0, 128, 255]);
  near(at(result, 2), [0, 0, 255, 255]);
});

test('ISF image param: This input or None', { skip: !browserAvailable }, async () => {
  const text = isf({ INPUTS: [image, { NAME: 'other', TYPE: 'image' }] }, 'void main() { gl_FragColor = vec4(IMG_THIS_PIXEL(other).rgb, 1.0); }');
  const result = await render(text, { frames: [{ input: [0, 1, 0, 1] }, { input: [0, 1, 0, 1], params: { other: 0 } }] });
  near(at(result, 0), [0, 255, 0, 255]);
  near(at(result, 1), [0, 0, 0, 255]);
});

test('ISF audioFFT and audio inputs read the analyser data', { skip: !browserAvailable }, async () => {
  const text = isf({ INPUTS: [{ NAME: 'fft', TYPE: 'audioFFT', MAX: 4 }, { NAME: 'wave', TYPE: 'audio', MAX: 4 }] },
    'void main() { gl_FragColor = vec4(IMG_NORM_PIXEL(fft, vec2(0.125, 0.5)).r, IMG_NORM_PIXEL(fft, vec2(0.875, 0.5)).r, IMG_PIXEL(wave, vec2(0.5, 0.5)).r, IMG_SIZE(fft).x / 4.0); }');
  const result = await render(text, { frames: [{ audio: { fft: [200, 200, 20, 20], wave: [40, 128, 128, 128] } }, {}] });
  near(at(result, 0), [200, 20, 40, 255]);
  // No audio: spectra are 0, waveforms sit at the 0.5 midpoint.
  near(at(result, 1), [0, 0, 128, 255]);
});

test('ISF vertex shader passes a custom varying', { skip: !browserAvailable }, async () => {
  const vertex = 'varying vec2 shifted;\nvoid main() {\n  vv_vertShaderInit();\n  shifted = vec2(0.75, 0.25);\n}';
  const result = await render(isf({}, 'varying vec2 shifted;\nvoid main() { gl_FragColor = vec4(shifted, 0.0, 1.0); }'), { vertex });
  assert.deepEqual(result.errors, []);
  near(at(result), [191, 64, 0, 255]);
});

test('GLSL 1.x idioms and non-constant globals compile and run', { skip: !browserAvailable }, async () => {
  const text = isf({ INPUTS: [image, { NAME: 'filter', TYPE: 'float', DEFAULT: 0.5 }] }, `uniform float TIME;
vec2 half = RENDERSIZE * 0.5;
float round(float x) { return floor(x + 0.5); }
void main() {
  vec4 c = texture2D(inputImage, vv_FragNormCoord);
  gl_FragColor = vec4(c.r * filter, half.x / 8.0, round(0.4), 1.0);
}`);
  const result = await render(text, { frames: [{ input: [1, 0, 0, 1] }] });
  assert.deepEqual(result.errors, []);
  near(at(result), [128, 128, 0, 255]);
});

test('a shader that does not compile reports the GPU error and renders nothing', { skip: !browserAvailable }, async () => {
  const result = await render(isf({}, 'void main() { gl_FragColor = vec4(undefinedThing); }'));
  assert.equal(result.frames[0].pixels, null);
  assert.match(result.errors[0], /could not compile/);
});
test('built-in Stop Motion, Delay RGB and Freeze keep frame history', { skip: !browserAvailable }, async () => {
  const { MANUAL_ISF_EFFECTS } = await import('../src/fx/manual-effects.js');
  const text = id => MANUAL_ISF_EFFECTS.find(effect => effect.id === id).text;
  const red = [1, 0, 0, 1], green = [0, 1, 0, 1], blue = [0, 0, 1, 1];
  const stop = await render(text('stop-motion'), { frames: [{ input: red, params: { hold: 2 } }, { input: green, params: { hold: 2 } }, { input: blue, params: { hold: 2 } }] });
  assert.deepEqual(stop.errors, []);
  near(at(stop, 0), [255, 0, 0, 255]);
  near(at(stop, 1), [255, 0, 0, 255]);
  near(at(stop, 2), [0, 0, 255, 255]);
  const grey = value => [value, value, value, 1];
  const params = { red: 0, green: 1, blue: 2 };
  const delay = await render(text('delay-rgb'), { frames: [{ input: grey(0.2), params }, { input: grey(0.6), params }, { input: grey(1), params }] });
  assert.deepEqual(delay.errors, []);
  near(at(delay, 2), [255, 153, 51, 255]);
  const freeze = await render(text('freeze'), { frames: [{ input: red, params: { solid: true } }, { input: green, params: { solid: true } }, { input: green, params: { solid: false, areaX: 0 } }] });
  assert.deepEqual(freeze.errors, []);
  near(at(freeze, 0), [255, 0, 0, 255]);
  near(at(freeze, 1), [255, 0, 0, 255]);
  near(at(freeze, 2), [0, 255, 0, 255]);
});