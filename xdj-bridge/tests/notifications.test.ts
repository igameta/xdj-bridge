import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { StateStore } from '../src/core/store.js';
import type { StatusObservation } from '../src/core/types.js';
import { createMacNotificationSender, MAC_NOTIFICATION_SCRIPT, PlaybackNotifier, type NativeNotification, type NotificationSender } from '../src/output/notifications.js';
import { snapshotToOsc } from '../src/output/osc.js';
import { startServer } from '../src/output/server.js';
import { RuntimeController } from '../src/runtime.js';

const waitFor = async (predicate: () => boolean) => {
  const end = performance.now() + 1000;
  while (!predicate() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 3));
  assert.ok(predicate(), 'Expected notification state was not reached');
};
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const observation = (changes: Partial<StatusObservation> = {}): StatusObservation => ({ interfaceId: 'test', sourceIp: '192.0.2.50', receivedAt: 0, wireDeviceId: 1, model: 'XDJ-AZ', trackId: 100, sourceWireDeviceId: 1, protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 122, pitchPercent: 0, ...changes });
const setup = (enabled = true, options = {}) => {
  const store = new StateStore({ sessionId: 'notifications', mode: 'demo', staleAfterMs: 1000 });
  store.ingestStatus(observation());
  const sent: NativeNotification[] = [];
  const sender: NotificationSender = { supported: true, async send(value) { sent.push(value); } };
  const notifier = new PlaybackNotifier(store, sender, { enabled, coalesceMs: 5, minIntervalMs: 0, timeoutMs: 100, failureBackoffMs: 10, ...options });
  return { store, sent, sender, notifier };
};

test('native sender uses a fixed script, an argv delimiter, no shell, bounded process and cancellable arguments', async () => {
  let calls = 0;
  const value = { title: '-e', subtitle: '"; do shell script "touch /tmp/forbidden"', body: '曲名\0改行\n$(echo unsafe)`unsafe`' };
  const abort = new AbortController();
  const sender = createMacNotificationSender('darwin', (file, args, options, callback) => {
    calls++; assert.equal(file, '/usr/bin/osascript');
    assert.deepEqual(args.slice(0, 5), ['-l', 'AppleScript', '-e', MAC_NOTIFICATION_SCRIPT, '--']);
    assert.equal(args.length, 8); assert.equal(args[5], '-e'); assert.equal(args[6], value.subtitle);
    assert.equal(args[7].includes('\0'), false); assert.match(args[7], /\$\(echo unsafe\)/);
    assert.equal(options.shell, false); assert.equal(options.signal, abort.signal); assert.equal(options.timeout, 2500); assert.equal(options.maxBuffer, 4096);
    assert.equal(MAC_NOTIFICATION_SCRIPT.includes(value.subtitle), false); callback(null);
  });
  await sender.send(value, abort.signal); assert.equal(calls, 1);
  abort.abort(); await assert.rejects(sender.send(value, abort.signal)); assert.equal(calls, 1);
  const unsupported = createMacNotificationSender('linux', () => { throw new Error('Must not execute on unsupported platform'); });
  assert.equal(unsupported.supported, false); await assert.rejects(unsupported.send(value, new AbortController().signal), /macOS/);
});

test('notifications default OFF, enabling establishes a baseline and only known observed state changes send', async () => {
  const { store, sent, notifier } = setup(false);
  try {
    store.ingestStatus(observation({ receivedAt: 1, playState: 5 })); await wait(); assert.equal(sent.length, 0);
    notifier.setEnabled(true); await wait(); assert.equal(sent.length, 0);
    const deck = store.snapshot().decks[0];
    store.applyMetadata({ deckId: deck.deckId, loadGeneration: deck.loadGeneration, mediaGeneration: deck.trackRef!.mediaGeneration, title: 'テスト曲' }, 2);
    store.ingestStatus(observation({ receivedAt: 3, playState: 5, trackBpm: 128 })); await wait(); assert.equal(sent.length, 0);
    store.ingestStatus(observation({ receivedAt: 4, playState: 3, trackBpm: 128 })); await waitFor(() => sent.length === 1);
    assert.deepEqual(sent[0], { title: 'XDJ Bridge · デモ', subtitle: 'Deck 1', body: '再生中 — テスト曲' });
    for (let n = 5; n < 100; n++) store.ingestStatus(observation({ receivedAt: n, playState: 3 }));
    await wait(); assert.equal(sent.length, 1);
  } finally { await notifier.close(); }
});

test('unknown/stale recovery and load replacement establish new baselines without sending stale pending changes', async () => {
  const { store, sent, notifier } = setup(true, { coalesceMs: 30 });
  try {
    store.ingestStatus(observation({ receivedAt: 1, playState: 5 }));
    store.ingestStatus(observation({ receivedAt: 2, playState: 99 })); await wait(40); assert.equal(sent.length, 0);
    store.ingestStatus(observation({ receivedAt: 3, playState: 3 })); await wait(40); assert.equal(sent.length, 0);
    store.ingestStatus(observation({ receivedAt: 4, playState: 5 })); store.tick(1100); await wait(40); assert.equal(sent.length, 0);
    store.ingestStatus(observation({ receivedAt: 1200, playState: 3 })); await wait(40); assert.equal(sent.length, 0);
    store.ingestStatus(observation({ receivedAt: 1201, playState: 5 }));
    store.ingestStatus(observation({ receivedAt: 1202, playState: 3, trackId: 200 })); await wait(40); assert.equal(sent.length, 0);
    store.ingestStatus(observation({ receivedAt: 1203, playState: 6, trackId: 200 })); await waitFor(() => sent.length === 1);
    assert.match(sent[0].body, /キュー待機/);
  } finally { await notifier.close(); }
});

test('coalescing drops net-zero changes, rate limits sends and keeps four decks independent', async () => {
  const { store, sent, notifier } = setup(true, { coalesceMs: 10, minIntervalMs: 15 });
  try {
    store.ingestStatus(observation({ receivedAt: 1, playState: 5 }));
    store.ingestStatus(observation({ receivedAt: 2, playState: 3 })); await wait(25); assert.equal(sent.length, 0);
    for (const wire of [2, 3, 4]) store.ingestStatus(observation({ wireDeviceId: wire, trackId: wire * 100 }));
    for (const wire of [1, 2, 3, 4]) store.ingestStatus(observation({ wireDeviceId: wire, receivedAt: 10, trackId: wire * 100, playState: 5 }));
    await waitFor(() => sent.length === 4);
    assert.deepEqual(sent.map(value => value.subtitle), ['Deck 1', 'Deck 2', 'Deck 3', 'Deck 4']);
    assert.ok(sent.every(value => value.body === '一時停止'));
  } finally { await notifier.close(); }
});

test('OFF and close discard queued changes, abort an active sender, and do not wait for an uncooperative process', async () => {
  const first = setup(true, { coalesceMs: 30 });
  first.store.ingestStatus(observation({ receivedAt: 1, playState: 5 })); first.notifier.setEnabled(false); await wait(40);
  assert.equal(first.sent.length, 0); await first.notifier.close();
  const store = new StateStore({ sessionId: 'abort', mode: 'replay' }); store.ingestStatus(observation());
  let signal: AbortSignal | undefined; let sends = 0;
  const notifier = new PlaybackNotifier(store, { supported: true, send(_value, value) { sends++; signal = value; return new Promise(() => {}); } }, { enabled: true, coalesceMs: 0, timeoutMs: 5000 });
  store.ingestStatus(observation({ receivedAt: 1, playState: 5 })); await waitFor(() => sends === 1);
  await notifier.close(); assert.equal(signal?.aborted, true);
  store.ingestStatus(observation({ receivedAt: 2, playState: 3 })); await wait(); assert.equal(sends, 1);
});

test('notification timeout keeps one sender slot and reports an error while fresh state and OSC continue', async () => {
  const store = new StateStore({ sessionId: 'failure', mode: 'replay' }); store.ingestStatus(observation());
  let release!: () => void; let sends = 0; let errors = 0;
  const notifier = new PlaybackNotifier(store, { supported: true, async send() {
    sends++; if (sends === 1) await new Promise<void>(resolve => { release = resolve; });
  } }, { enabled: true, coalesceMs: 0, minIntervalMs: 0, timeoutMs: 15, failureBackoffMs: 10, onError() { errors++; } });
  try {
    store.ingestStatus(observation({ receivedAt: 1, playState: 5 })); await waitFor(() => notifier.getStatus().error !== null);
    assert.equal(errors, 1); await wait(15);
    store.ingestStatus(observation({ receivedAt: 2, playState: 3, trackBpm: 130 })); await wait(10); assert.equal(sends, 1);
    assert.equal(store.snapshot().decks[0].trackBpm.value, 130);
    assert.deepEqual(snapshotToOsc(store.snapshot()).find(m => m.address === '/dj/decks/1/bpm/valid')?.args, [1]);
    release(); await waitFor(() => sends === 2); await waitFor(() => notifier.getStatus().error === null);
  } finally { release?.(); await notifier.close(); }
});

test('config validates notification types and runtime exposes/supports the new toggle without native calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xdj-notification-config-'));
  try {
    const path = join(dir, 'config.json');
    for (const notifications of [false, [], null, { enabled: 'true' }]) {
      await writeFile(path, JSON.stringify({ notifications })); await assert.rejects(parseConfig(['--config', path]), /notifications/);
    }
    await writeFile(path, JSON.stringify({ notifications: { enabled: true } }));
    assert.equal((await parseConfig(['--config', path])).notifications?.enabled, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const runtime = new RuntimeController(await parseConfig([]), { listInterfaces: () => [], notificationSender: { supported: true, async send() { throw new Error('No state means no send'); } } });
  try {
    assert.deepEqual(runtime.getRuntime().notifications, { enabled: false, supported: true, error: null });
    await runtime.setNotifications({ enabled: true }); assert.equal(runtime.getRuntime().notifications.enabled, true);
    await assert.rejects(runtime.setNotifications({ enabled: 'true' })); assert.equal(runtime.getRuntime().notifications.enabled, true);
    await runtime.setNotifications({ enabled: false }); assert.equal(runtime.getRuntime().notifications.enabled, false);
  } finally { await runtime.close(); }
  const unsupported = new RuntimeController(await parseConfig([]), { listInterfaces: () => [], notificationSender: { supported: false, async send() {} } });
  try { await assert.rejects(unsupported.setNotifications({ enabled: true }), /macOS/); assert.equal(unsupported.getRuntime().notifications.enabled, false); }
  finally { await unsupported.close(); }
});

test('notification settings HTTP API shares existing JSON/origin protection and preserves optional controls compatibility', async () => {
  const runtime = new RuntimeController(await parseConfig([]), { listInterfaces: () => [], notificationSender: { supported: true, async send() { throw new Error('No OS notification should occur'); } } });
  const server = await startServer(runtime, { port: 0, runtime: () => runtime.getRuntime(), controls: runtime });
  try {
    const post = (value: unknown, headers = {}) => fetch(server.url + '/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
    const enabled = await post({ enabled: true }); assert.equal(enabled.status, 200);
    assert.equal((await enabled.json() as { notifications: { enabled: boolean } }).notifications.enabled, true);
    assert.equal((await post({ enabled: 1 })).status, 400);
    assert.equal((await post({ enabled: false }, { Origin: 'https://example.invalid' })).status, 403);
    assert.equal(runtime.getRuntime().notifications.enabled, true);
    assert.equal((await post({ enabled: false })).status, 200);
  } finally { await runtime.close(); await server.close(); }
  const store = new StateStore({ sessionId: 'mock', mode: 'idle' });
  const legacy = await startServer(store, { port: 0, controls: { async connect() {}, async disconnect() {}, async setOsc() {} } });
  try {
    const response = await fetch(legacy.url + '/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' }); assert.equal(response.status, 501);
  } finally { await legacy.close(); }
});
