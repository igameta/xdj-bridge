import assert from 'node:assert/strict';
import os from 'node:os';
import { request } from 'node:http';
import test from 'node:test';
import { StateStore } from '../src/core/store.js';
import type { PlaybackState, Snapshot, StateSource } from '../src/core/types.js';
import { createMacNotificationSender, MAC_NOTIFICATION_SCRIPT, PlaybackNotifier, type NativeNotification } from '../src/output/notifications.js';
import { snapshotToOsc } from '../src/output/osc.js';
import { startServer } from '../src/output/server.js';
import { RuntimeController } from '../src/runtime.js';
import { parseConfig } from '../src/config.js';

const sleep = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 1200;
  while (!predicate() && performance.now() < deadline) await sleep(2);
  assert.ok(predicate(), 'Expected notification event did not arrive');
}
function seed(): Snapshot {
  const store = new StateStore({ sessionId: 'notification-audit', mode: 'replay' });
  for (const wire of [1, 2, 3, 4]) store.ingestStatus({ interfaceId: 'audit0', sourceIp: '192.0.2.10', receivedAt: 0,
    wireDeviceId: wire, model: 'XDJ-AZ', trackId: wire * 100, sourceWireDeviceId: 1, protocolSlot: 3,
    trackType: 1, playState: 3, trackBpm: 120 + wire, pitchPercent: 0 });
  return store.snapshot();
}
class Source implements StateSource {
  private state = seed();
  private listeners = new Set<(snapshot: Snapshot) => void>();
  snapshot() { return structuredClone(this.state); }
  subscribe(listener: (snapshot: Snapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  publish(update: (snapshot: Snapshot) => void) {
    update(this.state); this.state.revision++;
    for (const listener of this.listeners) listener(this.snapshot());
  }
  play(wire: number, state: PlaybackState | null) {
    this.publish(snapshot => {
      const deck = snapshot.decks.find(value => value.wireDeviceId === wire)!;
      deck.playbackState.value = state; deck.stateRevision++;
    });
  }
}
const fast = { coalesceMs: 2, minIntervalMs: 0, timeoutMs: 100, failureBackoffMs: 10 };

test('notification audit: hostile and oversized text remains bounded argv with a fixed AppleScript', async () => {
  const invocations: Array<{ file: string; args: string[] }> = [];
  const sender = createMacNotificationSender('darwin', (file, args, options, callback) => {
    invocations.push({ file, args });
    assert.equal(options.shell, false); assert.equal(options.timeout, 2500); callback(null);
  });
  const payloads = [
    { title: '-e', subtitle: '"; do shell script "unexpected-command"', body: '$(unexpected)`command`\n曲名\0アーティスト' },
    { title: '🎵'.repeat(400), subtitle: '-l JavaScript ' + 'a'.repeat(400), body: '\r\t' + '曲'.repeat(2000) },
  ];
  for (const payload of payloads) await sender.send(payload, new AbortController().signal);
  assert.equal(invocations.length, 2);
  for (const invocation of invocations) {
    assert.equal(invocation.file, '/usr/bin/osascript');
    assert.deepEqual(invocation.args.slice(0, 5), ['-l', 'AppleScript', '-e', MAC_NOTIFICATION_SCRIPT, '--']);
    assert.equal(invocation.args.length, 8);
    for (const [index, limit] of [[5, 80], [6, 80], [7, 300]]) {
      assert.ok([...invocation.args[index]].length <= limit);
      assert.doesNotMatch(invocation.args[index], /[\u0000-\u001f\u007f]/);
    }
  }
  assert.equal(invocations[0].args[5], '-e');
  assert.equal(invocations[0].args[6], payloads[0].subtitle);
  assert.ok(invocations[0].args[7].includes('$(unexpected)`command`'));
  assert.equal(MAC_NOTIFICATION_SCRIPT.includes('unexpected-command'), false);
});

test('notification audit: partial degradation, stale and estimated recovery preserve per-deck baselines', async () => {
  const source = new Source(), sent: NativeNotification[] = [];
  const notifier = new PlaybackNotifier(source, { supported: true, async send(value) { sent.push(value); } }, { enabled: true, ...fast });
  try {
    source.publish(snapshot => { snapshot.session.state = 'degraded'; snapshot.decks[3].playbackState.freshness = 'stale'; });
    source.play(1, 'paused'); await waitFor(() => sent.length === 1);
    assert.equal(sent[0].subtitle, 'Deck 1');
    assert.match(sent[0].title, /キャプチャ再生/);
    source.publish(snapshot => { snapshot.decks[3].playbackState.freshness = 'fresh'; snapshot.decks[3].playbackState.value = 'paused'; });
    source.publish(snapshot => { snapshot.decks[1].playbackState.quality = 'estimated'; snapshot.decks[1].playbackState.value = 'paused'; });
    source.publish(snapshot => { snapshot.decks[1].playbackState.quality = 'observed'; snapshot.decks[1].playbackState.value = 'playing'; });
    for (let index = 0; index < 1000; index++) source.publish(() => {});
    await sleep(); assert.equal(sent.length, 1);
    source.play(4, 'playing'); await waitFor(() => sent.length === 2);
    assert.equal(sent[1].subtitle, 'Deck 4');
  } finally { await notifier.close(); }
});

test('notification audit: session and load-generation changes cancel pending messages without a new initial alert', async () => {
  const source = new Source(), sent: NativeNotification[] = [];
  const notifier = new PlaybackNotifier(source, { supported: true, async send(value) { sent.push(value); } }, { enabled: true, ...fast, coalesceMs: 15 });
  try {
    source.play(1, 'paused');
    source.publish(snapshot => { snapshot.session.id = 'new-session'; snapshot.decks[0].playbackState.value = 'playing'; });
    await sleep(25); assert.equal(sent.length, 0);
    source.play(1, 'paused');
    source.publish(snapshot => { snapshot.decks[0].loadGeneration++; snapshot.decks[0].playbackState.value = 'cued'; });
    await sleep(25); assert.equal(sent.length, 0);
    source.play(1, 'playing'); await waitFor(() => sent.length === 1);
    assert.match(sent[0].body, /再生中/);
  } finally { await notifier.close(); }
});

test('notification audit: a blocked sender retains its slot and the waiting queue stays bounded', async () => {
  const source = new Source(), sent: NativeNotification[] = [];
  let release!: () => void, active = 0, maximum = 0;
  const notifier = new PlaybackNotifier(source, { supported: true, async send(value) {
    sent.push(value); active++; maximum = Math.max(maximum, active);
    try { if (sent.length === 1) await new Promise<void>(resolve => { release = resolve; }); }
    finally { active--; }
  } }, { enabled: true, ...fast, coalesceMs: 0, timeoutMs: 1000, maxPending: 2 });
  try {
    source.play(1, 'paused'); await waitFor(() => sent.length === 1);
    for (const wire of [2, 3, 4]) source.play(wire, 'paused');
    await sleep(); assert.equal(sent.length, 1);
    release(); await waitFor(() => sent.length === 3);
    await sleep(); assert.equal(sent.length, 3); assert.equal(maximum, 1);
    assert.deepEqual(sent.map(value => value.subtitle), ['Deck 1', 'Deck 3', 'Deck 4']);
  } finally { release?.(); await notifier.close(); }
});

test('notification audit: OFF/ON and close suppress canceled jobs and ignore a late old failure', async () => {
  const source = new Source(), sent: NativeNotification[] = [];
  let rejectOld!: (error: Error) => void, oldSignal: AbortSignal | undefined;
  const notifier = new PlaybackNotifier(source, { supported: true, send(value, signal) {
    sent.push(value);
    if (sent.length === 1) { oldSignal = signal; return new Promise<void>((_resolve, reject) => { rejectOld = reject; }); }
    return Promise.resolve();
  } }, { enabled: true, ...fast, coalesceMs: 0 });
  try {
    source.play(1, 'paused'); await waitFor(() => sent.length === 1);
    source.play(2, 'paused'); notifier.setEnabled(false);
    assert.equal(oldSignal?.aborted, true);
    source.play(1, 'playing'); notifier.setEnabled(true);
    rejectOld(new Error('Old canceled request failed')); await sleep();
    assert.equal(sent.length, 1); assert.equal(notifier.getStatus().error, null);
    source.play(3, 'paused'); await waitFor(() => sent.length === 2);
    source.play(4, 'paused'); await notifier.close(); await sleep();
    assert.equal(sent.length, 2); assert.equal(notifier.getStatus().enabled, false);
  } finally { rejectOld?.(new Error('cleanup')); await notifier.close(); }
});

test('notification audit: a synchronous sender failure and a throwing diagnostic callback cannot stop state or OSC', async () => {
  const source = new Source(); let sends = 0;
  const notifier = new PlaybackNotifier(source, { supported: true, send() { sends++; throw new Error('Injected sender failure'); } },
    { enabled: true, ...fast, onError() { throw new Error('Injected diagnostic failure'); } });
  try {
    source.play(1, 'paused'); await waitFor(() => notifier.getStatus().error !== null);
    assert.equal(sends, 1); assert.match(notifier.getStatus().error!, /Injected sender failure/);
    source.publish(snapshot => { snapshot.decks[0].trackBpm.value = 140; });
    assert.equal(source.snapshot().decks[0].playbackState.freshness, 'fresh');
    assert.deepEqual(snapshotToOsc(source.snapshot()).find(value => value.address === '/dj/decks/1/bpm')?.args, [140]);
  } finally { await notifier.close(); }
});

test('notification audit: the API rejects cross-site, oversized, wrong-type and non-loopback mutation without sending OS notifications', async () => {
  let sends = 0;
  const runtime = new RuntimeController(await parseConfig([]), { listInterfaces: () => [], notificationSender: { supported: true, async send() { sends++; } } });
  const server = await startServer(runtime, { port: 0, controls: runtime, runtime: () => runtime.getRuntime() });
  const post = (body: string, headers: Record<string, string> = {}) => fetch(server.url + '/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  try {
    assert.equal((await post('{"enabled":true}', { Origin: 'https://untrusted.invalid' })).status, 403);
    assert.equal((await post('{"enabled":true}', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(JSON.stringify({ enabled: true, padding: 'x'.repeat(5000) }))).status, 413);
    assert.equal((await post('{"enabled":"true"}')).status, 400);
    assert.equal(runtime.getRuntime().notifications.enabled, false);
    assert.equal((await post('{"enabled":true}')).status, 200);
    assert.equal(runtime.getRuntime().notifications.enabled, true);
    await runtime.close(); assert.equal((await post('{"enabled":true}')).status, 503);
    const entry = Object.values(os.networkInterfaces()).flat().find(value => value?.family === 'IPv4' && !value.internal);
    if (entry) {
      let mutations = 0;
      const remote = await startServer(new StateStore({ sessionId: 'remote-notification-audit', mode: 'idle' }), { host: entry.address, port: 0,
        controls: { async connect() {}, async disconnect() {}, async setOsc() {}, async setNotifications() { mutations++; } } });
      try {
        const status = await new Promise<number>((resolve, reject) => {
          const req = request(remote.url + '/api/notifications', { method: 'POST', localAddress: entry.address, headers: { 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode!); });
          req.on('error', reject); req.setTimeout(1500, () => req.destroy(new Error('Local HTTP audit timed out'))); req.end('{"enabled":true}');
        });
        assert.equal(status, 403); assert.equal(mutations, 0);
      } finally { await remote.close(); }
    }
    assert.equal(sends, 0);
  } finally { await runtime.close(); await server.close(); }
});
