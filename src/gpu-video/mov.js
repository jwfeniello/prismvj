// Minimal QuickTime/MP4 demuxer: locates the moov atom with ranged reads and
// builds the video sample table (byte offset, size and time of every frame).
// GPU codecs (HAP, DXV) are intra-only, so decode order equals display order.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const text = (bytes, offset) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

function atoms(view, bytes, start, end, visit) {
  for (let offset = start; offset + 8 <= end;) {
    let size = view.getUint32(offset), header = 8;
    const type = text(bytes, offset + 4);
    if (size === 1) { size = Number(view.getBigUint64(offset + 8)); header = 16; }
    else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) throw new Error(`Damaged MOV atom ${type}.`);
    visit(type, offset + header, offset + size);
    offset += size;
  }
}

function parseTrack(view, bytes, start, end) {
  const track = {};
  const visit = (type, from, to) => {
    if (CONTAINERS.has(type)) return atoms(view, bytes, from, to, visit);
    if (type === 'mdhd') {
      const version = bytes[from];
      track.timescale = view.getUint32(from + (version === 1 ? 20 : 12));
    } else if (type === 'hdlr' && text(bytes, from + 4) !== 'dhlr') track.handler = text(bytes, from + 8); // media, not data, handler
    else if (type === 'stsd') {
      if (view.getUint32(from + 4) < 1) return;
      const entry = from + 8;
      track.fourcc = text(bytes, entry + 4);
      track.width = view.getUint16(entry + 32);
      track.height = view.getUint16(entry + 34);
    } else if (type === 'stts') {
      const count = view.getUint32(from + 4);
      track.stts = Array.from({ length: count }, (_, i) => [view.getUint32(from + 8 + i * 8), view.getUint32(from + 12 + i * 8)]);
    } else if (type === 'stsc') {
      const count = view.getUint32(from + 4);
      track.stsc = Array.from({ length: count }, (_, i) => [view.getUint32(from + 8 + i * 12), view.getUint32(from + 12 + i * 12)]);
    } else if (type === 'stsz') {
      const fixed = view.getUint32(from + 4), count = view.getUint32(from + 8);
      track.sizes = new Uint32Array(count);
      for (let i = 0; i < count; i++) track.sizes[i] = fixed || view.getUint32(from + 12 + i * 4);
    } else if (type === 'stco' || type === 'co64') {
      const count = view.getUint32(from + 4), wide = type === 'co64';
      track.chunks = new Float64Array(count);
      for (let i = 0; i < count; i++) track.chunks[i] = wide ? Number(view.getBigUint64(from + 8 + i * 8)) : view.getUint32(from + 8 + i * 4);
    }
  };
  atoms(view, bytes, start, end, visit);
  return track;
}

function sampleTable(track) {
  const { sizes, chunks, stsc, stts } = track;
  if (!sizes?.length || !chunks?.length || !stsc?.length || !stts?.length || !track.timescale) throw new Error('The MOV video track has no frame index.');
  const count = sizes.length, offsets = new Float64Array(count), times = new Float64Array(count + 1);
  let sample = 0;
  for (let entry = 0; entry < stsc.length && sample < count; entry++) {
    const [first, perChunk] = stsc[entry];
    const last = entry + 1 < stsc.length ? stsc[entry + 1][0] - 1 : chunks.length;
    for (let chunk = first; chunk <= last && sample < count; chunk++) {
      let offset = chunks[chunk - 1];
      for (let i = 0; i < perChunk && sample < count; i++, sample++) { offsets[sample] = offset; offset += sizes[sample]; }
    }
  }
  if (sample !== count) throw new Error('The MOV frame index is incomplete.');
  let time = 0, index = 0;
  for (const [repeat, delta] of stts) for (let i = 0; i < repeat && index < count; i++) { times[index++] = time / track.timescale; time += delta; }
  while (index < count) times[index++] = time / track.timescale;
  times[count] = time / track.timescale;
  return { offsets, sizes, times, duration: times[count] };
}

export function parseMovie(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tracks = [];
  atoms(view, bytes, 0, bytes.length, (type, from, to) => {
    if (type === 'moov') atoms(view, bytes, from, to, (child, start, end) => { if (child === 'trak') tracks.push(parseTrack(view, bytes, start, end)); });
    if (type === 'cmov') throw new Error('Compressed MOV headers are not supported.');
  });
  return tracks;
}

// read(offset, length) resolves to a Uint8Array of at most `length` bytes.
export async function demuxMovie(read, fileSize) {
  let offset = 0, moov = null;
  while (offset + 8 <= fileSize) {
    const header = await read(offset, 16);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let size = view.getUint32(0);
    const type = text(header, 4);
    if (size === 1) size = Number(view.getBigUint64(8));
    else if (size === 0) size = fileSize - offset;
    if (size < 8) throw new Error('Damaged MOV file.');
    if (type === 'moov') {
      if (size > 512 * 1024 * 1024) throw new Error('The MOV header is too large.');
      moov = await read(offset, size);
      break;
    }
    offset += size;
  }
  if (!moov) throw new Error('The MOV file has no movie header.');
  const tracks = parseMovie(moov);
  const video = tracks.find(track => track.handler === 'vide' && track.sizes?.length);
  if (!video) throw new Error('The MOV file has no video track.');
  const table = sampleTable(video);
  return { fourcc: video.fourcc, width: video.width, height: video.height, count: video.sizes.length,
    frameRate: table.duration > 0 ? video.sizes.length / table.duration : 30, hasAudio: tracks.some(track => track.handler === 'soun' && track.sizes?.length), ...table };
}

// Index of the frame displayed at `time` seconds.
export function frameAt(times, count, time) {
  let low = 0, high = count - 1;
  const t = time + 1e-7;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (times[middle] <= t) low = middle; else high = middle - 1;
  }
  return low;
}
