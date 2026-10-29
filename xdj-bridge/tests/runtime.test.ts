import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import type { AppConfig } from '../src/config.js';
import type { StateStore } from '../src/core/store.js';
import type { Snapshot, StateSource } from '../src/core/types.js';
import { snapshotToOsc, type OscOptions } from '../src/output/osc.js';
import { startServer } from '../src/output/server.js';
import { RuntimeController, RuntimeError, type RuntimeServices } from '../src/runtime.js';
import type { LiveOptions, SelectedInterface } from '../src/transport/live.js';

const config = (changes: Partial<AppConfig> = {}): AppConfig => ({ mode: 'passive', backend: 'native', interfaceName: 'en6', profile: 'auto', speed: 1, loop: false, host: '127.0.0.1', port: 0, staleAfterMs: 3000, publicDeckIds: {}, ...changes });
const interfaces = (): SelectedInterface[] => [
  { name: 'en6', address: '169.254.77.195', netmask: '255.255.0.0', family: 'IPv4', mac: '00:11:22:33:44:55', internal: false, cidr: '169.254.77.195/16', broadcast: '169.254.255.255' },
  { name: 'en0', address: '192.168.42.2', netmask: '255.255.255.0', family: 'IPv4', mac: '00:11:22:33:44:66', internal: false, cidr: '192.168.42.2/24', broadcast: '192.168.42.255' },
];
const selection = (changes = {}) => ({ mode: 'virtual-device', backend: 'native', interfaceName: 'en6', profile: 'xdj-rx3', ...changes });
const oscSettings = (changes = {}) => ({ enabled: true, host: '127.0.0.1', port: 9000, maxHz: 30, snapshotIntervalMs: 1000, ...changes });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function ingest(store: StateStore, interfaceName = 'en6', receivedAt = 0, trackId = 70) {
  const az = interfaceName === 'en0';
  store.ingestStatus({ sessionId: store.snapshot().session.id, interfaceId: interfaceName, sourceIp: az ? '192.168.42.10' : '169.254.95.63', receivedAt,
    wireDeviceId: az ? 1 : 11, model: az ? 'XDJ-AZ' : 'XDJ-RX3', trackId, sourceWireDeviceId: az ? 1 : 11, protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 122, pitchPercent: -8.5 });
}
function fakeServices(overrides: Partial<RuntimeServices> = {}) {
  const starts: { store: StateStore; options: LiveOptions }[] = [];
  const captures: { store: StateStore; iface: string }[] = [];
  const closed: StateStore[] = [];
  const services: Partial<RuntimeServices> = {
    listInterfaces: interfaces,
    async startLive(store, options) { starts.push({ store, options }); ingest(store, options.interfaceName); return { async close() { closed.push(store); } }; },
    async startCapture(store, iface) { captures.push({ store, iface }); ingest(store, iface); return { async close() { closed.push(store); } }; },
    startOsc() { return { async close() {} }; },
    ...overrides,
  };
  return { starts, captures, closed, services };
}

test('runtime applies selected model/interface/mode to real session creation and exposes current settings', async () => {
  const fake = fakeServices(); const runtime = new RuntimeController(config(), fake.services);
  try {
    await runtime.initialize(); await turn();
    assert.equal(fake.starts[0].options.interfaceName, 'en6'); assert.equal(fake.starts[0].options.mode, 'passive');
    assert.equal(runtime.getRuntime().connection.connected, true);
    const firstSession = runtime.snapshot().session.id;
    await runtime.connect(selection({ interfaceName: 'en0', profile: 'xdj-az' })); await turn();
    assert.equal(fake.closed.length, 1); assert.equal(fake.starts.length, 2);
    assert.equal(fake.starts[1].options.mode, 'virtual-device'); assert.equal(fake.starts[1].options.interfaceName, 'en0');
    assert.notEqual(runtime.snapshot().session.id, firstSession); assert.equal(runtime.snapshot().decks[0].profile, 'xdj-az');
    assert.equal(runtime.snapshot().session.interfaceId, 'en0');
    assert.deepEqual(runtime.getRuntime().connection, { mode: 'virtual-device', backend: 'native', interfaceName: 'en0', profile: 'xdj-az', connected: true, connecting: false, error: null });
    assert.deepEqual(runtime.getRuntime().interfaces.map(x => x.name), ['en6', 'en0']);
    await runtime.connect(selection({ mode: 'passive', backend: 'alphatheta' })); await turn();
    assert.equal(fake.captures.length, 1); assert.equal(fake.captures[0].iface, 'en6');
    assert.equal(runtime.getRuntime().connection.backend, 'alphatheta');
  } finally { await runtime.close(); }
});

test('runtime waits for a late aborted startup and its close before starting the next source', async () => {
  const firstStart = deferred<{ close(): Promise<void> }>(); const firstClose = deferred<void>();
  const calls: { store: StateStore; options: LiveOptions }[] = []; const events: string[] = [];
  const fake = fakeServices({ async startLive(store, options) {
    calls.push({ store, options }); events.push('start:' + options.interfaceName);
    if (calls.length === 1) return firstStart.promise;
    ingest(store, options.interfaceName); return { async close() { events.push('close:second'); } };
  } });
  const runtime = new RuntimeController(config(), fake.services);
  try {
    await runtime.connect(selection()); await turn(); assert.equal(calls.length, 1); assert.equal(runtime.getRuntime().connection.connecting, true);
    const switching = runtime.connect(selection({ interfaceName: 'en0', profile: 'xdj-az' })); await turn();
    assert.equal(calls[0].options.signal?.aborted, true); assert.equal(calls.length, 1);
    firstStart.resolve({ async close() { events.push('close:first:begin'); await firstClose.promise; events.push('close:first:end'); } });
    await turn(); assert.equal(calls.length, 1); assert.ok(events.includes('close:first:begin'));
    firstClose.resolve(); await switching; await turn();
    assert.deepEqual(events.slice(0, 4), ['start:en6', 'close:first:begin', 'close:first:end', 'start:en0']);
    assert.equal(runtime.getRuntime().connection.connected, true); assert.equal(runtime.snapshot().session.interfaceId, 'en0');
  } finally { firstClose.resolve(); firstStart.resolve({ async close() {} }); await runtime.close(); }
});

test('runtime disconnect stops an in-flight connection and rejects simultaneous setting changes', async () => {
  const startup = deferred<{ close(): Promise<void> }>(); let oldClose = 0; let signal: AbortSignal | undefined;
  const fake = fakeServices({ async startLive(_store, options) { signal = options.signal; return startup.promise; } });
  const runtime = new RuntimeController(config(), fake.services);
  try {
    await runtime.connect(selection()); await turn();
    const disconnecting = runtime.disconnect(); await turn(); assert.equal(signal?.aborted, true);
    await assert.rejects(runtime.connect(selection({ interfaceName: 'en0' })), error => error instanceof RuntimeError && error.status === 409);
    await assert.rejects(runtime.setOsc(oscSettings()), error => error instanceof RuntimeError && error.status === 409);
    startup.resolve({ async close() { oldClose++; } }); await disconnecting;
    assert.equal(oldClose, 1); assert.equal(runtime.getRuntime().connection.connected, false); assert.equal(runtime.getRuntime().connection.connecting, false);
    assert.equal(runtime.snapshot().session.state, 'disconnected');
  } finally { startup.resolve({ async close() {} }); await runtime.close(); }
});

test('runtime source replacement ignores late packets and errors from the previous session', async () => {
  const fake = fakeServices(); const runtime = new RuntimeController(config(), fake.services); const updates: Snapshot[] = [];
  const unsubscribe = runtime.subscribe(s => updates.push(s));
  try {
    await runtime.initialize(); await turn(); const first = fake.starts[0]; const oldSession = runtime.snapshot().session.id;
    await runtime.connect(selection({ interfaceName: 'en0', profile: 'xdj-az' })); await turn();
    const current = runtime.snapshot(); const count = updates.length;
    ingest(first.store, 'en6', 500, 999); first.options.onError?.(new Error('late old failure')); await turn();
    assert.notEqual(current.session.id, oldSession); assert.equal(runtime.snapshot().session.id, current.session.id);
    assert.equal(runtime.snapshot().decks[0].trackRef?.trackId, 70); assert.equal(updates.length, count);
    assert.equal(runtime.getRuntime().connection.error, null); assert.ok(updates.some(s => s.session.id === oldSession));
    assert.ok(updates.some(s => s.session.id === current.session.id));
  } finally { unsubscribe(); await runtime.close(); }
});

test('runtime rejects invalid connection and OSC inputs without stopping the active session', async () => {
  let outputCloses = 0;
  const fake = fakeServices({ startOsc() { return { async close() { outputCloses++; } }; } });
  const runtime = new RuntimeController(config({ osc: oscSettings() }), fake.services);
  try {
    await runtime.initialize(); await turn(); const session = runtime.snapshot().session.id;
    for (const value of [null, [], {}, selection({ interfaceName: 'missing' }), selection({ profile: 'wrong' }), selection({ backend: 'alphatheta' }), selection({ interfaceName: 6 })]) {
      await assert.rejects(runtime.connect(value), error => error instanceof RuntimeError && error.status === 400);
    }
    for (const value of [null, [], {}, oscSettings({ enabled: 'false' }), oscSettings({ port: '9000' }), oscSettings({ port: 0 }), oscSettings({ maxHz: 0 }), oscSettings({ host: 'bad/path' })]) {
      await assert.rejects(runtime.setOsc(value), error => error instanceof RuntimeError && error.status === 400);
    }
    assert.equal(runtime.snapshot().session.id, session); assert.equal(runtime.getRuntime().connection.connected, true);
    assert.equal(fake.closed.length, 0); assert.equal(outputCloses, 0);
  } finally { await runtime.close(); }
});

test('runtime sends valid=0 to an old OSC destination and closes it before starting its replacement', async () => {
  const closing = deferred<void>();
  const outputs: { source: StateSource; options: OscOptions; final?: Snapshot }[] = []; const events: string[] = [];
  const fake = fakeServices({ startOsc(source, options) {
    const entry: { source: StateSource; options: OscOptions; final?: Snapshot } = { source, options }; outputs.push(entry); events.push('start:' + options.port);
    return { async close() { entry.final = source.snapshot(); events.push('close:' + options.port); if (options.port === 9000) await closing.promise; } };
  } });
  const runtime = new RuntimeController(config({ osc: oscSettings() }), fake.services);
  try {
    await runtime.initialize(); await turn(); const session = runtime.snapshot().session.id;
    assert.equal(snapshotToOsc(outputs[0].source.snapshot()).find(m => m.address === '/dj/decks/1/bpm/valid')?.args[0], 1);
    const changing = runtime.setOsc(oscSettings({ host: 'localhost', port: 9001, maxHz: 60 })); await turn();
    assert.equal(outputs.length, 1); assert.equal(outputs[0].final?.session.state, 'disconnected');
    assert.equal(snapshotToOsc(outputs[0].final!).find(m => m.address === '/dj/decks/1/bpm/valid')?.args[0], 0);
    assert.equal(runtime.snapshot().decks[0].trackBpm.freshness, 'fresh'); assert.equal(runtime.snapshot().session.id, session);
    closing.resolve(); await changing;
    assert.deepEqual(events, ['start:9000', 'close:9000', 'start:9001']);
    assert.equal(outputs[1].options.maxHz, 60); assert.equal(outputs[1].options.host, 'localhost');
    assert.equal(snapshotToOsc(outputs[1].source.snapshot()).find(m => m.address === '/dj/decks/1/bpm/valid')?.args[0], 1);
    assert.equal(runtime.getRuntime().osc.port, 9001);
    await runtime.setOsc(oscSettings({ enabled: false, port: 9001 }));
    assert.equal(outputs.length, 2); assert.equal(runtime.getRuntime().osc.enabled, false);
    assert.equal(snapshotToOsc(outputs[1].final!).find(m => m.address === '/dj/decks/1/bpm/valid')?.args[0], 0);
  } finally { closing.resolve(); await runtime.close(); }
});

test('runtime reports startup failure while keeping the application available for retry', async () => {
  let fail = true;
  const fake = fakeServices({ async startLive(store, options) { if (fail) throw new Error('UDP port busy'); ingest(store, options.interfaceName); return { async close() {} }; } });
  const runtime = new RuntimeController(config(), fake.services);
  try {
    await runtime.initialize(); await turn(); assert.equal(runtime.getRuntime().connection.connected, false);
    assert.match(runtime.getRuntime().connection.error!, /UDP port busy/); assert.equal(runtime.snapshot().session.state, 'degraded');
    fail = false; await runtime.connect(selection()); await turn();
    assert.equal(runtime.getRuntime().connection.connected, true); assert.equal(runtime.getRuntime().connection.error, null);
  } finally { const closing = runtime.close(); assert.equal(runtime.close(), closing); await closing; }
  await assert.rejects(runtime.connect(selection()), error => error instanceof RuntimeError && error.status === 503);
});

test('HTTP controls validate JSON/origin/size/status and return live runtime settings', async () => {
  const fake = fakeServices(); const runtime = new RuntimeController(config(), fake.services);
  const server = await startServer(runtime, { port: 0, runtime: () => runtime.getRuntime(), controls: runtime });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const connected = await post('/api/connection', { action: 'connect', ...selection() });
    assert.equal(connected.status, 200); assert.equal((await connected.json() as { connection: { interfaceName: string } }).connection.interfaceName, 'en6'); await turn();
    assert.equal((await post('/api/osc', oscSettings())).status, 200);
    const status = await (await fetch(server.url + '/api/runtime')).json() as { osc: { enabled: boolean; port: number } };
    assert.equal(status.osc.enabled, true); assert.equal(status.osc.port, 9000);
    assert.equal((await post('/api/connection', { action: 'wrong' })).status, 400);
    assert.equal((await post('/api/connection', { action: 'connect', ...selection({ profile: 4 }) })).status, 400);
    assert.equal((await post('/api/osc', oscSettings(), { Origin: 'https://example.invalid' })).status, 403);
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const req = request(server.url + '/api/osc', { method: 'POST', headers: { Host: 'example.invalid', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end(JSON.stringify(oscSettings()));
    });
    assert.equal(foreignHost, 403);
    assert.equal((await fetch(server.url + '/api/osc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(server.url + '/api/osc', { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await post('/api/osc', { padding: 'x'.repeat(5000) })).status, 413);
    // Transfer-encoding/chunked must enforce the same bound without Content-Length.
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = request(server.url + '/api/osc', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.write('{"padding":"'); req.write('x'.repeat(5000)); req.end('"}');
    });
    assert.equal(chunked, 413);
    assert.equal((await fetch(server.url + '/api/osc', { method: 'PUT' })).status, 405);
    assert.equal((await post('/api/connection', { action: 'disconnect' })).status, 200);
    assert.equal(runtime.getRuntime().connection.connected, false);
  } finally { await runtime.close(); await server.close(); }
});

test('HTTP controls return 409 during changes and 503 after shutdown', async () => {
  const release = deferred<void>(); let closingSource = false;
  const fake = fakeServices({ async startLive(store, options) {
    ingest(store, options.interfaceName);
    return { async close() { closingSource = true; await release.promise; } };
  } });
  const runtime = new RuntimeController(config(), fake.services);
  const server = await startServer(runtime, { port: 0, runtime: () => runtime.getRuntime(), controls: runtime });
  let switching: Promise<void> | undefined;
  try {
    await runtime.initialize(); await turn();
    switching = runtime.connect(selection({ interfaceName: 'en0', profile: 'xdj-az' })); await turn(); assert.equal(closingSource, true);
    const post = (path: string, body: unknown) => fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: server.url }, body: JSON.stringify(body) });
    const conflict = await post('/api/connection', { action: 'disconnect' }); assert.equal(conflict.status, 409);
    assert.equal(typeof (await conflict.json() as { error: unknown }).error, 'string');
    assert.equal((await post('/api/osc', oscSettings())).status, 409);
    release.resolve(); await switching; await turn(); await runtime.close();
    assert.equal((await post('/api/connection', { action: 'connect', ...selection() })).status, 503);
  } finally { release.resolve(); await switching; await runtime.close(); await server.close(); }
});

test('WebSocket consumers receive a complete snapshot when a device switch creates a new session', async () => {
  const fake = fakeServices(); const runtime = new RuntimeController(config(), fake.services);
  const server = await startServer(runtime, { port: 0, runtime: () => runtime.getRuntime(), controls: runtime });
  const ws = new WebSocket(server.url.replace('http:', 'ws:') + '/ws');
  const received: { type: string; session: { id: string }; decks: { model: string }[] }[] = [];
  ws.on('message', bytes => received.push(JSON.parse(bytes.toString())));
  const waitFor = async (predicate: () => boolean) => {
    const deadline = performance.now() + 1000;
    while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'Expected WebSocket state was not received');
  };
  try {
    await waitFor(() => received.length > 0); assert.equal(received[0].type, 'snapshot');
    await runtime.initialize(); await turn(); const oldSession = runtime.snapshot().session.id;
    await waitFor(() => received.some(s => s.session.id === oldSession && s.decks.some(d => d.model === 'XDJ-RX3')));
    await runtime.connect(selection({ interfaceName: 'en0', profile: 'xdj-az' })); await turn(); const currentSession = runtime.snapshot().session.id;
    await waitFor(() => received.some(s => s.session.id === currentSession && s.decks.some(d => d.model === 'XDJ-AZ')));
    const firstNew = received.find(s => s.session.id === currentSession)!;
    assert.notEqual(currentSession, oldSession); assert.equal(firstNew.type, 'snapshot');
    assert.equal(runtime.snapshot().decks.some(d => d.model === 'XDJ-RX3'), false);
    const count = received.length; ingest(fake.starts[0].store, 'en6', 900, 999); await turn();
    assert.equal(received.length, count);
  } finally { ws.terminate(); await runtime.close(); await server.close(); }
});
