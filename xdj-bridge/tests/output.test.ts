import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { StateStore } from '../src/core/store.js';
import { startServer } from '../src/output/server.js';
import { decodeOscPacket, encodeOscBundle, encodeOscMessage, snapshotToOsc, startOsc } from '../src/output/osc.js';

const createStore = () => {
  const store = new StateStore({ sessionId: 'output-test', mode: 'replay' });
  store.ingestStatus({ sessionId: 'output-test', interfaceId: 'capture0', sourceIp: '169.254.1.2', receivedAt: 0, wireDeviceId: 11, model: 'XDJ-RX3', trackId: 70, sourceWireDeviceId: 11, protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 122, pitchPercent: -8.5 });
  return store;
};
const readWs = (ws: WebSocket) => once(ws, 'message').then(([bytes]) => JSON.parse(bytes.toString()));

test('OSC encoding is aligned and supports explicit integers, float32 and UTF-8 strings', () => {
  const message = { address: '/dj/test', args: [1, 122.5, '日本語'], types: 'ifs' };
  const bytes = encodeOscMessage(message);
  assert.equal(bytes.length % 4, 0);
  assert.deepEqual(decodeOscPacket(bytes), [message]);
  assert.deepEqual(decodeOscPacket(encodeOscBundle([message, { address: '/valid', args: [0], types: 'i' }])), [message, { address: '/valid', args: [0], types: 'i' }]);
  assert.throws(() => encodeOscMessage({ address: '/bad', args: [NaN] }));
  assert.throws(() => decodeOscPacket(bytes.subarray(0, bytes.length - 1)));
});

test('OSC uses common deck state, clears invalid/stale data and never fabricates zero positions', () => {
  const store = createStore();
  let messages = snapshotToOsc(store.snapshot());
  assert.deepEqual(messages.find(m => m.address === '/dj/decks/1/bpm')?.args, [122]);
  assert.deepEqual(messages.find(m => m.address === '/dj/decks/1/playing')?.args, [1]);
  assert.deepEqual(messages.find(m => m.address === '/dj/decks/1/track_id')?.args, ['70']);
  assert.equal(messages.some(m => m.address === '/dj/decks/1/position_ms'), false);
  assert.deepEqual(messages.find(m => m.address === '/dj/decks/1/position_ms/valid')?.args, [0]);
  assert.equal(messages.some(m => m.address.startsWith('/dj/decks/11/')), false);
  store.setSession({ state: 'disconnected', now: 1000 });
  messages = snapshotToOsc(store.snapshot());
  assert.equal(messages.some(m => m.address === '/dj/decks/1/bpm'), false);
  assert.deepEqual(messages.find(m => m.address === '/dj/decks/1/bpm/valid')?.args, [0]);
  assert.deepEqual(messages.find(m => m.address === '/dj/decks/1/bpm/quality')?.args, [1]);
});

test('OSC transmits real UDP bundles, limits packet size and repeats snapshots without updates', async () => {
  const receiver = dgram.createSocket('udp4');
  receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  const address = receiver.address();
  const packets: { at: number; bytes: Buffer }[] = [];
  receiver.on('message', bytes => packets.push({ at: performance.now(), bytes }));
  const store = createStore();
  const osc = startOsc(store, { host: '127.0.0.1', port: address.port, maxHz: 20, snapshotIntervalMs: 100 });
  try {
    await new Promise(resolve => setTimeout(resolve, 280));
    assert.ok(packets.length >= 4);
    assert.ok(packets.every(p => p.bytes.length <= 1200));
    assert.ok(packets.every(p => decodeOscPacket(p.bytes).some(m => m.address === '/dj/revision')));
    assert.ok(packets.some(p => decodeOscPacket(p.bytes).some(m => m.address === '/dj/decks/1/effective_bpm')));
    const batchTimes = [...new Set(packets.map(p => Math.floor(p.at / 20)))];
    assert.ok(batchTimes.length >= 2, 'periodic snapshot should repeat without state updates');
  } finally { await osc.close(); receiver.close(); }
});

test('OSC close flushes final invalidation before closing and respects the output rate', { timeout: 3000 }, async () => {
  const receiver = dgram.createSocket('udp4');
  receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  const store = createStore();
  let sawValid: (at: number) => void = () => {};
  let sawInvalid: (at: number) => void = () => {};
  const validReceived = new Promise<number>(resolve => { sawValid = resolve; });
  const invalidReceived = new Promise<number>(resolve => { sawInvalid = resolve; });
  receiver.on('message', bytes => {
    const valid = decodeOscPacket(bytes).find(message => message.address === '/dj/decks/1/bpm/valid');
    if (valid?.args[0] === 1) sawValid(performance.now());
    if (valid?.args[0] === 0) sawInvalid(performance.now());
  });
  const osc = startOsc(store, { host: '127.0.0.1', port: receiver.address().port, maxHz: 20 });
  try {
    const firstAt = await validReceived;
    store.setSession({ state: 'disconnected', now: 1000 });
    const closing = osc.close();
    assert.equal(osc.close(), closing, 'concurrent close calls share the same final flush');
    const invalidAt = await invalidReceived;
    await closing;
    assert.ok(invalidAt - firstAt >= 40, 'final snapshot must preserve the 50ms output interval');
  } finally { await osc.close(); receiver.close(); }
});

test('HTTP default public assets, versioned WS delta and resync work; cross-site requests are refused', async () => {
  const store = createStore();
  const server = await startServer(store, { port: 0, runtime: { osc: { host: '127.0.0.1', port: 9000, enabled: true } } });
  let ws: WebSocket | undefined;
  try {
    const page = await fetch(server.url + '/'); assert.equal(page.status, 200); assert.match(await page.text(), /接続先/);
    assert.equal((await fetch(server.url + '/app.js')).status, 200);
    const state = await (await fetch(server.url + '/api/state')).json() as { schemaVersion: number };
    assert.equal(state.schemaVersion, 1);
    const runtime = await (await fetch(server.url + '/api/runtime')).json() as { osc: { port: number } }; assert.equal(runtime.osc.port, 9000);
    assert.equal((await fetch(server.url + '/api/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(server.url + '/api/state', { method: 'POST' })).status, 405);
    ws = new WebSocket(server.url.replace('http:', 'ws:') + '/ws');
    const first = await readWs(ws); assert.equal(first.type, 'snapshot'); assert.equal(first.schemaVersion, 1);
    const waiting = readWs(ws); store.setSession({ state: 'degraded', reason: 'test receive gap', now: 4000 });
    const delta = await waiting; assert.equal(delta.type, 'delta'); assert.equal(delta.baseRevision, first.revision); assert.ok(delta.revision > first.revision); assert.equal(delta.decks[0].trackBpm.freshness, 'stale');
    const resynced = readWs(ws); ws.send(JSON.stringify({ type: 'resync' }));
    assert.equal((await resynced).type, 'snapshot');
    const forbidden = new WebSocket(server.url.replace('http:', 'ws:') + '/ws', { origin: 'https://evil.example' });
    const rejected = await new Promise<Error>(resolve => forbidden.once('error', resolve)); assert.match(rejected.message, /403/);
  } finally { ws?.terminate(); await server.close(); }
});
