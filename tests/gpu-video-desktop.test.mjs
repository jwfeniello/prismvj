// HAP movies in the desktop app: import without a playback transcode, play
// from the original file through compressed GPU textures in the composition,
// preview and output windows, follow reverse playback, and serve the
// soundtrack and thumbnail on request. Also reports 1080p decode cost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import converterModule from '../electron/media-converter.cjs';
import { createClip, createLayer, createProject } from '../src/model.js';
import { referenceFrames } from './gpu-video-fixtures.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const execute = promisify(execFile);
const ffmpeg = await converterModule.discoverExecutable('ffmpeg').catch(() => null);
const WIDTH = 128, HEIGHT = 72, FPS = 15;

async function encode(destination, args) {
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, destination], { windowsHide: true, timeout: 120000 });
  return destination;
}

test('HAP imports instantly and plays from the original file on the GPU', { timeout: 240000, skip: !ffmpeg }, async t => {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Run npm run build before desktop integration tests.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-hap-desktop-'));
  const profile = path.join(temporary, 'profile'), cache = path.join(profile, 'media-cache');
  await mkdir(profile, { recursive: true });
  // Transparent gradient over moving test footage, with a 440 Hz soundtrack.
  const movie = await encode(path.join(temporary, 'Gradient Alpha.mov'), ['-f', 'lavfi', '-i',
    `testsrc2=s=${WIDTH}x${HEIGHT}:r=${FPS}:d=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*X/${WIDTH - 1}'`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'hap', '-format', 'hap_alpha', '-c:a', 'pcm_s16le', '-shortest']);
  const large = await encode(path.join(temporary, 'Full HD.mov'), ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=2', '-c:v', 'hap', '-format', 'hap_q']);
  const dxv = await encode(path.join(temporary, 'Resolume DXV.mov'), ['-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:r=${FPS}:d=2`, '-c:v', 'dxv']);
  const reference = await referenceFrames(ffmpeg, movie, WIDTH, HEIGHT);
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PRISM_DEV_URL;
  let application, page;
  const pageErrors = [];
  const openProject = async (project, name) => {
    const destination = path.join(temporary, `${name}.prism`);
    await writeFile(destination, JSON.stringify(project));
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, destination);
    await page.locator('#open-project').click();
    await page.waitForFunction(name => prismDiagnostics().project.name === name, project.name);
  };
  // A one-layer composition of `media` paused inside frame 7 (0.5 s).
  const pausedComposition = (media, name, extras = {}) => {
    const project = createProject();
    project.name = name; project.width = WIDTH; project.height = HEIGHT;
    project.decks = [project.decks[0]]; project.columns = 2;
    const clip = createClip('video', { ...media, duration: 2, videoDuration: 2, direction: 0, inPoint: 0.5 / 2, ...extras });
    return { project, clip };
  };
  const canvasPixels = selector => page.evaluate(selector => {
    const canvas = document.querySelector(selector), gl = canvas.getContext('webgl2'), pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { width: canvas.width, height: canvas.height, pixels: btoa(String.fromCharCode(...pixels)) };
  }, selector);
  try {
    application = await electron.launch({ args: [root, '--autoplay-policy=no-user-gesture-required'], cwd: root, env, timeout: 30000 });
    page = await application.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.waitForFunction(() => typeof prismDiagnostics === 'function' && prismDiagnostics().stats.frames > 1);
    const recovery = page.getByRole('dialog').filter({ hasText: 'Recover your last session?' });
    if (await recovery.count()) await recovery.getByRole('button', { name: 'Cancel', exact: true }).click();

    let media;
    await t.test('import registers the original movie without a playback transcode', async () => {
      const started = Date.now();
      [media] = await page.evaluate(file => desktop.importPaths([file]), movie);
      const elapsed = Date.now() - started;
      assert.equal(media.error, undefined, media.error);
      assert.equal(media.kind, 'video');
      assert.equal(media.hasAlpha, true);
      assert.match(media.url, /^prism-media:\/\/media\/[^?]+\/Gradient%20Alpha\.mov\?gpu=hap&rev=\d+-\d+$/);
      assert.ok(elapsed < 5000, `import took ${elapsed} ms`);
      const transcodes = existsSync(cache) ? (await readdir(cache)).filter(name => /\.(webm|mp4)$/.test(name)) : [];
      assert.deepEqual(transcodes, []);
      const [again] = await page.evaluate(file => desktop.importPaths([file]), movie);
      assert.equal(again.url, media.url);
      t.diagnostic(`HAP import: ${elapsed} ms`);
      // DXV's alpha depends on its texture format, which the renderer reads.
      const [resolume] = await page.evaluate(file => desktop.importPaths([file]), dxv);
      assert.equal(resolume.error, undefined, resolume.error);
      assert.match(resolume.url, /\?gpu=dxv&rev=/);
      assert.equal('hasAlpha' in resolume, false);
      const after = existsSync(cache) ? (await readdir(cache)).filter(name => /\.(webm|mp4)$/.test(name)) : [];
      assert.deepEqual(after, []);
    });

    await t.test('the protocol serves original bytes, a thumbnail and both soundtrack directions', async () => {
      const served = await page.evaluate(async url => {
        const read = async (suffix, headers) => {
          const response = await fetch(url + suffix, { headers });
          return { status: response.status, type: response.headers.get('content-type'), bytes: [...new Uint8Array(await response.arrayBuffer())] };
        };
        const range = await read('', { Range: 'bytes=4-11' }), thumbnail = await read('&thumbnail=1');
        const forward = await read('&audio=1'), backward = await read('&audio=1&reverse=1');
        return { range, thumbnail: { status: thumbnail.status, magic: thumbnail.bytes.slice(0, 2) },
          forward: { status: forward.status, magic: String.fromCharCode(...forward.bytes.slice(0, 4)), size: forward.bytes.length },
          backward: { status: backward.status, magic: String.fromCharCode(...backward.bytes.slice(0, 4)), size: backward.bytes.length } };
      }, media.url);
      assert.equal(served.range.status, 206);
      assert.equal(served.range.type, 'video/quicktime');
      assert.deepEqual(served.range.bytes, [...(await readFile(movie)).subarray(4, 12)]);
      assert.deepEqual(served.thumbnail, { status: 200, magic: [0xff, 0xd8] });
      assert.equal(served.forward.status, 200); assert.equal(served.forward.magic, 'fLaC');
      assert.equal(served.backward.status, 200); assert.equal(served.backward.magic, 'fLaC');
      assert.ok(served.forward.size > 1000 && served.backward.size > 1000);
    });

    let clip, composition;
    await t.test('composition shows FFmpeg-matching pixels with alpha over the layer below', async () => {
      // Slow playback keeps reverse steps unambiguous at a hidden window's ~1 Hz rendering.
      let project;
      ({ project, clip } = pausedComposition(media, 'HAP composition', { speed: 0.25 }));
      composition = project;
      const background = createClip('source', { name: 'Green', source: 'solid', color: '#00ff00' });
      project.layers = [createLayer('Green'), createLayer('HAP')];
      for (const [index, item] of [background, clip].entries()) {
        project.layers[index].clips[project.selectedDeckId] = [item, null]; project.layers[index].activeClipId = item.id;
      }
      await openProject(project, 'composition');
      // 0.5 s lies inside frame 7 (7/15 s to 8/15 s).
      await page.waitForFunction(id => prismDiagnostics().voices.some(voice => voice.clipId === id && Math.abs(voice.mediaTime - 7 / 15) < 1e-6), clip.id, { timeout: 20000 });
      await page.waitForTimeout(100);
      const output = await canvasPixels('#output-canvas');
      assert.deepEqual([output.width, output.height], [WIDTH, HEIGHT]);
      const pixels = Buffer.from(output.pixels, 'base64'), expected = reference[7];
      let total = 0, worst = 0;
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
        const actual = ((HEIGHT - 1 - y) * WIDTH + x) * 4, source = (y * WIDTH + x) * 4, alpha = expected[source + 3] / 255;
        for (let channel = 0; channel < 3; channel++) {
          const want = expected[source + channel] * alpha + (channel === 1 ? 255 : 0) * (1 - alpha);
          const difference = Math.abs(pixels[actual + channel] - want);
          total += difference; worst = Math.max(worst, difference);
        }
      }
      const mean = total / (WIDTH * HEIGHT * 3);
      t.diagnostic(`composition vs FFmpeg: mean ${mean.toFixed(3)}, worst ${worst}`);
      assert.ok(mean < 1 && worst <= 8, `mean ${mean}, worst ${worst}`);
      const stats = await page.evaluate(() => prismDiagnostics().stats);
      assert.equal(stats.gpuVideo.clips, 1);
      assert.ok(stats.gpuVideo.workers > 0, 'Frames decode in workers.');
    });

    await t.test('DXV plays from the original file with FFmpeg-matching pixels', async () => {
      const [item] = await page.evaluate(file => desktop.importPaths([file]), dxv);
      const { project, clip: dxvClip } = pausedComposition(item, 'DXV composition');
      project.layers = [createLayer('DXV')];
      project.layers[0].clips[project.selectedDeckId] = [dxvClip, null]; project.layers[0].activeClipId = dxvClip.id;
      await openProject(project, 'dxv');
      await page.waitForFunction(id => prismDiagnostics().voices.some(voice => voice.clipId === id && Math.abs(voice.mediaTime - 7 / 15) < 1e-6), dxvClip.id, { timeout: 20000 });
      await page.waitForTimeout(100);
      const output = await canvasPixels('#output-canvas'), pixels = Buffer.from(output.pixels, 'base64');
      const expected = (await referenceFrames(ffmpeg, dxv, WIDTH, HEIGHT))[7];
      let total = 0, worst = 0;
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) for (let channel = 0; channel < 3; channel++) {
        const difference = Math.abs(pixels[((HEIGHT - 1 - y) * WIDTH + x) * 4 + channel] - expected[(y * WIDTH + x) * 4 + channel]);
        total += difference; worst = Math.max(worst, difference);
      }
      const mean = total / (WIDTH * HEIGHT * 3);
      t.diagnostic(`DXV composition vs FFmpeg: mean ${mean.toFixed(3)}, worst ${worst}`);
      assert.ok(mean < 1 && worst <= 8, `mean ${mean}, worst ${worst}`);
      const restored = await page.evaluate(id => prismDiagnostics().project.layers[0].clips[prismDiagnostics().project.selectedDeckId][0], dxvClip.id);
      assert.equal(restored.hasAlpha, false);
    });

    await t.test('preview, output window and reverse playback use the same GPU frames', async () => {
      // Back to the transparent HAP composition.
      await openProject(composition, 'composition-again');
      await page.waitForFunction(id => prismDiagnostics().voices.some(voice => voice.clipId === id), clip.id, { timeout: 20000 });
      await page.locator(`.clip-slot[data-clip="${clip.id}"] .clip-name`).click();
      await page.waitForFunction(() => document.querySelector('#preview-canvas'));
      await page.locator('[data-inspector-panel="clip"] [data-direction="-1"]').click();
      const times = [], previews = new Set();
      for (let attempt = 0; attempt < 80 && (times.length < 7 || previews.size < 3); attempt++) {
        const sample = await page.evaluate(id => {
          const voice = prismDiagnostics().voices.find(voice => voice.clipId === id), canvas = document.querySelector('#preview-canvas');
          const gl = canvas.getContext('webgl2'), rgba = new Uint8Array(4), values = [];
          for (let i = 1; i < 8; i++) { gl.readPixels(Math.floor(canvas.width * i / 8), Math.floor(canvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba); values.push(...rgba); }
          return { time: voice?.mediaTime, preview: values.join(','), dark: values.every(value => value < 8 || value === 255) };
        }, clip.id);
        if (sample.time !== times.at(-1)) times.push(sample.time);
        previews.add(sample.preview);
        await page.waitForTimeout(200);
      }
      const steps = times.slice(1).map((time, i) => time - times[i]);
      assert.ok(steps.filter(step => step < 0).length >= 4 && steps.filter(step => step > 0).length <= 2, `reverse media times ${times.join(', ')}`);
      assert.ok(previews.size >= 3, `preview must animate (${previews.size} distinct samples)`);
      await page.locator('#output').click();
      await page.getByRole('button', { name: 'Open output', exact: true }).click();
      await page.waitForFunction(() => prismDiagnostics().outputs.length === 1);
      const probe = await page.evaluate(() => prismOutputProbe());
      assert.ok(probe.outputs[0].every((value, i) => Math.abs(value - probe.composition[i]) <= 6), `output ${probe.outputs[0]} vs composition ${probe.composition}`);
      assert.ok(probe.composition[0] + probe.composition[2] > 0, 'The output centre shows the movie, not only the green layer.');
      await page.locator('#output').click();
      await page.waitForFunction(() => prismDiagnostics().outputs.length === 0);
    });

    await t.test('1080p Hap Q decodes within a frame interval', async () => {
      const [item] = await page.evaluate(file => desktop.importPaths([file]), large);
      assert.match(item.url, /\?gpu=hap/);
      const project = createProject();
      project.name = 'HAP 1080p'; project.width = 1920; project.height = 1080;
      project.decks = [project.decks[0]]; project.columns = 2;
      const playing = createClip('video', { ...item, duration: 2, videoDuration: 2 });
      project.layers = [createLayer('HAP')];
      project.layers[0].clips[project.selectedDeckId] = [playing, null]; project.layers[0].activeClipId = playing.id;
      await openProject(project, 'full-hd');
      await page.waitForFunction(() => prismDiagnostics().stats.gpuVideo?.clips === 1 && prismDiagnostics().stats.gpuVideo.decodeMs > 0, null, { timeout: 20000 });
      await page.waitForTimeout(3000);
      const { gpuVideo, renderer } = await page.evaluate(() => prismDiagnostics().stats);
      const report = `1080p Hap Q per frame: fetch ${gpuVideo.fetchMs.toFixed(2)} ms, Snappy+parse ${gpuVideo.decodeMs.toFixed(2)} ms (worker), upload+convert ${gpuVideo.uploadMs.toFixed(2)} ms (main thread), ${gpuVideo.workers} workers, ${renderer}`;
      t.diagnostic(report);
      console.log(report);
      assert.ok(gpuVideo.decodeMs < 33, report);
      assert.ok(gpuVideo.uploadMs < 16, report);
    });
    assert.deepEqual(pageErrors, []);
    assert.equal(await page.locator('.toast.error').count(), 0, await page.locator('.toast.error').allTextContents().then(texts => texts.join('\n')));
  } finally {
    await application?.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
});