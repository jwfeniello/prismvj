import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismLTCDecoder } from '../public/ltc-worklet.js';
import {
  timecodeToSeconds, secondsToTimecode, timecodeToFrames, framesToTimecode, parseTimecode, formatTimecode,
  encodeLTC, generateLTC, ltcBits, clipTimeFromTimecode, frameRate, TimecodeInput,
} from '../src/smpte.js';

const DF = { fps: 29.97, dropFrame: true };

test('frame counts round trip at every supported rate', () => {
  for (const [fps, dropFrame] of [[24, false], [25, false], [30, false], [29.97, true], [29.97, false], [23.976, false]]) {
    for (const n of [0, 1, 1799, 1800, 17981, 17982, 17983, 107891, 107892, 2000003]) {
      const tc = framesToTimecode(n, fps, dropFrame);
      assert.equal(timecodeToFrames(tc), n, `${fps}${dropFrame ? 'DF' : ''} frame ${n}`);
      const seconds = timecodeToSeconds(tc);
      assert.deepEqual(secondsToTimecode(seconds, fps, dropFrame), tc);
    }
  }
});

test('29.97 drop-frame skips frames 0 and 1 except every tenth minute', () => {
  assert.equal(formatTimecode(framesToTimecode(1799, 29.97, true)), '00:00:59;29');
  assert.equal(formatTimecode(framesToTimecode(1800, 29.97, true)), '00:01:00;02');
  assert.equal(formatTimecode(framesToTimecode(17981, 29.97, true)), '00:09:59;29');
  assert.equal(formatTimecode(framesToTimecode(17982, 29.97, true)), '00:10:00;00');
  assert.equal(formatTimecode(framesToTimecode(17983, 29.97, true)), '00:10:00;01');
  const seen = new Set();
  for (let n = 0; n < 17982 * 2 + 10; n++) {
    const tc = framesToTimecode(n, 29.97, true);
    if (tc.seconds === 0 && tc.frames < 2) assert.equal(tc.minutes % 10, 0, formatTimecode(tc));
    const label = formatTimecode(tc);
    assert.ok(!seen.has(label), label);
    seen.add(label);
  }
  assert.equal(timecodeToFrames({ hours: 1, ...DF }), 107892);
  assert.ok(Math.abs(timecodeToSeconds({ hours: 1, ...DF }) - 107892 * 1001 / 30000) < 1e-9);
  assert.ok(Math.abs(timecodeToSeconds({ hours: 1, ...DF }) - 3600) < 0.004, 'drop-frame tracks wall-clock time');
  assert.ok(Math.abs(frameRate(29.97) - 30000 / 1001) < 1e-12);
  assert.equal(frameRate(25, true), 25);
});

test('parse and format timecode', () => {
  assert.deepEqual(parseTimecode('01:02:03:04', 25), { hours: 1, minutes: 2, seconds: 3, frames: 4, fps: 25, dropFrame: false });
  assert.deepEqual(parseTimecode(' 00:10:00;15 ', 30), { hours: 0, minutes: 10, seconds: 0, frames: 15, fps: 29.97, dropFrame: true });
  assert.equal(parseTimecode('00:01:00;00', 29.97).frames, 2, 'dropped labels round up');
  assert.equal(parseTimecode('00:01:00;00', 25).dropFrame, false, 'no drop-frame at 25 fps');
  assert.deepEqual(parseTimecode('02:00:00', 25), { hours: 2, minutes: 0, seconds: 0, frames: 0, fps: 25, dropFrame: false });
  for (const bad of ['', '1:2', '00:60:00:00', '24:00:00:00', '00:00:00:25', 'aa:bb:cc:dd', null, '00:00:00:00:00'])
    assert.equal(parseTimecode(bad, 25), null, String(bad));
  assert.equal(formatTimecode({ hours: 1, minutes: 2, seconds: 3, frames: 4, fps: 25 }), '01:02:03:04');
  assert.equal(formatTimecode({ hours: 1, minutes: 2, seconds: 3, frames: 4, ...DF }), '01:02:03;04');
  assert.equal(formatTimecode(3600, 25), '01:00:00:00');
  assert.equal(formatTimecode(3600.5, 25), '01:00:00:12');
  assert.equal(formatTimecode(timecodeToSeconds(parseTimecode('13:59:59;29', 29.97)), 29.97, true), '13:59:59;29');
  assert.equal(formatTimecode(-1 / 25, 25), '23:59:59:24', 'wraps at 24 hours');
});

test('clipTimeFromTimecode maps composition timecode to clip position', () => {
  const base = { clipOffsetSeconds: 3600, clipDuration: 100 };
  assert.equal(clipTimeFromTimecode({ ...base, timecodeSeconds: 3599.9 }), null, 'before the offset');
  assert.equal(clipTimeFromTimecode({ ...base, timecodeSeconds: 3600 }), 0);
  assert.equal(clipTimeFromTimecode({ ...base, timecodeSeconds: 3625 }), 0.25);
  assert.equal(clipTimeFromTimecode({ ...base, timecodeSeconds: 3800 }), 1, 'hold by default');
  assert.equal(clipTimeFromTimecode({ ...base, timecodeSeconds: 3800, mode: 'stop' }), null);
  assert.ok(Math.abs(clipTimeFromTimecode({ ...base, timecodeSeconds: 3725, mode: 'loop' }) - 0.25) < 1e-9);
  const window = { ...base, inPoint: 0.2, outPoint: 0.6 };
  assert.equal(clipTimeFromTimecode({ ...window, timecodeSeconds: 3610 }), 0.2, 'holds the in point until reached');
  assert.equal(clipTimeFromTimecode({ ...window, timecodeSeconds: 3630 }), 0.3, 'absolute mapping keeps A/V sync');
  assert.equal(clipTimeFromTimecode({ ...window, timecodeSeconds: 3670 }), 0.6);
  assert.ok(Math.abs(clipTimeFromTimecode({ ...window, timecodeSeconds: 3670, mode: 'loop' }) - 0.3) < 1e-9);
  assert.equal(clipTimeFromTimecode({ ...window, timecodeSeconds: 3670, mode: 'stop' }), null);
  for (const bad of [{ timecodeSeconds: NaN, clipDuration: 10 }, { timecodeSeconds: 1, clipDuration: 0 }, {}])
    assert.equal(clipTimeFromTimecode(bad), null);
});

test('LTC frame layout carries sync word, BCD fields and even parity', () => {
  const bits = ltcBits({ hours: 23, minutes: 59, seconds: 58, frames: 27, ...DF }, { userBits: 0x12345678 });
  assert.equal([...bits.slice(64)].join(''), '0011111111111101');
  assert.equal(bits[10], 1, 'drop-frame flag');
  assert.equal(bits.reduce((a, b) => a + b, 0) % 2, 0);
  const value = (start, length) => [...bits.slice(start, start + length)].reduce((v, b, i) => v | (b << i), 0);
  assert.deepEqual([value(0, 4), value(8, 2), value(48, 4), value(56, 2), value(4, 4), value(60, 4)], [7, 2, 3, 2, 8, 1]);
  assert.equal(encodeLTC('00:00:00:00', 25, 48000).length, 1920);
  assert.equal(encodeLTC('00:00:00;00', 29.97, 48000).length, 1602);
});

// Deterministic Gaussian-ish noise.
function noise(seed) {
  let s = seed >>> 0;
  const uniform = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return () => uniform() + uniform() + uniform() + uniform() - 2;
}

function decode(audio, sampleRate, block = 128) {
  const frames = [];
  let lost = 0;
  const decoder = new PrismLTCDecoder(sampleRate, { onFrame: f => frames.push({ ...f }), onLoss: () => lost++ });
  for (let i = 0; i < audio.length; i += block) decoder.process(audio.subarray(i, i + block), i);
  return { frames, lost, decoder };
}

function expectSequence(frames, start, fps, dropFrame, { count, step = 1 }) {
  assert.ok(frames.length >= count - 2, `decoded ${frames.length} of ${count}`);
  const base = timecodeToFrames(parseTimecode(start, fps, dropFrame));
  const first = timecodeToFrames({ ...frames[0], fps, dropFrame });
  assert.ok(Math.abs(first - base) <= 1, `first frame ${formatTimecode({ ...frames[0], fps, dropFrame })}`);
  frames.forEach((frame, i) => {
    assert.equal(formatTimecode({ ...frame, fps, dropFrame }), formatTimecode(framesToTimecode(first + i * step, fps, dropFrame)));
    assert.equal(frame.dropFrame, dropFrame);
  });
}

for (const sampleRate of [44100, 48000]) {
  for (const [fps, dropFrame, start] of [[25, false, '00:59:58:10'], [29.97, true, '00:09:58;20'], [24, false, '10:00:00:00'], [30, false, '23:59:59:00']]) {
    test(`decodes ${fps}${dropFrame ? ' DF' : ''} LTC at ${sampleRate} Hz with noise, DC and level changes`, () => {
      const count = Math.round(fps * 4);
      const clean = generateLTC({ start, frames: count, fps, dropFrame, sampleRate, amplitude: 0.5, userBits: 0xcafe });
      const rand = noise(sampleRate + fps * 100);
      const audio = new Float32Array(clean.length);
      let low = 0;
      const smooth = 1 - Math.exp(-2 * Math.PI * 12000 / sampleRate); // band-limited like a real line input
      for (let i = 0; i < clean.length; i++) {
        low += (clean[i] - low) * smooth;
        const gain = i < clean.length / 2 ? 1 : 0.5 - 0.3 * ((i - clean.length / 2) / clean.length); // half amplitude, then fading
        audio[i] = low * gain + 0.25 + rand() * 0.05; // noise ~0.03 RMS, ~15 dB SNR at the quietest
      }
      const { frames, decoder } = decode(audio, sampleRate);
      expectSequence(frames, start, fps, dropFrame, { count });
      assert.ok(frames.every(frame => frame.userBits === 0xcafe));
      assert.equal(frames.at(-1).fps, fps, 'frame rate detected from the bit rate');
      assert.ok(decoder.errors <= 2, `${decoder.errors} bit errors`);
    });
  }
}

test('decodes concatenated encodeLTC frames (29.97 DF at 44.1 kHz) and reports sample times', () => {
  const sampleRate = 44100, first = timecodeToFrames(parseTimecode('01:00:59;25', 29.97));
  const chunks = [];
  for (let i = 0; i < 40; i++) chunks.push(encodeLTC(framesToTimecode(first + i, 29.97, true), 29.97, sampleRate, { amplitude: 0.3 }));
  const audio = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((offset, chunk) => (audio.set(chunk, offset), offset + chunk.length), 0);
  const { frames } = decode(audio, sampleRate, 97);
  expectSequence(frames, '01:00:59;26', 29.97, true, { count: 39 });
  assert.ok(frames.some(f => f.minutes === 1 && f.seconds === 0 && f.frames === 2), 'crosses the dropped labels');
  const spacing = frames[5].sampleTime - frames[4].sampleTime;
  assert.ok(Math.abs(spacing - sampleRate / frameRate(29.97)) < 2, `frame spacing ${spacing}`);
});

test('decodes reversed LTC and reports signal loss after 200 ms of silence', () => {
  const sampleRate = 48000;
  const forward = generateLTC({ start: '00:00:10:00', frames: 50, fps: 25, sampleRate });
  const audio = new Float32Array(forward.length + sampleRate / 2);
  audio.set(forward.slice().reverse());
  const { frames, lost } = decode(audio, sampleRate);
  assert.ok(frames.length >= 45, `decoded ${frames.length}`);
  assert.ok(frames.every(f => f.reverse));
  frames.forEach((frame, i) => i && assert.equal(timecodeToFrames({ ...frame, fps: 25 }), timecodeToFrames({ ...frames[i - 1], fps: 25 }) - 1));
  assert.equal(lost, 1);
});

test('ignores garbage input without decoding frames', () => {
  const rand = noise(7), audio = new Float32Array(48000);
  for (let i = 0; i < audio.length; i++) audio[i] = i % 1000 === 0 ? NaN : rand() * 0.5;
  assert.equal(decode(audio, 48000).frames.length, 0);
  assert.doesNotThrow(() => new PrismLTCDecoder(NaN).process(null, 0));
});

// TimecodeInput clock logic against a fake context (no audio graph needed).
function fakeInput(options) {
  const context = { sampleRate: 48000, currentTime: 0, createGain() {} };
  const input = new TimecodeInput(context, { workletURL: '/ltc-worklet.js', ...options });
  input.offline = true; // deterministic: no wall-clock extrapolation
  const events = [];
  for (const name of ['lock', 'unlock', 'timecode']) input.on(name, detail => events.push([name, detail]));
  const send = (label, time) => input._message({ ...parseTimecode(label, 25), fps: 25, dropFrame: false, sampleTime: time * 48000 });
  return { context, input, events, send };
}

test('TimecodeInput locks, interpolates, follows jumps and unlocks', () => {
  const { context, input, events, send } = fakeInput({ delayFrames: 0 });
  send('01:00:00:00', 1.04);
  assert.equal(input.state.locked, false, 'needs two consistent frames');
  send('01:00:00:01', 1.08);
  assert.equal(input.state.locked, true);
  assert.equal(events.filter(e => e[0] === 'lock').length, 1);
  context.currentTime = 1.1;
  assert.ok(Math.abs(input.state.seconds - (3600 + 2 / 25 + 0.02)) < 1e-6, 'interpolates between frames');
  assert.equal(input.state.timecode, '01:00:00:02');
  // A single corrupt frame does not move the clock; a confirmed jump does.
  send('02:00:00:00', 1.12);
  assert.ok(Math.abs(input.state.seconds - 3600.1) < 0.01);
  send('01:00:00:03', 1.16);
  send('02:00:00:00', 1.20);
  send('02:00:00:01', 1.24);
  context.currentTime = 1.24;
  assert.ok(Math.abs(input.state.seconds - (7200 + 2 / 25)) < 1e-6);
  assert.equal(events.filter(e => e[0] === 'lock').at(-1)[1].jump, true);
  // Small corrections never run the clock backwards.
  const before = input.state.seconds;
  send('02:00:00:02', 1.2805);
  assert.ok(input.state.seconds >= before);
  const undelayed = input.state.seconds;
  input.delayFrames = -2;
  assert.ok(Math.abs(input.state.seconds - (undelayed - 2 / 25)) < 1e-9, 'negative delay holds video back');
  input._message({ signal: false });
  assert.equal(input.state.locked, false);
  assert.equal(events.at(-1)[0], 'unlock');
  assert.ok(events.some(e => e[0] === 'timecode' && e[1].timecode === '01:00:00:00'));
  for (const junk of [null, 5, { hours: 'x' }, { hours: 1, minutes: 99, seconds: 0, frames: 0, sampleTime: 1 }]) input._message(junk);
  assert.equal(input.state.locked, false);
});

test('TimecodeInput applies frame delay compensation and a fixed frame rate', () => {
  const { context, input, send } = fakeInput({ fps: 25, delayFrames: 5 });
  send('00:00:01:00', 2.04);
  send('00:00:01:01', 2.08);
  context.currentTime = 2.08;
  assert.ok(Math.abs(input.state.seconds - (1 + 2 / 25 + 5 / 25)) < 1e-6);
  assert.throws(() => new TimecodeInput(null));
});
