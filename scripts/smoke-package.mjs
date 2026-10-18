import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release', 'prismvj', 'PrismVJ-win32-x64', 'PrismVJ.exe');
const packageFolder = path.dirname(executable);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-package-smoke-'));
const profile = path.join(temporary, 'profile');
let application;

try {
  assert.ok((await stat(executable)).size > 0, 'The packaged executable must exist before running this smoke test.');
  await mkdir(profile);
  const mediaPath = path.join(temporary, 'local media ü.webm');
  await copyFile(path.join(root, 'tests', 'engine-fixture.webm'), mediaPath);
  const env = { ...process.env, PRISM_HEADLESS: '1', PRISM_TEST_DATA: profile };
  delete env.PRISM_DEV_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  // The packaged binary resolves all application code itself, from an unrelated
  // working directory. No workspace app argument or development server is used.
  application = await electron.launch({ executablePath: executable,
    args: ['--autoplay-policy=no-user-gesture-required'], cwd: temporary, env, timeout: 30000 });
  const page = await application.firstWindow();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForFunction(() => typeof window.prismDiagnostics === 'function'
    && window.prismDiagnostics().stats.frames >= 3, null, { timeout: 20000 });

  const splitters = page.locator('[data-layout-splitter]');
  assert.equal(await splitters.count(), 5, 'The packaged workspace must contain every resize divider.');
  const workspaceBefore = await page.locator('.workspace').boundingBox();
  const divider = await page.locator('[data-layout-splitter="workspace"]').boundingBox();
  const point = { x: divider.x + divider.width / 2, y: divider.y + divider.height / 2 };
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x, point.y + 60, { steps: 6 }); await page.mouse.up();
  const workspaceAfter = await page.locator('.workspace').boundingBox();
  assert.ok(workspaceAfter.height > workspaceBefore.height + 50);
  await page.reload();
  await page.waitForFunction(() => typeof prismDiagnostics === 'function' && prismDiagnostics().stats.frames >= 3);
  const workspaceRestored = await page.locator('.workspace').boundingBox();
  assert.ok(Math.abs(workspaceRestored.height - workspaceAfter.height) < 3, 'The packaged layout must persist after reload.');

  const native = await application.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'),
    windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), fullscreen: window.isFullScreen() })),
  }));
  assert.equal(native.packaged, true, 'Smoke must run the packaged application.');
  assert.ok(path.resolve(native.appPath).startsWith(packageFolder + path.sep));
  assert.equal(native.userData, profile);
  assert.ok(native.windows.length > 0 && native.windows.every(window => !window.visible && !window.fullscreen));
  assert.equal(new URL(page.url()).protocol, 'file:');
  const initial = await page.evaluate(() => {
    const diagnostics = window.prismDiagnostics(); const canvas = document.querySelector('#output-canvas');
    return { activeFrames: diagnostics.frames.length, renderedFrames: diagnostics.stats.frames,
      canvasWidth: canvas.width, canvasHeight: canvas.height, renderer: diagnostics.stats.renderer,
      nodeAccessible: typeof window.require !== 'undefined' };
  });
  assert.equal(initial.activeFrames, 3);
  assert.ok(initial.renderedFrames >= 3);
  assert.equal(initial.canvasWidth, 1280);
  assert.equal(initial.canvasHeight, 720);
  assert.equal(initial.nodeAccessible, false);

  // Exercises the packaged native module loader and disk write path as well.
  assert.equal(await page.evaluate(() => desktop.autosave(prismDiagnostics().project)), true);
  const [media] = await page.evaluate(paths => desktop.importPaths(paths), [mediaPath]);
  assert.equal(media.kind, 'video');
  assert.equal(media.path, mediaPath);
  assert.match(media.url, /^prism-media:/);
  const range = await page.evaluate(async url => {
    const response = await fetch(url, { headers: { Range: 'bytes=8-39' } });
    return { status: response.status, contentRange: response.headers.get('content-range'),
      bytes: [...new Uint8Array(await response.arrayBuffer())] };
  }, media.url);
  const original = await readFile(mediaPath);
  assert.equal(range.status, 206);
  assert.equal(range.contentRange, `bytes 8-39/${original.length}`);
  assert.deepEqual(range.bytes, [...original.subarray(8, 40)]);

  const seek = await page.evaluate(async url => {
    const video = document.createElement('video'); video.muted = true; video.crossOrigin = 'anonymous';
    const event = name => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Packaged video ${name} timed out`)), 10000);
      video.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
      video.addEventListener('error', () => { clearTimeout(timer); reject(new Error(video.error?.message || 'Video decode error')); }, { once: true });
    });
    try {
      const loaded = event('loadeddata'); video.src = url; document.body.append(video); await loaded;
      const target = Math.min(1.2, video.duration / 2); const sought = event('seeked'); video.currentTime = target; await sought;
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, target, position: video.currentTime };
    } finally { video.removeAttribute('src'); video.load(); video.remove(); }
  }, media.url);
  assert.ok(seek.width > 0 && seek.height > 0 && seek.duration > 0);
  assert.ok(Math.abs(seek.position - seek.target) < 0.03, JSON.stringify(seek));
  assert.deepEqual(pageErrors, []);
  assert.ok((await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.isVisible()))).every(visible => !visible));
  console.log('PACKAGED_SMOKE_PASS', JSON.stringify({ executable, appPath: native.appPath, initial, media: seek, rangeStatus: range.status,
    isolatedProfile: true, allWindowsHidden: true, developerServerUsed: false, resizableLayoutRestored: true }));
} catch (error) {
  console.error('PACKAGED_SMOKE_FAIL', error.stack || error.message);
  process.exitCode = 1;
} finally {
  await application?.close();
  const resolved = path.resolve(temporary);
  assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('prism-package-smoke-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
