import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dgram from 'node:dgram';
import { _electron as electron } from '@playwright/test';
import { createProject, createClip } from '../src/model.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = path.join(root, 'tests', 'engine-fixture.webm');

test('native desktop media, persistence, recovery, output, OSC and streaming recording', { timeout: 120000 }, async t => {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Run npm run build before desktop integration tests.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-desktop-'));
  const profile = path.join(temporary, 'profile');
  await mkdir(path.join(profile, 'recovery'), { recursive: true });
  const recovery = createProject(); recovery.name = 'Preserved previous session';
  const previous = path.join(profile, 'recovery', 'recovery-previous.prism');
  await writeFile(previous, JSON.stringify(recovery));
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PRISM_DEV_URL;
  let application;
  let imported;
  let page;
  const project = createProject(); project.name = 'Desktop verification';
  try {
    application = await electron.launch({ args: [root, '--autoplay-policy=no-user-gesture-required'], cwd: root, env, timeout: 30000 });
    page = await application.firstWindow();
    await page.waitForFunction(() => window.desktop && window.prismDiagnostics);
    // Startup recovery is a renderer dialog. Dismiss it without loading the old project.
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    if (await cancel.count()) await cancel.click();

    await t.test('isolated, hidden application and trusted MIDI access', async () => {
      const state = await application.evaluate(({ app, BrowserWindow }) => ({
        userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), fullscreen: window.isFullScreen() })),
      }));
      assert.equal(state.userData, profile);
      assert.ok(state.windows.every(window => !window.visible && !window.fullscreen));
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      const midi = await page.evaluate(async () => {
        try { const access = await navigator.requestMIDIAccess({ sysex: false }); return { success: true, inputs: access.inputs.size }; }
        catch (error) { return { success: false, error: error.name + ': ' + error.message }; }
      });
      assert.equal(midi.success, true, midi.error);
    });

    await t.test('native media registration, byte ranges and video seeking', async () => {
      [imported] = await page.evaluate(paths => desktop.importPaths(paths), [fixture]);
      assert.equal(imported.kind, 'video');
      assert.match(imported.url, /^prism-media:\/\/media\/[a-z0-9-]+\//);
      const byteRange = await page.evaluate(async url => {
        const response = await fetch(url, { headers: { Range: 'bytes=12-31' } });
        return { status: response.status, range: response.headers.get('content-range'), bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, imported.url);
      const source = await readFile(fixture);
      assert.equal(byteRange.status, 206);
      assert.equal(byteRange.range, `bytes 12-31/${source.length}`);
      assert.deepEqual(byteRange.bytes, [...source.subarray(12, 32)]);
      const seek = await page.evaluate(async url => {
        const video = document.createElement('video'); video.muted = true; video.crossOrigin = 'anonymous'; video.src = url; document.body.append(video);
        const wait = event => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Video ${event} timeout`)), 10000);
          video.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
          video.addEventListener('error', () => { clearTimeout(timer); reject(new Error(video.error?.message || 'Decode failed')); }, { once: true });
        });
        await wait('loadeddata');
        const duration = video.duration;
        const target = Math.min(1.2, duration / 2);
        const seeking = wait('seeked'); video.currentTime = target; await seeking;
        const result = { duration, target, actual: video.currentTime, width: video.videoWidth };
        video.removeAttribute('src'); video.load(); video.remove(); return result;
      }, imported.url);
      assert.ok(seek.width > 0);
      assert.ok(Math.abs(seek.actual - seek.target) < 0.03, JSON.stringify(seek));
      assert.equal(await page.evaluate(async () => (await fetch('prism-media://media/not-authorized/secret.mp4')).status), 404);
    });

    await t.test('project save/open, fresh session URL and reset save destination', async () => {
      project.layers[0].clips[project.selectedDeckId][0] = createClip('video', { ...imported, name: 'Media fixture' });
      const destination = path.join(temporary, 'saved.prism');
      await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
      assert.deepEqual(await page.evaluate(value => desktop.saveProject(value, true), project), { path: destination });
      const saved = JSON.parse(await readFile(destination, 'utf8'));
      assert.equal(saved.layers[0].clips[saved.selectedDeckId][0].path, fixture);
      assert.equal(saved.layers[0].clips[saved.selectedDeckId][0].url, '');
      await application.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, destination);
      const reopened = await page.evaluate(() => desktop.openProject());
      assert.equal(reopened.project.name, project.name);
      assert.match(reopened.project.layers[0].clips[project.selectedDeckId][0].url, /^prism-media:/);
      const nextDestination = path.join(temporary, 'new.prism');
      await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, nextDestination);
      await page.evaluate(() => desktop.resetProjectPath());
      assert.equal((await page.evaluate(value => desktop.saveProject(value, false), project)).path, nextDestination);
      const bad = path.join(temporary, 'bad.prism'); await writeFile(bad, '{broken');
      await application.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, bad);
      assert.match(await page.evaluate(async () => { try { await desktop.openProject(); return ''; } catch (error) { return error.message; } }), /JSON|Unexpected|Expected/);
      assert.equal((await page.evaluate(value => desktop.saveProject(value, false), project)).path, nextDestination, 'failed open must not change save path');
    });

    await t.test('autosave does not overwrite previous or corrupt recovery', async () => {
      await page.evaluate(value => desktop.autosave(value), project);
      assert.equal(JSON.parse(await readFile(previous, 'utf8')).name, recovery.name);
      const corrupt = path.join(profile, 'recovery', 'recovery-corrupt.prism');
      await writeFile(corrupt, 'broken recovery');
      const future = new Date(Date.now() + 2000); await utimes(corrupt, future, future);
      const restored = await page.evaluate(() => desktop.recoverProject());
      assert.equal(restored.name, recovery.name);
      assert.equal(await readFile(corrupt, 'utf8'), 'broken recovery');
      const files = await readdir(path.join(profile, 'recovery'));
      assert.ok(files.length >= 3);
      assert.ok(files.every(file => !file.endsWith('.tmp')));
    });

    await t.test('separate output window and bounded IPC frame bridge', async () => {
      const displays = await page.evaluate(() => desktop.getDisplays());
      assert.ok(displays.length > 0 && displays[0].width > 0);
      await page.evaluate(id => desktop.openOutput(id), displays[0].id);
      const output = application.windows().find(window => new URL(window.url()).searchParams.has('output'));
      assert.ok(output);
      output.on('pageerror', error => console.log('OUTPUT_ERROR', error.message));
      await output.waitForFunction(() => window.desktop);
      await output.waitForFunction(() => document.querySelector('canvas').width === 1280, null, { timeout: 5000 });
      const livePixel = await output.evaluate(() => [...document.querySelector('canvas').getContext('2d').getImageData(640, 360, 1, 1).data]);
      assert.ok(livePixel[0] + livePixel[1] + livePixel[2] > 0, 'The live publisher produces visible output.');
      // Keep the real output window open while suspending the application's
      // automatic publisher so it cannot replace the known fixture mid-assertion.
      await application.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find(window => !new URL(window.webContents.getURL()).searchParams.has('output')).webContents.send('prism:output-state', false);
      });
      await output.evaluate(() => { window.testFrame = null; desktop.onOutputFrame(bytes => { window.testFrame = [...bytes]; }); });
      const encoded = await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
        const context = canvas.getContext('2d'); context.fillStyle = '#ff0000'; context.fillRect(0, 0, 4, 4);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 1));
        return [...new Uint8Array(await blob.arrayBuffer())];
      });
      await page.evaluate(data => desktop.sendOutputFrame(new Uint8Array(data).buffer), encoded);
      await output.waitForFunction(() => window.testFrame);
      assert.deepEqual(await output.evaluate(() => window.testFrame), encoded);
      await output.waitForFunction(() => document.querySelector('canvas').width === 4, null, { timeout: 5000 });
      const pixel = await output.evaluate(() => [...document.querySelector('canvas').getContext('2d').getImageData(1, 1, 1, 1).data]);
      assert.ok(pixel[0] > 245 && pixel[1] < 10 && pixel[2] < 10 && pixel[3] === 255, JSON.stringify(pixel));
      await output.evaluate(() => {
        window.heldFrames = 0;
        const hold = new Promise(resolve => { window.releaseFrame = resolve; });
        window.stopHolding = desktop.onOutputFrame(async () => { heldFrames++; await hold; });
      });
      await page.evaluate(data => desktop.sendOutputFrame(new Uint8Array(data).buffer), encoded);
      await output.waitForFunction(() => window.heldFrames === 1);
      await page.evaluate(data => desktop.sendOutputFrame(new Uint8Array(data).buffer), encoded);
      assert.equal(await output.evaluate(() => new Promise(resolve => setTimeout(() => resolve(window.heldFrames), 75))), 1, 'A fast observer must not release backpressure before a slow consumer.');
      await output.evaluate(() => { releaseFrame(); stopHolding(); });
      assert.ok((await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.isVisible()))).every(visible => !visible));
      await page.evaluate(() => desktop.closeOutput());
      assert.equal(await page.evaluate(() => desktop.outputStatus()), false);
    });

    await t.test('actual OSC UDP receive and malformed-packet rejection', async () => {
      const allocator = dgram.createSocket('udp4');
      await new Promise(resolve => allocator.bind(0, '127.0.0.1', resolve));
      const port = allocator.address().port;
      await new Promise(resolve => allocator.close(resolve));
      await page.evaluate(() => { window.testControls = []; desktop.onControl(message => testControls.push(message)); });
      assert.equal((await page.evaluate(port => desktop.startOSC(port), port)).active, true);
      const string = value => { const data = Buffer.alloc(Math.ceil((Buffer.byteLength(value) + 1) / 4) * 4); data.write(value); return data; };
      const amount = Buffer.alloc(4); amount.writeFloatBE(0.25);
      const packet = Buffer.concat([string('/layer1/video/opacity/values'), string(',f'), amount]);
      const sender = dgram.createSocket('udp4');
      try {
        await new Promise((resolve, reject) => sender.send(packet, port, '127.0.0.1', error => error ? reject(error) : resolve()));
        await new Promise((resolve, reject) => sender.send(Buffer.from('invalid'), port, '127.0.0.1', error => error ? reject(error) : resolve()));
        await page.waitForFunction(() => window.testControls.length === 1);
        assert.equal((await page.evaluate(() => window.testControls[0])).args[0], 0.25);
        await page.waitForFunction(async () => (await desktop.oscStatus()).rejected >= 1);
        assert.equal((await page.evaluate(() => desktop.stopOSC())).active, false);
      } finally { sender.close(); }
    });

    await t.test('stream recording chunks atomically into independently decodable media', async () => {
      const destination = path.join(temporary, 'recorded.webm');
      await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
      const record = await page.evaluate(() => desktop.beginRecording());
      assert.equal(record.path, destination);
      const bytes = await readFile(fixture);
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        await page.evaluate(async ({ id, data }) => desktop.writeRecordingChunk(id, new Uint8Array(data).buffer), { id: record.id, data: [...bytes.subarray(offset, offset + 4096)] });
      }
      assert.equal(await page.evaluate(id => desktop.finishRecording(id), record.id), destination);
      assert.deepEqual(await readFile(destination), bytes);
      assert.equal((await readdir(temporary)).filter(file => file.endsWith('.part')).length, 0);
      const [savedMedia] = await page.evaluate(paths => desktop.importPaths(paths), [destination]);
      const duration = await page.evaluate(url => new Promise((resolve, reject) => {
        const video = document.createElement('video'); video.src = url;
        const timer = setTimeout(() => reject(new Error('Recorded media decode timeout')), 10000);
        video.onloadedmetadata = () => { clearTimeout(timer); const duration = video.duration; video.removeAttribute('src'); video.load(); resolve(duration); };
        video.onerror = () => { clearTimeout(timer); reject(new Error('Recorded media is not decodable')); };
      }), savedMedia.url);
      assert.ok(duration > 0);
    });

    await t.test('reports actual hidden-window GPU and demo performance', async () => {
      const gpu = await application.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic') }));
      const performance = await page.evaluate(async () => {
        const start = performance.now(); let last = start; const intervals = [];
        await new Promise(resolve => {
          const sample = timestamp => { intervals.push(timestamp - last); last = timestamp; if (timestamp - start >= 5000) resolve(); else requestAnimationFrame(sample); };
          requestAnimationFrame(sample);
        });
        intervals.shift(); intervals.sort((a, b) => a - b);
        const diagnostics = window.prismDiagnostics();
        return { hidden: document.hidden, width: diagnostics.project.width, height: diagnostics.project.height,
          activeLayers: diagnostics.frames.length, stats: diagnostics.stats, sampleFrames: intervals.length,
          meanFrameMs: intervals.reduce((sum, value) => sum + value, 0) / intervals.length,
          p95FrameMs: intervals[Math.floor(intervals.length * 0.95)] };
      });
      assert.ok(performance.sampleFrames > 0);
      const rendering = await page.evaluate(async ({ engineURL, project }) => {
        const { LiveEngine } = await import(engineURL);
        const canvas = document.createElement('canvas'); const engine = new LiveEngine(canvas);
        engine.resize(project.width, project.height);
        const samples = [];
        try {
          for (let index = 0; index < 70; index++) {
            const time = index / 60;
            const frames = project.layers.map(layer => {
              const clip = layer.clips[project.selectedDeckId][0];
              return { layer, clip, time, position: time / clip.duration, weight: 1 };
            });
            const start = window.performance.now();
            engine.render(project, frames, time);
            engine.gl.finish();
            if (index >= 10) samples.push(window.performance.now() - start);
          }
          samples.sort((a, b) => a - b);
          return { renderer: engine.getStats().renderer, width: project.width, height: project.height,
            layers: project.layers.length, completedFrames: samples.length,
            meanCompletedFrameMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
            p95CompletedFrameMs: samples[Math.floor(samples.length * 0.95)], glError: engine.gl.getError() };
        } finally { engine.dispose(); }
      }, { engineURL: pathToFileURL(path.join(root, 'src', 'engine.js')).href, project: createProject() });
      assert.equal(rendering.glError, 0);
      console.log('DESKTOP_GPU_EVIDENCE', JSON.stringify({ gpu, performance, rendering }));
    });
  } finally {
    await application?.close();
    // Resolve and validate the exact test-owned target before recursive cleanup.
    const resolved = path.resolve(temporary);
    assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('prism-desktop-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
