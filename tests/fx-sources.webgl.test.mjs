import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { PARAM_TYPES, normalizeParam, uniformName } from '../src/fx/shader-template.js';
import { SOURCES, SOURCE_CATEGORIES, sourceDefinition } from '../src/fx/sources.js';
import { TEXT_ANIMATOR, normalizeTextParams } from '../src/fx/text-animator.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browserAvailable = existsSync(chrome);
const LEGACY_IDS = ['plasma', 'grid', 'rings', 'noise', 'solid'];
// Sources whose default parameters describe a still image.
const STATIC_IDS = new Set(['solid', 'gradient', 'checkered', 'color-bars', 'ramp', 'color-wheel']);
// Sources that fill the frame with one colour by design.
const FLAT_IDS = new Set(['solid', 'strobe']);
const TIMES = [0.37, 1.91];

let browser;
let server;
let baseURL;
let legacyShader;

before(async () => {
  if (!browserAvailable) return;
  const files = new Map();
  for (const name of ['shader-template.js', 'sources.js', 'text-animator.js']) files.set(`/fx/${name}`, await readFile(new URL(`../src/fx/${name}`, import.meta.url)));
  legacyShader = /const SOURCE = `([\s\S]*?)`;/.exec(await readFile(new URL('../src/engine.js', import.meta.url), 'utf8'))[1];
  server = createServer((request, response) => {
    const file = files.get(request.url);
    response.setHeader('Content-Type', file ? 'text/javascript' : 'text/html');
    response.end(file || '<canvas id="gl" width="96" height="54"></canvas>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

// Test-only GL runner: compiles a fragment shader against the template's
// fullscreen-triangle vertex shader and renders it into the 96x54 canvas.
async function glPage() {
  const page = await browser.newPage();
  await page.goto(baseURL);
  await page.evaluate(async () => {
    const template = await import('/fx/shader-template.js');
    const { SOURCES, sourceDefinition } = await import('/fx/sources.js');
    const canvas = document.getElementById('gl');
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    const vao = gl.createVertexArray();
    const shader = (type, text) => {
      const object = gl.createShader(type);
      gl.shaderSource(object, text);
      gl.compileShader(object);
      return gl.getShaderParameter(object, gl.COMPILE_STATUS) ? { object } : { error: gl.getShaderInfoLog(object) || 'compile failed' };
    };
    const vertex = shader(gl.VERTEX_SHADER, template.VERTEX_SHADER);
    const build = (fragmentText, names) => {
      const fragment = shader(gl.FRAGMENT_SHADER, fragmentText);
      if (fragment.error) return { error: `compile: ${fragment.error}` };
      const program = gl.createProgram();
      gl.attachShader(program, vertex.object);
      gl.attachShader(program, fragment.object);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return { error: `link: ${gl.getProgramInfoLog(program)}` };
      return { program, locations: Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)])) };
    };
    const read = () => {
      const pixels = new Uint8Array(96 * 54 * 4);
      gl.readPixels(0, 0, 96, 54, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const audioAt = time => time < 1 ? [0.2, 0.3, 0.1, 0.25] : [0.9, 0.7, 0.8, 0.85];
    const drawSource = (built, definition, values, time) => {
      const u = built.locations;
      gl.viewport(0, 0, 96, 54);
      gl.useProgram(built.program);
      gl.bindVertexArray(vao);
      gl.uniform2f(u.uResolution, 96, 54);
      gl.uniform1f(u.uAspect, 96 / 54);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uBeat, time * 2);
      gl.uniform4fv(u.uAudio, audioAt(time));
      template.bindParams(gl, u, definition, values);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return read();
    };
    const drawLegacy = (built, index, color, time) => {
      const u = built.locations;
      gl.useProgram(built.program);
      gl.bindVertexArray(vao);
      gl.uniform1i(u.uSource, index);
      gl.uniform1f(u.uTime, time);
      gl.uniform3fv(u.uColor, template.colorToVec4(color).slice(0, 3));
      gl.uniform2f(u.uFit, 1, 1);
      gl.uniform1f(u.uAspect, 96 / 54);
      gl.uniform3f(u.uChannels, 1, 1, 1);
      gl.uniform1i(u.uIgnoreAlpha, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return read();
    };
    const stats = pixels => {
      let visible = 0, premultiplied = true, uniform = true;
      for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3];
        if (a > 0) visible++;
        if (pixels[i] > a + 1 || pixels[i + 1] > a + 1 || pixels[i + 2] > a + 1) premultiplied = false;
        for (let c = 0; c < 4; c++) if (pixels[i + c] !== pixels[c]) uniform = false;
      }
      return { visible, premultiplied, uniform };
    };
    const difference = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum; };
    window.fx = { gl, template, SOURCES, sourceDefinition, build, drawSource, drawLegacy, stats, difference, vertexError: vertex.error };
  });
  return page;
}

test('source definitions are well formed', () => {
  assert.ok(Object.isFrozen(SOURCES) && SOURCES.length >= 30, `expected 30+ frozen sources, got ${SOURCES.length}`);
  const ids = SOURCES.map(definition => definition.id);
  assert.equal(new Set(ids).size, ids.length, 'source ids are unique');
  for (const definition of SOURCES) {
    const where = definition.id;
    assert.match(definition.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${where}: kebab-case id`);
    assert.ok(Object.isFrozen(definition) && Object.isFrozen(definition.params), `${where}: frozen`);
    assert.ok(typeof definition.name === 'string' && definition.name.length > 0, `${where}: name`);
    assert.ok(SOURCE_CATEGORIES.includes(definition.category), `${where}: category ${definition.category}`);
    assert.match(definition.glsl, /vec4\s+gen\s*\(\s*vec2\s+uv\s*\)/, `${where}: defines gen(uv)`);
    assert.equal(sourceDefinition(definition.id), definition);
    const keys = new Set();
    for (const param of definition.params) {
      const at = `${where}.${param.key}`;
      assert.match(param.key, /^[a-zA-Z][a-zA-Z0-9]*$/, `${at}: key`);
      assert.ok(!keys.has(param.key), `${at}: duplicate key`);
      keys.add(param.key);
      assert.ok(PARAM_TYPES.includes(param.type), `${at}: type ${param.type}`);
      assert.ok(typeof param.label === 'string' && param.label.length > 0, `${at}: label`);
      assert.ok(new RegExp(`\\b${uniformName(param.key)}\\b`).test(definition.glsl), `${at}: uniform is used by the shader`);
      if (param.type === 'float' || param.type === 'int') {
        assert.ok(Number.isFinite(param.min) && Number.isFinite(param.max) && param.min < param.max, `${at}: min < max`);
        assert.ok(param.default >= param.min && param.default <= param.max, `${at}: default in range`);
        if (param.type === 'int') assert.ok(Number.isInteger(param.default) && Number.isInteger(param.min) && Number.isInteger(param.max), `${at}: integer bounds`);
      } else if (param.type === 'choice') {
        assert.ok(Array.isArray(param.options) && param.options.length > 1 && param.options.every(option => typeof option === 'string' && option), `${at}: options`);
        assert.ok(Number.isInteger(param.default) && param.default >= 0 && param.default < param.options.length, `${at}: default option`);
      } else if (param.type === 'color') {
        assert.match(param.default, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i, `${at}: colour default`);
      } else if (param.type === 'point') {
        assert.ok(param.default.length === 2 && param.default.every(value => value >= param.min && value <= param.max), `${at}: point default`);
      } else if (param.type === 'bool') {
        assert.equal(typeof param.default, 'boolean', `${at}: bool default`);
      }
      assert.deepEqual(normalizeParam(param, param.default), Array.isArray(param.default) ? [...param.default] : param.default, `${at}: default survives normalization`);
    }
  }
  for (const id of LEGACY_IDS) {
    const definition = sourceDefinition(id);
    assert.ok(definition?.legacy, `${id} is a legacy source`);
    assert.equal(definition.params.find(param => param.key === 'color')?.default, '#ff6a38', `${id} takes the clip colour`);
  }
  assert.deepEqual(SOURCES.filter(definition => definition.legacy).map(definition => definition.id).sort(), [...LEGACY_IDS].sort());
  assert.equal(sourceDefinition('missing'), null);
});

test('every source compiles, links and renders valid animated output', { skip: !browserAvailable }, async () => {
  const page = await glPage();
  try {
    const results = await page.evaluate(times => fx.SOURCES.map(definition => {
      const built = fx.build(fx.template.buildSourceShader(definition), fx.template.uniformNames(definition));
      if (built.error) return { id: definition.id, error: built.error };
      const values = fx.template.defaultParams(definition);
      const frames = times.map(time => fx.drawSource(built, definition, values, time));
      return { id: definition.id, glError: fx.gl.getError(), stats: frames.map(fx.stats), change: fx.difference(frames[0], frames[1]) };
    }), TIMES);
    const failures = results.filter(result => result.error).map(result => `${result.id}\n${result.error}`);
    assert.deepEqual(failures, [], `shader failures:\n${failures.join('\n\n')}`);
    const problems = [];
    for (const result of results) {
      if (result.glError) problems.push(`${result.id}: GL error ${result.glError}`);
      if (!result.stats.some(frame => frame.visible > 0)) problems.push(`${result.id}: fully transparent`);
      if (!result.stats.every(frame => frame.premultiplied)) problems.push(`${result.id}: output is not premultiplied`);
      if (!STATIC_IDS.has(result.id) && result.change === 0) problems.push(`${result.id}: does not animate`);
      if (STATIC_IDS.has(result.id) && result.change !== 0) problems.push(`${result.id}: static source changed over time`);
      if (!FLAT_IDS.has(result.id) && result.stats.every(frame => frame.uniform)) problems.push(`${result.id}: renders a flat frame`);
    }
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test('legacy sources reproduce the original engine generators', { skip: !browserAvailable }, async () => {
  const page = await glPage();
  try {
    const result = await page.evaluate(({ legacy, times }) => {
      const old = fx.build(legacy, ['uImage', 'uSource', 'uTime', 'uColor', 'uFit', 'uAspect', 'uChannels', 'uIgnoreAlpha']);
      if (old.error) return { error: old.error };
      const index = { plasma: 1, grid: 2, rings: 3, noise: 4, solid: 5 };
      const report = {};
      for (const id of Object.keys(index)) {
        const definition = fx.sourceDefinition(id);
        const built = fx.build(fx.template.buildSourceShader(definition), fx.template.uniformNames(definition));
        let worst = 0;
        for (const color of ['#ff6a38', '#3f9cd0']) {
          for (const time of times) {
            const next = fx.drawSource(built, definition, { color }, time);
            const before = fx.drawLegacy(old, index[id], color, time);
            for (let i = 0; i < next.length; i++) worst = Math.max(worst, Math.abs(next[i] - before[i]));
          }
        }
        report[id] = worst;
      }
      const solid = fx.sourceDefinition('solid');
      const pixels = fx.drawSource(fx.build(fx.template.buildSourceShader(solid), fx.template.uniformNames(solid)), solid, { color: '#12ab7f' }, 3);
      report.solidPixel = [...pixels.slice(0, 4)];
      report.solidUniform = fx.stats(pixels).uniform;
      return report;
    }, { legacy: legacyShader, times: TIMES });
    assert.equal(result.error, undefined, result.error);
    for (const id of LEGACY_IDS) assert.ok(result[id] <= 2, `${id} differs from the engine shader by ${result[id]}`);
    assert.deepEqual(result.solidPixel, [0x12, 0xab, 0x7f, 255]);
    assert.ok(result.solidUniform);
  } finally {
    await page.close();
  }
});

test('text params normalize like the other param types', () => {
  const defaults = normalizeTextParams();
  assert.equal(defaults.text, 'PrismVJ');
  assert.equal(defaults.animate, false);
  assert.equal(TEXT_ANIMATOR.params.length, Object.keys(defaults).length);
  const values = normalizeTextParams({ text: 'A\r\nB', size: 9, alignment: 7, color: 'red', animate: true });
  assert.equal(values.text, 'A\nB');
  assert.equal(values.size, 1);
  assert.equal(values.alignment, 1);
  assert.equal(values.color, '#ffffff');
  assert.equal(values.animate, true);
  assert.equal(normalizeTextParams({ text: 42 }).text, 'PrismVJ');
  assert.equal(TEXT_ANIMATOR.kind, 'canvas');
  assert.equal(TEXT_ANIMATOR.params.find(param => param.key === 'text').type, 'text');
});

test('Text Animator draws, aligns, animates and caches its layout', { skip: !browserAvailable }, async () => {
  const page = await browser.newPage();
  try {
    await page.goto(baseURL);
    const result = await page.evaluate(async () => {
      const { TextAnimator } = await import('/fx/text-animator.js');
      const animator = new TextAnimator();
      const W = 320, H = 180;
      const frame = (params, time = 0) => {
        const canvas = animator.render(params, time, W, H);
        const data = animator.ctx.getImageData(0, 0, W, H).data;
        let count = 0, sumX = 0, sumA = 0, top = 0, bottom = 0, hash = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const a = data[(y * W + x) * 4 + 3];
            hash = (hash * 31 + a) >>> 0;
            if (!a) continue;
            count++; sumX += x * a; sumA += a;
            if (y < H / 2) top++; else bottom++;
          }
        }
        return { count, top, bottom, hash, centroid: sumA ? sumX / sumA : -1, size: [canvas.width, canvas.height], corner: data[3] };
      };
      const base = { text: 'Hello\nWorld', size: 0.2 };
      const plain = frame(base);
      const left = frame({ ...base, alignment: 0 });
      const center = frame({ ...base, alignment: 1 });
      const right = frame({ ...base, alignment: 2 });
      const animated = { ...base, animate: true, delay: 0.1, speed: 1, animY: 0.5, animScale: 0.3, animRotation: 20 };
      const a1 = frame(animated, 0.1), a2 = frame(animated, 0.6), a1again = frame(animated, 0.1);

      let calls = 0;
      const measure = animator.ctx.measureText.bind(animator.ctx);
      animator.ctx.measureText = text => { calls++; return measure(text); };
      frame({ ...animated, text: 'Cache me\nplease' }, 0);
      const afterLayout = { calls, layouts: animator.layoutCount };
      for (const time of [0.25, 0.5, 1.75]) frame({ ...animated, text: 'Cache me\nplease' }, time);
      frame({ ...animated, text: 'Cache me\nplease', alignment: 0, color: '#ff0000', x: 0.3, y: 0.6, spacingY: 2 }, 2);
      const afterTime = { calls, layouts: animator.layoutCount };
      frame({ ...animated, text: 'Changed' }, 2);
      const afterText = { calls, layouts: animator.layoutCount };
      animator.dispose();
      return { plain, left, center, right, a1, a2, a1again, afterLayout, afterTime, afterText, kind: animator.canvas === null };
    });
    assert.ok(result.plain.count > 200, `expected text pixels, got ${result.plain.count}`);
    assert.ok(result.plain.top > 50 && result.plain.bottom > 50, 'both lines are drawn');
    assert.equal(result.plain.corner, 0, 'background is transparent');
    assert.deepEqual(result.plain.size, [320, 180]);
    assert.ok(result.left.centroid > result.center.centroid + 20, `left ${result.left.centroid} vs center ${result.center.centroid}`);
    assert.ok(result.center.centroid > result.right.centroid + 20, `center ${result.center.centroid} vs right ${result.right.centroid}`);
    assert.ok(Math.abs(result.center.centroid - 160) < 20, 'centered text is centered');
    assert.notEqual(result.a1.hash, result.a2.hash, 'animation changes over time');
    assert.notEqual(result.a1.hash, result.plain.hash, 'animation moves characters');
    assert.equal(result.a1.hash, result.a1again.hash, 'animation is a pure function of time');
    assert.ok(result.afterLayout.calls > 0);
    assert.deepEqual(result.afterTime, result.afterLayout, 'time, colour, alignment and position reuse the layout');
    assert.equal(result.afterText.layouts, result.afterLayout.layouts + 1);
    assert.ok(result.afterText.calls > result.afterTime.calls);
    assert.ok(result.kind, 'dispose releases the canvas');
  } finally {
    await page.close();
  }
});
