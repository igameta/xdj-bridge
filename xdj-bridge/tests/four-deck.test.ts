import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { parseConfig } from '../src/config.js';
import { StateStore } from '../src/core/store.js';
import type { PacketEnvelope, Snapshot } from '../src/core/types.js';
import { decodeOscPacket, snapshotToOsc, startOsc, type OscMessage } from '../src/output/osc.js';
import { startServer } from '../src/output/server.js';
import { RuntimeController } from '../src/runtime.js';
import { makeDemoPackets } from '../src/transport/replay.js';

const firstFrame = (sessionId = 'four'): PacketEnvelope[] => makeDemoPackets(sessionId, 4).slice(0, 4);
const waitFor = async (predicate: () => boolean) => {
  const deadline = performance.now() + 1500;
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected state was not received');
};

test('4-deck demo is explicit, preserves 2-deck default and validates profile/count consistency', async () => {
  const defaults = await parseConfig(['--mode', 'demo']); assert.equal(defaults.demoDecks, 2);
  assert.equal(makeDemoPackets('two').length, 240);
  const four = await parseConfig(['--mode', 'demo', '--demo-decks', '4', '--profile', 'xdj-az']);
  assert.equal(four.demoDecks, 4); assert.equal(makeDemoPackets('four', four.demoDecks).length, 480);
  for (const count of ['0', '3', '6', 'NaN']) await assert.rejects(parseConfig(['--mode', 'demo', '--demo-decks', count]), /2 or 4/);
  await assert.rejects(parseConfig(['--mode', 'demo', '--demo-decks', '4', '--profile', 'xdj-rx3']), /mismatch/);
  await assert.rejects(parseConfig(['--mode', 'demo', '--demo-decks', '2', '--profile', 'xdj-az']), /mismatch/);
  const dir = await mkdtemp(join(tmpdir(), 'xdj-four-config-'));
  try {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ mode: 'demo', demoDecks: 4 }));
    assert.equal((await parseConfig(['--config', path])).demoDecks, 4);
    await writeFile(path, JSON.stringify({ mode: 'demo', demoDecks: '4' }));
    await assert.rejects(parseConfig(['--config', path]), /2 or 4/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('4 raw demo streams reduce to independent decks, shared physical unit and unverified capabilities', () => {
  const store = new StateStore({ sessionId: 'four', mode: 'demo' });
  for (const packet of makeDemoPackets('four', 4)) store.ingest(packet);
  const snapshot = store.snapshot();
  assert.equal(snapshot.decks.length, 4);
  assert.deepEqual(snapshot.decks.map(d => d.publicDeckId), ['1', '2', '3', '4']);
  assert.deepEqual(snapshot.decks.map(d => d.trackBpm.value), [122, 125, 128, 130]);
  assert.deepEqual(snapshot.decks.map(d => d.trackRef!.trackId), [100, 201, 300, 400]);
  assert.equal(snapshot.decks[2].playbackState.value, 'paused');
  assert.equal(new Set(snapshot.decks.map(d => d.physicalDeviceId)).size, 1);
  assert.equal(new Set(snapshot.decks.map(d => d.trackRef!.sourceDeviceId)).size, 1);
  assert.ok(snapshot.diagnostics.some(d => d.code === 'synthetic-demo'));
  for (const d of snapshot.decks) {
    assert.equal(d.capabilities.status.verification, 'implemented-unverified');
    for (const field of [d.title, d.artist, d.beat, d.beatPhase, d.positionMs, d.onAir]) assert.equal(field.value, null);
  }
});

test('4 independent CDJs share one session without merging their physical/media identities', () => {
  const store = new StateStore({ sessionId: 'four', mode: 'replay' });
  for (const packet of firstFrame()) {
    const bytes = Buffer.from(packet.bytes); bytes.fill(0, 11, 31); bytes.write('CDJ-3000', 11, 'ascii'); bytes[0x28] = bytes[0x21];
    store.ingest({ ...packet, bytes, sourceIp: '192.0.2.' + (10 + bytes[0x21]) });
  }
  const decks = store.snapshot().decks;
  assert.equal(decks.length, 4); assert.deepEqual(decks.map(d => d.publicDeckId), ['1', '2', '3', '4']);
  assert.equal(new Set(decks.map(d => d.physicalDeviceId)).size, 4);
  assert.equal(new Set(decks.map(d => d.trackRef!.sourceDeviceId)).size, 4);
  assert.ok(decks.every(d => d.profile === 'generic-prolink' && d.sessionId === 'four'));
});

test('mixed 2+4 decks report public-ID conflicts; explicit IDs retain all six routes', () => {
  const rx3 = makeDemoPackets('mixed').slice(0, 2);
  const az = firstFrame('mixed').map(p => ({ ...p, sourceIp: '192.0.2.50' }));
  const conflicting = new StateStore({ sessionId: 'mixed', mode: 'demo' });
  for (const p of [...rx3, ...az]) conflicting.ingest(p);
  assert.deepEqual(conflicting.snapshot().decks.map(d => d.publicDeckId), ['1', '2', null, null, '3', '4']);
  assert.ok(conflicting.snapshot().diagnostics.some(d => d.code === 'public-deck-collision'));
  const mapped = new StateStore({ sessionId: 'mixed', mode: 'demo', publicDeckIds: { '192.0.2.50:1': 'az1', '192.0.2.50:2': 'az2', '192.0.2.50:3': 'az3', '192.0.2.50:4': 'az4' } });
  for (const p of [...rx3, ...az]) mapped.ingest(p);
  assert.deepEqual(mapped.snapshot().decks.map(d => d.publicDeckId), ['1', '2', 'az1', 'az2', 'az3', 'az4']);
  const messages = snapshotToOsc(mapped.snapshot());
  for (const id of ['1', '2', 'az1', 'az2', 'az3', 'az4']) assert.deepEqual(messages.find(m => m.address === `/dj/decks/${id}/bpm/valid`)?.args, [1]);
});

test('runtime 4-deck demo starts all four streams without hardware acquisition', async () => {
  const settings = await parseConfig(['--mode', 'demo', '--demo-decks', '4']);
  const runtime = new RuntimeController(settings, {
    listInterfaces: () => [],
    async startLive() { throw new Error('4-deck demo must never open device sockets'); },
    async startCapture() { throw new Error('4-deck demo must never capture a device'); },
  });
  try {
    await runtime.initialize();
    assert.equal(runtime.snapshot().decks.length, 4);
    assert.equal(runtime.snapshot().session.mode, 'demo');
    assert.ok(runtime.snapshot().decks.every(d => d.trackBpm.freshness === 'fresh'));
  } finally { await runtime.close(); }
});

test('4-deck raw acquisition reaches WS and real OSC; one stale deck leaves three valid', async () => {
  const store = new StateStore({ sessionId: 'four', mode: 'demo', staleAfterMs: 1000 });
  const server = await startServer(store, { port: 0 });
  const receiver = dgram.createSocket('udp4'); receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  const messages: OscMessage[] = [];
  receiver.on('message', bytes => { assert.ok(bytes.length <= 1200); messages.push(...decodeOscPacket(bytes)); });
  const output = startOsc(store, { host: '127.0.0.1', port: receiver.address().port, maxHz: 60 });
  const ws = new WebSocket(server.url.replace('http:', 'ws:') + '/ws');
  const received: { type: string; decks: Snapshot['decks'] }[] = [];
  ws.on('message', bytes => received.push(JSON.parse(bytes.toString())));
  try {
    await once(ws, 'open'); await waitFor(() => received.length > 0);
    for (const packet of firstFrame()) store.ingest(packet);
    ws.send(JSON.stringify({ type: 'resync' }));
    await waitFor(() => received.some(s => s.type === 'snapshot' && s.decks.length === 4));
    const snapshot = received.find(s => s.type === 'snapshot' && s.decks.length === 4)!;
    assert.deepEqual(snapshot.decks.map(d => d.publicDeckId), ['1', '2', '3', '4']);
    await waitFor(() => ['1', '2', '3', '4'].every(id => messages.some(m => m.address === `/dj/decks/${id}/bpm/valid` && m.args[0] === 1)));
    for (const packet of firstFrame().slice(0, 3)) store.ingest({ ...packet, receivedAt: 900 });
    const start = messages.length; store.tick(1100);
    await waitFor(() => messages.slice(start).some(m => m.address === '/dj/decks/4/bpm/valid' && m.args[0] === 0));
    const recent = messages.slice(start);
    for (const id of ['1', '2', '3']) assert.ok(recent.some(m => m.address === `/dj/decks/${id}/bpm/valid` && m.args[0] === 1));
    assert.equal(store.snapshot().session.state, 'degraded');
    const unknown = firstFrame()[3]; const bytes = Buffer.from(unknown.bytes); bytes.writeUInt16BE(0xffff, 0x92);
    store.ingest({ ...unknown, bytes, receivedAt: 1200 });
    assert.equal(store.snapshot().decks[3].trackBpm.value, null);
    assert.equal(snapshotToOsc(store.snapshot()).some(m => m.address === '/dj/decks/4/bpm'), false);
  } finally { ws.terminate(); store.setSession({ state: 'disconnected' }); await output.close(); receiver.close(); await server.close(); }
});
