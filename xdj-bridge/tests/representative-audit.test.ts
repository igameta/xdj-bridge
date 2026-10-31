import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import test from 'node:test';
import { StateStore } from '../src/core/store.js';
import type { StatusObservation } from '../src/core/types.js';
import { snapshotToOsc, startOsc, decodeOscPacket, type OscMessage } from '../src/output/osc.js';
import { RuntimeController } from '../src/runtime.js';
import type { AppConfig } from '../src/config.js';
import type { SelectedInterface } from '../src/transport/live.js';

const observation = (wire: number, changes: Partial<StatusObservation> = {}): StatusObservation => ({
  interfaceId: 'audit-representative', sourceIp: '192.0.2.10', receivedAt: 0,
  wireDeviceId: wire, model: 'XDJ-AZ', trackId: 100 + wire, sourceWireDeviceId: 1,
  protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 120 + wire,
  pitchPercent: 0, ...changes,
});
const at = (messages: OscMessage[], path: string) => messages.find(message => message.address === path)?.args[0];
const waitFor = async (predicate: () => boolean) => {
  const deadline = performance.now() + 1500;
  while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Expected representative OSC state did not arrive');
};

test('representative audit: explicit master takes priority even paused or with unknown BPM; fields invalidate independently', () => {
  const store = new StateStore({ sessionId: 'rep-audit-master', mode: 'replay' });
  store.ingestStatus(observation(1));
  store.ingestStatus(observation(4, { statusFlags: 0x20, playState: 5, trackBpm: null }));
  const selected = store.snapshot();
  assert.equal(selected.representative.publicDeckId, '4');
  assert.equal(selected.representative.reason, 'tempo-master');
  const messages = snapshotToOsc(selected);
  assert.equal(at(messages, '/dj/representative/valid'), 1);
  assert.equal(at(messages, '/dj/representative/public_deck_id'), '4');
  assert.equal(at(messages, '/dj/representative/playing'), 0);
  assert.equal(at(messages, '/dj/representative/tempo_master'), 1);
  for (const field of ['bpm', 'effective_bpm']) {
    assert.equal(at(messages, `/dj/representative/${field}/valid`), 0);
    assert.equal(messages.some(message => message.address === `/dj/representative/${field}`), false);
  }
  assert.equal(at(messages, '/dj/decks/1/bpm'), 121, 'individual valid decks remain available');
  store.ingestStatus(observation(4, { receivedAt: 10, statusFlags: 0, playState: 5, trackBpm: null }));
  assert.equal(store.snapshot().representative.publicDeckId, '1');
});

test('representative audit: multiple-master and unknown-master transitions are stable; collision and stale candidates cannot win', () => {
  const store = new StateStore({ sessionId: 'rep-audit-stable', mode: 'replay', staleAfterMs: 1000 });
  store.ingestStatus(observation(3, { statusFlags: 0x20 }));
  store.ingestStatus(observation(1, { statusFlags: 0x20 }));
  assert.equal(store.snapshot().representative.publicDeckId, '3', 'a second concurrent master claim must not oscillate the choice');
  store.ingestStatus(observation(3, { statusFlags: 0, receivedAt: 10 }));
  assert.equal(store.snapshot().representative.publicDeckId, '1', 'observed master transfer must override sticky playback');
  store.ingestStatus(observation(1, { receivedAt: 20 }));
  assert.equal(store.snapshot().representative.publicDeckId, '1', 'missing master information falls back to the current playing deck');
  store.ingestStatus(observation(3, { statusFlags: 0, receivedAt: 900 }));
  store.tick(1100);
  assert.equal(store.snapshot().representative.publicDeckId, '3', 'the fresh fallback replaces a stale master');
  const stale = store.snapshot().decks.find(deck => deck.logicalDeck === 1)!;
  assert.equal(stale.tempoMaster.freshness, 'stale');
  store.ingestStatus(observation(1, { sourceIp: '192.0.2.99', statusFlags: 0x20, receivedAt: 1101 }));
  assert.equal(store.snapshot().decks.find(deck => deck.raw.sourceIp === '192.0.2.99')!.publicDeckId, null);
  assert.equal(store.snapshot().representative.publicDeckId, '3', 'unroutable duplicate public IDs cannot become representative');
});

test('representative audit: invalid flag observations stay unknown and a disconnected private OSC view rejects a retained selection', () => {
  const store = new StateStore({ sessionId: 'rep-audit-unknown', mode: 'replay' });
  for (const statusFlags of [undefined, NaN, -1, 256, 1.5]) {
    store.ingestStatus(observation(1, { statusFlags, receivedAt: store.snapshot().session.now + 1 }));
    const master = store.snapshot().decks[0].tempoMaster;
    assert.equal(master.value, null); assert.equal(master.quality, 'unknown');
    assert.equal(store.snapshot().representative.reason, 'playing');
  }
  store.ingestStatus(observation(1, { statusFlags: 0x20, receivedAt: 20 }));
  const privateView = store.snapshot();
  privateView.session.state = 'disconnected';
  const messages = snapshotToOsc(privateView);
  assert.equal(at(messages, '/dj/representative/valid'), 0);
  assert.equal(at(messages, '/dj/representative/reason'), 'none');
  assert.equal(messages.some(message => message.address === '/dj/representative/public_deck_id'), false);
  assert.equal(messages.some(message => message.address === '/dj/representative/effective_bpm'), false);
  assert.equal(at(messages, '/dj/representative/effective_bpm/valid'), 0);
  assert.equal(store.snapshot().representative.publicDeckId, '1', 'private output invalidation must not change source selection');
});

test('representative audit: every UDP fragment carries current identity and no-candidate invalidation without fabricated BPM', async () => {
  const receiver = dgram.createSocket('udp4'); receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  const packets: { bytes: Buffer; messages: OscMessage[] }[] = [];
  receiver.on('message', bytes => packets.push({ bytes, messages: decodeOscPacket(bytes) }));
  const store = new StateStore({ sessionId: 'rep-audit-udp', mode: 'replay' });
  for (const wire of [1, 2, 3, 4]) store.ingestStatus(observation(wire, { statusFlags: wire === 4 ? 0x20 : 0 }));
  for (const deck of store.snapshot().decks) store.applyMetadata({ deckId: deck.deckId, loadGeneration: deck.loadGeneration,
    mediaGeneration: deck.trackRef!.mediaGeneration, title: 'T'.repeat(500), artist: 'A'.repeat(500) }, 1);
  const output = startOsc(store, { host: '127.0.0.1', port: receiver.address().port, maxHz: 100 });
  try {
    await waitFor(() => packets.some(packet => at(packet.messages, '/dj/representative/effective_bpm') === 124));
    const revision = String(store.snapshot().revision);
    const frame = packets.filter(packet => at(packet.messages, '/dj/revision') === revision);
    assert.ok(frame.length > 2, 'long four-deck metadata must exercise fragmented OSC snapshots');
    for (const packet of frame) {
      assert.ok(packet.bytes.length <= 1200);
      assert.equal(at(packet.messages, '/dj/representative/valid'), 1);
      assert.equal(at(packet.messages, '/dj/representative/public_deck_id'), '4');
      assert.equal(at(packet.messages, '/dj/representative/reason'), 'tempo-master');
    }
    assert.equal(at(frame.flatMap(packet => packet.messages), '/dj/representative/deck_id'), store.snapshot().representative.deckId);
    assert.equal(at(frame.flatMap(packet => packet.messages), '/dj/representative/deck_id/valid'), 1);
    const start = packets.length;
    store.setSession({ state: 'disconnected', now: 100 });
    await output.close();
    await waitFor(() => packets.slice(start).some(packet => at(packet.messages, '/dj/representative/effective_bpm/valid') === 0));
    const finalRevision = String(store.snapshot().revision);
    for (const packet of packets.slice(start).filter(packet => at(packet.messages, '/dj/revision') === finalRevision)) {
      assert.equal(at(packet.messages, '/dj/representative/valid'), 0);
      assert.equal(at(packet.messages, '/dj/representative/reason'), 'none');
      assert.equal(packet.messages.some(message => message.address === '/dj/representative/effective_bpm'), false);
      assert.equal(packet.messages.some(message => message.address === '/dj/representative/public_deck_id'), false);
    }
  } finally { await output.close(); receiver.close(); }
});

test('representative audit: OSC destination reapply invalidates a later revision then restores the same source selection', async () => {
  const receiver = dgram.createSocket('udp4'); receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  const records: { revision: number; valid: number; publicId: string | number | undefined }[] = [];
  receiver.on('message', bytes => {
    const messages = decodeOscPacket(bytes), valid = at(messages, '/dj/representative/valid');
    if (valid !== undefined) records.push({ revision: Number(at(messages, '/dj/revision')), valid: Number(valid), publicId: at(messages, '/dj/representative/public_deck_id') });
  });
  const iface: SelectedInterface = { name: 'audit-representative', address: '192.0.2.20', netmask: '255.255.255.0', family: 'IPv4',
    mac: '00:11:22:33:44:55', internal: false, cidr: '192.0.2.20/24', broadcast: '192.0.2.255' };
  const settings = { enabled: true, host: '127.0.0.1', port: receiver.address().port, maxHz: 100, snapshotIntervalMs: 1000 };
  const config: AppConfig = { mode: 'passive', backend: 'native', interfaceName: iface.name, profile: 'auto',
    speed: 1, loop: false, host: '127.0.0.1', port: 0, staleAfterMs: 3000, publicDeckIds: {}, osc: settings };
  const runtime = new RuntimeController(config, {
    listInterfaces: () => [iface],
    async startLive(store) {
      store.ingestStatus(observation(1)); store.ingestStatus(observation(4, { statusFlags: 0x20 }));
      return { async close() {} };
    },
  });
  try {
    await runtime.initialize();
    await waitFor(() => records.some(record => record.valid === 1 && record.publicId === '4'));
    const source = runtime.snapshot();
    const first = records.filter(record => record.valid === 1).at(-1)!;
    await runtime.setOsc(settings);
    await waitFor(() => records.some(record => record.valid === 1 && record.revision > first.revision + 1));
    const invalid = records.find(record => record.valid === 0 && record.revision > first.revision)!;
    const restored = records.find(record => record.valid === 1 && record.revision > invalid.revision)!;
    assert.ok(first.revision < invalid.revision && invalid.revision < restored.revision);
    assert.equal(invalid.publicId, undefined); assert.equal(restored.publicId, '4');
    assert.equal(runtime.snapshot().session.id, source.session.id);
    assert.deepEqual(runtime.snapshot().representative, source.representative);
    assert.deepEqual(runtime.snapshot().decks.map(deck => deck.tempoMaster), source.decks.map(deck => deck.tempoMaster));
  } finally { await runtime.close(); receiver.close(); }
});

test('representative audit: long captured interface identities cannot exceed OSC packet bounds or lose the public representative binding', async () => {
  const receiver = dgram.createSocket('udp4'); receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  const packets: { bytes: Buffer; messages: OscMessage[] }[] = [];
  receiver.on('message', bytes => packets.push({ bytes, messages: decodeOscPacket(bytes) }));
  const store = new StateStore({ sessionId: 'rep-audit-long', mode: 'replay' });
  store.ingestStatus(observation(4, { interfaceId: 'capture:' + 'I'.repeat(700), statusFlags: 0x20 }));
  const deck = store.snapshot().decks[0];
  assert.ok(Buffer.byteLength(deck.deckId) > 512);
  store.applyMetadata({ deckId: deck.deckId, loadGeneration: deck.loadGeneration,
    mediaGeneration: deck.trackRef!.mediaGeneration, title: 'T'.repeat(512), artist: 'A'.repeat(512) }, 1);
  const output = startOsc(store, { host: '127.0.0.1', port: receiver.address().port, maxHz: 100 });
  try {
    await waitFor(() => packets.some(packet => at(packet.messages, '/dj/representative/effective_bpm') === 124));
    assert.ok(packets.every(packet => packet.bytes.length <= 1200));
    for (const packet of packets) {
      assert.equal(at(packet.messages, '/dj/representative/valid'), 1);
      assert.equal(at(packet.messages, '/dj/representative/public_deck_id'), '4');
      assert.equal(at(packet.messages, '/dj/representative/reason'), 'tempo-master');
    }
    const messages = packets.flatMap(packet => packet.messages);
    assert.equal(at(messages, '/dj/representative/deck_id/valid'), 0, 'an oversized normalized ID must explicitly invalidate a previously held ID');
    assert.equal(messages.some(message => message.address === '/dj/representative/deck_id'), false);
    assert.equal(messages.some(message => message.address === '/dj/decks/4/title'), true);
    assert.equal(messages.some(message => message.address === '/dj/decks/4/artist'), true);
  } finally { await output.close(); receiver.close(); }
});
