import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { VIDEO_EFFECTS, videoEffect, LEGACY_EFFECT_IDS } from '../src/fx/video-effects.js';
import { PARAM_TYPES, effectPasses } from '../src/fx/shader-template.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browserAvailable = existsSync(chrome);
const W = 96, H = 54;
const LEGACY_IDS = ['invert', 'grayscale', 'brightness', 'contrast', 'saturation', 'hue', 'pixelate', 'mirror', 'kaleidoscope', 'strobe'];
// Effects whose default params are an identity transform by design.
const IDENTITY_DEFAULTS = new Set(['transform-2d', 'brightness', 'contrast', 'saturation', 'hue']);

let browser, server, page;

before(async () => {
  if (!browserAvailable) return;
  const files = {
    '/shader-template.js': await readFile(new URL('../src/fx/shader-template.js', import.meta.url)),
    '/video-effects.js': await readFile(new URL('../src/fx/video-effects.js', import.meta.url)),
  };
  server = createServer((request, response) => {
    const file = files[request.url];
    response.setHeader('Content-Type', file ? 'text/javascript' : 'text/html');
    response.end(file || '<!doctype html><title>fx</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(installRunner, { W, H });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

// Runs inside the page: a minimal test-only GL host for catalog effects.
async function installRunner({ W, H }) {
  const template = await import('/shader-template.js');
  const { VIDEO_EFFECTS } = await import('/video-effects.js');
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true });
  if (!gl) throw new Error('WebGL2 unavailable');
  const floatTargets = !!gl.getExtension('EXT_color_buffer_float');
  const vao = gl.createVertexArray();
  const shader = (type, source) => {
    const object = gl.createShader(type);
    gl.shaderSource(object, source);
    gl.compileShader(object);
    return object;
  };
  const vertex = shader(gl.VERTEX_SHADER, template.VERTEX_SHADER);
  if (!gl.getShaderParameter(vertex, gl.COMPILE_STATUS)) throw new Error(`vertex: ${gl.getShaderInfoLog(vertex)}`);

  const programs = new Map();
  const program = (def, pass) => {
    const key = `${def.id}:${pass}`;
    if (programs.has(key)) return programs.get(key);
    let result;
    const fragment = shader(gl.FRAGMENT_SHADER, template.buildEffectShader(def, pass));
    if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) result = { error: `compile: ${gl.getShaderInfoLog(fragment)}` };
    else {
      const object = gl.createProgram();
      gl.attachShader(object, vertex);
      gl.attachShader(object, fragment);
      gl.linkProgram(object);
      if (!gl.getProgramParameter(object, gl.LINK_STATUS)) result = { error: `link: ${gl.getProgramInfoLog(object)}` };
      else {
        const locations = {};
        for (const name of template.uniformNames(def)) {
          const location = gl.getUniformLocation(object, name);
          if (location) locations[name] = location;
        }
        result = { program: object, locations };
      }
    }
    programs.set(key, result);
    return result;
  };

  const texture = (data, float = false) => {
    const object = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, object);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return object;
  };
  const targets = [0, 1].map(() => {
    const tex = texture(null, floatTargets);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb };
  });

  // Patterns are unpremultiplied 0..255 rgba, uploaded premultiplied.
  const hsv = (h, s, v) => {
    const f = n => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5), f(3), f(1)];
  };
  const pattern = spec => {
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let rgba;
        if (spec.kind === 'flat') rgba = spec.color;
        else if (spec.kind === 'split') rgba = x < W / 2 ? spec.left : spec.right;
        else {
          const checker = (Math.floor(x / 12) + Math.floor(y / 12)) % 2 ? 1 : 0.6;
          const rgb = hsv(x / W, 0.85, (0.12 + 0.88 * y / (H - 1)) * checker);
          rgba = [...rgb.map(v => v * 255), y >= H - 6 ? 128 : 255];
        }
        const i = (y * W + x) * 4;
        const a = rgba[3] / 255;
        data[i] = Math.round(rgba[0] * a);
        data[i + 1] = Math.round(rgba[1] * a);
        data[i + 2] = Math.round(rgba[2] * a);
        data[i + 3] = Math.round(rgba[3]);
      }
    }
    return data;
  };

  // Returns premultiplied float rgba of the final pass.
  const render = (id, options = {}) => {
    const def = VIDEO_EFFECTS.find(effect => effect.id === id);
    if (!def) throw new Error(`unknown effect ${id}`);
    const { params = {}, input = { kind: 'test' }, previous = null, time = 1.37, beat = 2.3, audio = [0.5, 0.4, 0.3, 0.6] } = options;
    gl.getError();
    const inputData = pattern(input);
    const inputTex = texture(inputData);
    const prevTex = previous ? texture(pattern(previous)) : inputTex;
    const passes = template.effectPasses(def);
    let source = inputTex, target;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(vao);
    for (let pass = 0; pass < passes.length; pass++) {
      const compiled = program(def, pass);
      if (compiled.error) return { error: compiled.error };
      target = targets[pass % 2];
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.useProgram(compiled.program);
      const L = compiled.locations;
      [[source, 'uImage'], [inputTex, 'uOriginal'], [prevTex, 'uPrevious']].forEach(([tex, name], unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (L[name]) gl.uniform1i(L[name], unit);
      });
      if (L.uResolution) gl.uniform2f(L.uResolution, W, H);
      if (L.uAspect) gl.uniform1f(L.uAspect, W / H);
      if (L.uTime) gl.uniform1f(L.uTime, time);
      if (L.uBeat) gl.uniform1f(L.uBeat, beat);
      if (L.uAudio) gl.uniform4fv(L.uAudio, audio);
      if (L.uPass) gl.uniform1i(L.uPass, pass);
      template.bindParams(gl, L, def, params);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      source = target.tex;
    }
    let pixels;
    if (floatTargets) {
      pixels = new Float32Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, pixels);
    } else {
      const bytes = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      pixels = Float32Array.from(bytes, v => v / 255);
    }
    const glError = gl.getError();
    gl.deleteTexture(inputTex);
    if (prevTex !== inputTex) gl.deleteTexture(prevTex);
    return { pixels, inputData, glError };
  };

  window.fx = {
    floatTargets,
    ids: VIDEO_EFFECTS.map(effect => effect.id),
    compileAll() {
      const failures = [];
      for (const def of VIDEO_EFFECTS) {
        template.effectPasses(def).forEach((_, pass) => {
          const compiled = program(def, pass);
          if (compiled.error) failures.push({ id: def.id, pass, log: compiled.error });
        });
      }
      return failures;
    },
    // Summary stats for one render: validity and mean difference from input.
    stats(id, options) {
      const result = render(id, options);
      if (result.error) return { id, error: result.error };
      const { pixels, inputData, glError } = result;
      let finite = true, valid = true, diff = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const a = pixels[i + 3];
        for (let c = 0; c < 4; c++) {
          const v = pixels[i + c];
          if (!Number.isFinite(v)) finite = false;
          else if (v < -0.002 || v > 1.002 || (c < 3 && v > a + 0.004)) valid = false;
          diff += Math.abs(v - inputData[i + c] / 255);
        }
      }
      return { id, glError, finite, valid, diff: diff / pixels.length };
    },
    // Unpremultiplied 0..255 rgba at the requested pixel coordinates (origin bottom-left).
    sample(id, options, points) {
      const result = render(id, options);
      if (result.error) throw new Error(`${id}: ${result.error}`);
      return points.map(([x, y]) => {
        const i = (y * W + x) * 4, p = result.pixels;
        const a = p[i + 3];
        return [0, 1, 2].map(c => Math.round(a > 0.0001 ? p[i + c] / a * 255 : 0)).concat(Math.round(a * 255));
      });
    },
  };
}

const sample = (id, options, points) => page.evaluate(([id, options, points]) => window.fx.sample(id, options, points), [id, options, points]);
const near = (actual, expected, tolerance = 3, label = '') => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance, `${label} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`));
};

test('catalog metadata is complete and valid', () => {
  assert.ok(Object.isFrozen(VIDEO_EFFECTS));
  assert.ok(VIDEO_EFFECTS.filter(effect => !effect.legacy).length >= 80, 'at least 80 non-legacy effects');
  const ids = new Set(), names = new Set();
  for (const effect of VIDEO_EFFECTS) {
    const where = `effect ${effect.id}`;
    assert.match(effect.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${where}: kebab-case id`);
    assert.ok(!ids.has(effect.id), `${where}: duplicate id`);
    ids.add(effect.id);
    assert.ok(typeof effect.name === 'string' && effect.name.length, `${where}: name`);
    assert.ok(!names.has(effect.name), `${where}: duplicate name ${effect.name}`);
    names.add(effect.name);
    assert.ok(typeof effect.category === 'string' && effect.category.length, `${where}: category`);
    assert.ok(Object.isFrozen(effect) && Object.isFrozen(effect.params), `${where}: frozen`);
    const passes = effectPasses(effect);
    assert.ok(passes.length >= 1, `${where}: passes`);
    for (const body of passes) {
      assert.equal(typeof body, 'string', `${where}: glsl body`);
      assert.match(body, /vec4\s+fx\s*\(\s*vec2\s+uv\s*\)/, `${where}: defines fx`);
    }
    const usesPrev = passes.some(body => /\bprev\s*\(/.test(body));
    assert.equal(!!effect.feedback, usesPrev, `${where}: feedback flag matches prev() use`);
    const keys = new Set();
    for (const param of effect.params) {
      const at = `${where} param ${param.key}`;
      assert.match(param.key, /^[a-zA-Z][a-zA-Z0-9]*$/, `${at}: key`);
      assert.ok(!keys.has(param.key), `${at}: duplicate key`);
      keys.add(param.key);
      assert.ok(typeof param.label === 'string' && param.label.length, `${at}: label`);
      assert.ok(PARAM_TYPES.includes(param.type), `${at}: type ${param.type}`);
      if (param.type === 'float' || param.type === 'int') {
        assert.ok(Number.isFinite(param.min) && Number.isFinite(param.max) && param.min < param.max, `${at}: range`);
        assert.ok(Number.isFinite(param.default) && param.default >= param.min && param.default <= param.max, `${at}: default in range`);
        if (param.type === 'int') assert.ok(Number.isInteger(param.default) && Number.isInteger(param.min) && Number.isInteger(param.max), `${at}: integer`);
      } else if (param.type === 'choice') {
        assert.ok(Array.isArray(param.options) && param.options.length >= 2 && param.options.every(option => typeof option === 'string'), `${at}: options`);
        assert.ok(Number.isInteger(param.default) && param.default >= 0 && param.default < param.options.length, `${at}: default option`);
      } else if (param.type === 'bool') {
        assert.equal(typeof param.default, 'boolean', `${at}: bool default`);
      } else if (param.type === 'color') {
        assert.match(param.default, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i, `${at}: color default`);
      } else if (param.type === 'point') {
        assert.ok(Array.isArray(param.default) && param.default.length === 2, `${at}: point default`);
        param.default.forEach(value => assert.ok(value >= (param.min ?? 0) && value <= (param.max ?? 1), `${at}: point in range`));
      }
    }
    for (const token of passes.join('\n').match(/\bp_[a-zA-Z0-9_]+/g) || []) assert.ok(keys.has(token.slice(2)), `${where}: ${token} has no param`);
  }
});

test('legacy effects keep their ids and single amount param', () => {
  assert.deepEqual([...LEGACY_EFFECT_IDS].sort(), [...LEGACY_IDS].sort());
  for (const id of LEGACY_IDS) {
    const effect = videoEffect(id);
    assert.ok(effect, id);
    assert.equal(effect.legacy, true, id);
    assert.deepEqual(effect.params.map(({ key, type, min, max, default: value }) => ({ key, type, min, max, value })), [{ key: 'amount', type: 'float', min: 0, max: 1, value: 0.5 }], id);
  }
  assert.equal(videoEffect('nope'), null);
  assert.equal(videoEffect('hue-rotate').name, 'Hue Rotate');
});

test('every effect pass compiles and links', { skip: !browserAvailable }, async () => {
  const failures = await page.evaluate(() => window.fx.compileAll());
  assert.deepEqual(failures, [], `failing effects:\n${failures.map(f => `${f.id} [pass ${f.pass}]\n${f.log}`).join('\n')}`);
});

test('every effect renders valid output with default params', { skip: !browserAvailable }, async () => {
  const results = await page.evaluate(([ids, feedbackIds]) => ids.map(id => window.fx.stats(id, feedbackIds.includes(id) ? { previous: { kind: 'flat', color: [255, 255, 255, 255] } } : {})), [VIDEO_EFFECTS.map(e => e.id), VIDEO_EFFECTS.filter(e => e.feedback).map(e => e.id)]);
  const problems = [];
  for (const result of results) {
    if (result.error) problems.push(`${result.id}: ${result.error}`);
    else {
      if (result.glError !== 0) problems.push(`${result.id}: GL error ${result.glError}`);
      if (!result.finite) problems.push(`${result.id}: non-finite output`);
      if (!result.valid) problems.push(`${result.id}: invalid premultiplied output`);
      if (!IDENTITY_DEFAULTS.has(result.id) && result.diff < 0.002) problems.push(`${result.id}: default params leave the image unchanged (diff ${result.diff.toFixed(5)})`);
      if (IDENTITY_DEFAULTS.has(result.id) && result.diff > 0.004) problems.push(`${result.id}: expected identity defaults (diff ${result.diff.toFixed(5)})`);
    }
  }
  assert.deepEqual(problems, []);
});

test('effect semantics match their names', { skip: !browserAvailable }, async () => {
  const white = { kind: 'flat', color: [255, 255, 255, 255] };
  const swatch = { kind: 'flat', color: [200, 100, 50, 255] };
  const L = [10, 27], R = [85, 27], C = [48, 27];

  near((await sample('invert-rgb', { input: white }, [C]))[0], [0, 0, 0, 255], 2, 'invert-rgb white');
  near((await sample('invert', { input: swatch, params: { amount: 1 } }, [C]))[0], [55, 155, 205, 255], 2, 'legacy invert 1');
  near((await sample('invert', { input: swatch, params: { amount: 0 } }, [C]))[0], [200, 100, 50, 255], 2, 'legacy invert 0');
  const [gray] = await sample('grayscale', { input: swatch, params: { amount: 1 } }, [C]);
  assert.ok(Math.abs(gray[0] - gray[1]) <= 1 && Math.abs(gray[1] - gray[2]) <= 1, `legacy grayscale ${gray}`);
  for (const id of ['brightness', 'contrast', 'saturation', 'hue']) near((await sample(id, { input: swatch }, [C]))[0], [200, 100, 50, 255], 2, `legacy ${id} identity`);
  near((await sample('brightness', { input: swatch, params: { amount: 0.25 } }, [C]))[0], [100, 50, 25, 255], 2, 'legacy brightness');
  assert.equal((await sample('strobe', { input: swatch, params: { amount: 1 }, time: 0.03 }, [C]))[0][3], 0, 'legacy strobe off');
  assert.equal((await sample('strobe', { input: swatch, params: { amount: 1 }, time: 0.01 }, [C]))[0][3], 255, 'legacy strobe on');
  assert.equal((await sample('strobe', { input: swatch, params: { amount: 0 }, time: 0.03 }, [C]))[0][3], 255, 'legacy strobe disabled');

  const redBlue = { kind: 'split', left: [255, 0, 0, 255], right: [0, 0, 255, 255] };
  const flipped = await sample('flip', { input: redBlue }, [L, R]);
  near(flipped[0], [0, 0, 255, 255], 2, 'flip left');
  near(flipped[1], [255, 0, 0, 255], 2, 'flip right');
  const mirrored = await sample('mirror', { input: redBlue }, [[4, 27], [91, 27]]);
  near(mirrored[0], [0, 0, 255, 255], 2, 'legacy mirror left');
  near(mirrored[1], [0, 0, 255, 255], 2, 'legacy mirror right');

  const darkLight = { kind: 'split', left: [50, 50, 50, 255], right: [200, 200, 200, 255] };
  const thresholded = await sample('threshold', { input: darkLight }, [L, R]);
  near(thresholded[0], [0, 0, 0, 255], 1, 'threshold dark');
  near(thresholded[1], [255, 255, 255, 255], 1, 'threshold light');

  const keyed = await sample('luma-key', { input: { kind: 'split', left: [10, 10, 10, 255], right: [230, 230, 230, 255] } }, [L, R]);
  assert.equal(keyed[0][3], 0, 'luma-key removes dark pixels');
  near(keyed[1], [230, 230, 230, 255], 2, 'luma-key keeps bright pixels');

  const chroma = await sample('chroma-key', { input: { kind: 'split', left: [0, 255, 0, 255], right: [255, 0, 0, 255] } }, [L, R]);
  assert.equal(chroma[0][3], 0, 'chroma-key removes green');
  assert.equal(chroma[1][3], 255, 'chroma-key keeps red');

  const flat = { kind: 'flat', color: [180, 60, 120, 255] };
  for (const pixel of await sample('blur', { input: flat, params: { radius: 40 } }, [[0, 0], [95, 53], C])) near(pixel, [180, 60, 120, 255], 2, 'blur flat');
  near((await sample('blur', { input: { kind: 'flat', color: [180, 60, 120, 128] }, params: { radius: 20 } }, [C]))[0], [180, 60, 120, 128], 3, 'blur translucent flat');
  const edge = await sample('blur', { input: { kind: 'split', left: [0, 0, 0, 255], right: [255, 255, 255, 255] }, params: { radius: 12 } }, [[2, 27], [47, 27], [93, 27]]);
  assert.ok(edge[0][0] <= 2 && edge[2][0] >= 253 && edge[1][0] > 40 && edge[1][0] < 215, `blur edge ${JSON.stringify(edge)}`);

  const glowed = await sample('glow', { input: { kind: 'split', left: [0, 0, 0, 255], right: [255, 255, 255, 255] } }, [[44, 27], [2, 27]]);
  assert.ok(glowed[0][0] > 15, `glow spills into dark side ${glowed[0]}`);
  assert.ok(glowed[1][0] <= 2, `glow stays local ${glowed[1]}`);

  near((await sample('hue-rotate', { input: { kind: 'flat', color: [255, 0, 0, 255] }, params: { hue: 1 / 3 } }, [C]))[0], [0, 255, 0, 255], 3, 'hue-rotate');
  near((await sample('fill-color', { input: swatch }, [C]))[0], [255, 34, 102, 255], 1, 'fill-color');
  const poster = (await sample('posterize', { params: { levels: 2 } }, [[5, 5], [40, 30], [80, 45]])).flatMap(p => p.slice(0, 3));
  assert.ok(poster.every(v => v <= 1 || v >= 254), `posterize 2 levels ${poster}`);

  const [trail] = await sample('trails', { input: { kind: 'flat', color: [0, 0, 0, 255] }, previous: white }, [C]);
  near(trail, [217, 217, 217, 255], 3, 'trails keeps decayed previous frame');
  const [fresh] = await sample('trails', { input: white, previous: { kind: 'flat', color: [0, 0, 0, 255] } }, [C]);
  near(fresh, [255, 255, 255, 255], 2, 'trails shows current frame');

  const chase = await sample('chaser', { input: white, beat: 0.5 }, [[5, 27], [30, 27], [60, 27], [90, 27]]);
  assert.deepEqual(chase.map(p => p[3]), [255, 0, 0, 0], 'chaser lights only the first step on beat 0');
  const chase2 = await sample('chaser', { input: white, beat: 2.5 }, [[5, 27], [30, 27], [60, 27], [90, 27]]);
  assert.deepEqual(chase2.map(p => p[3]), [0, 0, 255, 0], 'chaser advances one step per beat');
});
