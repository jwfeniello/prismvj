// Loopback benchmark for the Spout and NDI bridge (electron/native/prism_video.node):
// sends 1080p frames at 60 fps and receives them in the same process.
// Usage: node scripts/bench-video-share.mjs [spout|ndi] [seconds] [width] [height]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const video = require('../electron/native/prism_video.node');

const [kind = 'spout', seconds = '10', width = '1920', height = '1080'] = process.argv.slice(2);
const W = Number(width), H = Number(height), FPS = 60, name = `PrismVJ bench ${process.pid}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const sender = kind === 'ndi' ? video.createNdiSender(name) : video.createSpoutSender(name);
await sleep(300);
let receiver;
if (kind === 'ndi') {
  const fullName = () => video.ndiSources().find(source => source.name.endsWith(`(${name})`));
  for (let i = 0; i < 100 && !fullName(); i++) { sender.send(new Uint8Array(W * H * 4), W, H); await sleep(100); }
  const source = fullName();
  if (!source) throw new Error('The NDI sender was not discovered.');
  receiver = video.createNdiReceiver(source.name, source.url);
} else receiver = video.createSpoutReceiver(sender.info().name);

// Each frame carries its index as 24 black/white 16×16 blocks along the top,
// which survive NDI's lossy compression.
const BLOCK = 16;
function stamp(frame, index) {
  for (let bit = 0; bit < 24; bit++) {
    const value = (index >> bit) & 1 ? 255 : 0;
    for (let y = 0; y < BLOCK; y++) frame.fill(value, (y * W + bit * BLOCK) * 4, (y * W + (bit + 1) * BLOCK) * 4);
  }
}
const readStamp = frame => { let index = 0; for (let bit = 0; bit < 24; bit++) if (frame[((BLOCK >> 1) * W + bit * BLOCK + (BLOCK >> 1)) * 4 + 1] > 127) index |= 1 << bit; return index; };
const frames = Array.from({ length: 3 }, () => new Uint8Array(W * H * 4));
for (const frame of frames) for (let i = 0; i < frame.length; i += 4) { frame[i] = (i >> 2) & 255; frame[i + 1] = 128; frame[i + 2] = 64; frame[i + 3] = 255; }
const target = new Uint8Array(W * H * 4), sentAt = new Map(), latencies = [];
let firstIndex = -1, lastIndex = -1, sent = 0, received = 0, sendCost = 0, readCost = 0, corrupt = 0;
const cpu0 = process.cpuUsage(), start = performance.now();

const readLoop = setInterval(() => {
  const t = performance.now();
  const result = receiver.read(target);
  readCost += performance.now() - t;
  if (!result?.copied) return;
  const index = readStamp(target);
  if (sentAt.has(index)) { if (firstIndex < 0) firstIndex = index; lastIndex = index; latencies.push(performance.now() - sentAt.get(index)); sentAt.delete(index); received++; } else corrupt++;
}, 1);

while (performance.now() - start < Number(seconds) * 1000) {
  const due = start + sent * 1000 / FPS;
  if (performance.now() < due) { await sleep(Math.max(0, due - performance.now() - 1)); continue; }
  const frame = frames[sent % frames.length];
  stamp(frame, sent);
  const t = performance.now();
  sender.send(frame, W, H, { fps: FPS });
  sendCost += performance.now() - t;
  sentAt.set(sent, t);
  sent++;
}
await sleep(500);
clearInterval(readLoop);
const elapsed = (performance.now() - start) / 1000, cpu = process.cpuUsage(cpu0);
latencies.sort((a, b) => a - b);
const pct = p => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))].toFixed(1) : '-';
console.log(JSON.stringify({
  kind, size: `${W}x${H}`, sent, received,
  // Steady state: frames that arrived out of those sent after the connection was up.
  deliveredAfterConnect: `${received}/${lastIndex - firstIndex + 1}`, receivedFps: +(received / ((lastIndex - firstIndex + 1) / FPS)).toFixed(1),
  latencyMs: { p50: pct(0.5), p95: pct(0.95), max: pct(0.999) },
  sendCallMs: +(sendCost / sent).toFixed(2), processCpuPercentOfOneCore: +((cpu.user + cpu.system) / 1000 / elapsed / 10).toFixed(0),
  sender: sender.info(), receiver: receiver.info(), unmatched: corrupt,
}, null, 1));
sender.close(); receiver.close();
