// Decoder jobs shared by the worker and the in-thread fallback. Frames are
// read with HTTP Range requests, so only the bytes of one frame are fetched.
import { demuxMovie } from './mov.js';
import { decodeHapFrame, decodeBC4, hapHasAlpha } from './hap.js';
import { decodeDxvFrame, dxvFormat, dxvHasAlpha } from './dxv.js';

const fileSizes = new Map();
const padded = value => Math.ceil(value / 4) * 4;

async function read(url, offset, length) {
  const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (!response.ok) throw new Error(`Cannot read the media file (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.status === 206) {
    const total = /\/(\d+)\s*$/.exec(response.headers.get('Content-Range') || '');
    if (total) fileSizes.set(url, Number(total[1]));
    return bytes;
  }
  // A server without Range support returns the whole file.
  fileSizes.set(url, bytes.length);
  return bytes.subarray(offset, offset + length);
}

// How HAP textures combine into RGBA (see GPU_VIDEO_FRAGMENT).
function hapLayout(formats) {
  const [color, alpha] = formats;
  if (color === 'ycocg') return alpha ? 'ycocg-alpha' : 'ycocg';
  if (color === 'bc4' || color === 'r8') return 'matte';
  if (color === 'dxt1' || color === 'bc6u' || color === 'bc6s') return 'rgb';
  return 'rgba';
}

async function open({ url }) {
  await read(url, 0, 16);
  const size = fileSizes.get(url);
  const movie = await demuxMovie((offset, length) => read(url, offset, Math.max(0, Math.min(length, size - offset))), size);
  const codec = /^Hap[15YMA7H]$/.test(movie.fourcc) ? 'hap' : /^DXD/.test(movie.fourcc) ? 'dxv' : null;
  if (!codec) throw new Error(`The ${movie.fourcc} codec cannot be decoded on the GPU.`);
  if (!movie.width || !movie.height) throw new Error('The video track has no frame size.');
  // DXV declares its texture format per frame; the first frame represents the file.
  const format = codec === 'dxv' ? dxvFormat(await read(url, movie.offsets[0], Math.min(16, movie.sizes[0]))) : null;
  if (codec === 'dxv' && !format) throw new Error('This DXV version is not supported.');
  const hasAlpha = codec === 'hap' ? hapHasAlpha(movie.fourcc) : dxvHasAlpha(format);
  return { result: { ...movie, codec, format, hasAlpha }, transfer: [movie.offsets.buffer, movie.sizes.buffer, movie.times.buffer] };
}

// Without EXT_texture_compression_rgtc, BC4/BC5 planes are expanded here.
function expandRgtc(texture) {
  const { width, height, data } = texture;
  if (texture.format === 'bc4') return { ...texture, format: 'r8', data: decodeBC4(data, width, height) };
  if (texture.format !== 'bc5') return texture;
  const red = decodeBC4(data, width, height, 16, 0), green = decodeBC4(data, width, height, 16, 8), pair = new Uint8Array(red.length * 2);
  for (let i = 0; i < red.length; i++) { pair[i * 2] = red[i]; pair[i * 2 + 1] = green[i]; }
  return { ...texture, format: 'rg8', data: pair };
}

async function decode({ url, codec, width, height, offset, size, rgtc = true }) {
  const started = performance.now();
  const bytes = await read(url, offset, size);
  const fetched = performance.now();
  if (bytes.length !== size) throw new Error('The media file ended before this frame.');
  let frame;
  if (codec === 'dxv') frame = decodeDxvFrame(bytes, width, height);
  else {
    const textures = decodeHapFrame(bytes, width, height);
    frame = { layout: hapLayout(textures.map(texture => texture.format)),
      textures: textures.map(texture => ({ ...texture, width: padded(width), height: padded(height), extent: [width, height] })) };
  }
  if (!rgtc) frame.textures = frame.textures.map(expandRgtc);
  for (const texture of frame.textures) if (texture.data.byteOffset || texture.data.byteLength !== texture.data.buffer.byteLength) texture.data = texture.data.slice();
  return { result: { ...frame, fetchMs: fetched - started, decodeMs: performance.now() - fetched }, transfer: frame.textures.map(texture => texture.data.buffer) };
}

export function handle(message) {
  if (message.type === 'open') return open(message);
  if (message.type === 'decode') return decode(message);
  throw new Error(`Unknown decoder request ${message.type}.`);
}