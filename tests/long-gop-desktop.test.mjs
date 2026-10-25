// Long-GOP movies in the desktop app: placing one offers HAP or a reverse
// copy, the copy is made in the background, and reverse playback then reads
// the copy. Preferences can make copies automatically or hide the notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ffmpeg = [process.env.PRISM_FFMPEG_PATH, 'C:/ffmpeg/bin/ffmpeg.exe', 'ffmpeg'].find(candidate => candidate && spawnSync(candidate, ['-version']).status === 0);

test('a long-GOP MP4 gets the notice and reverses from its reverse copy', { skip: !ffmpeg, timeout: 240000 }, async t => {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Run npm run build first.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-long-gop-'));
  const profile = path.join(temporary, 'profile'), media = path.join(temporary, 'media');
  await mkdir(profile, { recursive: true }); await mkdir(media, { recursive: true });
  // 6.4 s at 30 fps with keyframes 128 frames (4.27 s) apart, like the clip
  // that stuttered in reverse; Short.mp4 has a keyframe every half second.
  const encode = (name, gop) => {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=6.4',
      '-f', 'lavfi', '-i', 'sine=duration=6.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      '-c:a', 'aac', '-shortest', path.join(media, name)]);
    assert.equal(result.status, 0, String(result.stderr));
    return path.join(media, name);
  };
  const short = encode('Short.mp4', 15), long = encode('Long.mp4', 128), hap = encode('ToHap.mp4', 128);
  const automatic = encode('Automatic.mp4', 128), quiet = encode('Quiet.mp4', 128);
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PRISM_DEV_URL;
  let application;
  try {
    application = await electron.launch({ args: [root, '--autoplay-policy=no-user-gesture-required'], cwd: root, env, timeout: 30000 });
    const page = await application.firstWindow();
    await page.waitForFunction(() => window.desktop && window.prismDiagnostics);
    const clips = () => page.evaluate(() => prismDiagnostics().project.layers.flatMap(layer => Object.values(layer.clips).flat()).filter(Boolean));
    const clipFor = async file => (await clips()).find(clip => clip.path === file);
    // Drop a file into the first empty slot, as from the Files browser.
    const place = async file => {
      await page.evaluate(file => {
        const slot = document.querySelector('.clip-slot.empty-slot');
        const data = new DataTransfer();
        data.setData('application/prism-path', file);
        slot.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
        slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      }, file);
      await page.waitForFunction(file => prismDiagnostics().project.layers.some(layer => Object.values(layer.clips).flat().some(clip => clip?.path === file)), file, { timeout: 30000 });
    };
    const notice = page.locator('#long-gop-notice');
    const setLongGop = async value => {
      await page.locator('#preferences').click();
      await page.locator('[data-text-preference="longGop"]').selectOption(value);
      await page.getByRole('button', { name: 'Save settings' }).click();
      await page.waitForFunction(value => prismDiagnostics().preferences.longGop === value, value);
    };

    await t.test('import reports the keyframe interval', async () => {
      const [shortItem, longItem] = await page.evaluate(files => desktop.importPaths(files), [short, long]);
      assert.ok(Math.abs(shortItem.keyframeInterval - .5) < .05, `short GOP ${shortItem.keyframeInterval}`);
      assert.ok(Math.abs(longItem.keyframeInterval - 128 / 30) < .05, `long GOP ${longItem.keyframeInterval}`);
      assert.equal(longItem.reverseCopy, false);
    });

    await t.test('only the long-GOP clip shows the notice', async () => {
      await place(short);
      assert.equal(await notice.count(), 0);
      await place(long);
      await notice.waitFor();
      assert.match(await notice.textContent(), /Long\.mp4 has keyframes 4\.3 s apart, so reverse playback and scrubbing can stutter/);
      assert.equal((await clipFor(long)).reverseCopy, false);
    });

    await t.test('Make a reverse copy runs in the background and reverse uses it', async () => {
      await notice.getByRole('button', { name: 'Make a reverse copy' }).click();
      await notice.waitFor({ state: 'detached' });
      await page.waitForFunction(file => prismDiagnostics().project.layers.some(layer => Object.values(layer.clips).flat().some(clip => clip?.path === file && clip.reverseCopy)), long, { timeout: 120000 });
      const clip = await clipFor(long);
      // Importing the file again finds the copy (so there is nothing to
      // offer), and the movie's own URL serves the reversed copy for ?reverse=1.
      const [again] = await page.evaluate(file => desktop.importPaths([file]), long);
      assert.equal(again.reverseCopy, true);
      const served = await page.evaluate(async url => {
        const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}reverse=1`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { ok: response.ok, size: bytes.length, type: String.fromCharCode(...bytes.slice(4, 8)) };
      }, again.url);
      assert.ok(served.ok);
      assert.equal(served.type, 'ftyp');
      assert.notEqual(served.size, (await stat(long)).size, 'reverse serves the copy, not the original');
      // Trigger the clip and play it backwards: the reversed file plays forwards.
      await page.locator(`.clip-slot[data-clip="${clip.id}"]`).click({ position: { x: 6, y: 6 } });
      await page.locator('[data-inspector-panel="clip"] [data-direction="-1"]').click();
      const samples = [];
      for (let attempt = 0; attempt < 60 && samples.length < 6; attempt++) {
        const voice = await page.evaluate(id => prismDiagnostics().voices.find(voice => voice.clipId === id), clip.id);
        if (voice?.mediaURL?.includes('reverse=1') && voice.mediaTime !== samples.at(-1)) samples.push(voice.mediaTime);
        await page.waitForTimeout(150);
      }
      assert.ok(samples.length >= 4, `the reverse copy plays (${samples.join(', ')})`);
      const steps = samples.slice(1).map((time, index) => time - samples[index]);
      assert.ok(steps.filter(step => step > 0).length >= steps.length - 1, `reverse copy times ${samples.join(', ')}`);
    });

    await t.test('Convert to HAP opens the converter set to replace the clip', async () => {
      await place(hap);
      await notice.getByRole('button', { name: 'Convert to HAP' }).click();
      const row = page.locator('.cv-row[data-item]', { hasText: 'ToHap.mp4' });
      await row.waitFor({ timeout: 60000 });
      await page.locator('[data-act="convert"]').click();
      assert.match(await page.locator('.cv-row[data-entry]').first().textContent(), /ToHap \(HAP\)\.mov[\s\S]*replaces clips in composition/);
      await page.keyboard.press('Escape');
      await page.locator('.cv-root').waitFor({ state: 'detached' });
    });

    await t.test('preferences make reverse copies automatically or hide the notice', async () => {
      await setLongGop('reverse');
      await place(automatic);
      assert.equal(await notice.count(), 0);
      await page.waitForFunction(file => prismDiagnostics().project.layers.some(layer => Object.values(layer.clips).flat().some(clip => clip?.path === file && clip.reverseCopy)), automatic, { timeout: 120000 });
      await setLongGop('ignore');
      await place(quiet);
      await page.waitForTimeout(1500);
      assert.equal(await notice.count(), 0);
      assert.equal((await clipFor(quiet)).reverseCopy, false);
    });
  } finally {
    await application?.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
  }
});
