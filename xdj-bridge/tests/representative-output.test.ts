import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import test from 'node:test';
import { StateStore } from '../src/core/store.js';
import type { StatusObservation } from '../src/core/types.js';
import { decodeOscPacket, snapshotToOsc, startOsc, type OscMessage } from '../src/output/osc.js';

const status = (wireDeviceId: number, changes: Partial<StatusObservation> = {}): StatusObservation => ({
  sessionId: 'representative-output', interfaceId: 'test0', sourceIp: '192.0.2.50', receivedAt: 0,
  wireDeviceId, model: 'XDJ-AZ', trackId: wireDeviceId * 100, sourceWireDeviceId: 1,
  protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 120 + wireDeviceId,
  pitchPercent: 0, ...changes,
});
const createStore = () => new StateStore({ sessionId: 'representative-output', mode: 'replay' });
const args = (messages: OscMessage[], path: string) => messages.find(message => message.address === path)?.args;
const waitFor = async (predicate: () => boolean) => {
  const deadline = performance.now() + 1500;
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected OSC state was not received');
};

test('representative OSC aliases the tempo master while preserving every individual deck route', () => {
  const store = createStore();
  store.ingestStatus(status(1, { trackBpm: 120 }));
  store.ingestStatus(status(2, { trackBpm: 128, pitchPercent: 5, tempoMaster: true }));
  const messages = snapshotToOsc(store.snapshot());
  assert.deepEqual(args(messages, '/dj/representative/valid'), [1]);
  assert.deepEqual(args(messages, '/dj/representative/public_deck_id'), ['2']);
  assert.deepEqual(args(messages, '/dj/representative/deck_id'), [store.snapshot().decks[1].deckId]);
  assert.deepEqual(args(messages, '/dj/representative/reason'), ['tempo-master']);
  assert.deepEqual(args(messages, '/dj/representative/bpm'), [128]);
  assert.ok(Math.abs(Number(args(messages, '/dj/representative/effective_bpm')?.[0]) - 134.4) < 0.0001);
  assert.deepEqual(args(messages, '/dj/representative/playing'), [1]);
  assert.deepEqual(args(messages, '/dj/representative/tempo_master'), [1]);
  assert.deepEqual(args(messages, '/dj/decks/1/bpm'), [120]);
  assert.deepEqual(args(messages, '/dj/decks/2/bpm'), [128]);
  assert.deepEqual(args(messages, '/dj/decks/2/tempo_master'), [1]);
});

test('a paused master with unknown BPM keeps its identity but explicitly invalidates tempo fields', () => {
  const store = createStore();
  store.ingestStatus(status(1, { tempoMaster: true, playState: 5, trackBpm: null }));
  store.ingestStatus(status(2, { trackBpm: 130 }));
  const messages = snapshotToOsc(store.snapshot());
  assert.deepEqual(args(messages, '/dj/representative/public_deck_id'), ['1']);
  assert.deepEqual(args(messages, '/dj/representative/valid'), [1]);
  assert.deepEqual(args(messages, '/dj/representative/playing'), [0]);
  for (const name of ['bpm', 'effective_bpm']) {
    assert.deepEqual(args(messages, `/dj/representative/${name}/valid`), [0]);
    assert.equal(args(messages, `/dj/representative/${name}`), undefined);
  }
});

test('no candidate and a privately disconnected view clear representative values instead of replaying old BPM', () => {
  const store = createStore(); store.ingestStatus(status(1));
  const historical = store.snapshot();
  assert.equal(historical.representative.publicDeckId, '1');
  historical.session.state = 'disconnected';
  // OscView may retain source fields and selection; the output must recheck
  // session availability rather than trusting the old shared selection.
  let messages = snapshotToOsc(historical);
  assert.deepEqual(args(messages, '/dj/representative/valid'), [0]);
  assert.deepEqual(args(messages, '/dj/representative/reason'), ['none']);
  for (const name of ['deck_id', 'bpm', 'effective_bpm', 'pitch_percent', 'playing', 'tempo_master']) {
    assert.deepEqual(args(messages, `/dj/representative/${name}/valid`), [0]);
    assert.equal(args(messages, `/dj/representative/${name}`), undefined);
  }
  assert.equal(args(messages, '/dj/representative/public_deck_id'), undefined);
  store.ingestStatus(status(1, { receivedAt: 100, playState: 5 }));
  messages = snapshotToOsc(store.snapshot());
  assert.deepEqual(args(messages, '/dj/representative/valid'), [0]);
  assert.equal(args(messages, '/dj/representative/effective_bpm'), undefined);
});

test('representative OSC switches over real UDP with identity in each fragment and ends invalid', async () => {
  const receiver = dgram.createSocket('udp4'); receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  const packets: { bytes: Buffer; messages: OscMessage[] }[] = [];
  receiver.on('message', bytes => packets.push({ bytes, messages: decodeOscPacket(bytes) }));
  const store = createStore();
  for (const wire of [1, 2, 3, 4]) store.ingestStatus(status(wire));
  const output = startOsc(store, { host: '127.0.0.1', port: receiver.address().port, maxHz: 60 });
  try {
    await waitFor(() => packets.some(packet => args(packet.messages, '/dj/representative/effective_bpm')?.[0] === 121));
    store.ingestStatus(status(2, { receivedAt: 100, tempoMaster: true, trackBpm: 132 }));
    await waitFor(() => packets.some(packet => args(packet.messages, '/dj/representative/effective_bpm')?.[0] === 132));
    const selectedRevision = store.snapshot().revision;
    const selected = packets.filter(packet => args(packet.messages, '/dj/revision')?.[0] === String(selectedRevision));
    assert.ok(selected.length > 1, 'four decks should exercise OSC fragmentation');
    for (const packet of selected) {
      assert.ok(packet.bytes.length <= 1200);
      assert.deepEqual(args(packet.messages, '/dj/representative/valid'), [1]);
      assert.deepEqual(args(packet.messages, '/dj/representative/public_deck_id'), ['2']);
      assert.deepEqual(args(packet.messages, '/dj/representative/reason'), ['tempo-master']);
      assert.deepEqual(args(packet.messages, '/dj/session_id'), ['representative-output']);
    }
    store.setSession({ state: 'disconnected', now: 200 });
    await output.close();
    await waitFor(() => packets.some(packet => args(packet.messages, '/dj/revision')?.[0] === String(store.snapshot().revision)));
    const final = packets.filter(packet => args(packet.messages, '/dj/revision')?.[0] === String(store.snapshot().revision));
    assert.ok(final.some(packet => args(packet.messages, '/dj/representative/effective_bpm/valid')?.[0] === 0));
    for (const packet of final) {
      assert.deepEqual(args(packet.messages, '/dj/representative/valid'), [0]);
      assert.equal(args(packet.messages, '/dj/representative/public_deck_id'), undefined);
      assert.equal(args(packet.messages, '/dj/representative/effective_bpm'), undefined);
    }
  } finally { await output.close(); receiver.close(); }
});
