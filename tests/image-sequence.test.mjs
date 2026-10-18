import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import converterModule from '../electron/media-converter.cjs';
import sequenceModule from '../electron/image-sequence.cjs';

const { createMediaConverter, discoverExecutable, findImageSequence, imageSequenceFramePath } = converterModule;
const { validateImageSequence } = sequenceModule;
const execute = promisify(execFile);
const ffmpeg = await discoverExecutable('ffmpeg').catch(() => null);
const ffprobe = await discoverExecutable('ffprobe').catch(() => null);
const skip = !(ffmpeg && ffprobe) && 'FFmpeg and ffprobe are not installed';
const run = (executable, args, options = {}) => execute(executable, args, { windowsHide: true, shell: false, maxBuffer: 64 * 1024 * 1024, ...options });
const encode = args => run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
const probe = async file => JSON.parse((await run(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file])).stdout);
const touch = async (directory, names) => { for (const name of names) await writeFile(path.join(directory, name), ''); };
const range = (from, to, name) => Array.from({ length: to - from + 1 }, (_, index) => name(from + index));
const pad = (value, width) => String(value).padStart(width, '0');

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return directory;
}

// Mean luma of each decoded frame, in playback order.
async function frameLuma(file, width, height) {
  const { stdout } = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { encoding: 'buffer' });
  const size = width * height;
  return Array.from({ length: stdout.length / size }, (_, frame) => {
    let sum = 0;
    for (let index = frame * size; index < (frame + 1) * size; index++) sum += stdout[index];
    return sum / size;
  });
}

test('image sequence detection finds the longest numbered run and ignores everything else', async t => {
  const root = await temporaryDirectory(t, 'prism-sequence-detect-');
  const padded = path.join(root, 'padded');
  await mkdir(path.join(padded, 'nested'), { recursive: true });
  await touch(padded, [...range(1, 20, n => `shot.${pad(n, 4)}.png`), ...range(22, 30, n => `shot.${pad(n, 4)}.png`),
    'notes.txt', 'shot.0040.psd', 'other_0005.png', 'Thumbs.db', 'cover.jpg']);
  await touch(path.join(padded, 'nested'), range(1, 50, n => `deep_${pad(n, 4)}.png`));

  const sequence = await findImageSequence(padded);
  assert.deepEqual(sequence, { directory: padded, pattern: 'shot.%04d.png', start: 1, count: 20, extension: 'png',
    firstFile: path.join(padded, 'shot.0001.png') });
  assert.equal(imageSequenceFramePath(sequence, 19), path.join(padded, 'shot.0020.png'));
  // A frame path selects the run it belongs to, even when it is not the first frame.
  assert.deepEqual(await findImageSequence(path.join(padded, 'shot.0005.png')), sequence);
  const tail = await findImageSequence(path.join(padded, 'shot.0025.png'));
  assert.equal(tail.start, 22);
  assert.equal(tail.count, 9);
  assert.equal(await findImageSequence(path.join(padded, 'other_0005.png')), null, 'A lone numbered still is not a sequence.');
  assert.equal(await findImageSequence(path.join(padded, 'notes.txt')), null);

  const unpadded = path.join(root, 'unpadded');
  await mkdir(unpadded);
  await touch(unpadded, [...range(1, 120, n => `img_${n}.PNG`), 'img_0.txt', 'readme.md']);
  assert.deepEqual(await findImageSequence(unpadded), { directory: unpadded, pattern: 'img_%d.PNG', start: 1, count: 120,
    extension: 'png', firstFile: path.join(unpadded, 'img_1.PNG') });

  const mixed = path.join(root, 'mixed % case');
  await mkdir(mixed);
  await touch(mixed, [...range(0, 4, n => `50%_${pad(n, 3)}.TIF`), ...range(5, 9, n => `50%_${pad(n, 3)}.tif`)]);
  const mixedSequence = await findImageSequence(mixed);
  assert.equal(mixedSequence.pattern, '50%%_%03d.TIF', 'Literal percent signs are escaped for FFmpeg.');
  assert.equal(mixedSequence.extension, 'tif');
  assert.equal(mixedSequence.count, process.platform === 'win32' || process.platform === 'darwin' ? 10 : 5);
  assert.equal(imageSequenceFramePath(mixedSequence, 2), path.join(mixed, '50%_002.TIF'));

  const none = path.join(root, 'none');
  await mkdir(none);
  await touch(none, ['a.png', 'b.png', 'clip_3.mov', 'clip_4.mov', 'take_1.png', 'take_3.png']);
  assert.equal(await findImageSequence(none), null);
  await assert.rejects(findImageSequence(padded, { maxEntries: 10 }), /more than 10 entries/);

  assert.throws(() => validateImageSequence({ ...sequence, pattern: '..\\%04d.png' }), /pattern is invalid/);
  assert.throws(() => validateImageSequence({ ...sequence, pattern: 'a%04d%d.png' }), /pattern is invalid/);
  assert.throws(() => validateImageSequence({ ...sequence, pattern: 'shot.%04d.mov' }), /Unsupported/);
  assert.throws(() => validateImageSequence({ ...sequence, directory: 'relative' }), /absolute/);
  assert.throws(() => validateImageSequence({ ...sequence, count: 0 }), /count/);
});

test('image sequences become cached forward and reverse playback clips', { skip, timeout: 180000 }, async t => {
  const root = await temporaryDirectory(t, 'prism-sequence-prepare-');
  const cacheDirectory = path.join(root, 'cache');
  const events = [];
  const converter = createMediaConverter({ cacheDirectory, onProgress: value => events.push(value) });
  t.after(() => converter.close());

  // Opaque, odd-sized, padded with a gap and stray files. Brightness rises
  // with the frame number so playback direction is measurable.
  const opaque = path.join(root, 'opaque');
  await mkdir(opaque);
  await encode(['-f', 'lavfi', '-i', "color=c=black:s=33x25:r=30:d=1,format=gray,geq=lum='N*8',format=rgb24",
    '-start_number', '1', '-c:v', 'png', path.join(opaque, 'shot.%04d.png')]);
  await unlink(path.join(opaque, 'shot.0021.png'));
  await writeFile(path.join(opaque, 'notes.txt'), 'not a frame');
  // Transparent, unpadded, starting at frame 0.
  const alpha = path.join(root, 'alpha');
  await mkdir(alpha);
  await encode(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=32x32:r=15:d=1,format=rgba',
    '-start_number', '0', '-c:v', 'png', path.join(alpha, 'matte_%d.png')]);

  let prepared;
  await t.test('opaque sequence uses H.264 MP4 with the requested frame rate', async () => {
    const sequence = await converter.findImageSequence(opaque);
    assert.equal(sequence.pattern, 'shot.%04d.png');
    assert.equal(sequence.count, 20);
    assert.equal(sequence.width, 33);
    assert.equal(sequence.hasAlpha, false);
    const callEvents = [];
    prepared = await converter.prepareImageSequence(sequence, { fps: 20, onProgress: value => callEvents.push(value) });
    assert.equal(prepared.format, 'mp4');
    assert.equal(prepared.hasAlpha, false);
    assert.deepEqual(prepared.sequence, { directory: opaque, pattern: 'shot.%04d.png', start: 1, count: 20, fps: 20,
      duration: 1, width: 33, height: 25 });
    for (const file of [prepared.playbackPath, prepared.reversePath]) {
      const info = await probe(file);
      const video = info.streams.find(stream => stream.codec_type === 'video');
      assert.equal(video.codec_name, 'h264');
      assert.equal(video.pix_fmt, 'yuv420p');
      assert.equal(Number(video.nb_read_frames), 20);
      assert.equal(`${video.width}x${video.height}`, '32x24', 'Odd stills are trimmed to even 4:2:0 dimensions.');
      assert.ok(Math.abs(Number(info.format.duration) - 1) < .08, `duration=${info.format.duration}`);
      assert.ok(!info.streams.some(stream => stream.codec_type === 'audio'));
    }
    const forward = await frameLuma(prepared.playbackPath, 32, 24);
    const reverse = await frameLuma(prepared.reversePath, 32, 24);
    assert.ok(forward[19] - forward[0] > 100, `forward ${forward[0]} -> ${forward[19]}`);
    assert.ok(reverse[0] - reverse[19] > 100, `reverse ${reverse[0]} -> ${reverse[19]}`);
    assert.ok(Math.abs(reverse[0] - forward[19]) < 6 && Math.abs(reverse[19] - forward[0]) < 6);
    assert.ok(prepared.thumbnailPath.endsWith('.jpg'));
    assert.ok((await stat(prepared.thumbnailPath)).size > 0);
    for (const list of [events, callEvents]) {
      const phases = list.filter(value => value.path === sequence.firstFile).map(value => value.phase);
      assert.equal(phases[0], 'queued');
      assert.ok(phases.includes('preparing'));
      assert.equal(phases.at(-1), 'ready');
      assert.ok(list.every(value => value.kind === 'image-sequence' && value.name === 'opaque'));
    }
  });

  await t.test('second request, folder path and offline converter reuse the cache', async () => {
    const before = events.length;
    assert.deepEqual(await converter.prepareImageSequence(await findImageSequence(opaque), { fps: 20 }), prepared);
    assert.deepEqual(await converter.prepareImageSequence(opaque, { fps: 20 }), prepared);
    assert.equal(events.length, before, 'A cache hit starts no work.');
    const offline = createMediaConverter({ cacheDirectory, env: { PRISM_FFMPEG_PATH: path.join(root, 'missing.exe') } });
    assert.deepEqual(await offline.prepareImageSequence(opaque, { fps: 20 }), prepared);
    await offline.close();
    const concurrent = await Promise.all([converter.prepareImageSequence(opaque, { fps: 10 }), converter.prepareImageSequence(opaque, { fps: 10 })]);
    assert.equal(concurrent[0].playbackPath, concurrent[1].playbackPath);
    assert.notEqual(concurrent[0].playbackPath, prepared.playbackPath, 'Frame rate is part of the cache key.');
    assert.equal(concurrent[0].sequence.duration, 2);
  });

  await t.test('a touched frame produces a new cache entry', async () => {
    const frame = path.join(opaque, 'shot.0007.png');
    const original = await stat(frame);
    await utimes(frame, original.atime, new Date(original.mtimeMs + 5000));
    const changed = await converter.prepareImageSequence(opaque, { fps: 20 });
    assert.notEqual(changed.playbackPath, prepared.playbackPath);
  });

  await t.test('alpha sequence keeps transparency in VP9 WebM', async () => {
    const sequence = await findImageSequence(path.join(alpha, 'matte_0.png'));
    assert.equal(sequence.pattern, 'matte_%d.png');
    assert.equal(sequence.start, 0);
    assert.equal(sequence.count, 15);
    const result = await converter.prepareImageSequence(sequence, { fps: 15 });
    assert.equal(result.format, 'webm');
    assert.equal(result.hasAlpha, true);
    for (const file of [result.playbackPath, result.reversePath]) {
      const info = await probe(file);
      const video = info.streams.find(stream => stream.codec_type === 'video');
      assert.equal(video.codec_name, 'vp9');
      assert.equal(video.tags.alpha_mode, '1');
      assert.ok(Math.abs(Number(info.format.duration) - 1) < .1, `duration=${info.format.duration}`);
      const decoded = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-c:v', 'libvpx-vp9', '-i', file,
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer' });
      assert.equal(decoded.stdout.length, 32 * 32 * 4);
      assert.ok(decoded.stdout[3] >= 120 && decoded.stdout[3] <= 135, `alpha=${decoded.stdout[3]}`);
    }
  });

  await t.test('cancelling stops FFmpeg mid-encode and leaves no partial cache entry', async () => {
    const large = path.join(root, 'large');
    await mkdir(large);
    await encode(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=8,format=rgba', '-start_number', '1', '-c:v', 'png', path.join(large, 'big-%04d.png')]);
    const cancelDirectory = path.join(root, 'cancel-cache');
    const cancelling = createMediaConverter({ cacheDirectory: cancelDirectory });
    const controller = new AbortController();
    const request = cancelling.prepareImageSequence(large, { fps: 30, signal: controller.signal });
    const kept = cancelling.prepareImageSequence(large, { fps: 30, signal: new AbortController().signal });
    let encoding = false;
    for (let attempt = 0; attempt < 2000 && !encoding; attempt++) {
      encoding = (await readdir(cancelDirectory).catch(() => [])).some(name => name.includes('.part.webm'));
      if (!encoding) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(encoding, 'FFmpeg started writing the playback copy.');
    controller.abort();
    await assert.rejects(request, error => error.name === 'AbortError');
    assert.equal(cancelling.stats().processes, 1, 'Another caller still waits, so FFmpeg keeps running.');
    await cancelling.close();
    await assert.rejects(kept, /closing/);
    assert.equal(cancelling.stats().processes, 0);
    const left = await readdir(cancelDirectory).catch(() => []);
    assert.deepEqual(left.filter(name => /\.(part|tmp)|\.(mp4|webm|json)$/.test(name)), []);

    const solo = createMediaConverter({ cacheDirectory: cancelDirectory });
    const soloController = new AbortController();
    const soloRequest = solo.prepareImageSequence(large, { fps: 30, signal: soloController.signal });
    for (let attempt = 0; attempt < 2000 && !solo.stats().processes; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    soloController.abort();
    await assert.rejects(soloRequest, error => error.name === 'AbortError');
    for (let attempt = 0; attempt < 500 && solo.stats().processes; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(solo.stats().processes, 0, 'The last caller aborting kills FFmpeg.');
    await solo.close();
    const early = new AbortController();
    early.abort();
    await assert.rejects(converter.prepareImageSequence(alpha, { signal: early.signal }), error => error.name === 'AbortError');
  });

  await t.test('missing frames and bad input fail with useful errors', async () => {
    const sequence = await findImageSequence(opaque);
    await assert.rejects(converter.prepareImageSequence({ ...sequence, count: 25 }), /shot\.0021\.png .*missing/);
    await assert.rejects(converter.prepareImageSequence(path.join(root, 'cache')), /No numbered image sequence/);
    await assert.rejects(converter.prepareImageSequence(sequence, { fps: 0 }), /frame rate/);
    assert.ok((await readdir(cacheDirectory)).every(name => !name.includes('.part.') && !name.endsWith('.tmp')));
  });
});

test('video thumbnails work for any format and never run more than two FFmpeg jobs at once', { skip, timeout: 180000 }, async t => {
  const root = await temporaryDirectory(t, 'prism-video-thumbnail-');
  const converter = createMediaConverter({ cacheDirectory: path.join(root, 'cache') });
  t.after(() => converter.close());
  const mp4 = path.join(root, 'clip.mp4');
  const webm = path.join(root, 'matte.webm');
  await encode(['-f', 'lavfi', '-i', 'testsrc2=s=96x64:r=12:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
  await encode(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=64x48:r=12:d=2,format=rgba', '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', webm]);

  const opaque = await converter.videoThumbnail(mp4);
  assert.ok(opaque.endsWith('.jpg'));
  const opaqueInfo = (await probe(opaque)).streams[0];
  assert.equal(opaqueInfo.width, 160);
  assert.equal(await converter.videoThumbnail(mp4), opaque, 'Thumbnails are cached.');
  const small = await converter.videoThumbnail(mp4, { width: 64, at: 'start' });
  assert.notEqual(small, opaque);
  assert.equal((await probe(small)).streams[0].width, 64);
  assert.ok((await converter.videoThumbnail(mp4, { at: 30 })).endsWith('.jpg'), 'A time past the end falls back to a real frame.');

  const transparent = await converter.videoThumbnail(webm, { width: 32 });
  assert.ok(transparent.endsWith('.png'), 'Alpha sources get PNG thumbnails.');
  const pixels = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', transparent, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { encoding: 'buffer' });
  assert.equal(pixels.stdout.length, 32 * 24 * 4);
  assert.ok(pixels.stdout[3] >= 120 && pixels.stdout[3] <= 135, `alpha=${pixels.stdout[3]}`);

  const text = path.join(root, 'notes.mp4');
  await writeFile(text, 'not a movie');
  await assert.rejects(converter.videoThumbnail(text), /Could not create a thumbnail for notes\.mp4/);
  await assert.rejects(converter.videoThumbnail('relative.mp4'), /absolute/);
  await assert.rejects(converter.videoThumbnail(mp4, { width: 5 }), /between 16 and 1920/);

  // A burst of imports queues behind the concurrency cap.
  const burst = path.join(root, 'burst');
  await mkdir(burst);
  const copies = [];
  for (let index = 0; index < 12; index++) {
    const copy = path.join(burst, `copy-${index}${index % 2 ? '.mp4' : '.webm'}`);
    await copyFile(index % 2 ? mp4 : webm, copy);
    copies.push(copy);
  }
  const fresh = createMediaConverter({ cacheDirectory: path.join(root, 'burst-cache') });
  t.after(() => fresh.close());
  let maxQueued = 0;
  const sampler = setInterval(() => { maxQueued = Math.max(maxQueued, fresh.stats().thumbnailsQueued); }, 2);
  const results = await Promise.all(copies.map(copy => fresh.videoThumbnail(copy))).finally(() => clearInterval(sampler));
  const stats = fresh.stats();
  assert.equal(new Set(results).size, copies.length);
  for (const result of results) assert.ok((await stat(result)).size > 0);
  assert.equal(stats.thumbnailLimit, 2);
  assert.equal(stats.thumbnailPeak, 2);
  assert.ok(stats.processPeak <= 2, `processPeak=${stats.processPeak}`);
  assert.equal(stats.processes, 0);
  assert.ok(maxQueued > 0, 'Requests beyond the cap waited in the queue.');
});
