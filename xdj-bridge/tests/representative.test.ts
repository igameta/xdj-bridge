import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { WebSocket } from 'ws';
import { statusObservationFromLibrary } from '../src/adapters/alphatheta.js';
import { decodePacket, tempoMasterFromFlags } from '../src/core/decoder.js';
import { selectRepresentative } from '../src/core/representative.js';
import { StateStore } from '../src/core/store.js';
import type { PacketEnvelope, Snapshot, StatusObservation } from '../src/core/types.js';
import { startServer } from '../src/output/server.js';

const fixture = Buffer.from((await readFile(new URL('../../tests/fixtures/rx3-loop-master-sync.hex', import.meta.url), 'utf8')).trim(), 'hex');
const packet = (bytes = fixture): PacketEnvelope => ({ sessionId: 'representative', interfaceId: 'capture0', sourceIp: '192.0.2.10', sourcePort: 50002, destinationIp: '192.0.2.20', destinationPort: 50002, transport: 'replay', bytes, receivedAt: 0 });
const status = (deck: number, changes: Partial<StatusObservation> = {}): StatusObservation => ({ sessionId: 'representative', interfaceId: 'capture0', sourceIp: '192.0.2.10', receivedAt: 0, wireDeviceId: deck, model: 'XDJ-AZ', trackId: deck, sourceWireDeviceId: 1, protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 120 + deck, pitchPercent: 0, ...changes });
const createStore = (staleAfterMs = 1000) => new StateStore({ sessionId: 'representative', mode: 'demo', staleAfterMs });
const waitFor = async (predicate: () => boolean) => {
  const deadline = performance.now() + 1500;
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected representative state was not received');
};

test('tempo master uses the observed 0x20 flag and leaves missing/invalid flags unknown', () => {
  assert.equal(tempoMasterFromFlags(0xb0), true); assert.equal(tempoMasterFromFlags(0x40), false);
  for (const invalid of [undefined, -1, 256, 1.5, NaN, Infinity]) assert.equal(tempoMasterFromFlags(invalid), null);
  const store = new StateStore({ sessionId: 'representative', mode: 'replay' });
  store.ingest(packet());
  const deck = store.snapshot().decks[0];
  assert.equal(deck.tempoMaster.value, true); assert.equal(deck.tempoMaster.quality, 'observed');
  assert.equal(deck.tempoMaster.freshness, 'fresh'); assert.equal(deck.playbackState.value, 'playing');
  assert.equal(deck.raw.playingFlag, false, 'RX3 playState remains independent from the standard playing bit');
  assert.equal(deck.capabilities.tempoMaster.verification, 'implemented-unverified', 'a saved flag is not a firmware/hardware certification');
  for (const subtype of [3, 4, 5]) for (let length = 0xcc; length < 0xd4; length++) {
    const short = Buffer.from(fixture.subarray(0, length)); short[0x20] = subtype;
    const decoded = decodePacket(packet(short));
    assert.equal(decoded?.kind, 'status');
    assert.equal(decoded?.kind === 'status' ? decoded.status.statusFlags : null, 0xb0, 'every already-accepted status layout contains flag byte 0x89');
    const shortStore = new StateStore({ sessionId: 'representative', mode: 'replay' }); shortStore.ingest(packet(short));
    assert.equal(shortStore.snapshot().decks[0].tempoMaster.value, true);
  }
  for (let length = 0; length < 0xcc; length++) assert.equal(decodePacket(packet(fixture.subarray(0, length))), null);
  const unsupported = Buffer.from(fixture.subarray(0, 0xcc)); unsupported[0x20] = 0x99;
  assert.equal(decodePacket(packet(unsupported)), null, 'reading flags does not admit an unknown status layout');
});

test('public library status preserves explicit master true/false without synthesizing unrelated flags', () => {
  const context = { sessionId: 'representative', interfaceId: 'capture0', sourceIp: '192.0.2.10', model: 'XDJ-AZ', receivedAt: 0 };
  const library = { deviceId: 1, trackId: 1, trackDeviceId: 1, trackSlot: 3, trackType: 1, playState: 3, trackBPM: 120, effectivePitch: 0 };
  for (const isMaster of [true, false, undefined]) {
    const observation = statusObservationFromLibrary({ ...library, isMaster }, context);
    assert.equal(observation.statusFlags, undefined);
    const store = createStore(); store.ingestStatus(observation);
    assert.equal(store.snapshot().decks[0].tempoMaster.value, isMaster ?? null);
  }
});

test('representative follows a tempo-master handover and remains stable while two masters are briefly observed', () => {
  const store = createStore();
  store.ingestStatus(status(1, { statusFlags: 0x20 })); store.ingestStatus(status(2, { statusFlags: 0 }));
  assert.equal(store.snapshot().representative.publicDeckId, '1');
  store.ingestStatus(status(2, { receivedAt: 10, statusFlags: 0x20 }));
  assert.equal(store.snapshot().representative.publicDeckId, '1', 'overlapping claims must not oscillate on packet arrival');
  store.ingestStatus(status(1, { receivedAt: 20, statusFlags: 0 }));
  assert.deepEqual(store.snapshot().representative, { deckId: store.snapshot().decks[1].deckId, publicDeckId: '2', reason: 'tempo-master' });
  store.ingestStatus(status(1, { receivedAt: 30, statusFlags: 0 }));
  assert.equal(store.snapshot().representative.publicDeckId, '2');
});

test('a paused master with unknown BPM stays authoritative; fallback requires playing and usable effective BPM', () => {
  const store = createStore(); store.ingestStatus(status(1));
  store.ingestStatus(status(2, { playState: 5, trackBpm: null, statusFlags: 0x20 }));
  assert.equal(store.snapshot().representative.publicDeckId, '2'); assert.equal(store.snapshot().representative.reason, 'tempo-master');
  assert.equal(store.snapshot().decks[1].effectiveBpm.value, null);
  store.ingestStatus(status(2, { receivedAt: 10, playState: 5, trackBpm: null, statusFlags: 0 }));
  assert.equal(store.snapshot().representative.publicDeckId, '1'); assert.equal(store.snapshot().representative.reason, 'playing');
  store.ingestStatus(status(1, { receivedAt: 20, trackBpm: null }));
  assert.deepEqual(store.snapshot().representative, { deckId: null, publicDeckId: null, reason: 'none' });
  store.ingestStatus(status(1, { receivedAt: 30, playState: 99 }));
  assert.equal(store.snapshot().representative.reason, 'none');
});

test('playing fallback retains its deck, supports four decks and has deterministic ordering without history', () => {
  const store = createStore();
  for (const deck of [4, 3, 2, 1]) store.ingestStatus(status(deck));
  assert.equal(store.snapshot().representative.publicDeckId, '4', 'existing same-priority fallback is sticky');
  assert.equal(selectRepresentative(store.snapshot()).publicDeckId, '1', 'first selection is independent of array arrival order');
  assert.equal(selectRepresentative({ ...store.snapshot(), decks: [...store.snapshot().decks].reverse() }).publicDeckId, '1');
  store.ingestStatus(status(4, { receivedAt: 10, playState: 5 }));
  assert.equal(store.snapshot().representative.publicDeckId, '1');
  store.ingestStatus(status(3, { receivedAt: 20, statusFlags: 0x20 }));
  assert.equal(store.snapshot().representative.publicDeckId, '3', 'a master promotes above the retained fallback');
});

test('stale master falls back to a fresh playing deck, then disconnect clears the shared representative', () => {
  const store = createStore();
  store.ingestStatus(status(1, { statusFlags: 0x20 })); store.ingestStatus(status(2));
  store.ingestStatus(status(2, { receivedAt: 900 })); store.tick(1100);
  assert.equal(store.snapshot().session.state, 'degraded');
  assert.equal(store.snapshot().decks[0].tempoMaster.freshness, 'stale');
  assert.equal(store.snapshot().representative.publicDeckId, '2');
  assert.equal(store.snapshot().decks[0].capabilities.tempoMaster.availability, 'unavailable');
  store.setSession({ state: 'disconnected', now: 1200 });
  assert.equal(store.snapshot().representative.reason, 'none');
  store.ingestStatus(status(1, { receivedAt: 1300, statusFlags: 0 }));
  assert.equal(store.snapshot().representative.reason, 'playing');
  assert.equal(store.snapshot().decks[0].tempoMaster.value, false, 'old master claim is not resurrected on reconnect');
});

test('unmapped, duplicate public IDs and previous-session decks cannot become a representative', () => {
  const store = createStore(); for (const deck of [1, 2, 3, 4]) store.ingestStatus(status(deck));
  const state = store.snapshot();
  state.decks[0].publicDeckId = null;
  state.decks[1].publicDeckId = 'duplicate'; state.decks[2].publicDeckId = 'duplicate';
  state.decks[3].sessionId = 'previous-session';
  assert.equal(selectRepresentative(state).reason, 'none');
  assert.equal(selectRepresentative({ ...state, session: { ...state.session, id: 'different-session' } }, store.snapshot().representative.deckId).reason, 'none');
  const immutable = store.snapshot(); immutable.representative.publicDeckId = 'changed';
  assert.notEqual(store.snapshot().representative.publicDeckId, 'changed');
});

test('shared representative is sent on WebSocket deltas as well as snapshots', async () => {
  const store = createStore(), server = await startServer(store, { port: 0 });
  const ws = new WebSocket(server.url.replace('http:', 'ws:') + '/ws');
  const received: Array<{ type: string; representative: Snapshot['representative'] }> = [];
  ws.on('message', bytes => received.push(JSON.parse(bytes.toString())));
  try {
    await once(ws, 'open'); await waitFor(() => received.length > 0);
    assert.equal(received[0].type, 'snapshot'); assert.equal(received[0].representative.reason, 'none');
    store.ingestStatus(status(1)); store.ingestStatus(status(2, { statusFlags: 0x20 }));
    await waitFor(() => received.some(message => message.type === 'delta' && message.representative?.publicDeckId === '2'));
    store.setSession({ state: 'disconnected', now: 20 });
    await waitFor(() => received.at(-1)?.representative.reason === 'none');
  } finally { ws.terminate(); await server.close(); }
});
