// HAP frame decoding (https://github.com/Vidvox/hap/blob/master/documentation/HapVideoDRAFT.md).
// A frame is one texture section, or a 0x0D section holding several (Hap Q
// Alpha: YCoCg DXT5 plus an RGTC1 alpha plane). Each texture is stored raw,
// Snappy-compressed, or split into independently compressed chunks. The
// result is the GPU block data itself; nothing is expanded to RGBA here.
import { snappyDecompress, snappyLength } from './snappy.js';

export const TEXTURE_FORMATS = { 0xB: 'dxt1', 0xE: 'dxt5', 0xF: 'ycocg', 0xC: 'bc7', 0x1: 'bc4', 0x2: 'bc6u', 0x3: 'bc6s' };
export const BLOCK_BYTES = { dxt1: 8, dxt5: 16, ycocg: 16, bc7: 16, bc4: 8, bc6u: 16, bc6s: 16 };
export const HAP_CODECS = { Hap1: 'Hap', Hap5: 'Hap Alpha', HapY: 'Hap Q', HapM: 'Hap Q Alpha', HapA: 'Hap Alpha-Only', Hap7: 'Hap R', HapH: 'Hap HDR' };
export const hapHasAlpha = fourcc => fourcc === 'Hap5' || fourcc === 'HapM' || fourcc === 'Hap7';

export const textureBytes = (format, width, height) => Math.ceil(width / 4) * Math.ceil(height / 4) * BLOCK_BYTES[format];

function section(bytes, offset, limit) {
  if (offset + 4 > limit) throw new Error('Truncated HAP section.');
  let size = bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16, header = 4;
  const type = bytes[offset + 3];
  if (size === 0) {
    if (offset + 8 > limit) throw new Error('Truncated HAP section.');
    size = (bytes[offset + 4] | bytes[offset + 5] << 8 | bytes[offset + 6] << 16 | bytes[offset + 7] << 24) >>> 0;
    header = 8;
  }
  const start = offset + header, end = start + size;
  if (end > limit) throw new Error('Truncated HAP section.');
  return { type, start, end };
}

const u32 = (bytes, offset) => (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;

function chunked(bytes, start, end, output) {
  const instructions = section(bytes, start, end);
  if (instructions.type !== 0x01) throw new Error('HAP chunk instructions are missing.');
  let compressors = null, sizes = null, offsets = null;
  for (let offset = instructions.start; offset < instructions.end;) {
    const part = section(bytes, offset, instructions.end), length = part.end - part.start;
    if (part.type === 0x02) compressors = bytes.subarray(part.start, part.end);
    else if (part.type === 0x03) sizes = Array.from({ length: length >> 2 }, (_, i) => u32(bytes, part.start + i * 4));
    else if (part.type === 0x04) offsets = Array.from({ length: length >> 2 }, (_, i) => u32(bytes, part.start + i * 4));
    offset = part.end;
  }
  if (!compressors || !sizes || sizes.length !== compressors.length || (offsets && offsets.length !== sizes.length)) throw new Error('HAP chunk table is damaged.');
  let source = instructions.end, written = 0;
  for (let i = 0; i < sizes.length; i++) {
    const from = offsets ? instructions.end + offsets[i] : source, to = from + sizes[i];
    source += sizes[i];
    if (to > end) throw new Error('HAP chunk is truncated.');
    if (compressors[i] === 0x0B) written += snappyDecompress(bytes, from, to, output, written);
    else if (compressors[i] === 0x0A) {
      if (written + sizes[i] > output.length) throw new Error('HAP chunk is larger than its texture.');
      output.set(bytes.subarray(from, to), written);
      written += sizes[i];
    } else throw new Error(`Unsupported HAP chunk compressor 0x${compressors[i].toString(16)}.`);
  }
  return written;
}

function texture(bytes, part, width, height) {
  const format = TEXTURE_FORMATS[part.type & 0x0F], compressor = part.type & 0xF0;
  if (!format) throw new Error(`Unsupported HAP texture format 0x${(part.type & 0x0F).toString(16)}.`);
  const expected = textureBytes(format, width, height);
  let data;
  if (compressor === 0xA0) {
    if (part.end - part.start < expected) throw new Error('HAP texture is truncated.');
    data = new Uint8Array(bytes.subarray(part.start, part.start + expected));
  } else if (compressor === 0xB0) {
    data = new Uint8Array(Math.max(expected, snappyLength(bytes, part.start, part.end).length));
    if (snappyDecompress(bytes, part.start, part.end, data) < expected) throw new Error('HAP texture is truncated.');
  } else if (compressor === 0xC0) {
    data = new Uint8Array(expected);
    if (chunked(bytes, part.start, part.end, data) < expected) throw new Error('HAP texture is truncated.');
  } else throw new Error(`Unsupported HAP compressor 0x${compressor.toString(16)}.`);
  return { format, data: data.length === expected ? data : data.slice(0, expected) };
}

export function decodeHapFrame(bytes, width, height) {
  const top = section(bytes, 0, bytes.length);
  if (top.type !== 0x0D) return [texture(bytes, top, width, height)];
  const textures = [];
  for (let offset = top.start; offset < top.end;) {
    const part = section(bytes, offset, top.end);
    textures.push(texture(bytes, part, width, height));
    offset = part.end;
  }
  if (!textures.length) throw new Error('HAP frame has no textures.');
  return textures;
}

// RGTC1/BC4 to one byte per pixel, for drivers without EXT_texture_compression_rgtc.
// A BC5 texture holds two BC4 blocks per 16 bytes (blockBytes 16, offset 0 or 8).
export function decodeBC4(data, width, height, blockBytes = 8, offset = 0) {
  const blocksX = Math.ceil(width / 4), blocksY = Math.ceil(height / 4), stride = blocksX * 4;
  const output = new Uint8Array(stride * blocksY * 4), palette = new Uint8Array(8);
  for (let by = 0, block = offset; by < blocksY; by++) for (let bx = 0; bx < blocksX; bx++, block += blockBytes) {
    const r0 = data[block], r1 = data[block + 1];
    palette[0] = r0; palette[1] = r1;
    if (r0 > r1) for (let k = 1; k < 7; k++) palette[k + 1] = ((7 - k) * r0 + k * r1 + 3) / 7 | 0;
    else { for (let k = 1; k < 5; k++) palette[k + 1] = ((5 - k) * r0 + k * r1 + 2) / 5 | 0; palette[6] = 0; palette[7] = 255; }
    const low = data[block + 2] | data[block + 3] << 8 | data[block + 4] << 16, high = data[block + 5] | data[block + 6] << 8 | data[block + 7] << 16;
    for (let pixel = 0; pixel < 16; pixel++) {
      const index = pixel < 8 ? (low >> (pixel * 3)) & 7 : (high >> ((pixel - 8) * 3)) & 7;
      output[(by * 4 + (pixel >> 2)) * stride + bx * 4 + (pixel & 3)] = palette[index];
    }
  }
  return output;
}
