import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = process.argv[2] && path.resolve(process.argv[2]);
const gif = process.argv[3] && path.resolve(process.argv[3]);
assert.ok(executable && gif, 'Usage: node scripts/smoke-gif.mjs <packaged exe> <animated gif>');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-gif-smoke-'));
const profile = path.join(temporary, 'profile');
await mkdir(profile);
let application;
try {
  const env = { ...process.env, PRISM_HEADLESS: '1', PRISM_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PRISM_DEV_URL;
  application = await electron.launch({ executablePath: executable, cwd: temporary, env,
    args: ['--autoplay-policy=no-user-gesture-required'], timeout: 30000 });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof prismDiagnostics === 'function' && prismDiagnostics().stats.frames > 1);
  await page.locator('#clear-all').click();
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, gif);
  await page.locator('[data-browser="files"]').click();
  await page.locator('#import-media').click();
  const slot = page.locator('.clip-slot').filter({ hasText: path.basename(gif) });
  await slot.waitFor({ state: 'visible' });
  await slot.click();
  await page.waitForFunction(name => prismDiagnostics().frames.some(frame =>
    prismDiagnostics().project.layers.some(layer => Object.values(layer.clips).flat().some(clip =>
      clip?.id === frame.clipId && clip.name === name))), path.basename(gif));

  // Read actual compositor pixels: a moving playhead alone does not establish
  // that GIF frames are being uploaded to the GPU or appearing in the output.
  const sample = () => page.evaluate(() => {
    const canvas = document.querySelector('#output-canvas');
    const gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(4);
    const colors = [];
    for (let y = 1; y <= 7; y++) for (let x = 1; x <= 11; x++) {
      gl.readPixels(Math.floor(canvas.width*x/12), Math.floor(canvas.height*y/8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      colors.push(...pixels.subarray(0, 3));
    }
    return { signature: colors.join(','), position: prismDiagnostics().frames[0]?.position,
      playing: prismDiagnostics().frames.length };
  });
  const samples = [];
  for (let index = 0; index < 20; index++) {
    samples.push(await sample());
    if (new Set(samples.map(value => value.signature)).size >= 3) break;
    await page.waitForTimeout(400);
  }
  assert.ok(samples.every(value => value.playing === 1), 'The GIF must be the only active composition clip.');
  const uniqueFrames = new Set(samples.map(value => value.signature)).size;
  assert.ok(uniqueFrames >= 3, `Expected animated composition pixels; found ${uniqueFrames} distinct frames.`);
  assert.ok(new Set(samples.map(value => value.position)).size >= 3);
  await page.locator('#pause').click();
  await page.waitForTimeout(400);
  const paused = await sample();
  await page.waitForTimeout(500);
  const pausedLater = await sample();
  assert.equal(pausedLater.position, paused.position, 'Global pause must stop the GIF timeline.');
  assert.equal(pausedLater.signature, paused.signature, 'Global pause must hold the displayed GIF frame.');
  await page.locator('#pause').click();
  await page.waitForFunction(position => prismDiagnostics().frames[0]?.position !== position, paused.position);
  assert.deepEqual(errors, []);
  const native = await application.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged, profile: app.getPath('userData'),
    allHidden: BrowserWindow.getAllWindows().every(window => !window.isVisible()),
  }));
  assert.equal(native.packaged, true);
  assert.equal(native.profile, profile);
  assert.equal(native.allHidden, true);
  await page.screenshot({ path: path.join(root, 'test-results', 'gif-composition.png') });
  console.log('PACKAGED_GIF_PASS', JSON.stringify({ uniqueFrames, pauseHoldsFrame: true, resumeAdvances: true, allWindowsHidden: true }));
} finally {
  await application?.close();
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('prism-gif-smoke-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
