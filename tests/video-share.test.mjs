// The Spout/NDI bridge (electron/native/prism_video.node) on its own: frames
// sent at 1080p60 come back through a receiver in the same process, intact,
// in order and at full rate. NDI runs when its runtime is installed (or
// PRISM_NDI_LIBRARY names one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const addon = path.join(root, 'electron', 'native', 'prism_video.node');
const video = existsSync(addon) && process.platform === 'win32' ? createRequire(import.meta.url)(addon) : null;
const W = 1920, H = 1080, BLOCK = 16;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The frame index as 24 black/white blocks along the top survives NDI's compression.
function stamp(frame, index) {
  for (let bit = 0; bit < 24; bit++) {
    const value = (index >> bit) & 1 ? 255 : 0;
    for (let y = 0; y < BLOCK; y++) frame.fill(value, (y * W + bit * BLOCK) * 4, (y * W + (bit + 1) * BLOCK) * 4);
  }
}
const readStamp = (frame, flipped) => {
  let index = 0;
  const y = flipped ? H - 1 - (BLOCK >> 1) : BLOCK >> 1;
  for (let bit = 0; bit < 24; bit++) if (frame[(y * W + bit * BLOCK + (BLOCK >> 1)) * 4 + 1] > 127) index |= 1 << bit;
  return index;
};

// Frames counted from the first stamped one. A receiver may hand over the same
// frame twice (Spout right after connecting), but never an older one.
function summarize(seen) {
  const firstIndex = seen.find(index => index > 0) ?? 0, delivered = seen.filter(index => index >= firstIndex);
  return { firstIndex, unique: new Set(delivered).size, ordered: delivered.every((index, i) => i === 0 || index >= delivered[i - 1]) };
}

async function loopback(sender, receiver, { seconds = 3, flipped = false } = {}) {
  // BGRA blue-ish body: received as RGBA, the channels swap.
  const frame = new Uint8Array(W * H * 4);
  for (let i = 0; i < frame.length; i += 4) { frame[i] = 200; frame[i + 1] = 100; frame[i + 2] = 30; frame[i + 3] = 255; }
  const target = new Uint8Array(W * H * 4), seen = [];
  let center = null;
  const reader = setInterval(() => {
    const result = receiver.read(target, flipped);
    if (!result?.copied) return;
    seen.push(readStamp(target, flipped));
    const middle = ((H >> 1) * W + (W >> 1)) * 4;
    center = [...target.subarray(middle, middle + 4)];
  }, 1);
  const start = performance.now();
  let sent = 0;
  while (performance.now() - start < seconds * 1000) {
    const due = start + sent * 1000 / 60;
    if (performance.now() < due) { await sleep(Math.max(0, due - performance.now() - 1)); continue; }
    stamp(frame, sent);
    sender.send(frame, W, H, { fps: 60 });
    sent++;
  }
  await sleep(300);
  clearInterval(reader);
  return { sent, seen, center };
}

test('Spout sends and receives 1080p frames at 60 fps', { skip: !video && 'Spout bridge not built' }, async () => {
  const sender = video.createSpoutSender(`PrismVJ test ${process.pid}`);
  // A Spout sender registers with its first frame.
  const listed = () => video.spoutSenders().some(item => item.name === sender.info().name);
  for (let i = 0; i < 50 && !listed(); i++) { sender.send(new Uint8Array(W * H * 4), W, H); await sleep(100); }
  assert.ok(listed(), 'the sender is listed');
  const name = sender.info().name;
  const receiver = video.createSpoutReceiver(name);
  try {
    const { sent, seen, center } = await loopback(sender, receiver, { flipped: true });
    const { firstIndex, unique, ordered } = summarize(seen);
    assert.ok(unique >= (sent - firstIndex) * 0.95, `received ${unique} of ${sent - firstIndex} frames`);
    assert.ok(ordered, 'frames arrive in order');
    assert.deepEqual(center, [30, 100, 200, 255], 'pixels are unchanged apart from BGRA → RGBA');
    assert.equal(receiver.info().width, W);
  } finally { sender.close(); receiver.close(); }
  await sleep(200);
  assert.ok(!video.spoutSenders().some(item => item.name === name), 'a closed sender is removed');
});

test('NDI® sends and receives 1080p frames at 60 fps', { skip: !video?.ndiStatus().available && 'NDI runtime not installed' }, async () => {
  const name = `PrismVJ test ${process.pid}`;
  const sender = video.createNdiSender(name);
  try {
    let source = null;
    const blank = new Uint8Array(W * H * 4);
    for (let i = 0; i < 100 && !source; i++) { sender.send(blank, W, H); await sleep(100); source = video.ndiSources().find(item => item.name.endsWith(`(${name})`)); }
    assert.ok(source, 'discovery finds the sender');
    const receiver = video.createNdiReceiver(source.name, source.url);
    try {
      // Let the connection come up before counting.
      for (let i = 0; i < 50 && !receiver.info().connected; i++) { sender.send(blank, W, H); await sleep(50); }
      const { sent, seen, center } = await loopback(sender, receiver);
      const { firstIndex, unique, ordered } = summarize(seen);
      assert.ok(unique >= (sent - firstIndex) * 0.95, `received ${unique} of ${sent - firstIndex} frames`);
      assert.ok(ordered, 'frames arrive in order');
      assert.ok(center.every((value, i) => Math.abs(value - [30, 100, 200, 255][i]) <= 6), `centre ${center}`);
    } finally { receiver.close(); }
  } finally { sender.close(); }
});

test('NDI reports a missing runtime instead of failing', { skip: !video && 'Spout bridge not built' }, () => {
  const status = video.ndiStatus();
  assert.equal(typeof status.available, 'boolean');
  assert.match(status.runtimeURL, /ndi\.link/);
  if (!status.available) assert.throws(() => video.createNdiSender('x'), /NDI/);
});
