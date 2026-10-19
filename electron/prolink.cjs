// Pro DJ Link client (Pioneer / AlphaTheta CDJ, XDJ and DJM networks).
// Joins the network as a virtual CDJ so players send it their status, follows
// beat packets (tempo, beat in bar, CDJ-3000 absolute playhead) and reads
// track titles from the players' database server. Packet layouts follow Deep
// Symmetry's dysentery protocol analysis (used by Beat Link Trigger) and
// prolink-connect by Evan Purkhiser (MIT). Everything from the network is
// untrusted: packet lengths are checked and lookups time out.
const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const HEADER = Buffer.from([0x51, 0x73, 0x70, 0x74, 0x31, 0x57, 0x6d, 0x4a, 0x4f, 0x4c]);
const PORTS = Object.freeze({ announce: 50000, beat: 50001, status: 50002, db: 12523 });
const DEVICE_TYPES = { 1: 'cdj', 3: 'mixer', 4: 'rekordbox' };
const PLAY_STATES = { 0x00: 'empty', 0x02: 'loading', 0x03: 'playing', 0x04: 'looping', 0x05: 'paused', 0x06: 'cued', 0x07: 'cuing', 0x08: 'held', 0x09: 'searching', 0x0e: 'spun-down', 0x11: 'ended' };
const FLAGS = { onAir: 0x08, sync: 0x10, master: 0x20, playing: 0x40 };
const SLOTS = { 0: 'empty', 1: 'cd', 2: 'sd', 3: 'usb', 4: 'rekordbox' };
const ANNOUNCE_INTERVAL = 1500, DEVICE_TIMEOUT = 5000, PRECISE_TIMEOUT = 1000, QUERY_TIMEOUT = 4000;

const ascii = (buffer, offset, length) => buffer.subarray(offset, offset + length).toString('latin1').replace(/\0.*$/s, '').trim();
const ipFrom = value => [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
const ipTo = address => address.split('.').reduce((value, part) => (value << 8 | Number(part)) >>> 0, 0);
const isProLink = buffer => buffer.length > 0x0b && buffer.subarray(0, 10).equals(HEADER);
// Pitch: 0x100000 is normal speed; 0 is stopped and 0x200000 is +100%.
const pitch = (buffer, offset) => ((buffer[offset] << 16 | buffer[offset + 1] << 8 | buffer[offset + 2]) - 0x100000) / 0x100000 * 100;

function parseAnnounce(buffer) {
  if (!isProLink(buffer) || buffer[0x0a] !== 0x06 || buffer.length < 0x36) return null;
  return { number: buffer[0x24], name: ascii(buffer, 0x0c, 20), type: DEVICE_TYPES[buffer[0x34]] || 'other', mac: [...buffer.subarray(0x26, 0x2c)], ip: ipFrom(buffer.readUInt32BE(0x2c)) };
}

// Port 50001: beat packets (type 0x28) and CDJ-3000 absolute position (type 0x0b).
function parseBeat(buffer) {
  if (!isProLink(buffer)) return null;
  if (buffer[0x0a] === 0x28 && buffer.length >= 0x60) {
    return { kind: 'beat', device: buffer[0x21], name: ascii(buffer, 0x0b, 20), nextBeatMs: buffer.readUInt32BE(0x24), pitch: pitch(buffer, 0x55), bpm: buffer.readUInt16BE(0x5a) / 100, beatInBar: buffer[0x5c] };
  }
  if (buffer[0x0a] === 0x0b && buffer.length >= 0x3c) {
    return { kind: 'position', device: buffer[0x21], length: buffer.readUInt32BE(0x24), positionMs: buffer.readUInt32BE(0x28), pitch: buffer.readInt32BE(0x2c) / 100, bpm: buffer.readUInt32BE(0x38) / 10 };
  }
  return null;
}

// Port 50002: CDJ status (type 0x0a). Short packets (rekordbox, mixers) are ignored.
function parseStatus(buffer) {
  if (!isProLink(buffer) || buffer[0x0a] !== 0x0a || buffer.length < 0xcc) return null;
  const rawBpm = buffer.readUInt16BE(0x92), rawBeat = buffer.readUInt32BE(0xa0), flags = buffer[0x89];
  return {
    device: buffer[0x21], name: ascii(buffer, 0x0b, 20), trackDevice: buffer[0x28], trackSlot: buffer[0x29], trackType: buffer[0x2a], trackId: buffer.readUInt32BE(0x2c),
    playState: PLAY_STATES[buffer[0x7b]] || 'unknown', playing: (flags & FLAGS.playing) !== 0, onAir: (flags & FLAGS.onAir) !== 0, sync: (flags & FLAGS.sync) !== 0, master: (flags & FLAGS.master) !== 0,
    trackBpm: rawBpm === 0xffff ? null : rawBpm / 100, pitch: pitch(buffer, 0x99), beat: rawBeat === 0xffffffff ? null : rawBeat, beatInBar: buffer[0xa6], packet: buffer.readUInt32BE(0xc8),
  };
}

function makeAnnounce({ number, name, mac, ip }) {
  const packet = Buffer.alloc(0x36);
  HEADER.copy(packet, 0);
  packet[0x0a] = 0x06;
  packet.write(String(name).slice(0, 20), 0x0c, 'latin1');
  packet[0x20] = 0x01; packet[0x21] = 0x02; packet[0x22] = 0x00; packet[0x23] = 0x36;
  packet[0x24] = number; packet[0x25] = 0x01;
  Buffer.from(mac).copy(packet, 0x26, 0, 6);
  packet.writeUInt32BE(ipTo(ip), 0x2c);
  packet[0x30] = 0x01; packet[0x34] = 0x01;
  return packet;
}

// The IPv4 interface on the same subnet as a device (or the first usable one).
function interfaceFor(address, interfaces = os.networkInterfaces()) {
  const all = Object.values(interfaces).flat().filter(item => item && (item.family === 'IPv4' || item.family === 4) && !item.internal);
  const target = address ? ipTo(address) : null;
  const match = target === null ? null : all.find(item => ((ipTo(item.address) ^ target) & ipTo(item.netmask)) === 0);
  const chosen = match || all[0];
  if (!chosen) return null;
  const mask = ipTo(chosen.netmask);
  return { address: chosen.address, mac: chosen.mac.split(':').map(part => parseInt(part, 16) || 0), broadcast: ipFrom((ipTo(chosen.address) & mask | ~mask) >>> 0) };
}

// ---------------------------------------------------------------- database server (TCP)

const FIELD = { u8: 0x0f, u16: 0x10, u32: 0x11, binary: 0x14, string: 0x26 };
const ARG = { u32: 0x06, string: 0x02, binary: 0x03 };
const MAGIC = 0x872349ae;
const u32 = value => { const field = Buffer.alloc(5); field[0] = FIELD.u32; field.writeUInt32BE(value >>> 0, 1); return field; };
function message(transaction, type, args) {
  const argTypes = Buffer.alloc(12);
  args.forEach((_, index) => { argTypes[index] = ARG.u32; });
  const head = Buffer.alloc(5 + 5 + 3 + 2 + 5);
  let offset = 0;
  head[offset++] = FIELD.u32; head.writeUInt32BE(MAGIC, offset); offset += 4;
  head[offset++] = FIELD.u32; head.writeUInt32BE(transaction >>> 0, offset); offset += 4;
  head[offset++] = FIELD.u16; head.writeUInt16BE(type, offset); offset += 2;
  head[offset++] = FIELD.u8; head[offset++] = args.length;
  head[offset++] = FIELD.binary; head.writeUInt32BE(12, offset);
  return Buffer.concat([head, argTypes, ...args.map(u32)]);
}

// Buffered reads from a socket with a deadline.
class Reader {
  constructor(socket, timeout) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.waiting = null; this.error = null; this.timeout = timeout;
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); if (this.buffer.length > 4 * 1024 * 1024) socket.destroy(new Error('Too much data from player.')); this._wake(); });
    socket.on('error', error => { this.error = error; this._wake(); });
    socket.on('close', () => { this.error ||= new Error('Player closed the connection.'); this._wake(); });
  }
  _wake() { const waiting = this.waiting; this.waiting = null; waiting?.(); }
  async read(count) {
    const deadline = Date.now() + this.timeout;
    while (this.buffer.length < count) {
      if (this.error) throw this.error;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('Player did not answer in time.');
      await new Promise(resolve => { this.waiting = resolve; setTimeout(resolve, left); });
    }
    const data = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return data;
  }
  async field() {
    const type = (await this.read(1))[0];
    if (type === FIELD.u8) return (await this.read(1))[0];
    if (type === FIELD.u16) return (await this.read(2)).readUInt16BE(0);
    if (type === FIELD.u32) return (await this.read(4)).readUInt32BE(0);
    const length = (await this.read(4)).readUInt32BE(0);
    if (type === FIELD.binary) { if (length > 1024 * 1024) throw new Error('Field too large.'); return this.read(length); }
    if (type === FIELD.string) {
      if (length > 4096) throw new Error('Field too large.');
      const data = Buffer.from(await this.read(length * 2));
      return data.swap16().toString('utf16le').replace(/\0+$/, '');
    }
    throw new Error(`Unknown field type 0x${type.toString(16)}.`);
  }
  async message() {
    if (await this.field() !== MAGIC) throw new Error('Unexpected data from player.');
    const transaction = await this.field(), type = await this.field(), count = await this.field(), argTypes = await this.field();
    const args = [];
    for (let index = 0; index < count; index++) {
      // Empty binary arguments are left out after a zero length.
      if (argTypes[index] === ARG.binary && args[index - 1] === 0) { args.push(Buffer.alloc(0)); continue; }
      args.push(await this.field());
    }
    return { transaction, type, args };
  }
}

function connect(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Player did not accept a connection.')); }, timeout);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

const ITEM = { album: 0x02, title: 0x04, genre: 0x06, artist: 0x07, duration: 0x0b, tempo: 0x0d, label: 0x0e, key: 0x0f, comment: 0x23 };

// Title, artist and more for one rekordbox track, from the database server of
// the device that holds the media.
async function queryTrack({ host, dbPort = PORTS.db, ourNumber, slot, trackType, trackId, timeout = QUERY_TIMEOUT }) {
  const lookup = await connect(host, dbPort, timeout);
  let port;
  try {
    const reader = new Reader(lookup, timeout);
    lookup.write(Buffer.concat([Buffer.from([0, 0, 0, 0x0f]), Buffer.from('RemoteDBServer\0', 'latin1')]));
    port = (await reader.read(2)).readUInt16BE(0);
  } finally { lookup.destroy(); }
  const socket = await connect(host, port, timeout);
  try {
    const reader = new Reader(socket, timeout);
    socket.write(u32(1));
    if (await reader.field() !== 1) throw new Error('Player refused the database connection.');
    socket.write(message(0xfffffffe, 0x0000, [ourNumber]));
    if ((await reader.message()).type !== 0x4000) throw new Error('Player refused our device number for track lookups.');
    const descriptor = (ourNumber << 24 | 1 << 16 | slot << 8 | trackType) >>> 0;
    socket.write(message(1, 0x2002, [descriptor, trackId]));
    const answer = await reader.message();
    if (answer.type !== 0x4000) throw new Error('Track not found on the player.');
    const total = Math.min(64, Number(answer.args[1]) || 0);
    const track = { id: trackId };
    if (total) {
      socket.write(message(2, 0x3000, [descriptor, 0, total, 0, total, 0x0c]));
      if ((await reader.message()).type !== 0x4001) throw new Error('Unexpected menu from player.');
      for (let index = 0; index < total; index++) {
        const item = await reader.message();
        if (item.type !== 0x4101) break;
        const [, main, , label] = item.args, kind = Number(item.args[6]) & 0xffff;
        if (kind === ITEM.title) track.title = String(label || '').slice(0, 200);
        else if (kind === ITEM.artist) track.artist = String(label || '').slice(0, 200);
        else if (kind === ITEM.album) track.album = String(label || '').slice(0, 200);
        else if (kind === ITEM.genre) track.genre = String(label || '').slice(0, 100);
        else if (kind === ITEM.key) track.key = String(label || '').slice(0, 20);
        else if (kind === ITEM.label) track.label = String(label || '').slice(0, 100);
        else if (kind === ITEM.duration) track.duration = Number(main) || null;
        else if (kind === ITEM.tempo) track.bpm = (Number(main) || 0) / 100 || null;
      }
    }
    socket.write(message(3, 0x0100, []));
    return track;
  } finally { socket.destroy(); }
}
// ---------------------------------------------------------------- network client

class ProLink extends EventEmitter {
  constructor({ number = 5, name = 'PrismVJ', ports = PORTS, interfaces = () => os.networkInterfaces(), bindAddress = '0.0.0.0', lookups = true, now = () => Date.now() } = {}) {
    super();
    if (!Number.isInteger(number) || number < 1 || number > 15) throw new RangeError('Pro DJ Link device number must be 1-15.');
    this.number = number;
    this.name = String(name).slice(0, 20);
    this.ports = { ...PORTS, ...ports };
    this.interfaces = interfaces;
    this.bindAddress = bindAddress;
    this.lookups = lookups;
    this.now = now;
    this.devices = new Map();
    this.players = new Map();
    this.tracks = new Map();
    this.pending = new Set();
    this.sockets = [];
    this.iface = null;
    this.timer = null;
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    const bind = (port, handler) => new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.once('error', reject);
      socket.on('message', (data, remote) => { try { handler(data, remote); } catch { /* malformed packet */ } });
      socket.bind(port, this.bindAddress, () => { socket.removeListener('error', reject); socket.on('error', error => this.emit('warning', error.message)); try { socket.setBroadcast(true); } catch { /* not supported */ } resolve(socket); });
    });
    try {
      this.announceSocket = await bind(this.ports.announce, (data, remote) => this._announce(data, remote));
      this.sockets.push(this.announceSocket);
      this.sockets.push(await bind(this.ports.beat, data => this._beat(data)));
      this.sockets.push(await bind(this.ports.status, data => this._status(data)));
    } catch (error) {
      this.stop();
      throw new Error(`Pro DJ Link ports are busy or blocked (${error.message}).`);
    }
    this.timer = setInterval(() => this._tick(), ANNOUNCE_INTERVAL);
    this._tick();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
    for (const socket of this.sockets) try { socket.close(); } catch { /* already closed */ }
    this.sockets = [];
    this.devices.clear();
    this.players.clear();
    this.iface = null;
  }

  _tick() {
    const now = this.now();
    for (const [number, device] of this.devices) if (now - device.seen > DEVICE_TIMEOUT) { this.devices.delete(number); this.players.delete(number); }
    // Announce ourselves once we know which interface the players are on.
    if (!this.iface) {
      const first = [...this.devices.values()][0];
      if (first) this.iface = interfaceFor(first.ip, this.interfaces());
    }
    if (this.iface && this.announceSocket) {
      const packet = makeAnnounce({ number: this.number, name: this.name, mac: this.iface.mac, ip: this.iface.address });
      const targets = new Set([this.iface.broadcast, ...[...this.devices.values()].map(device => device.ip)]);
      for (const address of targets) this.announceSocket.send(packet, this.ports.announce, address, () => {});
    }
    this.emit('state', this.snapshot());
  }

  _announce(data, remote) {
    const device = parseAnnounce(data);
    if (!device || device.number < 1) return;
    if (this.iface && device.ip === this.iface.address && device.number === this.number) return; // our own echo
    if (device.number === this.number && device.ip !== this.iface?.address) this.emit('warning', `Device number ${this.number} is also used by ${device.name}. Pick another in Settings.`);
    const known = this.devices.get(device.number);
    this.devices.set(device.number, { ...device, ip: device.ip || remote?.address, seen: this.now() });
    // Join as soon as the first player shows up.
    if (!this.iface) this._tick();
    else if (!known) this.emit('state', this.snapshot());
  }

  _player(number, name) {
    let player = this.players.get(number);
    if (!player) {
      player = { number, name: name || this.devices.get(number)?.name || `Player ${number}`, trackId: 0, trackDevice: 0, trackSlot: 0, trackType: 0, playState: 'empty', playing: false, onAir: false, master: false, sync: false,
        trackBpm: null, pitch: 0, beat: null, beatInBar: 0, position: 0, positionAt: this.now(), precise: 0, length: null };
      this.players.set(number, player);
    }
    return player;
  }

  _status(data) {
    const status = parseStatus(data);
    if (!status || status.device === this.number) return;
    const player = this._player(status.device, status.name);
    const now = this.now();
    const changed = status.trackId !== player.trackId || status.trackDevice !== player.trackDevice || status.trackSlot !== player.trackSlot;
    if (changed) { player.precise = 0; player.length = null; player.position = 0; player.positionAt = now; }
    Object.assign(player, { name: status.name || player.name, trackId: status.trackId, trackDevice: status.trackDevice, trackSlot: status.trackSlot, trackType: status.trackType, playState: status.playState,
      playing: status.playing || status.playState === 'playing' || status.playState === 'looping', onAir: status.onAir, master: status.master, sync: status.sync, trackBpm: status.trackBpm, pitch: status.pitch, beatInBar: status.beatInBar });
    // Without CDJ-3000 position packets the playhead is estimated from the beat count.
    if (now - player.precise > PRECISE_TIMEOUT && status.beat !== player.beat) {
      player.position = status.beat && player.trackBpm ? (status.beat - 1) * 60 / player.trackBpm : 0;
      player.positionAt = now;
    }
    player.beat = status.beat;
    if (changed && status.trackId && this.lookups) this._lookup(player);
  }

  _beat(data) {
    const packet = parseBeat(data);
    if (!packet || packet.device === this.number) return;
    const player = this._player(packet.device, packet.name);
    if (packet.kind === 'position') {
      player.position = packet.positionMs / 1000;
      player.positionAt = player.precise = this.now();
      player.length = packet.length || null;
      player.pitch = packet.pitch;
      return;
    }
    player.pitch = packet.pitch;
    if (packet.bpm > 0 && packet.bpm < 1000) player.trackBpm = packet.bpm;
    player.beatInBar = packet.beatInBar;
    this.emit('beat', { player: packet.device, beatInBar: packet.beatInBar, bpm: packet.bpm * (1 + packet.pitch / 100), master: !!player.master });
  }

  trackKey(player) { return `${player.trackDevice}:${player.trackSlot}:${player.trackType}:${player.trackId}`; }

  async _lookup(player) {
    const key = this.trackKey(player), cached = this.tracks.get(key);
    if (cached && (cached.track || this.now() - cached.at < 30000)) return;
    if (this.pending.has(key)) return;
    const host = this.devices.get(player.trackDevice) || this.devices.get(player.number);
    // Only rekordbox-analysed tracks (type 1) have database entries.
    if (!host || player.trackType !== 1) return;
    this.pending.add(key);
    try {
      const track = await queryTrack({ host: host.ip, dbPort: this.ports.db, ourNumber: this.number, slot: player.trackSlot, trackType: player.trackType, trackId: player.trackId });
      this.tracks.set(key, { track, at: this.now() });
      if (this.tracks.size > 500) this.tracks.delete(this.tracks.keys().next().value);
    } catch (error) {
      this.tracks.set(key, { track: null, at: this.now(), error: error.message });
      this.emit('warning', `Track details from ${host.name}: ${error.message}`);
    } finally {
      this.pending.delete(key);
      this.emit('state', this.snapshot());
    }
  }

  // Plain data for the renderer; positions are extrapolated to now.
  snapshot() {
    const now = this.now();
    const players = [...this.players.values()].filter(player => this.devices.has(player.number) || now - player.positionAt < DEVICE_TIMEOUT).map(player => {
      const rate = 1 + player.pitch / 100;
      const entry = this.tracks.get(this.trackKey(player));
      return {
        number: player.number, name: player.name, playing: player.playing, playState: player.playState, onAir: player.onAir, master: player.master, sync: player.sync,
        trackId: player.trackId, slot: SLOTS[player.trackSlot] || 'other', trackBpm: player.trackBpm, pitch: Math.round(player.pitch * 100) / 100,
        bpm: player.trackBpm ? Math.round(player.trackBpm * rate * 100) / 100 : null, beatInBar: player.beatInBar, beat: player.beat,
        position: Math.max(0, player.position + (player.playing ? (now - player.positionAt) / 1000 * rate : 0)), precise: now - player.precise < PRECISE_TIMEOUT, length: player.length,
        track: entry?.track || null, lookupError: entry?.error || null,
      };
    }).sort((a, b) => a.number - b.number);
    const devices = [...this.devices.values()].map(({ number, name, type, ip }) => ({ number, name, type, ip })).sort((a, b) => a.number - b.number);
    return { running: this.running, number: this.number, joined: !!this.iface, address: this.iface?.address || null, devices, players, at: now };
  }
}

module.exports = { ProLink, parseAnnounce, parseBeat, parseStatus, makeAnnounce, interfaceFor, queryTrack, message, Reader, HEADER, PORTS };