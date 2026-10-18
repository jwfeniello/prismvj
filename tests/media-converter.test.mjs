import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, stat, utimes, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import converterModule from '../electron/media-converter.cjs';

const { createMediaConverter, discoverExecutable, sourceHasAlpha } = converterModule;
const execute = promisify(execFile);
const hash = buffer => createHash('sha256').update(buffer).digest('hex');

test('MOV alpha metadata includes packed, planar and high bit depth formats', () => {
  for (const pix_fmt of ['rgba', 'bgra', 'argb', 'abgr', 'yuva420p', 'yuva444p10le', 'gbrap12le', 'ya16be', 'pal8']) {
    assert.equal(sourceHasAlpha({ pix_fmt }), true, pix_fmt);
  }
  for (const pix_fmt of ['yuv420p', 'yuv444p10le', 'rgb24', 'gbrp12le']) assert.equal(sourceHasAlpha({ pix_fmt }), false, pix_fmt);
  assert.equal(sourceHasAlpha({ pix_fmt: 'yuv420p', tags: { alpha_mode: '1' } }), true);
});

test('opaque MOV uses H.264/AAC playback copies in both directions', { timeout: 120000 }, async () => {
  const ffmpeg = await discoverExecutable('ffmpeg');
  const ffprobe = await discoverExecutable('ffprobe');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-opaque-converter-'));
  const source = path.join(temporary, 'opaque-audio.mov');
  const converter = createMediaConverter({ cacheDirectory: path.join(temporary, 'cache') });
  try {
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
      '-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=12:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', '-shortest', source],
    { windowsHide: true, shell: false });
    const prepared = await converter.prepare(source);
    assert.equal(prepared.hasAlpha, false);
    assert.equal(prepared.format, 'mp4');
    for (const copy of [prepared.playbackPath, prepared.reversePath]) {
      assert.ok(copy.endsWith('.mp4'));
      const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', copy],
        { windowsHide: true, shell: false });
      const streams = JSON.parse(stdout).streams;
      assert.equal(streams.find(stream => stream.codec_type === 'video').codec_name, 'h264');
      assert.equal(streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
    }
    assert.deepEqual(await converter.prepare(source), prepared);
  } finally {
    await converter.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('native MOV preparation preserves alpha, audio, originals and reusable cache', { timeout: 120000 }, async t => {
  const ffmpeg = await discoverExecutable('ffmpeg');
  const ffprobe = await discoverExecutable('ffprobe');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-converter-'));
  const source = path.join(temporary, 'Transparent café clip.mov');
  const cacheDirectory = path.join(temporary, 'cache');
  const events = [];
  const converter = createMediaConverter({ cacheDirectory, onProgress: value => events.push(value) });
  let cancelledConverter;
  try {
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
      '-f', 'lavfi', '-i', 'color=c=red@0.5:s=96x64:r=12:d=2,format=argb',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-c:v', 'qtrle', '-c:a', 'pcm_s16le', '-shortest', source], { windowsHide: true, shell: false });
    const sourceHash = hash(await readFile(source));
    let prepared;

    await t.test('concurrent imports reuse one conversion and preserve source alpha/audio', async () => {
      const results = await Promise.all([converter.prepare(source), converter.prepare(source), converter.prepare(source)]);
      prepared = results[0];
      assert.ok(results.every(value => value.playbackPath === prepared.playbackPath && value.hasAlpha));
      assert.equal(events.filter(value => value.phase === 'queued').length, 1);
      assert.equal(events.filter(value => value.phase === 'ready').length, 1);
      assert.ok(events.some(value => value.phase === 'preparing'));
      const { stdout } = await execute(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', prepared.playbackPath], { windowsHide: true, shell: false });
      const streams = JSON.parse(stdout).streams;
      assert.equal(streams.find(stream => stream.codec_type === 'video').codec_name, 'vp9');
      assert.equal(streams.find(stream => stream.codec_type === 'video').tags.alpha_mode, '1');
      assert.equal(streams.find(stream => stream.codec_type === 'audio').codec_name, 'opus');
      const decoded = await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', prepared.playbackPath,
        '-map', '0:v:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true, shell: false, encoding: 'buffer' });
      assert.equal(decoded.stdout.length, 96 * 64 * 4);
      assert.ok(decoded.stdout[3] >= 120 && decoded.stdout[3] <= 135, `alpha=${decoded.stdout[3]}`);
      assert.equal(hash(await readFile(source)), sourceHash, 'Original media bytes must never change.');
    });

    await t.test('persistent cache needs no decoder and changed originals get a new cache key', async () => {
      const before = await stat(prepared.playbackPath);
      const offline = createMediaConverter({ cacheDirectory, env: { PRISM_FFMPEG_PATH: path.join(temporary, 'missing.exe') } });
      assert.deepEqual(await offline.prepare(source), prepared);
      await offline.close();
      assert.equal((await stat(prepared.playbackPath)).mtimeMs, before.mtimeMs);
      const original = await stat(source);
      await utimes(source, original.atime, new Date(original.mtimeMs + 2000));
      const changed = await converter.prepare(source);
      assert.notEqual(changed.playbackPath, prepared.playbackPath);
      assert.equal(hash(await readFile(source)), sourceHash);
    });

    await t.test('failed conversion reports useful errors and leaves no temporary playback files', async () => {
      const broken = path.join(temporary, 'broken.mov');
      await writeFile(broken, 'not a QuickTime movie');
      await assert.rejects(converter.prepare(broken), /Could not prepare broken\.mov/);
      assert.ok(events.some(value => value.phase === 'error' && value.path === broken));
      assert.ok((await readdir(cacheDirectory)).every(name => !name.includes('.part.') && !name.endsWith('.tmp')));
    });

    await t.test('shutdown cancels an active conversion and queued work without publishing partial cache', async () => {
      const cancelledDirectory = path.join(temporary, 'cancel-cache');
      let shutdown;
      let reports = 0;
      cancelledConverter = createMediaConverter({ cacheDirectory: cancelledDirectory, onProgress: value => {
        if (value.phase === 'preparing' && ++reports === 2) shutdown = cancelledConverter.close();
      } });
      const changed = await stat(source);
      const active = cancelledConverter.prepare(source);
      // A distinct source signature queues a second request behind the active one.
      const queued = cancelledConverter.prepare(source, { isFile: () => true, size: changed.size, mtimeMs: changed.mtimeMs + 1 });
      const results = await Promise.allSettled([active, queued]);
      await shutdown;
      assert.equal(reports, 2, 'Cancellation happened after FFmpeg emitted encoding progress.');
      assert.ok(results.every(result => result.status === 'rejected' && /closing/.test(result.reason.message)));
      assert.deepEqual(await readdir(cancelledDirectory), []);
      await assert.rejects(cancelledConverter.prepare(source), /closing/);
    });
  } finally {
    await converter.close();
    await cancelledConverter?.close();
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('prism-converter-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
