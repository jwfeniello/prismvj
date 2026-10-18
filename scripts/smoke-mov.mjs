import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import { createClip, createLayer, createProject } from '../src/model.js';

// Usage: node scripts/smoke-mov.mjs [packaged exe or -] [transparent MOV]
// Every native window and converter process stays hidden. Source media is read
// in place; generated media, proxies, projects and profiles live in one temp dir.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = process.argv[2] && process.argv[2] !== '-' ? path.resolve(process.argv[2]) : null;
const source = process.argv[3] ? path.resolve(process.argv[3]) : 'C:\\Program Files\\Resolume Arena\\media\\Shop74\\BattleWeapon_Tank_09.mov';
const ffmpeg = process.env.PRISM_FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-mov-smoke-'));
const profile = path.join(temporary, 'profile');
const cache = path.join(profile, 'media-cache');
const reports = [];
const pageErrors = [];
let application, page;

async function launch() {
  const env = { ...process.env, PRISM_HEADLESS: '1', PRISM_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PRISM_DEV_URL;
  application = await electron.launch({ ...(executable ? { executablePath: executable } : {}),
    args: [...(executable ? [] : [root]), '--autoplay-policy=no-user-gesture-required'],
    cwd: executable ? temporary : root, env, timeout: 30000 });
  page = await application.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => typeof prismDiagnostics === 'function' && prismDiagnostics().stats.frames > 1);
  const native = await application.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged, profile: app.getPath('userData'),
    hidden: BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFullScreen()),
  }));
  assert.equal(native.profile, profile);
  assert.equal(native.hidden, true);
  if (executable) assert.equal(native.packaged, true);
  // A second launch may offer recovery from this script's own test composition.
  const recovery = page.getByRole('dialog').filter({ hasText: 'Recover your last session?' });
  if (await recovery.count()) await recovery.getByRole('button', { name: 'Cancel', exact: true }).click();
}

async function cacheSnapshot() {
  return Object.fromEntries(await Promise.all((await readdir(cache)).filter(name => name.endsWith('.webm'))
    .sort().map(async name => [name, { size: (await stat(path.join(cache, name))).size, mtime: (await stat(path.join(cache, name))).mtimeMs }])));
}

async function generateAlphaMov(destination, prores = false) {
  // Original RGBA footage: transparent margins, a moving opaque
  // red square, and a fixed 50%-alpha blue rectangle. No licensed assets copied.
  // A nonintegral duration avoids aliasing a 2-frame cycle when Chromium
  // throttles hidden requestAnimationFrame callbacks to roughly 1 Hz.
  const width = 128, height = 72, frames = 47;
  const bytes = Buffer.alloc(width * height * 4 * frames);
  for (let frame = 0; frame < frames; frame++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = ((frame * height + y) * width + x) * 4;
    if (x >= 90 && x < 114 && y >= 16 && y < 58) bytes.set([0, 0, 255, 128], offset);
    if (x >= 16 + frame && x < 42 + frame && y >= 20 && y < 52) bytes.set([255, 0, 0, 255], offset);
  }
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgba',
      '-video_size', `${width}x${height}`, '-framerate', '15', '-i', 'pipe:0', '-an',
      ...(prores ? ['-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le'] : ['-c:v', 'qtrle', '-pix_fmt', 'argb']), '-y', destination],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Creating MOV fixture failed (${code}): ${error}`)));
    child.stdin.on('error', reject);
    child.stdin.end(bytes);
  });
}

async function decodeVideo(url) {
  return page.evaluate(async url => {
    const video = document.createElement('video');
    video.muted = true; video.crossOrigin = 'anonymous'; video.preload = 'auto';
    const event = name => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MOV ${name} timed out`)), 15000);
      video.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
      video.addEventListener('error', () => { clearTimeout(timer); reject(new Error(video.error?.message || 'MOV video decode error')); }, { once: true });
    });
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    try {
      const loaded = event('loadeddata'); video.src = url; await loaded;
      const signatures = [];
      let held;
      for (const target of [0.1, 0.5, Math.min(1, video.duration * 0.8)]) {
        const sought = event('seeked'); video.currentTime = target; await sought;
        context.clearRect(0, 0, 160, 90); context.drawImage(video, 0, 0, 160, 90);
        const pixels = context.getImageData(0, 0, 160, 90).data;
        const samples = [];
        for (let y = 3; y < 90; y += 6) for (let x = 3; x < 160; x += 6) samples.push(...pixels.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 4));
        signatures.push(samples.join(','));
        if (target !== 0.5) continue;
        const counts = { transparent: 0, opaque: 0, partial: 0 };
        const points = { transparent: [], opaque: [], partial: [] };
        const category = alpha => alpha <= 2 ? 'transparent' : alpha >= 253 ? 'opaque' : 'partial';
        for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) counts[category(pixels[(y * 160 + x) * 4 + 3])]++;
        // Sample inside smooth regions to avoid subpixel scaling boundaries.
        for (let y = 3; y < 87; y += 3) for (let x = 3; x < 157; x += 3) {
          const offset = (y * 160 + x) * 4, rgba = [...pixels.subarray(offset, offset + 4)], kind = category(rgba[3]);
          if (points[kind].length >= 8 || (kind === 'opaque' && rgba[0] + rgba[1] + rgba[2] < 60)) continue;
          if ([-2, 0, 2].every(dy => [-2, 0, 2].every(dx => category(pixels[((y + dy) * 160 + x + dx) * 4 + 3]) === kind))) points[kind].push({ x, y, rgba });
        }
        held = { counts, points };
      }
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration,
        uniqueFrames: new Set(signatures).size, ...held };
    } finally { video.removeAttribute('src'); video.load(); }
  }, url);
}

function composition(media, duration) {
  const project = createProject();
  project.name = `Transparent MOV ${media.name}`; project.width = 160; project.height = 90;
  project.decks = [project.decks[0]]; project.columns = 2;
  const background = createClip('source', { name: 'Green transparency reference', source: 'solid', color: '#00ff00' });
  const foreground = createClip('video', { ...media, duration, videoDuration: duration, direction: 0, inPoint: 0.5 / duration, useAudio: false });
  project.layers = [createLayer('Green background'), createLayer('MOV foreground')];
  for (const [index, clip] of [background, foreground].entries()) {
    project.layers[index].clips[project.selectedDeckId] = [clip, null]; project.layers[index].activeClipId = clip.id;
  }
  return { project, foreground };
}

async function openFixture(project, destination) {
  await writeFile(destination, JSON.stringify(project));
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, destination);
  await page.locator('#open-project').click();
  await page.waitForFunction(name => prismDiagnostics().project.name === name, project.name);
}

async function outputPixels(points) {
  return page.evaluate(points => {
    const canvas = document.querySelector('#output-canvas'), gl = canvas.getContext('webgl2');
    return points.map(({ x, y }) => {
      const rgba = new Uint8Array(4); gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba); return [...rgba];
    });
  }, points);
}

async function exercise(file) {
  const original = await stat(file), started = Date.now();
  const [media] = await page.evaluate(file => desktop.importPaths([file]), file);
  assert.equal(media.error, undefined, media.error);
  assert.equal(media.kind, 'video'); assert.equal(media.path, file); assert.equal(media.name, path.basename(file));
  assert.equal(media.hasAlpha, true, 'Alpha capability must reach the clip before playback.');
  const preparedMs = Date.now() - started;
  const snapshot = await cacheSnapshot();
  const [again] = await page.evaluate(file => desktop.importPaths([file]), file);
  assert.equal(again.url, media.url, 'Repeated import reuses the protocol token.');
  assert.deepEqual(await cacheSnapshot(), snapshot, 'Repeated import must reuse the finished proxy without rewriting it.');
  const protocol = await page.evaluate(async url => {
    const head = await fetch(url, { method: 'HEAD' });
    const response = await fetch(url, { headers: { Range: 'bytes=0-31' } });
    return { headStatus: head.status, headType: head.headers.get('content-type'), headLength: Number(head.headers.get('content-length')),
      rangeStatus: response.status, rangeType: response.headers.get('content-type'), range: response.headers.get('content-range'),
      bytes: [...new Uint8Array(await response.arrayBuffer())] };
  }, media.url);
  assert.equal(protocol.headStatus, 200); assert.match(protocol.headType, /^video\/webm/);
  assert.equal(protocol.rangeStatus, 206); assert.match(protocol.rangeType, /^video\/webm/);
  assert.equal(protocol.range, `bytes 0-31/${protocol.headLength}`);
  assert.equal(protocol.bytes.length, 32); assert.deepEqual(protocol.bytes.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3], 'The native URL must serve WebM bytes, not the original MOV.');
  const decoded = await decodeVideo(media.url);
  assert.ok(decoded.width > 0 && decoded.height > 0 && decoded.duration > 1);
  assert.ok(decoded.counts.transparent > 10 && decoded.counts.opaque > 10, JSON.stringify(decoded.counts));
  assert.ok(decoded.points.transparent.length && decoded.points.opaque.length);
  assert.ok(decoded.uniqueFrames >= 2, 'MOV decoding and seeking must produce different visible frames.');

  const { project, foreground } = composition(media, decoded.duration);
  const destination = path.join(temporary, `${reports.length}-composition.prism`);
  await openFixture(project, destination);
  await page.waitForFunction(id => prismDiagnostics().voices.some(voice => voice.clipId === id && Math.abs(voice.mediaTime - 0.5) < 0.05), foreground.id);
  const synthetic = path.dirname(file) === temporary;
  if (synthetic) assert.ok(decoded.counts.partial > 10, 'The source fixture has a semitransparent blue rectangle.');
  const points = [...decoded.points.transparent, ...decoded.points.opaque, ...(synthetic ? decoded.points.partial : [])];
  const expected = points.map(point => point.rgba.slice(0, 3).map((channel, index) => channel * point.rgba[3] / 255 + (index === 1 ? 255 - point.rgba[3] : 0)));
  try {
    // Canvas 2D minification averages more neighboring texels than WebGL's
    // bilinear texture sampling. Dense real footage therefore has different RGB
    // samples at 1/8 resolution; controlled solid fixture regions compare exactly.
    await expect.poll(async () => (await outputPixels(points)).every((rgba, index) => synthetic || points[index].rgba[3] <= 2
      ? rgba.slice(0, 3).every((channel, component) => Math.abs(channel - expected[index][component]) <= 20)
      : rgba[1] - Math.max(rgba[0], rgba[2]) < 30),
      { timeout: 15000, message: 'Transparent MOV pixels must reveal the green layer; opaque pixels must retain the footage.' }).toBe(true);
  } catch (error) {
    console.error('MOV_PIXEL_DIAGNOSTIC', JSON.stringify({ name: media.name, counts: decoded.counts, points, expected, actual: await outputPixels(points),
      playback: await page.evaluate(() => ({ frames: prismDiagnostics().frames, voices: prismDiagnostics().voices })) }));
    throw error;
  }

  const slot = page.locator(`.clip-slot[data-clip="${foreground.id}"]`);
  await slot.locator('.clip-name').click();
  const alpha = page.locator('[data-inspector-panel="clip"] [data-channel="alpha"]');
  await expect(alpha).toBeEnabled(); await expect(alpha).toBeChecked();
  await alpha.uncheck();
  await expect.poll(async () => (await outputPixels(decoded.points.transparent)).some(rgba => rgba[1] < 200),
    { timeout: 10000, message: 'Disabling the MOV alpha channel must stop revealing the green background.' }).toBe(true);
  await alpha.check();
  await page.locator('[data-inspector-panel="clip"] [data-direction="1"]').click();
  const signatures = { output: new Set(), preview: new Set() };
  for (let attempt = 0; attempt < 25; attempt++) {
    const sample = await page.evaluate(() => ['output', 'preview'].map(name => {
      const canvas = document.querySelector(`#${name}-canvas`); if (!canvas) return '';
      const gl = canvas.getContext('webgl2'), rgba = new Uint8Array(4), values = [];
      for (let y = 1; y < 9; y++) for (let x = 1; x < 17; x++) {
        gl.readPixels(Math.floor(canvas.width * x / 17), Math.floor(canvas.height * y / 9), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba); values.push(...rgba.slice(0, 3));
      }
      return values.join(',');
    }));
    signatures.output.add(sample[0]); signatures.preview.add(sample[1]);
    if (signatures.output.size >= 3 && signatures.preview.size >= 3) break;
    await page.waitForTimeout(400);
  }
  assert.ok(signatures.output.size >= 3, `Composition GPU pixels must animate (${signatures.output.size} distinct samples).`);
  assert.ok(signatures.preview.size >= 3, `Independent preview GPU pixels must animate (${signatures.preview.size} distinct samples).`);
  await page.locator('#snapshot-clip').click();
  await page.waitForFunction(deckId => prismDiagnostics().project.layers[0].clips[deckId][1]?.kind === 'image', project.selectedDeckId,
    { timeout: 20000 });
  const snapshotPath = await page.evaluate(deckId => prismDiagnostics().project.layers[0].clips[deckId][1].path, project.selectedDeckId);
  assert.ok(path.relative(path.join(profile, 'Recordings'), snapshotPath) &&
    !path.relative(path.join(profile, 'Recordings'), snapshotPath).startsWith('..'), 'Clip snapshot must save inside the test profile.');
  const snapshotPNG = await readFile(snapshotPath);
  assert.equal(snapshotPNG.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const snapshotAlpha = await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = { transparent: 0, opaque: 0, partial: 0, bluePartial: 0 };
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3];
      if (alpha <= 2) counts.transparent++;
      else if (alpha >= 253) counts.opaque++;
      else {
        counts.partial++;
        if (pixels[offset + 2] > 180 && pixels[offset + 2] > pixels[offset] + 100) counts.bluePartial++;
      }
    }
    return { width: bitmap.width, height: bitmap.height, counts };
  }, [...snapshotPNG]);
  assert.equal(snapshotAlpha.width, project.width); assert.equal(snapshotAlpha.height, project.height);
  assert.ok(snapshotAlpha.counts.transparent > 10 && snapshotAlpha.counts.opaque > 10,
    `Transparent MOV clip snapshot must retain both transparent and opaque regions: ${JSON.stringify(snapshotAlpha)}`);
  if (synthetic) assert.ok(snapshotAlpha.counts.bluePartial > 10,
    `Transparent MOV clip snapshot must retain the blue partial-alpha rectangle: ${JSON.stringify(snapshotAlpha)}`);
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
  await page.locator('#save-project').click();
  try { await expect(page.locator('#save-state')).toHaveText('SAVED'); }
  catch (error) {
    console.error('MOV_SAVE_DIAGNOSTIC', await page.evaluate(() => ({ saveState: document.querySelector('#save-state')?.textContent,
      status: document.querySelector('#status-text')?.textContent, toast: document.querySelector('.toast')?.textContent })));
    throw error;
  }
  const saved = JSON.parse(await readFile(destination, 'utf8'));
  const savedClip = saved.layers[1].clips[saved.selectedDeckId][0];
  assert.equal(savedClip.path, file); assert.equal(savedClip.url, '');
  await page.locator('#open-project').click();
  await expect(page.locator('#save-state')).toHaveText('LOADED');
  const restored = await page.evaluate(id => prismDiagnostics().project.layers.flatMap(layer => Object.values(layer.clips).flat()).find(clip => clip?.id === id), foreground.id);
  assert.equal(restored.path, file); assert.equal(restored.hasAlpha, true);
  // Diagnostics intentionally serialize away ephemeral URLs. The native open
  // response exposes the fresh registration before the UI serializes it again.
  const reopened = await page.evaluate(() => desktop.openProject());
  assert.deepEqual(reopened.missing, []);
  assert.match(reopened.project.layers[1].clips[reopened.project.selectedDeckId][0].url, /^prism-media:/);
  assert.deepEqual(await cacheSnapshot(), snapshot, 'Save/open must keep the original source and reuse its prepared media.');
  const unchanged = await stat(file); assert.equal(unchanged.size, original.size); assert.equal(unchanged.mtimeMs, original.mtimeMs);
  reports.push({ name: media.name, preparedMs, width: decoded.width, height: decoded.height, duration: decoded.duration,
    alphaPixels: decoded.counts, snapshotAlpha: snapshotAlpha.counts, nativeFrames: decoded.uniqueFrames,
    compositionFrames: signatures.output.size, previewFrames: signatures.preview.size });
  console.log('MOV_FIXTURE_PASS', JSON.stringify(reports.at(-1)));
  return destination;
}

try {
  assert.ok(existsSync(source), `Missing test MOV: ${source}`);
  assert.ok(existsSync(ffmpeg), `Missing fixture encoder: ${ffmpeg}`);
  await mkdir(profile);
  const qtrle = path.join(temporary, 'Original alpha animation qtrle.mov');
  const prores = path.join(temporary, 'Original alpha animation ProRes4444.mov');
  await generateAlphaMov(qtrle);
  await generateAlphaMov(prores, true);
  await launch();
  await exercise(source);
  await exercise(qtrle);
  const destination = await exercise(prores);
  const beforeRestart = await cacheSnapshot();
  await application.close(); application = null;
  await launch();
  const [registered] = await page.evaluate(file => desktop.importPaths([file]), source);
  assert.equal(registered.error, undefined, registered.error); assert.equal(registered.hasAlpha, true);
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, destination);
  await page.locator('#open-project').click();
  await expect(page.locator('#save-state')).toHaveText('LOADED');
  assert.deepEqual(await cacheSnapshot(), beforeRestart, 'A new native session must reuse the on-disk proxy cache.');
  assert.deepEqual(pageErrors, []);
  assert.ok(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFullScreen())));
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results', 'mov-composition.png') });
  console.log('MOV_SMOKE_PASS', JSON.stringify({ packaged: !!executable, reports, originalPathsPreserved: true,
    cacheReusedAcrossRestart: true, webmByteRanges: true, allWindowsHidden: true }));
} catch (error) {
  console.error('MOV_SMOKE_FAIL', error.stack || error.message);
  process.exitCode = 1;
} finally {
  await application?.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('prism-mov-smoke-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
