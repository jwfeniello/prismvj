import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDmxConfig, sampleFixtures, createDmxSampler, fixtureSampleRect, dmxInputToValue, dmxValueToIndex,
  findChannelOverlaps, dmxUniverseRoutes, fixtureFootprint, artnetPortAddress, splitArtnetPortAddress, DMX_LIMITS,
} from '../src/dmx.js';

// RGBA frame from a top-down colour function; flipY stores it bottom row first like WebGL readPixels.
function image(width, height, color, flipY = true) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = color(x, y), at = ((flipY ? height - 1 - y : y) * width + x) * 4;
    pixels.set([r, g, b, 255], at);
  }
  return pixels;
}
const config = (fixture, extra = {}) => normalizeDmxConfig({
  lumiverses: [{ id: 'L1', universe: 0 }], ...extra,
  fixtures: [{ id: 'F1', lumiverseId: 'L1', rect: { x: 0, y: 0, width: 2, height: 2 }, ...fixture }],
});
const uniform = rgb => image(2, 2, () => rgb);
const bytes = (out, universe, count, from = 0) => [...out.get(universe).subarray(from, from + count)];

test('normalizeDmxConfig fills defaults', () => {
  assert.deepEqual(normalizeDmxConfig(undefined), {
    version: 1, enabled: false, protocol: 'artnet', host: '255.255.255.255', port: 6454, rate: 44, lumiverses: [], fixtures: [],
    input: { enabled: false, protocol: 'artnet', port: 6454, bindAddress: '0.0.0.0', universe: 0, channelOffset: 0 },
  });
  const fixture = config({}).fixtures[0];
  assert.deepEqual(fixture, {
    id: 'F1', name: 'F1', lumiverseId: 'L1', enabled: true, startChannel: 1, rect: { x: 0, y: 0, width: 2, height: 2 }, rotation: 0,
    columns: 1, rows: 1, order: 'row-major', flipH: false, flipV: false, channels: 'rgb', brightness: 1, gamma: 1, whiteMode: 'extract', blackLevel: 0,
  });
  const sacn = normalizeDmxConfig({ protocol: 'sacn', lumiverses: [{ id: 'a', universe: 0 }], input: { enabled: true, protocol: 'sacn', universe: 0, channelOffset: 600, bindAddress: 'x' } });
  assert.equal(sacn.host, ''); assert.equal(sacn.port, 5568); assert.equal(sacn.lumiverses[0].universe, 1);
  assert.deepEqual(sacn.input, { enabled: true, protocol: 'sacn', port: 5568, bindAddress: '0.0.0.0', universe: 1, channelOffset: 511 });
});

test('normalizeDmxConfig applies an allow-list and rejects bad entries', () => {
  const cfg = normalizeDmxConfig(JSON.parse(JSON.stringify({
    protocol: 'dmx', port: 80, rate: 1000, host: '999.1.1.1', evil: 1,
    lumiverses: [{ id: 'a', universe: 40000, x: 1 }, { id: 'a', universe: 2 }, { id: 'bad id!' }, { id: 'b', universe: 40000 }, { id: 'c', universe: 3, host: '10.0.0.9', name: 'Tubes\u0007' }],
    fixtures: [
      { id: 'f', lumiverseId: 'nope' },
      { id: 'g', lumiverseId: 'c', channels: 'xyz', startChannel: 9999, columns: 0, order: 'spiral', gamma: 'x' },
      { id: 'g', lumiverseId: 'c' },
      { id: 'h', lumiverseId: 'a', startChannel: 511 },
    ],
  }).replace('"evil":1', '"evil":1,"__proto__":{"polluted":true}')));
  assert.equal(cfg.protocol, 'artnet'); assert.equal(cfg.port, 6454); assert.equal(cfg.rate, 100); assert.equal(cfg.host, '255.255.255.255');
  assert.equal('evil' in cfg, false); assert.equal({}.polluted, undefined);
  assert.deepEqual(cfg.lumiverses.map(l => [l.id, l.universe, l.host]), [['a', 32767, ''], ['c', 3, '10.0.0.9']]);
  assert.equal(cfg.lumiverses[1].name, 'Tubes');
  assert.equal('x' in cfg.lumiverses[0], false);
  assert.deepEqual(cfg.fixtures.map(f => f.id), ['g']); // h would spill past universe 32767
  const g = cfg.fixtures[0];
  assert.deepEqual([g.channels, g.startChannel, g.columns, g.order, g.gamma], ['rgb', 512, 1, 'row-major', 1]);
  assert.deepEqual([...dmxUniverseRoutes(cfg)], [[3, '10.0.0.9'], [4, '10.0.0.9']]);
});

test('normalizeDmxConfig enforces limits', () => {
  const many = normalizeDmxConfig({ lumiverses: Array.from({ length: 70 }, (_, i) => ({ id: `L${i}`, universe: i })) });
  assert.equal(many.lumiverses.length, DMX_LIMITS.lumiverses);
  const fixtures = normalizeDmxConfig({ lumiverses: [{ id: 'L', universe: 0 }], fixtures: Array.from({ length: 1100 }, (_, i) => ({ id: `F${i}`, lumiverseId: 'L' })) });
  assert.equal(fixtures.fixtures.length, DMX_LIMITS.fixtures);
  const universes = normalizeDmxConfig({
    lumiverses: [{ id: 'U0', universe: 0 }, { id: 'U1', universe: 100 }, { id: 'U2', universe: 10 }],
    fixtures: [
      { id: 'huge', lumiverseId: 'U0', columns: 100, rows: 100 },
      { id: 'big', lumiverseId: 'U0', columns: 128, rows: 64, channels: 'rgbw' }, // 32768 channels = universes 0..63
      { id: 'over', lumiverseId: 'U1' }, { id: 'inside', lumiverseId: 'U2' },
    ],
  });
  assert.deepEqual(universes.fixtures.map(f => f.id), ['big', 'inside']);
  assert.equal(fixtureFootprint(universes.fixtures[0]), 32768);
});

test('samples a 4x2 snake-ordered RGB fixture with box filtering and flipY', () => {
  const color = (col, row) => [col * 50 + 10, row * 100 + 20, 200 - col * 30 - row * 10];
  const draw = (x, y) => {
    const col = x >> 1, row = y >> 1, rgb = color(col, row);
    if (col === 0 && row === 0) rgb[0] = [4, 8, 12, 16][(y & 1) * 2 + (x & 1)]; // averages to 10
    return rgb;
  };
  const cfg = config({ rect: { x: 0, y: 0, width: 8, height: 4 }, columns: 4, rows: 2, order: 'snake' });
  const expected = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1]].flatMap(([c, r]) => color(c, r));
  const out = sampleFixtures(image(8, 4, draw), 8, 4, cfg);
  assert.deepEqual([...out.keys()], [0]);
  assert.deepEqual(bytes(out, 0, 24), expected);
  assert.ok(out.get(0).subarray(24).every(v => v === 0));
  assert.deepEqual(bytes(sampleFixtures(image(8, 4, draw, false), 8, 4, cfg, { flipY: false }), 0, 24), expected);
  const swapped = [[0, 1], [1, 1], [2, 1], [3, 1], [3, 0], [2, 0], [1, 0], [0, 0]].flatMap(([c, r]) => color(c, r));
  assert.deepEqual(bytes(sampleFixtures(image(8, 4, draw, false), 8, 4, cfg), 0, 24), swapped);
  const flipped = config({ rect: { x: 0, y: 0, width: 8, height: 4 }, columns: 4, rows: 2, order: 'column-major', flipH: true });
  assert.deepEqual(bytes(sampleFixtures(image(8, 4, draw), 8, 4, flipped), 0, 24), [[3, 0], [3, 1], [2, 0], [2, 1], [1, 0], [1, 1], [0, 0], [0, 1]].flatMap(([c, r]) => color(c, r)));
});

test('channel orders, luminance and dimmer layouts', () => {
  const pixels = uniform([10, 20, 30]);
  const cases = { rgb: [10, 20, 30], rbg: [10, 30, 20], grb: [20, 10, 30], gbr: [20, 30, 10], brg: [30, 10, 20], bgr: [30, 20, 10], w: [19] };
  for (const [channels, want] of Object.entries(cases)) assert.deepEqual(bytes(sampleFixtures(pixels, 2, 2, config({ channels })), 0, want.length), want, channels);
  assert.deepEqual(bytes(sampleFixtures(pixels, 2, 2, config({ channels: 'dimmer-rgb', brightness: 0.5 })), 0, 4), [128, 10, 20, 30]);
  assert.deepEqual(bytes(sampleFixtures(pixels, 2, 2, config({ channels: 'rgb-dimmer', brightness: 0.5 })), 0, 4), [10, 20, 30, 128]);
});

test('gamma, brightness and black level', () => {
  const out = sampleFixtures(uniform([128, 255, 0]), 2, 2, config({ gamma: 2.2, brightness: 0.5 }));
  assert.equal(Math.round(255 * 0.5 * (128 / 255) ** 2.2), 28);
  assert.deepEqual(bytes(out, 0, 3), [28, 128, 0]);
  assert.deepEqual(bytes(sampleFixtures(uniform([10, 30, 200]), 2, 2, config({ blackLevel: 0.1 })), 0, 3), [0, 30, 200]);
  const dim = normalizeDmxConfig({ lumiverses: [{ id: 'L1', universe: 0, brightness: 0.5 }], fixtures: [{ id: 'F1', lumiverseId: 'L1', rect: { x: 0, y: 0, width: 2, height: 2 } }] });
  assert.deepEqual(bytes(sampleFixtures(uniform([200, 100, 0]), 2, 2, dim), 0, 3), [100, 50, 0]);
});

test('RGBW and RGBA white extraction', () => {
  const pixels = uniform([200, 150, 100]);
  assert.deepEqual(bytes(sampleFixtures(pixels, 2, 2, config({ channels: 'rgbw' })), 0, 4), [100, 50, 0, 100]);
  assert.deepEqual(bytes(sampleFixtures(pixels, 2, 2, config({ channels: 'rgbw', whiteMode: 'add' })), 0, 4), [200, 150, 100, 100]);
  assert.deepEqual(bytes(sampleFixtures(pixels, 2, 2, config({ channels: 'rgbw', whiteMode: 'off' })), 0, 4), [200, 150, 100, 0]);
  assert.deepEqual(bytes(sampleFixtures(pixels, 2, 2, config({ channels: 'wrgb' })), 0, 4), [100, 100, 50, 0]);
  assert.deepEqual(bytes(sampleFixtures(uniform([200, 150, 0]), 2, 2, config({ channels: 'rgba' })), 0, 4), [0, 0, 0, 200]);
});

test('fixtures spill over into the next universe', () => {
  const cfg = normalizeDmxConfig({
    lumiverses: [{ id: 'L', universe: 5 }],
    fixtures: [{ id: 'bar', lumiverseId: 'L', startChannel: 500, rect: { x: 0, y: 0, width: 10, height: 1 }, columns: 10 }],
  });
  const out = sampleFixtures(image(10, 1, x => [x + 1, 100 + x, 200 + x]), 10, 1, cfg);
  const flat = Array.from({ length: 10 }, (_, x) => [x + 1, 100 + x, 200 + x]).flat();
  assert.deepEqual([...out.keys()].sort(), [5, 6]);
  assert.deepEqual(bytes(out, 5, 13, 499), flat.slice(0, 13));
  assert.deepEqual(bytes(out, 6, 17), flat.slice(13));
  assert.deepEqual([...dmxUniverseRoutes(cfg).keys()], [5, 6]);
});

test('rotation and region readback mapping', () => {
  const rotated = config({ rect: { x: 0, y: 1, width: 4, height: 2 }, columns: 2, rotation: 90 });
  const out = sampleFixtures(image(4, 4, (x, y) => y < 2 ? [255, 0, 0] : [0, 255, 0]), 4, 4, rotated);
  assert.deepEqual(bytes(out, 0, 6), [255, 0, 0, 0, 255, 0]);
  assert.deepEqual(fixtureSampleRect(rotated), { x: 1, y: 0, width: 2, height: 4 });

  const cfg = config({ rect: { x: 100, y: 100, width: 40, height: 20 }, columns: 2 });
  const region = fixtureSampleRect(cfg, { width: 1920, height: 1080 });
  assert.deepEqual(region, { x: 100, y: 100, width: 40, height: 20 });
  const small = image(20, 10, x => x < 10 ? [1, 2, 3] : [4, 5, 6]); // half-resolution readback of the region
  assert.deepEqual(bytes(sampleFixtures(small, 20, 10, cfg, { region }), 0, 6), [1, 2, 3, 4, 5, 6]);
  const edge = config({ rect: { x: 0, y: 0, width: 100, height: 10 }, rotation: 90 });
  assert.deepEqual(fixtureSampleRect(edge, { width: 200, height: 200 }), { x: 45, y: 0, width: 10, height: 55 });
  assert.equal(fixtureSampleRect(normalizeDmxConfig({})), null);
});

test('cells partly outside the frame count the outside as black', () => {
  const cfg = config({ rect: { x: -2, y: 0, width: 4, height: 2 } });
  assert.deepEqual(bytes(sampleFixtures(uniform([200, 100, 50]), 2, 2, cfg), 0, 3), [100, 50, 25]);
});

test('sampler caches geometry by fixture signature and reuses buffers', () => {
  const sampler = createDmxSampler();
  const pixels = image(8, 4, () => [50, 60, 70]);
  const cfg = config({ rect: { x: 0, y: 0, width: 8, height: 4 }, columns: 4, rows: 2 });
  const first = sampler.sample(pixels, 8, 4, cfg);
  const buffer = first.get(0);
  const second = sampler.sample(pixels, 8, 4, cfg);
  assert.equal(second, first); assert.equal(second.get(0), buffer);
  assert.deepEqual({ ...sampler.stats }, { builds: 1, plans: 1, frames: 2 });
  sampler.sample(pixels, 8, 4, config({ rect: { x: 0, y: 0, width: 8, height: 4 }, columns: 4, rows: 2, brightness: 0.5 }));
  assert.equal(sampler.stats.builds, 1); assert.equal(sampler.stats.plans, 2);
  assert.equal(buffer[0], 25);
  sampler.sample(pixels, 8, 4, config({ rect: { x: 1, y: 0, width: 7, height: 4 }, columns: 4, rows: 2 }));
  assert.equal(sampler.stats.builds, 2);
  sampler.sample(image(4, 2, () => [0, 0, 0]), 4, 2, cfg);
  assert.equal(sampler.stats.builds, 3);
  const moved = normalizeDmxConfig({ lumiverses: [{ id: 'L1', universe: 7 }], fixtures: [{ id: 'F1', lumiverseId: 'L1', rect: { x: 0, y: 0, width: 8, height: 4 }, columns: 4, rows: 2 }] });
  assert.deepEqual([...sampler.sample(pixels, 8, 4, moved).keys()], [7]);
  assert.throws(() => sampler.sample(new Uint8Array(4), 8, 4, cfg), TypeError);
  assert.throws(() => sampler.sample(pixels, 0, 4, cfg), RangeError);
});

test('patch overlaps are detected', () => {
  const cfg = normalizeDmxConfig({
    lumiverses: [{ id: 'L', universe: 0 }],
    fixtures: [
      { id: 'a', lumiverseId: 'L', columns: 16 }, { id: 'b', lumiverseId: 'L', columns: 16, startChannel: 40 },
      { id: 'c', lumiverseId: 'L', columns: 16, startChannel: 97 },
    ],
  });
  assert.deepEqual(findChannelOverlaps(cfg), [['a', 'b']]);
});

test('DMX shortcut input helpers', () => {
  const data = new Uint8Array(512);
  data[0] = 255; data[9] = 0x80; data[10] = 0x00; data[511] = 51;
  assert.equal(dmxInputToValue(data, 1), 1);
  assert.equal(dmxInputToValue(data, 1, { invert: true }), 0);
  assert.equal(dmxInputToValue(data, 10, { fine: true }), 0x8000 / 65535);
  assert.equal(dmxInputToValue(data, 5, { offset: 5 }), 128 / 255);
  assert.equal(dmxInputToValue(data, 512), 0.2);
  assert.equal(dmxInputToValue(data, 512, { fine: true }), null);
  assert.equal(dmxInputToValue(data, 0), null);
  assert.equal(dmxInputToValue([1, 2], 1), null);
  assert.deepEqual([0, 63, 64, 127, 128, 191, 192, 255].map(v => dmxValueToIndex(v, 4)), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(artnetPortAddress(1, 2, 3), 0x123);
  assert.deepEqual(splitArtnetPortAddress(0x123), { net: 1, subnet: 2, universe: 3 });
  assert.equal(artnetPortAddress(0, 16, 0), null);
});
