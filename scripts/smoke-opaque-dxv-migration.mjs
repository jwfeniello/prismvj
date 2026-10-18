import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import converterModule from '../electron/media-converter.cjs';

// Usage: node scripts/smoke-opaque-dxv-migration.mjs <DXV MOV> <old media-cache>
// Copies the old cache into a disposable profile; the user's cache is untouched.
const { createMediaConverter, cacheKey } = converterModule;
const source = process.argv[2], oldCache = process.argv[3];
if (!source || !oldCache) throw new Error('Pass the opaque DXV source and old media-cache directory.');
const key = cacheKey(source, await stat(source));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-reverse-migration-'));
const cacheDirectory = path.join(temporary, 'cache');
await mkdir(cacheDirectory);
let converter;
try {
  for (const suffix of ['.json', '.webm', '.reverse.webm', '.jpg'])
    await copyFile(path.join(oldCache, key + suffix), path.join(cacheDirectory, key + suffix));
  const before = JSON.parse(await readFile(path.join(cacheDirectory, key + '.json')));
  assert.equal(before.hasAlpha, true);
  const oldReverseBytes = (await stat(path.join(cacheDirectory, key + '.reverse.webm'))).size;
  converter = createMediaConverter({ cacheDirectory });
  const prepared = await converter.prepare(source);
  const after = JSON.parse(await readFile(path.join(cacheDirectory, key + '.json')));
  assert.equal(prepared.hasAlpha, false);
  assert.equal(after.hasAlpha, false);
  assert.equal(after.alphaVerified, true);
  assert.equal(after.format, 'mp4');
  assert.ok(prepared.playbackPath.endsWith('.mp4') && prepared.reversePath.endsWith('.mp4'));
  assert.ok((await stat(prepared.reversePath)).size < oldReverseBytes);
  assert.deepEqual(await converter.prepare(source), prepared);
  console.log('OPAQUE_DXV_MIGRATION_PASS', JSON.stringify({ oldReverseBytes, reverseBytes: after.reverseBytes, forwardBytes: after.bytes }));
} finally {
  await converter?.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
