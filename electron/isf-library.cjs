// Scans a folder for ISF fragment shaders (*.fs) for the renderer to import.
// Node only: reads the folder itself plus one level of subfolders, never
// follows symlinks and bounds file count and size, so a hostile or huge
// folder cannot hang or exhaust the app.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_SUBFOLDERS = 256;
const positiveInt = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;

async function listEntries(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

async function readShader(file, maxBytes) {
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    handle = await fs.open(file, 'r');
    // Read at most maxBytes + 1 so a file that grew after lstat is still rejected.
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return null;
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const MAX_IMAGE = 4 * 1024 * 1024;

// IMPORTED image paths from the JSON header (best effort; the renderer parses
// the header properly). Paths must stay inside the shader's folder.
function importedPaths(text) {
  const raw = /^\s*\/\*([\s\S]*?)\*\//.exec(text)?.[1];
  if (!raw) return [];
  let header;
  try { header = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); } catch { return []; }
  const imported = header?.IMPORTED;
  const items = Array.isArray(imported) ? imported : imported && typeof imported === 'object' ? Object.values(imported) : [];
  return items.map(item => item?.PATH).filter(item => typeof item === 'string' && item.length < 512).slice(0, 8);
}

async function readAssets(file, text) {
  const folder = path.dirname(file), assets = {};
  for (const relative of importedPaths(text)) {
    const full = path.resolve(folder, relative);
    const type = IMAGE_TYPES[path.extname(full).toLowerCase()];
    if (!type || (full !== folder && !full.startsWith(folder + path.sep))) continue;
    try {
      const stat = await fs.lstat(full);
      if (!stat.isFile() || stat.size > MAX_IMAGE) continue;
      assets[relative] = `data:${type};base64,${(await fs.readFile(full)).toString('base64')}`;
    } catch { /* missing image reads as black */ }
  }
  return assets;
}

// Returns [{ name, path, text, vertex, assets }] sorted by name (case-insensitive), then path.
// vertex is the matching .vs file's text ('' when there is none).
async function scanISFFolder(directory, { maxFiles = 500, maxBytes = 256 * 1024 } = {}) {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) throw new TypeError('scanISFFolder needs a directory path.');
  const fileLimit = positiveInt(maxFiles, 500, 10000);
  const byteLimit = positiveInt(maxBytes, 256 * 1024, 16 * 1024 * 1024);
  const root = path.resolve(directory);
  const results = [];
  const visit = async (folder, depth) => {
    const subfolders = [];
    for (const entry of await listEntries(folder)) {
      if (results.length >= fileLimit) return;
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0 && subfolders.length < MAX_SUBFOLDERS && entry.name !== '__MACOSX') subfolders.push(full);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.fs') continue;
      const text = await readShader(full, byteLimit);
      if (text === null) continue;
      const vertexPath = full.slice(0, -3) + '.vs';
      const vertex = (await readShader(vertexPath, byteLimit)) ?? (await readShader(full.slice(0, -3) + '.VS', byteLimit)) ?? '';
      results.push({ name: entry.name, path: full, text, vertex, assets: await readAssets(full, text) });
    }
    for (const subfolder of subfolders) {
      if (results.length >= fileLimit) return;
      await visit(subfolder, depth + 1);
    }
  };
  await visit(root, 0);
  return results.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

module.exports = { scanISFFolder };
