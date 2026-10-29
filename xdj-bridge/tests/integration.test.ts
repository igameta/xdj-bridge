import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { attachMetadataProvider, ProviderScheduler, type MetadataRequest } from '../src/adapters/providers.js';
import { parseConfig } from '../src/config.js';
import { StateStore } from '../src/core/store.js';
import type { StatusObservation } from '../src/core/types.js';
import { announcementPacket, claimedNumber, inNetwork, joinPackets, keepAlive, pickNumber, selectInterface, type SelectedInterface } from '../src/transport/live.js';

const iface = (changes: Partial<SelectedInterface> = {}): SelectedInterface => ({ name: 'en6', address: '169.254.77.195', netmask: '255.255.0.0', family: 'IPv4', mac: '00:11:22:33:44:55', internal: false, cidr: '169.254.77.195/16', broadcast: '169.254.255.255', ...changes });
const status = (changes: Partial<StatusObservation> = {}): StatusObservation => ({ interfaceId: 'en6', sourceIp: '169.254.95.63', receivedAt: 0, wireDeviceId: 11, model: 'XDJ-RX3', trackId: 1, sourceWireDeviceId: 11, protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 122, pitchPercent: 0, ...changes });
async function jsonConfig(value: unknown, action: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'xdj-config-test-'));
  try { const path = join(dir, 'config.json'); await writeFile(path, JSON.stringify(value)); await action(path); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test('explicit network interface selection rejects overlapping and ambiguous routes before joining', () => {
  const selected = iface();
  const independent = iface({ name: 'en0', address: '192.168.1.2', netmask: '255.255.255.0' });
  assert.equal(selectInterface('en6', [selected, independent]), selected);
  assert.equal(inNetwork('169.254.95.63', selected), true); assert.equal(inNetwork('192.168.1.2', selected), false);
  const overlap = iface({ name: 'en0', address: '169.254.77.1', netmask: '255.255.255.0' });
  assert.throws(() => selectInterface('en6', [selected, overlap]), /overlapping/);
  assert.throws(() => selectInterface('en6', [selected, iface({ address: '169.254.77.196' })]), /single active/);
  assert.throws(() => selectInterface('en6', [iface({ netmask: '255.255.255.255' })]), /broadcast/);
  assert.throws(() => selectInterface('missing', [selected]), /single active/);
});
test('native join and keepalive packet bytes match the prior verified Python implementation', async () => {
  const expected = JSON.parse(await readFile(new URL('../../tests/fixtures/join-packets.json', import.meta.url), 'utf8')) as { join: string[]; keepAlive: string };
  assert.deepEqual(joinPackets(iface(), 8).map(p => p.toString('hex')), expected.join);
  assert.equal(keepAlive(iface(), 8).toString('hex'), expected.keepAlive);
  assert.throws(() => announcementPacket(6, 2, Buffer.alloc(0), 'too long a device name for the protocol'), /ASCII/);
});
test('virtual number selection uses observed claims and never silently overrides a requested conflict', () => {
  assert.equal(pickNumber(new Set()), 7); assert.equal(pickNumber(new Set([7, 11, 12])), 8);
  assert.equal(pickNumber(new Set([7, 8])), 9);
  assert.throws(() => pickNumber(new Set([7, 8, 9])), /No free/);
  assert.throws(() => pickNumber(new Set([8]), 8), /No free/);
  assert.throws(() => pickNumber(new Set(), 1), /7, 8 or 9/);
  const packets = joinPackets(iface(), 8);
  assert.equal(claimedNumber(packets[0]), null); assert.equal(claimedNumber(packets[3]), null);
  for (const p of [...packets.slice(6), keepAlive(iface(), 8)]) assert.equal(claimedNumber(p), 8);
  const wrongMagic = Buffer.from(keepAlive(iface(), 8)); wrongMagic[0] = 0;
  assert.equal(claimedNumber(wrongMagic), null); assert.equal(claimedNumber(Buffer.alloc(10)), null);
});
test('configuration validates JSON types and duplicate OSC public IDs', async () => {
  const invalid: unknown[] = [null, [], 5, { loop: 'false' }, { speed: '2' }, { staleAfterMs: -1 }, { port: 65536 },
    { mode: 'passive', interfaceName: 7 }, { mode: 'replay', capture: 3 }, { publicDeckIds: { a: '1', b: '1' } },
    { publicDeckIds: { a: '/bad' } }, { osc: false }, { osc: [] }, { osc: { host: '127.0.0.1', port: 9000, enabled: 'false' } },
    { osc: { host: '127.0.0.1', port: 9000, maxHz: 0 } }, { osc: { host: '127.0.0.1', port: 9000, snapshotIntervalMs: 1 } }];
  for (const value of invalid) await jsonConfig(value, async path => { await assert.rejects(parseConfig(['--config', path]), () => true, JSON.stringify(value)); });
  await jsonConfig({ mode: 'replay', capture: 'sample.pcap', loop: false, publicDeckIds: { '169.254.95.63:11': 'rx1' }, osc: { enabled: false, host: '127.0.0.1', port: 9000, maxHz: 30 } }, async path => {
    const config = await parseConfig(['--config', path, '--speed', '2']);
    assert.equal(config.mode, 'replay'); assert.equal(config.speed, 2); assert.equal(config.loop, false); assert.equal(config.osc?.enabled, false);
  });
  await assert.rejects(parseConfig(['--mode', 'passive']), /interface/);
  await assert.rejects(parseConfig(['--mode', 'virtual-device', '--backend', 'alphatheta', '--interface', 'en6']), /capture-only/);
});
test('timed out operations retain concurrency slots until the underlying promise settles', async () => {
  const scheduler = new ProviderScheduler(1, 25, 2);
  let finish!: (value: string) => void;
  const first = scheduler.run(() => new Promise<string>(resolve => { finish = resolve; }));
  await assert.rejects(first, /timed out/);
  let started = false;
  const second = scheduler.run(async () => { started = true; return 'second'; });
  await delay(10); assert.equal(started, false);
  finish('late first'); assert.equal(await second, 'second'); assert.equal(started, true);
  scheduler.close();
  await assert.rejects(scheduler.run(async () => 'forbidden'), /stopped/);
});
test('scheduler bounds its waiting queue and rejects queued work on shutdown', async () => {
  const scheduler = new ProviderScheduler(1, 1000, 1);
  let finish!: (value: void) => void;
  const running = scheduler.run(() => new Promise<void>(resolve => { finish = resolve; }));
  const waiting = scheduler.run(async () => 'queued');
  const full = scheduler.run(async () => 'overflow');
  await assert.rejects(full, /queue full/);
  scheduler.close();
  await assert.rejects(running, /stopped/); await assert.rejects(waiting, /stopped/);
  finish();
});
test('metadata completion and failure only affect the matching load/media generations', async () => {
  const store = new StateStore({ sessionId: 'providers', mode: 'replay' });
  const requests: { request: MetadataRequest; resolve: (value: { title?: string; artist?: string }) => void; reject: (reason: Error) => void }[] = [];
  const detach = attachMetadataProvider(store, {
    id: 'test-provider', supports: () => true,
    fetch: request => new Promise((resolve, reject) => { requests.push({ request, resolve, reject }); }),
  }, new ProviderScheduler(3, 1000));
  try {
    store.ingestStatus(status()); await delay(0); assert.equal(requests.length, 1);
    store.ingestStatus(status({ receivedAt: 10, trackId: 2 })); await delay(0); assert.equal(requests.length, 2);
    requests[0].reject(new Error('old track failed')); await delay(0);
    assert.equal(store.snapshot().decks[0].capabilities.metadata.availability, 'idle');
    requests[1].resolve({ title: 'Current', artist: 'Artist' }); await delay(0);
    assert.equal(store.snapshot().decks[0].title.value, 'Current');
    assert.equal(store.snapshot().decks[0].capabilities.metadata.availability, 'available');
    store.ingestStatus(status({ receivedAt: 20, trackId: 3 })); await delay(0);
    requests[2].reject(new Error('current media refused')); await delay(0);
    const failed = store.snapshot().decks[0]; assert.equal(failed.title.value, null);
    assert.equal(failed.capabilities.metadata.availability, 'unavailable'); assert.equal(failed.capabilities.metadata.verification, 'implemented-unverified');
    for (let n = 0; n < 10; n++) store.ingestStatus(status({ receivedAt: 30 + n, trackId: 3 }));
    await delay(0); assert.equal(requests.length, 3); // finite once-per-load, no polling flood
    store.ingestStatus(status({ receivedAt: 50, trackId: 4 })); await delay(0);
    const d = store.snapshot().decks[0]; store.invalidateMedia(d.trackRef!.sourceDeviceId, 3, 60); await delay(0);
    assert.equal(requests.length, 5);
    requests[3].resolve({ title: 'Old USB title' }); await delay(0);
    assert.equal(store.snapshot().decks[0].title.value, null);
    requests[4].resolve({ title: 'New USB title' }); await delay(0);
    assert.equal(store.snapshot().decks[0].title.value, 'New USB title');
  } finally { detach(); }
});
