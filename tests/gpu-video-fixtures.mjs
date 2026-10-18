// HAP test media: FFmpeg encodes Hap, Hap Alpha and Hap Q. Hap Q Alpha and
// Hap Alpha-Only (which FFmpeg cannot encode) are assembled from a Hap Q
// movie plus generated RGTC1 alpha planes, in a minimal QuickTime file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { demuxMovie } from '../src/gpu-video/mov.js';

const execute = promisify(execFile);

export async function encode(ffmpeg, destination, { width = 128, height = 72, fps = 10, seconds = 1.2, format = 'hap', chunks = 1, compressor = 'snappy', alpha = false } = {}) {
  const source = `testsrc2=s=${width}x${height}:r=${fps}:d=${seconds},format=rgba${alpha ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*X/${width - 1}'` : ''}`;
  await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', source,
    '-c:v', 'hap', '-format', format, '-chunks', String(chunks), '-compressor', compressor, destination], { windowsHide: true });
  return destination;
}

// Every frame decoded by FFmpeg, as one RGBA buffer per frame.
export async function referenceFrames(ffmpeg, file, width, height) {
  const { stdout } = await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true });
  const size = width * height * 4, frames = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) frames.push(stdout.subarray(offset, offset + size));
  return frames;
}

export async function readMovie(file) {
  const bytes = await readFile(file);
  const movie = await demuxMovie(async (offset, length) => bytes.subarray(offset, offset + length), bytes.length);
  return { bytes, movie, frames: Array.from({ length: movie.count }, (_, i) => bytes.subarray(movie.offsets[i], movie.offsets[i] + movie.sizes[i])) };
}

const box = (type, ...parts) => {
  const body = Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};
const u32 = (...values) => { const buffer = Buffer.alloc(values.length * 4); values.forEach((value, i) => buffer.writeUInt32BE(value >>> 0, i * 4)); return buffer; };
const u16 = (...values) => { const buffer = Buffer.alloc(values.length * 2); values.forEach((value, i) => buffer.writeUInt16BE(value & 0xffff, i * 2)); return buffer; };
const matrix = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

// A single-chunk QuickTime movie holding `frames` as one video track.
export function writeMovie(frames, { fourcc, width, height, fps }) {
  const timescale = fps * 100, delta = 100, duration = frames.length * delta;
  const ftyp = box('ftyp', 'qt  ', u32(0x200), 'qt  ');
  const mdat = box('mdat', ...frames);
  const firstFrame = ftyp.length + 8;
  const entry = Buffer.concat([u32(86), Buffer.from(fourcc, 'latin1'), Buffer.alloc(6), u16(1), u16(0, 0), u32(0, 0, 0), u16(width, height),
    u32(72 << 16, 72 << 16, 0), u16(1), Buffer.alloc(32), u16(24, 0xffff)]);
  let offset = firstFrame;
  const stbl = box('stbl', box('stsd', u32(0, 1), entry), box('stts', u32(0, 1, frames.length, delta)), box('stsc', u32(0, 1, 1, frames.length, 1)),
    box('stsz', u32(0, 0, frames.length), ...frames.map(frame => u32(frame.length))), box('stco', u32(0, 1, offset)));
  offset += frames.reduce((sum, frame) => sum + frame.length, 0);
  const minf = box('minf', box('vmhd', u32(1), u16(0, 0, 0, 0)), box('hdlr', u32(0), 'dhlr', 'alis', u32(0, 0, 0), Buffer.from([0])),
    box('dinf', box('dref', u32(0, 1), box('alis', u32(1)))), stbl);
  const mdia = box('mdia', box('mdhd', u32(0, 0, 0, timescale, duration), u16(0, 0)), box('hdlr', u32(0), 'mhlr', 'vide', u32(0, 0, 0), Buffer.from([0])), minf);
  const tkhd = box('tkhd', u32(3, 0, 0, 1, 0, duration, 0, 0), u16(0, 0, 0, 0), matrix, u32(width << 16, height << 16));
  const mvhd = box('mvhd', u32(0, 0, 0, 1000, Math.round(duration / timescale * 1000), 0x10000), u16(0x100), Buffer.alloc(10), matrix, Buffer.alloc(24), u32(2));
  return Buffer.concat([ftyp, mdat, box('moov', mvhd, box('trak', tkhd, mdia))]);
}

// HAP section with the long (8-byte) header.
const section = (type, payload) => { const header = Buffer.alloc(8); header.writeUInt8(type, 3); header.writeUInt32LE(payload.length, 4); return Buffer.concat([header, payload]); };

// RGTC1 blocks whose endpoints vary per block and whose indices vary per
// pixel, with the exact values the format defines.
export function alphaPlane(width, height) {
  const blocksX = Math.ceil(width / 4), blocksY = Math.ceil(height / 4);
  const blocks = Buffer.alloc(blocksX * blocksY * 8), values = new Uint8Array(width * height);
  for (let by = 0; by < blocksY; by++) for (let bx = 0; bx < blocksX; bx++) {
    const block = (by * blocksX + bx) * 8, r0 = 255 - ((bx * 23 + by * 11) % 96), r1 = (bx * 7 + by * 29) % 64;
    blocks[block] = r0; blocks[block + 1] = r1;
    let bits = 0n;
    for (let pixel = 0; pixel < 16; pixel++) {
      const index = (pixel + bx + by) % 8;
      bits |= BigInt(index) << BigInt(pixel * 3);
      const x = bx * 4 + (pixel & 3), y = by * 4 + (pixel >> 2);
      const value = index === 0 ? r0 : index === 1 ? r1 : ((8 - index) * r0 + (index - 1) * r1) / 7;
      if (x < width && y < height) values[y * width + x] = Math.round(value);
    }
    for (let i = 0; i < 6; i++) blocks[block + 2 + i] = Number((bits >> BigInt(i * 8)) & 0xffn);
  }
  return { blocks, values };
}

// DXV high quality frames (YCG6, or YG10 with alpha), which FFmpeg cannot
// encode. Every block is a literal (opcode 3); the luma opcodes are stored
// raw and the chroma opcodes as a fill, the two simple opcode encodings.
// Chroma is constant over 16x16 pixels so its upsampling is unambiguous.
export function dxvHighQualityFrame(format, width, height, seed) {
  const codedWidth = Math.ceil(width / 16) * 16, codedHeight = Math.ceil(height / 4) * 4;
  const blocksX = codedWidth / 4, blocksY = codedHeight / 4;
  const bc4 = (r0, r1, pattern) => {
    const block = Buffer.alloc(8);
    block[0] = r0; block[1] = r1;
    let bits = 0n;
    for (let pixel = 0; pixel < 16; pixel++) bits |= BigInt((pixel + pattern) % 8) << BigInt(pixel * 3);
    for (let i = 0; i < 6; i++) block[2 + i] = Number((bits >> BigInt(i * 8)) & 0xffn);
    return block;
  };
  const flat = value => Buffer.from([value, value, 0, 0, 0, 0, 0, 0]);
  const luma = [];
  for (let by = 0; by < blocksY; by++) for (let bx = 0; bx < blocksX; bx++) {
    const y = bc4(40 + (bx * 13 + by * 7 + seed * 5) % 180, 20 + (bx * 3 + by * 11) % 60, bx + by + seed);
    luma.push(format === 'YG10' ? Buffer.concat([y, bc4(255 - (bx * 9 + by * 5) % 200, (by * 17) % 50, bx + seed)]) : y);
  }
  const chroma = [];
  for (let by = 0; by < blocksY / 2 >> 0; by++) for (let bx = 0; bx < blocksX / 2; bx++) {
    const cell = (bx >> 1) * 3 + (by >> 1) * 5 + seed;
    chroma.push(Buffer.concat([flat(128 + (cell * 37 % 90) - 45), flat(128 + (cell * 53 % 70) - 35)]));
  }
  const stream = (blocks, ops) => {
    const data = Buffer.concat(blocks.map(block => Buffer.from(block)));
    const sizes = ops.map(op => op.count), header = Buffer.alloc(4 + 4 * sizes.length);
    header.writeUInt32LE(header.length + data.length, 0);
    sizes.forEach((size, i) => header.writeUInt32LE(size, 4 + i * 4));
    return Buffer.concat([header, data, ...ops.map(op => op.fill ? Buffer.from([1, 3]) : Buffer.concat([Buffer.from([0]), Buffer.alloc(op.count, 3)]))]);
  };
  // Y: the first 8-byte block, then one literal per block. YG10 and CoCg
  // interleave two block streams after a 16-byte start.
  const yStream = format === 'YCG6' ? stream(luma, [{ count: luma.length - 1 }])
    : stream(luma, [{ count: luma.length - 1 }, { count: luma.length - 1 }]);
  const body = Buffer.concat([yStream, stream(chroma, [{ count: chroma.length - 1, fill: true }, { count: chroma.length - 1, fill: true }])]);
  const header = Buffer.alloc(12);
  header.write(format.split('').reverse().join(''), 0, 'latin1');
  header.set([4, 0, 0, 0], 4);
  header.writeUInt32LE(body.length, 8);
  return Buffer.concat([header, body]);
}

export const writeDxvMovie = (frames, options) => writeMovie(frames, { ...options, fourcc: 'DXD3' });

// Hap Q Alpha from a Hap Q movie, and Hap Alpha-Only from its alpha plane.
export async function composeAlphaMovies(hapQ, directory) {
  const { movie, frames } = await readMovie(hapQ);
  const { blocks, values } = alphaPlane(movie.width, movie.height);
  const options = { width: movie.width, height: movie.height, fps: Math.round(movie.frameRate) };
  const qAlpha = path.join(directory, 'hap_q_alpha.mov'), matte = path.join(directory, 'hap_alpha_only.mov');
  await writeFile(qAlpha, writeMovie(frames.map(frame => section(0x0D, Buffer.concat([frame, section(0xA1, blocks)]))), { ...options, fourcc: 'HapM' }));
  await writeFile(matte, writeMovie(frames.map(() => section(0xA1, blocks)), { ...options, fourcc: 'HapA' }));
  return { qAlpha, matte, alpha: values };
}