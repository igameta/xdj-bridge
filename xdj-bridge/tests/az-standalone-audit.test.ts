import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { parseConfig } from '../src/config.js';
import { StateStore } from '../src/core/store.js';
import { snapshotToOsc } from '../src/output/osc.js';
import { startServer } from '../src/output/server.js';
import { RuntimeController } from '../src/runtime.js';
import { azStandalonePresence, keepAlive, pickAzStandaloneNumber, startLive, type NetworkServices, type SelectedInterface } from '../src/transport/live.js';

const iface: SelectedInterface = { name: 'az-audit0', address: '192.0.2.20', netmask: '255.255.255.0',
  family: 'IPv4', mac: '00:11:22:33:44:55', internal: false, cidr: '192.0.2.20/24', broadcast: '192.0.2.255' };
const fixture = Buffer.from((await readFile(new URL('../../tests/fixtures/rx3-loop-master-sync.hex', import.meta.url), 'utf8')).trim(), 'hex');
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
const options = { interfaceName: iface.name, mode: 'az-standalone' as const, profile: 'xdj-az' as const };
function announcement(ip: string, wire: number, model = 'XDJ-AZ') {
  const bytes = keepAlive({ ...iface, address: ip, mac: '00:aa:bb:cc:dd:ee' }, wire);
  bytes.fill(0, 12, 32); bytes.write(model, 12, 20, 'ascii'); return bytes;
}
function status(wire = 1, model = 'XDJ-AZ') {
  const bytes = Buffer.alloc(292); fixture.copy(bytes, 0, 0, 292);
  bytes.fill(0, 11, 31); bytes.write(model, 11, 20, 'ascii'); bytes[0x1f] = 1; bytes[0x20] = 3; bytes[0x21] = wire; bytes[0x28] = 1;
  bytes.writeUInt32BE(100 + wire, 0x2c); return bytes;
}
class FakeSocket extends EventEmitter {
  port = -1; address = ''; closed = false; ready?: () => void;
  holdBind = false; holdSend = false; holdClose = false;
  sendCallbacks: Array<(error?: Error) => void> = [];
  closeCallback?: () => void;
  sent: Array<{ bytes: Buffer; port: number; address: string }> = [];
  bind(port: number, address: string, ready: () => void) { this.port = port; this.address = address; this.ready = ready; if (!this.holdBind) queueMicrotask(ready); }
  setBroadcast() {}
  send(bytes: Buffer, port: number, address: string, callback: (error?: Error) => void) {
    this.sent.push({ bytes: Buffer.from(bytes), port, address }); if (this.holdSend) this.sendCallbacks.push(callback); else queueMicrotask(callback);
  }
  close(callback: () => void) { this.closed = true; if (this.holdClose) this.closeCallback = callback; else queueMicrotask(callback); }
  receive(bytes: Buffer, address: string) { this.emit('message', bytes, { address, port: 50002, family: 'IPv4', size: bytes.length }); }
}
function network(onWait?: (network: ReturnType<typeof makeNetwork>, ms: number, signal: AbortSignal) => Promise<void> | void) { return makeNetwork(onWait); }
function makeNetwork(onWait?: (network: ReturnType<typeof makeNetwork>, ms: number, signal: AbortSignal) => Promise<void> | void) {
  const sockets: FakeSocket[] = []; let time = 0;
  const net = {
    sockets, blockIndex: -1, holdSends: false,
    setTime(value: number) { time = value; },
    get sends() { return sockets.flatMap(socket => socket.sent); },
    socket(port: number) { return sockets.find(socket => socket.port === port)!; },
    services: {} as NetworkServices,
  };
  net.services = {
    createSocket(value) { assert.deepEqual(value, { type: 'udp4', reuseAddr: false }); const socket = new FakeSocket(); socket.holdBind = sockets.length === net.blockIndex; socket.holdSend = net.holdSends; sockets.push(socket); return socket as unknown as Socket; },
    listInterfaces: () => [iface], now: () => time,
    async wait(ms, signal) { await onWait?.(net, ms, signal); if (signal.aborted) throw new Error('Cancelled'); time += ms; },
  };
  return net;
}
const store = () => new StateStore({ sessionId: 'az-independent-audit', mode: 'az-standalone', interfaceId: iface.name });

test('AZ audit: PC presence encodes only independently described fields and reserves numbers 5/6', () => {
  const bytes = azStandalonePresence(iface, 6, 9);
  assert.equal(bytes.length, 54); assert.equal(bytes.subarray(0, 10).toString(), 'Qspt1WmJOL');
  assert.equal(bytes[10], 6); assert.equal(bytes[11], 0); assert.equal(bytes[0x20], 1); assert.equal(bytes[0x21], 3);
  assert.equal(bytes.readUInt16BE(0x22), 54); assert.equal(bytes[0x24], 6);
  assert.equal(bytes.subarray(0x26, 0x2c).toString('hex'), '001122334455');
  assert.deepEqual([...bytes.subarray(0x2c, 0x30)], [192, 0, 2, 20]); assert.deepEqual([...bytes.subarray(0x30)], [9, 1, 0, 0, 4, 8]);
  assert.equal(pickAzStandaloneNumber(new Set([1, 2, 3, 4, 17, 33])), 5); assert.equal(pickAzStandaloneNumber(new Set([5])), 6);
  assert.throws(() => pickAzStandaloneNumber(new Set([5, 6])));
  assert.throws(() => azStandalonePresence(iface, 1 as 5));
  for (const count of [0, -1, 1.5, 256, NaN]) assert.throws(() => azStandalonePresence(iface, 5, count));
  assert.equal(keepAlive(iface, 7)[0x21], 2, 'the legacy RX3 encoder must retain its observed layout');
});

test('AZ audit: only an explicitly valid experimental selection reaches socket creation', async () => {
  const net = network();
  for (const extra of [{ profile: 'xdj-rx3' as const }, { profile: 'generic-prolink' as const }, { deviceNumber: 5 }, { deviceNumber: 7 }]) {
    await assert.rejects(startLive(store(), { ...options, ...extra }, net.services));
  }
  assert.equal(net.sockets.length, 0);
  const parsed = await parseConfig(['--mode', 'az-standalone', '--interface', iface.name, '--profile', 'xdj-az']);
  assert.equal(parsed.mode, 'az-standalone'); assert.equal(parsed.osc, undefined); assert.equal(parsed.notifications?.enabled, undefined);
  for (const extra of [['--device-number', '5'], ['--device-number', '7'], ['--backend', 'alphatheta'], ['--profile', 'xdj-rx3']]) {
    await assert.rejects(parseConfig(['--mode', 'az-standalone', '--interface', iface.name, ...extra]));
  }
  assert.equal((await parseConfig([])).mode, 'idle');
});

test('AZ audit: silent wake is explicit, directed, rate bounded and stops when no post-presence reply arrives', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const gate = deferred(), net = network(async (_net, ms) => { assert.ok(ms >= 6000); await gate.promise; }), state = store();
  const errors: Error[] = []; const starting = startLive(state, { ...options, onError: error => errors.push(error) }, net.services);
  await turn(); assert.equal(net.sends.length, 0, 'observing alone must not announce'); gate.resolve();
  const source = await starting;
  try {
    assert.equal(net.sockets.length, 4); assert.equal(net.socket(50002).address, iface.address); assert.equal(net.socket(0).address, iface.address);
    assert.equal(net.socket(0).sent.length, 1); assert.equal(net.socket(50002).sent.length, 0);
    assert.deepEqual(net.sends.map(value => [value.address, value.port, value.bytes[10], value.bytes[0x21], value.bytes[0x24]]), [[iface.broadcast, 50000, 6, 3, 5]]);
    net.setTime(7499); t.mock.timers.tick(1499); await turn(); assert.equal(net.sends.length, 1);
    net.setTime(7500); t.mock.timers.tick(1); await turn(); assert.equal(net.sends.length, 2);
    net.setTime(17001); t.mock.timers.tick(250); await turn();
    assert.equal(errors.length, 1); assert.match(errors[0].message, /10秒/); assert.ok(net.sockets.every(socket => socket.closed));
    const count = net.sends.length; t.mock.timers.tick(6000); await turn(); assert.equal(net.sends.length, count);
    assert.equal(state.snapshot().decks.length, 0); assert.equal(state.snapshot().session.state, 'degraded');
    assert.ok(net.sends.every(value => value.address !== '255.255.255.255'));
  } finally { await source.close(); t.mock.timers.reset(); }
});

test('AZ audit: observed occupancy selects 6, every valid peer can cause a collision, and busy 5/6 transmit nothing', async () => {
  const net = network(current => { current.socket(50000).receive(announcement('192.0.2.50', 1), '192.0.2.50'); current.socket(50000).receive(announcement('192.0.2.60', 5, 'rekordbox'), '192.0.2.60'); });
  const state = store(), errors: Error[] = [], source = await startLive(state, { ...options, onError: error => errors.push(error) }, net.services);
  try {
    assert.deepEqual(new Set(net.sends.map(value => value.address)), new Set([iface.broadcast, '192.0.2.50']));
    assert.ok(net.sends.every(value => value.bytes[0x24] === 6 && value.bytes[10] === 6));
    net.socket(50000).receive(announcement('192.0.2.61', 6, 'rekordbox'), '192.0.2.61'); await turn();
    assert.equal(errors.length, 1); assert.ok(net.sockets.every(socket => socket.closed));
  } finally { await source.close(); }
  const busy = network(current => { for (const wire of [5, 6]) current.socket(50000).receive(announcement(`192.0.2.${wire + 60}`, wire, 'rekordbox'), `192.0.2.${wire + 60}`); });
  await assert.rejects(startLive(store(), options, busy.services)); assert.equal(busy.sends.length, 0); assert.ok(busy.sockets.every(socket => socket.closed));
});

test('AZ audit: wrong or mixed player LANs are rejected before presence and never receive a fallback claim', async () => {
  for (const models of [['CDJ-3000'], ['XDJ-RX3'], ['XDJ-AZ', 'CDJ-3000']]) {
    const net = network(current => models.forEach((model, index) => current.socket(50000).receive(announcement(`192.0.2.${50 + index}`, index + 1, model), `192.0.2.${50 + index}`)));
    await assert.rejects(startLive(store(), options, net.services)); assert.equal(net.sends.length, 0); assert.ok(net.sockets.every(socket => socket.closed));
  }
});

test('AZ audit: only guarded AZ status creates four unverified decks, independent OSC routes and unknown metadata', async () => {
  const net = network(), state = store(), source = await startLive(state, options, net.services);
  try {
    for (const wire of [4, 2, 1, 3]) net.socket(50002).receive(status(wire), '192.0.2.50');
    const before = state.snapshot(); assert.equal(before.decks.length, 4);
    net.socket(50002).receive(status(3, 'CDJ-3000'), '192.0.2.51');
    net.socket(50002).receive(status(3), '198.51.100.50');
    const unknown = status(3); unknown[0x20] = 0xfe; net.socket(50002).receive(unknown, '192.0.2.50');
    net.socket(50002).receive(status(3).subarray(0, 0xcb), '192.0.2.50');
    const current = state.snapshot(); assert.deepEqual(current.decks, before.decks);
    assert.deepEqual(current.decks.map(deck => deck.publicDeckId).sort(), ['1', '2', '3', '4']);
    for (const deck of current.decks) {
      assert.equal(deck.title.value, null); assert.equal(deck.artist.value, null); assert.equal(deck.onAir.value, null);
      assert.equal(deck.capabilities.status.verification, 'implemented-unverified');
      assert.equal(snapshotToOsc(current).find(message => message.address === `/dj/decks/${deck.publicDeckId}/bpm/valid`)?.args[0], 1);
    }
    assert.ok(current.diagnostics.some(value => value.message.includes('1.23') && value.message.includes('1.30')));
  } finally { await source.close(); }
  assert.ok(state.snapshot().decks.every(deck => deck.playbackState.freshness === 'stale'));
  for (const wire of [1, 2, 3, 4]) assert.equal(snapshotToOsc(state.snapshot()).find(message => message.address === `/dj/decks/${wire}/bpm/valid`)?.args[0], 0);
});

test('AZ audit: reentrant close waits for every receiver and the extra ephemeral sender to release ownership', async () => {
  const net = network(), abort = new AbortController(), source = await startLive(store(), { ...options, signal: abort.signal }, net.services);
  for (const socket of net.sockets) socket.holdClose = true;
  abort.abort(); let finished = false;
  const closing = source.close().then(() => { finished = true; });
  try {
    await turn(); assert.equal(net.sockets.length, 4); assert.ok(net.sockets.every(socket => socket.closeCallback));
    for (const socket of net.sockets.filter(value => value.port !== 0)) socket.closeCallback!();
    await turn(); assert.equal(finished, false, 'the extra sender is part of the same ownership boundary');
    net.socket(0).closeCallback!(); await closing; assert.equal(finished, true);
  } finally { for (const socket of net.sockets) socket.closeCallback?.(); await closing; }
});

test('AZ audit: cancellation during RX or ephemeral-TX bind releases ownership without waiting for a lost listening callback', async () => {
  for (const blockIndex of [1, 3]) {
    const net = network(); net.blockIndex = blockIndex; const abort = new AbortController();
    let settled = false;
    const result = startLive(store(), { ...options, signal: abort.signal }, net.services).then(value => { settled = true; return value; }, error => { settled = true; return error as Error; });
    try {
      await turn(); assert.equal(net.sockets.length, blockIndex + 1); abort.abort(); await turn();
      assert.equal(settled, true, 'closing a socket can remove its pending bind callback; startup must reject on abort');
      assert.ok(net.sockets.every(socket => socket.closed)); assert.equal(net.sends.length, 0);
    } finally { for (const socket of net.sockets) socket.ready?.(); const value = await result; if (!(value instanceof Error)) await value.close(); }
  }
});

test('AZ audit: cancellation during the first send cannot create a new heartbeat after all four sockets closed', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const net = network(); net.holdSends = true; const abort = new AbortController();
  const starting = startLive(store(), { ...options, signal: abort.signal }, net.services);
  const outcome = starting.then(value => value, error => error as Error);
  try {
    await turn(); assert.equal(net.sends.length, 1); abort.abort(); await turn();
    for (const socket of net.sockets) for (const callback of socket.sendCallbacks.splice(0)) callback();
    assert.ok(await outcome instanceof Error); assert.ok(net.sockets.every(socket => socket.closed));
    t.mock.timers.tick(6000); await turn(); assert.equal(net.sends.length, 1);
  } finally { for (const socket of net.sockets) for (const callback of socket.sendCallbacks.splice(0)) callback(); const value = await outcome; if (!(value instanceof Error)) await value.close(); t.mock.timers.reset(); }
});

test('AZ audit: protected JSON mode selection preserves old connection on invalid input and never silently falls back', async () => {
  const config = await parseConfig([]); let calls: string[] = [], closes = 0;
  const runtime = new RuntimeController(config, {
    listInterfaces: () => [iface],
    async startLive(_store, value) { calls.push(value.mode); if (value.mode === 'az-standalone') throw new Error('Synthetic FW1.23 trial failure'); return { async close() { closes++; } }; },
  });
  const server = await startServer(runtime, { host: '127.0.0.1', port: 0, controls: runtime, runtime: () => runtime.getRuntime() });
  const selection = { action: 'connect', backend: 'native', interfaceName: iface.name, profile: 'xdj-az', mode: 'az-standalone' };
  const post = (body: unknown, headers = {}) => fetch(server.url + '/api/connection', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    await runtime.connect({ ...selection, mode: 'virtual-device' }); await turn(); const original = runtime.snapshot().session.id;
    assert.equal((await post({ ...selection, profile: 'xdj-rx3' })).status, 400);
    assert.equal((await post({ ...selection, backend: 'alphatheta' })).status, 400);
    assert.equal((await post(selection, { Origin: 'https://foreign.invalid' })).status, 403);
    assert.equal((await post(selection, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post({ ...selection, padding: 'x'.repeat(5000) })).status, 413);
    assert.equal(runtime.snapshot().session.id, original); assert.equal(closes, 0);
    assert.equal((await post(selection)).status, 200); await turn();
    assert.deepEqual(calls, ['virtual-device', 'az-standalone']); assert.equal(closes, 1);
    assert.equal(runtime.getRuntime().connection.mode, 'az-standalone'); assert.match(runtime.getRuntime().connection.error!, /1\.23/);
    assert.equal(runtime.getRuntime().osc.enabled, false); assert.equal(runtime.getRuntime().notifications.enabled, false);
  } finally { await runtime.close(); await server.close(); }
});

test('AZ audit: the real UI keeps the trial an explicit native-only action and never changes a conflicting profile automatically', async () => {
  const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8'), script = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
  const { document, window } = parseHTML(html);
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', { configurable: true,
    get() { const values = [...this.querySelectorAll('option')]; return (values.find(option => option.selected) ?? values[0])?.value ?? ''; },
    set(value) { for (const option of [...this.querySelectorAll('option')]) { option.removeAttribute('selected'); if (option.value === value) option.setAttribute('selected', ''); } },
  });
  const dialog: any = document.getElementById('settings-drawer'); dialog.showModal = () => {}; dialog.close = () => {}; dialog.getBoundingClientRect = () => ({ left: 0, right: 500, top: 0, bottom: 800 });
  let current: any = { connection: { mode: 'idle', backend: 'native', profile: 'auto', interfaceName: iface.name, connected: false, connecting: false, error: null },
    interfaces: [iface], osc: { enabled: false, host: '127.0.0.1', port: 9000, maxHz: 20, snapshotIntervalMs: 1000 },
    notifications: { enabled: false, supported: false, error: null }, discovery: { searching: false, attempted: false, source: 'session', interfaceName: null, devices: [], error: null } };
  const posts: any[] = [];
  class FakeWebSocket { addEventListener() {} send() {} close() {} }
  vm.runInContext(script, vm.createContext({ document, location: { protocol: 'http:', host: '127.0.0.1:8080' }, WebSocket: FakeWebSocket,
    performance: { now: () => 0 }, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, addEventListener() {},
    fetch: async (_url: string, settings: any = {}) => { if (settings.method === 'POST') { const value = JSON.parse(settings.body); posts.push(value); current = { ...current, connection: { ...current.connection, ...value, connecting: true } }; } return { ok: true, json: async () => structuredClone(current) }; },
  }));
  await turn(); const method: any = document.getElementById('method-select'), profile: any = document.getElementById('device-select'), form: any = document.getElementById('connection-form'), button: any = document.getElementById('connect-button');
  method.value = 'az-standalone'; method.dispatchEvent(new window.Event('change', { bubbles: true }));
  profile.value = 'xdj-az'; profile.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(posts.length, 0); assert.equal(button.disabled, false); assert.match(document.getElementById('connection-hint')!.textContent!, /OFF.*未検証/);
  profile.value = 'xdj-rx3'; profile.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(button.disabled, true); assert.equal(profile.value, 'xdj-rx3'); assert.equal(posts.length, 0);
  profile.value = 'xdj-az'; profile.dispatchEvent(new window.Event('change', { bubbles: true })); form.reportValidity = () => true;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await turn();
  assert.equal(posts.length, 1); assert.equal(posts[0].mode, 'az-standalone'); assert.equal(posts[0].backend, 'native'); assert.equal(posts[0].profile, 'xdj-az');
});
