// Converter in the desktop app: a clip in the composition is converted with
// "+ From composition" and the clip switches to the HAP file automatically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ffmpeg = [process.env.PRISM_FFMPEG_PATH, 'C:/ffmpeg/bin/ffmpeg.exe', 'ffmpeg'].find(candidate => candidate && spawnSync(candidate, ['-version']).status === 0);

test('Converter converts a composition clip to HAP and the clip switches over', { skip: !ffmpeg, timeout: 240000 }, async () => {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Run npm run build first.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-converter-'));
  const profile = path.join(temporary, 'profile'), media = path.join(temporary, 'media');
  await mkdir(profile, { recursive: true }); await mkdir(media, { recursive: true });
  const source = path.join(media, 'Loop.mp4');
  spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PRISM_DEV_URL;
  let application;
  try {
    application = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    const page = await application.firstWindow();
    await page.waitForFunction(() => window.desktop && window.prismDiagnostics);
    // Drop the file into the first empty slot, as from the Files browser.
    await page.evaluate(file => {
      const slot = document.querySelector('.clip-slot.empty-slot');
      const data = new DataTransfer();
      data.setData('application/prism-path', file);
      slot.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }, source);
    const clipsUsing = name => page.evaluate(wanted => window.prismDiagnostics().project.layers.flatMap(layer => Object.values(layer.clips).flat()).filter(clip => clip && String(clip.path).endsWith(wanted)).map(clip => ({ path: clip.path, url: clip.url })), name);
    await page.waitForFunction(() => window.prismDiagnostics().project.layers.some(layer => Object.values(layer.clips).flat().some(clip => clip && String(clip.path).endsWith('Loop.mp4'))), null, { timeout: 30000 });
    await page.locator('#converter').click();
    await page.locator('[data-act="composition"]').click();
    const row = page.locator('.cv-row[data-item]', { hasText: 'Loop.mp4' });
    await row.waitFor({ timeout: 60000 });
    assert.match(await row.textContent(), /H\.264[\s\S]*No Alpha[\s\S]*320 x 180 30 FPS[\s\S]*audio/);
    await row.click();
    await page.locator('[data-act="convert"]').click();
    const entry = page.locator('.cv-row[data-entry]').first();
    assert.match(await entry.textContent(), /Loop \(HAP\)\.mov[\s\S]*replaces clips in composition/);
    await page.locator('[data-act="queue"]').click();
    await page.locator('.cv-job.done').waitFor({ timeout: 120000 });
    await page.waitForFunction(() => window.prismDiagnostics().project.layers.some(layer => Object.values(layer.clips).flat().some(clip => clip && String(clip.path).endsWith('Loop (HAP).mov'))), null, { timeout: 30000 });
    const [converted] = await clipsUsing('Loop (HAP).mov');
    assert.equal(converted.path, path.join(media, 'Loop (HAP).mov'));
    const ffprobe = ffmpeg.replace(/ffmpeg(.exe)?$/i, match => match.replace('ffmpeg', 'ffprobe'));
    const tag = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_tag_string', '-of', 'csv=p=0', converted.path]).stdout.toString().trim();
    assert.equal(tag, 'Hap1');
    assert.deepEqual(await clipsUsing('Loop.mp4'), []);
    assert.ok((await readdir(media)).includes('Loop (HAP).mov'));
    // Escape closes the converter.
    await page.keyboard.press('Escape');
    await page.locator('.cv-root').waitFor({ state: 'detached' });
  } finally {
    await application?.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
  }
});