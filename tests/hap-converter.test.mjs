// HAP converter engine with real FFmpeg encodes of tiny generated clips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createHapConverter, normalizeSettings, resolveFormat, filterChain, outputPath, outputSize } = require('../electron/hap-converter.cjs');
const ffmpeg = [process.env.PRISM_FFMPEG_PATH, 'C:/ffmpeg/bin/ffmpeg.exe', 'ffmpeg'].find(candidate => candidate && spawnSync(candidate, ['-version']).status === 0);
const ffprobe = ffmpeg && ffmpeg.replace(/ffmpeg(\.exe)?$/i, match => match.replace('ffmpeg', 'ffprobe'));
const make = (args) => { const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]); if (result.status !== 0) throw new Error(String(result.stderr)); };
const probe = file => JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file]).stdout.toString());

test('settings normalize to safe values', () => {
  const settings = normalizeSettings({ format: 'evil', size: { mode: 'custom', width: 99999, height: -5 }, scaling: 'zoom', fps: 13, trim: { start: -1, end: 5 }, audio: { bitDepth: 24, sampleRate: 12345 }, output: { mode: 'folder', folder: 'C:/out', label: 'a/b:c' }, fileName: 'x<y>.mov', chunks: 999 });
  assert.equal(settings.format, 'auto');
  assert.deepEqual(settings.size, { mode: 'custom', width: 8192, height: 4 });
  assert.equal(settings.scaling, 'fit');
  assert.equal(settings.fps, 0);
  assert.deepEqual(settings.trim, { start: 0, end: 5 });
  assert.deepEqual(settings.audio, { enabled: true, sampleRate: 0, bitDepth: 24 });
  assert.equal(settings.output.label, 'abc');
  assert.equal(settings.fileName, 'xy.mov');
  assert.equal(settings.chunks, 64);
  assert.deepEqual(normalizeSettings({}).output, { mode: 'beside', folder: '', label: '' });
});

test('auto formats follow detected transparency', () => {
  assert.equal(resolveFormat('auto', 'used'), 'hap_alpha');
  assert.equal(resolveFormat('auto', 'channel'), 'hap');
  assert.equal(resolveFormat('auto', 'none'), 'hap');
  assert.equal(resolveFormat('auto_q', 'used'), 'hap_alpha');
  assert.equal(resolveFormat('auto_q', 'none'), 'hap_q');
  assert.equal(resolveFormat('hap_q', 'used'), 'hap_q');
  assert.equal(resolveFormat('nonsense', 'none'), 'hap');
});

test('filter chains pad to multiples of 4 and scale by fit, fill or stretch', () => {
  const source = normalizeSettings({});
  assert.equal(filterChain({ width: 1920, height: 1080 }, source, false), 'format=rgba,setsar=1');
  assert.match(filterChain({ width: 1918, height: 1078 }, source, true), /pad=ceil\(iw\/4\)\*4:ceil\(ih\/4\)\*4:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0/);
  const fit = normalizeSettings({ size: { mode: 'custom', width: 1281, height: 719 }, fps: 30 });
  assert.match(filterChain({ width: 1920, height: 1080 }, fit, false), /^fps=30,format=rgba,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720/);
  assert.match(filterChain({ width: 1920, height: 1080 }, { ...fit, scaling: 'fill' }, false), /force_original_aspect_ratio=increase:flags=lanczos,crop=1280:720/);
  assert.match(filterChain({ width: 1920, height: 1080 }, { ...fit, scaling: 'stretch' }, false), /scale=1280:720:flags=lanczos,setsar=1/);
  assert.deepEqual(outputSize({ width: 1918, height: 1078 }, source), { width: 1920, height: 1080 });
});

test('output names sit beside, in a preset folder or a chosen folder, never on the source', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'prism-names-'));
  try {
    const source = path.join(folder, 'clip.mov');
    await writeFile(source, 'x');
    const item = { source: { kind: 'file', path: source } };
    assert.equal(await outputPath(item, normalizeSettings({}), 'hap_alpha'), path.join(folder, 'clip (HAP Alpha).mov'));
    await writeFile(path.join(folder, 'clip (HAP).mov'), 'taken');
    assert.equal(await outputPath(item, normalizeSettings({}), 'hap'), path.join(folder, 'clip (HAP) 2.mov'));
    assert.equal(await outputPath(item, normalizeSettings({ output: { mode: 'subfolder', label: 'Show' } }), 'hap'), path.join(folder, 'Show', 'clip.mov'));
    // Same folder and same name as the source: never overwritten.
    assert.equal(await outputPath(item, normalizeSettings({ output: { mode: 'folder', folder } }), 'hap'), path.join(folder, 'clip 2.mov'));
    const taken = new Set();
    const first = await outputPath(item, normalizeSettings({ fileName: 'final' }), 'hap', taken);
    const second = await outputPath(item, normalizeSettings({ fileName: 'final' }), 'hap', taken);
    assert.deepEqual([path.basename(first), path.basename(second)], ['final.mov', 'final 2.mov']);
    await assert.rejects(outputPath(item, normalizeSettings({ output: { mode: 'folder', folder: 'relative' } }), 'hap'), /output folder/);
  } finally { await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('detects real transparency and encodes HAP or HAP Alpha with audio, padding and trim', { skip: !ffmpeg, timeout: 180000 }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'prism-hap-'));
  try {
    const opaque = path.join(folder, 'opaque.mp4'), alpha = path.join(folder, 'alpha.mov'), channel = path.join(folder, 'channel.mov'), frames = path.join(folder, 'frames');
    make(['-f', 'lavfi', '-i', 'testsrc2=size=66x38:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', opaque]);
    make(['-f', 'lavfi', '-i', "testsrc2=size=64x36:rate=25:duration=2,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,32),255,0)'", '-c:v', 'qtrle', alpha]);
    make(['-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=25:duration=2,format=rgba', '-c:v', 'qtrle', channel]);
    await mkdir(frames);
    make(['-f', 'lavfi', '-i', "testsrc2=size=64x36:rate=25:duration=1,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='128'", path.join(frames, 'shot_%03d.png')]);
    let latest = null;
    const converter = createHapConverter({ cacheDirectory: path.join(folder, 'cache'), onUpdate: state => { latest = state; } });
    const items = await converter.add([opaque, alpha, channel, frames, path.join(folder, 'missing.mov')]);
    const byName = Object.fromEntries(items.map(item => [item.name, item]));
    assert.equal(byName['opaque.mp4'].alpha, 'none');
    assert.equal(byName['opaque.mp4'].hasAudio, true);
    assert.equal(byName['alpha.mov'].alpha, 'used');
    assert.equal(byName['channel.mov'].alpha, 'channel');
    assert.equal(byName.frames.alpha, 'used');
    assert.equal(byName.frames.frames, 25);
    assert.match(byName['missing.mov'].error, /ENOENT|no such/i);
    assert.ok(byName['opaque.mp4'].thumbnail.startsWith('data:image/jpeg;base64,'));
    const out = path.join(folder, 'out');
    const wanted = ['opaque.mp4', 'alpha.mov', 'channel.mov', 'frames'];
    await converter.enqueue(wanted.map(name => ({ itemId: byName[name].id, settings: { format: 'auto', output: { mode: 'folder', folder: out } } })));
    const [trimmed] = await converter.enqueue([{ itemId: byName['opaque.mp4'].id, settings: { format: 'hap_q', trim: { start: 0.4, end: 1.4 }, audio: { enabled: false }, output: { mode: 'folder', folder: out }, fileName: 'trimmed' } }]);
    while (!latest || latest.jobs.some(job => job.status === 'queued' || job.status === 'running')) await new Promise(resolve => setTimeout(resolve, 50));
    for (const job of latest.jobs) assert.equal(job.status, 'done', `${job.name}: ${job.error}`);
    const info = file => { const result = probe(path.join(out, file)); return { video: result.streams.find(stream => stream.codec_type === 'video'), audio: result.streams.find(stream => stream.codec_type === 'audio') }; };
    const opaqueOut = info('opaque.mov');
    assert.equal(opaqueOut.video.codec_tag_string, 'Hap1');
    assert.deepEqual([opaqueOut.video.width, opaqueOut.video.height], [68, 40]);
    assert.equal(Number(opaqueOut.video.nb_read_frames), 50);
    assert.equal(opaqueOut.audio.codec_name, 'pcm_s16le');
    assert.equal(info('alpha.mov').video.codec_tag_string, 'Hap5');
    assert.equal(info('channel.mov').video.codec_tag_string, 'Hap1');
    assert.equal(info('frames.mov').video.codec_tag_string, 'Hap5');
    const trimmedOut = info('trimmed.mov');
    assert.equal(trimmedOut.video.codec_tag_string, 'HapY');
    assert.equal(Number(trimmedOut.video.nb_read_frames), 25);
    assert.equal(trimmedOut.audio, undefined);
    assert.equal(trimmed.format, 'hap_q');
    // No partial files are left behind.
    assert.deepEqual((await readdir(out)).filter(name => name.includes('.part')), []);
    // Cancelling a running job removes its partial output.
    const long = path.join(folder, 'long.mp4');
    make(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=60', '-c:v', 'libx264', '-preset', 'ultrafast', long]);
    const [longItem] = await converter.add([long]);
    const [job] = await converter.enqueue([{ itemId: longItem.id, settings: { output: { mode: 'folder', folder: out } } }]);
    while (!latest.jobs.some(entry => entry.id === job.id && entry.status === 'running')) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(converter.cancel(job.id), true);
    while (latest.jobs.find(entry => entry.id === job.id).status === 'running') await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(latest.jobs.find(entry => entry.id === job.id).status, 'cancelled');
    assert.deepEqual((await readdir(out)).filter(name => name.startsWith('.long') || name === 'long.mov'), []);
    await converter.close();
  } finally { await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});