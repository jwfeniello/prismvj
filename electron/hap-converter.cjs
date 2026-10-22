// HAP converter (main process): PrismVJ's equivalent of Resolume Alley's
// convert queue, aimed at HAP. Probes sources (files, folders, image
// sequences), detects whether a clip really uses transparency, and encodes to
// HAP / HAP Alpha / HAP Q with FFmpeg in a parallel queue with progress,
// cancel and "convert first". Paths come from the renderer and are validated;
// a source is never overwritten and partial output never replaces a file.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { discoverExecutable, sourceHasAlpha } = require('./media-converter.cjs');
const { findImageSequence, validateImageSequence, imageSequenceFramePath } = require('./image-sequence.cjs');

const VIDEO_EXTENSIONS = new Set(['mov', 'mp4', 'm4v', 'avi', 'mkv', 'webm', 'mxf', 'mpg', 'mpeg', 'wmv', 'flv', 'ts', 'mts', 'm2ts', 'gif', 'ogv', 'dv', '3gp', 'y4m']);
const FORMATS = Object.freeze({ hap: { codec: 'hap', label: 'HAP', alpha: false }, hap_alpha: { codec: 'hap_alpha', label: 'HAP Alpha', alpha: true }, hap_q: { codec: 'hap_q', label: 'HAP Q', alpha: false } });
const MAX_FOLDER_FILES = 500, PROBE_TIMEOUT = 20000, MAX_DIMENSION = 8192;
// Short codec names for the file list (FFmpeg's long names are unwieldy).
const CODEC_NAMES = { h264: 'H.264', hevc: 'H.265 / HEVC', prores: 'Apple ProRes', hap: 'HAP', dxv: 'DXV', qtrle: 'Animation', png: 'PNG', mjpeg: 'Motion JPEG', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', dnxhd: 'DNxHD / DNxHR', cfhd: 'CineForm', rawvideo: 'Uncompressed', gif: 'GIF', tiff: 'TIFF', exr: 'OpenEXR', dpx: 'DPX', targa: 'TGA', wmv3: 'WMV', v210: 'Uncompressed 10-bit', ffv1: 'FFV1', utvideo: 'Ut Video' };

const finite = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
const multipleOf4 = value => Math.max(4, Math.round(value / 4) * 4);

function run(executable, args, { timeout = PROBE_TIMEOUT, onStdout, encoding = 'utf8', maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('FFmpeg took too long.')); }, timeout);
    child.stdout.on('data', chunk => {
      if (onStdout) { if (onStdout(chunk, child) === false) child.kill(); return; }
      size += chunk.length; if (size > maxBytes) { child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const output = encoding === 'buffer' ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding);
      if (code === 0 || onStdout) resolve(output); else reject(new Error(stderr.trim().split(/\r?\n/).slice(-2).join(' ') || `FFmpeg exited with ${code}.`));
    });
  });
}

function parseRate(value) {
  const [a, b] = String(value || '').split('/').map(Number);
  const rate = b ? a / b : a;
  return Number.isFinite(rate) && rate > 0 && rate < 1000 ? Math.round(rate * 1000) / 1000 : 0;
}

// FFmpeg input arguments for a source (a file or an image sequence).
function inputArgs(source, { start = 0, duration = 0 } = {}) {
  const seek = start > 0 ? ['-ss', String(start)] : [];
  const length = duration > 0 ? ['-t', String(duration)] : [];
  if (source.kind === 'sequence') {
    const sequence = validateImageSequence(source.sequence);
    return [...seek, '-framerate', String(finite(source.fps, 25, 1, 240)), '-start_number', String(sequence.start), '-i', path.join(sequence.directory, sequence.pattern), ...length];
  }
  return [...seek, '-i', source.path, ...length];
}

// Video filter chain: optional fps, size (fit / fill / stretch) and HAP's
// multiple-of-4 frame size, ending in RGBA for the encoder.
function filterChain({ width, height }, settings, alpha) {
  const filters = [];
  if (settings.fps > 0) filters.push(`fps=${settings.fps}`);
  const pad = alpha ? 'black@0' : 'black';
  if (settings.size?.mode === 'custom') {
    const w = multipleOf4(finite(settings.size.width, width, 4, MAX_DIMENSION)), h = multipleOf4(finite(settings.size.height, height, 4, MAX_DIMENSION));
    filters.push('format=rgba');
    if (settings.scaling === 'fill') filters.push(`scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${w}:${h}`);
    else if (settings.scaling === 'stretch') filters.push(`scale=${w}:${h}:flags=lanczos`, 'setsar=1');
    else filters.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${pad}`);
  } else {
    filters.push('format=rgba');
    if (width % 4 || height % 4) filters.push(`pad=ceil(iw/4)*4:ceil(ih/4)*4:(ow-iw)/2:(oh-ih)/2:color=${pad}`);
  }
  filters.push('setsar=1', 'format=rgba');
  return [...new Set(filters)].join(',');
}

function outputSize({ width, height }, settings) {
  if (settings.size?.mode === 'custom') return { width: multipleOf4(finite(settings.size.width, width, 4, MAX_DIMENSION)), height: multipleOf4(finite(settings.size.height, height, 4, MAX_DIMENSION)) };
  return { width: Math.ceil(width / 4) * 4, height: Math.ceil(height / 4) * 4 };
}

// Which HAP flavour a job encodes to. "auto" follows the detected alpha.
function resolveFormat(format, alpha) {
  if (format === 'auto') return alpha === 'used' ? 'hap_alpha' : 'hap';
  if (format === 'auto_q') return alpha === 'used' ? 'hap_alpha' : 'hap_q';
  return FORMATS[format] ? format : 'hap';
}

function normalizeSettings(value = {}) {
  const size = value.size?.mode === 'custom' ? { mode: 'custom', width: finite(value.size.width, 1920, 4, MAX_DIMENSION), height: finite(value.size.height, 1080, 4, MAX_DIMENSION) } : { mode: 'source' };
  const output = ['beside', 'subfolder', 'folder'].includes(value.output?.mode) ? value.output.mode : 'beside';
  return {
    format: ['auto', 'auto_q', 'hap', 'hap_alpha', 'hap_q'].includes(value.format) ? value.format : 'auto',
    size, scaling: ['fit', 'fill', 'stretch'].includes(value.scaling) ? value.scaling : 'fit',
    fps: [0, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60].includes(Number(value.fps)) ? Number(value.fps) : 0,
    trim: { start: finite(value.trim?.start, 0, 0, 86400), end: finite(value.trim?.end, 0, 0, 86400) },
    audio: { enabled: value.audio?.enabled !== false, sampleRate: [0, 44100, 48000, 96000].includes(Number(value.audio?.sampleRate)) ? Number(value.audio.sampleRate) : 0, bitDepth: Number(value.audio?.bitDepth) === 24 ? 24 : 16 },
    output: { mode: output, folder: typeof value.output?.folder === 'string' ? value.output.folder.slice(0, 4096) : '', label: typeof value.output?.label === 'string' ? value.output.label.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 60) : '' },
    fileName: typeof value.fileName === 'string' ? value.fileName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 120) : '',
    chunks: finite(value.chunks, 0, 0, 64),
  };
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

// Where a job writes. Never the source itself; numbered on conflicts.
async function outputPath(item, settings, format, taken = new Set()) {
  const sourcePath = item.source.kind === 'sequence' ? item.source.sequence.directory : item.source.path;
  const base = settings.fileName || (item.source.kind === 'sequence' ? path.basename(sourcePath) : path.basename(sourcePath, path.extname(sourcePath)));
  const label = settings.output.label || FORMATS[format].label;
  let directory = path.dirname(sourcePath), name = `${base} (${label})`;
  if (item.source.kind === 'sequence') directory = path.dirname(sourcePath);
  if (settings.output.mode === 'subfolder') { directory = path.join(directory, label); name = base; }
  if (settings.output.mode === 'folder') {
    if (!path.isAbsolute(settings.output.folder)) throw new Error('Choose an output folder.');
    directory = settings.output.folder; name = base;
  }
  if (settings.fileName) name = settings.fileName.replace(/\.mov$/i, '');
  for (let index = 1; index < 1000; index++) {
    const candidate = path.join(directory, `${name}${index > 1 ? ` ${index}` : ''}.mov`);
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (path.resolve(candidate).toLowerCase() === path.resolve(sourcePath).toLowerCase() || taken.has(key) || await exists(candidate)) continue;
    taken.add(key);
    return candidate;
  }
  throw new Error('Could not find a free output file name.');
}

function encodeArgs(item, settings, format, destination) {
  const start = settings.trim.start, end = settings.trim.end;
  const duration = end > start ? end - start : 0;
  const alpha = FORMATS[format].alpha;
  // Chunks let PrismVJ decode each frame on several workers; they do not change encode speed.
  const chunks = settings.chunks || 8;
  const audio = settings.audio.enabled && item.hasAudio && item.source.kind !== 'sequence';
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats',
    ...inputArgs(item.source, { start, duration }),
    '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : []),
    '-vf', filterChain(item, settings, alpha),
    '-c:v', 'hap', '-format', FORMATS[format].codec, '-chunks', String(chunks), '-compressor', 'snappy',
    ...(audio ? ['-c:a', settings.audio.bitDepth === 24 ? 'pcm_s24le' : 'pcm_s16le', ...(settings.audio.sampleRate ? ['-ar', String(settings.audio.sampleRate)] : [])] : ['-an']),
    '-map_metadata', '-1', '-f', 'mov', destination,
  ];
}
// ---------------------------------------------------------------- converter

function createHapConverter({ cacheDirectory, resourcesPath = '', env = process.env, onUpdate = () => {} } = {}) {
  if (typeof cacheDirectory !== 'string' || !cacheDirectory) throw new TypeError('The HAP converter needs a cache folder.');
  let toolsPromise = null;
  const tools = () => toolsPromise ||= Promise.all([discoverExecutable('ffmpeg', { env, resourcesPath }), discoverExecutable('ffprobe', { env, resourcesPath })])
    .then(([ffmpeg, ffprobe]) => ({ ffmpeg, ffprobe })).catch(error => { toolsPromise = null; throw error; });
  const items = new Map();
  const jobs = [];
  const running = new Map();
  const previews = new Map();
  // Two or three encoders saturate a 16-core CPU (see pump()).
  const concurrency = os.cpus().length >= 24 ? 3 : os.cpus().length >= 8 ? 2 : 1;
  let closed = false;

  const sourcePath = item => item.source.kind === 'sequence' ? imageSequenceFramePath(item.source.sequence, 0) : item.source.path;

  // Real transparency, not just an alpha channel: sample a few frames per
  // second at low resolution and look for any alpha below 255 (converted to
  // 8-bit first: 10-bit ProRes 4444 alpha would otherwise read up to 1023).
  async function alphaInUse(item, ffmpeg) {
    let pending = '', inspected = 0, transparent = false;
    const onStdout = chunk => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const match = /^lavfi\.signalstats\.YMIN=(\d+)$/.exec(line);
        if (match) { inspected++; if (Number(match[1]) < 255) transparent = true; }
      }
      return !transparent;
    };
    const measure = 'scale=160:-2:flags=neighbor,format=rgba,alphaextract,signalstats,metadata=print:key=lavfi.signalstats.YMIN:file=-';
    if (item.source.kind === 'file' && item.duration > 20) {
      // Long clips: seek to 24 evenly spaced frames instead of decoding everything.
      const points = Array.from({ length: 24 }, (_, index) => (item.duration - 0.1) * (index + 0.5) / 24);
      const inputs = points.flatMap(time => ['-ss', time.toFixed(3), '-i', item.source.path]);
      const graph = points.map((_, index) => `[${index}:v:0]trim=end_frame=1,setpts=PTS-STARTPTS,${measure.replace(',metadata=print:key=lavfi.signalstats.YMIN:file=-', '')}[s${index}]`).join(';')
        + `;${points.map((_, index) => `[s${index}]`).join('')}concat=n=${points.length}:v=1:a=0,metadata=print:key=lavfi.signalstats.YMIN:file=-[out]`;
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputs, '-filter_complex', graph, '-map', '[out]', '-an', '-f', 'null', '-'], { timeout: 5 * 60 * 1000, onStdout });
      return inspected ? transparent : false;
    }
    const sampleRate = item.duration > 10 ? 2 : 6;
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputArgs(item.source), '-map', '0:v:0',
      '-vf', `fps=${sampleRate},${measure}`, '-an', '-f', 'null', '-'], { timeout: 10 * 60 * 1000, onStdout });
    return inspected ? transparent : false;
  }

  async function thumbnail(item, ffmpeg, seconds = 0) {
    const at = Math.max(0, Math.min(seconds || Math.min(1, (item.duration || 0) * 0.25), Math.max(0, (item.duration || 0) - 0.05)));
    const image = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputArgs(item.source, { start: at }), '-frames:v', '1',
      '-vf', 'scale=480:-2:flags=bilinear', '-f', 'image2pipe', '-c:v', item.alpha === 'used' ? 'png' : 'mjpeg', '-q:v', '4', 'pipe:1'], { encoding: 'buffer', maxBytes: 4 * 1024 * 1024 });
    return image.length ? `data:${item.alpha === 'used' ? 'image/png' : 'image/jpeg'};base64,${image.toString('base64')}` : null;
  }

  async function describe(source) {
    const { ffmpeg, ffprobe } = await tools();
    const target = source.kind === 'sequence' ? imageSequenceFramePath(source.sequence, 0) : source.path;
    const probe = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', target]));
    const video = probe.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    if (!video) throw new Error('No video stream.');
    const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
    const stat = source.kind === 'sequence' ? null : await fs.stat(source.path);
    const fps = source.kind === 'sequence' ? source.fps : parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate);
    const duration = source.kind === 'sequence' ? source.sequence.count / source.fps : Number(probe.format?.duration) || Number(video.duration) || 0;
    const item = {
      id: randomUUID(), source,
      name: source.kind === 'sequence' ? path.basename(source.sequence.directory) : path.basename(source.path),
      codec: CODEC_NAMES[video.codec_name] || String(video.codec_long_name || video.codec_name || '').replace(/\s*\(.*\)$/, '').slice(0, 40), codecName: video.codec_name,
      profile: video.profile || '', width: Number(video.width) || 0, height: Number(video.height) || 0, fps, duration,
      frames: source.kind === 'sequence' ? source.sequence.count : Math.round(duration * fps), bytes: stat?.size || 0,
      hasAudio: !!audio, audio: audio ? { codec: audio.codec_name, rate: Number(audio.sample_rate) || 0, channels: audio.channels || 0 } : null,
      pixFmt: video.pix_fmt || '', alpha: sourceHasAlpha(video) || /hap_alpha|dxv/i.test(`${video.codec_tag_string} ${video.codec_name}`) ? 'channel' : 'none',
      thumbnail: null, modified: stat?.mtimeMs || 0,
    };
    if (!item.width || !item.height) throw new Error('Unknown frame size.');
    if (item.alpha === 'channel') { try { if (await alphaInUse(item, ffmpeg)) item.alpha = 'used'; } catch { /* keep: channel */ } }
    try { item.thumbnail = await thumbnail(item, ffmpeg); } catch { item.thumbnail = null; }
    items.set(item.id, item);
    return item;
  }

  async function sourcesFor(target, depth = 0) {
    const absolute = path.resolve(target);
    const stat = await fs.stat(absolute);
    if (stat.isFile()) {
      const extension = path.extname(absolute).slice(1).toLowerCase();
      if (VIDEO_EXTENSIONS.has(extension)) return [{ kind: 'file', path: absolute }];
      const sequence = await findImageSequence(absolute).catch(() => null);
      return sequence ? [{ kind: 'sequence', sequence, fps: 25 }] : [];
    }
    if (!stat.isDirectory()) return [];
    const sequence = await findImageSequence(absolute).catch(() => null);
    const sources = sequence ? [{ kind: 'sequence', sequence, fps: 25 }] : [];
    if (depth > 2) return sources;
    let entries = [];
    try { entries = (await fs.readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); } catch { return sources; }
    for (const entry of entries) {
      if (sources.length >= MAX_FOLDER_FILES || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(absolute, entry.name);
      if (entry.isDirectory()) sources.push(...await sourcesFor(full, depth + 1));
      else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).slice(1).toLowerCase())) sources.push({ kind: 'file', path: full });
    }
    return sources.slice(0, MAX_FOLDER_FILES);
  }

  // Files, folders and image sequences -> described items (errors per item).
  async function add(targets) {
    const list = (Array.isArray(targets) ? targets : []).filter(target => typeof target === 'string' && path.isAbsolute(target) && !target.includes('\0')).slice(0, MAX_FOLDER_FILES);
    const sources = [];
    for (const target of list) { try { sources.push(...await sourcesFor(target)); } catch (error) { sources.push({ kind: 'error', path: target, error: error.message }); } }
    const described = [];
    for (const source of sources.slice(0, MAX_FOLDER_FILES)) {
      if (source.kind === 'error') { described.push({ id: randomUUID(), name: path.basename(source.path), error: source.error }); continue; }
      try { described.push(await describe(source)); }
      catch (error) { described.push({ id: randomUUID(), name: path.basename(source.path || source.sequence?.directory || ''), error: error.message.slice(0, 300) }); }
    }
    return described;
  }

  async function frame(id, seconds) {
    const item = items.get(id);
    if (!item) throw new Error('Unknown item.');
    const { ffmpeg } = await tools();
    return thumbnail(item, ffmpeg, finite(seconds, 0, 0, item.duration || 0));
  }

  // A small cached proxy the preview <video> can play: VP9 with alpha for
  // transparent clips, H.264 otherwise. Short GOP so scrubbing is quick.
  async function preview(id) {
    const item = items.get(id);
    if (!item) throw new Error('Unknown item.');
    const key = `${sourcePath(item)}|${item.modified}|${item.alpha}`;
    if (previews.has(key)) return previews.get(key);
    const job = (async () => {
      const { ffmpeg } = await tools();
      await fs.mkdir(cacheDirectory, { recursive: true });
      const alpha = item.alpha === 'used';
      const destination = path.join(cacheDirectory, `${randomUUID()}.preview.${alpha ? 'webm' : 'mp4'}`);
      const video = alpha
        ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '2M', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', '26', '-pix_fmt', 'yuv420p'];
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...inputArgs(item.source, { duration: Math.min(item.duration || 600, 600) }), '-map', '0:v:0',
        '-vf', `scale='min(960,iw)':-2:flags=bilinear${alpha ? ',format=yuva420p' : ''}`, ...video, '-g', '6', '-an', destination], { timeout: 15 * 60 * 1000 });
      return destination;
    })();
    previews.set(key, job);
    job.catch(() => previews.delete(key));
    return job;
  }
  // ------------------------------------------------------------ queue

  const publicJob = job => ({ workers: job.workers || 1, id: job.id, itemId: job.itemId, name: job.name, format: job.format, output: job.output, status: job.status, progress: job.progress, fps: job.fps, speed: job.speed, eta: job.eta, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt, alpha: job.alpha });
  const state = () => ({ jobs: jobs.map(publicJob), running: running.size, concurrency });
  const changed = () => onUpdate(state());

  // jobs: [{ itemId, settings }] -> queued jobs (output names reserved now).
  async function enqueue(requests) {
    const taken = new Set(jobs.filter(job => job.status === 'queued' || job.status === 'running').map(job => process.platform === 'win32' ? job.output.toLowerCase() : job.output));
    const created = [];
    for (const request of (Array.isArray(requests) ? requests : []).slice(0, 2000)) {
      const item = items.get(request?.itemId);
      if (!item) continue;
      const settings = normalizeSettings(request.settings);
      const format = resolveFormat(settings.format, item.alpha);
      try {
        const output = await outputPath(item, settings, format, taken);
        const job = { id: randomUUID(), itemId: item.id, name: item.name, settings, format, alpha: item.alpha, output, status: 'queued', progress: 0, fps: 0, speed: 0, eta: null, error: null, startedAt: null, finishedAt: null, child: null };
        jobs.push(job);
        created.push(publicJob(job));
      } catch (error) {
        created.push({ id: randomUUID(), itemId: item.id, name: item.name, status: 'failed', error: error.message });
      }
    }
    changed();
    pump();
    return created;
  }

  // Measured on a 16-core Ryzen: one FFmpeg HAP encode tops out near 480
  // fps at 1080p with 16 slice threads; two or three side by side reach about
  // 660 fps in total, so jobs run in parallel and share the cores. Splitting
  // one clip into joined segments was frame-exact but slower in practice: the
  // join rewrites the whole output and HAP output is disk-bound.
  const threadsPerWorker = () => Math.max(2, Math.floor(os.cpus().length / concurrency));
  const used = () => [...running.values()].reduce((sum, job) => sum + (job.workers || 1), 0);

  function pump() {
    if (closed) return;
    while (used() < concurrency) {
      const job = jobs.find(entry => entry.status === 'queued');
      if (!job) break;
      job.workers = 1;
      encode(job);
    }
  }

  function trimmedLength(item, settings) {
    const { start, end } = settings.trim;
    return Math.max(0.001, (end > start ? Math.min(end, item?.duration || end) : item?.duration || 0) - start);
  }

  // One FFmpeg run; resolves when it exits cleanly. onTime gets seconds encoded.
  function ffmpegRun(job, ffmpeg, args, onTime) {
    return new Promise((resolve, reject) => {
      // Cancelled before FFmpeg started: never start it.
      if (job.status === 'cancelled') { reject(new Error('Cancelled.')); return; }
      const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      job.children.add(child);
      let stderr = '', pending = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.stdout.on('data', chunk => {
        const lines = (pending + chunk).split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
          if (match) onTime?.(Number(match[1]) / 1e6);
        }
      });
      child.on('error', reject);
      child.on('close', code => {
        job.children.delete(child);
        if (job.status === 'cancelled') reject(new Error('Cancelled.'));
        else if (code === 0) resolve();
        else reject(new Error(stderr.trim().split(/\r?\n/).slice(-2).join(' ') || `FFmpeg exited with ${code}.`));
      });
    });
  }

  async function encode(job) {
    job.status = 'running'; job.startedAt = Date.now(); job.children = new Set();
    running.set(job.id, job);
    changed();
    const item = items.get(job.itemId);
    const stem = path.join(path.dirname(job.output), `.${path.basename(job.output, '.mov')}.${job.id.slice(0, 8)}`);
    const temporary = `${stem}.part.mov`;
    try {
      const { ffmpeg } = await tools();
      await fs.mkdir(path.dirname(job.output), { recursive: true });
      const total = trimmedLength(item, job.settings);
      const threads = String(threadsPerWorker());
      const done = [0];
      let lastUpdate = 0;
      const report = () => {
        job.progress = Math.min(0.999, done.reduce((sum, value) => sum + value, 0) / total);
        const elapsed = (Date.now() - job.startedAt) / 1000;
        job.fps = elapsed > 0 ? Math.round(job.progress * total * (item.fps || 25) / elapsed) : 0;
        job.speed = elapsed > 0 ? Math.round(job.progress * total / elapsed * 10) / 10 : 0;
        job.eta = job.progress > 0.02 ? Math.round(elapsed / job.progress - elapsed) : null;
        if (Date.now() - lastUpdate > 200) { lastUpdate = Date.now(); changed(); }
      };
      const withThreads = args => { const output = args.indexOf('-c:v'); args.splice(output, 0, '-threads', threads); return args; };
      await ffmpegRun(job, ffmpeg, withThreads(encodeArgs(item, job.settings, job.format, temporary)), seconds => { done[0] = seconds; report(); });
      // Keep the output name free right up to the rename.
      if (await exists(job.output)) job.output = await outputPath(item, job.settings, job.format, new Set());
      await fs.rename(temporary, job.output);
      job.status = 'done'; job.progress = 1; job.eta = 0;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      if (job.status !== 'cancelled') { job.status = 'failed'; job.error = String(error.message).slice(0, 400); }
    } finally {
      job.finishedAt = Date.now();
      running.delete(job.id);
      changed();
      pump();
    }
  }

  function cancel(id) {
    const job = jobs.find(entry => entry.id === id);
    if (!job || job.status === 'done' || job.status === 'failed') return false;
    const wasRunning = job.status === 'running';
    job.status = 'cancelled';
    if (wasRunning) for (const child of job.children || []) child.kill('SIGKILL');
    changed();
    return true;
  }

  // "Queue specific files first": move queued jobs to the front.
  function prioritize(ids) {
    const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
    const front = jobs.filter(job => wanted.has(job.id) && job.status === 'queued');
    const rest = jobs.filter(job => !front.includes(job));
    jobs.splice(0, jobs.length, ...rest.filter(job => job.status !== 'queued'), ...front, ...rest.filter(job => job.status === 'queued'));
    changed();
    pump();
    return front.length;
  }

  function clearFinished() {
    for (let index = jobs.length - 1; index >= 0; index--) if (['done', 'failed', 'cancelled'].includes(jobs[index].status)) jobs.splice(index, 1);
    changed();
  }

  function forget(ids) { for (const id of Array.isArray(ids) ? ids : [ids]) if (!jobs.some(job => job.itemId === id && (job.status === 'queued' || job.status === 'running'))) items.delete(id); return true; }

  async function close() {
    closed = true;
    for (const job of running.values()) { job.status = 'cancelled'; for (const child of job.children || []) child.kill('SIGKILL'); }
    for (const preview of previews.values()) preview.then(file => fs.rm(file, { force: true })).catch(() => {});
  }

  return { add, frame, preview, enqueue, cancel, prioritize, clearFinished, forget, state, close, items };
}

module.exports = { createHapConverter, normalizeSettings, resolveFormat, filterChain, encodeArgs, outputPath, outputSize, FORMATS, VIDEO_EXTENSIONS };