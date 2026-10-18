import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { createProject, createClip } from '../src/model.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = path.join(root, 'tests', 'engine-fixture.webm');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const mask = (id, filePath) => ({ id, path: filePath, url: 'blob:expired-mask', enabled: true, invert: true });
const firstClip = project => project.layers[0].clips[project.selectedDeckId][0];

test('native media browser, component persistence and missing-media reconnection', { timeout: 120000 }, async t => {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Run npm run build before desktop integration tests.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-media-desktop-'));
  const profile = path.join(temporary, 'profile');
  const library = path.join(temporary, 'library');
  const replacements = path.join(temporary, 'replacements');
  await mkdir(library, { recursive: true });
  await mkdir(path.join(library, 'Zebra'));
  await mkdir(path.join(library, 'Alpha'));
  await mkdir(path.join(replacements, 'first'), { recursive: true });
  await mkdir(path.join(replacements, 'second'));
  const video = path.join(library, 'Video 2.webm');
  const audio = path.join(library, 'Track.wav');
  const image = path.join(library, 'Mask.png');
  await copyFile(fixture, video);
  await copyFile(fixture, path.join(library, 'Video 10.webm'));
  await writeFile(audio, Buffer.from('RIFFfixture WAVEdata'));
  await writeFile(image, png);
  await writeFile(path.join(library, 'ignore.txt'), 'not media');
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PRISM_DEV_URL;
  let application;
  let page;
  const project = createProject();
  project.name = 'Component persistence';
  project.mask = mask('composition-mask', image);
  project.layers[0].mask = mask('layer-mask', image);
  project.layers[0].clips[project.selectedDeckId][0] = createClip('video', {
    id: 'media-clip', name: 'Linked audiovisual clip', path: video, url: 'blob:expired-video', duration: 3,
    audio: { id: 'audio-component', path: audio, url: 'blob:expired-audio', duration: 7 },
    mask: mask('clip-mask', image),
  });
  try {
    application = await electron.launch({ args: [root, '--autoplay-policy=no-user-gesture-required'], cwd: root, env, timeout: 30000 });
    page = await application.firstWindow();
    await page.waitForFunction(() => window.desktop && window.prismDiagnostics);

    await t.test('test profile and windows stay isolated and hidden', async () => {
      const state = await application.evaluate(({ app, BrowserWindow }) => ({
        profile: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), fullscreen: window.isFullScreen() })),
      }));
      assert.equal(state.profile, profile);
      assert.ok(state.windows.every(window => !window.visible && !window.fullscreen));
    });

    await t.test('roots, sorted folders and media metadata support real navigation', async () => {
      const roots = await page.evaluate(() => desktop.browseRoots());
      assert.ok(roots.length > 0);
      assert.ok(roots.every(entry => entry.kind === 'directory' && path.isAbsolute(entry.path)));
      if (process.platform === 'win32') assert.ok(roots.some(entry => entry.path.toLowerCase() === path.parse(temporary).root.toLowerCase()));
      const directory = await page.evaluate(folder => desktop.browseDirectory(folder), library);
      assert.equal(directory.path, library);
      assert.equal(directory.parent, temporary);
      assert.equal(directory.truncated, false);
      assert.deepEqual(directory.entries.map(entry => entry.name), ['Alpha', 'Zebra', 'Mask.png', 'Track.wav', 'Video 2.webm', 'Video 10.webm']);
      assert.ok(directory.entries.slice(0, 2).every(entry => entry.kind === 'directory' && entry.size === null));
      assert.ok(directory.entries.slice(2).every(entry => entry.size > 0 && entry.modified > 0));
      const parent = await page.evaluate(folder => desktop.browseDirectory(folder), directory.parent);
      assert.ok(parent.entries.some(entry => entry.path === library && entry.kind === 'directory'));
      await assert.rejects(page.evaluate(() => desktop.browseDirectory('../outside')), /absolute local path/);
      await assert.rejects(page.evaluate(file => desktop.browseDirectory(file), video));
      const [imported] = await page.evaluate(file => desktop.importPaths([file]), video);
      assert.equal(imported.kind, 'video');
      assert.match(imported.url, /^prism-media:/);
      const [again] = await page.evaluate(file => desktop.importPaths([file]), video);
      assert.equal(imported.url, again.url, 'Browsing/importing the same media reuses its session token.');
      const range = await page.evaluate(async url => {
        const response = await fetch(url, { headers: { Range: 'bytes=12-31' } });
        return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, imported.url);
      assert.equal(range.status, 206);
      assert.deepEqual(range.bytes, [...(await readFile(video)).subarray(12, 32)]);
    });

    await t.test('large directory result is bounded and signals truncation', async () => {
      const many = path.join(temporary, 'many');
      await mkdir(many);
      for (let index = 0; index < 2005; index += 50) {
        await Promise.all(Array.from({ length: Math.min(50, 2005 - index) }, (_, offset) => writeFile(path.join(many, `mask-${index + offset}.png`), png)));
      }
      const directory = await page.evaluate(folder => desktop.browseDirectory(folder), many);
      assert.equal(directory.entries.length, 2000);
      assert.equal(directory.truncated, true);
      assert.equal(directory.entries[0].name, 'mask-0.png');
      assert.equal(directory.entries.at(-1).name, 'mask-1999.png');
    });

    await t.test('save and reopen restores primary, attached audio and all mask components', async () => {
      const destination = path.join(temporary, 'components.prism');
      await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
      await page.evaluate(value => desktop.saveProject(value, true), project);
      const saved = JSON.parse(await readFile(destination, 'utf8'));
      for (const component of [firstClip(saved), firstClip(saved).audio, firstClip(saved).mask, saved.layers[0].mask, saved.mask]) {
        assert.ok(component.path);
        assert.equal(component.url, '');
      }
      assert.equal(firstClip(saved).audio.duration, 7);
      assert.equal(firstClip(saved).duration, 7);
      await application.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, destination);
      const reopened = await page.evaluate(() => desktop.openProject());
      assert.deepEqual(reopened.missing, []);
      for (const component of [firstClip(reopened.project), firstClip(reopened.project).audio, firstClip(reopened.project).mask, reopened.project.layers[0].mask, reopened.project.mask]) {
        assert.match(component.url, /^prism-media:/);
        assert.equal(await page.evaluate(async url => (await fetch(url)).status, component.url), 200);
      }
      assert.equal(reopened.project.mask.invert, true);
      assert.equal(reopened.project.layers[0].mask.enabled, true);
    });

    await t.test('recovery restores attached media using the same component paths', async () => {
      const recoveryFile = path.join(profile, 'recovery', 'recovery-component-fixture.prism');
      await writeFile(recoveryFile, JSON.stringify(project));
      const recovered = await page.evaluate(() => desktop.recoverProject());
      assert.equal(recovered.name, project.name);
      for (const component of [firstClip(recovered), firstClip(recovered).audio, firstClip(recovered).mask, recovered.layers[0].mask, recovered.mask]) {
        assert.match(component.url, /^prism-media:/);
      }
      assert.equal(firstClip(recovered).audio.path, audio);
      assert.equal(recovered.mask.path, image);
    });

    let broken;
    let linked;
    await t.test('bulk reconnect fixes unique missing names and reports ambiguous components', async () => {
      broken = structuredClone(project);
      firstClip(broken).path = path.join(temporary, 'unavailable', 'Video 2.webm');
      firstClip(broken).audio.path = path.join(temporary, 'unavailable', 'Track.wav');
      firstClip(broken).mask.path = path.join(temporary, 'unavailable', 'clip-mask.png');
      broken.mask.path = path.join(temporary, 'unavailable', 'ambiguous.png');
      broken.layers[0].clips[broken.selectedDeckId][1] = createClip('video', { id: 'unfound-clip', path: path.join(temporary, 'unavailable', 'unfound.webm') });
      await copyFile(video, path.join(replacements, 'Video 2.webm'));
      await copyFile(audio, path.join(replacements, 'Track.wav'));
      await writeFile(path.join(replacements, 'clip-mask.png'), png);
      await writeFile(path.join(replacements, 'Mask.png'), png);
      await writeFile(path.join(replacements, 'first', 'ambiguous.png'), png);
      await writeFile(path.join(replacements, 'second', 'ambiguous.png'), png);
      linked = await page.evaluate(({ project, folder }) => desktop.relinkProject(project, folder), { project: broken, folder: replacements });
      assert.equal(linked.relinked.length, 3);
      assert.equal(firstClip(linked.project).path, path.join(replacements, 'Video 2.webm'));
      assert.equal(firstClip(linked.project).audio.path, path.join(replacements, 'Track.wav'));
      assert.equal(firstClip(linked.project).mask.path, path.join(replacements, 'clip-mask.png'));
      assert.equal(linked.project.layers[0].mask.path, image, 'An existing mask is never redirected to a matching basename.');
      assert.equal(linked.project.mask.path, broken.mask.path);
      assert.equal(linked.ambiguous.length, 1);
      assert.equal(linked.ambiguous[0].component, 'mask');
      assert.equal(linked.ambiguous[0].candidates.length, 2);
      assert.equal(linked.missing.length, 2);
      assert.ok(linked.missing.some(item => item.clipId === 'unfound-clip' && item.component === 'video'));
      assert.equal(linked.scan.truncated, false);
      assert.deepEqual(linked.scan.errors, []);
      assert.ok(firstClip(broken).path.includes('unavailable'), 'Input data stays unchanged.');
    });

    await t.test('explicit reconnect targets one component and rejects mismatched media', async () => {
      const before = structuredClone(linked.project);
      await assert.rejects(page.evaluate(({ project, file }) => desktop.reconnectMedia(project, { component: 'mask', replacementPath: file }), { project: before, file: audio }), /needs image media/);
      const repaired = await page.evaluate(({ project, file }) => desktop.reconnectMedia(project, { component: 'mask', replacementPath: file }),
        { project: before, file: path.join(replacements, 'second', 'ambiguous.png') });
      assert.equal(repaired.relinked.length, 1);
      assert.equal(repaired.relinked[0].previousPath, before.mask.path);
      assert.equal(repaired.project.mask.path, path.join(replacements, 'second', 'ambiguous.png'));
      assert.equal(repaired.project.layers[0].mask.path, before.layers[0].mask.path);
      assert.equal(firstClip(repaired.project).path, firstClip(before).path);
      assert.equal(firstClip(repaired.project).audio.path, firstClip(before).audio.path);
      assert.equal(repaired.missing.length, 1);
      // Selecting reconnect for already available media is harmless.
      const healthy = await page.evaluate(({ project, file }) => desktop.reconnectMedia(project, { clipId: 'media-clip', component: 'audio', replacementPath: file }), { project: repaired.project, file: audio });
      assert.equal(healthy.relinked.length, 0);
      assert.equal(firstClip(healthy.project).audio.path, firstClip(repaired.project).audio.path);
      await assert.rejects(page.evaluate(value => desktop.reconnectMedia(value, { clipId: 'gone', component: 'audio' }), repaired.project), /no longer exists/);
      const missingLayerMask = structuredClone(repaired.project);
      missingLayerMask.layers[0].mask.path = path.join(temporary, 'unavailable', 'layer-mask.png');
      const layerRepaired = await page.evaluate(({ project, file }) => desktop.reconnectMedia(project, {
        layerId: project.layers[0].id, component: 'mask', replacementPath: file,
      }), { project: missingLayerMask, file: image });
      assert.equal(layerRepaired.relinked.length, 1);
      assert.equal(layerRepaired.project.layers[0].mask.path, image);
      assert.equal(layerRepaired.project.mask.path, repaired.project.mask.path);
      assert.equal(firstClip(layerRepaired.project).mask.path, firstClip(repaired.project).mask.path);
    });

    await t.test('deep scan refuses to guess uniqueness when the search is incomplete', async () => {
      const deep = path.join(temporary, 'deep');
      await mkdir(path.join(deep, ...Array(18).fill('child')), { recursive: true });
      await copyFile(video, path.join(deep, 'Video 2.webm'));
      const incomplete = await page.evaluate(({ project, folder }) => desktop.relinkProject(project, folder), { project: broken, folder: deep });
      assert.equal(incomplete.scan.truncated, true);
      assert.equal(incomplete.relinked.length, 0);
      assert.equal(firstClip(incomplete.project).path, firstClip(broken).path);
      assert.ok(incomplete.missing.length > 0);
    });

    await t.test('folder, reconnect and reveal user actions use stubbed dialogs only', async () => {
      await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, library);
      assert.equal(await page.evaluate(() => desktop.chooseMediaDirectory()), library);
      await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, audio);
      const audioRepair = await page.evaluate(value => desktop.reconnectMedia(value, { clipId: 'media-clip', component: 'audio' }), broken);
      assert.equal(firstClip(audioRepair.project).audio.path, audio);
      assert.equal(firstClip(audioRepair.project).path, firstClip(broken).path);
      await application.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
      assert.equal(await page.evaluate(() => desktop.chooseMediaDirectory()), null);
      assert.equal(await page.evaluate(value => desktop.relinkProject(value), broken), null);
      assert.equal(await page.evaluate(value => desktop.reconnectMedia(value, { clipId: 'media-clip', component: 'audio' }), broken), null);
      await application.evaluate(({ shell }) => { globalThis.revealedMedia = null; shell.showItemInFolder = file => { globalThis.revealedMedia = file; }; });
      assert.equal(await page.evaluate(file => desktop.revealInExplorer(file), image), true);
      assert.equal(await application.evaluate(() => globalThis.revealedMedia), image);
      assert.ok(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFullScreen())));
    });
  } finally {
    await application?.close();
    const resolved = path.resolve(temporary);
    assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('prism-media-desktop-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
