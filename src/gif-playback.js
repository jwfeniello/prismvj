// HTMLImageElement exposes a GIF's first frame to WebGL. Decode composited
// frames explicitly so the live output follows the same clock as other clips.
export function isGifAsset(asset, url) {
  return [asset.path, asset.name, url].some(value => /\.gif(?:[?#]|$)/i.test(value || '')) || /^data:image\/gif[;,]/i.test(url) || url.startsWith('blob:');
}

function gifMetadata(data) {
  const bytes = new Uint8Array(data);
  if (bytes.length < 13 || !['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))) return null;
  let offset = 13 + (bytes[10] & 128 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
  let delay = 0.1, duration = 0, hasAlpha = false;
  const ends = [];
  const requireBytes = count => { if (offset + count > bytes.length) throw new Error('The GIF data is incomplete.'); };
  const skipBlocks = () => {
    while (true) {
      requireBytes(1);
      const size = bytes[offset++];
      if (!size) return;
      requireBytes(size); offset += size;
    }
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      requireBytes(1);
      if (bytes[offset++] === 0xf9) {
        requireBytes(6);
        if (bytes[offset] !== 4 || bytes[offset + 5] !== 0) throw new Error('Invalid GIF frame control.');
        const hundredths = bytes[offset + 2] | (bytes[offset + 3] << 8);
        // Match Chromium's treatment of unspecified and sub-20ms GIF delays.
        delay = hundredths < 2 ? 0.1 : hundredths / 100;
        hasAlpha ||= !!(bytes[offset + 1] & 1);
        offset += 6;
      } else skipBlocks();
    } else if (marker === 0x2c) {
      requireBytes(9);
      const packed = bytes[offset + 8];
      offset += 9;
      if (packed & 128) offset += 3 * (1 << ((packed & 7) + 1));
      requireBytes(1); offset++; // LZW minimum code size; the codec handles pixels.
      skipBlocks();
      duration += delay; ends.push(duration); delay = 0.1;
    } else throw new Error('Invalid GIF image block.');
  }
  return { ends, duration, hasAlpha };
}

export class GifPlayback {
  static async open(url, signal, onError) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Cannot read GIF (${response.status}).`);
    const data = await response.arrayBuffer();
    const metadata = gifMetadata(data);
    if (!metadata || metadata.ends.length < 2) return null;
    if (!globalThis.ImageDecoder) throw new Error('Animated GIF decoding is unavailable in this browser.');
    const decoder = new ImageDecoder({ data, type: 'image/gif', preferAnimation: true });
    let playback;
    try {
      await decoder.tracks.ready;
      if (signal.aborted) throw new DOMException('GIF loading cancelled.', 'AbortError');
      playback = new GifPlayback(decoder, metadata, onError);
      const { image } = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
      if (signal.aborted) { image.close(); throw new DOMException('GIF loading cancelled.', 'AbortError'); }
      playback.cacheLimit = Math.max(1, Math.min(6, Math.floor(32 * 1024 * 1024 / (image.displayWidth * image.displayHeight * 4))));
      playback.frames.set(0, image);
      playback.current = image;
      playback.currentIndex = 0;
      return playback;
    } catch (error) { if (playback) playback.close(); else decoder.close(); throw error; }
  }

  constructor(decoder, metadata, onError = () => {}) {
    Object.assign(this, metadata);
    this.decoder = decoder;
    this.onError = onError;
    this.frames = new Map();
    this.cacheLimit = 1;
    this.currentIndex = -1;
    this.wanted = 0;
    this.pending = null;
    this.closed = false;
    this.failed = false;
  }

  frameAt(time) {
    const target = Math.max(0, Math.min(this.duration - 0.000001, Number(time) || 0));
    let low = 0, high = this.ends.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (target < this.ends[middle]) high = middle; else low = middle + 1;
    }
    this.wanted = low;
    const cached = this.frames.get(low);
    if (cached) {
      this.current = cached; this.currentIndex = low;
      this.frames.delete(low); this.frames.set(low, cached);
    }
    this._decode();
    return this.current;
  }

  _decode() {
    if (this.closed || this.failed || this.pending || this.frames.has(this.wanted)) return;
    const index = this.wanted;
    this.pending = this.decoder.decode({ frameIndex: index, completeFramesOnly: true }).then(({ image }) => {
      if (this.closed) { image.close(); return; }
      // Keep completed frames even when playback advanced during decoding.
      // Discarding them would freeze fast GIFs whenever decode takes longer
      // than one frame. Catch up from the latest completed frame, while an
      // already cached seek target always wins over an older pending result.
      this.frames.set(index, image);
      this.currentIndex = this.frames.has(this.wanted) ? this.wanted : index;
      this.current = this.frames.get(this.currentIndex);
      this.frames.delete(this.currentIndex); this.frames.set(this.currentIndex, this.current);
      while (this.frames.size > this.cacheLimit) {
        const oldest = this.frames.keys().next().value;
        this.frames.get(oldest).close(); this.frames.delete(oldest);
      }
    }).catch(error => {
      if (!this.closed) { this.failed = true; this.onError(error); }
    }).finally(() => { this.pending = null; this._decode(); });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const frame of this.frames.values()) frame.close();
    this.frames.clear();
    this.current = null;
    this.decoder.close();
  }
}
