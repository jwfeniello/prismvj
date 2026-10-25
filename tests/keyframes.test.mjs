// Keyframe-interval probe and reverse playback copies for movies that play
// from the original file, with real FFmpeg encodes of small generated clips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMediaConverter, keyframeSpacing } = require('../electron/media-converter.cjs');
const ffmpeg = [process.env.PRISM_FFMPEG_PATH, 'C:/ffmpeg/bin/ffmpeg.exe', 'ffmpeg'].find(candidate => candidate && spawnSync(candidate, ['-version']).status === 0);
const ffprobe = ffmpeg && ffmpeg.replace(/ffmpeg(\.exe)?$/i, match => match.replace('ffmpeg', 'ffprobe'));
const make = args => { const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (result.status !== 0) throw new Error(String(result.stderr)); };
const streams = file => JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file]).stdout.toString());
// Mean luma (or alpha) of every frame, in presentation order.
const levels = (file, filters = 'signalstats', decoder = []) => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...decoder, '-i', file,
  '-vf', `${filters},metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-an', '-f', 'null', '-'], { maxBuffer: 64 * 1024 * 1024 })
  .stdout.toString().split(/\r?\n/).filter(line => line.startsWith('lavfi.signalstats.YAVG=')).map(line => Number(line.split('=')[1]));
// Frame N has luma 2N (mod 256), so order and gaps are visible after encoding.
const ramp = (seconds, rate = 30) => `color=s=64x64:r=${rate}:d=${seconds},geq=lum='mod(N*2\\,256)':cb=128:cr=128`;
const h264 = gop => ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0'];

test('keyframe spacing reads packet flags in decode order', () => {
  // B-frames: packets arrive out of presentation order.
  assert.deepEqual(keyframeSpacing('0.000000,K__\n0.100000,___\n0.033333,___\n4.000000,K__\n4.100000,___\n4.066667,___\n'),
    { interval: 4, keyframes: 2, window: 4.1 });
  // The stretch after the last keyframe counts: reverse seeks into it too.
  assert.deepEqual(keyframeSpacing('0,K_\n1,_\n2,_\n5.5,_\n'), { interval: 5.5, keyframes: 1, window: 5.5 });
  // Frames before the first keyframe cannot be decoded without it.
  assert.equal(keyframeSpacing('0,_\n3,K_\n4,_\n').interval, 3);
  assert.equal(keyframeSpacing('N/A,K_\n\n'), null);
  assert.equal(keyframeSpacing('0,_\n1,_\n'), null);
});

test('the keyframe probe measures clips of different GOP sizes', { skip: !ffmpeg, timeout: 120000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-keyframes-'));
  const converter = createMediaConverter({ cacheDirectory: path.join(temporary, 'cache') });
  try {
    const clips = {
      'intra.mp4': ['-f', 'lavfi', '-i', ramp(3), ...h264(1)],
      'short.mp4': ['-f', 'lavfi', '-i', ramp(4), ...h264(15)],
      'long.mp4': ['-f', 'lavfi', '-i', ramp(10), '-f', 'lavfi', '-i', 'sine=duration=10', ...h264(120), '-c:a', 'aac', '-shortest'],
      'single.mp4': ['-f', 'lavfi', '-i', ramp(6), ...h264(1000)],
      'hevc.mkv': ['-f', 'lavfi', '-i', ramp(5), '-c:v', 'libx265', '-x265-params', 'keyint=75:min-keyint=75:scenecut=0:log-level=error'],
      'vp9.webm': ['-f', 'lavfi', '-i', ramp(5), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-g', '60', '-keyint_min', '60'],
      'window.mp4': ['-f', 'lavfi', '-i', ramp(40, 10), ...h264(10)],
    };
    for (const [name, args] of Object.entries(clips)) make([...args, path.join(temporary, name)]);
    const measure = async name => converter.keyframeInterval(path.join(temporary, name));
    const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < .05, `${label}: ${actual} s, expected ${expected} s`);
    const intra = await measure('intra.mp4');
    close(intra.interval, 1 / 30, 'every frame is a keyframe');
    assert.equal(intra.keyframes, 90);
    close((await measure('short.mp4')).interval, .5, '15-frame GOP at 30 fps');
    const long = await measure('long.mp4');
    close(long.interval, 4, '120-frame GOP at 30 fps');
    assert.equal(long.keyframes, 3);
    close((await measure('single.mp4')).interval, 6 - 1 / 30, 'one keyframe for the whole clip');
    close((await measure('hevc.mkv')).interval, 2.5, 'HEVC in Matroska');
    close((await measure('vp9.webm')).interval, 2, 'VP9 in WebM');
    // Only the start of a long movie is read.
    const windowed = await measure('window.mp4');
    close(windowed.interval, 1, '10-frame GOP at 10 fps');
    assert.ok(windowed.window >= 19 && windowed.window <= 21, `probed ${windowed.window} s of 40 s`);
    // Results are kept for the session, and a file without video has none.
    assert.equal(await measure('long.mp4'), long);
    make(['-f', 'lavfi', '-i', 'sine=duration=1', path.join(temporary, 'tone.m4a')]);
    assert.equal(await measure('tone.m4a'), null);
  } finally {
    await converter.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('long movies get a frame-exact reverse copy made in segments', { skip: !ffmpeg, timeout: 180000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-reverse-copy-'));
  const events = [];
  const converter = createMediaConverter({ cacheDirectory: path.join(temporary, 'cache'), reverseSegmentFrames: 64, onProgress: event => events.push(event) });
  try {
    const source = path.join(temporary, 'long.mp4');
    make(['-f', 'lavfi', '-i', ramp(10), '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', ...h264(120), '-c:a', 'aac', '-shortest', source]);
    assert.equal(await converter.reverseCopy(source, undefined, { create: false }), null);
    const copy = await converter.reverseCopy(source);
    assert.match(path.basename(copy), /\.reverse-copy\.mp4$/);
    const info = streams(copy);
    const video = info.streams.find(stream => stream.codec_type === 'video'), audio = info.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(Number(video.nb_read_frames), 300, 'every frame once');
    assert.equal(audio?.codec_name, 'aac');
    assert.ok(Math.abs(Number(info.format.duration) - 10) < .1, `duration ${info.format.duration}`);
    // Frame 299 first, then every earlier frame in turn across the 5 segments.
    const expected = Array.from({ length: 300 }, (_, index) => (299 - index) * 2 % 256);
    const actual = levels(copy);
    assert.equal(actual.length, 300);
    assert.ok(actual.every((value, index) => Math.abs(value - expected[index]) <= 2), `reversed luma ${actual.slice(0, 12).join(' ')} … ${actual.slice(-12).join(' ')}`);
    // Keyframes every 8 frames keep reverse seeks short.
    assert.ok((await converter.keyframeInterval(copy)).interval <= 8 / 30 + .01);
    assert.ok(events.some(event => event.kind === 'reverse' && event.phase === 'preparing' && event.progress > 0 && event.progress < 1));
    assert.equal(events.at(-1).phase, 'ready');
    // The copy is reused, also by a new converter on the same cache.
    const modified = (await stat(copy)).mtimeMs;
    assert.equal(await converter.reverseCopy(source), copy);
    const later = createMediaConverter({ cacheDirectory: path.join(temporary, 'cache') });
    assert.equal(await later.reverseCopy(source, undefined, { create: false }), copy);
    await later.close();
    assert.equal((await stat(copy)).mtimeMs, modified);
  } finally {
    await converter.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('short movies reverse in one pass and transparent WebM keeps its alpha', { skip: !ffmpeg, timeout: 180000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-reverse-alpha-'));
  const converter = createMediaConverter({ cacheDirectory: path.join(temporary, 'cache'), reverseSegmentFrames: 20 });
  const plain = createMediaConverter({ cacheDirectory: path.join(temporary, 'plain') });
  try {
    const short = path.join(temporary, 'short.mp4');
    make(['-f', 'lavfi', '-i', ramp(2), ...h264(60), short]);
    const forward = await plain.reverseCopy(short);
    const shortLevels = levels(forward);
    assert.equal(shortLevels.length, 60);
    assert.ok(Math.abs(shortLevels[0] - 118) <= 2 && Math.abs(shortLevels[59]) <= 2, `one-pass reverse ${shortLevels[0]} … ${shortLevels[59]}`);
    assert.equal(streams(forward).streams.some(stream => stream.codec_type === 'audio'), false);

    // Half-transparent frames whose luma ramps, as VP9 with an alpha channel.
    const source = path.join(temporary, 'alpha.webm');
    make(['-f', 'lavfi', '-i', `${ramp(2)},format=yuva420p,geq=lum='mod(N*2\\,256)':cb=128:cr=128:a=128`,
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-deadline', 'realtime', '-auto-alt-ref', '0', '-g', '60', source]);
    const copy = await converter.reverseCopy(source);
    assert.match(path.basename(copy), /\.reverse-copy\.webm$/);
    const video = streams(copy).streams.find(stream => stream.codec_type === 'video');
    assert.equal(String(video.tags?.ALPHA_MODE || video.tags?.alpha_mode), '1');
    const decoder = ['-c:v', 'libvpx-vp9'];
    const alpha = levels(copy, 'alphaextract,signalstats', decoder);
    assert.equal(alpha.length, 60);
    assert.ok(alpha.every(value => Math.abs(value - 128) <= 3), `alpha ${alpha.slice(0, 8).join(' ')}`);
    const luma = levels(copy, 'signalstats', decoder);
    assert.ok(luma.every((value, index) => Math.abs(value - (59 - index) * 2) <= 3), `reversed luma ${luma.slice(0, 8).join(' ')} … ${luma.slice(-8).join(' ')}`);
  } finally {
    await converter.close();
    await plain.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
