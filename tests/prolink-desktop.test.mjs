// Pro DJ Link end to end in the desktop app: a simulated CDJ-3000 plays a
// track; mapping it to the selected clip makes that clip play in sync with
// the track's playhead, hold when the track pauses and stop when it unloads.
// Uses the real Pro DJ Link ports, so it is skipped when they are busy.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { makeAnnounce, HEADER } = createRequire(import.meta.url)('../electron/prolink.cjs');

const free = port => new Promise(resolve => { const socket = dgram.createSocket('udp4'); socket.once('error', () => resolve(false)); socket.bind(port, () => socket.close(() => resolve(true))); });
const freeTcp = port => new Promise(resolve => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
const portsFree = (await Promise.all([free(50000), free(50001), free(50002), freeTcp(12523)])).every(Boolean);

function packet(type, length, fill) { const buffer = Buffer.alloc(length); HEADER.copy(buffer, 0); buffer[0x0a] = type; fill(buffer); return buffer; }
function status({ trackId = 1234, playState = 0x03, flags = 0x40 | 0x20 | 0x08 } = {}) {
  return packet(0x0a, 0xd4, buffer => {
    buffer.write('CDJ-3000', 0x0b, 'latin1'); buffer[0x21] = 2; buffer[0x28] = 2; buffer[0x29] = 3; buffer[0x2a] = trackId ? 1 : 0; buffer.writeUInt32BE(trackId, 0x2c);
    buffer[0x7b] = playState; buffer[0x89] = flags; buffer.writeUInt16BE(trackId ? 12800 : 0xffff, 0x92); buffer[0x99] = 0x10; buffer.writeUInt32BE(33, 0xa0); buffer[0xa6] = 1;
  });
}
const position = ms => packet(0x0b, 0x3c, buffer => { buffer[0x21] = 2; buffer.writeUInt32BE(300, 0x24); buffer.writeUInt32BE(ms, 0x28); buffer.writeUInt32BE(1280, 0x38); });

// Minimal player database server answering one metadata lookup.
function fakeDatabase() {
  const u32 = value => { const b = Buffer.alloc(5); b[0] = 0x11; b.writeUInt32BE(value >>> 0, 1); return b; };
  const str = text => { const data = Buffer.from(`${text}\0`, 'utf16le').swap16(); const b = Buffer.alloc(5); b[0] = 0x26; b.writeUInt32BE(data.length / 2, 1); return Buffer.concat([b, data]); };
  const reply = (type, args) => {
    const kinds = Buffer.alloc(12); args.forEach((arg, index) => { kinds[index] = typeof arg === 'string' ? 0x02 : 0x06; });
    const head = Buffer.concat([u32(0x872349ae), u32(1), Buffer.from([0x10, type >> 8, type & 255]), Buffer.from([0x0f, args.length]), Buffer.from([0x14, 0, 0, 0, 12]), kinds]);
    return Buffer.concat([head, ...args.map(arg => typeof arg === 'string' ? str(arg) : u32(arg))]);
  };
  const items = [[0x04, 'Strobe'], [0x07, 'deadmau5']];
  const db = net.createServer(socket => {
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0), started = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!started && buffer.length >= 5) { buffer = buffer.subarray(5); started = true; socket.write(u32(1)); }
      while (started && buffer.length >= 32) {
        const type = buffer.readUInt16BE(11), count = buffer[14], total = 32 + count * 5;
        if (buffer.length < total) return;
        buffer = buffer.subarray(total);
        if (type === 0x0000) socket.write(reply(0x4000, [0, 0]));
        else if (type === 0x2002) socket.write(reply(0x4000, [0x2002, items.length]));
        else if (type === 0x3000) { socket.write(reply(0x4001, [])); for (const [kind, label] of items) socket.write(reply(0x4101, [0, 1, 0, label, 2, '', kind, 0, 0, 0, 0, 0])); socket.write(reply(0x4201, [])); }
      }
    });
  });
  const lookup = net.createServer(socket => socket.on('error', () => {}).once('data', () => { const port = Buffer.alloc(2); port.writeUInt16BE(db.address().port); socket.end(port); }));
  return new Promise(resolve => db.listen(0, '127.0.0.1', () => lookup.listen(12523, '127.0.0.1', () => resolve({ close: () => { db.close(); lookup.close(); } }))));
}

test('CDJ track trigger plays the mapped clip in sync, holds on pause, stops on unload', { skip: !portsFree, timeout: 180000 }, async () => {
  assert.ok(existsSync(path.join(root, 'dist', 'index.html')), 'Run npm run build first.');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'prism-prolink-'));
  const profile = path.join(temporary, 'profile');
  await mkdir(profile, { recursive: true });
  const database = await fakeDatabase();
  const sender = dgram.createSocket('udp4');
  const send = (data, port) => sender.send(data, port, '127.0.0.1');
  let mode = { trackId: 1234, playState: 0x03, flags: 0x68 }, started = Date.now(), held = 61500;
  const timer = setInterval(() => {
    send(makeAnnounce({ number: 2, name: 'CDJ-3000', mac: [2, 0, 0, 0, 0, 2], ip: '127.0.0.1' }), 50000);
    send(status(mode), 50002);
    if (mode.trackId) send(position(mode.playState === 0x03 ? 61500 + (Date.now() - started) : held), 50001);
  }, 100);
  const env = { ...process.env, PRISM_TEST_DATA: profile, PRISM_HEADLESS: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PRISM_DEV_URL;
  let application;
  try {
    application = await electron.launch({ args: [root], cwd: root, env, timeout: 30000 });
    const page = await application.firstWindow();
    await page.waitForFunction(() => window.desktop && window.prismDiagnostics);
    await page.locator('[data-browser="controls"]').click();
    await page.locator('#prolink-toggle').click();
    await page.locator('.prolink-player', { hasText: 'Strobe' }).waitFor({ timeout: 30000 });
    const row = await page.locator('.prolink-player').first().textContent();
    for (const part of ['deadmau5', 'MASTER', 'ON AIR', '128.00 BPM']) assert.ok(row.includes(part), part + ' in ' + row);
    await page.locator('[data-prolink-map="2"]').click();
    const trigger = await page.evaluate(() => window.prismDiagnostics().project.trackTriggers[0]);
    assert.deepEqual([trigger.title, trigger.artist, trigger.sync], ['Strobe', 'deadmau5', true]);
    // The mapped clip plays at the track's position (looped over its duration).
    const sample = () => page.evaluate(id => {
      const diagnostics = window.prismDiagnostics();
      const frame = diagnostics.frames.find(item => item.clipId === id);
      const clip = diagnostics.project.layers.flatMap(layer => Object.values(layer.clips).flat()).find(item => item?.id === id);
      return frame ? { position: frame.position, duration: clip.duration } : null;
    }, trigger.clipId);
    await page.waitForFunction(id => window.prismDiagnostics().frames.some(frame => frame.clipId === id), trigger.clipId);
    await page.waitForTimeout(500);
    const playing = await sample();
    const expected = (((61500 + (Date.now() - started)) / 1000) / playing.duration) % 1;
    const drift = Math.min(Math.abs(playing.position - expected), 1 - Math.abs(playing.position - expected)) * playing.duration;
    assert.ok(drift < 0.25, `clip ${playing.position} vs track ${expected} (${drift.toFixed(3)} s apart)`);
    // Pause on the CDJ: the clip holds its frame.
    held = 61500 + (Date.now() - started);
    mode = { trackId: 1234, playState: 0x05, flags: 0x28 };
    await page.waitForTimeout(600);
    const a = await sample();
    await page.waitForTimeout(500);
    const b = await sample();
    assert.ok(a && b && Math.abs(a.position - b.position) < 0.002, `held ${a?.position} -> ${b?.position}`);
    // Unload the track: the clip stops.
    mode = { trackId: 0, playState: 0x00, flags: 0x08 };
    await page.waitForFunction(id => !window.prismDiagnostics().frames.some(frame => frame.clipId === id), trigger.clipId, { timeout: 10000 });
  } finally {
    clearInterval(timer);
    sender.close();
    database.close();
    await application?.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
});