// Snappy raw-block decompression (https://github.com/google/snappy/blob/main/format_description.txt).
// HAP compresses its DXT/BC texture data with Snappy as the second stage.

export function snappyLength(input, offset = 0, end = input.length) {
  let result = 0, shift = 0;
  for (let i = offset; i < end && shift < 35; i++, shift += 7) {
    const byte = input[i];
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return { length: result, header: i - offset + 1 };
  }
  throw new Error('Corrupt Snappy length.');
}

// Decompresses input[offset, end) into output at outputOffset. Returns the
// number of bytes written. Texture data yields many short literals and
// copies, so those are copied inline rather than through subarray/copyWithin.
export function snappyDecompress(input, offset, end, output, outputOffset = 0) {
  const { length, header } = snappyLength(input, offset, end);
  const limit = outputOffset + length;
  if (limit > output.length) throw new Error('Snappy data is larger than its texture.');
  let i = offset + header, o = outputOffset;
  while (i < end) {
    const tag = input[i++];
    const type = tag & 3;
    if (type === 0) {
      let size = (tag >>> 2) + 1;
      if (size > 60) {
        const bytes = size - 60;
        size = (input[i] | (bytes > 1 ? input[i + 1] << 8 : 0) | (bytes > 2 ? input[i + 2] << 16 : 0) | (bytes > 3 ? input[i + 3] << 24 : 0)) >>> 0;
        size += 1;
        i += bytes;
      }
      if (i + size > end || o + size > limit) throw new Error('Corrupt Snappy literal.');
      if (size < 32) for (const stop = i + size; i < stop;) output[o++] = input[i++];
      else { output.set(input.subarray(i, i + size), o); i += size; o += size; }
      continue;
    }
    let size, distance;
    if (type === 1) { size = ((tag >>> 2) & 7) + 4; distance = ((tag >>> 5) << 8) | input[i++]; }
    else if (type === 2) { size = (tag >>> 2) + 1; distance = input[i] | input[i + 1] << 8; i += 2; }
    else { size = (tag >>> 2) + 1; distance = (input[i] | input[i + 1] << 8 | input[i + 2] << 16 | input[i + 3] << 24) >>> 0; i += 4; }
    if (!distance || distance > o - outputOffset || o + size > limit) throw new Error('Corrupt Snappy copy.');
    if (size >= 32 && distance >= size) { output.copyWithin(o, o - distance, o - distance + size); o += size; }
    else for (let from = o - distance, stop = o + size; o < stop;) output[o++] = output[from++];
  }
  if (o !== limit) throw new Error('Truncated Snappy data.');
  return length;
}
