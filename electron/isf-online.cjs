// Client for the ISF community library at editor.isf.video (main process).
// Search results and installed shaders come from its public JSON API; images
// (thumbnails, bundled image inputs) from its Cloudinary account. Thumbnails
// are proxied as data: URLs so the renderer's content policy stays strict.
// Installed shaders are saved under <userData>/ISF Library/<id>/ and loaded
// again on start. Every id, size and value is validated: responses are
// untrusted.
const fs = require('node:fs/promises');
const path = require('node:path');

const API = 'https://editor.isf.video/api';
const SITE = 'https://editor.isf.video/shaders';
const CLOUDINARY = 'https://res.cloudinary.com/hrlz5rsqo/image/upload';
const PAGE_SIZE = 18;
const SORTS = Object.freeze({ popular: 'Popularity \u2193', newest: 'Date Created \u2193', oldest: 'Date Created \u2191', title: 'Title \u2191', relevance: 'Relevance' });
const CATEGORIES = Object.freeze(['Generator', 'Color Adjustment', 'Color Effect', 'Blur', 'Distortion Effect', 'Glitch', 'Halftone Effect',
  'Masking', 'Patterns', 'Sharpen', 'Stylize', 'Tile Effect', 'Geometry Adjustment', 'Film', 'Transition', 'Examples']);
const ID = /^[a-f0-9]{24}$/;
const CLOUD_ID = /^[A-Za-z0-9_-]{1,120}$/;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };
const MAX_SOURCE = 512 * 1024, MAX_IMAGE = 4 * 1024 * 1024, MAX_IMAGES = 8;

const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const isId = value => typeof value === 'string' && ID.test(value);

// Kind from the ISF JSON header: transition, effect (filter) or source.
function shaderKind(fragment) {
  const header = /^\s*\/\*([\s\S]*?)\*\//.exec(fragment || '')?.[1] || '';
  const named = name => new RegExp(`"NAME"\\s*:\\s*"${name}"`).test(header);
  if (named('startImage') && named('endImage')) return 'transition';
  return named('inputImage') ? 'effect' : 'source';
}

async function read(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('The ISF library sent too much data.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('The ISF library sent too much data.');
  return buffer;
}

class IsfOnline {
  constructor({ libraryDir, fetchImpl = globalThis.fetch, timeout = 20000 } = {}) {
    if (typeof libraryDir !== 'string' || !libraryDir) throw new TypeError('IsfOnline needs a library folder.');
    this.libraryDir = libraryDir;
    this.fetch = fetchImpl;
    this.timeout = timeout;
    this.sources = new Map();
    this.thumbnails = new Map();
  }

  async _get(url, maxBytes) {
    const response = await this.fetch(url, { signal: AbortSignal.timeout(this.timeout), headers: { Accept: 'application/json, image/*' }, redirect: 'error' });
    if (response.status === 404) throw new Error('That shader is no longer on editor.isf.video.');
    if (!response.ok) throw new Error(`editor.isf.video answered ${response.status}.`);
    return { response, body: await read(response, maxBytes) };
  }

  async _json(url, maxBytes = 8 * 1024 * 1024) {
    const { body } = await this._get(url, maxBytes);
    try { return JSON.parse(body.toString('utf8')); } catch { throw new Error('editor.isf.video sent an unreadable answer.'); }
  }

  async _image(url) {
    const { response, body } = await this._get(url, MAX_IMAGE);
    const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES[type]) throw new Error('Not an image.');
    return { type, body, dataURL: `data:${type};base64,${body.toString('base64')}` };
  }

  async _thumbnail(cloudId) {
    if (!CLOUD_ID.test(cloudId || '')) return null;
    if (this.thumbnails.has(cloudId)) return this.thumbnails.get(cloudId);
    let dataURL = null;
    try { dataURL = (await this._image(`${CLOUDINARY}/c_fill,h_126,w_180/${cloudId}.jpg`)).dataURL; } catch { dataURL = null; }
    this.thumbnails.set(cloudId, dataURL);
    if (this.thumbnails.size > 400) this.thumbnails.delete(this.thumbnails.keys().next().value);
    return dataURL;
  }

  _remember(item) {
    const fragment = text(item.rawFragmentSource, MAX_SOURCE + 1);
    if (!isId(item.id || item._id) || !fragment || fragment.length > MAX_SOURCE) return;
    this.sources.set(item.id || item._id, item);
    if (this.sources.size > 300) this.sources.delete(this.sources.keys().next().value);
  }

  // { q, category, sort: popular|newest|oldest|title|relevance, page }.
  async search({ q = '', category = '', sort = 'popular', page = 0 } = {}) {
    const query = text(q, 100).trim();
    const from = Math.min(9982, Math.max(0, Math.trunc(Number(page) || 0)) * PAGE_SIZE);
    const params = new URLSearchParams({ q: query, sort: SORTS[sort] || SORTS.popular, from: String(from), showPrivate: 'false' });
    if (CATEGORIES.includes(category)) params.set('category', category);
    const json = await this._json(`${API}/search?${params}`);
    const shaders = Array.isArray(json?.shaders) ? json.shaders.slice(0, PAGE_SIZE) : [];
    const items = shaders.filter(item => item && isId(item.id || item._id)).map(item => {
      this._remember(item);
      return {
        id: item.id || item._id,
        title: text(item.title, 80).trim() || 'Untitled',
        author: text(item.username || item.user?.username, 60),
        description: text(item.description, 300),
        categories: (Array.isArray(item.publicCategories) ? item.publicCategories : []).filter(value => typeof value === 'string').slice(0, 4).map(value => value.slice(0, 40)),
        stars: Array.isArray(item.stars) ? item.stars.length : 0,
        kind: shaderKind(item.rawFragmentSource),
        created: text(item.createdAt, 40),
        link: `${SITE}/${item.id || item._id}`,
        cloud: CLOUD_ID.test(item.thumbnailCloudinaryId || '') ? item.thumbnailCloudinaryId : null,
      };
    });
    await Promise.all(items.map(async item => { item.thumbnail = await this._thumbnail(item.cloud); delete item.cloud; }));
    const total = Number.isFinite(json?.numberOfResults) ? Math.max(0, Math.trunc(json.numberOfResults)) : items.length;
    return { items, total, page: from / PAGE_SIZE, pageSize: PAGE_SIZE, more: from + PAGE_SIZE < Math.min(total, 10000) };
  }

  _folder(id) { return path.join(this.libraryDir, id); }

  // Downloads a shader (and its bundled images) into the library.
  async install(id) {
    if (!isId(id)) throw new Error('Invalid shader id.');
    const item = await this._json(`${API}/shaders/${id}`).catch(error => { if (this.sources.has(id)) return this.sources.get(id); throw error; });
    const fragment = text(item?.rawFragmentSource, MAX_SOURCE + 1);
    const vertex = text(item?.rawVertexSource, MAX_SOURCE + 1);
    if (!fragment || fragment.length > MAX_SOURCE || vertex.length > MAX_SOURCE || fragment.includes('\0') || vertex.includes('\0')) throw new Error('That shader has no usable source.');
    const folder = this._folder(id);
    await fs.rm(folder, { recursive: true, force: true });
    await fs.mkdir(folder, { recursive: true });
    const images = {};
    for (const image of (Array.isArray(item.images) ? item.images : []).slice(0, MAX_IMAGES)) {
      const name = text(image?.name, 64);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || !CLOUD_ID.test(image?.cloudinaryId || '')) continue;
      try {
        const { type, body } = await this._image(`${CLOUDINARY}/${image.cloudinaryId}`);
        const file = `${name}.${IMAGE_TYPES[type]}`;
        await fs.writeFile(path.join(folder, file), body);
        images[name] = file;
      } catch { /* a missing bundled image reads as black */ }
    }
    const meta = {
      id, title: text(item.title, 80).trim() || 'Untitled', author: text(item.user?.username || item.username, 60),
      description: text(item.description, 300), link: `${SITE}/${id}`, kind: shaderKind(fragment), images, installed: new Date().toISOString(),
    };
    await fs.writeFile(path.join(folder, 'shader.fs'), fragment, 'utf8');
    if (vertex.trim()) await fs.writeFile(path.join(folder, 'shader.vs'), vertex, 'utf8');
    await fs.writeFile(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    return this._entry(id);
  }

  async _entry(id) {
    const folder = this._folder(id);
    const meta = JSON.parse(await fs.readFile(path.join(folder, 'meta.json'), 'utf8'));
    const fragment = await fs.readFile(path.join(folder, 'shader.fs'), 'utf8');
    if (fragment.length > MAX_SOURCE) throw new Error('Shader too large.');
    const vertex = await fs.readFile(path.join(folder, 'shader.vs'), 'utf8').catch(() => '');
    const assets = {};
    for (const [name, file] of Object.entries(meta?.images || {}).slice(0, MAX_IMAGES)) {
      const extension = path.extname(String(file)).slice(1).toLowerCase();
      const type = Object.keys(IMAGE_TYPES).find(key => IMAGE_TYPES[key] === extension);
      if (!type || path.basename(String(file)) !== file) continue;
      const body = await fs.readFile(path.join(folder, file)).catch(() => null);
      if (body && body.length <= MAX_IMAGE) assets[name] = `data:${type};base64,${body.toString('base64')}`;
    }
    return {
      id, name: text(meta?.title, 80) || 'Untitled', author: text(meta?.author, 60), link: `${SITE}/${id}`,
      description: text(meta?.description, 300), kind: shaderKind(fragment), text: fragment, vertex: vertex.slice(0, MAX_SOURCE), assets,
    };
  }

  // Every installed shader, for registering at start.
  async library() {
    let entries = [];
    try { entries = await fs.readdir(this.libraryDir, { withFileTypes: true }); } catch { return []; }
    const result = [];
    for (const entry of entries.slice(0, 2000)) {
      if (!entry.isDirectory() || !isId(entry.name)) continue;
      try { result.push(await this._entry(entry.name)); } catch { /* skip damaged entries */ }
    }
    return result;
  }

  async remove(id) {
    if (!isId(id)) throw new Error('Invalid shader id.');
    await fs.rm(this._folder(id), { recursive: true, force: true });
    return true;
  }
}

module.exports = { IsfOnline, ISF_SORTS: SORTS, ISF_CATEGORIES: CATEGORIES, shaderKind, PAGE_SIZE };