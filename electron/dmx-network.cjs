'use strict';
// Art-Net 4 and sACN (ANSI E1.31) framing plus UDP transport for DMX Output (Lumiverses -> LED fixtures,
// manual pp. 133-139) and DMX Shortcuts input (manual pp. 183-188). Node only, no Electron imports.
// Decoders never throw: anything malformed returns null. Encoders throw on invalid arguments.
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const ARTNET_PORT = 6454;
const E131_PORT = 5568;
const ARTNET_ID = Buffer.from('Art-Net\0', 'latin1');
const OP_POLL = 0x2000, OP_POLL_REPLY = 0x2100, OP_DMX = 0x5000;
const ARTNET_VERSION = 14;
const ACN_ID = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]);
const E131_PREVIEW = 0x80, E131_TERMINATED = 0x40, E131_FORCE_SYNC = 0x20;
const UNIVERSE_RANGE = { artnet: [0, 0x7fff], sacn: [1, 63999] };
const DEFAULT_PORT = { artnet: ARTNET_PORT, sacn: E131_PORT };
const MAX_UNIVERSES = 512;

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const isBytes = value => value instanceof Uint8Array || value instanceof Uint8ClampedArray;
const toBuffer = value => Buffer.isBuffer(value) ? value
  : isBytes(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : null;
const now = () => performance.now();

function dmxBytes(data) {
  if (!isBytes(data) || data.length > 512) throw new TypeError('DMX data must be a Uint8Array of at most 512 bytes.');
  return data;
}

function cString(buffer, start, length, encoding = 'latin1') {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString(encoding).replace(/[\u0000-\u001f\u007f]/g, '');
}

function writeCString(buffer, start, length, text, encoding = 'latin1') {
  const bytes = Buffer.from(String(text ?? ''), encoding);
  let size = Math.min(bytes.length, length - 1); // always NUL terminated
  if (encoding === 'utf8') while (size > 0 && size < bytes.length && (bytes[size] & 0xc0) === 0x80) size--;
  bytes.copy(buffer, start, 0, size);
}

// Art-Net 15-bit Port-Address: Net (7 bits) / Sub-Net (4 bits) / Universe (4 bits).
function portAddress(netNumber, subnet, universe) {
  if (!isInt(netNumber, 0, 127) || !isInt(subnet, 0, 15) || !isInt(universe, 0, 15)) throw new RangeError('Invalid Art-Net Net/Sub-Net/Universe.');
  return netNumber << 8 | subnet << 4 | universe;
}
function splitPortAddress(address) {
  if (!isInt(address, 0, 0x7fff)) throw new RangeError('Invalid Art-Net Port-Address.');
  return { net: address >> 8, subnet: address >> 4 & 15, universe: address & 15 };
}

// --- Art-Net ---------------------------------------------------------------------------------------------

function artHeader(size, opcode) {
  const packet = Buffer.alloc(size);
  ARTNET_ID.copy(packet, 0);
  packet.writeUInt16LE(opcode, 8);
  return packet;
}

function encodeArtDmx({ universe = 0, sequence = 0, physical = 0, data } = {}) {
  if (!isInt(universe, 0, 0x7fff) || !isInt(sequence, 0, 255) || !isInt(physical, 0, 255)) throw new RangeError('Invalid ArtDmx universe, sequence or physical.');
  const payload = dmxBytes(data);
  const length = Math.max(2, payload.length + (payload.length & 1)); // spec: even, 2..512
  const packet = artHeader(18 + length, OP_DMX);
  packet.writeUInt16BE(ARTNET_VERSION, 10);
  packet[12] = sequence; packet[13] = physical;
  packet[14] = universe & 0xff; packet[15] = universe >> 8;
  packet.writeUInt16BE(length, 16);
  packet.set(payload, 18);
  return packet;
}

function encodeArtPoll({ flags = 0, diagPriority = 0x10 } = {}) {
  if (!isInt(flags, 0, 255) || !isInt(diagPriority, 0, 255)) throw new RangeError('Invalid ArtPoll flags.');
  const packet = artHeader(14, OP_POLL);
  packet.writeUInt16BE(ARTNET_VERSION, 10);
  packet[12] = flags; packet[13] = diagPriority;
  return packet;
}

// Minimal Art-Net 4 ArtPollReply (239 bytes). Up to 4 ports sharing one Net/Sub-Net; direction 'output' means
// the node consumes Art-Net (what a DMX input like Prism's shortcuts listener is), 'input' means it produces it.
function encodeArtPollReply({ ip = '0.0.0.0', port = ARTNET_PORT, version = 1, shortName = 'Prism Live', longName = 'Prism Live',
  nodeReport = '', oem = 0xffff, estaMan = 0, ports = [], mac, bindIndex = 0, style = 0 } = {}) {
  if (!net.isIPv4(ip) || !isInt(port, 0, 65535) || !isInt(version, 0, 0xffff) || !isInt(oem, 0, 0xffff) || !isInt(estaMan, 0, 0xffff)
    || !isInt(bindIndex, 0, 255) || !isInt(style, 0, 255) || !Array.isArray(ports) || ports.length > 4) throw new RangeError('Invalid ArtPollReply fields.');
  const packet = artHeader(239, OP_POLL_REPLY);
  ip.split('.').forEach((octet, i) => { packet[10 + i] = Number(octet); packet[207 + i] = Number(octet); });
  packet.writeUInt16LE(port, 14);
  packet.writeUInt16BE(version, 16);
  let high = null;
  ports.forEach((entry, i) => {
    const universe = entry?.universe;
    if (!isInt(universe, 0, 0x7fff) || !['input', 'output'].includes(entry.direction)) throw new RangeError('Invalid ArtPollReply port.');
    if (high === null) high = universe >> 4;
    else if (high !== universe >> 4) throw new RangeError('ArtPollReply ports must share one Net/Sub-Net.');
    if (entry.direction === 'output') { packet[174 + i] |= 0x80; packet[182 + i] = 0x80; packet[190 + i] = universe & 15; }
    else { packet[174 + i] |= 0x40; packet[178 + i] = 0x80; packet[186 + i] = universe & 15; }
  });
  packet[18] = (high ?? 0) >> 4 & 0x7f; packet[19] = (high ?? 0) & 15;
  packet.writeUInt16BE(oem, 20);
  packet[23] = 0xd0; // indicators normal, Port-Address set by front panel
  packet.writeUInt16LE(estaMan, 24);
  writeCString(packet, 26, 18, shortName);
  writeCString(packet, 44, 64, longName);
  writeCString(packet, 108, 64, nodeReport);
  packet.writeUInt16BE(ports.length, 172);
  packet[200] = style;
  if (isBytes(mac) && mac.length === 6) packet.set(mac, 201);
  packet[211] = bindIndex;
  packet[212] = 0x08; // Status2: supports 15-bit Port-Address
  return packet;
}

function decodeArtNet(input) {
  const buffer = toBuffer(input);
  if (!buffer || buffer.length < 14 || buffer.length > 1024 || !buffer.subarray(0, 8).equals(ARTNET_ID)) return null;
  const opcode = buffer.readUInt16LE(8);
  if (opcode === OP_DMX) {
    if (buffer.length < 20 || buffer.readUInt16BE(10) < ARTNET_VERSION || buffer[15] & 0x80) return null;
    const length = buffer.readUInt16BE(16);
    if (length < 2 || length > 512 || length & 1 || buffer.length !== 18 + length) return null;
    return { opcode, universe: buffer[15] << 8 | buffer[14], sequence: buffer[12], physical: buffer[13], data: new Uint8Array(buffer.subarray(18)) };
  }
  if (opcode === OP_POLL) {
    if (buffer.readUInt16BE(10) < ARTNET_VERSION) return null;
    return { opcode, flags: buffer[12], diagPriority: buffer[13] };
  }
  if (opcode === OP_POLL_REPLY) {
    if (buffer.length < 207) return null;
    const netSwitch = buffer[18] & 0x7f, subSwitch = buffer[19] & 15, ports = [];
    const count = Math.min(4, buffer.readUInt16BE(172));
    for (let i = 0; i < count; i++) {
      const base = netSwitch << 8 | subSwitch << 4;
      if (buffer[174 + i] & 0x80) ports.push({ direction: 'output', universe: base | buffer[190 + i] & 15 });
      if (buffer[174 + i] & 0x40) ports.push({ direction: 'input', universe: base | buffer[186 + i] & 15 });
    }
    return {
      opcode, ip: [...buffer.subarray(10, 14)].join('.'), port: buffer.readUInt16LE(14), version: buffer.readUInt16BE(16),
      netSwitch, subSwitch, oem: buffer.readUInt16BE(20), status1: buffer[23], estaMan: buffer.readUInt16LE(24),
      shortName: cString(buffer, 26, 18), longName: cString(buffer, 44, 64), nodeReport: cString(buffer, 108, 64),
      ports, style: buffer[200], mac: [...buffer.subarray(201, 207)].map(byte => byte.toString(16).padStart(2, '0')).join(':'),
      bindIndex: buffer.length > 211 ? buffer[211] : 0,
    };
  }
  return null;
}

// --- sACN / E1.31 ----------------------------------------------------------------------------------------

function e131MulticastAddress(universe) {
  if (!isInt(universe, 1, 63999)) throw new RangeError('sACN universe must be 1..63999.');
  return `239.255.${universe >> 8}.${universe & 0xff}`;
}

function encodeE131({ universe, sequence = 0, priority = 100, sourceName = 'Prism Live', cid, data, options = 0, syncAddress = 0, startCode = 0 } = {}) {
  if (!isInt(universe, 1, 63999) || !isInt(sequence, 0, 255) || !isInt(priority, 0, 200) || !isInt(options, 0, 255)
    || !isInt(syncAddress, 0, 63999) || !isInt(startCode, 0, 255)) throw new RangeError('Invalid E1.31 header fields.');
  if (!isBytes(cid) || cid.length !== 16) throw new TypeError('E1.31 CID must be 16 bytes.');
  const payload = dmxBytes(data);
  const size = 126 + payload.length;
  const packet = Buffer.alloc(size);
  // Root layer
  packet.writeUInt16BE(0x0010, 0); packet.writeUInt16BE(0x0000, 2); ACN_ID.copy(packet, 4);
  packet.writeUInt16BE(0x7000 | size - 16, 16); packet.writeUInt32BE(0x00000004, 18); packet.set(cid, 22);
  // Framing layer
  packet.writeUInt16BE(0x7000 | size - 38, 38); packet.writeUInt32BE(0x00000002, 40);
  writeCString(packet, 44, 64, sourceName, 'utf8');
  packet[108] = priority; packet.writeUInt16BE(syncAddress, 109); packet[111] = sequence; packet[112] = options;
  packet.writeUInt16BE(universe, 113);
  // DMP layer
  packet.writeUInt16BE(0x7000 | size - 115, 115); packet[117] = 0x02; packet[118] = 0xa1;
  packet.writeUInt16BE(0x0000, 119); packet.writeUInt16BE(0x0001, 121); packet.writeUInt16BE(payload.length + 1, 123);
  packet[125] = startCode; packet.set(payload, 126);
  return packet;
}

function decodeE131(input) {
  const buffer = toBuffer(input);
  if (!buffer || buffer.length < 126 || buffer.length > 638) return null;
  const size = buffer.length;
  const pdu = (offset, expected) => buffer.readUInt16BE(offset) === (0x7000 | expected);
  if (buffer.readUInt16BE(0) !== 0x0010 || buffer.readUInt16BE(2) !== 0 || !buffer.subarray(4, 16).equals(ACN_ID)) return null;
  if (!pdu(16, size - 16) || buffer.readUInt32BE(18) !== 0x00000004) return null; // extended (sync/discovery) ignored
  if (!pdu(38, size - 38) || buffer.readUInt32BE(40) !== 0x00000002) return null;
  const priority = buffer[108], syncAddress = buffer.readUInt16BE(109), options = buffer[112], universe = buffer.readUInt16BE(113);
  if (priority > 200 || syncAddress > 63999 || !isInt(universe, 1, 63999)) return null;
  if (!pdu(115, size - 115) || buffer[117] !== 0x02 || buffer[118] !== 0xa1 || buffer.readUInt16BE(119) !== 0
    || buffer.readUInt16BE(121) !== 1 || buffer.readUInt16BE(123) !== size - 125) return null;
  return {
    universe, sequence: buffer[111], priority, syncAddress, options,
    preview: !!(options & E131_PREVIEW), terminated: !!(options & E131_TERMINATED),
    sourceName: cString(buffer, 44, 64, 'utf8'), cid: new Uint8Array(buffer.subarray(22, 38)),
    startCode: buffer[125], data: new Uint8Array(buffer.subarray(126)),
  };
}

// --- Transport helpers -----------------------------------------------------------------------------------

function validatePort(port, label, allowEphemeral = false) {
  if (!(allowEphemeral && port === 0) && !isInt(port, 1024, 65535)) throw new RangeError(`Invalid ${label} port.`);
  return port;
}
function validateProtocol(protocol) {
  if (!Object.hasOwn(UNIVERSE_RANGE, protocol)) throw new RangeError('DMX protocol must be "artnet" or "sacn".');
  return protocol;
}
const isBroadcast = host => host === '255.255.255.255' || host.endsWith('.255');
const isMulticast = host => { const first = Number(host.split('.')[0]); return first >= 224 && first <= 239; };
function validateHost(host, protocol) {
  if (typeof host !== 'string' || !net.isIPv4(host) || host === '0.0.0.0' || protocol === 'artnet' && isMulticast(host)) throw new RangeError('Invalid DMX target host.');
  return host;
}
function bindSocket(socket, port, address) {
  return new Promise((resolve, reject) => {
    const failed = error => { socket.removeListener('listening', ready); try { socket.close(); } catch {} reject(error); };
    const ready = () => { socket.removeListener('error', failed); resolve(); };
    socket.once('error', failed); socket.once('listening', ready); socket.bind(port, address);
  });
}
const closeSocket = socket => new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } });
function localIPv4(bindAddress) {
  if (bindAddress && bindAddress !== '0.0.0.0') return bindAddress;
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return '127.0.0.1';
}
function emitError(emitter, error) { if (emitter.listenerCount('error')) emitter.emit('error', error); }

// --- Sender ----------------------------------------------------------------------------------------------

class DmxSender extends EventEmitter {
  #socket = null; #entries = new Map(); #lastFlush = -Infinity; #flushTimer = null; #keepAliveTimer = null; #broadcast = false;

  constructor({ protocol = 'artnet', host, port, rate = 44, sourceName = 'Prism Live', priority = 100, cid, keepAliveMs,
    bindAddress = '0.0.0.0', localPort = 0 } = {}) {
    super();
    this.protocol = validateProtocol(protocol);
    this.host = host === undefined || host === null || host === '' || host === 'multicast'
      ? (protocol === 'artnet' ? '255.255.255.255' : null) : validateHost(host, protocol);
    this.port = validatePort(port ?? DEFAULT_PORT[protocol], 'DMX target');
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 1 || rate > 1000) throw new RangeError('DMX rate must be 1..1000 Hz.');
    this.rate = rate;
    this.keepAliveMs = keepAliveMs ?? (protocol === 'sacn' ? 800 : 1000);
    if (!isInt(this.keepAliveMs, 10, 10000)) throw new RangeError('DMX keep-alive must be 10..10000 ms.');
    if (!isInt(priority, 0, 200)) throw new RangeError('sACN priority must be 0..200.');
    if (typeof sourceName !== 'string' || sourceName.length > 256) throw new TypeError('Invalid DMX source name.');
    if (cid !== undefined && (!isBytes(cid) || cid.length !== 16)) throw new TypeError('sACN CID must be 16 bytes.');
    if (!net.isIPv4(bindAddress)) throw new RangeError('Invalid DMX bind address.');
    this.priority = priority; this.sourceName = sourceName; this.bindAddress = bindAddress;
    this.localPort = validatePort(localPort, 'DMX local', true);
    this.cid = cid ? new Uint8Array(cid) : new Uint8Array(Buffer.from(crypto.randomUUID().replace(/-/g, ''), 'hex'));
    this.stats = { sent: 0, keepAlive: 0, errors: 0 };
  }

  get active() { return !!this.#socket; }

  async start() {
    await this.stop();
    const socket = dgram.createSocket('udp4');
    await bindSocket(socket, this.localPort, this.bindAddress);
    socket.on('error', error => { this.stats.errors++; emitError(this, error); });
    this.#broadcast = false;
    if (this.host && isBroadcast(this.host)) this.#enableBroadcast(socket);
    for (const entry of this.#entries.values()) if (entry.host && isBroadcast(entry.host)) this.#enableBroadcast(socket);
    if (this.protocol === 'sacn' && this.bindAddress !== '0.0.0.0') { try { socket.setMulticastInterface(this.bindAddress); } catch (error) { emitError(this, error); } }
    this.#socket = socket;
    this.#keepAliveTimer = setInterval(() => this.#keepAlive(), Math.max(5, Math.floor(this.keepAliveMs / 4)));
    this.#keepAliveTimer.unref?.();
    for (const entry of this.#entries.values()) entry.dirty = true;
    this.#schedule();
    return this;
  }

  // Queue the latest frame for a universe; optional per-universe host (Lumiverse routed to a specific node).
  // Returns true when the frame differs from what was last transmitted (it will go out at the next allowed slot).
  send(universe, data, { host } = {}) {
    const [min, max] = UNIVERSE_RANGE[this.protocol];
    if (!isInt(universe, min, max)) throw new RangeError(`Universe must be ${min}..${max}.`);
    dmxBytes(data);
    const target = host === undefined || host === null || host === '' ? null : validateHost(host, this.protocol);
    const key = `${target ?? ''}|${universe}`;
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= MAX_UNIVERSES) throw new RangeError('Too many DMX universes.');
      entry = { universe, host: target, data: new Uint8Array(512), length: 0, sent: new Uint8Array(512), sentLength: -1, dirty: false, lastSent: -Infinity, sequence: 0 };
      this.#entries.set(key, entry);
      if (target && this.#socket && isBroadcast(target)) this.#enableBroadcast(this.#socket);
    }
    entry.data.set(data);
    if (data.length < entry.length) entry.data.fill(0, data.length, entry.length);
    entry.length = data.length;
    let changed = entry.sentLength !== entry.length;
    for (let i = 0; !changed && i < entry.length; i++) changed = entry.data[i] !== entry.sent[i];
    entry.dirty = changed;
    if (changed) this.#schedule();
    return changed;
  }

  async stop() {
    clearTimeout(this.#flushTimer); clearInterval(this.#keepAliveTimer);
    this.#flushTimer = this.#keepAliveTimer = null;
    const socket = this.#socket; this.#socket = null;
    if (!socket) return;
    if (this.protocol === 'sacn') { // E1.31 6.2.6: announce stream termination three times
      const pending = [];
      for (const entry of this.#entries.values()) {
        if (entry.sentLength < 0) continue;
        for (let i = 0; i < 3; i++) pending.push(this.#transmit(socket, entry, E131_TERMINATED));
      }
      await Promise.race([Promise.allSettled(pending), new Promise(resolve => setTimeout(resolve, 250))]);
    }
    for (const entry of this.#entries.values()) entry.sentLength = -1;
    await closeSocket(socket);
  }

  #enableBroadcast(socket) {
    if (this.#broadcast) return;
    try { socket.setBroadcast(true); this.#broadcast = true; } catch (error) { emitError(this, error); }
  }

  #schedule() {
    if (!this.#socket || this.#flushTimer) return;
    const wait = this.#lastFlush + 1000 / this.rate - now();
    if (wait <= 0) this.#flush();
    else { this.#flushTimer = setTimeout(() => { this.#flushTimer = null; this.#flush(); }, Math.ceil(wait)); this.#flushTimer.unref?.(); }
  }

  #flush() {
    const socket = this.#socket;
    if (!socket) return;
    let any = false;
    for (const entry of this.#entries.values()) if (entry.dirty) { any = true; void this.#transmit(socket, entry); }
    if (any) this.#lastFlush = now();
  }

  #keepAlive() {
    const socket = this.#socket, time = now();
    if (!socket) return;
    for (const entry of this.#entries.values()) {
      if (!entry.dirty && entry.sentLength >= 0 && time - entry.lastSent >= this.keepAliveMs) { this.stats.keepAlive++; void this.#transmit(socket, entry); }
    }
  }

  #transmit(socket, entry, options = 0) {
    const data = entry.data.subarray(0, entry.length);
    let packet;
    if (this.protocol === 'artnet') {
      entry.sequence = entry.sequence % 255 + 1; // 1..255; 0 would disable re-ordering
      packet = encodeArtDmx({ universe: entry.universe, sequence: entry.sequence, data });
    } else {
      entry.sequence = entry.sequence + 1 & 0xff;
      packet = encodeE131({ universe: entry.universe, sequence: entry.sequence, priority: this.priority, sourceName: this.sourceName, cid: this.cid, data, options });
    }
    const host = entry.host ?? this.host ?? e131MulticastAddress(entry.universe);
    entry.sent.set(entry.data); entry.sentLength = entry.length; entry.dirty = false; entry.lastSent = now();
    this.stats.sent++;
    return new Promise(resolve => {
      try {
        socket.send(packet, this.port, host, error => { if (error) { this.stats.errors++; emitError(this, error); } resolve(); });
      } catch (error) { this.stats.errors++; emitError(this, error); resolve(); }
    });
  }
}

// --- Receiver --------------------------------------------------------------------------------------------

const SOURCE_TIMEOUT_MS = 2500; // E1.31 network data loss timeout

class DmxReceiver extends EventEmitter {
  #socket = null; #state = new Map(); #budgetAt = 0; #budget = 0;

  constructor({ protocol = 'artnet', port, bindAddress = '0.0.0.0', universes, reuseAddr = false, multicast = true,
    maxPacketsPerSecond = 20000, pollReply = null } = {}) {
    super();
    this.protocol = validateProtocol(protocol);
    this.port = validatePort(port ?? DEFAULT_PORT[protocol], 'DMX input', true);
    if (!net.isIPv4(bindAddress)) throw new RangeError('Invalid DMX bind address.');
    this.bindAddress = bindAddress;
    const [min, max] = UNIVERSE_RANGE[protocol];
    if (universes !== undefined && universes !== null) {
      if (!Array.isArray(universes) || universes.length > 64 || !universes.every(u => isInt(u, min, max))) throw new RangeError(`DMX input universes must be up to 64 values in ${min}..${max}.`);
      this.universes = new Set(universes);
    } else this.universes = null;
    if (!isInt(maxPacketsPerSecond, 1, 1e6)) throw new RangeError('Invalid DMX packet budget.');
    this.maxPacketsPerSecond = maxPacketsPerSecond;
    this.reuseAddr = !!reuseAddr; this.multicast = !!multicast;
    this.pollReply = pollReply && typeof pollReply === 'object' ? { ...pollReply } : pollReply === true ? {} : null;
    if (this.pollReply?.ip !== undefined && !net.isIPv4(this.pollReply.ip)) throw new RangeError('Invalid ArtPollReply IP.');
    this.stats = { received: 0, rejected: 0, ignored: 0, emitted: 0 };
  }

  get active() { return !!this.#socket; }
  address() { try { return this.#socket ? this.#socket.address() : null; } catch { return null; } }

  async start() {
    await this.stop();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: this.reuseAddr });
    socket.on('message', (packet, remote) => this.#onMessage(packet, remote));
    await bindSocket(socket, this.port, this.bindAddress);
    socket.on('error', error => emitError(this, error));
    if (this.protocol === 'sacn' && this.multicast && this.universes && !this.bindAddress.startsWith('127.')) {
      const iface = this.bindAddress === '0.0.0.0' ? undefined : this.bindAddress;
      for (const universe of this.universes) {
        try { socket.addMembership(e131MulticastAddress(universe), iface); } catch (error) { emitError(this, error); }
      }
    }
    this.#socket = socket;
    return this;
  }

  async stop() {
    const socket = this.#socket; this.#socket = null; this.#state.clear();
    if (socket) await closeSocket(socket);
  }

  #onMessage(packet, remote) {
    if (!this.#socket) return;
    const time = now();
    if (time - this.#budgetAt >= 1000) { this.#budgetAt = time; this.#budget = 0; }
    if (++this.#budget > this.maxPacketsPerSecond) { this.stats.rejected++; return; }
    try {
      if (this.protocol === 'artnet') {
        const message = decodeArtNet(packet);
        if (!message) { this.stats.rejected++; return; }
        this.stats.received++;
        if (message.opcode === OP_DMX) this.#accept(message.universe, message.data, message.sequence || -1, remote.address, 100, time);
        else if (message.opcode === OP_POLL) { this.emit('poll', { source: remote.address, port: remote.port }); this.#replyToPoll(remote); }
        else this.stats.ignored++;
        return;
      }
      const message = decodeE131(packet);
      if (!message) { this.stats.rejected++; return; }
      this.stats.received++;
      if (message.preview || message.startCode !== 0) { this.stats.ignored++; return; }
      const key = `${remote.address}|${Buffer.from(message.cid).toString('hex')}`;
      if (message.terminated) {
        const state = this.#state.get(message.universe);
        if (state?.owner === key) { state.owner = null; state.lastSequence = null; }
        return;
      }
      this.#accept(message.universe, message.data, message.sequence, remote.address, message.priority, time, key);
    } catch (error) { this.stats.rejected++; emitError(this, error); }
  }

  #accept(universe, data, sequence, source, priority, time, key = source) {
    if (this.universes && !this.universes.has(universe)) { this.stats.ignored++; return; }
    let state = this.#state.get(universe);
    if (!state) {
      if (this.#state.size >= MAX_UNIVERSES) { this.stats.ignored++; return; }
      state = { data: new Uint8Array(512), length: -1, owner: null, priority: 0, seen: -Infinity, lastSequence: null };
      this.#state.set(universe, state);
    }
    const fresh = state.owner !== null && time - state.seen < SOURCE_TIMEOUT_MS;
    if (fresh && state.owner !== key && priority < state.priority) { this.stats.ignored++; return; }
    if (fresh && state.owner === key && sequence >= 0 && state.lastSequence !== null) {
      const diff = (sequence - state.lastSequence + 256 & 0xff) << 24 >> 24; // signed 8-bit
      if (diff <= 0 && diff > -20) { this.stats.ignored++; return; } // late or duplicate packet
    }
    if (state.owner !== key) state.lastSequence = null;
    state.owner = key; state.priority = priority; state.seen = time;
    if (sequence >= 0) state.lastSequence = sequence; // Art-Net sequence 0 (passed as -1) disables re-ordering
    let changed = state.length !== data.length;
    for (let i = 0; !changed && i < data.length; i++) changed = state.data[i] !== data[i];
    if (!changed) return;
    state.data.fill(0); state.data.set(data); state.length = data.length;
    this.stats.emitted++;
    this.emit('dmx', { universe, data: new Uint8Array(state.data), length: data.length, source, sequence: Math.max(0, sequence), priority, protocol: this.protocol });
  }

  #replyToPoll(remote) {
    const socket = this.#socket;
    if (!this.pollReply || !socket) return;
    const groups = new Map();
    for (const universe of this.universes || []) {
      const list = groups.get(universe >> 4) || [];
      list.push(universe); groups.set(universe >> 4, list);
    }
    const chunks = [];
    for (const list of groups.values()) for (let i = 0; i < list.length; i += 4) chunks.push(list.slice(i, i + 4));
    if (!chunks.length) chunks.push([]);
    const ip = this.pollReply.ip ?? localIPv4(this.bindAddress);
    chunks.forEach((chunk, index) => {
      try {
        const reply = encodeArtPollReply({ ...this.pollReply, ip, bindIndex: chunks.length > 1 ? index + 1 : 0,
          ports: chunk.map(universe => ({ universe, direction: 'output' })) });
        socket.send(reply, remote.port, remote.address, error => { if (error) emitError(this, error); });
      } catch (error) { emitError(this, error); }
    });
  }
}

module.exports = {
  ARTNET_PORT, E131_PORT, OP_POLL, OP_POLL_REPLY, OP_DMX, ARTNET_VERSION, E131_PREVIEW, E131_TERMINATED, E131_FORCE_SYNC, UNIVERSE_RANGE,
  portAddress, splitPortAddress, encodeArtDmx, encodeArtPoll, encodeArtPollReply, decodeArtNet,
  e131MulticastAddress, encodeE131, decodeE131, DmxSender, DmxReceiver,
};
