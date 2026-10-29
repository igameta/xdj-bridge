import assert from 'node:assert/strict';
import dgram, { type Socket } from 'node:dgram';
import os from 'node:os';
import { EventEmitter, once } from 'node:events';
import { request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
import { StateStore } from '../src/core/store.js';
import type { Snapshot, StateSource } from '../src/core/types.js';
import { decodeOscPacket, snapshotToOsc, type OscOptions } from '../src/output/osc.js';
import { startServer } from '../src/output/server.js';
import { RuntimeController } from '../src/runtime.js';
import { startLive, type SelectedInterface } from '../src/transport/live.js';

const iface: SelectedInterface = { name: 'audit0', address: '192.0.2.20', netmask: '255.255.255.0',
  family: 'IPv4', mac: '00:11:22:33:44:55', internal: false, cidr: '192.0.2.20/24', broadcast: '192.0.2.255' };
const config = (changes: Partial<AppConfig> = {}): AppConfig => ({ mode: 'passive', backend: 'native', interfaceName: 'audit0',
  profile: 'auto', speed: 1, loop: false, host: '127.0.0.1', port: 0, staleAfterMs: 3000, publicDeckIds: {}, ...changes });
const selection = { mode: 'passive', backend: 'native', interfaceName: 'audit0', profile: 'xdj-rx3' };
const oscSettings = (port: number) => ({ enabled: true, host: '127.0.0.1', port, maxHz: 100, snapshotIntervalMs: 1000 });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};
const waitFor = async (predicate: () => boolean) => {
  const end = performance.now() + 1500;
  while (!predicate() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected asynchronous event did not arrive');
};
function ingest(store: StateStore) {
  store.ingestStatus({ sessionId: store.snapshot().session.id, interfaceId: 'audit0', sourceIp: '192.0.2.10', receivedAt: 0,
    wireDeviceId: 11, model: 'XDJ-RX3', trackId: 70, sourceWireDeviceId: 11, protocolSlot: 3, trackType: 1,
    playState: 3, trackBpm: 122, pitchPercent: 0 });
}

test('runtime audit: reentrant native close waits for the original UDP release', async t => {
  const pendingCloses: Array<() => void> = [];
  class FakeSocket extends EventEmitter {
    bind(_port: number, _address: string, ready: () => void) { queueMicrotask(ready); }
    setBroadcast() {}
    close(callback: () => void) { pendingCloses.push(callback); }
  }
  t.mock.method(os, 'networkInterfaces', () => ({ audit0: [{ ...iface }] }));
  syncBuiltinESMExports();
  t.mock.method(dgram, 'createSocket', () => new FakeSocket() as unknown as Socket);
  const abort = new AbortController();
  const store = new StateStore({ sessionId: 'native-close-audit', mode: 'passive' });
  let source: Awaited<ReturnType<typeof startLive>> | undefined;
  try {
    source = await startLive(store, { interfaceName: 'audit0', mode: 'passive', signal: abort.signal });
    abort.abort(); // The signal listener starts close before the explicit call.
    let finished = false;
    const closing = source.close().then(() => { finished = true; });
    await turn();
    assert.equal(pendingCloses.length, 3);
    assert.equal(finished, false, 'all UDP sockets must finish closing before a new session can bind');
    for (const release of pendingCloses.splice(0)) release();
    await closing;
    assert.equal(store.snapshot().session.state, 'disconnected');
  } finally {
    for (const release of pendingCloses.splice(0)) release();
    await source?.close();
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});

test('runtime audit: application close waits for a late startup handle and its release', async () => {
  const startup = deferred<{ close(): Promise<void> }>();
  const release = deferred<void>();
  let handleClosing = false;
  let signal: AbortSignal | undefined;
  const runtime = new RuntimeController(config(), {
    listInterfaces: () => [iface],
    async startLive(_store, options) { signal = options.signal; return startup.promise; },
  });
  let closing: Promise<void> | undefined;
  try {
    await runtime.connect(selection); await turn();
    closing = runtime.close();
    assert.equal(runtime.close(), closing);
    assert.equal(signal?.aborted, true);
    let finished = false; void closing.then(() => { finished = true; });
    startup.resolve({ async close() { handleClosing = true; await release.promise; } });
    await turn();
    assert.equal(handleClosing, true);
    assert.equal(finished, false);
    release.resolve(); await closing;
    assert.equal(runtime.snapshot().session.state, 'disconnected');
    assert.equal(runtime.getRuntime().connection.connected, false);
  } finally {
    release.resolve(); startup.resolve({ async close() {} }); await closing; await runtime.close();
  }
});

test('runtime audit: same-destination OSC reapply orders valid1, valid0 and new valid1 by revision', async () => {
  const receiver = dgram.createSocket('udp4');
  receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  const records: Array<{ revision: number; valid: number }> = [];
  receiver.on('message', bytes => {
    const messages = decodeOscPacket(bytes);
    const valid = messages.find(message => message.address === '/dj/decks/1/bpm/valid');
    const revision = messages.find(message => message.address === '/dj/revision');
    if (valid && revision) records.push({ revision: Number(revision.args[0]), valid: Number(valid.args[0]) });
  });
  const settings = oscSettings(receiver.address().port);
  const runtime = new RuntimeController(config({ osc: settings }), {
    listInterfaces: () => [iface],
    async startLive(store) { ingest(store); return { async close() {} }; },
  });
  try {
    await runtime.initialize();
    await waitFor(() => records.some(record => record.valid === 1));
    const old = records.filter(record => record.valid === 1).at(-1)!;
    const session = runtime.snapshot().session.id;
    const field = runtime.snapshot().decks[0].trackBpm;
    await runtime.setOsc(settings);
    await waitFor(() => records.some(record => record.valid === 1 && record.revision > old.revision + 1));
    const invalid = records.find(record => record.valid === 0 && record.revision > old.revision)!;
    const restarted = records.find(record => record.valid === 1 && record.revision > invalid.revision)!;
    assert.ok(invalid); assert.ok(restarted);
    assert.ok(old.revision < invalid.revision && invalid.revision < restarted.revision);
    assert.equal(runtime.snapshot().session.id, session);
    assert.deepEqual(runtime.snapshot().decks[0].trackBpm, field, 'OSC changes must preserve the XDJ observation and its freshness');
  } finally { await runtime.close(); receiver.close(); }
});

test('runtime audit: a failed OSC replacement restores the active destination and fresh source', async () => {
  const outputs: Array<{ source: StateSource; options: OscOptions; final?: Snapshot }> = [];
  const runtime = new RuntimeController(config({ osc: oscSettings(9000) }), {
    listInterfaces: () => [iface],
    async startLive(store) { ingest(store); return { async close() {} }; },
    startOsc(source, options) {
      if (options.port === 9001) throw new Error('Simulated output failure');
      const entry = { source, options, final: undefined as Snapshot | undefined }; outputs.push(entry);
      return { async close() { entry.final = source.snapshot(); } };
    },
  });
  try {
    await runtime.initialize(); await turn();
    const before = runtime.snapshot();
    await assert.rejects(runtime.setOsc(oscSettings(9001)), /Simulated output failure/);
    assert.equal(outputs.length, 2);
    assert.equal(runtime.getRuntime().osc.port, 9000);
    assert.equal(runtime.getRuntime().osc.enabled, true);
    assert.equal(runtime.snapshot().session.id, before.session.id);
    assert.equal(runtime.snapshot().decks[0].trackBpm.freshness, 'fresh');
    assert.equal(snapshotToOsc(outputs[0].final!).find(message => message.address === '/dj/decks/1/bpm/valid')?.args[0], 0);
    assert.equal(snapshotToOsc(outputs[1].source.snapshot()).find(message => message.address === '/dj/decks/1/bpm/valid')?.args[0], 1);
    assert.ok(outputs[1].source.snapshot().revision > outputs[0].final!.revision);
  } finally { await runtime.close(); }
});

test('runtime audit: a local non-loopback client may read but cannot mutate settings', async t => {
  const entry = Object.values(os.networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal);
  if (!entry) { t.skip('No local non-loopback IPv4 interface exists'); return; }
  const store = new StateStore({ sessionId: 'remote-audit', mode: 'idle' });
  let mutations = 0;
  const server = await startServer(store, { host: entry.address, port: 0, controls: {
    async connect() { mutations++; }, async disconnect() { mutations++; }, async setOsc() { mutations++; },
  } });
  const status = (method: string, path: string) => new Promise<number>((resolve, reject) => {
    const req = request(server.url + path, { method, localAddress: entry.address, headers: { 'Content-Type': 'application/json' } }, res => {
      res.resume(); resolve(res.statusCode!);
    });
    req.on('error', reject); req.setTimeout(1500, () => req.destroy(new Error('Local HTTP audit timed out')));
    req.end(method === 'POST' ? JSON.stringify({ action: 'disconnect' }) : undefined);
  });
  try {
    assert.equal(await status('GET', '/api/runtime'), 200);
    assert.equal(await status('POST', '/api/connection'), 403);
    assert.equal(await status('POST', '/api/osc'), 403);
    assert.equal(mutations, 0);
  } finally { await server.close(); }
});
