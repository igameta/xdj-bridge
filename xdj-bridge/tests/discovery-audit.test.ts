import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:dgram';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import type { AppConfig } from '../src/config.js';
import { decodePacket } from '../src/core/decoder.js';
import { StateStore } from '../src/core/store.js';
import type { PacketEnvelope } from '../src/core/types.js';
import { PlaybackNotifier } from '../src/output/notifications.js';
import { snapshotToOsc } from '../src/output/osc.js';
import { startServer } from '../src/output/server.js';
import { RuntimeController } from '../src/runtime.js';
import { discoverDevices, keepAlive, mixerNegotiation, sourceMembership, startLive, type NetworkServices, type SelectedInterface } from '../src/transport/live.js';
import { readCapture } from '../src/transport/replay.js';

const iface: SelectedInterface = { name: 'audit0', address: '192.0.2.20', netmask: '255.255.255.0',
  family: 'IPv4', mac: '00:11:22:33:44:55', internal: false, cidr: '192.0.2.20/24', broadcast: '192.0.2.255' };
const other: SelectedInterface = { ...iface, name: 'audit1', address: '198.51.100.20', cidr: '198.51.100.20/24', broadcast: '198.51.100.255' };
const fixture = Buffer.from((await readFile(new URL('../../tests/fixtures/rx3-loop-master-sync.hex', import.meta.url), 'utf8')).trim(), 'hex');
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const config = (extra: Partial<AppConfig> = {}): AppConfig => ({ mode: 'idle', backend: 'native', interfaceName: iface.name,
  profile: 'auto', speed: 1, loop: false, host: '127.0.0.1', port: 0, staleAfterMs: 3000, publicDeckIds: {}, ...extra });
const selected = (interfaceName = iface.name) => ({ interfaceName, mode: 'passive', backend: 'native', profile: 'auto' });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};
function announcement(ip = '192.0.2.50', wire = 1, model = 'CDJ-3000'): Buffer {
  const bytes = keepAlive({ ...iface, address: ip, mac: '00:aa:bb:cc:dd:ee' }, wire);
  bytes.fill(0, 12, 32); bytes.write(model, 12, 20, 'ascii');
  return bytes;
}
function status(wire = 1): Buffer {
  const bytes = Buffer.from(fixture);
  bytes.fill(0, 11, 31); bytes.write('CDJ-3000', 11, 'ascii');
  bytes[0x20] = 3; bytes[0x21] = wire; bytes[0x28] = wire;
  return bytes;
}
function packet(store: StateStore, bytes: Buffer, sourceIp = '192.0.2.50', destinationPort = 50000, receivedAt = 0): PacketEnvelope {
  return { sessionId: store.snapshot().session.id, interfaceId: iface.name, sourceIp, sourcePort: 50002,
    destinationIp: iface.broadcast, destinationPort, transport: 'udp', bytes, receivedAt, interfaceEvidence: 'subnet' };
}
class FakeSocket extends EventEmitter {
  port = 0;
  address = '';
  closed = false;
  sent: Array<{ bytes: Buffer; port: number; address: string }> = [];
  closeCallback?: () => void;
  holdClose = false;
  bind(port: number, address: string, ready: () => void) { this.port = port; this.address = address; queueMicrotask(ready); }
  setBroadcast() {}
  send(bytes: Buffer, port: number, address: string, done: (error?: Error) => void) {
    this.sent.push({ bytes: Buffer.from(bytes), port, address }); queueMicrotask(done);
  }
  close(done: () => void) { this.closed = true; if (this.holdClose) this.closeCallback = done; else queueMicrotask(done); }
  receive(bytes: Buffer, address: string) { this.emit('message', bytes, { address, family: 'IPv4', port: 50002, size: bytes.length }); }
}
function network(wait?: NetworkServices['wait']) {
  const sockets: FakeSocket[] = [];
  let interfaces = [iface, other], time = 0;
  const gate = deferred<void>();
  const services: NetworkServices = {
    createSocket(options) { assert.deepEqual(options, { type: 'udp4', reuseAddr: false }); const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as Socket; },
    listInterfaces: () => interfaces,
    now: () => time,
    wait: wait ?? (async (_ms, signal) => {
      if (signal.aborted) throw new Error('Cancelled');
      const abort = () => gate.reject(new Error('Cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      try { await gate.promise; } finally { signal.removeEventListener('abort', abort); }
    }),
  };
  return { sockets, services, gate, setInterfaces(value: SelectedInterface[]) { interfaces = value; }, setTime(value: number) { time = value; } };
}

test('discovery audit: receive-only scan keeps distinct source IPs, rejects foreign routes and never makes deck/output state', async () => {
  const store = new StateStore({ sessionId: 'scan-audit', mode: 'passive' });
  const net = network();
  let notices = 0;
  const notifier = new PlaybackNotifier(store, { supported: true, async send() { notices++; } }, { enabled: true, coalesceMs: 0 });
  const task = discoverDevices(store, { interfaceName: iface.name }, net.services);
  try {
    await turn(); const socket = net.sockets[0];
    assert.equal(net.sockets.length, 1); assert.equal(socket.port, 50000); assert.equal(socket.address, '0.0.0.0');
    socket.receive(announcement('192.0.2.50', 1), '192.0.2.50');
    socket.receive(announcement('192.0.2.51', 1), '192.0.2.51');
    socket.receive(announcement(other.address, 2), other.address); // Our other local address.
    socket.receive(announcement('198.51.100.51', 2), '198.51.100.51'); // A known other IF.
    socket.receive(announcement('203.0.113.51', 3), '203.0.113.51'); // Observed, never assigned to the selected IF.
    socket.receive(status(), '192.0.2.50'); // A status-looking payload on the announcement port.
    const devices = store.snapshot().devices;
    assert.equal(devices.length, 3);
    assert.equal(new Set(devices.map(value => value.id)).size, 3);
    assert.deepEqual(devices.filter(value => value.interfaceId === iface.name).map(value => value.sourceIp), ['192.0.2.50', '192.0.2.51']);
    const unknown = devices.find(value => value.sourceIp === '203.0.113.51')!;
    assert.equal(unknown.interfaceId, null); assert.equal(unknown.interfaceEvidence, 'unknown'); assert.equal(unknown.status, 'unassigned');
    assert.equal(store.snapshot().decks.length, 0);
    assert.equal(snapshotToOsc(store.snapshot()).some(message => message.address.startsWith('/dj/decks/')), false);
    await turn(); assert.equal(notices, 0); assert.equal(socket.sent.length, 0);
  } finally { net.gate.resolve(); await task; await notifier.close(); }
  assert.ok(net.sockets.every(socket => socket.closed));
});

test('discovery audit: passive receives broadcast status on wildcard 50002 while active keeps the selected source address', async () => {
  const passiveStore = new StateStore({ sessionId: 'passive-audit', mode: 'passive' }), passiveNet = network();
  const source = await startLive(passiveStore, { interfaceName: iface.name, mode: 'passive' }, passiveNet.services);
  try {
    assert.deepEqual(passiveNet.sockets.map(socket => [socket.port, socket.address]), [[50000, '0.0.0.0'], [50001, '0.0.0.0'], [50002, '0.0.0.0']]);
    const socket = passiveNet.sockets.find(value => value.port === 50002)!;
    socket.receive(status(1), '192.0.2.50'); socket.receive(status(2), '192.0.2.51');
    socket.receive(status(3), '198.51.100.51'); socket.receive(status(4), iface.address);
    assert.deepEqual(passiveStore.snapshot().decks.map(deck => deck.raw.sourceIp), ['192.0.2.50', '192.0.2.51']);
    assert.ok(passiveStore.snapshot().devices.every(device => device.status === 'receiving' && device.interfaceEvidence === 'subnet'));
    assert.equal(passiveNet.sockets.flatMap(value => value.sent).length, 0);
  } finally { await source.close(); }
  const activeStore = new StateStore({ sessionId: 'active-audit', mode: 'virtual-device' });
  let calls = 0;
  const activeNet = network(async () => {
    if (calls++ === 0) {
      activeNet.sockets[0].receive(announcement('192.0.2.50', 1), '192.0.2.50');
      activeNet.sockets[0].receive(announcement('192.0.2.51', 2), '192.0.2.51');
    }
  });
  const active = await startLive(activeStore, { interfaceName: iface.name, mode: 'virtual-device' }, activeNet.services);
  try {
    const sender = activeNet.sockets.find(socket => socket.port === 50002)!;
    assert.equal(sender.address, iface.address);
    assert.deepEqual(new Set(sender.sent.map(value => value.address)), new Set(['192.0.2.50', '192.0.2.51']));
    assert.equal(sender.sent.length, 26, 'each of two LAN peers gets the 12 startup packets plus keepalive');
    assert.ok(sender.sent.every(value => value.port === 50000));
  } finally { await active.close(); }
});

test('discovery audit: malformed announcement identity/layout never creates a device', async () => {
  const store = new StateStore({ sessionId: 'parse-audit', mode: 'passive' });
  const valid = announcement();
  const mutate = (action: (bytes: Buffer) => void) => { const bytes = Buffer.from(valid); action(bytes); return bytes; };
  const malformed = [valid.subarray(0, 53), mutate(bytes => { bytes[0] = 0; }), mutate(bytes => { bytes[0x24] = 0; }),
    mutate(bytes => { bytes[0x20] = 0; }), mutate(bytes => { bytes[0x21] = 0xff; }),
    mutate(bytes => { bytes.writeUInt16BE(53, 0x22); }), mutate(bytes => { bytes.writeUInt16BE(65535, 0x22); }),
    mutate(bytes => { bytes[0x2c] = 1; }), mutate(bytes => { bytes.fill(0, 12, 32); })];
  for (const bytes of malformed) { const value = packet(store, bytes); assert.equal(decodePacket(value), null, bytes.toString('hex')); store.ingest(value); }
  assert.equal(store.snapshot().devices.length, 0); assert.equal(store.snapshot().decks.length, 0);
});

test('discovery audit: a changed or overlapping interface cannot attribute a packet to the old selected LAN', async () => {
  for (const replacement of [[other], [iface, { ...other, address: '192.0.2.30', netmask: '255.255.255.0' }]]) {
    const store = new StateStore({ sessionId: 'changed-if', mode: 'passive' }), net = network();
    const task = discoverDevices(store, { interfaceName: iface.name }, net.services);
    const outcome = task.then(() => undefined, error => error);
    await turn(); net.setInterfaces(replacement); net.sockets[0].receive(announcement(), '192.0.2.50');
    net.gate.resolve(); await outcome;
    assert.equal(store.snapshot().devices.some(device => device.interfaceId === iface.name), false, 'an old subnet must not be accepted after its interface changed');
    assert.ok(net.sockets.every(socket => socket.closed));
  }
  assert.equal(sourceMembership(iface.address, iface, [iface, other]), 'self');
  assert.equal(sourceMembership('224.0.0.1', iface, [iface, other]), 'other-interface');
});

test('discovery audit: cancellation waits for UDP release and late packets cannot change its result', async () => {
  const store = new StateStore({ sessionId: 'scan-close', mode: 'passive' }), net = network(), abort = new AbortController();
  const task = discoverDevices(store, { interfaceName: iface.name, signal: abort.signal }, net.services);
  await turn(); const socket = net.sockets[0]; socket.holdClose = true;
  abort.abort(); let finished = false; void task.then(() => { finished = true; });
  await turn(); assert.equal(finished, false); assert.ok(socket.closeCallback);
  socket.receive(announcement(), '192.0.2.50'); assert.equal(store.snapshot().devices.length, 0);
  socket.closeCallback!(); await task;
  assert.equal(finished, true); assert.equal(socket.sent.length, 0);
});

test('discovery audit: bounded catalog expires reception, revives identity and ignores the prior session', () => {
  const store = new StateStore({ sessionId: 'catalog-audit', mode: 'passive' });
  for (let n = 1; n <= 180; n++) store.ingest(packet(store, announcement(`192.0.2.${n}`, n), `192.0.2.${n}`, 50000, n));
  assert.equal(store.snapshot().devices.length, 128);
  const prior = store.snapshot().devices.find(device => device.sourceIp === '192.0.2.180')!;
  store.tick(7000); assert.ok(store.snapshot().devices.every(device => device.status === 'stale'));
  store.ingest(packet(store, announcement('192.0.2.180', 180), '192.0.2.180', 50000, 7001));
  const revived = store.snapshot().devices.find(device => device.sourceIp === '192.0.2.180')!;
  assert.equal(revived.id, prior.id); assert.equal(revived.status, 'announced'); assert.equal(revived.lastSeenAt, 7001);
  const next = new StateStore({ sessionId: 'catalog-next', mode: 'passive' });
  next.ingest(packet(store, announcement(), '192.0.2.50', 50000, 7002));
  assert.equal(next.snapshot().devices.length, 0); assert.equal(next.snapshot().decks.length, 0);
});

test('discovery audit: mixer intention has no target identity and unrelated assignment cannot stop a running peer', () => {
  const intention = Buffer.alloc(0x2f); announcement().copy(intention, 0, 0, 36); intention[10] = 1; intention.writeUInt16BE(intention.length, 0x22);
  assert.equal(mixerNegotiation(intention, 7, true), 'ambiguous');
  assert.equal(mixerNegotiation(intention, 7, false), 'ambiguous');
  const assigned = Buffer.alloc(0x27); announcement().copy(assigned, 0, 0, 36); assigned[10] = 3; assigned[11] = 1; assigned[36] = 8; assigned.writeUInt16BE(assigned.length, 0x22);
  assert.equal(mixerNegotiation(assigned, 7, true), 'ignore');
  assigned[36] = 7;
  assert.equal(mixerNegotiation(assigned, 7, false), 'ignore');
  assert.equal(mixerNegotiation(assigned, 7, true), 'reject');
  assigned.writeUInt16BE(65535, 0x22); assert.equal(mixerNegotiation(assigned, 7, true), 'ignore');
});

test('discovery audit: synthetic Ethernet/VLAN broadcast observations preserve multiple physical IPs without phantom decks', async () => {
  const header = Buffer.alloc(24); header.writeUInt32LE(0xa1b2c3d4); header.writeUInt16LE(2, 4); header.writeUInt16LE(4, 6); header.writeUInt32LE(65535, 16); header.writeUInt32LE(1, 20);
  const record = (ip: string, wire: number, vlan: boolean) => {
    const payload = announcement(ip, wire), link = vlan ? 18 : 14;
    const frame = Buffer.alloc(link + 28 + payload.length); frame.fill(0xff, 0, 6); frame.writeUInt16BE(vlan ? 0x8100 : 0x0800, 12);
    if (vlan) { frame.writeUInt16BE(42, 14); frame.writeUInt16BE(0x0800, 16); }
    frame[link] = 0x45; frame.writeUInt16BE(28 + payload.length, link + 2); frame[link + 9] = 17;
    Buffer.from(ip.split('.').map(Number)).copy(frame, link + 12); Buffer.from([192, 0, 2, 255]).copy(frame, link + 16);
    frame.writeUInt16BE(50000, link + 20); frame.writeUInt16BE(50000, link + 22); frame.writeUInt16BE(8 + payload.length, link + 24); payload.copy(frame, link + 28);
    const rec = Buffer.alloc(16); rec.writeUInt32LE(1000 + wire); rec.writeUInt32LE(frame.length, 8); rec.writeUInt32LE(frame.length, 12);
    return Buffer.concat([rec, frame]);
  };
  const dir = await mkdtemp(join(tmpdir(), 'xdj-discovery-audit-'));
  try {
    const path = join(dir, 'synthetic.pcap'); await writeFile(path, Buffer.concat([header, record('192.0.2.50', 1, false), record('192.0.2.51', 2, true)]));
    const packets = await readCapture(path, 'l2-audit'), store = new StateStore({ sessionId: 'l2-audit', mode: 'replay' });
    for (const value of packets) store.ingest(value);
    assert.deepEqual(store.snapshot().devices.map(device => device.sourceIp), ['192.0.2.50', '192.0.2.51']);
    assert.ok(store.snapshot().devices.every(device => device.interfaceEvidence === 'capture'));
    assert.equal(store.snapshot().decks.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('discovery audit: private scan cannot affect live values, OSC, notifications or the next source session', async () => {
  const gate = deferred<void>(); let scanStore!: StateStore, liveStore!: StateStore;
  let scanSignal!: AbortSignal, notices = 0, outputStarts = 0, outputCloses = 0;
  const runtime = new RuntimeController(config({ notifications: { enabled: true }, osc: { enabled: true, host: '127.0.0.1', port: 9000 } }), {
    listInterfaces: () => [iface, other],
    notificationSender: { supported: true, async send() { notices++; } },
    startOsc() { outputStarts++; return { async close() { outputCloses++; } }; },
    async discoverDevices(store, options) { scanStore = store; scanSignal = options.signal!; await gate.promise; },
    async startLive(store) { liveStore = store; store.ingest(packet(store, status(), '192.0.2.50', 50002)); return { async close() {} }; },
  });
  try {
    await runtime.initialize(); const before = runtime.snapshot();
    await runtime.discover({ interfaceName: iface.name });
    assert.equal(runtime.getRuntime().discovery.searching, true, 'discovery must return before its receive window finishes');
    scanStore.ingest(packet(scanStore, announcement()));
    const maliciousStatus = status(); maliciousStatus[0x7b] = 3;
    scanStore.ingest(packet(scanStore, maliciousStatus, '192.0.2.50', 50002, 1));
    maliciousStatus[0x7b] = 5;
    scanStore.ingest(packet(scanStore, maliciousStatus, '192.0.2.50', 50002, 2));
    assert.deepEqual(runtime.snapshot(), before, 'even an injected scanner must not publish deck data to the session hub');
    assert.equal(outputStarts, 1); assert.equal(outputCloses, 0); assert.equal(notices, 0);
    await assert.rejects(runtime.connect(selected()), { status: 409 });
    await assert.rejects(runtime.discover({ interfaceName: iface.name }), { status: 409 });
    gate.resolve(); await turn(); assert.equal(runtime.getRuntime().discovery.searching, false);
    await runtime.connect(selected()); await turn();
    assert.notEqual(runtime.snapshot().session.id, before.session.id);
    assert.equal(runtime.getRuntime().discovery.source, 'session');
    assert.equal(runtime.getRuntime().discovery.devices[0].id, liveStore.snapshot().devices[0].id);
    const latest = runtime.snapshot();
    scanStore.ingest(packet(scanStore, announcement('192.0.2.51', 2), '192.0.2.51', 50000, 3));
    assert.deepEqual(runtime.snapshot(), latest); assert.equal(runtime.getRuntime().discovery.devices.length, 1);
    assert.equal(scanSignal.aborted, false); assert.equal(notices, 0);
  } finally { gate.resolve(); await runtime.close(); }
});

test('discovery audit: live discovery reuses the active source and rejects a different LAN without closing it', async () => {
  let scans = 0, closes = 0, outputs = 0;
  const runtime = new RuntimeController(config({ mode: 'passive', osc: { enabled: true, host: '127.0.0.1', port: 9000 } }), {
    listInterfaces: () => [iface, other],
    async startLive(store) { store.ingest(packet(store, status(), '192.0.2.50', 50002)); return { async close() { closes++; } }; },
    async discoverDevices() { scans++; },
    startOsc() { outputs++; return { async close() {} }; },
  });
  try {
    await runtime.initialize(); await turn(); const before = runtime.snapshot();
    await assert.rejects(runtime.discover({ interfaceName: other.name }), { status: 409 });
    await runtime.discover({ interfaceName: iface.name });
    assert.equal(runtime.getRuntime().discovery.source, 'session'); assert.equal(runtime.getRuntime().discovery.searching, true);
    assert.equal(scans, 0); assert.equal(closes, 0); assert.equal(outputs, 1); assert.deepEqual(runtime.snapshot(), before);
    await runtime.disconnect(); assert.equal(closes, 1); assert.equal(runtime.getRuntime().discovery.searching, false);
  } finally { await runtime.close(); }
});

test('discovery audit: immediate application close cannot start a queued scan, and scan cleanup remains awaited', async () => {
  let starts = 0;
  const immediate = new RuntimeController(config(), { listInterfaces: () => [iface], async discoverDevices() { starts++; } });
  const scanning = immediate.discover({ interfaceName: iface.name }), closing = immediate.close();
  await assert.rejects(scanning, { status: 503 }); await closing; assert.equal(starts, 0);
  const release = deferred<void>(); let signal!: AbortSignal;
  const runtime = new RuntimeController(config(), { listInterfaces: () => [iface], async discoverDevices(_store, options) { signal = options.signal!; await release.promise; } });
  await runtime.discover({ interfaceName: iface.name });
  const stopping = runtime.close(); assert.equal(signal.aborted, true);
  let finished = false; void stopping.then(() => { finished = true; });
  await turn(); assert.equal(finished, false);
  release.resolve(); await stopping;
  await assert.rejects(runtime.discover({ interfaceName: iface.name }), { status: 503 });
});

test('discovery audit: recovery after source failure waits for old ownership release before starting the scanner', async () => {
  const release = deferred<void>(), scanRelease = deferred<void>(); let scans = 0, closingSource = false;
  const runtime = new RuntimeController(config({ mode: 'passive' }), {
    listInterfaces: () => [iface],
    async startLive(_store, options) { options.onError?.(new Error('Synthetic source failure')); return { async close() { closingSource = true; await release.promise; } }; },
    async discoverDevices() { scans++; await scanRelease.promise; },
  });
  let searching: Promise<void> | undefined;
  try {
    await runtime.initialize(); await turn(); assert.equal(runtime.getRuntime().connection.connected, false);
    searching = runtime.discover({ interfaceName: iface.name }); await turn();
    assert.equal(closingSource, true); assert.equal(scans, 0);
    release.resolve(); await searching;
    assert.equal(scans, 1); assert.equal(runtime.getRuntime().discovery.source, 'scan'); assert.equal(runtime.getRuntime().discovery.searching, true);
    scanRelease.resolve(); await turn();
  } finally { release.resolve(); scanRelease.resolve(); await searching; await runtime.close(); }
});

test('discovery audit: local HTTP control guards and WebSocket device deltas preserve source-session boundaries', async () => {
  const gate = deferred<void>();
  const runtime = new RuntimeController(config(), { listInterfaces: () => [iface], async discoverDevices() { await gate.promise; } });
  const server = await startServer(runtime, { host: '127.0.0.1', port: 0, runtime: () => runtime.getRuntime(), controls: runtime });
  const post = (value: unknown, headers: Record<string, string> = {}) => fetch(server.url + '/api/discovery', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  const store = new StateStore({ sessionId: 'ws-catalog', mode: 'passive' });
  const wsServer = await startServer(store, { host: '127.0.0.1', port: 0 });
  const ws = new WebSocket(wsServer.url.replace('http', 'ws') + '/ws'), messages: any[] = [];
  const waitFor = async (predicate: () => boolean) => {
    const limit = performance.now() + 1500;
    while (!predicate() && performance.now() < limit) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'Expected local WebSocket event did not arrive');
  };
  ws.on('message', value => messages.push(JSON.parse(value.toString())));
  try {
    assert.equal((await post({ interfaceName: iface.name }, { Origin: 'https://foreign.invalid' })).status, 403);
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const req = request(server.url + '/api/discovery', { method: 'POST', headers: { Host: 'foreign.invalid', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end(JSON.stringify({ interfaceName: iface.name }));
    });
    assert.equal(foreignHost, 403);
    assert.equal((await post({ interfaceName: iface.name }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post({ padding: 'x'.repeat(5000) })).status, 413);
    assert.equal((await post({ interfaceName: false })).status, 400);
    assert.equal((await post({ interfaceName: iface.name })).status, 200);
    assert.equal((await post({ interfaceName: iface.name })).status, 409);
    assert.equal(runtime.snapshot().decks.length, 0);
    await waitFor(() => messages.length === 1);
    assert.deepEqual(messages[0].devices, []);
    store.ingest(packet(store, announcement())); await waitFor(() => messages.length === 2);
    assert.equal(messages[1].type, 'delta'); assert.equal(messages[1].baseRevision, messages[0].revision);
    assert.equal(messages[1].devices.length, 1); assert.equal(messages[1].decks.length, 0);
    store.tick(7000); await waitFor(() => messages.length === 3); assert.equal(messages[2].devices[0].status, 'stale');
    gate.resolve(); await turn(); await runtime.close();
    assert.equal((await post({ interfaceName: iface.name })).status, 503);
  } finally { gate.resolve(); ws.terminate(); await runtime.close(); await server.close(); await wsServer.close(); }
});
