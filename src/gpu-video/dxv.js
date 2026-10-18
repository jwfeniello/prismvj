// Resolume DXV texture decompression, ported from FFmpeg's libavcodec/dxv.c
// and lzf.c:
//   Copyright (C) 2015 Vittorio Giovara <vittorio.giovara@gmail.com>
//   Copyright (C) 2018 Paul B Mahol
// This file is free software; you can redistribute it and/or modify it under
// the terms of the GNU Lesser General Public License as published by the Free
// Software Foundation; either version 2.1 of the License, or (at your option)
// any later version. It is distributed WITHOUT ANY WARRANTY; see the GNU
// Lesser General Public License for details.
//
// Unlike FFmpeg, which expands the textures to RGBA/YUV on the CPU, this
// returns the DXT/BC blocks themselves for upload as compressed textures:
// DXT1 and DXT5 (premultiplied alpha), or for high quality (YCG6/YG10) a
// full-size BC4 luma plane (BC5 luma + alpha for YG10) and a half-size BC5
// CoCg plane.

const tag = text => (text.charCodeAt(0) << 24 | text.charCodeAt(1) << 16 | text.charCodeAt(2) << 8 | text.charCodeAt(3)) >>> 0;
const DXT1 = tag('DXT1'), DXT5 = tag('DXT5'), YCG6 = tag('YCG6'), YG10 = tag('YG10');
const invalid = () => new Error('The DXV frame is damaged.');

// FFmpeg's bytestream2 reader: reads past the end yield zero.
class Reader {
  constructor(bytes, offset, end) { this.bytes = bytes; this.position = offset; this.end = end; }
  get left() { return this.end - this.position; }
  byte() { return this.position < this.end ? this.bytes[this.position++] : (this.position = this.end, 0); }
  u16() {
    if (this.end - this.position < 2) { this.position = this.end; return 0; }
    const b = this.bytes, p = this.position; this.position += 2;
    return b[p] | b[p + 1] << 8;
  }
  u32() {
    if (this.end - this.position < 4) { this.position = this.end; return 0; }
    const b = this.bytes, p = this.position; this.position += 4;
    return (b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24) >>> 0;
  }
  peek() { return this.position < this.end ? this.bytes[this.position] : 0; }
  skip(count) { this.position = Math.min(this.end, this.position + count); }
  seek(position) { this.position = Math.max(0, Math.min(this.end, position)); }
}

const rl16 = (b, p) => b[p] | b[p + 1] << 8;
const rl32 = (b, p) => (b[p] | b[p + 1] << 8 | b[p + 2] << 16 | b[p + 3] << 24) >>> 0;
const wl16 = (b, p, v) => { b[p] = v; b[p + 1] = v >> 8; };
const wl32 = (b, p, v) => { b[p] = v; b[p + 1] = v >> 8; b[p + 2] = v >> 16; b[p + 3] = v >>> 24; };
const hash16 = v => Math.imul(0x9E3779B1, v & 0xFFFF) >>> 24;
const hash24 = (b, p) => Math.imul(0x9E3779B1, rl32(b, p) & 0xFFFFFF) >>> 24;

// Normal quality: 32-bit elements copied from the stream or from earlier
// output, selected by 2-bit opcodes. `step` is 2 for DXT1, 4 for DXT5.
function decompressDxt1(reader, out) {
  const total = out.length;
  let value = 0, state = 0, index = 0, op = 0, pos = 2;
  out[0] = reader.u32(); out[1] = reader.u32();
  const checkpoint = () => {
    if (state === 0) {
      if (reader.left < 4) throw invalid();
      value = reader.u32(); state = 16;
    }
    op = value & 3; value >>>= 2; state--;
    if (op === 1) index = 2;
    else if (op === 2) { index = (reader.byte() + 2) * 2; if (index > pos) throw invalid(); }
    else if (op === 3) { index = (reader.u16() + 0x102) * 2; if (index > pos) throw invalid(); }
  };
  while (pos + 2 <= total) {
    checkpoint();
    if (op) { out[pos] = out[pos - index]; pos++; out[pos] = out[pos - index]; pos++; }
    else {
      checkpoint();
      out[pos] = op ? out[pos - index] : reader.u32(); pos++;
      checkpoint();
      out[pos] = op ? out[pos - index] : reader.u32(); pos++;
    }
  }
}

function decompressDxt5(reader, out) {
  const total = out.length;
  let value = 0, state = 0, index = 0, op = 0, pos = 4, run = 0;
  for (let i = 0; i < 4; i++) out[i] = reader.u32();
  const checkpoint = () => {
    if (state === 0) {
      if (reader.left < 4) throw invalid();
      value = reader.u32(); state = 16;
    }
    op = value & 3; value >>>= 2; state--;
    if (op === 1) index = 4;
    else if (op === 2) { index = (reader.byte() + 2) * 4; if (index > pos) throw invalid(); }
    else if (op === 3) { index = (reader.u16() + 0x102) * 4; if (index > pos) throw invalid(); }
  };
  const copy = from => { out[pos] = out[pos - from]; pos++; out[pos] = out[pos - from]; pos++; };
  while (pos + 2 <= total) {
    if (run) { run--; copy(4); }
    else {
      if (reader.left < 1) throw invalid();
      if (state === 0) { value = reader.u32(); state = 16; }
      op = value & 3; value >>>= 2; state--;
      if (op === 0) {
        // Long copy of whole blocks.
        let count = reader.byte() + 1;
        if (count === 256) { let probe; do { probe = reader.u16(); count += probe; } while (probe === 0xFFFF); }
        while (count && pos + 4 <= total) { copy(4); copy(4); count--; }
        continue;
      }
      if (op === 1) {
        run = reader.byte();
        if (run === 255) { let probe; do { probe = reader.u16(); run += probe; } while (probe === 0xFFFF); }
        copy(4);
      } else if (op === 2) {
        index = 8 + 4 * reader.u16();
        if (index > pos || pos - index + 2 > total) throw invalid();
        copy(index);
      } else { out[pos++] = reader.u32(); out[pos++] = reader.u32(); }
    }
    checkpoint();
    if (pos + 2 > total) throw invalid();
    if (op) {
      if (index > pos || pos - index + 2 > total) throw invalid();
      copy(index);
    } else {
      checkpoint();
      if (op && (index > pos || pos - index + 2 > total)) throw invalid();
      out[pos] = op ? out[pos - index] : reader.u32(); pos++;
      checkpoint();
      out[pos] = op ? out[pos - index] : reader.u32(); pos++;
    }
  }
}

// Old DXV (version 1/2) LZF stream.
function decompressLzf(reader, out) {
  const { bytes, end } = reader;
  let i = reader.position, length = 0;
  while (end - i > 2) {
    const s = bytes[i++];
    if (s < 32) {
      const size = s + 1;
      if (i + size > end) throw invalid();
      out.set(bytes.subarray(i, i + Math.max(0, Math.min(size, out.length - length))), length);
      i += size; length += size;
    } else {
      let size = 2 + (s >> 5);
      const distance = ((s & 0x1f) << 8) + 1 + (size === 9 ? (size += bytes[i++], bytes[i++]) : bytes[i++]);
      if (distance > length) throw invalid();
      for (let from = length - distance, stop = length + size; length < stop; length++, from++) if (length < out.length) out[length] = out[from];
    }
  }
}

// High quality opcode tables: a canonical prefix code over opcodes 0-255.
function fillLengthTable(reader, table) {
  let half = 512, bits = 1023, left = 1024, lshift = 30, rshift = 10, counter = 0;
  let mask = reader.u32() >>> 2;
  while (left) {
    if (counter >= 256) throw invalid();
    const value = bits & mask;
    left = (left - value) >>> 0;
    mask >>>= rshift;
    lshift -= rshift;
    table[counter++] = value;
    if (lshift < 16) {
      if (reader.left <= 0) throw invalid();
      mask = (mask + (reader.u16() << lshift)) >>> 0;
      lshift += 16;
    }
    if (left < half) { half >>= 1; bits >>= 1; rshift--; }
  }
  while (counter > 0 && !table[counter - 1]) counter--;
  if (counter <= 0) throw invalid();
  table.fill(0, counter);
  if (lshift >= 16) reader.seek(reader.position - 2);
  return counter;
}

function fillOpcodeTable(lengths, elements) {
  const sums = new Uint32Array(256), value1 = new Uint8Array(1024), value2 = new Uint8Array(1024), next = new Int16Array(1024);
  sums[0] = lengths[0];
  for (let i = 0; i < elements - 1; i++) sums[i + 1] = lengths[i + 1] + sums[i];
  let k = 0, j = 2, x = 0;
  if (!sums[0]) do { k++; } while (k < 256 && !sums[k]);
  for (let i = 1024; i > 0; i--) {
    value1[x] = k;
    while (k < 256 && j > sums[k]) k++;
    x = (x - 383) & 0x3FF;
    j++;
  }
  sums.fill(0);
  sums.set(lengths.subarray(0, elements));
  for (let i = 0; i < 1024; i++) {
    const symbol = value1[i], count = sums[symbol]++;
    const width = 31 - Math.clz32(count);
    if (width > 10) throw invalid();
    value2[i] = 10 - width;
    next[i] = (count << value2[i]) - 1024;
  }
  return { value1, value2, next };
}

function readOpcodes(reader, lengths, destination, size, elements) {
  const table = fillOpcodeTable(lengths, elements), bytes = reader.bytes, source = reader.position;
  const sizeInBits = reader.u32();
  const endOffset = Math.floor((sizeInBits + 7) / 8) - 4;
  if (endOffset <= 0 || reader.left < endOffset) throw invalid();
  let offset = endOffset, next = rl32(bytes, source + endOffset);
  const rshift = (((sizeInBits & 0xFF) - 1) & 7) + 15;
  let lshift = 32 - rshift, index = (next >>> rshift) & 0x3FF;
  for (let i = 0; i < size; i++) {
    destination[i] = table.value1[index];
    const width = table.value2[index], sum = width + lshift;
    const x = (((next << lshift) >>> 0) >>> 1) >>> (31 - width);
    offset -= sum >> 3;
    lshift = sum & 7;
    index = x + table.next[index];
    if (offset < 0 || offset > endOffset || index < 0 || index > 1023) throw invalid();
    next = rl32(bytes, source + offset);
  }
  reader.skip(endOffset);
}

function decompressOpcodes(reader, destination, size) {
  const start = reader.position, flag = reader.peek();
  if ((flag & 3) === 0) {
    reader.skip(1);
    if (reader.left < size) throw invalid();
    destination.set(reader.bytes.subarray(reader.position, reader.position + size));
    reader.skip(size);
  } else if ((flag & 3) === 1) {
    reader.skip(1);
    destination.fill(reader.byte(), 0, size);
  } else {
    const lengths = new Uint32Array(256);
    readOpcodes(reader, lengths, destination, size, fillLengthTable(reader, lengths));
  }
  return reader.position - start;
}

// One 8-byte BC4 block per call. State carries runs between calls; tab0 and
// tab1 remember recent endpoint pairs and index triples by hash.
function cgo(reader, tex, size, ops, cursor, tab0, tab1, offset) {
  let dst = cursor.dst;
  const back = 8 + offset;
  if (cursor.state <= 0) {
    if (cursor.op >= cursor.opSize) throw invalid();
    const opcode = ops[cursor.op++];
    if (!opcode) {
      let v = reader.byte();
      if (v === 255) { let probe; do { if (reader.left <= 0) throw invalid(); probe = reader.u16(); v += probe; } while (probe === 0xFFFF); }
      wl32(tex, dst, rl32(tex, dst - back)); wl32(tex, dst + 4, rl32(tex, dst - back + 4));
      cursor.state = v + 4;
      wl32(tex, dst, rl32(tex, dst - back)); wl32(tex, dst + 4, rl32(tex, dst - back + 4));
      cursor.state--;
    } else {
      const table = (list, key) => { const at = list[key]; if (at < 0) throw invalid(); return at; };
      const behind = () => { const distance = back * (reader.u16() + 1); if (distance > dst) throw invalid(); return dst - distance; };
      let t0, t1, t3, v;
      switch (opcode) {
        case 1: wl32(tex, dst, rl32(tex, dst - back)); wl32(tex, dst + 4, rl32(tex, dst - back + 4)); break;
        case 2:
          t0 = behind(); v = rl32(tex, t0);
          wl32(tex, dst, v); wl32(tex, dst + 4, rl32(tex, t0 + 4));
          tab0[hash16(v)] = dst; tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 3:
          wl32(tex, dst, reader.u32()); wl32(tex, dst + 4, reader.u32());
          tab0[hash16(rl16(tex, dst))] = dst; tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 4:
          t3 = table(tab1, reader.byte());
          wl16(tex, dst, reader.u16()); wl16(tex, dst + 2, rl16(tex, t3)); tex[dst + 4] = tex[t3 + 2];
          wl16(tex, dst + 5, reader.u16()); tex[dst + 7] = reader.byte();
          tab0[hash16(rl16(tex, dst))] = dst; break;
        case 5:
          t3 = table(tab1, reader.byte());
          wl16(tex, dst, reader.u16()); wl16(tex, dst + 2, reader.u16()); tex[dst + 4] = reader.byte();
          wl16(tex, dst + 5, rl16(tex, t3)); tex[dst + 7] = tex[t3 + 2];
          tab0[hash16(rl16(tex, dst))] = dst; tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 6:
          t0 = table(tab1, reader.byte()); t1 = table(tab1, reader.byte());
          wl16(tex, dst, reader.u16()); wl16(tex, dst + 2, rl16(tex, t0)); tex[dst + 4] = tex[t0 + 2];
          wl16(tex, dst + 5, rl16(tex, t1)); tex[dst + 7] = tex[t1 + 2];
          tab0[hash16(rl16(tex, dst))] = dst; break;
        case 7:
          t0 = behind();
          wl16(tex, dst, reader.u16()); wl16(tex, dst + 2, rl16(tex, t0 + 2)); wl32(tex, dst + 4, rl32(tex, t0 + 4));
          tab0[hash16(rl16(tex, dst))] = dst; tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 8:
          t1 = table(tab0, reader.byte());
          wl16(tex, dst, rl16(tex, t1)); wl16(tex, dst + 2, reader.u16()); wl32(tex, dst + 4, reader.u32());
          tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 9:
          t1 = table(tab0, reader.byte()); t3 = table(tab1, reader.byte());
          wl16(tex, dst, rl16(tex, t1)); wl16(tex, dst + 2, rl16(tex, t3)); tex[dst + 4] = tex[t3 + 2];
          wl16(tex, dst + 5, reader.u16()); tex[dst + 7] = reader.byte();
          tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 10:
          t1 = table(tab0, reader.byte()); t3 = table(tab1, reader.byte());
          wl16(tex, dst, rl16(tex, t1)); wl16(tex, dst + 2, reader.u16()); tex[dst + 4] = reader.byte();
          wl16(tex, dst + 5, rl16(tex, t3)); tex[dst + 7] = tex[t3 + 2];
          tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 11:
          t0 = table(tab0, reader.byte()); t3 = table(tab1, reader.byte()); t1 = table(tab1, reader.byte());
          wl16(tex, dst, rl16(tex, t0)); wl16(tex, dst + 2, rl16(tex, t3)); tex[dst + 4] = tex[t3 + 2];
          wl16(tex, dst + 5, rl16(tex, t1)); tex[dst + 7] = tex[t1 + 2]; break;
        case 12:
          t1 = table(tab0, reader.byte()); t0 = behind();
          wl16(tex, dst, rl16(tex, t1)); wl16(tex, dst + 2, rl16(tex, t0 + 2)); wl32(tex, dst + 4, rl32(tex, t0 + 4));
          tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 13:
          wl16(tex, dst, rl16(tex, dst - back)); wl16(tex, dst + 2, reader.u16()); wl32(tex, dst + 4, reader.u32());
          tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 14:
          t3 = table(tab1, reader.byte());
          wl16(tex, dst, rl16(tex, dst - back)); wl16(tex, dst + 2, rl16(tex, t3)); tex[dst + 4] = tex[t3 + 2];
          wl16(tex, dst + 5, reader.u16()); tex[dst + 7] = reader.byte();
          tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 15:
          t3 = table(tab1, reader.byte());
          wl16(tex, dst, rl16(tex, dst - back)); wl16(tex, dst + 2, reader.u16()); tex[dst + 4] = reader.byte();
          wl16(tex, dst + 5, rl16(tex, t3)); tex[dst + 7] = tex[t3 + 2];
          tab1[hash24(tex, dst + 2)] = dst + 2; break;
        case 16:
          t3 = table(tab1, reader.byte()); t1 = table(tab1, reader.byte());
          wl16(tex, dst, rl16(tex, dst - back)); wl16(tex, dst + 2, rl16(tex, t3)); tex[dst + 4] = tex[t3 + 2];
          wl16(tex, dst + 5, rl16(tex, t1)); tex[dst + 7] = tex[t1 + 2]; break;
        case 17:
          t0 = behind();
          wl16(tex, dst, rl16(tex, dst - back)); wl16(tex, dst + 2, rl16(tex, t0 + 2)); wl32(tex, dst + 4, rl32(tex, t0 + 4));
          tab1[hash24(tex, dst + 2)] = dst + 2; break;
        default: break;
      }
    }
  } else {
    wl32(tex, dst, rl32(tex, dst - back)); wl32(tex, dst + 4, rl32(tex, dst - back + 4));
    cursor.state--;
  }
  if (dst + 8 > size) throw invalid();
  cursor.dst = dst + 8;
}

const tables = () => new Int32Array(256).fill(-1);

// Two interleaved BC4 streams forming one BC5 texture (CoCg, or Y and alpha).
function decompressCocg(reader, tex, ops0, ops1, max0, max1) {
  const opOffset = reader.u32() | 0, size0 = reader.u32(), size1 = reader.u32(), dataStart = reader.position;
  if (opOffset < 12 || opOffset - 12 > reader.left || size0 > max0 || size1 > max1) throw invalid();
  reader.skip(opOffset - 12);
  const skip0 = decompressOpcodes(reader, ops0, size0), skip1 = decompressOpcodes(reader, ops1, size1);
  reader.seek(dataStart);
  for (let i = 0; i < 16; i += 4) wl32(tex, i, reader.u32());
  const [tab0, tab1, tab2, tab3] = [tables(), tables(), tables(), tables()];
  tab0[hash16(rl16(tex, 0))] = 0; tab1[hash24(tex, 2)] = 2; tab2[hash16(rl16(tex, 8))] = 8; tab3[hash24(tex, 10)] = 10;
  const first = { dst: 16, state: 0, op: 0, opSize: size0 }, second = { state: 0, op: 0, opSize: size1 };
  while (first.dst + 10 < tex.length) {
    cgo(reader, tex, tex.length, ops0, first, tab0, tab1, 8);
    second.dst = first.dst;
    cgo(reader, tex, tex.length, ops1, second, tab2, tab3, 8);
    first.dst = second.dst;
  }
  reader.seek(dataStart - 12 + opOffset + skip0 + skip1);
}

function decompressY(reader, tex, ops, max) {
  const opOffset = reader.u32() | 0, size = reader.u32(), dataStart = reader.position;
  if (opOffset < 8 || opOffset - 8 > reader.left || size > max) throw invalid();
  reader.skip(opOffset - 8);
  const skip = decompressOpcodes(reader, ops, size);
  reader.seek(dataStart);
  const v = reader.u32();
  wl32(tex, 0, v); wl32(tex, 4, reader.u32());
  const tab0 = tables(), tab1 = tables();
  tab0[hash16(v)] = 0; tab1[hash24(tex, 2)] = 2;
  const cursor = { dst: 8, state: 0, op: 0, opSize: size };
  while (cursor.dst < tex.length) cgo(reader, tex, tex.length, ops, cursor, tab0, tab1, 0);
  reader.seek(dataStart + opOffset + skip - 8);
}

// The texture format of a frame, from its header.
export function dxvFormat(bytes) {
  const value = rl32(bytes, 0);
  if (value === DXT1 || value === DXT5 || value === YCG6 || value === YG10) return { [DXT1]: 'DXT1', [DXT5]: 'DXT5', [YCG6]: 'YCG6', [YG10]: 'YG10' }[value];
  const type = value >>> 24, major = (type & 0x0F) - 1;
  return type & 0x40 ? 'DXT5' : type & 0x20 || major === 1 ? 'DXT1' : null;
}
export const dxvHasAlpha = format => format === 'DXT5' || format === 'YG10';

export function decodeDxvFrame(bytes, width, height) {
  const reader = new Reader(bytes, 0, bytes.length);
  let format = reader.u32(), raw = false, lzf = false;
  let size;
  if (format === DXT1 || format === DXT5 || format === YCG6 || format === YG10) {
    reader.skip(2);
    raw = !!reader.byte();
    reader.skip(1);
    size = reader.u32();
  } else {
    // Old header: 24-bit size and a type byte.
    const type = format >>> 24, major = (type & 0x0F) - 1;
    size = format & 0xFFFFFF;
    raw = !!(type & 0x80); lzf = !raw;
    format = type & 0x40 ? DXT5 : type & 0x20 || major === 1 ? DXT1 : 0;
    if (!format) throw new Error('Unsupported DXV header.');
  }
  if (size !== reader.left) throw new Error('The DXV frame is incomplete.');
  const codedWidth = Math.ceil(width / 16) * 16, codedHeight = Math.ceil(height / 4) * 4;
  const blocks = codedWidth / 4 * codedHeight / 4, extent = [width, height];
  if (format === DXT1 || format === DXT5) {
    const tex = new Uint8Array(blocks * (format === DXT1 ? 8 : 16));
    if (raw) {
      if (reader.left < tex.length) throw invalid();
      tex.set(bytes.subarray(reader.position, reader.position + tex.length));
    } else if (lzf) decompressLzf(reader, tex);
    else (format === DXT1 ? decompressDxt1 : decompressDxt5)(reader, new Uint32Array(tex.buffer));
    return { layout: format === DXT1 ? 'rgb' : 'rgba-premultiplied',
      textures: [{ format: format === DXT1 ? 'dxt1' : 'dxt5', width: codedWidth, height: codedHeight, extent, data: tex }] };
  }
  // High quality: luma (and alpha) at full size, CoCg at half size.
  const chromaWidth = codedWidth / 2, chromaHeight = Math.floor(codedHeight / 2 / 4) * 4;
  const tex = new Uint8Array(blocks * (format === YCG6 ? 8 : 16));
  const ctex = new Uint8Array(Math.floor(codedWidth / 2 / 4 * codedHeight / 2 / 4) * 16);
  const pixels = codedWidth * codedHeight;
  const ops = [new Uint8Array(pixels / 16), new Uint8Array(pixels / 32), new Uint8Array(pixels / 32), new Uint8Array(pixels / 16)];
  if (raw) {
    if (reader.left < tex.length) throw invalid();
    tex.set(bytes.subarray(reader.position, reader.position + tex.length));
  } else {
    if (format === YCG6) decompressY(reader, tex, ops[0], ops[0].length);
    else decompressCocg(reader, tex, ops[0], ops[3], ops[0].length, ops[3].length);
    decompressCocg(reader, ctex, ops[1], ops[2], ops[1].length, ops[2].length);
  }
  const chroma = ctex.subarray(0, chromaWidth / 4 * chromaHeight / 4 * 16);
  return { layout: format === YCG6 ? 'ycocg-planar' : 'ycocg-planar-alpha',
    textures: [{ format: format === YCG6 ? 'bc4' : 'bc5', width: codedWidth, height: codedHeight, extent, data: tex },
      { format: 'bc5', width: chromaWidth, height: Math.max(4, chromaHeight), extent: [width / 2, height / 2], data: chroma.length === ctex.length ? ctex : chroma.slice() }] };
}