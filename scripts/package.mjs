// Packages PrismVJ for Windows. Uses electron-packager's API directly:
// npm runs scripts through cmd.exe, which strips the "^" anchors that CLI
// --ignore patterns need. The Ableton Link module ships beside app.asar.
import { packager } from '@electron/packager';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = process.argv[2] || 'release/prismvj';
const tmpdir = path.resolve(root, '..', 'resolume-data', 'packager-tmp');
mkdirSync(tmpdir, { recursive: true });
const link = path.join(root, 'electron', 'native', 'prism_link.node');

// Antivirus scanners briefly lock the freshly written exe, which makes the
// packager's final move fail with EPERM. Finish that move after a short wait.
async function finishMove(error) {
  const match = /rename '([^']+)' -> '([^']+)'/.exec(error?.message || '');
  if (error?.code !== 'EPERM' || !match) throw error;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try { renameSync(match[1], match[2]); return [match[2]]; } catch (retry) { if (retry.code !== 'EPERM') throw retry; }
  }
  throw error;
}

const paths = await packager({
  dir: root, name: 'PrismVJ', platform: 'win32', arch: 'x64', out: path.join(root, out), overwrite: true, tmpdir,
  ignore: [/^\/release($|\/)/, /^\/\.git/, /^\/tests($|\/)/, /^\/docs($|\/)/, /^\/test-results($|\/)/, /^\/native($|\/)/, /^\/electron\/native($|\/)/],
  extraResource: existsSync(link) ? [link] : [],
}).catch(finishMove);
console.log(`Wrote new app to: ${path.relative(root, paths[0])}${existsSync(link) ? ' (with Ableton Link)' : ' (Ableton Link not built)'}`);
