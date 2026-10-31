import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { parseConfig } from '../src/config.js';
import { StateStore } from '../src/core/store.js';
import { snapshotToOsc } from '../src/output/osc.js';
import { startServer } from '../src/output/server.js';
import { RuntimeController, RuntimeError } from '../src/runtime.js';
import type { DiscoveryOptions, LiveOptions, SelectedInterface } from '../src/transport/live.js';

const interfaces = (): SelectedInterface[] => [
  { name: 'lan0', address: '192.0.2.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:11:22:33:44:55', internal: false, cidr: '192.0.2.20/24', broadcast: '192.0.2.255' },
  { name: 'lan1', address: '198.51.100.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:11:22:33:44:66', internal: false, cidr: '198.51.100.20/24', broadcast: '198.51.100.255' },
];
const selection = (changes = {}) => ({ mode: 'virtual-device', backend: 'native', interfaceName: 'lan0', profile: 'auto', ...changes });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
};
const observe = (store: StateStore, ip = '192.0.2.50', wire = 1) => store.observeDevice({ model: 'CDJ-3000', sourceIp: ip, wireDeviceId: wire, interfaceId: 'lan0', interfaceEvidence: 'subnet', receivedAt: 0 });
const status = (store: StateStore, iface = 'lan0') => store.ingestStatus({ interfaceId: iface, sourceIp: iface === 'lan0' ? '192.0.2.50' : '198.51.100.50', receivedAt: 0, wireDeviceId: 1, model: 'CDJ-3000', trackId: 70, sourceWireDeviceId: 1, protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 122, pitchPercent: 0 });

test('standalone discovery returns while searching and keeps session, OSC and notifications unchanged', async () => {
  const complete = deferred<void>(); let scan: StateStore | undefined; let outputCloses = 0, sends = 0, participants = 0;
  const config = await parseConfig([]); config.osc = { enabled: true, host: '127.0.0.1', port: 9000 }; config.notifications = { enabled: true };
  const runtime = new RuntimeController(config, {
    listInterfaces: interfaces,
    async discoverDevices(store) { scan = store; await complete.promise; },
    async startLive() { participants++; throw new Error('No participant should be started'); },
    startOsc() { return { async close() { outputCloses++; } }; },
    notificationSender: { supported: true, async send() { sends++; } },
  });
  try {
    await runtime.initialize(); const before = runtime.snapshot();
    assert.equal(runtime.getRuntime().discovery.attempted, false);
    await runtime.discover({ interfaceName: 'lan0' });
    assert.equal(runtime.getRuntime().discovery.searching, true); assert.ok(scan);
    observe(scan!); observe(scan!, '192.0.2.51', 1);
    const discovery = runtime.getRuntime().discovery;
    assert.equal(discovery.source, 'scan'); assert.equal(discovery.attempted, true); assert.equal(discovery.devices.length, 2);
    assert.ok(discovery.devices.every(value => value.ageMs >= 0 && value.status === 'announced'));
    assert.deepEqual(runtime.snapshot(), before); assert.equal(snapshotToOsc(runtime.snapshot()).some(m => m.address.includes('/decks/')), false);
    await assert.rejects(runtime.connect(selection()), error => error instanceof RuntimeError && error.status === 409);
    assert.equal(participants, 0); assert.equal(outputCloses, 0); assert.equal(sends, 0);
    complete.resolve(); await turn(); assert.equal(runtime.getRuntime().discovery.searching, false);
    assert.equal(runtime.getRuntime().discovery.devices.length, 2);
  } finally { complete.resolve(); await runtime.close(); }
});

test('an existing healthy LAN session is tapped without opening or stopping sources and other LAN is rejected', async () => {
  let scanCalls = 0, sourceCloses = 0, outputCloses = 0; let original: StateStore | undefined;
  const config = await parseConfig([]); config.osc = { enabled: true, host: '127.0.0.1', port: 9000 };
  const runtime = new RuntimeController(config, {
    listInterfaces: interfaces,
    async startLive(store, options) { original = store; status(store, options.interfaceName); return { async close() { sourceCloses++; } }; },
    async discoverDevices() { scanCalls++; },
    startOsc() { return { async close() { outputCloses++; } }; },
  });
  try {
    await runtime.connect(selection()); await turn(); const before = runtime.snapshot(); const outputsBefore = outputCloses;
    await assert.rejects(runtime.discover({ interfaceName: 'lan1' }), error => error instanceof RuntimeError && error.status === 409);
    await runtime.discover({ interfaceName: 'lan0' });
    assert.equal(runtime.getRuntime().discovery.source, 'session'); assert.equal(runtime.getRuntime().discovery.searching, true);
    assert.deepEqual(runtime.snapshot(), before); assert.equal(sourceCloses, 0); assert.equal(outputCloses, outputsBefore); assert.equal(scanCalls, 0);
    observe(original!, '192.0.2.51', 2);
    assert.equal(runtime.getRuntime().discovery.devices.length, 2); assert.equal(runtime.getRuntime().connection.connected, true);
    assert.deepEqual(snapshotToOsc(runtime.snapshot()).find(m => m.address === '/dj/decks/1/bpm/valid')?.args, [1]);
  } finally { await runtime.close(); }
});

test('discovery after a failed source waits for release before opening a standalone receiver', async () => {
  const release = deferred<void>(); let live: LiveOptions | undefined; let closeStarted = false, scans = 0;
  const runtime = new RuntimeController(await parseConfig([]), {
    listInterfaces: interfaces,
    async startLive(store, options) { live = options; status(store); return { async close() { closeStarted = true; await release.promise; } }; },
    async discoverDevices(store) { assert.equal(closeStarted, true); scans++; observe(store); },
  });
  try {
    await runtime.connect(selection()); await turn(); live!.onError!(new Error('Network source failed'));
    const scanning = runtime.discover({ interfaceName: 'lan0' }); await turn();
    assert.equal(closeStarted, true); assert.equal(scans, 0);
    release.resolve(); await scanning; await turn();
    assert.equal(scans, 1); assert.equal(runtime.getRuntime().discovery.source, 'scan');
    assert.equal(runtime.getRuntime().discovery.devices.length, 1); assert.equal(runtime.getRuntime().connection.connected, false);
  } finally { release.resolve(); await runtime.close(); }
});

test('invalid discovery does not disturb a source; errors can be retried and new connection replaces old scan results', async () => {
  let scanCalls = 0;
  const runtime = new RuntimeController(await parseConfig([]), {
    listInterfaces: interfaces,
    async discoverDevices(store) { if (scanCalls++ === 0) throw new Error('UDP 50000 busy'); observe(store); },
    async startLive(store, options) { status(store, options.interfaceName); return { async close() {} }; },
  });
  try {
    const session = runtime.snapshot().session.id;
    for (const input of [null, [], {}, { interfaceName: 1 }, { interfaceName: 'missing' }]) await assert.rejects(runtime.discover(input));
    assert.equal(runtime.snapshot().session.id, session); assert.equal(scanCalls, 0);
    await runtime.discover({ interfaceName: 'lan0' }); await turn(); assert.match(runtime.getRuntime().discovery.error!, /busy/);
    await runtime.discover({ interfaceName: 'lan0' }); await turn(); assert.equal(runtime.getRuntime().discovery.error, null);
    assert.equal(runtime.getRuntime().discovery.devices[0].sourceIp, '192.0.2.50');
    await runtime.connect(selection({ interfaceName: 'lan1' })); await turn();
    assert.equal(runtime.getRuntime().discovery.source, 'session'); assert.equal(runtime.getRuntime().discovery.interfaceName, 'lan1');
    assert.deepEqual(runtime.getRuntime().discovery.devices.map(device => device.sourceIp), ['198.51.100.50']);
  } finally { await runtime.close(); }
});

test('queued discovery cannot open a socket after close begins and active scan abort is awaited', async () => {
  let scanCalls = 0;
  const runtime = new RuntimeController(await parseConfig([]), { listInterfaces: interfaces, async discoverDevices() { scanCalls++; } });
  const scan = runtime.discover({ interfaceName: 'lan0' }); const close = runtime.close();
  await assert.rejects(scan, error => error instanceof RuntimeError && error.status === 503); await close; assert.equal(scanCalls, 0);
  const release = deferred<void>(); let scanSignal: AbortSignal | undefined;
  const active = new RuntimeController(await parseConfig([]), { listInterfaces: interfaces, async discoverDevices(_store, options) { scanSignal = options.signal; await release.promise; } });
  await active.discover({ interfaceName: 'lan0' }); const closing = active.close();
  assert.equal(scanSignal?.aborted, true); let finished = false; void closing.then(() => { finished = true; });
  await turn(); assert.equal(finished, false); release.resolve(); await closing; assert.equal(finished, true);
});

test('discovery JSON controls preserve protections and live catalogs are included in WS deltas', async () => {
  const complete = deferred<void>();
  const runtime = new RuntimeController(await parseConfig([]), { listInterfaces: interfaces, async discoverDevices(store) { observe(store); await complete.promise; } });
  const server = await startServer(runtime, { port: 0, runtime: () => runtime.getRuntime(), controls: runtime });
  try {
    const post = (body: unknown, headers = {}) => fetch(server.url + '/api/discovery', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const response = await post({ interfaceName: 'lan0' }); assert.equal(response.status, 200);
    const json = await response.json() as { discovery: { searching: boolean; devices: unknown[] } };
    assert.equal(json.discovery.searching, true); assert.equal(json.discovery.devices.length, 1);
    assert.equal((await post({ interfaceName: 'lan0' })).status, 409);
    assert.equal((await post({ interfaceName: 'lan0' }, { Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await post({ padding: 'x'.repeat(5000) })).status, 413);
    assert.equal((await post({ interfaceName: null })).status, 400);
  } finally { complete.resolve(); await runtime.close(); await server.close(); }
  const store = new StateStore({ sessionId: 'ws-discovery', mode: 'passive' });
  const live = await startServer(store, { port: 0 }); const ws = new WebSocket(live.url.replace('http:', 'ws:') + '/ws');
  try {
    await once(ws, 'message'); const next = once(ws, 'message'); observe(store);
    const [bytes] = await next; const delta = JSON.parse(bytes.toString());
    assert.equal(delta.type, 'delta'); assert.equal(delta.devices[0].model, 'CDJ-3000'); assert.deepEqual(delta.decks, []);
  } finally { ws.terminate(); await live.close(); }
});
