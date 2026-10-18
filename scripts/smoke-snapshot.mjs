import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'release', 'reverse-smooth-dxv', 'PrismLive-win32-x64', 'PrismLive.exe');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-snapshot-smoke-'));
const profile = path.join(temporary, 'profile');
let application;

try {
  assert.ok((await stat(executable)).size > 0);
  await mkdir(profile);
  const env = { ...process.env, PRISM_HEADLESS: '1', PRISM_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PRISM_DEV_URL;
  application = await electron.launch({ executablePath: executable,
    args: ['--autoplay-policy=no-user-gesture-required'], cwd: temporary, env, timeout: 30000 });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof prismDiagnostics === 'function' && prismDiagnostics().stats.frames >= 3);
  const native = await application.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged, userData: app.getPath('userData'),
    hidden: BrowserWindow.getAllWindows().every(window => !window.isVisible()),
  }));
  assert.equal(native.packaged, true);
  assert.equal(native.userData, profile);
  assert.equal(native.hidden, true);

  const initial = await page.evaluate(() => prismDiagnostics().project);
  const bottomId = initial.layers[0].id, deckId = initial.selectedDeckId;
  const recordings = path.join(profile, 'Recordings');
  const saved = [];
  for (const [kind, slot] of [['clip', 4], ['output', 5]]) {
    await page.locator(`#snapshot-${kind}`).click();
    await page.waitForFunction(({ bottomId, deckId, slot }) => {
      const layer = prismDiagnostics().project.layers.find(item => item.id === bottomId);
      return layer?.clips[deckId]?.[slot]?.kind === 'image';
    }, { bottomId, deckId, slot }, { timeout: 20000 });
    const item = await page.evaluate(({ bottomId, deckId, slot }) => {
      const layer = prismDiagnostics().project.layers.find(entry => entry.id === bottomId);
      return layer.clips[deckId][slot];
    }, { bottomId, deckId, slot });
    assert.ok(path.relative(recordings, item.path) && !path.relative(recordings, item.path).startsWith('..'));
    const bytes = await readFile(item.path);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), initial.width);
    assert.equal(bytes.readUInt32BE(20), initial.height);
    saved.push({ kind, slot, file: path.basename(item.path), bytes: bytes.length });
  }
  await assert.rejects(page.evaluate(() => desktop.saveSnapshot('output', 'invalid', new Uint8Array([1, 2, 3]).buffer)));
  assert.equal((await readdir(recordings)).length, 2);
  assert.deepEqual(errors, []);
  assert.ok(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())));
  console.log('SNAPSHOT_SMOKE_PASS', JSON.stringify({ executable, saved, allWindowsHidden: true }));
} catch (error) {
  console.error('SNAPSHOT_SMOKE_FAIL', error.stack || error.message);
  process.exitCode = 1;
} finally {
  await application?.close();
  const resolved = path.resolve(temporary);
  assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('prism-snapshot-smoke-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
