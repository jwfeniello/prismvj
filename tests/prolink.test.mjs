// Pro DJ Link client against a simulated network: fake players send real
// packet layouts over UDP and a fake database server answers track lookups.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { createRequire } from 'node:module';

const { ProLink, parseAnnounce, parseBeat, parseStatus, makeAnnounce, interfaceFor, queryTrack, HEADER } = createRequire(import.meta.url)('../electron/prolink.cjs');

function packet(type, length, fill) {
  const buffer = Buffer.alloc(length);
  HEADER.copy(buffer, 0);
  buffer[0x0a] = type;
  fill(buffer);
  return buffer;
}
const pitchBytes = (buffer, offset, percent) => { const value = Math.round(0x100000 + percent / 100 * 0x100000); buffer[offset] = value >> 16 & 255; buffer[offset + 1] = value >> 8 & 255; buffer[offset + 2] = value & 255; };
function statusPacket({ device = 2, trackDevice = 2, slot = 3, type = 1, trackId = 1234, playState = 0x03, flags = 0x40 | 0x20 | 0x08, bpm = 12800, pitch = 0, beat = 33, beatInBar = 1 } = {}) {
  return packet(0x0a, 0xd4, buffer => {
    buffer.write('CDJ-3000', 0x0b, 'latin1');
    buffer[0x21] = device; buffer[0x28] = trackDevice; buffer[0x29] = slot; buffer[0x2a] = type; buffer.writeUInt32BE(trackId, 0x2c);
    buffer[0x7b] = playState; buffer[0x89] = flags; buffer.writeUInt16BE(bpm, 0x92); pitchBytes(buffer, 0x99, pitch);
    buffer.writeUInt32BE(beat, 0xa0); buffer[0xa6] = beatInBar; buffer.writeUInt32BE(7, 0xc8);
  });
}
const beatPacket = ({ device = 2, bpm = 12800, pitch = 0, beatInBar = 3 } = {}) => packet(0x28, 0x60, buffer => { buffer.write('CDJ-3000', 0x0b, 'latin1'); buffer[0x21] = device; buffer.writeUInt32BE(468, 0x24); pitchBytes(buffer, 0x55, pitch); buffer.writeUInt16BE(bpm, 0x5a); buffer[0x5c] = beatInBar; });
const positionPacket = ({ device = 2, length = 300, ms = 61500, pitch = 0, bpm = 1280 } = {}) => packet(0x0b, 0x3c, buffer => { buffer[0x21] = device; buffer.writeUInt32BE(length, 0x24); buffer.writeUInt32BE(ms, 0x28); buffer.writeInt32BE(Math.round(pitch * 100), 0x2c); buffer.writeUInt32BE(bpm, 0x38); });

test('packet parsers read announce, status, beat and absolute position packets', () => {
  const announce = makeAnnounce({ number: 3, name: 'CDJ-2000NXS2', mac: [1, 2, 3, 4, 5, 6], ip: '192.168.1.23' });
  assert.equal(announce.length, 0x36);
  assert.deepEqual(parseAnnounce(announce), { number: 3, name: 'CDJ-2000NXS2', type: 'cdj', mac: [1, 2, 3, 4, 5, 6], ip: '192.168.1.23' });
  const status = parseStatus(statusPacket({ pitch: 6, beat: 129 }));
  assert.equal(status.device, 2);
  assert.equal(status.trackId, 1234);
  assert.deepEqual([status.playing, status.master, status.onAir, status.sync], [true, true, true, false]);
  assert.equal(status.playState, 'playing');
  assert.equal(status.trackBpm, 128);
  assert.ok(Math.abs(status.pitch - 6) < 0.01);
  assert.equal(status.beat, 129);
  assert.equal(parseStatus(statusPacket({ bpm: 0xffff })).trackBpm, null);
  const beat = parseBeat(beatPacket({ pitch: -2, beatInBar: 4 }));
  assert.deepEqual([beat.kind, beat.device, beat.bpm, beat.beatInBar], ['beat', 2, 128, 4]);
  assert.ok(Math.abs(beat.pitch + 2) < 0.01);
  const position = parseBeat(positionPacket({ ms: 90250, pitch: 3.5 }));
  assert.deepEqual([position.kind, position.positionMs, position.length, position.pitch, position.bpm], ['position', 90250, 300, 3.5, 128]);
  // Junk and short packets are ignored.
  assert.equal(parseStatus(Buffer.from('hello')), null);
  assert.equal(parseStatus(packet(0x0a, 0x40, () => {})), null);
  assert.equal(parseBeat(packet(0x28, 0x20, () => {})), null);
  assert.equal(parseAnnounce(packet(0x0a, 0x36, () => {})), null);
});

test('interfaceFor picks the interface on the players\' subnet', () => {
  const interfaces = {
    wifi: [{ family: 'IPv4', address: '10.0.0.5', netmask: '255.255.255.0', mac: 'aa:bb:cc:dd:ee:01', internal: false }],
    lan: [{ family: 'IPv4', address: '192.168.1.10', netmask: '255.255.255.0', mac: 'aa:bb:cc:dd:ee:02', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', mac: '00:00:00:00:00:00', internal: true }],
  };
  assert.deepEqual(interfaceFor('192.168.1.23', interfaces), { address: '192.168.1.10', mac: [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 2], broadcast: '192.168.1.255' });
  assert.equal(interfaceFor('172.16.0.2', interfaces).address, '10.0.0.5');
  assert.equal(interfaceFor('1.2.3.4', { lo: interfaces.lo }), null);
});

// ---- a fake player database server

const field = {
  u32: value => { const b = Buffer.alloc(5); b[0] = 0x11; b.writeUInt32BE(value >>> 0, 1); return b; },
  u16: value => { const b = Buffer.alloc(3); b[0] = 0x10; b.writeUInt16BE(value, 1); return b; },
  u8: value => Buffer.from([0x0f, value]),
  binary: data => { const b = Buffer.alloc(5); b[0] = 0x14; b.writeUInt32BE(data.length, 1); return Buffer.concat([b, data]); },
  string: text => { const data = Buffer.from(`${text}\0`, 'utf16le').swap16(); const b = Buffer.alloc(5); b[0] = 0x26; b.writeUInt32BE(data.length / 2, 1); return Buffer.concat([b, data]); },
};
function reply(transaction, type, args) {
  const kinds = Buffer.alloc(12);
  args.forEach((arg, index) => { kinds[index] = typeof arg === 'string' ? 0x02 : 0x06; });
  return Buffer.concat([field.u32(0x872349ae), field.u32(transaction), field.u16(type), field.u8(args.length), field.binary(kinds), ...args.map(arg => typeof arg === 'string' ? field.string(arg) : field.u32(arg))]);
}
const item = (kind, main, label) => [0, main, (label.length + 1) * 2, label, 2, '', kind, 0, 0, 0, 0, 0];

async function fakeDatabase(tracks, { refuse = false } = {}) {
  const seen = [];
  const db = net.createServer(socket => {
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0), stage = 0;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 5) { buffer = buffer.subarray(5); stage = 1; socket.write(field.u32(1)); }
      // Messages: find the type (u16 after magic and transaction) and the u32 args.
      while (stage === 1 && buffer.length >= 20 + 12) {
        const type = buffer.readUInt16BE(11), count = buffer[14];
        const total = 20 + 12 + count * 5;
        if (buffer.length < total) return;
        const args = Array.from({ length: count }, (_, index) => buffer.readUInt32BE(32 + index * 5 + 1));
        buffer = buffer.subarray(total);
        seen.push({ type, args });
        if (type === 0x0000) socket.write(reply(0xfffffffe, refuse ? 0x4003 : 0x4000, [0, 0]));
        else if (type === 0x2002) {
          const track = tracks[args[1]];
          socket.write(track ? reply(1, 0x4000, [0x2002, track.length]) : reply(1, 0x4003, [0, 0]));
        } else if (type === 0x3000) {
          const descriptor = args[0];
          const track = Object.values(tracks)[0];
          socket.write(reply(2, 0x4001, []));
          for (const entry of track) socket.write(reply(2, 0x4101, item(...entry)));
          socket.write(reply(2, 0x4201, []));
          seen.push({ descriptor });
        }
      }
    });
  });
  await new Promise(resolve => db.listen(0, '127.0.0.1', resolve));
  const lookup = net.createServer(socket => socket.on('error', () => {}).once('data', () => { const port = Buffer.alloc(2); port.writeUInt16BE(db.address().port); socket.end(port); }));
  await new Promise(resolve => lookup.listen(0, '127.0.0.1', resolve));
  return { port: lookup.address().port, seen, close: () => { db.close(); lookup.close(); } };
}

const TRACK = [[0x04, 1234, 'Strobe'], [0x07, 77, 'deadmau5'], [0x02, 5, 'For Lack of a Better Name'], [0x0b, 637, ''], [0x0d, 12800, ''], [0x0f, 3, '7A']];

test('queryTrack reads title, artist and more from a player database server', async () => {
  const server = await fakeDatabase({ 1234: TRACK });
  try {
    const track = await queryTrack({ host: '127.0.0.1', dbPort: server.port, ourNumber: 3, slot: 3, trackType: 1, trackId: 1234, timeout: 2000 });
    assert.deepEqual(track, { id: 1234, title: 'Strobe', artist: 'deadmau5', album: 'For Lack of a Better Name', duration: 637, bpm: 128, key: '7A' });
    // Descriptor: our number, main menu, USB slot, rekordbox track.
    assert.equal(server.seen.find(entry => entry.descriptor !== undefined).descriptor, 0x03010301);
    await assert.rejects(queryTrack({ host: '127.0.0.1', dbPort: server.port, ourNumber: 3, slot: 3, trackType: 1, trackId: 99, timeout: 2000 }), /not found/);
  } finally { server.close(); }
  const refusing = await fakeDatabase({ 1234: TRACK }, { refuse: true });
  try { await assert.rejects(queryTrack({ host: '127.0.0.1', dbPort: refusing.port, ourNumber: 7, slot: 3, trackType: 1, trackId: 1234, timeout: 2000 }), /device number/); }
  finally { refusing.close(); }
  await assert.rejects(queryTrack({ host: '127.0.0.1', dbPort: 1, ourNumber: 3, slot: 3, trackType: 1, trackId: 1, timeout: 500 }));
});

test('ProLink follows players, beats, playhead and track names over UDP', { timeout: 20000 }, async () => {
  const server = await fakeDatabase({ 1234: TRACK });
  const base = 41000 + Math.floor(Math.random() * 2000);
  const ports = { announce: base, beat: base + 1, status: base + 2, db: server.port };
  const interfaces = () => ({ test: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.255.255.0', mac: '02:00:00:00:00:01', internal: false }] });
  let clock = 1_000_000;
  const client = new ProLink({ number: 5, ports, interfaces, bindAddress: '127.0.0.1', now: () => clock });
  const sender = dgram.createSocket('udp4');
  const send = (data, port) => new Promise(resolve => sender.send(data, port, '127.0.0.1', resolve));
  const waitFor = async (check, label) => { for (let i = 0; i < 100; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error(`Timed out: ${label}`); };
  const beats = [];
  client.on('beat', beat => beats.push(beat));
  client.on('warning', () => {});
  try {
    await client.start();
    await send(makeAnnounce({ number: 2, name: 'CDJ-3000', mac: [2, 0, 0, 0, 0, 2], ip: '127.0.0.1' }), ports.announce);
    await waitFor(() => client.devices.has(2), 'device');
    await send(statusPacket({ beat: 33 }), ports.status);
    const playing = await waitFor(() => client.snapshot().players.find(player => player.number === 2), 'player');
    assert.deepEqual([playing.playing, playing.master, playing.onAir, playing.bpm, playing.slot], [true, true, true, 128, 'usb']);
    // Estimated position: beat 33 at 128 BPM is 15 s in.
    assert.ok(Math.abs(playing.position - 15) < 0.01, `position ${playing.position}`);
    clock += 2000;
    assert.ok(Math.abs(client.snapshot().players[0].position - 17) < 0.01);
    // CDJ-3000 absolute position takes over.
    await send(positionPacket({ ms: 61500, pitch: 2 }), ports.beat);
    await waitFor(() => client.snapshot().players[0].precise, 'precise');
    assert.ok(Math.abs(client.snapshot().players[0].position - 61.5) < 0.01);
    await send(beatPacket({ beatInBar: 3, pitch: 2 }), ports.beat);
    await waitFor(() => beats.length, 'beat');
    assert.deepEqual([beats[0].player, beats[0].beatInBar, beats[0].master], [2, 3, true]);
    assert.ok(Math.abs(beats[0].bpm - 130.56) < 0.01);
    const named = await waitFor(() => client.snapshot().players[0].track?.title, 'track lookup');
    assert.equal(named, 'Strobe');
    assert.equal(client.snapshot().players[0].track.artist, 'deadmau5');
    assert.equal(client.snapshot().joined, true);
    // A new track resets the playhead and is looked up again.
    await send(statusPacket({ trackId: 99, beat: 1, flags: 0x08, playState: 0x05 }), ports.status);
    await waitFor(() => client.snapshot().players[0].trackId === 99, 'track change');
    assert.equal(client.snapshot().players[0].playing, false);
    assert.equal(client.snapshot().players[0].position, 0);
  } finally {
    client.stop();
    sender.close();
    server.close();
  }
});