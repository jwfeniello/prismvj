// Clip thumbnails for videos and generated sources. Generators render on a
// small private engine; videos decode one frame on a temporary element. Work
// runs one clip at a time between frames so playback never stalls.
import { LiveEngine } from './engine.js';
import { createLayer, Transport } from './model.js';

const WIDTH = 160, HEIGHT = 90;

export class Thumbnailer {
  constructor({ onThumbnail }) {
    this.onThumbnail = onThumbnail;
    this.queue = [];
    this.busy = false;
    this.engine = null;
  }

  request(clip) {
    if (!clip || clip.thumbnail || this.queue.some(item => item.id === clip.id)) return;
    if (clip.kind === 'source' || clip.kind === 'video') { this.queue.push(clip); this._next(); }
  }

  async _next() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const clip = this.queue.shift();
    try {
      const thumbnail = clip.kind === 'video' ? await this._video(clip) : await this._source(clip);
      if (thumbnail) this.onThumbnail(clip, thumbnail);
    } catch { /* thumbnails are optional */ }
    this.busy = false;
    setTimeout(() => this._next(), 30);
  }

  async _source(clip) {
    if (!this.engine) {
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH; canvas.height = HEIGHT;
      this.engine = new LiveEngine(canvas, { onError: () => {} });
    }
    const layer = { ...createLayer('Thumbnail'), clips: { thumb: [clip] }, activeClipId: clip.id };
    const project = { id: 'thumb', width: WIDTH, height: HEIGHT, bpm: 120, speed: 1, masterOpacity: 1, masterVolume: 0, av: 1, crossfader: 0.5,
      decks: [{ id: 'thumb', name: 'Thumb' }], selectedDeckId: 'thumb', layers: [layer], groups: [], effects: [] };
    const frames = new Transport(project).tick(1.5).map(frame => ({ ...frame, clip: { ...clip, opacity: 1, volume: 0, effects: [] }, time: 1.5, rate: 0 }));
    // Programs compile in the background; poll a few frames before capturing.
    for (let attempt = 0; attempt < 60; attempt++) {
      this.engine.render(project, frames, 1.5);
      if (!this.engine.hasPendingPrograms()) break;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    this.engine.render(project, frames, 1.5);
    return this.engine.canvas.toDataURL('image/jpeg', 0.75);
  }

  _video(clip) {
    const url = clip.url || clip.path;
    if (!url) return null;
    return new Promise(resolve => {
      const video = document.createElement('video'), done = value => { clearTimeout(timer); video.removeAttribute('src'); video.load(); resolve(value); };
      const timer = setTimeout(() => done(null), 8000);
      video.muted = true; video.preload = 'auto'; video.crossOrigin = 'anonymous';
      video.onloadedmetadata = () => { video.currentTime = Math.min(1, (video.duration || 0) * 0.1); };
      video.onseeked = () => {
        try {
          const canvas = document.createElement('canvas'), aspect = (video.videoWidth || 16) / (video.videoHeight || 9);
          canvas.width = WIDTH; canvas.height = Math.round(WIDTH / aspect);
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          done(canvas.toDataURL('image/jpeg', 0.75));
        } catch { done(null); }
      };
      video.onerror = () => done(null);
      video.src = url;
    });
  }

  dispose() { this.engine?.dispose(); this.engine = null; this.queue = []; }
}
