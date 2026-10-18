// Turns the packaged app into one zip for a GitHub release: PrismVJ plus
// FFmpeg/ffprobe (for MOV, image sequence and audio import) and the
// licenses of everything shipped inside it. Run after `npm run package`.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'release', 'prismvj');
const appDir = path.join(releaseDir, 'PrismVJ-win32-x64');
if (!existsSync(path.join(appDir, 'PrismVJ.exe'))) throw new Error(`No packaged app at ${appDir}. Run npm run package first.`);

function findFfmpegDir() {
  const explicit = process.env.PRISM_FFMPEG_PATH;
  const candidates = [
    ...(explicit ? [path.dirname(explicit)] : []),
    'C:\ffmpeg\bin',
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
  ];
  return candidates.find(dir => existsSync(path.join(dir, 'ffmpeg.exe')) && existsSync(path.join(dir, 'ffprobe.exe')));
}

const tools = path.join(appDir, 'resources', 'tools');
const licenses = path.join(appDir, 'licenses');
rmSync(tools, { recursive: true, force: true });
rmSync(licenses, { recursive: true, force: true });
mkdirSync(licenses, { recursive: true });

const ffmpegDir = findFfmpegDir();
if (ffmpegDir) {
  mkdirSync(tools, { recursive: true });
  // Shared builds need their DLLs beside the executables; static builds have none.
  for (const file of readdirSync(ffmpegDir)) {
    if (file === 'ffmpeg.exe' || file === 'ffprobe.exe' || file.toLowerCase().endsWith('.dll')) copyFileSync(path.join(ffmpegDir, file), path.join(tools, file));
  }
  const ffmpegLicense = [path.join(ffmpegDir, 'LICENSE.txt'), path.join(ffmpegDir, '..', 'LICENSE.txt'), path.join(ffmpegDir, '..', 'LICENSE')].find(existsSync);
  if (ffmpegLicense) copyFileSync(ffmpegLicense, path.join(licenses, 'FFmpeg-LICENSE.txt'));
  console.log(`Bundled FFmpeg from ${ffmpegDir}`);
} else {
  console.warn('FFmpeg not found (set PRISM_FFMPEG_PATH). The bundle will play HAP/DXV and web formats but cannot convert other MOV codecs.');
}

const notices = [
  [path.join(root, 'LICENSE'), 'PrismVJ-LICENSE.txt'],
  [path.join(root, 'node_modules', 'electron', 'dist', 'LICENSE'), 'Electron-LICENSE.txt'],
  [path.join(root, 'native', 'link', 'vendor', 'LICENSE.md'), 'AbletonLink-LICENSE.md'],
  [path.join(root, 'native', 'link', 'vendor', 'GNU-GPL-v2.0.md'), 'AbletonLink-GNU-GPL-v2.0.md'],
];
for (const [from, to] of notices) if (existsSync(from)) copyFileSync(from, path.join(licenses, to));
// electron-packager puts Electron's license at the top level; the top-level LICENSE should be PrismVJ's own.
if (existsSync(path.join(root, 'LICENSE'))) copyFileSync(path.join(root, 'LICENSE'), path.join(appDir, 'LICENSE'));

const zip = path.join(root, 'release', `PrismVJ-${version}-win-x64.zip`);
rmSync(zip, { force: true });
// Windows 10+ ships bsdtar, which writes zip archives with -a.
const tar = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe');
const result = spawnSync(tar, ['-a', '-c', '-f', zip, '-C', releaseDir, 'PrismVJ-win32-x64'], { stdio: 'inherit' });
if (result.status !== 0) throw new Error(`tar failed with exit code ${result.status}`);
console.log(`Wrote ${path.relative(root, zip)} (${(statSync(zip).size / 1048576).toFixed(0)} MB)`);
