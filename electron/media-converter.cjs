'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { findImageSequence, imageSequenceFramePath, validateImageSequence, probeImageSequence } = require('./image-sequence.cjs');

// Bump this when the playback format or conversion settings change. Originals
// remain authoritative; the files in this directory are disposable playback data.
const CACHE_VERSION = 1;
// Thumbnails are small single-frame decodes; anything slower is a stuck file.
const THUMBNAIL_TIMEOUT = 20000;
const MAX_QUEUED_THUMBNAILS = 1000;
const SEQUENCE_STAT_CONCURRENCY = 32;

function abortError(message = 'Media preparation was cancelled.') {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

// HAP and DXV store frames as DXT/BC textures the renderer uploads directly,
// so they need no playback copy. HAP variants are known by codec tag; DXV
// declares its texture format (and so its alpha) per frame, which the
// renderer reads when it opens the movie.
const HAP_ALPHA_TAGS = new Set(['Hap5', 'HapM', 'Hap7']);
function gpuVideoCodec(stream) {
  const tag = String(stream?.codec_tag_string || '');
  if (stream?.codec_name === 'hap') return { codec: 'hap', tag, hasAlpha: HAP_ALPHA_TAGS.has(tag) };
  if (stream?.codec_name === 'dxv') return { codec: 'dxv', tag };
  return null;
}

function sourceHasAlpha(stream) {
  const format = String(stream.pix_fmt || '').toLowerCase();
  return /^(rgba|bgra|argb|abgr|yuva|gbrap|ya\d|ayuv|vuya)/.test(format)
    || format === 'pal8' || String(stream.tags?.alpha_mode || '') === '1';
}

function cacheKey(source, stat) {
  const absolute = path.resolve(source);
  return createHash('sha256').update(JSON.stringify({ version: CACHE_VERSION,
    path: process.platform === 'win32' ? absolute.toLowerCase() : absolute,
    size: stat.size, modified: stat.mtimeMs })).digest('hex');
}

function sequenceCacheKey(sequence, signature, fps) {
  const directory = path.resolve(sequence.directory);
  return createHash('sha256').update(JSON.stringify({ version: CACHE_VERSION, kind: 'image-sequence',
    directory: process.platform === 'win32' ? directory.toLowerCase() : directory,
    pattern: sequence.pattern, start: sequence.start, count: sequence.count, fps, frames: signature })).digest('hex');
}

async function executableFile(candidate) {
  if (!candidate) return null;
  try { return (await fs.stat(candidate)).isFile() ? candidate : null; } catch { return null; }
}

async function discoverExecutable(name, { env = process.env, resourcesPath = '' } = {}) {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const filename = `${name}${extension}`;
  const explicit = env[`PRISM_${name.toUpperCase()}_PATH`];
  if (explicit) {
    const found = await executableFile(explicit);
    if (found) return found;
    throw new Error(`${name} was not found at ${explicit}. Check PRISM_${name.toUpperCase()}_PATH.`);
  }
  const candidates = [
    // An ffmpeg override normally ships its matching ffprobe beside it.
    ...(name === 'ffprobe' && env.PRISM_FFMPEG_PATH ? [path.join(path.dirname(env.PRISM_FFMPEG_PATH), filename)] : []),
    ...(resourcesPath ? [path.join(resourcesPath, 'tools', filename), path.join(resourcesPath, 'tools', name, 'bin', filename)] : []),
    ...(process.platform === 'win32' ? [path.join('C:\\ffmpeg\\bin', filename)] : []),
    ...String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/g, ''), filename)),
  ];
  for (const candidate of candidates) {
    const found = await executableFile(candidate);
    if (found) return found;
  }
  throw new Error(`MOV and image sequence playback needs FFmpeg and ffprobe. Install FFmpeg or set PRISM_FFMPEG_PATH and PRISM_FFPROBE_PATH to their executables.`);
}

function createMediaConverter({ cacheDirectory, resourcesPath = '', env = process.env, onProgress = () => {}, thumbnailConcurrency = 2 }) {
  if (!path.isAbsolute(cacheDirectory)) throw new Error('Media cache must use an absolute directory.');
  const pending = new Map();
  const thumbnailPending = new Map();
  const sequencePending = new Map();
  const videoThumbnailPending = new Map();
  const probes = new Map();
  const audioPending = new Map();
  const thumbnailWaiters = [];
  const thumbnailLimit = Math.max(1, Math.min(4, Math.floor(Number(thumbnailConcurrency)) || 2));
  const children = new Set();
  let queue = Promise.resolve();
  let toolsPromise;
  let exrPromise;
  let closed = false;
  let processPeak = 0;
  let thumbnailsActive = 0;
  let thumbnailPeak = 0;

  const checkOpen = () => { if (closed) throw new Error('Media preparation stopped because PrismVJ is closing.'); };
  const emit = (event, listeners) => {
    if (closed) return;
    // A disconnected window must not turn a successful conversion into a failure.
    try { onProgress(event); } catch {}
    for (const listener of listeners || []) try { listener(event); } catch {}
  };
  const report = (source, phase, progress = null, error) => {
    emit({ name: path.basename(source), path: source, phase, progress, ...(error ? { error } : {}) });
  };

  function run(executable, args, { timeout = 30000, onOutput, signal } = {}) {
    checkOpen();
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
      children.add(child);
      processPeak = Math.max(processPeak, children.size);
      let output = '';
      let errorOutput = '';
      let timedOut = false;
      let aborted = false;
      const onAbort = () => { aborted = true; child.kill(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
      const finish = () => { clearTimeout(timer); children.delete(child); signal?.removeEventListener('abort', onAbort); };
      child.stdout.on('data', chunk => {
        const text = chunk.toString();
        if (onOutput) onOutput(text);
        else output = (output + text).slice(-4 * 1024 * 1024);
      });
      child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-16384); });
      child.once('error', error => { finish(); reject(error); });
      child.once('close', code => {
        finish();
        if (closed) reject(new Error('Media preparation stopped because PrismVJ is closing.'));
        else if (aborted) reject(abortError());
        else if (timedOut) reject(new Error(`${path.basename(executable)} took too long while preparing this media.`));
        else if (code !== 0) reject(new Error(errorOutput.trim() || `${path.basename(executable)} exited with code ${code}.`));
        else resolve(output);
      });
    });
  }

  function tools() {
    return toolsPromise ||= Promise.all([
      discoverExecutable('ffmpeg', { env, resourcesPath }),
      discoverExecutable('ffprobe', { env, resourcesPath }),
    ]).then(([ffmpeg, ffprobe]) => ({ ffmpeg, ffprobe })).catch(error => { toolsPromise = null; throw error; });
  }

  // OpenEXR decoding is optional in FFmpeg builds.
  function supportsExr() {
    return exrPromise ||= tools().then(({ ffmpeg }) => run(ffmpeg, ['-hide_banner', '-decoders'], { timeout: THUMBNAIL_TIMEOUT }))
      .then(output => /^\s*V\S*\s+exr\s/m.test(output)).catch(error => { exrPromise = null; throw error; });
  }
  async function dxvHasTransparency(source, ffmpeg) {
    // FFprobe reports rgba for both opaque and transparent DXV. Inspect every
    // decoded alpha plane so a clip that becomes transparent later is retained.
    let pending = '';
    let inspected = 0;
    let transparent = false;
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source,
      '-map', '0:v:0', '-vf', 'alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YMIN:file=-',
      '-an', '-f', 'null', '-'], {
      timeout: 30 * 60 * 1000,
      onOutput(chunk) {
        const lines = (pending + chunk).split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          const match = /^lavfi\.signalstats\.YMIN=(\d+)$/.exec(line);
          if (match) { inspected++; if (Number(match[1]) < 255) transparent = true; }
        }
      },
    });
    if (!inspected) throw new Error('Could not inspect DXV transparency.');
    return transparent;
  }

  // ffprobe output for one revision of a file, kept for the session.
  async function probeSource(source, knownStat) {
    checkOpen();
    const absolute = path.resolve(source);
    const stat = knownStat || await fs.stat(absolute);
    const key = cacheKey(absolute, stat);
    if (!probes.has(key)) {
      const job = tools().then(({ ffprobe }) => run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', absolute], { timeout: THUMBNAIL_TIMEOUT }))
        .then(output => JSON.parse(output));
      probes.set(key, job);
      job.catch(() => probes.delete(key));
    }
    return probes.get(key);
  }

  /**
   * Describes a movie the renderer decodes on the GPU from the original file
   * ({ codec: 'hap', tag, hasAlpha, hasAudio }), or null when it needs a
   * converted playback copy.
   */
  async function gpuCodec(source, knownStat) {
    const probe = await probeSource(source, knownStat);
    const video = probe.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const codec = gpuVideoCodec(video);
    return codec && { ...codec, hasAudio: !!probe.streams?.some(stream => stream.codec_type === 'audio') };
  }

  /**
   * The first audio track of a movie as cached FLAC, reversed when requested,
   * for movies that play their video from the original file. Runs beside the
   * conversion queue: it is short, and playback is waiting for it.
   */
  async function extractAudio(source, knownStat, { reverse = false } = {}) {
    checkOpen();
    const absolute = path.resolve(source);
    const stat = knownStat || await fs.stat(absolute);
    const key = cacheKey(absolute, stat);
    const destination = path.join(cacheDirectory, `${key}.audio${reverse ? '.reverse' : ''}.flac`);
    const current = await fs.stat(destination).catch(() => null);
    if (current?.isFile() && current.size > 0) return destination;
    if (audioPending.has(destination)) return audioPending.get(destination);
    const job = (async () => {
      await fs.mkdir(cacheDirectory, { recursive: true });
      const temporary = path.join(cacheDirectory, `${key}.${randomUUID()}.part.flac`);
      try {
        const { ffmpeg } = await tools();
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', absolute, '-map', '0:a:0', '-vn', '-map_metadata', '-1',
          ...(reverse ? ['-af', 'areverse'] : []), '-c:a', 'flac', '-f', 'flac', temporary], { timeout: 10 * 60 * 1000 });
        if (!(await fs.stat(temporary)).size) throw new Error('The movie has no decodable audio.');
        await fs.rename(temporary, destination);
        return destination;
      } finally { await fs.unlink(temporary).catch(() => {}); }
    })();
    audioPending.set(destination, job);
    try { return await job; } finally { audioPending.delete(destination); }
  }

  async function cached(key) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(cacheDirectory, `${key}.json`), 'utf8'));
      const format = metadata.format === 'mp4' ? 'mp4' : 'webm';
      const playbackPath = path.join(cacheDirectory, `${key}.${format}`);
      const stat = await fs.stat(playbackPath);
      if (metadata.version === CACHE_VERSION && metadata.key === key && typeof metadata.hasAlpha === 'boolean'
        && stat.isFile() && stat.size > 0 && stat.size === metadata.bytes) {
        const reversePath = path.join(cacheDirectory, `${key}.reverse.${format}`);
        const thumbnailPath = path.join(cacheDirectory, `${key}.jpg`);
        const reverse = await fs.stat(reversePath).catch(() => null);
        const thumbnail = await fs.stat(thumbnailPath).catch(() => null);
        return { playbackPath, hasAlpha: metadata.hasAlpha, alphaVerified: metadata.alphaVerified === true, format,
          reversePath: reverse?.isFile() && reverse.size > 0 && reverse.size === metadata.reverseBytes ? reversePath : null,
          thumbnailPath: thumbnail?.isFile() && thumbnail.size > 0 ? thumbnailPath : null,
          ...(metadata.sequence && typeof metadata.sequence === 'object' ? { sequence: metadata.sequence } : {}) };
      }
    } catch { /* Missing or interrupted cache entries are rebuilt from the original. */ }
    return null;
  }

  async function makeThumbnail(source, key, positions = ['0.5', '0']) {
    const destination = path.join(cacheDirectory, `${key}.jpg`);
    const current = await fs.stat(destination).catch(() => null);
    if (current?.isFile() && current.size > 0) return destination;
    await fs.mkdir(cacheDirectory, { recursive: true });
    const temporary = path.join(cacheDirectory, `${key}.${randomUUID()}.part.jpg`);
    try {
      const { ffmpeg } = await tools();
      const encode = position => run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-ss', position, '-i', source, '-frames:v', '1', '-vf', 'scale=160:-2', '-q:v', '3', '-f', 'image2', temporary], { timeout: 60000 });
      for (let index = 0; index < positions.length; index++) {
        try { await encode(positions[index]); break; }
        catch (error) { await fs.unlink(temporary).catch(() => {}); if (index === positions.length - 1) throw error; }
      }
      if (!(await fs.stat(temporary)).size) throw new Error('Could not create a preview image.');
      await fs.rename(temporary, destination);
      return destination;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function thumbnail(source, knownStat) {
    checkOpen();
    const absolute = path.resolve(source);
    const stat = knownStat || await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Media path is not a file.');
    const key = cacheKey(absolute, stat);
    const destination = path.join(cacheDirectory, `${key}.jpg`);
    const current = await fs.stat(destination).catch(() => null);
    if (current?.isFile() && current.size > 0) return destination;
    if (thumbnailPending.has(key)) return thumbnailPending.get(key);
    const job = queue.then(() => makeThumbnail(absolute, key));
    thumbnailPending.set(key, job);
    queue = job.catch(() => {});
    try { return await job; } finally { if (thumbnailPending.get(key) === job) thumbnailPending.delete(key); }
  }

  // Thumbnails run beside (not behind) the one-at-a-time conversion queue, but
  // never more than `thumbnailLimit` at once: importing 50 clips queues them.
  function withThumbnailSlot(task) {
    return new Promise((resolve, reject) => {
      const start = () => {
        thumbnailsActive++;
        thumbnailPeak = Math.max(thumbnailPeak, thumbnailsActive);
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          thumbnailsActive--;
          thumbnailWaiters.shift()?.();
        });
      };
      if (thumbnailsActive < thumbnailLimit) start();
      else if (thumbnailWaiters.length >= MAX_QUEUED_THUMBNAILS) reject(new Error('Too many thumbnail requests are waiting.'));
      else thumbnailWaiters.push(start);
    });
  }

  async function makeVideoThumbnail(source, key, width, at) {
    checkOpen();
    const { ffmpeg, ffprobe } = await tools();
    const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source], { timeout: THUMBNAIL_TIMEOUT }));
    const video = probe.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
      || probe.streams?.find(stream => stream.codec_type === 'video');
    if (!video) throw new Error('This file does not contain a video track.');
    const duration = Number(video.duration || probe.format?.duration) || 0;
    const seconds = at === 'start' ? 0
      : at === 'middle' ? duration / 2
        : at === 'end' ? Math.max(0, duration - .1)
          : duration > 0 ? Math.min(at, Math.max(0, duration - .05)) : at;
    const alpha = sourceHasAlpha(video);
    const format = alpha ? 'png' : 'jpg';
    // libvpx is the only FFmpeg VP8/VP9 decoder that reads the WebM alpha side channel.
    const decoder = String(video.tags?.alpha_mode || '') === '1'
      ? video.codec_name === 'vp9' ? ['-c:v', 'libvpx-vp9'] : video.codec_name === 'vp8' ? ['-c:v', 'libvpx'] : []
      : [];
    await fs.mkdir(cacheDirectory, { recursive: true });
    const destination = path.join(cacheDirectory, `${key}.${format}`);
    const temporary = path.join(cacheDirectory, `${key}.${randomUUID()}.part.${format}`);
    const encode = position => run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
      ...(position > 0 ? ['-ss', position.toFixed(3)] : []), ...decoder, '-i', source,
      '-map', `0:${video.index}`, '-frames:v', '1', '-vf', `scale=${width}:-2`,
      ...(alpha ? ['-pix_fmt', 'rgba'] : ['-q:v', '3']), '-f', 'image2', temporary], { timeout: THUMBNAIL_TIMEOUT });
    const written = async () => (await fs.stat(temporary).catch(() => null))?.size > 0;
    try {
      let failure;
      try { await encode(seconds); } catch (error) { failure = error; }
      // Seeking past the last decodable frame writes nothing; fall back to the first frame.
      if (!(await written()) && seconds > 0) {
        checkOpen();
        await fs.unlink(temporary).catch(() => {});
        failure = null;
        await encode(0);
      }
      if (failure) throw failure;
      if (!(await written())) throw new Error('Could not create a preview image.');
      await fs.rename(temporary, destination);
      return destination;
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  /**
   * Cached preview image for any video FFmpeg can decode (and stills). Returns
   * the absolute path of a JPEG, or a PNG when the source has alpha.
   * `at` is 'start', 'middle', 'end' or a time in seconds.
   */
  async function videoThumbnail(source, { width = 160, at = 'middle' } = {}) {
    checkOpen();
    if (typeof source !== 'string' || !path.isAbsolute(source) || source.includes('\0') || source.length > 32768) {
      throw new Error('Expected an absolute local media path.');
    }
    const size = Math.round(Number(width));
    if (!Number.isFinite(size) || size < 16 || size > 1920) throw new Error('Thumbnail width must be between 16 and 1920 pixels.');
    const position = ['start', 'middle', 'end'].includes(at) ? at : Number(at);
    if (typeof position === 'number' && !(Number.isFinite(position) && position >= 0)) throw new Error('Thumbnail time must be start, middle, end or seconds.');
    const absolute = path.resolve(source);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Media path is not a file.');
    const key = createHash('sha256').update(JSON.stringify({ version: CACHE_VERSION, kind: 'video-thumbnail',
      source: cacheKey(absolute, stat), width: size, at: position })).digest('hex');
    for (const format of ['jpg', 'png']) {
      const destination = path.join(cacheDirectory, `${key}.${format}`);
      const current = await fs.stat(destination).catch(() => null);
      if (current?.isFile() && current.size > 0) return destination;
    }
    if (videoThumbnailPending.has(key)) return videoThumbnailPending.get(key);
    const job = withThumbnailSlot(() => makeVideoThumbnail(absolute, key, size, position)).catch(error => {
      throw new Error(`Could not create a thumbnail for ${path.basename(absolute)}: ${error.message}`);
    });
    videoThumbnailPending.set(key, job);
    try { return await job; } finally { if (videoThumbnailPending.get(key) === job) videoThumbnailPending.delete(key); }
  }
  async function convert(source, originalStat, key) {
    checkOpen();
    let existing = await cached(key);
    if (existing?.reversePath && existing.thumbnailPath && (existing.alphaVerified || !existing.hasAlpha)
      && (existing.hasAlpha || existing.format === 'mp4')) { report(source, 'ready', 1); return existing; }
    report(source, 'preparing', existing ? .45 : 0);
    const { ffmpeg, ffprobe } = await tools();
    const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', source]));
    const video = probe.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    if (!video) throw new Error('This MOV does not contain a video track.');
    const hasAlpha = sourceHasAlpha(video)
      ? video.codec_name === 'dxv' ? await dxvHasTransparency(source, ffmpeg) : true
      : false;
    const format = hasAlpha ? 'webm' : 'mp4';
    const videoOptions = hasAlpha
      ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-deadline', 'realtime', '-cpu-used', '5',
        '-row-mt', '1', '-threads', '4', '-crf', '18', '-b:v', '0', '-auto-alt-ref', '0']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
    const audioOptions = hasAlpha ? ['-c:a', 'libopus', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '192k'];
    const containerOptions = hasAlpha ? ['-f', 'webm'] : ['-movflags', '+faststart', '-f', 'mp4'];
    const duration = Number(video.duration || probe.format?.duration) || 0;
    await fs.mkdir(cacheDirectory, { recursive: true });
    checkOpen();
    const destination = path.join(cacheDirectory, `${key}.${format}`);
    const temporary = path.join(cacheDirectory, `${key}.${randomUUID()}.part.${format}`);
    const reverseDestination = path.join(cacheDirectory, `${key}.reverse.${format}`);
    const reverseTemporary = path.join(cacheDirectory, `${key}.${randomUUID()}.reverse.part.${format}`);
    const metadataPath = path.join(cacheDirectory, `${key}.json`);
    const temporaryMetadata = `${metadataPath}.${randomUUID()}.tmp`;
    let progressBuffer = '';
    let lastProgress = 0;
    let lastReportedAt = 0;
    try {
      if (existing?.reversePath && existing.thumbnailPath && existing.hasAlpha === hasAlpha && existing.format === format) {
        const outputStat = await fs.stat(existing.playbackPath);
        const reverseStat = await fs.stat(existing.reversePath);
        await fs.writeFile(temporaryMetadata, JSON.stringify({ version: CACHE_VERSION, key, hasAlpha, format,
          alphaVerified: true, bytes: outputStat.size, reverseBytes: reverseStat.size }), { flag: 'wx' });
        await fs.rename(temporaryMetadata, metadataPath);
        report(source, 'ready', 1);
        return { ...existing, alphaVerified: true };
      }
      if (existing && (existing.hasAlpha !== hasAlpha || existing.format !== format)) existing = null;
      if (!existing) await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-n', '-i', source,
        '-map', `0:${video.index}`, '-map', '0:a:0?', '-map_metadata', '-1',
        ...videoOptions, '-g', '8', '-fps_mode', 'passthrough',
        ...audioOptions, '-progress', 'pipe:1', ...containerOptions, temporary], {
        timeout: 30 * 60 * 1000,
        onOutput(text) {
          progressBuffer += text;
          const lines = progressBuffer.split(/\r?\n/);
          progressBuffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('out_time_us=')) continue;
            const seconds = Number(line.slice(12)) / 1000000;
            if (!Number.isFinite(seconds)) continue;
            const progress = duration > 0 ? Math.min(.45, Math.max(lastProgress, seconds / duration * .45)) : null;
            if (Date.now() - lastReportedAt >= 250) {
              lastReportedAt = Date.now();
              lastProgress = progress ?? 0;
              report(source, 'preparing', progress);
            }
          }
        },
      });
      if (!existing?.reversePath) {
        let reverseBuffer = '';
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-n', '-i', source,
          '-map', `0:${video.index}`, '-map', '0:a:0?', '-map_metadata', '-1',
          '-vf', 'reverse', '-af', 'areverse', ...videoOptions, '-g', '8', '-fps_mode', 'passthrough',
          ...audioOptions, '-progress', 'pipe:1', ...containerOptions, reverseTemporary], {
          timeout: 30 * 60 * 1000,
          onOutput(text) {
            reverseBuffer += text;
            const lines = reverseBuffer.split(/\r?\n/);
            reverseBuffer = lines.pop();
            for (const line of lines) if (line.startsWith('out_time_us=')) {
              const seconds = Number(line.slice(12)) / 1000000;
              if (Number.isFinite(seconds) && Date.now() - lastReportedAt >= 250) {
                lastReportedAt = Date.now();
                report(source, 'preparing', duration > 0 ? Math.min(.95, .45 + seconds / duration * .5) : null);
              }
            }
          },
        });
      }
      checkOpen();
      const sourceStat = await fs.stat(source);
      if (sourceStat.size !== originalStat.size || sourceStat.mtimeMs !== originalStat.mtimeMs) {
        throw new Error('The original MOV changed during preparation. Import it again after the file finishes copying.');
      }
      const outputStat = existing ? await fs.stat(existing.playbackPath) : await fs.stat(temporary);
      if (!outputStat.size) throw new Error('The decoder produced an empty playback file.');
      const reverseStat = existing?.reversePath ? await fs.stat(existing.reversePath) : await fs.stat(reverseTemporary);
      if (!reverseStat.size) throw new Error('The reverse decoder produced an empty playback file.');
      if (!existing) await fs.rename(temporary, destination);
      if (!existing?.reversePath) await fs.rename(reverseTemporary, reverseDestination);
      const thumbnailPath = existing?.thumbnailPath || await makeThumbnail(source, key);
      await fs.writeFile(temporaryMetadata, JSON.stringify({ version: CACHE_VERSION, key, hasAlpha, format,
        alphaVerified: true, bytes: outputStat.size, reverseBytes: reverseStat.size }), { flag: 'wx' });
      await fs.rename(temporaryMetadata, metadataPath);
      report(source, 'ready', 1);
      return { playbackPath: destination, reversePath: reverseDestination, thumbnailPath, hasAlpha, alphaVerified: true, format };
    } finally {
      await fs.unlink(temporary).catch(() => {});
      await fs.unlink(reverseTemporary).catch(() => {});
      await fs.unlink(temporaryMetadata).catch(() => {});
    }
  }

  async function prepare(source, knownStat) {
    checkOpen();
    const absolute = path.resolve(source);
    const stat = knownStat || await fs.stat(absolute);
    if (!stat.isFile()) throw new Error('Media path is not a file.');
    const key = cacheKey(absolute, stat);
    if (pending.has(key)) return pending.get(key);
    const existing = await cached(key);
    if (existing?.reversePath && existing.thumbnailPath && (existing.alphaVerified || !existing.hasAlpha)
      && (existing.hasAlpha || existing.format === 'mp4')) return existing;
    // Another request may have entered while this one checked the disk cache.
    if (pending.has(key)) return pending.get(key);
    report(absolute, 'queued', null);
    const job = queue.then(() => convert(absolute, stat, key)).catch(error => {
      const wrapped = new Error(`Could not prepare ${path.basename(absolute)}: ${error.message}`);
      report(absolute, 'error', null, wrapped.message);
      throw wrapped;
    });
    pending.set(key, job);
    // One conversion at a time leaves CPU available for the live composition.
    queue = job.catch(() => {});
    try { return await job; } finally { if (pending.get(key) === job) pending.delete(key); }
  }

  // Size and mtime of every frame, in order. Any added, removed, replaced or
  // touched frame yields a different cache key.
  async function sequenceSignature(sequence, signal) {
    const entries = new Array(sequence.count);
    let next = 0;
    const worker = async () => {
      while (next < sequence.count) {
        const index = next++;
        if (signal?.aborted) throw abortError();
        checkOpen();
        const framePath = imageSequenceFramePath(sequence, index);
        const stat = await fs.stat(framePath).catch(() => null);
        if (!stat?.isFile()) throw new Error(`Frame ${path.basename(framePath)} of the image sequence is missing.`);
        entries[index] = `${stat.size}:${stat.mtimeMs}`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEQUENCE_STAT_CONCURRENCY, sequence.count) }, worker));
    const hash = createHash('sha256');
    for (const entry of entries) hash.update(entry).update('\n');
    return hash.digest('hex');
  }

  async function convertSequence(sequence, key, signature, fps, event, signal) {
    checkOpen();
    if (signal.aborted) throw abortError();
    const existing = await cached(key);
    if (existing?.reversePath && existing.thumbnailPath && existing.sequence) { event('ready', 1); return existing; }
    event('preparing', 0);
    const { ffmpeg, ffprobe } = await tools();
    if (sequence.extension === 'exr' && !(await supportsExr())) throw new Error('This FFmpeg build cannot decode OpenEXR images.');
    const frames = Array.from({ length: sequence.count }, (_, index) => imageSequenceFramePath(sequence, index));
    // The reverse pass lists every frame in an FFmpeg concat script; a line
    // break in a name would end the entry early.
    if (frames.some(frame => /[\r\n]/.test(frame))) throw new Error('Image sequence file names must not contain line breaks.');
    const info = await probeImageSequence(sequence, args => run(ffprobe, args, { timeout: THUMBNAIL_TIMEOUT, signal }));
    const { hasAlpha } = info;
    const format = hasAlpha ? 'webm' : 'mp4';
    const videoOptions = hasAlpha
      ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-deadline', 'realtime', '-cpu-used', '5',
        '-row-mt', '1', '-threads', '4', '-crf', '18', '-b:v', '0', '-auto-alt-ref', '0']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
    const containerOptions = hasAlpha ? ['-f', 'webm'] : ['-movflags', '+faststart', '-f', 'mp4'];
    // 4:2:0 chroma needs even dimensions; stills are often odd-sized.
    const outputOptions = ['-frames:v', String(sequence.count), '-an', '-map_metadata', '-1',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', ...videoOptions, '-g', '8', '-fps_mode', 'passthrough',
      '-progress', 'pipe:1', ...containerOptions];
    const rate = String(fps);
    const timeout = Math.max(30 * 60 * 1000, sequence.count * 250);
    await fs.mkdir(cacheDirectory, { recursive: true });
    checkOpen();
    const destination = path.join(cacheDirectory, `${key}.${format}`);
    const temporary = path.join(cacheDirectory, `${key}.${randomUUID()}.part.${format}`);
    const reverseDestination = path.join(cacheDirectory, `${key}.reverse.${format}`);
    const reverseTemporary = path.join(cacheDirectory, `${key}.${randomUUID()}.reverse.part.${format}`);
    const reverseList = path.join(cacheDirectory, `${key}.${randomUUID()}.part.ffconcat`);
    const metadataPath = path.join(cacheDirectory, `${key}.json`);
    const temporaryMetadata = `${metadataPath}.${randomUUID()}.tmp`;
    let lastReportedAt = 0;
    const frameProgress = (from, span) => {
      let buffer = '';
      return text => {
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('frame=')) continue;
          const frame = Number(line.slice(6));
          if (Number.isFinite(frame) && Date.now() - lastReportedAt >= 250) {
            lastReportedAt = Date.now();
            event('preparing', Math.min(from + span, from + frame / sequence.count * span));
          }
        }
      };
    };
    try {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-n',
        '-framerate', rate, '-start_number', String(sequence.start), '-pattern_type', 'sequence',
        '-i', path.join(sequence.directory, sequence.pattern), ...outputOptions, temporary],
      { timeout, signal, onOutput: frameProgress(0, .45) });
      // Reverse playback reads the frames newest-first instead of buffering the
      // whole clip in FFmpeg's reverse filter, so memory stays bounded.
      await fs.writeFile(reverseList, `ffconcat version 1.0\n${frames.slice().reverse()
        .map(frame => `file '${frame.replace(/'/g, "'\\''")}'\n`).join('')}`, { flag: 'wx' });
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-nostats', '-n',
        '-r', rate, '-f', 'concat', '-safe', '0', '-i', reverseList, ...outputOptions, reverseTemporary],
      { timeout, signal, onOutput: frameProgress(.45, .5) });
      checkOpen();
      if (signal.aborted) throw abortError();
      if (await sequenceSignature(sequence, signal) !== signature) {
        throw new Error('The image sequence changed during preparation. Import it again after the files finish copying.');
      }
      const outputStat = await fs.stat(temporary);
      if (!outputStat.size) throw new Error('The encoder produced an empty playback file.');
      const reverseStat = await fs.stat(reverseTemporary);
      if (!reverseStat.size) throw new Error('The reverse encoder produced an empty playback file.');
      await fs.rename(temporary, destination);
      await fs.rename(reverseTemporary, reverseDestination);
      const thumbnailIndex = Math.min(sequence.count - 1, Math.round(fps * .5));
      const thumbnailPath = await makeThumbnail(frames[thumbnailIndex], key, ['0']);
      // JSON round-trip drops unknown sizes so fresh and cached results match exactly.
      const details = JSON.parse(JSON.stringify({ directory: sequence.directory, pattern: sequence.pattern,
        start: sequence.start, count: sequence.count, fps, duration: sequence.count / fps, width: info.width, height: info.height }));
      await fs.writeFile(temporaryMetadata, JSON.stringify({ version: CACHE_VERSION, key, hasAlpha, format,
        alphaVerified: true, bytes: outputStat.size, reverseBytes: reverseStat.size, sequence: details }), { flag: 'wx' });
      await fs.rename(temporaryMetadata, metadataPath);
      event('ready', 1);
      return { playbackPath: destination, reversePath: reverseDestination, thumbnailPath, hasAlpha, alphaVerified: true, format, sequence: details };
    } finally {
      await fs.unlink(temporary).catch(() => {});
      await fs.unlink(reverseTemporary).catch(() => {});
      await fs.unlink(reverseList).catch(() => {});
      await fs.unlink(temporaryMetadata).catch(() => {});
    }
  }
  /**
   * Encode an image sequence (from findImageSequence, or a folder/frame path)
   * into cached forward and reverse playback copies plus a thumbnail, exactly
   * like a MOV: VP9/WebM with alpha when sampled frames carry alpha, otherwise
   * H.264/MP4. Progress goes to the converter's onProgress and to the optional
   * per-call `onProgress` with `path` = the first frame. Aborting `signal`
   * rejects this call with an AbortError; FFmpeg stops once every caller
   * waiting on the same sequence has aborted.
   */
  async function prepareImageSequence(input, { fps = 30, onProgress: listener, signal } = {}) {
    checkOpen();
    const rate = Number(fps);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 240) throw new Error('Image sequence frame rate must be between 0 and 240 fps.');
    if (signal?.aborted) throw abortError();
    const found = typeof input === 'string' ? await findImageSequence(input) : input;
    if (!found) throw new Error('No numbered image sequence was found.');
    const sequence = validateImageSequence(found);
    const signature = await sequenceSignature(sequence, signal);
    const key = sequenceCacheKey(sequence, signature, rate);
    let entry = sequencePending.get(key);
    if (!entry) {
      const existing = await cached(key);
      if (existing?.reversePath && existing.thumbnailPath && existing.sequence) return existing;
      // Another request may have entered while this one checked the disk cache.
      entry = sequencePending.get(key);
    }
    if (!entry) {
      const firstFrame = imageSequenceFramePath(sequence, 0);
      const name = path.basename(sequence.directory) || sequence.pattern;
      const listeners = new Set();
      const event = (phase, progress = null, error) => emit({ name, path: firstFrame, kind: 'image-sequence', phase, progress,
        ...(error ? { error } : {}) }, listeners);
      const controller = new AbortController();
      const job = queue.then(() => convertSequence(sequence, key, signature, rate, event, controller.signal)).catch(error => {
        const wrapped = error.name === 'AbortError' ? error : new Error(`Could not prepare ${name}: ${error.message}`);
        event('error', null, wrapped.message);
        throw wrapped;
      });
      entry = { job, controller, listeners, waiters: 0 };
      sequencePending.set(key, entry);
      // One conversion at a time leaves CPU available for the live composition.
      queue = job.catch(() => {});
      job.catch(() => {}).finally(() => { if (sequencePending.get(key) === entry) sequencePending.delete(key); });
      if (listener) listeners.add(listener);
      event('queued');
    } else if (listener) entry.listeners.add(listener);
    entry.waiters++;
    if (!signal) return entry.job;
    const current = entry;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (listener) current.listeners.delete(listener);
        if (--current.waiters === 0) current.controller.abort();
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      current.job.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  // Detection with frame size and alpha probed through this converter's FFmpeg.
  function detectImageSequence(target, { probe = true, maxEntries } = {}) {
    checkOpen();
    return findImageSequence(target, { probe, maxEntries,
      exec: async args => run((await tools()).ffprobe, args, { timeout: THUMBNAIL_TIMEOUT }) });
  }

  function stats() {
    return { processes: children.size, processPeak, thumbnailsActive, thumbnailsQueued: thumbnailWaiters.length,
      thumbnailPeak, thumbnailLimit };
  }

  async function close() {
    closed = true;
    for (const child of children) child.kill();
    for (const entry of sequencePending.values()) entry.controller.abort();
    await Promise.allSettled([...pending.values(), ...[...sequencePending.values()].map(entry => entry.job),
      ...videoThumbnailPending.values(), ...audioPending.values()]);
  }

  return { prepare, thumbnail, prepareImageSequence, findImageSequence: detectImageSequence, videoThumbnail, gpuCodec, extractAudio, stats, close };
}

module.exports = { createMediaConverter, discoverExecutable, cacheKey, sourceHasAlpha, gpuVideoCodec, findImageSequence, imageSequenceFramePath };
