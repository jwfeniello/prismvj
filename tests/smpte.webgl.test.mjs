import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { sourceFile } from './src-server.mjs';

let browser;
let server;
let baseURL;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browserAvailable = existsSync(chrome);

before(async () => {
  if (!browserAvailable) return;
  const worklet = await readFile(new URL('../public/ltc-worklet.js', import.meta.url));
  server = createServer((request, response) => {
    const source = sourceFile(request.url);
    if (source) { response.setHeader('Content-Type', source.type); response.end(source.body); return; }
    if (request.url === '/ltc-worklet.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(worklet); return; }
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Content-Security-Policy', "script-src 'self'");
    response.end('<!doctype html><title>smpte</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

test('TimecodeInput locks to LTC played through an AudioBufferSourceNode', { skip: !browserAvailable && 'Chrome not installed' }, async () => {
  const page = await browser.newPage();
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const { TimecodeInput, generateLTC } = await import('/smpte.js');
    const context = new AudioContext({ sampleRate: 48000 });
    await context.resume();
    const audio = generateLTC({ start: '01:00:00:00', frames: 25 * 3, fps: 25, sampleRate: context.sampleRate, amplitude: 0.4 });
    const buffer = context.createBuffer(1, audio.length, context.sampleRate);
    buffer.copyToChannel(audio, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const input = new TimecodeInput(context); // default URL resolves relative to the page
    await input.start(source);
    const timecodes = [];
    input.on('timecode', event => timecodes.push(event.timecode));
    const unlocked = new Promise(resolve => input.on('unlock', resolve));
    const locked = new Promise(resolve => input.on('lock', resolve));
    const startedAt = context.currentTime + 0.05;
    source.start(startedAt);
    const lock = await Promise.race([locked, new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
    const samples = [];
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const state = input.state;
      samples.push({ ...state, expected: 3600 + (context.currentTime - startedAt) });
    }
    const unlock = await Promise.race([unlocked, new Promise(resolve => setTimeout(() => resolve(null), 3000))]);
    const final = input.state;
    input.stop();
    await context.close();
    return { lock, samples, unlocked: !!unlock, final, timecodes };
  });
  await page.close();
  assert.ok(result.lock, 'locked');
  assert.equal(result.lock.jump, false);
  assert.ok(Math.abs(result.lock.seconds - 3600.08) < 0.1, `lock at ${result.lock.seconds}`);
  assert.match(result.timecodes[0], /^01:00:00:0[0-3]$/);
  for (let i = 1; i < result.timecodes.length; i++) assert.notEqual(result.timecodes[i], result.timecodes[i - 1]);
  const playing = result.samples.filter(sample => sample.locked);
  assert.ok(playing.length >= 5, `${playing.length} locked samples`);
  for (const [i, sample] of playing.entries()) {
    assert.equal(sample.fps, 25);
    assert.ok(Math.abs(sample.seconds - sample.expected) < 0.06, `sample ${i}: ${sample.seconds} vs ${sample.expected}`);
    if (i) assert.ok(sample.seconds > playing[i - 1].seconds, 'monotonic');
    assert.match(sample.timecode, /^01:00:0[0-2]:\d\d$/);
  }
  assert.ok(result.unlocked, 'unlocks when the signal stops');
  assert.equal(result.final.locked, false);
  assert.ok(result.final.seconds > 3602 && result.final.seconds < 3603.2, `held at ${result.final.seconds}`);
});

test('TimecodeInput reads the chosen channel in an OfflineAudioContext', { skip: !browserAvailable && 'Chrome not installed' }, async () => {
  const page = await browser.newPage();
  await page.goto(baseURL);
  const result = await page.evaluate(async () => {
    const { TimecodeInput, generateLTC } = await import('/smpte.js');
    const sampleRate = 44100;
    const ltc = generateLTC({ start: '00:09:59;20', frames: 60, fps: 29.97, dropFrame: true, sampleRate, amplitude: 0.5 });
    const context = new OfflineAudioContext(2, ltc.length + sampleRate / 2, sampleRate);
    // Manual's DIY split: music on the left channel, SMPTE on the right.
    const music = new Float32Array(ltc.length);
    for (let i = 0; i < music.length; i++) music[i] = 0.6 * Math.sin(i * 2 * Math.PI * 220 / sampleRate);
    const buffer = context.createBuffer(2, ltc.length, sampleRate);
    buffer.copyToChannel(music, 0);
    buffer.copyToChannel(ltc, 1);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const input = new TimecodeInput(context, { workletURL: '/ltc-worklet.js' });
    await input.start(source, { channel: 1 });
    const timecodes = [];
    let locks = 0, unlocks = 0;
    input.on('timecode', event => timecodes.push(event.timecode));
    input.on('lock', () => locks++);
    input.on('unlock', () => unlocks++);
    source.start();
    await context.startRendering();
    await new Promise(resolve => setTimeout(resolve, 300));
    return { timecodes, locks, unlocks, state: input.state };
  });
  await page.close();
  assert.ok(result.timecodes.length >= 55, `${result.timecodes.length} frames`);
  assert.equal(result.timecodes[0], '00:09:59;21');
  assert.ok(result.timecodes.includes('00:10:00;00'), 'tenth minute keeps frame 00');
  assert.ok(result.timecodes.includes('00:10:01;10'));
  assert.equal(result.locks, 1);
  assert.equal(result.unlocks, 1);
  assert.equal(result.state.dropFrame, true);
  assert.equal(result.state.fps, 29.97);
});
