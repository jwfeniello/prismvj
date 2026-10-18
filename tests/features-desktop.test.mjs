// Electron-only checks: the LTC AudioWorklet loads from the packaged file://
// page under its CSP, and a folder of numbered frames imports as one clip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ffmpeg = [process.env.PRISM_FFMPEG_PATH, 'C:/ffmpeg/bin/ffmpeg.exe', 'ffmpeg'].find(candidate => candidate && spawnSync(candidate, ['-version']).status === 0);

test('LTC worklet loads in Electron and folders import as image sequences', { timeout: 180000 }, async () => {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Run npm run build first.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-desktop-features-'));
  const profile = path.join(temporary, 'profile'), frames = path.join(temporary, 'frames');
  await mkdir(profile, { recursive: true }); await mkdir(frames, { recursive: true });
  if (ffmpeg) spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=10:duration=1', path.join(frames, 'shot_%03d.png')]);
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PRISM_DEV_URL;
  let application;
  try {
    application = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    const page = await application.firstWindow();
    await page.waitForFunction(() => window.desktop && window.prismDiagnostics);
    const worklet = await page.evaluate(async () => {
      const context = new AudioContext();
      try { await context.audioWorklet.addModule(new URL('ltc-worklet.js', location.href).href); return 'loaded'; }
      catch (error) { return `${error.name}: ${error.message}`; }
      finally { await context.close(); }
    });
    assert.equal(worklet, 'loaded');
    if (ffmpeg) {
      const [item] = await page.evaluate(folder => window.desktop.importPaths([folder]), frames);
      assert.equal(item.error, undefined, item.error);
      assert.equal(item.kind, 'video');
      assert.equal(item.sequenceFps, 25);
      assert.match(item.path, /shot_001\.png$/);
      const duration = await page.evaluate(async url => {
        const video = document.createElement('video'); video.src = url;
        await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('decode failed')); });
        return video.duration;
      }, item.url);
      assert.ok(Math.abs(duration - 10 / 25) < 0.1, `sequence duration ${duration}`);
    }
  } finally {
    await application?.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
});
