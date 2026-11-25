// Turns the packaged app into one archive for a GitHub release: PrismVJ plus
// FFmpeg/ffprobe (for MOV, image sequence and audio import) and the
// licenses of everything shipped inside it. Run after `npm run package`.
// Windows gets a zip; Linux gets a tar.gz (which keeps the executable bits)
// with a start script that copes with Chromium's sandbox requirements.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'release', 'prismvj');
const platform = process.env.PRISM_PLATFORM || process.platform;
const arch = process.env.PRISM_ARCH || process.arch;
const windows = platform === 'win32';
const appName = `PrismVJ-${platform}-${arch}`;
const appDir = path.join(releaseDir, appName);
const exe = name => windows ? `${name}.exe` : name;
if (!existsSync(path.join(appDir, exe('PrismVJ')))) throw new Error(`No packaged app at ${appDir}. Run npm run package first.`);
// On CI (GitHub Actions sets CI=true) a release missing FFmpeg or a license is an error, not a warning.
const strict = !!process.env.CI;
function missing(message) {
  if (strict) throw new Error(message);
  console.warn(message);
}

// On Linux only an explicit PRISM_FFMPEG_PATH is bundled: a distribution's
// /usr/bin/ffmpeg depends on shared libraries that would not come along, and
// the packaged app already falls back to the ffmpeg on PATH.
function findFfmpegDir() {
  const explicit = process.env.PRISM_FFMPEG_PATH;
  const candidates = [
    ...(explicit ? [path.dirname(explicit)] : []),
    ...(windows ? ['C:\\ffmpeg\\bin', ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean)] : []),
  ];
  return candidates.find(dir => existsSync(path.join(dir, exe('ffmpeg'))) && existsSync(path.join(dir, exe('ffprobe'))));
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
    if (file === exe('ffmpeg') || file === exe('ffprobe') || (windows && file.toLowerCase().endsWith('.dll'))) copyFileSync(path.join(ffmpegDir, file), path.join(tools, file));
  }
  if (!windows) for (const name of ['ffmpeg', 'ffprobe']) chmodSync(path.join(tools, name), 0o755);
  const ffmpegLicense = [path.join(ffmpegDir, 'LICENSE.txt'), path.join(ffmpegDir, '..', 'LICENSE.txt'), path.join(ffmpegDir, '..', 'LICENSE')].find(existsSync);
  if (ffmpegLicense) copyFileSync(ffmpegLicense, path.join(licenses, 'FFmpeg-LICENSE.txt'));
  else missing(`No FFmpeg license found beside ${ffmpegDir}.`);
  console.log(`Bundled FFmpeg from ${ffmpegDir}`);
} else {
  missing(windows
    ? 'FFmpeg not found (set PRISM_FFMPEG_PATH). The bundle will play HAP/DXV and web formats but cannot convert other MOV codecs.'
    : 'FFmpeg not bundled (set PRISM_FFMPEG_PATH to a static build). The app will use the ffmpeg on PATH if there is one.');
}

const notices = [
  [path.join(root, 'LICENSE'), 'PrismVJ-LICENSE.txt'],
  [path.join(path.dirname(createRequire(import.meta.url).resolve('electron/package.json')), 'dist', 'LICENSE'), 'Electron-LICENSE.txt'],
  [path.join(root, 'native', 'link', 'vendor', 'LICENSE.md'), 'AbletonLink-LICENSE.md'],
  [path.join(root, 'native', 'link', 'vendor', 'GNU-GPL-v2.0.md'), 'AbletonLink-GNU-GPL-v2.0.md'],
];
// The Ableton Link notices come from the native/link/vendor submodule (git submodule update --init).
for (const [from, to] of notices) {
  if (existsSync(from)) copyFileSync(from, path.join(licenses, to));
  else missing(`Missing ${path.relative(root, from)}; ${to} is not in the bundle.`);
}
// Notices for code PrismVJ adapts (kept in the repository's licenses folder).
const ownLicenses = path.join(root, 'licenses');
if (existsSync(ownLicenses)) for (const file of readdirSync(ownLicenses)) copyFileSync(path.join(ownLicenses, file), path.join(licenses, file));
// electron-packager puts Electron's license at the top level; the top-level LICENSE should be PrismVJ's own.
if (existsSync(path.join(root, 'LICENSE'))) copyFileSync(path.join(root, 'LICENSE'), path.join(appDir, 'LICENSE'));

if (!windows) {
  // Chromium's sandbox needs unprivileged user namespaces or a setuid-root
  // chrome-sandbox. Ubuntu 24.04 and later restrict user namespaces, and an
  // extracted archive cannot carry a root-owned setuid file, so the start
  // script falls back to --no-sandbox when neither is available.
  const launcher = path.join(appDir, 'prismvj.sh');
  writeFileSync(launcher, `#!/bin/sh
# Starts PrismVJ. Chromium's sandbox needs either unprivileged user namespaces
# or a root-owned setuid chrome-sandbox helper. When neither is available
# (Ubuntu 24.04 and later restrict user namespaces), PrismVJ starts with
# --no-sandbox. To keep the sandbox in that case, run once in this folder:
#   sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
here="$(dirname "$(readlink -f "$0")")"
helper="$here/chrome-sandbox"
if [ -u "$helper" ] && [ "$(stat -c %u "$helper" 2>/dev/null)" = "0" ]; then
  exec "$here/PrismVJ" "$@"
fi
restricted="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)"
if [ "$restricted" != "1" ] && command -v unshare >/dev/null 2>&1 && unshare --user --map-root-user true 2>/dev/null; then
  exec "$here/PrismVJ" "$@"
fi
exec "$here/PrismVJ" --no-sandbox "$@"
`);
  chmodSync(launcher, 0o755);
}

const archive = path.join(root, 'release', windows ? `PrismVJ-${version}-win-${arch}.zip` : `PrismVJ-${version}-${platform}-${arch}.tar.gz`);
rmSync(archive, { force: true });
// Windows 10+ ships bsdtar, which writes zip archives with -a; elsewhere the
// system tar writes a gzip tarball that keeps file modes.
const tar = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const args = windows ? ['-a', '-c', '-f', archive, '-C', releaseDir, appName] : ['-czf', archive, '-C', releaseDir, appName];
const result = spawnSync(tar, args, { stdio: 'inherit' });
if (result.status !== 0) throw new Error(`tar failed with exit code ${result.status}`);
console.log(`Wrote ${path.relative(root, archive)} (${(statSync(archive).size / 1048576).toFixed(0)} MB)`);
