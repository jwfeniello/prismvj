// Packages Prism Live for Windows. Uses electron-packager's API directly:
// npm runs scripts through cmd.exe, which strips the "^" anchors that CLI
// --ignore patterns need. The Ableton Link module ships beside app.asar.
import { packager } from '@electron/packager';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = process.argv[2] || 'release/resolume-transports';
const tmpdir = path.resolve(root, '..', 'resolume-data', 'packager-tmp');
mkdirSync(tmpdir, { recursive: true });
const link = path.join(root, 'electron', 'native', 'prism_link.node');

const paths = await packager({
  dir: root, name: 'PrismLive', platform: 'win32', arch: 'x64', out: path.join(root, out), overwrite: true, tmpdir,
  ignore: [/^\/release($|\/)/, /^\/\.git/, /^\/tests($|\/)/, /^\/docs($|\/)/, /^\/test-results($|\/)/, /^\/native($|\/)/, /^\/electron\/native($|\/)/],
  extraResource: existsSync(link) ? [link] : [],
});
console.log(`Wrote new app to: ${path.relative(root, paths[0])}${existsSync(link) ? ' (with Ableton Link)' : ' (Ableton Link not built)'}`);
