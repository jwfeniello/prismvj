'use strict';

// Image sequence detection for the Electron main process. A folder of
// sequentially numbered stills plays as a single video clip (Resolume manual,
// "Image Sequences"). Detection is pure file-system work; FFmpeg is only used
// when a caller asks for frame size and alpha via `probe`.

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const IMAGE_SEQUENCE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'tga', 'bmp', 'webp', 'exr']);
const MAX_SCAN_ENTRIES = 100000;
const MAX_SEQUENCE_FRAMES = 100000;
const PROBE_SAMPLES = 5;
const PATTERN = /^((?:[^%]|%%)*)%(?:0(\d{1,2}))?d((?:[^%]|%%)*)$/;
// Windows and default macOS volumes are case-insensitive, so `IMG_0001.PNG` and
// `img_0002.png` are one sequence there and FFmpeg opens both through one pattern.
const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function alphaPixelFormat(stream) {
  const format = String(stream?.pix_fmt || '').toLowerCase();
  return /^(rgba|bgra|argb|abgr|yuva|gbrap|ya\d|ayuv|vuya)/.test(format)
    || format === 'pal8' || String(stream?.tags?.alpha_mode || '') === '1';
}

// The last run of digits before the extension is the frame number:
// `shot.0001.png`, `img_1.png`, `v2_take_0010.tif`.
function parseFrameName(name) {
  const match = /^(.*?)(\d{1,15})(\.[A-Za-z0-9]{1,8})$/.exec(name);
  if (!match) return null;
  const extension = match[3].slice(1).toLowerCase();
  if (!IMAGE_SEQUENCE_EXTENSIONS.includes(extension)) return null;
  return { prefix: match[1], digits: match[2], number: Number(match[2]), suffix: match[3], extension };
}

const escapePattern = text => text.replace(/%/g, '%%');

function frameFileName(sequence, number) {
  const match = PATTERN.exec(String(sequence.pattern || ''));
  if (!match) throw new Error('Invalid image sequence pattern.');
  const unescape = text => text.replace(/%%/g, '%');
  return `${unescape(match[1])}${String(number).padStart(Number(match[2] || 1), '0')}${unescape(match[3])}`;
}

/** Absolute path of frame `index` (0-based, counted from `start`) of a sequence. */
function imageSequenceFramePath(sequence, index = 0) {
  return path.join(sequence.directory, frameFileName(sequence, sequence.start + index));
}

// Rejects anything that would make FFmpeg read outside the sequence folder or
// run unbounded. Sequence objects can come back from the renderer over IPC.
function validateImageSequence(sequence) {
  if (!sequence || typeof sequence !== 'object') throw new Error('Expected an image sequence.');
  const { directory, pattern, start, count } = sequence;
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0') || directory.length > 32768) {
    throw new Error('Image sequence folder must be an absolute path.');
  }
  if (typeof pattern !== 'string' || pattern.length > 1024 || /[\\/\0:]/.test(pattern) || !PATTERN.test(pattern)) {
    throw new Error('Image sequence pattern is invalid.');
  }
  const extension = path.extname(pattern.replace(/%%/g, '%')).slice(1).toLowerCase();
  if (!IMAGE_SEQUENCE_EXTENSIONS.includes(extension)) throw new Error(`Unsupported image sequence format: .${extension}`);
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('Image sequence start frame is invalid.');
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SEQUENCE_FRAMES) throw new Error('Image sequence frame count is invalid.');
  return { directory: path.resolve(directory), pattern, start, count, extension };
}

function longestRun(numbers) {
  let best = null;
  let runStart = numbers[0];
  let previous = numbers[0];
  const close = end => {
    const count = end - runStart + 1;
    if (!best || count > best.count) best = { start: runStart, count };
  };
  for (let index = 1; index < numbers.length; index++) {
    if (numbers[index] !== previous + 1) { close(previous); runStart = numbers[index]; }
    previous = numbers[index];
  }
  close(previous);
  return best;
}

function runContaining(numbers, wanted) {
  const set = new Set(numbers);
  if (!set.has(wanted)) return null;
  let start = wanted;
  let end = wanted;
  while (set.has(start - 1)) start--;
  while (set.has(end + 1)) end++;
  return { start, count: end - start + 1 };
}

async function scanDirectory(directory, maxEntries) {
  const names = [];
  const handle = await fs.opendir(directory);
  let seen = 0;
  try {
    for await (const entry of handle) {
      if (++seen > maxEntries) throw new Error(`The folder ${path.basename(directory)} has more than ${maxEntries} entries; image sequence detection stopped.`);
      // One level only: nested folders and links are never followed.
      if (entry.isFile()) names.push(entry.name);
    }
  } finally {
    // for-await already closes the handle; a second close rejects harmlessly.
    await handle.close().catch(() => {});
  }
  return names;
}

function simpleRun(executable, args, { timeout = 20000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '';
    let errorOutput = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-1024 * 1024); });
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-8192); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(errorOutput.trim() || `${path.basename(executable)} exited with code ${code}.`));
    });
  });
}

/**
 * Probe up to five evenly spaced frames for size and alpha. `exec(args)` runs
 * ffprobe with the given arguments and resolves its stdout.
 */
async function probeImageSequence(sequence, exec) {
  const sampleCount = Math.min(PROBE_SAMPLES, sequence.count);
  const samples = [...new Set(Array.from({ length: sampleCount },
    (_, index) => Math.round(index * (sequence.count - 1) / Math.max(1, sampleCount - 1))))];
  let width;
  let height;
  let hasAlpha = false;
  for (const index of samples) {
    const output = await exec(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt,codec_name',
      '-of', 'json', imageSequenceFramePath(sequence, index)]);
    const stream = JSON.parse(output).streams?.[0];
    if (!stream) throw new Error(`Frame ${frameFileName(sequence, sequence.start + index)} is not a readable image.`);
    if (width === undefined) { width = Number(stream.width) || undefined; height = Number(stream.height) || undefined; }
    if (alphaPixelFormat(stream)) hasAlpha = true;
  }
  return { width, height, hasAlpha };
}

/**
 * Detect the image sequence in a folder, or the sequence a numbered still
 * belongs to.
 *
 * - Folder: the longest consecutive numbered run of supported stills wins.
 * - File: the consecutive run containing that file (it need not be the first).
 *
 * Returns null when there is no run of at least two frames. Files that are not
 * supported stills, or not numbered, are ignored. Only one folder level is read
 * and at most `maxEntries` (<= 100000) directory entries are scanned; a larger
 * folder throws instead of returning a partial guess.
 *
 * Result: { directory, pattern, start, count, extension, firstFile,
 *   width?, height?, hasAlpha? } where `pattern` is an FFmpeg image2 pattern
 * relative to `directory` (literal % escaped as %%), `start` the first frame
 * number and `firstFile` the absolute path of that frame. Size and alpha are
 * present only with `probe: true`.
 */
async function findImageSequence(folderOrFirstFile, {
  maxEntries = MAX_SCAN_ENTRIES, probe = false, ffprobe, env = process.env, resourcesPath = '', exec,
} = {}) {
  if (typeof folderOrFirstFile !== 'string' || !folderOrFirstFile || folderOrFirstFile.includes('\0') || folderOrFirstFile.length > 32768) {
    throw new Error('Expected an image sequence folder or frame path.');
  }
  const target = path.resolve(folderOrFirstFile);
  const stat = await fs.stat(target);
  let directory = target;
  let hint = null;
  if (stat.isFile()) {
    directory = path.dirname(target);
    hint = parseFrameName(path.basename(target));
    if (!hint) return null;
  } else if (!stat.isDirectory()) return null;

  const limit = Math.max(1, Math.min(MAX_SCAN_ENTRIES, Math.floor(Number(maxEntries)) || MAX_SCAN_ENTRIES));
  const groups = new Map();
  const normalize = text => caseInsensitive ? text.toLowerCase() : text;
  for (const name of await scanDirectory(directory, limit)) {
    const frame = parseFrameName(name);
    if (!frame) continue;
    const key = `${normalize(frame.prefix)}\0${normalize(frame.suffix)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...frame, name });
  }
  const hintKey = hint ? `${normalize(hint.prefix)}\0${normalize(hint.suffix)}` : null;

  let best = null;
  for (const [key, frames] of groups) {
    if (hint && key !== hintKey) continue;
    // A digit string matches padding width w when String(n).padStart(w, '0')
    // reproduces it; w = 1 is FFmpeg's unpadded `%d`.
    const widths = new Set([1, ...frames.map(frame => frame.digits.length)]);
    for (const width of widths) {
      const byNumber = new Map();
      for (const frame of frames) {
        if (String(frame.number).padStart(width, '0') !== frame.digits) continue;
        const previous = byNumber.get(frame.number);
        // Duplicate numbers (case variants on case-sensitive volumes) keep the first name in sort order.
        if (!previous || frame.name < previous.name) byNumber.set(frame.number, frame);
      }
      if (byNumber.size < 2) continue;
      if (hint && byNumber.get(hint.number)?.digits !== hint.digits) continue;
      const numbers = [...byNumber.keys()].sort((a, b) => a - b);
      const run = hint ? runContaining(numbers, hint.number) : longestRun(numbers);
      if (!run || run.count < 2) continue;
      const first = byNumber.get(run.start);
      const candidate = { ...run, width, first };
      if (!best || candidate.count > best.count
        || (candidate.count === best.count && (candidate.width > best.width
          || (candidate.width === best.width && first.name < best.first.name)))) best = candidate;
    }
  }
  if (!best) return null;
  const sequence = {
    directory,
    pattern: `${escapePattern(best.first.prefix)}${best.width > 1 ? `%0${best.width}d` : '%d'}${escapePattern(best.first.suffix)}`,
    start: best.start,
    count: Math.min(best.count, MAX_SEQUENCE_FRAMES),
    extension: best.first.extension,
    firstFile: path.join(directory, best.first.name),
  };
  if (!probe) return sequence;
  const runner = exec || (async args => {
    const executable = ffprobe || await require('./media-converter.cjs').discoverExecutable('ffprobe', { env, resourcesPath });
    return simpleRun(executable, args, { env });
  });
  return { ...sequence, ...await probeImageSequence(sequence, runner) };
}

module.exports = {
  IMAGE_SEQUENCE_EXTENSIONS,
  MAX_SEQUENCE_FRAMES,
  findImageSequence,
  imageSequenceFramePath,
  validateImageSequence,
  probeImageSequence,
  parseFrameName,
  alphaPixelFormat,
};
