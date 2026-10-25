'use strict';
// Spout/NDI peer for the desktop tests, run with ELECTRON_RUN_AS_NODE:
//   receive <spout|ndi> <name>        prints one JSON line of stats per second
//   send <spout|ndi> <name> <w> <h>   sends a solid frame at 60 fps; stdin "color r g b"
// Received frames report the colour of their centre pixel (RGBA).
const video = require(process.argv[2]);
const [mode, kind, name, width = '1920', height = '1080'] = process.argv.slice(3);
const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);

if (mode === 'receive') {
  let receiver = null, frames = 0, target = new Uint8Array(0), last = null, ageMs = 0, started = Date.now();
  const cpu0 = process.cpuUsage();
  const open = () => {
    if (kind === 'spout') return video.createSpoutReceiver(name);
    const source = video.ndiSources().find(item => item.name === name || item.name.endsWith(`(${name})`));
    return source ? video.createNdiReceiver(source.name, source.url) : null;
  };
  setInterval(() => {
    receiver ||= open();
    if (!receiver) return;
    let result = receiver.read(target);
    if (result && !result.copied) { target = new Uint8Array(result.width * result.height * 4); result = receiver.read(target); }
    if (!result?.copied) return;
    frames++; ageMs += result.ageMs;
    const center = ((result.height >> 1) * result.width + (result.width >> 1)) * 4;
    last = { width: result.width, height: result.height, center: [...target.subarray(center, center + 4)] };
  }, 1);
  setInterval(() => {
    const cpu = process.cpuUsage(cpu0), seconds = (Date.now() - started) / 1000;
    print({ frames, fps: frames, ...last, ageMs: frames ? ageMs / frames : null, cpuPercent: (cpu.user + cpu.system) / 1000 / seconds / 10, info: receiver?.info() || null });
    frames = 0; ageMs = 0;
  }, 1000);
} else {
  const w = Number(width), h = Number(height), frame = new Uint8Array(w * h * 4);
  const fill = (r, g, b) => { for (let i = 0; i < frame.length; i += 4) { frame[i] = b; frame[i + 1] = g; frame[i + 2] = r; frame[i + 3] = 255; } };
  fill(200, 40, 90);
  const sender = kind === 'ndi' ? video.createNdiSender(name) : video.createSpoutSender(name);
  process.stdin.on('data', data => { const match = /color (\d+) (\d+) (\d+)/.exec(String(data)); if (match) fill(+match[1], +match[2], +match[3]); });
  const started = performance.now();
  let sent = 0;
  const tick = () => {
    while (performance.now() - started >= sent * 1000 / 60) { sender.send(frame, w, h, { fps: 60 }); sent++; }
    setTimeout(tick, 2);
  };
  tick();
  setInterval(() => print(sender.info()), 1000);
}
