import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import converterModule from '../electron/media-converter.cjs';
import { sourceFile } from './src-server.mjs';
import { encode, referenceFrames, readMovie, composeAlphaMovies, dxvHighQualityFrame, writeDxvMovie } from './gpu-video-fixtures.mjs';
import { decodeHapFrame } from '../src/gpu-video/hap.js';
import { frameAt } from '../src/gpu-video/mov.js';

const { discoverExecutable } = converterModule;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ffmpeg = await discoverExecutable('ffmpeg').catch(() => null);
const available = existsSync(chrome) && !!ffmpeg;
const WIDTH = 128, HEIGHT = 72, FPS = 10;
// Resolume's bundled DXV3 DXT5 clip, when installed, checks real premultiplied footage.
const resolumeDxt5 = 'C:/Program Files/Resolume Arena/media/Shop74/BattleWeapon_Tank_09.mov';

let browser, server, baseURL, directory;
const media = new Map(), references = {};
let alphaValues;

before(async () => {
  if (!available) return;
  directory = await mkdtemp(path.join(os.tmpdir(), 'prism-hap-'));
  const file = name => path.join(directory, `${name}.mov`);
  await Promise.all([
    encode(ffmpeg, file('hap'), { format: 'hap' }),
    encode(ffmpeg, file('hap_alpha'), { format: 'hap_alpha', alpha: true }),
    encode(ffmpeg, file('hap_q'), { format: 'hap_q' }),
    encode(ffmpeg, file('hap_q_chunks'), { format: 'hap_q', chunks: 4 }),
    encode(ffmpeg, file('hap_raw'), { format: 'hap', compressor: 'none' }),
  ]);
  const composed = await composeAlphaMovies(file('hap_q'), directory);
  alphaValues = composed.alpha;
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:r=${FPS}:d=1.2`, '-c:v', 'dxv', file('dxv_dxt1')]);
  for (const format of ['YCG6', 'YG10']) {
    await writeFile(file(`dxv_${format}`), writeDxvMovie(Array.from({ length: 12 }, (_, seed) => dxvHighQualityFrame(format, WIDTH, HEIGHT, seed)), { width: WIDTH, height: HEIGHT, fps: FPS }));
    references[`dxv_${format}`] = await planarFrames(file(`dxv_${format}`), format === 'YG10');
  }
  for (const name of ['hap', 'hap_alpha', 'hap_q', 'hap_q_chunks', 'hap_raw', 'hap_q_alpha', 'hap_alpha_only', 'dxv_dxt1', 'dxv_YCG6', 'dxv_YG10']) media.set(`/media/${name}.mov`, await readFile(file(name)));
  if (existsSync(resolumeDxt5)) media.set('/media/resolume_dxt5.mov', await readFile(resolumeDxt5));
  for (const name of ['hap', 'hap_alpha', 'hap_q', 'dxv_dxt1']) references[name] = await referenceFrames(ffmpeg, file(name), WIDTH, HEIGHT);
  media.set('/media/converted.webm', await readFile(new URL('./engine-fixture.webm', import.meta.url)));
  server = createServer((request, response) => {
    const [pathname, query = ''] = request.url.split('?');
    const source = sourceFile(pathname);
    if (source) { response.setHeader('Content-Type', source.type); response.end(source.body); return; }
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(`<canvas id="output" width="${WIDTH}" height="${HEIGHT}"></canvas>`); return; }
    // The desktop host serves a converted copy for ?converted=1 (no S3TC).
    const body = media.get(/(^|&)converted=1/.test(query) ? '/media/converted.webm' : pathname);
    if (!body) { response.writeHead(404); response.end(); return; }
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', pathname.endsWith('.webm') || /converted=1/.test(query) ? 'video/webm' : 'video/quicktime');
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
      response.end(body.subarray(start, end + 1));
      return;
    }
    response.setHeader('Content-Length', body.length);
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
// FFmpeg's Y, Cg (U), Co (V) and alpha planes: it cannot convert YCoCg to RGB.
async function planarFrames(file, alpha) {
  const { stdout } = await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-f', 'rawvideo', '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 });
  const luma = WIDTH * HEIGHT, chroma = luma / 4, size = luma + 2 * chroma + (alpha ? luma : 0), frames = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) {
    const frame = stdout.subarray(offset, offset + size), rgba = Buffer.alloc(luma * 4);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const i = y * WIDTH + x, c = (y >> 1) * (WIDTH / 2) + (x >> 1);
      const Y = frame[i], cg = frame[luma + c] - 128, co = frame[luma + chroma + c] - 128;
      const clip = value => Math.max(0, Math.min(255, value));
      rgba.set([clip(Y + co - cg), clip(Y + cg), clip(Y - co - cg), alpha ? frame[luma + 2 * chroma + i] : 255], i * 4);
    }
    frames.push(rgba);
  }
  return frames;
}

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const page = await browser.newPage();
  await page.goto(baseURL);
  await page.evaluate(async () => {
    const { LiveEngine } = await import('/engine.js');
    window.errors = [];
    window.engine = new LiveEngine(document.querySelector('canvas'), { onError: error => errors.push(error) });
    window.project = { id: 'project', width: 128, height: 72, speed: 1, bpm: 120, masterOpacity: 1, masterVolume: 1, crossfader: 0.5, paused: false, blackout: false, layers: [], effects: [] };
    window.layer = { id: 'layer', opacity: 1, volume: 1, blend: 'normal', group: 'none', effects: [] };
    project.layers = [layer];
    window.movie = (name, extras = {}) => ({ id: name, name, kind: 'video', path: `C:/media/${name}.mov`, url: `/media/${name}.mov?gpu=${name.startsWith('dxv') || name.startsWith('resolume') ? 'dxv' : 'hap'}`,
      duration: 1.2, opacity: 1, volume: 1, speed: 1, direction: 1, scale: 1, effects: [], ...extras });
    window.clock = 1;
    // Renders until the frame chosen for `time` is on screen, then returns the
    // displayed RGBA rows top first: composited over black, or the
    // premultiplied composition (`transparent`).
    window.show = async (clip, time, extras = {}, transparent = false) => {
      const frame = { layer, clip, time, position: time / clip.duration, weight: 1, ...extras };
      for (let attempt = 0; attempt < 400; attempt++) {
        engine.render(project, [frame], clock += 1 / 60);
        const entry = engine.media.get(clip.id);
        if (entry?.failed) throw new Error(errors.join('\n') || 'Media failed.');
        if (entry?.player?.presented && entry.player.presented.index === entry.wantIndex) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const gl = engine.gl, width = engine.canvas.width, height = engine.canvas.height, stride = width * 4, pixels = new Uint8Array(stride * height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, transparent ? engine.lastFinished.framebuffer : null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const rows = new Uint8Array(pixels.length);
      for (let y = 0; y < height; y++) rows.set(pixels.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
      let text = '';
      for (let i = 0; i < rows.length; i += 0x8000) text += String.fromCharCode(...rows.subarray(i, i + 0x8000));
      const entry = engine.media.get(clip.id);
      return { pixels: btoa(text), index: entry.player.presented.index, currentTime: engine.getMedia(clip.id).currentTime };
    };
  });
  return page;
}

const decode = base64 => Buffer.from(base64, 'base64');
// Differences between FFmpeg's DXT decoder and the GPU's are rounding only.
// Colours are compared premultiplied (as composited over black); alpha is
// compared when reading the transparent composition (`premultiply`).
// `include(pixel)` limits the comparison to some pixels.
function compare(actual, expected, { premultiply = false, alphaOnly = false, include = () => true } = {}) {
  let total = 0, worst = 0, count = 0;
  for (let i = 0; i < expected.length; i += 4) {
    if (!include(i / 4)) continue;
    const alpha = expected[i + 3];
    for (let channel = alphaOnly ? 3 : 0; channel < 4; channel++) {
      const want = channel === 3 ? (premultiply ? alpha : 255) : expected[i + channel] * alpha / 255;
      const difference = Math.abs(actual[i + channel] - want);
      total += difference; worst = Math.max(worst, difference); count++;
    }
  }
  return { mean: total / count, worst };
}

test('HAP frames decode to their DXT/BC texture data regardless of chunking or compression', { skip: !available }, async () => {
  const plain = await readMovie(path.join(directory, 'hap_q.mov')), chunked = await readMovie(path.join(directory, 'hap_q_chunks.mov'));
  assert.equal(plain.movie.fourcc, 'HapY');
  assert.equal(plain.movie.count, 12);
  assert.equal(plain.movie.frameRate, FPS);
  assert.deepEqual([plain.movie.width, plain.movie.height], [WIDTH, HEIGHT]);
  for (let i = 0; i < plain.movie.count; i++) {
    const [single] = decodeHapFrame(plain.frames[i], WIDTH, HEIGHT), [split] = decodeHapFrame(chunked.frames[i], WIDTH, HEIGHT);
    assert.equal(single.format, 'ycocg');
    assert.equal(single.data.length, WIDTH * HEIGHT);
    assert.deepEqual(split.data, single.data, `frame ${i}`);
  }
  const snappy = await readMovie(path.join(directory, 'hap.mov')), raw = await readMovie(path.join(directory, 'hap_raw.mov'));
  assert.ok(raw.frames[0].length > snappy.frames[0].length);
  assert.deepEqual(decodeHapFrame(raw.frames[3], WIDTH, HEIGHT)[0].data, decodeHapFrame(snappy.frames[3], WIDTH, HEIGHT)[0].data);
  const times = snappy.movie.times;
  assert.equal(frameAt(times, 12, 0), 0);
  assert.equal(frameAt(times, 12, 0.3), 3);
  assert.equal(frameAt(times, 12, 0.35), 3);
  assert.equal(frameAt(times, 12, 5), 11);
  const qAlpha = await readMovie(path.join(directory, 'hap_q_alpha.mov'));
  assert.equal(qAlpha.movie.fourcc, 'HapM');
  assert.deepEqual(decodeHapFrame(qAlpha.frames[0], WIDTH, HEIGHT).map(texture => texture.format), ['ycocg', 'bc4']);
});

test('Hap, Hap Alpha and Hap Q play forward on the GPU with FFmpeg-matching pixels', { skip: !available, timeout: 120000 }, async () => {
  const page = await setup();
  try {
    for (const name of ['hap', 'hap_alpha', 'hap_q']) {
      await page.evaluate(name => engine.prepare(movie(name)), name);
      const info = await page.evaluate(name => { const entry = engine.media.get(name); return { kind: entry.kind, hasAlpha: entry.hasAlpha, width: entry.element.videoWidth, duration: entry.element.duration }; }, name);
      assert.deepEqual(info, { kind: 'gpu', hasAlpha: name === 'hap_alpha', width: WIDTH, duration: 1.2 });
      for (const index of [0, 1, 2, 5, 11]) {
        const shown = await page.evaluate(([name, time]) => show(movie(name), time), [name, (index + 0.5) / FPS]);
        assert.equal(shown.index, index);
        assert.ok(Math.abs(shown.currentTime - index / FPS) < 1e-9);
        const result = compare(decode(shown.pixels), references[name][index]);
        assert.ok(result.mean < 0.5 && result.worst <= 3, `${name} frame ${index}: mean ${result.mean.toFixed(2)}, worst ${result.worst}`);
      }
      if (name === 'hap_alpha') {
        // The composition keeps the movie's own transparency.
        const shown = await page.evaluate(() => show(movie('hap_alpha'), 0.25, {}, true));
        const result = compare(decode(shown.pixels), references.hap_alpha[2], { premultiply: true });
        const alpha = compare(decode(shown.pixels), references.hap_alpha[2], { premultiply: true, alphaOnly: true });
        assert.ok(result.mean < 0.5, `premultiplied mean ${result.mean}`);
        assert.ok(alpha.worst <= 3, `alpha worst ${alpha.worst}`);
      }
    }
    assert.deepEqual(await page.evaluate(() => errors), []);
    assert.equal(await page.evaluate(() => engine.gl.getError()), 0);
  } finally { await page.close(); }
});

test('reverse playback and scrubbing choose frames from the transport and prefetch backwards', { skip: !available, timeout: 120000 }, async () => {
  const page = await setup();
  try {
    // No prepare(): the render loop opens the movie and syncs it once ready.
    const seen = [];
    for (let index = 11; index >= 0; index -= 1) {
      const shown = await page.evaluate(time => show(movie('hap_q'), time, { direction: -1, rate: 1, playing: true }), (index + 0.5) / FPS);
      seen.push(shown.index);
      const result = compare(decode(shown.pixels), references.hap_q[index]);
      assert.ok(result.mean < 0.5, `reverse frame ${index}: ${result.mean}`);
    }
    assert.deepEqual(seen, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    // Frames ahead of the playhead in reverse are already requested.
    const wanted = await page.evaluate(() => { const player = engine.media.get('hap_q').player; return [...player.wanted]; });
    assert.deepEqual(wanted.slice(0, 4), [0, 11, 10, 9]);
    // Paused scrubbing to arbitrary positions shows exactly that frame.
    for (const index of [7, 2, 9, 4]) {
      const shown = await page.evaluate(time => show(movie('hap_q', { paused: true }), time, { rate: 0, playing: false }), (index + 0.2) / FPS);
      assert.equal(shown.index, index);
      assert.ok(compare(decode(shown.pixels), references.hap_q[index]).mean < 0.5);
    }
    const state = await page.evaluate(() => { const element = engine.getMedia('hap_q'); return { paused: element.paused, wanted: [...engine.media.get('hap_q').player.wanted] }; });
    assert.deepEqual(state, { paused: true, wanted: [4] });
    assert.deepEqual(await page.evaluate(() => errors), []);
  } finally { await page.close(); }
});

test('Hap Q Alpha and Hap Alpha-Only combine RGTC alpha planes, with or without RGTC support', { skip: !available, timeout: 120000 }, async () => {
  for (const rgtc of [true, false]) {
    const page = await setup();
    try {
      if (!rgtc) await page.evaluate(() => { delete engine.gpuFormats.bc4; });
      const shown = await page.evaluate(async () => { await engine.prepare(movie('hap_q_alpha')); return show(movie('hap_q_alpha'), 0.35, {}, true); });
      const pixels = decode(shown.pixels);
      assert.equal(shown.index, 3);
      let alphaWorst = 0, colorTotal = 0;
      for (let i = 0; i < WIDTH * HEIGHT; i++) {
        const alpha = alphaValues[i];
        alphaWorst = Math.max(alphaWorst, Math.abs(pixels[i * 4 + 3] - alpha));
        for (let channel = 0; channel < 3; channel++) colorTotal += Math.abs(pixels[i * 4 + channel] - references.hap_q[3][i * 4 + channel] * alpha / 255);
      }
      assert.ok(alphaWorst <= 2, `alpha worst ${alphaWorst} (rgtc ${rgtc})`);
      assert.ok(colorTotal / (WIDTH * HEIGHT * 3) < 0.5, `color mean ${colorTotal / (WIDTH * HEIGHT * 3)}`);
      assert.equal(await page.evaluate(() => engine.media.get('hap_q_alpha').hasAlpha), true);
      // Alpha-Only shows its matte as an opaque grayscale image.
      const matte = decode((await page.evaluate(async () => { await engine.prepare(movie('hap_alpha_only')); return show(movie('hap_alpha_only'), 0.1); })).pixels);
      let matteWorst = 0;
      for (let i = 0; i < WIDTH * HEIGHT; i++) for (let channel = 0; channel < 3; channel++) matteWorst = Math.max(matteWorst, Math.abs(matte[i * 4 + channel] - alphaValues[i]));
      assert.ok(matteWorst <= 2, `matte worst ${matteWorst}`);
      assert.deepEqual(await page.evaluate(() => errors), []);
    } finally { await page.close(); }
  }
});

test('DXV DXT1 and high quality YCoCg (with and without alpha) play on the GPU', { skip: !available, timeout: 120000 }, async () => {
  for (const rgtc of [true, false]) {
    const page = await setup();
    try {
      if (!rgtc) await page.evaluate(() => { delete engine.gpuFormats.bc4; delete engine.gpuFormats.bc5; });
      for (const [name, hasAlpha] of [['dxv_dxt1', false], ['dxv_YCG6', false], ['dxv_YG10', true]]) {
        await page.evaluate(name => engine.prepare(movie(name)), name);
        assert.equal(await page.evaluate(name => engine.media.get(name).hasAlpha, name), hasAlpha, name);
        // Chroma is constant in 16x16 cells; skip pixels where upsampling blends cells.
        const include = name === 'dxv_dxt1' ? undefined : pixel => (pixel % WIDTH) % 16 >= 2 && (pixel % WIDTH) % 16 <= 13 && Math.floor(pixel / WIDTH) % 16 >= 2 && Math.floor(pixel / WIDTH) % 16 <= 13;
        for (const index of [0, 4, 11, 6]) {
          const shown = await page.evaluate(([name, time]) => show(movie(name), time), [name, (index + 0.5) / FPS]);
          assert.equal(shown.index, index);
          const result = compare(decode(shown.pixels), references[name][index], { include });
          assert.ok(result.mean < 0.6 && result.worst <= 4, `${name} frame ${index} (rgtc ${rgtc}): mean ${result.mean.toFixed(2)}, worst ${result.worst}`);
        }
        if (hasAlpha) {
          const shown = await page.evaluate(name => show(movie(name), 0.75, {}, true), name);
          const alpha = compare(decode(shown.pixels), references[name][7], { premultiply: true, alphaOnly: true });
          assert.ok(alpha.worst <= 2, `${name} alpha worst ${alpha.worst}`);
        }
      }
      assert.deepEqual(await page.evaluate(() => errors), []);
    } finally { await page.close(); }
  }
});

test("Resolume's own DXV3 DXT5 footage matches FFmpeg after un-premultiplying", { skip: !available || !existsSync(resolumeDxt5), timeout: 120000 }, async () => {
  const { movie } = await readMovie(resolumeDxt5);
  const frames = [3, 45];
  const reference = await referenceFrames(ffmpeg, resolumeDxt5, movie.width, movie.height);
  const page = await setup();
  try {
    await page.evaluate(([width, height]) => { engine.resize(width, height); project.width = width; project.height = height; }, [movie.width, movie.height]);
    for (const index of frames) {
      const shown = await page.evaluate(([time, duration]) => show(movie('resolume_dxt5', { duration }), time, {}, true), [movie.times[index] + 0.5 / movie.frameRate, movie.duration]);
      assert.equal(shown.index, index);
      const result = compare(decode(shown.pixels), reference[index], { premultiply: true });
      assert.ok(result.mean < 0.6 && result.worst <= 4, `frame ${index}: mean ${result.mean.toFixed(3)}, worst ${result.worst}`);
    }
    assert.equal(await page.evaluate(() => engine.media.get('resolume_dxt5').hasAlpha), true);
  } finally { await page.close(); }
});

test('without S3TC the clip plays the converted copy instead', { skip: !available, timeout: 60000 }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      engine.gpuFormats = {};
      const clip = movie('hap');
      await engine.prepare(clip);
      engine.render(project, [{ layer, clip, time: 0.1, position: 0.1 / clip.duration, weight: 1 }], clock += 1 / 60);
      const entry = engine.media.get('hap');
      return { kind: entry.kind, url: entry.url, reverse: [...engine.media.keys()].some(key => key.includes('reverse')) };
    });
    assert.deepEqual(result, { kind: 'video', url: '/media/hap.mov?gpu=hap&converted=1', reverse: false });
  } finally { await page.close(); }
});

test('removing a GPU clip releases its textures, frames and decoder requests', { skip: !available, timeout: 60000 }, async () => {
  const page = await setup();
  try {
    const result = await page.evaluate(async () => {
      const clip = movie('hap_alpha');
      await engine.prepare(clip);
      await show(clip, 0.5);
      const entry = engine.media.get('hap_alpha'), player = entry.player;
      const textures = [entry.texture, ...entry.surface.planes.map(plane => plane.texture)];
      engine.remove('hap_alpha');
      engine.render(project, [], clock += 1 / 60);
      return { gone: !engine.media.has('hap_alpha'), frames: player.frames.size, pending: player.pending.size, disposed: player.disposed,
        deleted: textures.every(texture => !engine.gl.isTexture(texture)), error: engine.gl.getError() };
    });
    assert.deepEqual(result, { gone: true, frames: 0, pending: 0, disposed: true, deleted: true, error: 0 });
  } finally { await page.close(); }
});