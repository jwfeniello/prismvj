import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { AUDIO_EFFECTS, DIVISIONS, syncSeconds, audioEffectDefinition } from '../src/audio-fx.js';
import { PARAM_TYPES, defaultParams, normalizeParams } from '../src/fx/shader-template.js';

let browser;
let server;
let baseURL;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browserAvailable = existsSync(chrome);
const skip = !browserAvailable;

before(async () => {
  if (!browserAvailable) return;
  const files = new Map([
    ['/audio-fx.js', await readFile(new URL('../src/audio-fx.js', import.meta.url))],
    ['/fx/shader-template.js', await readFile(new URL('../src/fx/shader-template.js', import.meta.url))],
  ]);
  server = createServer((request, response) => {
    const file = files.get(request.url);
    response.setHeader('Content-Type', file ? 'text/javascript' : 'text/html');
    response.end(file || '<!doctype html><title>audio-fx</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function setup() {
  const page = await browser.newPage();
  await page.goto(baseURL);
  await page.evaluate(async () => {
    window.fx = await import('/audio-fx.js');
    const SR = window.SR = 48000;
    // kind: 'noise' (stereo, independent channels), 'sine' (mono), 'impulse' (mono, sample 0 = 1).
    window.source = (ctx, { kind = 'noise', freq = 440, amp = 0.3 } = {}) => {
      const length = ctx.length, channels = kind === 'noise' ? 2 : 1;
      const buffer = new AudioBuffer({ numberOfChannels: channels, length, sampleRate: SR });
      let seed = 12345; // same noise on every render so dry/wet renders compare sample by sample
      const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (let c = 0; c < channels; c++) {
        const data = buffer.getChannelData(c);
        if (kind === 'impulse') data[0] = 1;
        else for (let i = 0; i < length; i++) data[i] = kind === 'sine' ? amp * Math.sin(2 * Math.PI * freq * i / SR) : amp * (random() * 2 - 1);
      }
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      return node;
    };
    // build(ctx) -> { input, output } | null (passthrough). Returns [left, right] Float32Arrays.
    window.render = async (build, { seconds = 0.5, ...sourceOptions } = {}) => {
      const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
      const src = source(ctx, sourceOptions), node = build ? build(ctx) : null;
      if (node) { src.connect(node.input); node.output.connect(ctx.destination); } else src.connect(ctx.destination);
      src.start();
      const buffer = await ctx.startRendering();
      return [buffer.getChannelData(0), buffer.getChannelData(1)];
    };
    window.effect = (id, params = {}, options = {}) => ctx => (window.last = fx.createAudioEffect(ctx, id, params, options));
    window.rms = (data, start = 0) => { let sum = 0; for (let i = start; i < data.length; i++) sum += data[i] * data[i]; return Math.sqrt(sum / (data.length - start)); };
    window.peakIndex = (data, from = 0, to = data.length) => { let best = from; for (let i = from; i < to; i++) if (Math.abs(data[i]) > Math.abs(data[best])) best = i; return best; };
    window.magnitude = (data, freq, start = 0) => {
      let re = 0, im = 0;
      for (let i = start; i < data.length; i++) { const phase = 2 * Math.PI * freq * i / SR; re += data[i] * Math.cos(phase); im -= data[i] * Math.sin(phase); }
      return 2 * Math.hypot(re, im) / (data.length - start);
    };
  });
  return page;
}

test('audio effect catalog has unique ids, valid params and a Dry/Wet on every effect', () => {
  assert.ok(Object.isFrozen(AUDIO_EFFECTS));
  const ids = AUDIO_EFFECTS.map(effect => effect.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['eq', 'lowpass', 'highpass', 'bandpass', 'notch', 'delay', 'pingpong', 'reverb', 'distortion', 'bitcrusher', 'compressor', 'limiter', 'flanger', 'chorus', 'phaser', 'tremolo', 'autopan', 'width', 'gain']) assert.ok(ids.includes(id), id);
  for (const effect of AUDIO_EFFECTS) {
    assert.ok(Object.isFrozen(effect) && Object.isFrozen(effect.params), effect.id);
    assert.ok(effect.name && effect.category, effect.id);
    assert.equal(audioEffectDefinition(effect.id), effect);
    const keys = effect.params.map(param => param.key);
    assert.equal(new Set(keys).size, keys.length, `${effect.id} duplicate keys`);
    for (const param of effect.params) {
      const where = `${effect.id}.${param.key}`;
      assert.ok(PARAM_TYPES.includes(param.type) && param.label, where);
      if (param.type === 'float' || param.type === 'int') {
        assert.ok(Number.isFinite(param.min) && Number.isFinite(param.max) && param.min < param.max, where);
        assert.ok(param.default >= param.min && param.default <= param.max, where);
        if (param.type === 'int') assert.ok(Number.isInteger(param.default), where);
      } else if (param.type === 'choice') {
        assert.ok(Array.isArray(param.options) && param.options.length > 1, where);
        assert.ok(Number.isInteger(param.default) && param.default >= 0 && param.default < param.options.length, where);
      } else if (param.type === 'bool') assert.equal(typeof param.default, 'boolean', where);
    }
    const dryWet = effect.params.find(param => param.key === 'dryWet');
    assert.ok(dryWet && dryWet.type === 'float' && dryWet.min === 0 && dryWet.max === 1, `${effect.id} dryWet`);
    assert.deepEqual(normalizeParams(effect, defaultParams(effect)), defaultParams(effect));
    if (effect.params.some(param => param.key === 'sync')) assert.ok(effect.params.some(param => param.key === 'division' && param.options.length === DIVISIONS.length), effect.id);
  }
  assert.equal(syncSeconds(120, DIVISIONS.findIndex(([label]) => label === '1/8')), 0.25);
  assert.equal(syncSeconds(60, DIVISIONS.findIndex(([label]) => label === '1 Bar')), 4);
  assert.equal(syncSeconds(-5, 999), syncSeconds(20, DIVISIONS.length - 1));
});

test('every effect renders finite, non-silent audio at default params', { skip }, async () => {
  const page = await setup();
  const results = await page.evaluate(async () => {
    const out = {};
    for (const { id } of fx.AUDIO_EFFECTS) {
      const [left, right] = await render(effect(id));
      out[id] = { finite: [...left, ...right].every(Number.isFinite), left: rms(left), right: rms(right), peak: Math.max(...left.map(Math.abs), ...right.map(Math.abs)) };
      last.dispose();
    }
    return out;
  });
  for (const [id, result] of Object.entries(results)) {
    assert.ok(result.finite, `${id} produced non-finite samples`);
    assert.ok(result.left > 0.01 && result.right > 0.01, `${id} is silent: ${JSON.stringify(result)}`);
    assert.ok(result.peak < 4, `${id} blew up: ${result.peak}`);
  }
  await page.close();
});

test('Dry/Wet 0 passes the dry signal unchanged for every effect', { skip }, async () => {
  const page = await setup();
  const results = await page.evaluate(async () => {
    const [refL, refR] = await render(null, { seconds: 0.25 });
    const out = {};
    for (const { id } of fx.AUDIO_EFFECTS) {
      const [left, right] = await render(effect(id, { dryWet: 0 }), { seconds: 0.25 });
      const offset = Math.round(last.latency * SR);
      let diff = 0;
      for (let i = 0; i + offset < left.length; i++) diff = Math.max(diff, Math.abs(left[i + offset] - refL[i]), Math.abs(right[i + offset] - refR[i]));
      out[id] = { diff, offset };
      last.dispose();
    }
    return out;
  });
  for (const [id, { diff }] of Object.entries(results)) assert.ok(diff < 1e-4, `${id} dry mismatch ${diff}`);
  assert.equal(results.compressor.offset, 288, 'compressor dry path is latency compensated');
  await page.close();
});

test('filters: low pass attenuates highs, high pass attenuates lows, band/notch select', { skip }, async () => {
  const page = await setup();
  const r = await page.evaluate(async () => {
    const ratio = async (id, params, freq) => {
      const [dry] = await render(null, { kind: 'sine', freq, amp: 0.5 });
      const [wet] = await render(effect(id, params), { kind: 'sine', freq, amp: 0.5 });
      return rms(wet, 4800) / rms(dry, 4800);
    };
    return {
      lpHigh: await ratio('lowpass', { frequency: 500 }, 8000), lpLow: await ratio('lowpass', { frequency: 5000 }, 200),
      hpLow: await ratio('highpass', { frequency: 2000 }, 60), hpHigh: await ratio('highpass', { frequency: 200 }, 6000),
      bpIn: await ratio('bandpass', { frequency: 1000, q: 5 }, 1000), bpOut: await ratio('bandpass', { frequency: 1000, q: 5 }, 8000),
      notch: await ratio('notch', { frequency: 1000, q: 2 }, 1000),
      eqCut: await ratio('eq', { low: -24 }, 60),
    };
  });
  assert.ok(r.lpHigh < 0.05, `low pass leaks highs ${r.lpHigh}`);
  assert.ok(r.lpLow > 0.9, `low pass cuts lows ${r.lpLow}`);
  assert.ok(r.hpLow < 0.05, `high pass leaks lows ${r.hpLow}`);
  assert.ok(r.hpHigh > 0.9, `high pass cuts highs ${r.hpHigh}`);
  assert.ok(r.bpIn > 0.9 && r.bpOut < 0.1, `band pass ${r.bpIn} ${r.bpOut}`);
  assert.ok(r.notch < 0.05, `notch ${r.notch}`);
  assert.ok(r.eqCut < 0.15, `eq low cut ${r.eqCut}`);
  await page.close();
});

test('delay echoes at the right sample offset, follows BPM sync and ping-pongs', { skip }, async () => {
  const page = await setup();
  const r = await page.evaluate(async () => {
    const eighth = fx.DIVISIONS.findIndex(([label]) => label === '1/8'), quarter = fx.DIVISIONS.findIndex(([label]) => label === '1/4');
    const [plain] = await render(effect('delay', { time: 100, feedback: 0.5, dryWet: 1 }), { kind: 'impulse', seconds: 0.5 });
    const [synced] = await render(effect('delay', { time: 100, feedback: 0, sync: true, division: eighth, dryWet: 1 }, { bpm: 120 }), { kind: 'impulse', seconds: 0.5 });
    const [slow] = await render(ctx => { const e = effect('delay', { time: 100, feedback: 0, sync: true, division: eighth, dryWet: 1 }, { bpm: 120 })(ctx); e.update({ time: 100, feedback: 0, sync: true, division: quarter, dryWet: 1 }, { bpm: 90 }); return e; }, { kind: 'impulse', seconds: 0.8 });
    const [left, right] = await render(effect('pingpong', { time: 100, feedback: 0.5, dryWet: 1 }), { kind: 'impulse', seconds: 0.5 });
    return {
      first: peakIndex(plain), firstValue: plain[peakIndex(plain)], second: peakIndex(plain, 6000), secondValue: plain[peakIndex(plain, 6000)],
      synced: peakIndex(synced), slow: peakIndex(slow), slowValue: Math.abs(slow[peakIndex(slow)]),
      left: peakIndex(left), right: peakIndex(right), rightValue: right[peakIndex(right)], left3: peakIndex(left, 12000), left3Value: left[peakIndex(left, 12000)], leftEarly: Math.max(...right.slice(0, 9000).map(Math.abs)),
    };
  });
  assert.equal(r.first, 4800);
  assert.ok(Math.abs(r.firstValue - 1) < 1e-3, `echo level ${r.firstValue}`);
  assert.equal(r.second, 9600);
  assert.ok(Math.abs(r.secondValue - 0.5) < 1e-3, `feedback level ${r.secondValue}`);
  assert.equal(r.synced, 12000, '1/8 at 120 BPM = 250 ms');
  // Updated to 1/4 at 90 BPM (smoothed via setTargetAtTime, so allow a small slew).
  assert.ok(Math.abs(r.slow - 32000) <= 48, `1/4 at 90 BPM = 666.7 ms, got ${r.slow}`);
  assert.equal(r.left, 4800);
  assert.equal(r.right, 9600);
  assert.ok(Math.abs(r.rightValue - 0.5) < 1e-3 && r.leftEarly < 1e-6, 'ping pong alternates channels');
  assert.equal(r.left3, 14400, 'third bounce back on the left, on time');
  assert.ok(Math.abs(r.left3Value - 0.25) < 1e-3, `third bounce level ${r.left3Value}`);
  await page.close();
});

test('distortion adds harmonics, bit crusher quantizes and holds samples', { skip }, async () => {
  const page = await setup();
  const r = await page.evaluate(async () => {
    const [dry] = await render(null, { kind: 'sine', freq: 220, amp: 0.5 });
    const [wet] = await render(effect('distortion', { drive: 1, tone: 1 }), { kind: 'sine', freq: 220, amp: 0.5 });
    const [crushed] = await render(effect('bitcrusher', { bits: 2, downsample: 1 }), { kind: 'sine', freq: 100, amp: 0.9 });
    const [held] = await render(effect('bitcrusher', { bits: 16, downsample: 8 }), { kind: 'sine', freq: 100, amp: 0.9 });
    const levels = [-1, -0.5, 0, 0.5, 1];
    let onLevel = 0, repeats = 0;
    for (const value of crushed) if (levels.some(level => Math.abs(value - level) < 1e-3)) onLevel++;
    for (let i = 1; i < held.length; i++) if (Math.abs(held[i] - held[i - 1]) < 1e-6) repeats++;
    return {
      dryH3: magnitude(dry, 660) / magnitude(dry, 220), wetH3: magnitude(wet, 660) / magnitude(wet, 220),
      dryRms: rms(dry), wetRms: rms(wet), onLevel: onLevel / crushed.length, repeats: repeats / (held.length - 1), heldRms: rms(held),
    };
  });
  assert.ok(r.dryH3 < 1e-3, `dry sine has harmonics ${r.dryH3}`);
  assert.ok(r.wetH3 > 0.05, `distortion third harmonic ${r.wetH3}`);
  assert.ok(Math.abs(r.wetRms - r.dryRms) > 0.01, 'distortion changes RMS');
  assert.ok(r.onLevel > 0.97, `2-bit output on quantization levels ${r.onLevel}`);
  assert.ok(r.repeats > 0.85 && r.heldRms > 0.5, `sample-and-hold ${r.repeats} ${r.heldRms}`);
  await page.close();
});

test('reverb, width and update(): cached IRs, mid/side and idempotent cheap updates', { skip }, async () => {
  const page = await setup();
  const r = await page.evaluate(async () => {
    const a = fx.reverbImpulse(SR, { size: 1 }), b = fx.reverbImpulse(SR, { size: 1.001 }), c = fx.reverbImpulse(SR, { size: 2 });
    const [tail] = await render(effect('reverb', { dryWet: 1, preDelay: 0 }), { kind: 'impulse', seconds: 1 });
    const [left, right] = await render(effect('width', { width: 0 }));
    const [wideL, wideR] = await render(effect('width', { width: 2 }));
    let monoDiff = 0;
    for (let i = 0; i < left.length; i++) monoDiff = Math.max(monoDiff, Math.abs(left[i] - right[i]));
    const ctx = new OfflineAudioContext(2, SR, SR);
    const reverb = fx.createAudioEffect(ctx, 'reverb', {});
    const ir = reverb.graph.impulse;
    reverb.update({ dryWet: 0.8 });
    const sameIr = reverb.graph.impulse === ir;
    reverb.update({ dryWet: 0.8, size: 4 });
    const newIr = reverb.graph.impulse !== ir;
    const phaser = fx.createAudioEffect(ctx, 'phaser', {});
    phaser.update({ stages: 8 }); phaser.update({ stages: 4 });
    const original = AudioParam.prototype.setTargetAtTime;
    let calls = 0;
    AudioParam.prototype.setTargetAtTime = function (...args) { calls++; return original.apply(this, args); };
    const tremolo = fx.createAudioEffect(ctx, 'tremolo', { depth: 0.5 }, { bpm: 120 });
    for (let i = 0; i < 100; i++) tremolo.update({ depth: 0.5 }, { bpm: 128 + i }); // not synced: BPM irrelevant
    const idle = calls;
    tremolo.update({ depth: 0.5, dryWet: 0.5 });
    const afterMix = calls;
    tremolo.update({ depth: 0.5, dryWet: 0.5, sync: true }, { bpm: 100 });
    const afterSync = calls;
    tremolo.update({ depth: 0.5, dryWet: 0.5, sync: true }, { bpm: 100 });
    const repeat = calls;
    AudioParam.prototype.setTargetAtTime = original;
    reverb.dispose(); phaser.dispose(); tremolo.dispose(); tremolo.dispose();
    return {
      cached: a === b, distinct: a !== c, irLength: c.length, tail: rms(tail, 9600), monoDiff,
      wide: rms(wideL.map((v, i) => v - wideR[i])) / rms(left), sameIr, newIr, idle, afterMix, afterSync, repeat, disposed: tremolo.disposed,
    };
  });
  assert.ok(r.cached && r.distinct, 'impulse cache');
  assert.equal(r.irLength, 2 * 48000 + 480, '2 s tail + default 10 ms pre-delay');
  assert.ok(r.tail > 1e-4, `reverb tail ${r.tail}`);
  assert.ok(r.monoDiff < 1e-6, `width 0 is mono ${r.monoDiff}`);
  assert.ok(r.wide > 1, 'width 2 widens');
  assert.ok(r.sameIr && r.newIr, 'IR regenerated only when IR params change');
  assert.equal(r.idle, 0, 'unchanged params schedule nothing');
  assert.equal(r.afterMix, 2, 'Dry/Wet change touches only the dry and wet gains');
  assert.equal(r.afterSync - r.afterMix, 1, 'enabling sync retunes only the LFO rate');
  assert.equal(r.repeat, r.afterSync);
  assert.ok(r.disposed);
  await page.close();
});

test('AudioEffectChain reuses nodes, skips disabled effects, reorders and diffs connections', { skip }, async () => {
  const page = await setup();
  const r = await page.evaluate(async () => {
    const ctx = new OfflineAudioContext(2, SR / 4, SR);
    const chain = new fx.AudioEffectChain(ctx);
    const out = {};
    const a = { id: 'a', type: 'gain', enabled: true, params: { gain: -6 } };
    const b = { id: 'b', type: 'lowpass', enabled: true, params: {} };
    const c = { id: 'c', type: 'delay', enabled: false, params: {} };
    chain.sync([a, b, c], { bpm: 120 });
    const a1 = chain.getEffect('a'), b1 = chain.getEffect('b');
    out.initial = chain.activeIds; out.disabledCreated = !!chain.getEffect('c');
    // Param-only change: same instances, no connect/disconnect at all.
    const connect = AudioNode.prototype.connect, disconnect = AudioNode.prototype.disconnect;
    let graphCalls = 0;
    AudioNode.prototype.connect = function (...args) { graphCalls++; return connect.apply(this, args); };
    AudioNode.prototype.disconnect = function (...args) { graphCalls++; return disconnect.apply(this, args); };
    chain.sync([{ ...a, params: { gain: -3 } }, b, c], { bpm: 120 });
    out.paramCalls = graphCalls;
    out.reused = chain.getEffect('a') === a1 && chain.getEffect('b') === b1;
    out.updated = chain.getEffect('a').params.gain;
    graphCalls = 0;
    chain.sync([b, a, c]);
    out.reorder = chain.activeIds; out.reorderCalls = graphCalls;
    AudioNode.prototype.connect = connect; AudioNode.prototype.disconnect = disconnect;
    out.reorderReused = chain.getEffect('a') === a1 && chain.getEffect('b') === b1;
    chain.sync([b, a, { ...c, enabled: true }]);
    const c1 = chain.getEffect('c');
    out.enabled = chain.activeIds;
    chain.sync([b, a, c]);
    out.disabled = chain.activeIds; out.keptDisabled = chain.getEffect('c') === c1;
    chain.sync([b, c]);
    out.removed = chain.activeIds; out.aGone = chain.getEffect('a') === undefined && a1.disposed;
    chain.sync([{ ...b, type: 'highpass' }]);
    out.retyped = chain.getEffect('b') !== b1 && b1.disposed && chain.getEffect('b').id === 'highpass';
    out.cGone = c1.disposed;
    chain.sync([]);
    out.empty = chain.activeIds;
    chain.dispose();

    const half = -20 * Math.log10(2);
    const scaled = async (steps, seconds = 0.1) => {
      const [left, right] = await render(context => { const ch = new fx.AudioEffectChain(context); for (const step of steps) ch.sync(step); return ch; }, { seconds });
      const [refL, refR] = await render(null, { seconds });
      let num = 0, den = 0, diff = 0;
      for (let i = 0; i < left.length; i++) { num += left[i] * refL[i] + right[i] * refR[i]; den += refL[i] * refL[i] + refR[i] * refR[i]; }
      const k = num / den;
      for (let i = 0; i < left.length; i++) diff = Math.max(diff, Math.abs(left[i] - k * refL[i]), Math.abs(right[i] - k * refR[i]));
      return { k, diff };
    };
    const A = { id: 'A', type: 'gain', enabled: true, params: { gain: half } }, B = { id: 'B', type: 'gain', enabled: true, params: { gain: half } };
    out.empty0 = await scaled([[]]);
    out.emptyAfter = await scaled([[A], [A, B], [B, A], []]);
    out.both = await scaled([[A], [A, B], [B, A]]);
    out.oneDisabled = await scaled([[A, B], [{ ...B, enabled: false }, A]]);
    out.allDisabled = await scaled([[A, B], [{ ...A, enabled: false }, { ...B, enabled: false }]]);
    return out;
  });
  assert.deepEqual(r.initial, ['a', 'b']);
  assert.equal(r.disabledCreated, false);
  assert.equal(r.paramCalls, 0, 'param change does not touch the graph');
  assert.ok(r.reused);
  assert.equal(r.updated, -3);
  assert.deepEqual(r.reorder, ['b', 'a']);
  assert.ok(r.reorderCalls > 0 && r.reorderCalls <= 8, `reorder rewires only changed edges (${r.reorderCalls})`);
  assert.ok(r.reorderReused);
  assert.deepEqual(r.enabled, ['b', 'a', 'c']);
  assert.deepEqual(r.disabled, ['b', 'a']);
  assert.ok(r.keptDisabled, 'disabled effect keeps its nodes');
  assert.deepEqual(r.removed, ['b']);
  assert.ok(r.aGone && r.retyped && r.cGone);
  assert.deepEqual(r.empty, []);
  const close = ({ k, diff }, expected, label) => assert.ok(Math.abs(k - expected) < 1e-4 && diff < 1e-4, `${label}: k=${k} diff=${diff}`);
  close(r.empty0, 1, 'empty chain passthrough');
  close(r.emptyAfter, 1, 'emptied chain passthrough');
  close(r.both, 0.25, 'two -6 dB gains after reorder');
  close(r.oneDisabled, 0.5, 'disabled effect bypassed');
  close(r.allDisabled, 1, 'all disabled passthrough');
  await page.close();
});
