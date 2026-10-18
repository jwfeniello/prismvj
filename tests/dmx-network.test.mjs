import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const {
  encodeArtDmx, encodeArtPoll, encodeArtPollReply, decodeArtNet, encodeE131, decodeE131, e131MulticastAddress,
  portAddress, splitPortAddress, DmxSender, DmxReceiver, OP_DMX, OP_POLL, OP_POLL_REPLY, E131_TERMINATED,
} = require('../electron/dmx-network.cjs');

const CID = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const collect = (emitter, event) => { const list = []; emitter.on(event, value => list.push(value)); return list; };
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for condition.'); await delay(5); }
}
async function rawSocket() {
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  return socket;
}
const sendRaw = (socket, packet, port) => new Promise((resolve, reject) => socket.send(packet, port, '127.0.0.1', error => error ? reject(error) : resolve()));

test('ArtDmx encodes spec byte offsets and round-trips', () => {
  const packet = encodeArtDmx({ universe: 0x1234, sequence: 7, physical: 2, data: Uint8Array.of(1, 2, 3) });
  assert.equal(packet.subarray(0, 8).toString('latin1'), 'Art-Net\0');
  assert.deepEqual([...packet.subarray(8, 18)], [0x00, 0x50, 0, 14, 7, 2, 0x34, 0x12, 0x00, 0x04]); // OpDmx LE, ProtVer 14, SubUni/Net, length BE (padded even)
  assert.equal(packet.length, 22);
  assert.deepEqual(decodeArtNet(packet), { opcode: OP_DMX, universe: 0x1234, sequence: 7, physical: 2, data: Uint8Array.of(1, 2, 3, 0) });
  const full = encodeArtDmx({ universe: 0, data: new Uint8Array(512).fill(9) });
  assert.deepEqual([full[16], full[17]], [0x02, 0x00]);
  assert.equal(decodeArtNet(full).data.length, 512);
  assert.equal(encodeArtDmx({ data: new Uint8Array(0) }).readUInt16BE(16), 2);
  assert.throws(() => encodeArtDmx({ universe: 0x8000, data: new Uint8Array(2) }), RangeError);
  assert.throws(() => encodeArtDmx({ data: new Uint8Array(513) }), TypeError);
  assert.equal(portAddress(1, 2, 3), 0x123);
  assert.deepEqual(splitPortAddress(0x7fff), { net: 127, subnet: 15, universe: 15 });
});

test('ArtPoll and ArtPollReply round-trip', () => {
  const poll = encodeArtPoll({ flags: 2 });
  assert.equal(poll.length, 14);
  assert.deepEqual([...poll.subarray(8, 14)], [0x00, 0x20, 0, 14, 2, 0x10]);
  assert.deepEqual(decodeArtNet(poll), { opcode: OP_POLL, flags: 2, diagPriority: 0x10 });
  const reply = encodeArtPollReply({ ip: '10.0.0.5', shortName: 'Prism', longName: 'Prism Live DMX input', ports: [{ universe: 0x123, direction: 'output' }, { universe: 0x125, direction: 'input' }] });
  assert.equal(reply.length, 239);
  assert.deepEqual([...reply.subarray(8, 16)], [0x00, 0x21, 10, 0, 0, 5, 0x36, 0x19]);
  const decoded = decodeArtNet(reply);
  assert.equal(decoded.opcode, OP_POLL_REPLY);
  assert.deepEqual([decoded.ip, decoded.port, decoded.netSwitch, decoded.subSwitch, decoded.shortName, decoded.longName],
    ['10.0.0.5', 6454, 1, 2, 'Prism', 'Prism Live DMX input']);
  assert.deepEqual(decoded.ports, [{ direction: 'output', universe: 0x123 }, { direction: 'input', universe: 0x125 }]);
  assert.throws(() => encodeArtPollReply({ ip: '10.0.0.5', ports: [{ universe: 0x10, direction: 'output' }, { universe: 0x20, direction: 'output' }] }), RangeError);
});

test('Art-Net decoder rejects malformed packets', () => {
  const good = encodeArtDmx({ universe: 1, data: new Uint8Array(4) });
  const mutate = fn => { const copy = Buffer.from(good); fn(copy); return copy; };
  assert.ok(decodeArtNet(good));
  assert.equal(decodeArtNet(mutate(p => { p[0] = 0x61; })), null); // header
  assert.equal(decodeArtNet(mutate(p => { p[7] = 0x20; })), null); // missing NUL
  assert.equal(decodeArtNet(mutate(p => { p[11] = 13; })), null); // protocol version
  assert.equal(decodeArtNet(mutate(p => { p.writeUInt16BE(3, 16); })), null); // odd length
  assert.equal(decodeArtNet(mutate(p => { p.writeUInt16BE(6, 16); })), null); // length mismatch
  assert.equal(decodeArtNet(mutate(p => { p[15] = 0x80; })), null); // Net high bit
  assert.equal(decodeArtNet(mutate(p => { p.writeUInt16LE(0x9999, 8); })), null); // unknown opcode
  assert.equal(decodeArtNet(good.subarray(0, 19)), null);
  assert.equal(decodeArtNet(Buffer.concat([good, Buffer.alloc(2)])), null);
  assert.equal(decodeArtNet(encodeArtPollReply({ ip: '1.2.3.4' }).subarray(0, 200)), null);
  for (const junk of [null, undefined, 'Art-Net', 42, {}, Buffer.alloc(0)]) assert.equal(decodeArtNet(junk), null);
});

test('E1.31 encodes root/framing/DMP layers and round-trips', () => {
  const data = new Uint8Array(512).map((_, i) => i * 7 & 255);
  const packet = encodeE131({ universe: 0x0102, sequence: 200, priority: 150, sourceName: 'Prism Live', cid: CID, data });
  assert.equal(packet.length, 638);
  assert.deepEqual([...packet.subarray(0, 4)], [0x00, 0x10, 0x00, 0x00]);
  assert.equal(packet.subarray(4, 16).toString('latin1'), 'ASC-E1.17\0\0\0');
  assert.equal(packet.readUInt16BE(16), 0x7000 | 622); assert.equal(packet.readUInt32BE(18), 4);
  assert.deepEqual([...packet.subarray(22, 38)], [...CID]);
  assert.equal(packet.readUInt16BE(38), 0x7000 | 600); assert.equal(packet.readUInt32BE(40), 2);
  assert.equal(packet.subarray(44, 54).toString(), 'Prism Live'); assert.equal(packet[54], 0);
  assert.deepEqual([packet[108], packet.readUInt16BE(109), packet[111], packet[112], packet.readUInt16BE(113)], [150, 0, 200, 0, 0x0102]);
  assert.equal(packet.readUInt16BE(115), 0x7000 | 523);
  assert.deepEqual([packet[117], packet[118], packet.readUInt16BE(119), packet.readUInt16BE(121), packet.readUInt16BE(123), packet[125]], [0x02, 0xa1, 0, 1, 513, 0]);
  const decoded = decodeE131(packet);
  assert.deepEqual({ ...decoded, data: undefined, cid: undefined }, {
    universe: 0x0102, sequence: 200, priority: 150, syncAddress: 0, options: 0, preview: false, terminated: false,
    sourceName: 'Prism Live', startCode: 0, data: undefined, cid: undefined,
  });
  assert.deepEqual(decoded.data, data); assert.deepEqual(decoded.cid, CID);
  const short = decodeE131(encodeE131({ universe: 1, cid: CID, data: Uint8Array.of(5, 6, 7), options: E131_TERMINATED }));
  assert.deepEqual([[...short.data], short.terminated], [[5, 6, 7], true]);
  const long = encodeE131({ universe: 1, cid: CID, data: new Uint8Array(1), sourceName: 'é'.repeat(40) });
  assert.equal(decodeE131(long).sourceName, 'é'.repeat(31)); // truncated on a UTF-8 boundary, NUL kept
  assert.equal(e131MulticastAddress(1), '239.255.0.1');
  assert.equal(e131MulticastAddress(63999), '239.255.249.255');
  assert.throws(() => e131MulticastAddress(0), RangeError);
  assert.throws(() => encodeE131({ universe: 64000, cid: CID, data: new Uint8Array(1) }), RangeError);
  assert.throws(() => encodeE131({ universe: 1, cid: new Uint8Array(4), data: new Uint8Array(1) }), TypeError);
  assert.throws(() => encodeE131({ universe: 1, priority: 201, cid: CID, data: new Uint8Array(1) }), RangeError);
});

test('E1.31 decoder rejects malformed packets', () => {
  const good = encodeE131({ universe: 1, cid: CID, data: new Uint8Array(8) });
  const mutate = fn => { const copy = Buffer.from(good); fn(copy); return copy; };
  assert.ok(decodeE131(good));
  assert.equal(decodeE131(mutate(p => { p[1] = 0x11; })), null); // preamble
  assert.equal(decodeE131(mutate(p => { p[4] = 0x42; })), null); // ACN identifier
  assert.equal(decodeE131(mutate(p => { p.writeUInt16BE(0x7000 | 10, 16); })), null); // root length
  assert.equal(decodeE131(mutate(p => { p.writeUInt16BE(0x6000 | good.length - 16, 16); })), null); // root flags
  assert.equal(decodeE131(mutate(p => { p.writeUInt32BE(8, 18); })), null); // extended packets ignored
  assert.equal(decodeE131(mutate(p => { p.writeUInt32BE(3, 40); })), null); // framing vector
  assert.equal(decodeE131(mutate(p => { p[108] = 201; })), null); // priority
  assert.equal(decodeE131(mutate(p => { p.writeUInt16BE(0, 113); })), null); // universe 0
  assert.equal(decodeE131(mutate(p => { p.writeUInt16BE(64000, 113); })), null);
  assert.equal(decodeE131(mutate(p => { p[118] = 0xa0; })), null); // address/data type
  assert.equal(decodeE131(mutate(p => { p.writeUInt16BE(10, 123); })), null); // property count mismatch
  assert.equal(decodeE131(good.subarray(0, 125)), null);
  assert.equal(decodeE131(Buffer.concat([good, Buffer.alloc(1)])), null);
  for (const junk of [null, 'x', 7, Buffer.alloc(700)]) assert.equal(decodeE131(junk), null);
});

test('sender and receiver validate options like the OSC server', async () => {
  assert.throws(() => new DmxReceiver({ port: 80 }), RangeError);
  assert.throws(() => new DmxReceiver({ port: 70000 }), RangeError);
  assert.throws(() => new DmxReceiver({ bindAddress: 'localhost' }), RangeError);
  assert.throws(() => new DmxReceiver({ protocol: 'dmx' }), RangeError);
  assert.throws(() => new DmxReceiver({ protocol: 'sacn', universes: [0] }), RangeError);
  assert.throws(() => new DmxSender({ host: 'example.com' }), RangeError);
  assert.throws(() => new DmxSender({ host: '239.255.0.1' }), RangeError); // Art-Net is never multicast
  assert.throws(() => new DmxSender({ rate: 0 }), RangeError);
  assert.equal(new DmxSender({ protocol: 'sacn' }).host, null); // per-universe multicast
  assert.equal(new DmxSender().host, '255.255.255.255');
  const sender = new DmxSender({ host: '2.255.255.255' });
  assert.throws(() => sender.send(40000, new Uint8Array(1)), RangeError);
  assert.throws(() => sender.send(0, [1, 2, 3]), TypeError);
  assert.throws(() => new DmxSender({ protocol: 'sacn' }).send(0, new Uint8Array(1)), RangeError);
  const first = new DmxReceiver({ port: 0, bindAddress: '127.0.0.1' });
  await first.start();
  try {
    const clash = new DmxReceiver({ port: first.address().port, bindAddress: '127.0.0.1' });
    await assert.rejects(clash.start());
    assert.equal(clash.active, false);
  } finally { await first.stop(); }
});

test('Art-Net loopback delivers frames, coalesces bursts and rate-limits', async () => {
  const receiver = new DmxReceiver({ protocol: 'artnet', port: 0, bindAddress: '127.0.0.1' });
  await receiver.start();
  const events = collect(receiver, 'dmx');
  const sender = new DmxSender({ protocol: 'artnet', host: '127.0.0.1', port: receiver.address().port, rate: 20, keepAliveMs: 5000 });
  await sender.start();
  try {
    const frame = new Uint8Array(512).map((_, i) => i & 255);
    assert.equal(sender.send(3, frame), true);
    await until(() => events.length === 1);
    assert.deepEqual([events[0].universe, events[0].source, events[0].length], [3, '127.0.0.1', 512]);
    assert.deepEqual(events[0].data, frame);
    assert.equal(sender.send(3, frame), false); // unchanged: nothing queued

    await delay(60);
    const before = sender.stats.sent;
    for (let i = 1; i <= 5; i++) sender.send(3, new Uint8Array(512).fill(i));
    await until(() => events.at(-1).data[0] === 5);
    await delay(80);
    assert.equal(sender.stats.sent - before, 2); // first immediately, the latest once the 50 ms slot opens
    assert.deepEqual(events.slice(1).map(event => event.data[0]), [1, 5]);

    const start = Date.now(), burst = sender.stats.sent;
    let frames = 0;
    while (Date.now() - start < 300) { sender.send(3, new Uint8Array(512).fill(10 + frames++ % 200)); await delay(2); }
    await delay(60);
    assert.ok(frames > 20, `sent ${frames} frames`);
    assert.ok(sender.stats.sent - burst <= Math.ceil(360 / 50) + 1, `transmitted ${sender.stats.sent - burst}`);
    assert.equal(receiver.stats.rejected, 0);
  } finally { await sender.stop(); await receiver.stop(); }
});

test('keep-alive resends unchanged universes without re-emitting them', async () => {
  const receiver = new DmxReceiver({ port: 0, bindAddress: '127.0.0.1' });
  await receiver.start();
  const events = collect(receiver, 'dmx');
  const sender = new DmxSender({ host: '127.0.0.1', port: receiver.address().port, keepAliveMs: 60 });
  await sender.start();
  try {
    sender.send(0, Uint8Array.of(1, 2, 3, 4));
    await until(() => events.length === 1);
    await delay(400);
    assert.ok(sender.stats.keepAlive >= 3, `keep-alives: ${sender.stats.keepAlive}`);
    assert.ok(receiver.stats.received >= 4);
    assert.equal(events.length, 1);
    assert.deepEqual([...events[0].data.subarray(0, 5)], [1, 2, 3, 4, 0]);
  } finally { await sender.stop(); await receiver.stop(); }
});

test('sACN loopback, sequence ordering, priority and malformed input', async () => {
  const receiver = new DmxReceiver({ protocol: 'sacn', port: 0, bindAddress: '127.0.0.1', universes: [1] });
  await receiver.start();
  const events = collect(receiver, 'dmx');
  const port = receiver.address().port;
  const sender = new DmxSender({ protocol: 'sacn', host: '127.0.0.1', port, cid: CID, sourceName: 'Test' });
  await sender.start();
  sender.send(1, Uint8Array.of(9, 8, 7));
  await until(() => events.length === 1);
  assert.deepEqual([events[0].universe, events[0].length, [...events[0].data.subarray(0, 4)], events[0].protocol], [1, 3, [9, 8, 7, 0], 'sacn']);
  await sender.stop(); // stream-terminated packets release the universe

  const raw = await rawSocket();
  const cid = Uint8Array.from({ length: 16 }, () => 0xab);
  const packet = (sequence, value, extra = {}) => encodeE131({ universe: 1, sequence, cid, data: Uint8Array.of(value), ...extra });
  try {
    await sendRaw(raw, packet(10, 1), port); await until(() => events.length === 2);
    await sendRaw(raw, packet(9, 2), port); // late
    await sendRaw(raw, packet(10, 3), port); // duplicate
    await sendRaw(raw, packet(12, 1, { priority: 50, cid: CID }), port); // lower priority source
    await sendRaw(raw, packet(11, 4, { options: 0x80 }), port); // preview data
    await sendRaw(raw, encodeE131({ universe: 2, cid, data: Uint8Array.of(9) }), port); // not subscribed
    await sendRaw(raw, Buffer.from('garbage'), port);
    await sendRaw(raw, packet(11, 5), port);
    await until(() => events.length === 3);
    await delay(30);
    assert.deepEqual(events.slice(1).map(event => event.data[0]), [1, 5]);
    assert.ok(receiver.stats.rejected >= 1);
    assert.ok(receiver.stats.ignored >= 5);
  } finally { raw.close(); await receiver.stop(); }
});

test('Art-Net receiver answers ArtPoll with its input universes', async () => {
  const receiver = new DmxReceiver({ port: 0, bindAddress: '127.0.0.1', universes: [0x10, 0x11], pollReply: { ip: '127.0.0.1', shortName: 'Prism' } });
  await receiver.start();
  const polls = collect(receiver, 'poll');
  const raw = await rawSocket();
  try {
    const reply = new Promise(resolve => raw.once('message', resolve));
    await sendRaw(raw, encodeArtPoll(), receiver.address().port);
    const decoded = decodeArtNet(await reply);
    assert.equal(polls.length, 1);
    assert.deepEqual([decoded.opcode, decoded.ip, decoded.shortName], [OP_POLL_REPLY, '127.0.0.1', 'Prism']);
    assert.deepEqual(decoded.ports, [{ direction: 'output', universe: 0x10 }, { direction: 'output', universe: 0x11 }]);
  } finally { raw.close(); await receiver.stop(); }
});
