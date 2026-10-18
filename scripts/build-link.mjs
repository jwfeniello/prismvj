// Rebuilds the Ableton Link bridge (native/link) for this Electron version
// and installs it at electron/native/prism_link.node. Needs Visual Studio
// C++ build tools and Python. A loaded copy cannot be overwritten on Windows,
// so a locked file is moved aside first.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, renameSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const electronVersion = JSON.parse(readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
execFileSync(npx, ['--yes', 'node-gyp@11', 'rebuild', `--target=${electronVersion}`, '--arch=x64', '--dist-url=https://electronjs.org/headers'],
  { cwd: path.join(root, 'native', 'link'), stdio: 'inherit', shell: process.platform === 'win32' });
const target = path.join(root, 'electron', 'native', 'prism_link.node');
if (existsSync(target)) {
  try { renameSync(target, path.join(path.dirname(target), `stale-${Date.now()}.node`)); } catch { /* not locked */ }
}
copyFileSync(path.join(root, 'native', 'link', 'build', 'Release', 'prism_link.node'), target);
console.log(`Installed ${target} for Electron ${electronVersion}.`);
