// Rebuilds a native bridge for this Electron version and installs it in
// electron/native: `link` (Ableton Link, native/link) or `video` (Spout and
// NDI, native/video). Needs Visual Studio C++ build tools and Python. A loaded
// copy cannot be overwritten on Windows, so a locked file is moved aside first.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, renameSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES = { link: 'prism_link', video: 'prism_video' };
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MODULES);
const unknown = names.filter(name => !MODULES[name]);
if (unknown.length) throw new Error(`Unknown native module: ${unknown.join(', ')} (expected ${Object.keys(MODULES).join(', ')})`);

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const electronVersion = JSON.parse(readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const name of names) {
  const target = MODULES[name];
  execFileSync(npx, ['--yes', 'node-gyp@11', 'rebuild', `--target=${electronVersion}`, '--arch=x64', '--dist-url=https://electronjs.org/headers'],
    { cwd: path.join(root, 'native', name), stdio: 'inherit', shell: process.platform === 'win32' });
  const installed = path.join(root, 'electron', 'native', `${target}.node`);
  if (existsSync(installed)) {
    try { renameSync(installed, path.join(path.dirname(installed), `stale-${Date.now()}.node`)); } catch { /* not locked */ }
  }
  copyFileSync(path.join(root, 'native', name, 'build', 'Release', `${target}.node`), installed);
  console.log(`Installed ${installed} for Electron ${electronVersion}.`);
}
