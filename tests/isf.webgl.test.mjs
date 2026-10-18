import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

let browser;
let server;
let baseURL;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browserAvailable = existsSync(chrome);
const SIZE = 8;

before(async () => {
  if (!browserAvailable) return;
  const files = new Map([
    ['/shader-template.js', await readFile(new URL('../src/fx/shader-template.js', import.meta.url))],
    ['/isf.js', await readFile(new URL('../src/fx/isf.js', import.meta.url))],
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

// Test-only GL runner: parses the ISF text in the page, compiles every pass
// through the shader template and renders `frames` into SIZE x SIZE targets.
// Each frame: { input: { fill: [r,g,b,a], dots: [[x, y, [r,g,b,a]]] }, time, audio, values }.
async function render(text, { fileName = 'fixture.fs', values = {}, frames = [{}] } = {}) {
  const page = await browser.newPage();
  try {
    await page.goto(baseURL);
    return await page.evaluate(async ({ text, fileName, values, frames, size }) => {
      const { parseISF } = await import('/isf.js');
      const T = await import('/shader-template.js');
      const { definition, kind, warnings } = parseISF(text, { fileName });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const gl = canvas.getContext('webgl2');
      if (!gl) throw new Error('WebGL2 unavailable');
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`${gl.getShaderInfoLog(shader)}\n${source}`);
        return shader;
      };
      const vertex = compile(gl.VERTEX_SHADER, T.VERTEX_SHADER);
      const link = fragment => {
        const program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        const locations = {};
        for (const name of T.uniformNames(definition)) locations[name] = gl.getUniformLocation(program, name);
        return { program, locations };
      };
      const programs = kind === 'effect'
        ? T.effectPasses(definition).map((_, index) => link(T.buildEffectShader(definition, index)))
        : [link(T.buildSourceShader(definition))];
      const texture = pixels => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
        return tex;
      };
      const target = () => {
        const tex = texture(null), fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        return { tex, fbo };
      };
      const image = (spec = {}) => {
        // Inputs are premultiplied like the engine's textures.
        const data = new Uint8Array(size * size * 4);
        const put = (x, y, [r, g, b, a]) => data.set([r * a / 255, g * a / 255, b * a / 255, a].map(Math.round), (y * size + x) * 4);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(x, y, spec.fill || [0, 0, 0, 255]);
        for (const [x, y, color] of spec.dots || []) put(x, y, color);
        return data;
      };
      const targets = programs.map(target), history = target(), vao = gl.createVertexArray();
      const output = [];
      frames.forEach(frame => {
        const input = texture(image(frame.input));
        let source = input;
        programs.forEach(({ program, locations }, index) => {
          gl.bindFramebuffer(gl.FRAMEBUFFER, targets[index].fbo);
          gl.viewport(0, 0, size, size);
          gl.useProgram(program);
          gl.bindVertexArray(vao);
          [source, input, history.tex].forEach((tex, unit) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); });
          const set = (name, method, ...args) => { if (locations[name]) gl[method](locations[name], ...args); };
          set('uImage', 'uniform1i', 0);
          set('uOriginal', 'uniform1i', 1);
          set('uPrevious', 'uniform1i', 2);
          set('uResolution', 'uniform2f', size, size);
          set('uAspect', 'uniform1f', 1);
          set('uTime', 'uniform1f', frame.time ?? 0);
          set('uBeat', 'uniform1f', 0);
          set('uAudio', 'uniform4fv', frame.audio || [0, 0, 0, 0]);
          set('uPass', 'uniform1i', index);
          T.bindParams(gl, locations, definition, frame.values ?? values);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          source = targets[index].tex;
        });
        const last = targets[targets.length - 1];
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, last.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, history.fbo);
        gl.blitFramebuffer(0, 0, size, size, 0, 0, size, size, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, last.fbo);
        const pixels = new Uint8Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        output.push([...pixels]);
        gl.deleteTexture(input);
      });
      const error = gl.getError();
      if (error) throw new Error(`GL error ${error}`);
      return { kind, warnings, feedback: !!definition.feedback, passes: T.effectPasses(definition).length, frames: output };
    }, { text, fileName, values, frames, size: SIZE });
  } finally {
    await page.close();
  }
}

const px = (pixels, x, y) => pixels.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4);
function near(actual, expected, message, tolerance = 3) {
  assert.ok(actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance), `${message}: expected ${expected}, got ${actual}`);
}

const INVERT = `/*{
  "ISFVSN": "2", "CATEGORIES": ["Color Effect"],
  "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" } ]
}*/
void main() {
  vec4 c = IMG_THIS_PIXEL(inputImage);
  gl_FragColor = vec4(1.0 - c.rgb, c.a);
}`;

const GRADIENT = `/*{ "ISFVSN": "2", "CATEGORIES": ["Generator"], "INPUTS": [] }*/
void main() {
  gl_FragColor = vec4(isf_FragNormCoord.x, RENDERSIZE.x == 8.0 ? 1.0 : 0.0, fract(TIME), 1.0);
}`;

const CHOICE = `/*{
  "INPUTS": [ { "NAME": "mode", "TYPE": "long", "VALUES": [10, 20, 30], "LABELS": ["Low", "Mid", "High"], "DEFAULT": 30 } ]
}*/
void main() { gl_FragColor = vec4(float(mode) / 255.0, 0.0, 0.0, 1.0); }`;

const SPOT = `/*{
  "INPUTS": [
    { "NAME": "tint", "TYPE": "color", "DEFAULT": [0.2, 0.4, 0.8, 1.0] },
    { "NAME": "center", "TYPE": "point2D", "DEFAULT": [2.0, 2.0], "MIN": [0.0, 0.0], "MAX": [8.0, 8.0] },
    { "NAME": "flash", "TYPE": "event" }
  ]
}*/
void main() {
  if (flash) { gl_FragColor = vec4(1.0); return; }
  gl_FragColor = distance(gl_FragCoord.xy, center) < 1.0 ? tint : vec4(0.0, 0.0, 0.0, 1.0);
}`;

const BLUR = `/*{
  "ISFVSN": "2",
  "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" } ],
  "PASSES": [ { "TARGET": "horizontal" }, {} ]
}*/
void main() {
  vec2 px = 1.0 / RENDERSIZE;
  if (PASSINDEX == 0) {
    gl_FragColor = (IMG_NORM_PIXEL(inputImage, isf_FragNormCoord - vec2(px.x, 0.0)) + IMG_THIS_NORM_PIXEL(inputImage)
      + IMG_NORM_PIXEL(inputImage, isf_FragNormCoord + vec2(px.x, 0.0))) / 3.0;
  } else {
    gl_FragColor = (IMG_PIXEL(horizontal, gl_FragCoord.xy - vec2(0.0, 1.0)) + IMG_THIS_PIXEL(horizontal)
      + IMG_PIXEL(horizontal, gl_FragCoord.xy + vec2(0.0, 1.0))) / 3.0;
  }
}`;

const TRAIL = `/*{
  "ISFVSN": "2",
  "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" }, { "NAME": "decay", "TYPE": "float", "DEFAULT": 0.5, "MIN": 0.0, "MAX": 1.0 } ],
  "PASSES": [ { "TARGET": "trail", "PERSISTENT": true } ]
}*/
void main() {
  vec4 fresh = IMG_THIS_PIXEL(inputImage);
  vec4 old = IMG_NORM_PIXEL(trail, isf_FragNormCoord);
  gl_FragColor = vec4(max(fresh.rgb, old.rgb * decay), 1.0);
}`;

const LEGACY = `/*{
  "CREDIT": "GLSL 1.x style",
  "INPUTS": [ { "NAME": "inputImage", "TYPE": "image" }, { "NAME": "amount", "TYPE": "float", "DEFAULT": 1.0, "MIN": 0.0, "MAX": 1.0 } ]
}*/
#version 110
#ifdef GL_ES
precision mediump float;
#endif
varying vec2 vv_FragNormCoord;
uniform float amount;
uniform sampler2D inputImage;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(void) {
  vec2 uv = vv_FragNormCoord;
  vec4 c = texture2D(inputImage, uv);
  vec3 swapped = c.bgr;
  gl_FragColor = vec4(mix(vec3(luma(c.rgb)), swapped, amount), c.a);
}`;

const MISC = `/*{
  "ISFVSN": "2",
  "INPUTS": [ { "NAME": "fft", "TYPE": "audioFFT" }, { "NAME": "mask", "TYPE": "image" } ]
}*/
const float PI = 3.14159;
float round(float x) { return floor(x + 0.5); }
void main() {
  float low = IMG_NORM_PIXEL(fft, vec2(0.0, 0.0)).r;
  float seconds = float(FRAMEINDEX) / 60.0;
  float dt = TIMEDELTA * 60.0;
  vec4 m = IMG_THIS_PIXEL(mask);
  gl_FragColor = vec4(low, round(seconds * 0.5 + 0.1), dt * cos(PI * 0.0) + m.r + DATE.x * 0.0, 1.0);
}`;

const ORANGE = { fill: [255, 64, 0, 255] };

test('ISF image filter (IMG_THIS_PIXEL) inverts its input', { skip: !browserAvailable }, async () => {
  const { kind, frames } = await render(INVERT, { frames: [{ input: ORANGE }] });
  assert.equal(kind, 'effect');
  near(px(frames[0], 3, 3), [0, 191, 255, 255], 'inverted');
});

test('ISF generator uses isf_FragNormCoord, RENDERSIZE and TIME', { skip: !browserAvailable }, async () => {
  const { kind, frames } = await render(GRADIENT, { frames: [{ time: 2.25 }] });
  assert.equal(kind, 'source');
  near(px(frames[0], 0, 0), [16, 255, 64, 255], 'left column');
  near(px(frames[0], 7, 5), [239, 255, 64, 255], 'right column');
});

test('ISF long input: the choice index selects the matching VALUE', { skip: !browserAvailable }, async () => {
  const { frames } = await render(CHOICE, { frames: [{}, { values: { mode: 0 } }, { values: { mode: 1 } }] });
  near(px(frames[0], 4, 4), [30, 0, 0, 255], 'default VALUE 30', 1);
  near(px(frames[1], 4, 4), [10, 0, 0, 255], 'index 0 -> 10', 1);
  near(px(frames[2], 4, 4), [20, 0, 0, 255], 'index 1 -> 20', 1);
});

test('ISF color, point2D (pixels) and event inputs', { skip: !browserAvailable }, async () => {
  const { frames } = await render(SPOT, { frames: [{}, { values: { center: [0.75, 0.75] } }, { values: { flash: true } }] });
  near(px(frames[0], 1, 1), [51, 102, 204, 255], 'default spot at (2,2) px');
  near(px(frames[0], 5, 5), [0, 0, 0, 255], 'outside default spot');
  near(px(frames[1], 5, 5), [51, 102, 204, 255], 'moved spot at (6,6) px');
  near(px(frames[1], 1, 1), [0, 0, 0, 255], 'old spot cleared');
  near(px(frames[2], 0, 7), [255, 255, 255, 255], 'event fired');
});

test('ISF two-pass blur reads the previous pass target', { skip: !browserAvailable }, async () => {
  const { passes, frames } = await render(BLUR, { frames: [{ input: { fill: [0, 0, 0, 255], dots: [[4, 4, [255, 255, 255, 255]]] } }] });
  assert.equal(passes, 2);
  near(px(frames[0], 4, 4), [28, 28, 28, 255], 'center');
  near(px(frames[0], 3, 5), [28, 28, 28, 255], 'diagonal neighbour');
  near(px(frames[0], 1, 1), [0, 0, 0, 255], 'far pixel');
});

test('ISF PERSISTENT buffer becomes a feedback trail', { skip: !browserAvailable }, async () => {
  const white = { fill: [255, 255, 255, 255] }, black = { fill: [0, 0, 0, 255] };
  const { feedback, frames } = await render(TRAIL, { frames: [{ input: white }, { input: black }, { input: black }] });
  assert.equal(feedback, true);
  near(px(frames[0], 2, 2), [255, 255, 255, 255], 'frame 1');
  near(px(frames[1], 2, 2), [128, 128, 128, 255], 'frame 2 decays');
  near(px(frames[2], 2, 2), [64, 64, 64, 255], 'frame 3 decays');
});

test('GLSL 1.x style ISF (texture2D, gl_FragColor, varyings, uniforms) compiles and runs', { skip: !browserAvailable }, async () => {
  const { kind, frames } = await render(LEGACY, { frames: [{ input: ORANGE }, { input: ORANGE, values: { amount: 0 } }] });
  assert.equal(kind, 'effect');
  near(px(frames[0], 6, 1), [0, 64, 255, 255], 'channels swapped');
  near(px(frames[1], 6, 1), [114, 114, 114, 255], 'luma at amount 0');
});

test('ISF audio, FRAMEINDEX, TIMEDELTA, DATE and renamed built-ins approximate sensibly', { skip: !browserAvailable }, async () => {
  const { kind, warnings, frames } = await render(MISC, { frames: [{ time: 1, audio: [0.5, 0, 0, 0] }] });
  assert.equal(kind, 'source');
  assert.ok(warnings.length >= 3);
  near(px(frames[0], 2, 6), [128, 255, 255, 255], 'approximated values');
});
