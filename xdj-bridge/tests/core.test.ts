import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { decodePacket } from '../src/core/decoder.js';
import { StateStore } from '../src/core/store.js';
import type { PacketEnvelope, StatusObservation } from '../src/core/types.js';

const fixture = await readFile(new URL('../../tests/fixtures/rx3-loop-master-sync.hex', import.meta.url), 'utf8');
const packet = (changes: Partial<PacketEnvelope> = {}): PacketEnvelope => ({ sessionId: 'test', interfaceId: 'en6', sourceIp: '169.254.95.63', sourcePort: 50002, destinationIp: '169.254.77.195', destinationPort: 50002, transport: 'replay', bytes: Buffer.from(fixture.trim(), 'hex'), receivedAt: 0, ...changes });
const observation = (changes: Partial<StatusObservation> = {}): StatusObservation => ({ interfaceId: 'en6', sourceIp: '169.254.95.63', receivedAt: 0, wireDeviceId: 11, model: 'XDJ-RX3', trackId: 1, sourceWireDeviceId: 11, protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 122, pitchPercent: -8.5, beat: null, ...changes });
test('recorded RX3 packet: independent playState, effective tempo, invalid beat', () => {
  const store = new StateStore({ sessionId: 'test', mode: 'replay' });
  store.ingest(packet());
  const d = store.snapshot().decks[0];
  assert.equal(d.logicalDeck, 1); assert.equal(d.publicDeckId, '1'); assert.equal(d.wireDeviceId, 11);
  assert.equal(d.trackRef?.trackId, 1); assert.equal(d.trackBpm.value, 122);
  assert.ok(Math.abs(d.effectiveBpm.value! - 137.311) < 0.001);
  assert.equal(d.playbackState.value, 'playing'); assert.equal(d.raw.playingFlag, false);
  assert.equal(d.beat.value, null); assert.equal(d.beatPhase.value, null); assert.equal(d.positionMs.value, null);
  assert.equal(d.onAir.value, null); assert.equal(d.title.value, null); assert.equal(d.artist.value, null);
});
test('wrong type, port, subtype and all truncations are harmless', () => {
  for (let length = 0; length < 0xcc; length++) assert.equal(decodePacket(packet({ bytes: Buffer.from(fixture.trim(), 'hex').subarray(0, length) })), null);
  for (const [offset, value] of [[10, 0x29], [0x20, 0x99], [0x1f, 0]] as const) {
    const bytes = Buffer.from(fixture.trim(), 'hex'); bytes[offset] = value;
    assert.equal(decodePacket(packet({ bytes })), null);
  }
  assert.equal(decodePacket(packet({ destinationPort: 50001 })), null);
  const bytes = Buffer.from(fixture.trim(), 'hex'); bytes[0] = 0;
  assert.equal(decodePacket(packet({ bytes })), null);
});
test('RX3 unknown wire IDs stay unmapped and unknown playState stays null', () => {
  const store = new StateStore({ sessionId: 'test', mode: 'replay' });
  store.ingestStatus(observation({ wireDeviceId: 13, playState: 99 }));
  const d = store.snapshot().decks[0];
  assert.equal(d.logicalDeck, null); assert.equal(d.publicDeckId, null); assert.equal(d.playbackState.value, null);
  assert.equal(d.playbackState.quality, 'unknown');
});
test('title is cleared on load and an old async response is rejected', () => {
  const store = new StateStore({ sessionId: 'test', mode: 'replay' });
  store.ingestStatus(observation());
  const d = store.snapshot().decks[0];
  const response = { deckId: d.deckId, loadGeneration: d.loadGeneration, mediaGeneration: d.trackRef!.mediaGeneration, title: 'First', artist: 'Artist' };
  assert.equal(store.applyMetadata(response, 10), true);
  store.ingestStatus(observation({ receivedAt: 20, trackId: 43 }));
  assert.equal(store.snapshot().decks[0].title.value, null);
  assert.equal(store.applyMetadata(response, 30), false);
  assert.equal(store.snapshot().decks[0].title.value, null);
});
test('media generation is shared across RX3 decks and same-ID replacement invalidates responses', () => {
  const store = new StateStore({ sessionId: 'test', mode: 'replay' });
  store.ingestStatus(observation()); store.ingestStatus(observation({ wireDeviceId: 12, trackId: 43 }));
  const old = store.snapshot().decks;
  for (const d of old) assert.equal(store.applyMetadata({ deckId: d.deckId, loadGeneration: d.loadGeneration, mediaGeneration: d.trackRef!.mediaGeneration, title: 'Old' }, 10), true);
  store.invalidateMedia(old[0].trackRef!.sourceDeviceId, 3, 20);
  for (const d of store.snapshot().decks) {
    assert.equal(d.title.value, null); assert.equal(d.trackRef!.mediaGeneration, 1);
    assert.equal(store.applyMetadata({ deckId: d.deckId, loadGeneration: old.find(x => x.deckId === d.deckId)!.loadGeneration, mediaGeneration: 0, title: 'Late' }, 30), false);
  }
});
test('a receive gap is stale playback, then reconnect invalidates metadata', () => {
  const store = new StateStore({ sessionId: 'test', mode: 'replay', staleAfterMs: 1000 });
  store.ingestStatus(observation()); const d = store.snapshot().decks[0];
  store.applyMetadata({ deckId: d.deckId, loadGeneration: d.loadGeneration, mediaGeneration: 0, title: 'Old' }, 10);
  store.tick(1100); const stale = store.snapshot().decks[0];
  assert.equal(stale.playbackState.value, 'playing'); assert.equal(stale.playbackState.freshness, 'stale');
  assert.equal(stale.title.value, 'Old'); assert.equal(store.snapshot().session.state, 'degraded');
  store.ingestStatus(observation({ receivedAt: 1200 }));
  const current = store.snapshot().decks[0];
  assert.equal(current.title.value, null); assert.equal(current.trackRef!.mediaGeneration, 1);
  assert.equal(current.playbackState.freshness, 'fresh');
  assert.equal(store.applyMetadata({ deckId: d.deckId, loadGeneration: d.loadGeneration, mediaGeneration: 0, title: 'Late' }, 1300), false);
});
test('immediate explicit reconnect invalidates metadata without waiting for stale timer', () => {
  const store = new StateStore({ sessionId: 'test', mode: 'replay' });
  store.ingestStatus(observation()); const d = store.snapshot().decks[0];
  store.applyMetadata({ deckId: d.deckId, loadGeneration: d.loadGeneration, mediaGeneration: 0, title: 'Old' }, 10);
  store.setSession({ state: 'disconnected', now: 20 });
  assert.equal(store.snapshot().decks[0].title.value, 'Old');
  store.ingestStatus(observation({ receivedAt: 30 }));
  assert.equal(store.snapshot().decks[0].title.value, null);
});
test('track references include media owner and protocol slot, pitch applied once', () => {
  const store = new StateStore({ sessionId: 'test', mode: 'replay' });
  store.ingestStatus(observation()); const first = store.snapshot().decks[0];
  assert.ok(Math.abs(first.effectiveBpm.value! - 111.63) < 1e-9);
  store.ingestStatus(observation({ receivedAt: 10, protocolSlot: 7 }));
  const next = store.snapshot().decks[0]; assert.equal(next.loadGeneration, first.loadGeneration + 1);
  assert.equal(next.trackRef?.protocolSlot, 7); assert.equal(next.trackRef?.trackId, first.trackRef?.trackId);
});
test('mixed models remain distinct, duplicate public IDs require mapping', () => {
  const store = new StateStore({ sessionId: 'test', mode: 'replay' });
  store.ingestStatus(observation());
  store.ingestStatus(observation({ sourceIp: '192.0.2.50', model: 'XDJ-AZ', wireDeviceId: 1, sourceWireDeviceId: 1 }));
  const decks = store.snapshot().decks;
  assert.equal(decks.length, 2); assert.notEqual(decks[0].physicalDeviceId, decks[1].physicalDeviceId);
  assert.equal(decks[1].profile, 'xdj-az'); assert.equal(decks[1].publicDeckId, null);
  const explicit = new StateStore({ sessionId: 'test', mode: 'replay', publicDeckIds: { '192.0.2.50:1': 'az1' } });
  explicit.ingestStatus(observation({ sourceIp: '192.0.2.50', model: 'XDJ-AZ', wireDeviceId: 1 }));
  assert.equal(explicit.snapshot().decks[0].publicDeckId, 'az1');
});
test('snapshots and subscribers cannot mutate reducer state; old sessions/packets are ignored', () => {
  const store = new StateStore({ sessionId: 'test', mode: 'replay' });
  store.subscribe(s => { s.decks.length = 0; });
  store.ingestStatus(observation({ receivedAt: 100 }));
  store.ingestStatus(observation({ receivedAt: 99, trackId: 43 }));
  store.ingest(packet({ sessionId: 'wrong', receivedAt: 200 }));
  const snap = store.snapshot(); assert.equal(snap.decks.length, 1); assert.equal(snap.decks[0].trackRef?.trackId, 1);
  snap.decks.length = 0; assert.equal(store.snapshot().decks.length, 1);
});
test('media and session invalidation clear availability while preserving capability history', () => {
  const store = new StateStore({ sessionId: 'test', mode: 'replay' });
  store.ingestStatus(observation({ positionMs: 100 }));
  const d = store.snapshot().decks[0];
  store.applyMetadata({ deckId: d.deckId, loadGeneration: d.loadGeneration, mediaGeneration: 0, title: 'Old' }, 1);
  store.setCapability(d.deckId, 'analysis', { availability: 'available', lastSuccessAt: 1, lastFailureAt: 0 });
  store.invalidateMedia(d.trackRef!.sourceDeviceId, 3, 2);
  const current = store.snapshot().decks[0];
  assert.equal(current.capabilities.metadata.availability, 'idle');
  assert.equal(current.capabilities.analysis.availability, 'idle');
  assert.equal(current.capabilities.position.availability, 'unavailable');
  assert.equal(current.capabilities.metadata.lastSuccessAt, 1);
  assert.equal(current.capabilities.analysis.lastSuccessAt, 1);
  assert.equal(current.capabilities.analysis.lastFailureAt, 0);
  store.ingestStatus(observation({ receivedAt: 3 }));
  const next = store.snapshot().decks[0];
  store.applyMetadata({ deckId: next.deckId, loadGeneration: next.loadGeneration, mediaGeneration: next.trackRef!.mediaGeneration, title: 'New' }, 4);
  store.setSession({ state: 'disconnected', now: 5 });
  const disconnected = store.snapshot().decks[0];
  assert.equal(disconnected.title.value, 'New'); assert.equal(disconnected.title.freshness, 'stale');
  assert.equal(disconnected.capabilities.metadata.availability, 'unavailable');
  assert.equal(disconnected.capabilities.metadata.lastSuccessAt, 4);
  assert.equal(disconnected.capabilities.metadata.lastFailureAt, null);
  assert.equal(Object.values(disconnected.capabilities).some(c => c.availability === 'available'), false);
});
