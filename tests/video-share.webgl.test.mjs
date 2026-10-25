// The page side of Spout/NDI (src/output/video-share.js) against a stand-in
// for the preload bridge: composition and Advanced Output screen senders get
// top-down BGRA frames of the right size, and received frames reach inputs
// with their buffers recycled.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { sourceFile } from './src-server.mjs';

const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browserAvailable = existsSync(chrome);
let browser, server, baseURL;

before(async () => {
  if (!browserAvailable) return;
  server = createServer((request, response) => {
    const source = sourceFile(request.url);
    response.setHeader('Content-Type', source?.type || 'text/html');
    response.end(source?.body || '<!doctype html><body></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function setup(width = 320, height = 180) {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error('page error:', error.message));
  await page.goto(baseURL);
  await page.evaluate(async ([width, height]) => {
    // The preload's side: senders record what they receive and hand buffers back.
    const fake = window.fake = { frames: [], opened: [], closed: [], next: 0, port: null };
    window.api = {
      status: () => ({ available: true, spout: true, ndi: { available: false } }),
      spoutSenders: () => [], ndiSources: () => [],
      connect() {
        const channel = new MessageChannel();
        fake.port = channel.port1;
        fake.port.onmessage = ({ data }) => {
          if (data.type === 'frame') {
            const bytes = new Uint8Array(data.buffer), at = (x, y) => [...bytes.subarray((y * data.width + x) * 4, (y * data.width + x) * 4 + 4)];
            fake.frames.push({ id: data.id, width: data.width, height: data.height, size: data.buffer.byteLength, top: at(data.width >> 1, 1), bottom: at(data.width >> 1, data.height - 2) });
            fake.port.postMessage({ type: 'returned', id: data.id, buffer: data.buffer }, [data.buffer]);
          } else if (data.type === 'returned') fake.returned = (fake.returned || 0) + 1;
        };
        window.postMessage('prism-video-port', '*', [channel.port2]);
        return true;
      },
      openSender: (kind, name) => { fake.opened.push({ kind, name }); return ++fake.next; },
      openReceiver: (kind, name) => { fake.opened.push({ kind, name, input: true }); return ++fake.next; },
      info: id => ({ id }), close: id => { fake.closed.push(id); return true; },
    };
    const share = await import('/output/video-share.js');
    window.model = await import('/output/output-model.js');
    window.video = await share.connectVideoShare(window.api);
    window.ShareOutputs = share.ShareOutputs;
    // Red top half, blue bottom half.
    const canvas = window.composition = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ff0000'; context.fillRect(0, 0, width, height / 2);
    context.fillStyle = '#0000ff'; context.fillRect(0, height / 2, width, height / 2);
  }, [width, height]);
  return page;
}

const pump = page => page.evaluate(async () => {
  for (let i = 0; i < 40 && window.fake.frames.length < 6; i++) { window.outputs.present(i / 60); await new Promise(resolve => setTimeout(resolve, 20)); }
  return window.fake.frames;
});

test('the composition sender gets top-down BGRA frames', { skip: !browserAvailable }, async () => {
  const page = await setup();
  await page.evaluate(() => { window.outputs = new window.ShareOutputs({ share: window.video, source: window.composition }); window.outputs.setComposition({ spout: 'PrismVJ' }); });
  const frames = await pump(page);
  assert.ok(frames.length >= 3, `${frames.length} frames`);
  assert.deepEqual(await page.evaluate(() => window.fake.opened), [{ kind: 'spout', name: 'PrismVJ' }]);
  const frame = frames.at(-1);
  assert.deepEqual([frame.width, frame.height, frame.size], [320, 180, 320 * 180 * 4]);
  assert.deepEqual(frame.top, [0, 0, 255, 255], 'red, top row first, as BGRA');
  assert.deepEqual(frame.bottom, [255, 0, 0, 255], 'blue at the bottom');
  // Switching the sender off closes it.
  await page.evaluate(() => window.outputs.setComposition({}));
  assert.equal((await page.evaluate(() => window.fake.closed)).length, 1);
  await page.close();
});

test('an Advanced Output screen can be a Spout sender at its own size', { skip: !browserAvailable }, async () => {
  // 100 px rows are not 256-byte aligned: the readback must still be tightly packed.
  const page = await setup(100, 50);
  await page.evaluate(() => {
    const screen = (id, device) => ({ ...window.model.screenFromComposition(100, 50), id, name: id, device });
    const config = window.model.normalizeOutputConfig({ version: 1, screens: [
      screen('Stage', { type: 'spout', name: 'Stage left', width: 100, height: 50 }), screen('Monitor', { type: 'virtual', width: 100, height: 50 }),
    ] }, { compositionWidth: 100, compositionHeight: 50 });
    window.outputs = new window.ShareOutputs({ share: window.video, source: window.composition, onError: message => window.fake.error = message });
    window.started = window.outputs.sync(config);
  });
  assert.equal(await page.evaluate(() => window.started), 1, 'only the Spout screen becomes a sender');
  const frames = await pump(page);
  assert.equal(await page.evaluate(() => window.fake.error), undefined);
  const frame = frames.at(-1);
  assert.deepEqual([frame.width, frame.height, frame.size], [100, 50, 100 * 50 * 4]);
  assert.ok(frame.top[2] > 200 && frame.top[0] < 40, `top ${frame.top}`);
  assert.ok(frame.bottom[0] > 200 && frame.bottom[2] < 40, `bottom ${frame.bottom}`);
  assert.deepEqual(await page.evaluate(() => window.fake.opened), [{ kind: 'spout', name: 'Stage left' }]);
  await page.evaluate(() => window.outputs.sync(null));
  assert.equal((await page.evaluate(() => window.fake.closed)).length, 1);
  await page.close();
});

test('received frames replace the latest one and buffers go back', { skip: !browserAvailable }, async () => {
  const page = await setup();
  const result = await page.evaluate(async () => {
    const input = window.video.input('spout', 'Camera');
    const send = (sequence, size = 16) => window.fake.port.postMessage({ type: 'input', id: input.id, buffer: new ArrayBuffer(size), width: 2, height: 2, alpha: true, sequence }, []);
    send(1); send(2); send(3);
    await new Promise(resolve => setTimeout(resolve, 50));
    const latest = { width: input.latest.width, sequence: input.sequence };
    input.close();
    return { latest, returned: window.fake.returned, closed: window.fake.closed };
  });
  assert.deepEqual(result.latest, { width: 2, sequence: 3 });
  assert.equal(result.returned, 2, 'the two older frames went back to the preload');
  assert.deepEqual(result.closed, [1]);
  await page.close();
});
