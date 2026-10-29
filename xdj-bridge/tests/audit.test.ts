import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { StateStore } from '../src/core/store.js';
import type { PacketEnvelope, StatusObservation } from '../src/core/types.js';
import { MAGIC } from '../src/core/decoder.js';
import { decodeOscPacket, snapshotToOsc, startOsc, type OscMessage } from '../src/output/osc.js';
import { ProviderScheduler } from '../src/adapters/providers.js';
import { selectInterface, type SelectedInterface } from '../src/transport/live.js';

const observation = (changes: Partial<StatusObservation> = {}): StatusObservation => ({
  interfaceId: 'capture:0', sourceIp: '192.0.2.10', receivedAt: 0,
  wireDeviceId: 1, model: 'CDJ-3000', trackId: 1, sourceWireDeviceId: 1,
  protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 122,
  pitchPercent: 0, beat: null, ...changes,
});
const envelope = (bytes: Buffer, receivedAt: number, destinationPort = 50001): PacketEnvelope => ({
  sessionId: 'audit', interfaceId: 'capture:0', sourceIp: '192.0.2.10',
  sourcePort: destinationPort, destinationIp: '192.0.2.20', destinationPort,
  transport: 'replay', bytes, receivedAt,
});

test('audit: track invalidation reaches OSC validity and rejects delayed metadata', () => {
  const store = new StateStore({ sessionId: 'audit', mode: 'replay' });
  store.ingestStatus(observation());
  const previous = store.snapshot().decks[0];
  const oldResponse = {
    deckId: previous.deckId, loadGeneration: previous.loadGeneration,
    mediaGeneration: previous.trackRef!.mediaGeneration, title: 'Previous track', artist: 'Previous artist',
  };
  assert.equal(store.applyMetadata(oldResponse, 1), true);
  assert.ok(snapshotToOsc(store.snapshot()).some(message => message.address === '/dj/decks/1/title'));
  store.ingestStatus(observation({ trackId: 2, receivedAt: 2 }));
  assert.equal(store.applyMetadata(oldResponse, 3), false);
  const messages = snapshotToOsc(store.snapshot());
  for (const field of ['title', 'artist', 'position_ms', 'on_air']) {
    assert.equal(messages.some(message => message.address === `/dj/decks/1/${field}`), false);
    assert.deepEqual(messages.find(message => message.address === `/dj/decks/1/${field}/valid`)?.args, [0]);
  }
  assert.deepEqual(messages.find(message => message.address === '/dj/decks/1/bpm')?.args, [122]);
});

test('audit: per-feature availability follows a newly valid beat counter', () => {
  const store = new StateStore({ sessionId: 'audit', mode: 'replay' });
  store.ingestStatus(observation());
  assert.equal(store.snapshot().decks[0].capabilities.beat.availability, 'unavailable');
  store.ingestStatus(observation({ receivedAt: 100, beat: 42 }));
  const deck = store.snapshot().decks[0];
  assert.equal(deck.beat.value, 42);
  assert.equal(deck.capabilities.beat.availability, 'available');
});

test('audit: a media change clears metadata availability as well as its values', () => {
  const store = new StateStore({ sessionId: 'audit', mode: 'replay' });
  store.ingestStatus(observation());
  const previous = store.snapshot().decks[0];
  store.applyMetadata({ deckId: previous.deckId, loadGeneration: previous.loadGeneration,
    mediaGeneration: previous.trackRef!.mediaGeneration, title: 'Old media' }, 1);
  assert.equal(store.snapshot().decks[0].capabilities.metadata.availability, 'available');
  store.invalidateMedia(previous.trackRef!.sourceDeviceId, previous.trackRef!.protocolSlot, 2);
  const current = store.snapshot().decks[0];
  assert.equal(current.title.value, null);
  assert.notEqual(current.capabilities.metadata.availability, 'available');
});

test('audit: a lost position stream becomes unavailable while status stays fresh', () => {
  const store = new StateStore({ sessionId: 'audit', mode: 'replay', staleAfterMs: 1000 });
  store.ingestStatus(observation());
  const packet = Buffer.alloc(0x34);
  MAGIC.copy(packet); packet[10] = 0x0b; packet.write('CDJ-3000', 11);
  packet[0x21] = 1; packet.writeUInt16BE(0x10, 0x22);
  packet.writeUInt32BE(180, 0x24); packet.writeUInt32BE(5000, 0x28);
  store.ingest(envelope(packet, 10));
  assert.equal(store.snapshot().decks[0].capabilities.position.availability, 'available');
  store.ingestStatus(observation({ receivedAt: 500 }));
  store.ingestStatus(observation({ receivedAt: 1009 }));
  store.tick(1011);
  const deck = store.snapshot().decks[0];
  assert.equal(deck.trackBpm.freshness, 'fresh');
  assert.equal(deck.positionMs.value, 5000);
  assert.equal(deck.positionMs.freshness, 'stale');
  assert.equal(deck.capabilities.position.availability, 'unavailable');
  const osc = snapshotToOsc(store.snapshot());
  assert.deepEqual(osc.find(message => message.address === '/dj/decks/1/position_ms/valid')?.args, [0]);
});

test('audit: overlapping IPv4 interfaces fail before any participation', () => {
  const make = (name: string, address: string, netmask: string): SelectedInterface => ({
    name, address, netmask, family: 'IPv4', mac: '00:11:22:33:44:55', internal: false,
    cidr: address + '/16', broadcast: '169.254.255.255',
  });
  const selected = make('usb0', '169.254.10.1', '255.255.0.0');
  const overlapping = make('wifi0', '169.254.20.1', '255.255.0.0');
  assert.throws(() => selectInterface('usb0', [selected, overlapping]), /overlapping/);
  assert.equal(selectInterface('usb0', [selected, make('wifi0', '192.168.1.1', '255.255.255.0')]), selected);
});

test('audit: a timed-out provider keeps its slot until it actually settles', async () => {
  const scheduler = new ProviderScheduler(1, 20, 4);
  let release!: () => void;
  let secondStarted = false;
  const first = scheduler.run(() => new Promise<void>(resolve => { release = resolve; }));
  const timeout = assert.rejects(first, /timed out/);
  const second = scheduler.run(async () => { secondStarted = true; return 2; });
  try {
    await timeout;
    assert.equal(secondStarted, false, 'timeouts must not permit unbounded orphan requests');
    release();
    assert.equal(await second, 2);
  } finally { scheduler.close(); }
});

test('audit: immediate OSC shutdown flushes the final invalidation over UDP', async () => {
  const receiver = dgram.createSocket('udp4');
  receiver.bind(0, '127.0.0.1');
  await once(receiver, 'listening');
  const messages: OscMessage[] = [];
  receiver.on('message', bytes => messages.push(...decodeOscPacket(bytes)));
  const store = new StateStore({ sessionId: 'audit', mode: 'replay' });
  store.ingestStatus(observation());
  const output = startOsc(store, { host: '127.0.0.1', port: receiver.address().port, maxHz: 100 });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = performance.now() + 1000;
    while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), 'Expected OSC datagram did not arrive');
  };
  try {
    await waitFor(() => messages.some(message => message.address === '/dj/decks/1/bpm/valid' && message.args[0] === 1));
    const start = messages.length;
    store.setSession({ state: 'disconnected', now: 100 });
    await output.close();
    await waitFor(() => messages.slice(start).some(message => message.address === '/dj/decks/1/bpm/valid' && message.args[0] === 0));
  } finally { await output.close(); receiver.close(); }
});

test('audit: four AZ decks share media ownership even when source deck status arrives last', () => {
  const store = new StateStore({ sessionId: 'audit-four', mode: 'replay' });
  for (const wire of [4, 3, 2]) store.ingestStatus(observation({ model: 'XDJ-AZ', wireDeviceId: wire, trackId: 100 + wire }));
  const unresolved = store.snapshot().decks.find(deck => deck.wireDeviceId === 4)!;
  const unresolvedResponse = { deckId: unresolved.deckId, loadGeneration: unresolved.loadGeneration,
    mediaGeneration: unresolved.trackRef!.mediaGeneration, title: 'Title requested before owner discovery' };
  assert.equal(store.applyMetadata(unresolvedResponse, 1), true);
  store.ingestStatus(observation({ model: 'XDJ-AZ', wireDeviceId: 1, trackId: 101, receivedAt: 2 }));
  assert.equal(store.snapshot().decks.find(deck => deck.wireDeviceId === 4)!.title.value, null);
  assert.equal(store.applyMetadata(unresolvedResponse, 3), false, 'responses from the unresolved owner generation must be rejected');
  const decks = store.snapshot().decks;
  assert.equal(new Set(decks.map(deck => deck.physicalDeviceId)).size, 1);
  assert.equal(new Set(decks.map(deck => deck.trackRef!.sourceDeviceId)).size, 1,
    'packet arrival order must not split the shared AZ media into different owners');
  const source = decks.find(deck => deck.wireDeviceId === 1)!;
  const fourth = decks.find(deck => deck.wireDeviceId === 4)!;
  const response = { deckId: fourth.deckId, loadGeneration: fourth.loadGeneration,
    mediaGeneration: fourth.trackRef!.mediaGeneration, title: 'Previous USB track', artist: 'Previous USB artist' };
  assert.equal(store.applyMetadata(response, 4), true);
  store.invalidateMedia(source.trackRef!.sourceDeviceId, 3, 5);
  assert.equal(store.snapshot().decks.find(deck => deck.wireDeviceId === 4)!.title.value, null);
  assert.equal(store.applyMetadata(response, 6), false);
});

test('audit: four-deck OSC routing isolates unknown and stale playback and recovers deck four', () => {
  const store = new StateStore({ sessionId: 'audit-four-routing', mode: 'replay', staleAfterMs: 1000,
    publicDeckIds: Object.fromEntries([1, 2, 3, 4].map(wire => [`192.0.2.10:${wire}`, `az${wire}`])) });
  const playStates = [3, 5, 99, 7];
  for (const wire of [1, 4, 2, 3]) store.ingestStatus(observation({ model: 'XDJ-AZ', wireDeviceId: wire,
    trackId: 100 + wire, trackBpm: 120 + wire, playState: playStates[wire - 1] }));
  for (const wire of [1, 2, 3]) store.ingestStatus(observation({ model: 'XDJ-AZ', wireDeviceId: wire,
    trackId: 100 + wire, trackBpm: 120 + wire, playState: playStates[wire - 1], receivedAt: 750 }));
  store.tick(1100);
  const messages = snapshotToOsc(store.snapshot());
  for (const wire of [1, 2, 3]) assert.deepEqual(messages.find(message => message.address === `/dj/decks/az${wire}/bpm`)?.args, [120 + wire]);
  assert.deepEqual(messages.find(message => message.address === '/dj/decks/az1/playing')?.args, [1]);
  assert.deepEqual(messages.find(message => message.address === '/dj/decks/az2/playing')?.args, [0]);
  for (const wire of [3, 4]) {
    assert.deepEqual(messages.find(message => message.address === `/dj/decks/az${wire}/playing/valid`)?.args, [0]);
    assert.equal(messages.some(message => message.address === `/dj/decks/az${wire}/playing`), false);
  }
  assert.equal(store.snapshot().decks.find(deck => deck.wireDeviceId === 1)!.playbackState.freshness, 'fresh');
  assert.equal(store.snapshot().decks.find(deck => deck.wireDeviceId === 4)!.playbackState.freshness, 'stale');
  store.ingestStatus(observation({ model: 'XDJ-AZ', wireDeviceId: 4, trackId: 104, trackBpm: 124, playState: 7, receivedAt: 1120 }));
  const recovered = snapshotToOsc(store.snapshot());
  assert.deepEqual(recovered.find(message => message.address === '/dj/decks/az4/playing/valid')?.args, [1]);
  assert.deepEqual(recovered.find(message => message.address === '/dj/decks/az4/playing')?.args, [1]);
  assert.deepEqual(recovered.find(message => message.address === '/dj/decks/az4/bpm')?.args, [124]);
  assert.equal(store.snapshot().decks.length, 4);
});

test('audit: a deck-three reload does not replace another decks title or OSC identity', () => {
  const store = new StateStore({ sessionId: 'audit-four-titles', mode: 'replay' });
  for (const wire of [1, 4, 2, 3]) store.ingestStatus(observation({ model: 'XDJ-AZ', wireDeviceId: wire, trackId: 100 + wire }));
  const before = store.snapshot().decks;
  const responses = before.map(deck => ({ deckId: deck.deckId, loadGeneration: deck.loadGeneration,
    mediaGeneration: deck.trackRef!.mediaGeneration, title: `Title ${deck.wireDeviceId}`, artist: `Artist ${deck.wireDeviceId}` }));
  for (const response of responses) assert.equal(store.applyMetadata(response, 1), true);
  store.ingestStatus(observation({ model: 'XDJ-AZ', wireDeviceId: 3, trackId: 303, receivedAt: 100 }));
  const third = store.snapshot().decks.find(deck => deck.wireDeviceId === 3)!;
  assert.equal(store.applyMetadata(responses.find(response => response.deckId === third.deckId)!, 101), false);
  const messages = snapshotToOsc(store.snapshot());
  assert.deepEqual(messages.find(message => message.address === '/dj/decks/3/title/valid')?.args, [0]);
  for (const wire of [1, 2, 4]) {
    assert.deepEqual(messages.find(message => message.address === `/dj/decks/${wire}/title`)?.args, [`Title ${wire}`]);
    assert.deepEqual(messages.find(message => message.address === `/dj/decks/${wire}/track_id`)?.args, [String(100 + wire)]);
  }
});

test('audit: an AZ deck keeps an observed external media owner rather than guessing its own chassis', () => {
  const store = new StateStore({ sessionId: 'audit-four-external', mode: 'replay' });
  store.ingestStatus(observation({ sourceIp: '192.0.2.30', model: 'CDJ-3000', wireDeviceId: 1 }));
  const external = store.snapshot().decks[0].physicalDeviceId;
  store.ingestStatus(observation({ model: 'XDJ-AZ', wireDeviceId: 4, sourceWireDeviceId: 1, trackId: 404 }));
  const az = store.snapshot().decks.find(deck => deck.model === 'XDJ-AZ')!;
  assert.equal(az.trackRef!.sourceDeviceId, external);
  assert.notEqual(az.trackRef!.sourceDeviceId, az.physicalDeviceId);
});
