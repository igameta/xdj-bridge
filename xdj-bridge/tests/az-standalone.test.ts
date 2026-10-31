import assert from 'node:assert/strict';
import type { Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { StateStore } from '../src/core/store.js';
import { snapshotToOsc } from '../src/output/osc.js';
import { RuntimeController } from '../src/runtime.js';
import { azStandalonePresence, keepAlive, pickAzStandaloneNumber, startLive, type LiveOptions, type NetworkServices, type SelectedInterface } from '../src/transport/live.js';
import { makeDemoPackets } from '../src/transport/replay.js';

const iface: SelectedInterface = { name: 'az-test', address: '192.0.2.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:11:22:33:44:55', internal: false, cidr: '192.0.2.20/24', broadcast: '192.0.2.255' };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const waitFor = async (predicate: () => boolean) => {
  const deadline = performance.now() + 1200;
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected AZ experimental state was not reached');
};
class FakeSocket extends EventEmitter {
  port = -1;
  address = '';
  closed = false;
  sent: { bytes: Buffer; target: string; port: number }[] = [];
  bind(port: number, address: string, done: () => void) { this.port = port; this.address = address; queueMicrotask(done); }
  setBroadcast() {}
  send(bytes: Buffer, port: number, target: string, done: () => void) { this.sent.push({ bytes: Buffer.from(bytes), target, port }); queueMicrotask(done); }
  close(done: () => void) { this.closed = true; queueMicrotask(done); }
  receive(bytes: Buffer, address: string) { this.emit('message', bytes, { address, port: 50002, family: 'IPv4', size: bytes.length }); }
}
function network(onObserve?: (net: ReturnType<typeof network>) => void) {
  const sockets: FakeSocket[] = []; let now = 0;
  const net = { sockets, setTime(value: number) { now = value; }, services: {} as NetworkServices };
  net.services = {
    createSocket() { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as Socket; },
    listInterfaces: () => [iface], now: () => now,
    async wait(ms, signal) { signal.throwIfAborted(); onObserve?.(net); now += ms; },
  };
  return net;
}
function announce(model: string, number: number, ip = '192.0.2.50') {
  const bytes = keepAlive({ ...iface, address: ip, mac: '00:aa:bb:cc:dd:ee' }, number);
  bytes.fill(0, 12, 32); bytes.write(model, 12, 'ascii'); return bytes;
}
function createStore() { return new StateStore({ sessionId: 'az-test', mode: 'az-standalone' }); }

test('AZ PC presence encodes observed role fields independently and reserves only unused number 5 or 6', () => {
  const packet = azStandalonePresence(iface, 5, 7);
  assert.equal(packet.length, 54); assert.equal(packet.subarray(0, 10).toString(), 'Qspt1WmJOL');
  assert.equal(packet[10], 6); assert.equal(packet[0x20], 1); assert.equal(packet[0x21], 3); assert.equal(packet.readUInt16BE(0x22), 54);
  assert.deepEqual([...packet.subarray(0x24, 0x30)], [5, 1, 0, 17, 34, 51, 68, 85, 192, 0, 2, 20]);
  assert.deepEqual([...packet.subarray(0x30)], [7, 1, 0, 0, 4, 8]);
  assert.equal(pickAzStandaloneNumber(new Set()), 5); assert.equal(pickAzStandaloneNumber(new Set([1, 2, 3, 4, 5])), 6);
  assert.throws(() => pickAzStandaloneNumber(new Set([5, 6])), /5\/6/);
  assert.throws(() => azStandalonePresence(iface, 7 as 5));
});

test('explicit AZ mode can send one PC presence after six silent seconds without any CDJ claims or global broadcast', async () => {
  const net = network(); const store = createStore();
  const source = await startLive(store, { interfaceName: iface.name, mode: 'az-standalone', profile: 'xdj-az' }, net.services);
  try {
    assert.equal(net.sockets.length, 4);
    assert.deepEqual(net.sockets.map(s => [s.port, s.address]), [[50000, '0.0.0.0'], [50001, '0.0.0.0'], [50002, iface.address], [0, iface.address]]);
    const sent = net.sockets.flatMap(s => s.sent); assert.equal(sent.length, 1); assert.equal(sent[0].target, iface.broadcast); assert.equal(sent[0].port, 50000);
    assert.equal(sent[0].bytes[10], 6); assert.equal(sent[0].bytes[0x21], 3); assert.equal(sent[0].bytes[0x24], 5);
    assert.equal(store.snapshot().session.now, 6000); assert.equal(store.snapshot().decks.length, 0);
    assert.match(store.snapshot().session.reason!, /試験/); assert.match(store.snapshot().diagnostics.find(d => d.code === 'az-standalone-experimental')!.message, /1\.23/);
    assert.equal(sent.some(s => s.target === '255.255.255.255'), false);
  } finally { await source.close(); }
  assert.ok(net.sockets.every(s => s.closed));
});

test('observed PC occupancy selects 6, known AZ adds one unicast, and all four valid statuses reach OSC without metadata', async () => {
  const net = network(value => {
    value.sockets[0].receive(announce('rekordbox', 5, '192.0.2.60'), '192.0.2.60');
    value.sockets[0].receive(announce('XDJ-AZ', 1), '192.0.2.50');
  });
  const store = createStore(); const source = await startLive(store, { interfaceName: iface.name, mode: 'az-standalone' }, net.services);
  try {
    const sent = net.sockets.flatMap(s => s.sent); assert.deepEqual(sent.map(s => s.target), [iface.broadcast, '192.0.2.50']);
    assert.ok(sent.every(s => s.bytes[0x24] === 6 && s.bytes[10] === 6));
    assert.ok(sent.every(s => s.bytes[0x30] === 1), 'production presence must keep the observed PC template count, not add the peer count');
    const receiver = net.sockets.find(s => s.port === 50002)!;
    const packets = makeDemoPackets('any', 4).slice(0, 4);
    net.setTime(6500);
    for (const packet of packets) receiver.receive(packet.bytes, '192.0.2.50');
    const invalid = Buffer.from(packets[0].bytes); invalid[0x20] = 0xff; receiver.receive(invalid, '192.0.2.50');
    receiver.receive(packets[0].bytes, '198.51.100.50');
    const decks = store.snapshot().decks; assert.equal(decks.length, 4);
    assert.deepEqual(decks.map(d => d.publicDeckId), ['1', '2', '3', '4']);
    for (const deck of decks) {
      assert.equal(deck.title.value, null); assert.equal(deck.positionMs.value, null);
      assert.equal(deck.capabilities.status.verification, 'implemented-unverified');
      assert.equal(deck.capabilities.status.mode, 'az-standalone');
    }
    const messages = snapshotToOsc(store.snapshot());
    for (const id of ['1', '2', '3', '4']) assert.deepEqual(messages.find(m => m.address === `/dj/decks/${id}/bpm/valid`)?.args, [1]);
  } finally { await source.close(); }
});

test('busy 5/6 and known non-AZ players refuse transmission rather than choosing 1–4 or adopting a foreign profile', async () => {
  for (const models of [[['rekordbox', 5], ['rekordbox', 6]], [['CDJ-3000', 1]], [['XDJ-AZ', 1], ['XDJ-RX3', 11]]] as [string, number][][]) {
    const net = network(value => models.forEach(([model, wire], index) => { const ip = `192.0.2.${50 + index}`; value.sockets[0].receive(announce(model, wire, ip), ip); }));
    const store = createStore(); await assert.rejects(startLive(store, { interfaceName: iface.name, mode: 'az-standalone' }, net.services));
    assert.equal(net.sockets.flatMap(s => s.sent).length, 0); assert.ok(net.sockets.every(s => s.closed));
    assert.equal(store.snapshot().decks.length, 0);
  }
});

test('AZ number conflict stops every socket and invalidates state; a later non-AZ player is never adopted', async () => {
  for (const incoming of ['conflict', 'foreign']) {
    const net = network(); const store = createStore(); const errors: Error[] = [];
    const source = await startLive(store, { interfaceName: iface.name, mode: 'az-standalone', onError: e => errors.push(e) }, net.services);
    try {
      const bytes = incoming === 'conflict' ? announce('rekordbox', 5) : announce('CDJ-3000', 2);
      net.sockets[0].receive(bytes, '192.0.2.50'); await turn();
      assert.equal(errors.length, 1); assert.ok(net.sockets.every(s => s.closed)); assert.equal(store.snapshot().session.state, 'degraded');
      const count = net.sockets.flatMap(s => s.sent).length;
      for (const p of makeDemoPackets('any', 4).slice(0, 4)) net.sockets[2].receive(p.bytes, '192.0.2.50');
      assert.equal(store.snapshot().decks.length, 0); assert.equal(net.sockets.flatMap(s => s.sent).length, count);
    } finally { await source.close(); }
  }
});

test('no AZ reply times out and stops presence without recommending Mode ON or updating firmware', async () => {
  const net = network(); const store = createStore(); const errors: Error[] = [];
  const source = await startLive(store, { interfaceName: iface.name, mode: 'az-standalone', onError: e => errors.push(e) }, net.services);
  try {
    net.setTime(16_001); await waitFor(() => errors.length === 1);
    assert.match(errors[0].message, /10秒/); assert.match(errors[0].message, /FW1\.23/); assert.match(errors[0].message, /OFF/);
    assert.doesNotMatch(errors[0].message, /Mode ON|ModeをOn|アップデート/);
    assert.ok(net.sockets.every(s => s.closed)); assert.equal(store.snapshot().session.state, 'degraded');
  } finally { await source.close(); }
});

test('AZ mode/profile/forced-number settings reject before source startup and retain normal virtual-device defaults', async () => {
  assert.equal((await parseConfig([])).mode, 'idle');
  const config = await parseConfig(['--mode', 'az-standalone', '--profile', 'xdj-az', '--interface', iface.name]);
  assert.equal(config.mode, 'az-standalone'); assert.equal(config.deviceNumber, undefined);
  for (const extra of [['--profile', 'xdj-rx3'], ['--profile', 'generic-prolink'], ['--backend', 'alphatheta'], ['--device-number', '7'], ['--device-number', '5']]) await assert.rejects(parseConfig(['--mode', 'az-standalone', '--interface', iface.name, ...extra]));
  const started: LiveOptions[] = [];
  const runtime = new RuntimeController(config, { listInterfaces: () => [iface], async startLive(_store, options) { started.push(options); return { async close() {} }; } });
  try {
    await runtime.initialize(); await turn(); assert.equal(started[0].mode, 'az-standalone'); assert.equal(started[0].profile, 'xdj-az');
    assert.equal(runtime.getRuntime().connection.mode, 'az-standalone');
  } finally { await runtime.close(); }
  const forced = new RuntimeController({ ...await parseConfig([]), deviceNumber: 7 }, { listInterfaces: () => [iface], async startLive() { throw new Error('Must not start'); } });
  try { await assert.rejects(forced.connect({ mode: 'az-standalone', backend: 'native', profile: 'auto', interfaceName: iface.name }), /deviceNumber/); }
  finally { await forced.close(); }
  const normal = await parseConfig(['--mode', 'virtual-device', '--interface', iface.name, '--device-number', '7']);
  assert.equal(normal.deviceNumber, 7); assert.equal(normal.mode, 'virtual-device');
});
