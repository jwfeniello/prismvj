'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

// Bump this when the playback format or conversion settings change. Originals
// remain authoritative; the files in this directory are disposable playback data.
const CACHE_VERSION = 1;

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
  throw new Error(`MOV playback needs FFmpeg and ffprobe. Install FFmpeg or set PRISM_FFMPEG_PATH and PRISM_FFPROBE_PATH to their executables.`);
}

function createMediaConverter({ cacheDirectory, resourcesPath = '', env = process.env, onProgress = () => {} }) {
  if (!path.isAbsolute(cacheDirectory)) throw new Error('Media cache must use an absolute directory.');
  const pending = new Map();
  const thumbnailPending = new Map();
  const children = new Set();
  let queue = Promise.resolve();
  let toolsPromise;
  let closed = false;

  const checkOpen = () => { if (closed) throw new Error('Media preparation stopped because Prism Live is closing.'); };
  const report = (source, phase, progress = null, error) => {
    if (closed) return;
    // A disconnected window must not turn a successful conversion into a failure.
    try { onProgress({ name: path.basename(source), path: source, phase, progress, ...(error ? { error } : {}) }); } catch {}
  };

  function run(executable, args, { timeout = 30000, onOutput } = {}) {
    checkOpen();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
      children.add(child);
      let output = '';
      let errorOutput = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
      child.stdout.on('data', chunk => {
        const text = chunk.toString();
        if (onOutput) onOutput(text);
        else output = (output + text).slice(-4 * 1024 * 1024);
      });
      child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-16384); });
      child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        children.delete(child);
        if (closed) reject(new Error('Media preparation stopped because Prism Live is closing.'));
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
          thumbnailPath: thumbnail?.isFile() && thumbnail.size > 0 ? thumbnailPath : null };
      }
    } catch { /* Missing or interrupted cache entries are rebuilt from the original. */ }
    return null;
  }

  async function makeThumbnail(source, key) {
    const destination = path.join(cacheDirectory, `${key}.jpg`);
    const current = await fs.stat(destination).catch(() => null);
    if (current?.isFile() && current.size > 0) return destination;
    await fs.mkdir(cacheDirectory, { recursive: true });
    const temporary = path.join(cacheDirectory, `${key}.${randomUUID()}.part.jpg`);
    try {
      const { ffmpeg } = await tools();
      const encode = position => run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-ss', position, '-i', source, '-frames:v', '1', '-vf', 'scale=160:-2', '-q:v', '3', '-f', 'image2', temporary], { timeout: 60000 });
      try { await encode('0.5'); }
      catch { await fs.unlink(temporary).catch(() => {}); await encode('0'); }
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

  async function close() {
    closed = true;
    for (const child of children) child.kill();
    await Promise.allSettled([...pending.values()]);
  }

  return { prepare, thumbnail, close };
}

module.exports = { createMediaConverter, discoverExecutable, cacheKey, sourceHasAlpha };
