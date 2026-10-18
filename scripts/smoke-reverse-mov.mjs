import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { createClip, createLayer, createProject } from '../src/model.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = process.argv[2] && process.argv[2] !== '-' ? path.resolve(process.argv[2]) : null;
const source = process.argv[3] ? path.resolve(process.argv[3]) : 'C:\\Program Files\\Resolume Arena\\media\\Shop74\\BattleWeapon_Tank_09.mov';
const expectedAlpha = !process.argv.includes('--opaque');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-reverse-mov-'));
const profile = path.join(temporary, 'profile');
let application;
try {
  await mkdir(profile);
  const env = { ...process.env, PRISM_HEADLESS: '1', PRISM_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PRISM_DEV_URL;
  application = await electron.launch({ ...(executable ? { executablePath: executable } : {}),
    args: [...(executable ? [] : [root]), '--autoplay-policy=no-user-gesture-required'],
    cwd: executable ? temporary : root, env, timeout: 30000 });
  const page = await application.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => typeof prismDiagnostics === 'function');
  assert.ok(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())), 'Test windows must remain hidden.');

  const [media] = await page.evaluate(file => desktop.importPaths([file]), source);
  assert.equal(media.error, undefined, media.error);
  assert.equal(media.hasAlpha, expectedAlpha);
  const urls = await page.evaluate(async ({ url, expectedAlpha }) => {
    const result = {};
    for (const [kind, query, type] of [['forward', '', expectedAlpha ? 'video/webm' : 'video/mp4'], ['reverse', '?reverse=1', expectedAlpha ? 'video/webm' : 'video/mp4'], ['thumbnail', '?thumbnail=1', 'image/jpeg']]) {
      const response = await fetch(url + query, { headers: { Range: 'bytes=0-31' } });
      result[kind] = { status: response.status, type: response.headers.get('content-type'), bytes: [...new Uint8Array(await response.arrayBuffer())] };
      if (!result[kind].type?.startsWith(type)) throw new Error(`${kind} has the wrong media type: ${result[kind].type}`);
    }
    return result;
  }, { url: media.url, expectedAlpha });
  for (const value of Object.values(urls)) assert.equal(value.status, 206);
  if (expectedAlpha) {
    assert.deepEqual(urls.forward.bytes.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3]);
    assert.deepEqual(urls.reverse.bytes.slice(0, 4), [0x1a, 0x45, 0xdf, 0xa3]);
  } else {
    assert.equal(String.fromCharCode(...urls.forward.bytes.slice(4, 8)), 'ftyp');
    assert.equal(String.fromCharCode(...urls.reverse.bytes.slice(4, 8)), 'ftyp');
  }
  assert.deepEqual(urls.thumbnail.bytes.slice(0, 3), [255, 216, 255]);

  const project = createProject();
  project.name = 'Reverse MOV check'; project.width = 160; project.height = 90;
  project.decks = [project.decks[0]]; project.columns = 2;
  const background = createClip('source', { name: 'Green', source: 'solid', color: '#00ff00' });
  const foreground = createClip('video', { ...media, duration: 3, videoDuration: 3, loop: 'loop' });
  project.layers = [createLayer('Background'), createLayer('Footage')];
  for (const [index, clip] of [background, foreground].entries()) {
    project.layers[index].clips[project.selectedDeckId] = [clip, null];
    project.layers[index].activeClipId = clip.id;
  }
  const projectPath = path.join(temporary, 'reverse.prism');
  await writeFile(projectPath, JSON.stringify(project));
  await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, projectPath);
  await page.locator('#open-project').click();
  await page.waitForFunction(name => prismDiagnostics().project.name === name, project.name);
  const slot = page.locator(`.clip-slot[data-clip="${foreground.id}"]`);
  const image = slot.locator('.clip-art img');
  await page.waitForFunction(id => {
    const element = document.querySelector(`.clip-slot[data-clip="${id}"] .clip-art img`);
    return element?.complete && element.naturalWidth > 0;
  }, foreground.id);
  assert.equal(await image.count(), 1, 'The MOV deck slot needs a preview image.');
  await slot.click({ button: 'right' });
  await page.waitForFunction(id => {
    const data = prismDiagnostics();
    return data.frames.some(frame => frame.clipId === id && frame.time > 1.2 && frame.time < 2.5)
      && data.voices.some(voice => voice.clipId === id && voice.mediaPaused === false);
  }, foreground.id, { timeout: 15000 });
  await page.locator('[data-inspector-panel="clip"] [data-direction="-1"]').click();
  await page.waitForFunction(id => {
    const data = prismDiagnostics();
    return data.frames.some(frame => frame.clipId === id && frame.direction === -1)
      && data.voices.some(voice => voice.clipId === id && voice.mediaPaused === false);
  }, foreground.id, { timeout: 5000 });
  const samples = [];
  for (let attempt = 0; attempt < 14; attempt++) {
    samples.push(await page.evaluate(id => {
      const data = prismDiagnostics();
      const frame = data.frames.find(frame => frame.clipId === id);
      const voice = data.voices.find(voice => voice.clipId === id);
      const canvas = document.querySelector('#output-canvas'), gl = canvas.getContext('webgl2'), pixel = new Uint8Array(4), values = [];
      for (let y = 1; y < 8; y++) for (let x = 1; x < 14; x++) {
        gl.readPixels(Math.floor(canvas.width*x/14), Math.floor(canvas.height*y/8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        values.push(...pixel.slice(0, 3));
      }
      return { time: frame?.time, mediaTime: voice?.mediaTime, mediaPaused: voice?.mediaPaused, signature: values.join(',') };
    }, foreground.id));
    if (new Set(samples.map(sample => sample.signature)).size >= 3
      && samples.some((sample, index) => index && sample.time < samples[index-1].time - .1 && sample.mediaTime > samples[index-1].mediaTime + .1)) break;
    await page.waitForTimeout(400);
  }
  assert.ok(samples.every(sample => sample.mediaPaused === false), 'The reverse MOV decoder must keep playing.');
  assert.ok(new Set(samples.map(sample => sample.signature)).size >= 3, 'Composition pixels must animate in reverse.');
  assert.ok(samples.some((sample, index) => index && sample.time < samples[index-1].time - .1 && sample.mediaTime > samples[index-1].mediaTime + .1),
    `The reverse decoder must advance while the transport moves backward: ${JSON.stringify(samples.map(({time,mediaTime}) => ({time,mediaTime})))}`);

  let thumbnails = 0;
  if (expectedAlpha) {
    await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, path.dirname(source));
    await page.locator('[data-browser="files"]').click();
    await page.locator('#choose-folder').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.file-entry .file-thumb')].filter(image => image.complete && image.naturalWidth > 0).length >= 10,
      null, { timeout: 30000 });
    thumbnails = await page.locator('.file-entry .file-thumb').count();
    assert.ok(thumbnails >= 10, `${thumbnails} browser thumbnails`);
  }
  assert.deepEqual(errors, []);
  console.log('REVERSE_MOV_PASS', JSON.stringify({ packaged: !!executable, file: path.basename(source), uniqueReverseFrames: new Set(samples.map(sample => sample.signature)).size, browserThumbnails: thumbnails, hidden: true }));
} finally {
  await application?.close();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('prism-reverse-mov-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
