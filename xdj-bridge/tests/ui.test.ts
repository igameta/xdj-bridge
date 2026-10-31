import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { StateStore } from '../src/core/store.js';
import type { Snapshot } from '../src/core/types.js';

const html = await readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
interface DiscoveryDevice {
  id: string; model: string; sourceIp: string; wireDeviceId: number; ageMs: number;
  status: 'announced' | 'receiving' | 'stale' | 'unassigned'; interfaceId: string | null;
  interfaceEvidence: 'subnet' | 'capture' | 'unknown'; reason: string | null; lastStatusAt?: number | null;
}
const initialRuntime = () => ({
  connection: { mode: 'virtual-device', backend: 'native', profile: 'xdj-rx3', interfaceName: 'en6', connected: true, connecting: false, error: null },
  interfaces: [{ name: 'en6', address: '169.254.60.99' }, { name: 'en0', address: '192.0.2.1' }],
  osc: { enabled: false, host: '127.0.0.1', port: 9000, maxHz: 20, snapshotIntervalMs: 1000 },
  notifications: { enabled: false, supported: true, error: null as string | null },
  discovery: { searching: false, attempted: false, interfaceName: 'en6' as string | null, source: 'session' as 'session' | 'scan', devices: [] as DiscoveryDevice[], error: null as string | null },
});
function seed(): Snapshot {
  const store = new StateStore({ sessionId: 'ui', mode: 'virtual-device' });
  for (const wireDeviceId of [12, 11]) store.ingestStatus({ sessionId: 'ui', interfaceId: 'en6', sourceIp: '169.254.1.2', receivedAt: 0,
    wireDeviceId, model: 'XDJ-RX3', trackId: 70, sourceWireDeviceId: 11, protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 122, pitchPercent: 0 });
  return store.snapshot();
}
function seedFourDecks(): Snapshot {
  const store = new StateStore({ sessionId: 'four-deck-ui', mode: 'virtual-device' });
  for (const wireDeviceId of [4, 2, 1, 3]) store.ingestStatus({ sessionId: 'four-deck-ui', interfaceId: 'en6', sourceIp: '169.254.1.4', receivedAt: 0,
    wireDeviceId, model: 'XDJ-AZ', trackId: 70 + wireDeviceId, sourceWireDeviceId: 1, protocolSlot: 3, trackType: 1, playState: 3, trackBpm: 120 + wireDeviceId, pitchPercent: 0 });
  for (const deck of store.snapshot().decks) assert.equal(store.applyMetadata({ deckId: deck.deckId, loadGeneration: deck.loadGeneration,
    mediaGeneration: deck.trackRef!.mediaGeneration, title: `デッキ${deck.logicalDeck}の長い曲名を省略せずに保持するための回帰データ`, artist: `アーティスト ${deck.logicalDeck}` }, 1), true);
  return store.snapshot();
}
async function harness() {
  const { document, window } = parseHTML(html);
  for (const form of document.querySelectorAll('form')) (form as any).reportValidity = () => true;
  // linkedom has no select setter, focus manager or modal top layer; provide
  // their browser contracts while exercising the actual application script.
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { const options = [...this.querySelectorAll('option')]; return (options.find(option => option.selected) ?? options[0])?.value ?? ''; },
    set(value: string) {
      const options = [...this.querySelectorAll('option')];
      for (const option of options) option.removeAttribute('selected');
      options.find(option => option.value === String(value))?.setAttribute('selected', '');
    },
  });
  let active: any = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => active });
  window.HTMLElement.prototype.focus = function () { active = this; };
  const dialog: any = document.getElementById('settings-drawer');
  Object.defineProperty(dialog, 'open', { get: () => dialog.hasAttribute('open') });
  dialog.showModal = () => { dialog.setAttribute('open', ''); document.getElementById('settings-close')!.focus(); };
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); };
  dialog.getBoundingClientRect = () => ({ left: 100, right: 600, top: 0, bottom: 800 });
  let now = 0, nextTimer = 1;
  const timers = new Map<number, { callback: () => void; at: number }>();
  const intervals: Array<() => void> = [];
  let currentRuntime = initialRuntime();
  let notificationsFailure: string | null = null;
  let discoveryFailure: string | null = null;
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  class FakeSocket {
    static instance: FakeSocket;
    listeners = new Map<string, Array<(event: any) => void>>();
    constructor() { FakeSocket.instance = this; }
    addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    emit(type: string, event: any = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    send() {}
    close() {}
  }
  const context = vm.createContext({ document, location: { protocol: 'http:', host: '127.0.0.1:8080' }, WebSocket: FakeSocket,
    performance: { now: () => now },
    setTimeout: (callback: () => void, delay = 0) => { const id = nextTimer++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length; }, clearInterval: () => {},
    addEventListener: () => {},
    fetch: async (url: string, options: { method?: string; body?: string } = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method: options.method ?? 'GET', ...(body ? { body } : {}) });
      if (url === '/api/notifications' && options.method === 'POST') {
        if (notificationsFailure) return { ok: false, json: async () => ({ error: notificationsFailure }) };
        currentRuntime = { ...currentRuntime, notifications: { ...currentRuntime.notifications, enabled: body.enabled, error: null } };
      }
      if (url === '/api/discovery' && options.method === 'POST') {
        if (discoveryFailure) return { ok: false, json: async () => ({ error: discoveryFailure }) };
        if (currentRuntime.connection.connected && body.interfaceName !== currentRuntime.connection.interfaceName) return { ok: false, json: async () => ({ error: '接続中とは別のLANは探索できません。' }) };
        currentRuntime = { ...currentRuntime, discovery: { ...currentRuntime.discovery, searching: true, attempted: true,
          interfaceName: body.interfaceName, source: currentRuntime.connection.connected ? 'session' : 'scan', error: null } };
      }
      if (url === '/api/connection' && options.method === 'POST') {
        currentRuntime = { ...currentRuntime, connection: body.action === 'disconnect' ? { ...currentRuntime.connection, connected: false, connecting: false } :
          { ...currentRuntime.connection, mode: body.mode, backend: body.backend, profile: body.profile, interfaceName: body.interfaceName, connected: false, connecting: true } };
      }
      return { ok: true, json: async () => structuredClone(currentRuntime) };
    },
  });
  vm.runInContext(script, context);
  await turn();
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].callback();
    }
    now = target;
  };
  return { document, window, requests, advance, socket: FakeSocket.instance!,
    receive: (message: unknown) => FakeSocket.instance.emit('message', { data: JSON.stringify(message) }),
    poll: async (next = currentRuntime) => { currentRuntime = next; for (const callback of intervals) callback(); await turn(); },
    rejectNotifications: (error: string | null) => { notificationsFailure = error; },
    rejectDiscovery: (error: string | null) => { discoveryFailure = error; },
  };
}

test('UI: unchanged live packets preserve deck DOM, details, diagnostics and focus', async () => {
  const h = await harness(), state = seed();
  h.receive({ type: 'snapshot', ...state }); h.advance(1);
  const cards = [...h.document.querySelectorAll('.deck')];
  assert.equal(cards[0].querySelector('.deck-label')!.textContent, 'Deck 1');
  const card = cards[0], heading = card.querySelector('.deck-label'), fraction = card.querySelector('.bpm-value small');
  const detail = card.querySelector('details')!;
  detail.setAttribute('open', ''); detail.querySelector('summary')!.focus();
  const focus = h.document.activeElement;
  const diagnostic = h.document.querySelector('#diagnostics > *');
  const mutations: any[] = [];
  const observer = new h.window.MutationObserver(records => mutations.push(...records));
  observer.observe(h.document.getElementById('decks')!, { childList: true });
  let revision = state.revision;
  for (let index = 0; index < 100; index++) {
    const decks = structuredClone(state.decks); for (const deck of decks) deck.stateRevision += index + 1;
    h.receive({ type: 'delta', schemaVersion: 1, baseRevision: revision, revision: ++revision, decks, removedDeckIds: [], session: state.session, diagnostics: state.diagnostics });
    h.advance(5);
  }
  h.advance(50); await turn();
  assert.equal(h.document.querySelector('.deck'), card);
  assert.equal(card.querySelector('.deck-label'), heading);
  assert.equal(card.querySelector('.bpm-value small'), fraction);
  assert.equal(h.document.querySelector('#diagnostics > *'), diagnostic);
  assert.equal(h.document.activeElement, focus); assert.equal(detail.hasAttribute('open'), true);
  assert.equal(mutations.length, 0, 'steady streams must not detach/reinsert deck cards');
  observer.disconnect();
});

test('UI: packet bursts coalesce into bounded renders and retain the newest BPM', async () => {
  const h = await harness(), state = seed();
  h.receive({ type: 'snapshot', ...state }); h.advance(1);
  const bpm = h.document.querySelector('.bpm-value')!;
  const changes: any[] = [];
  const observer = new h.window.MutationObserver(records => changes.push(...records)); observer.observe(bpm, { childList: true });
  let revision = state.revision;
  for (let index = 1; index <= 100; index++) {
    const decks = structuredClone(state.decks);
    for (const deck of decks) { deck.stateRevision += index; deck.effectiveBpm.value = 122 + index / 100; }
    h.receive({ type: 'delta', schemaVersion: 1, baseRevision: revision, revision: ++revision, decks, removedDeckIds: [], session: state.session, diagnostics: state.diagnostics });
    h.advance(1);
  }
  h.advance(50); await turn();
  assert.equal(bpm.textContent, '123.00');
  assert.ok(changes.length <= 12, `100 updates in 100ms should coalesce, got ${changes.length} child mutations`);
  observer.disconnect();
});

test('UI: interface ordering and option identity remain stable; focused selection defers refresh', async () => {
  const h = await harness();
  const select: any = h.document.getElementById('interface-select');
  const options = [...select.options];
  assert.deepEqual(options.map(option => option.value), ['', 'en0', 'en6']);
  const reordered = initialRuntime(); reordered.interfaces.reverse(); reordered.interfaces.push({ ...reordered.interfaces[0] });
  await h.poll(reordered);
  assert.deepEqual([...select.options], options, 'reordering and duplicate observations must not rebuild options');
  select.focus(); select.value = 'en6'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const changed = initialRuntime(); changed.interfaces.push({ name: 'en7', address: '198.51.100.1' });
  await h.poll(changed);
  assert.deepEqual([...select.options], options, 'do not mutate options while the native menu has focus');
  assert.equal(select.value, 'en6');
  h.document.getElementById('device-select')!.focus(); select.dispatchEvent(new h.window.Event('blur'));
  assert.deepEqual([...select.options].map(option => option.value), ['', 'en0', 'en6', 'en7']);
  assert.equal(select.value, 'en6'); assert.equal(select.options[2], options[2]);
});

test('UI: settings stay hidden initially and menu close/reopen preserves unsaved inputs without POST', async () => {
  const h = await harness();
  const dialog: any = h.document.getElementById('settings-drawer');
  const button = h.document.getElementById('settings-button')!;
  assert.equal(dialog.open, false); assert.equal(button.getAttribute('aria-expanded'), 'false');
  button.click(); assert.equal(dialog.open, true); assert.equal(button.getAttribute('aria-expanded'), 'true');
  const host: any = h.document.getElementById('osc-host'); host.value = '192.0.2.42'; host.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.document.getElementById('settings-close')!.click();
  assert.equal(dialog.open, false); assert.equal(h.document.activeElement, button);
  button.click(); await h.poll();
  assert.equal(host.value, '192.0.2.42'); assert.equal(dialog.open, true);
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
  assert.equal(h.document.getElementById('osc-unsaved')!.hidden, false);
});

test('UI: connection loss renders stale immediately and a same-revision snapshot restores freshness', async () => {
  const h = await harness(), state = seed();
  h.receive({ type: 'snapshot', ...state }); h.advance(1);
  h.socket.emit('close'); h.advance(50);
  assert.equal(h.document.querySelector('.deck')!.classList.contains('stale'), true);
  h.receive({ type: 'snapshot', ...state }); h.advance(50);
  assert.equal(h.document.querySelector('.deck')!.classList.contains('stale'), false);
  h.receive({ type: 'snapshot', ...state, decks: [] }); h.advance(50);
  const empty = h.document.querySelector('.empty-state');
  h.receive({ type: 'snapshot', ...state, decks: [] }); h.advance(50);
  assert.equal(h.document.querySelector('.empty-state'), empty);
});

test('UI: native interface popover keeps options stable even when focus moves to the dialog', async () => {
  const h = await harness();
  const select: any = h.document.getElementById('interface-select');
  const options = [...select.options];
  h.document.getElementById('settings-button')!.click();
  select.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
  h.document.getElementById('settings-drawer')!.focus();
  const changed = initialRuntime(); changed.interfaces.push({ name: 'en7', address: '198.51.100.1' });
  await h.poll(changed);
  assert.deepEqual([...select.options], options, 'native popover focus changes must not permit polling to replace its options');
  h.document.getElementById('settings-close')!.click();
  assert.deepEqual([...select.options].map(option => option.value), ['', 'en0', 'en6', 'en7']);
  assert.equal(select.value, 'en6');
});

test('UI: alternating session reasons never insert a banner, move cards or trigger runtime refreshes', async () => {
  const h = await harness(), state = seed();
  h.receive({ type: 'snapshot', ...state }); h.advance(1); await turn();
  const main = h.document.querySelector('main')!;
  const children = [...main.children];
  const card = h.document.querySelector('.deck');
  const badge = h.document.getElementById('session-status');
  assert.ok(badge, 'connection status should have a permanent compact display');
  const requests = h.requests.length;
  const mutations: any[] = [];
  const observer = new h.window.MutationObserver(records => mutations.push(...records)); observer.observe(main, { childList: true });
  let revision = state.revision;
  for (let index = 0; index < 60; index++) {
    h.receive({ type: 'delta', schemaVersion: 1, baseRevision: revision, revision: ++revision,
      session: { ...state.session, reason: index % 2 === 0 ? 'virtual-device on en6; firmware unknown.' : null },
      decks: [], removedDeckIds: [], diagnostics: state.diagnostics });
    h.advance(60); await turn();
  }
  assert.equal(h.document.getElementById('session-reason'), null, 'reason text must not appear as a toggling banner');
  assert.equal(h.document.getElementById('session-status'), badge);
  assert.equal(badge.textContent, '受信中');
  assert.equal(h.document.querySelector('.deck'), card);
  assert.deepEqual([...main.children], children);
  assert.equal(mutations.length, 0);
  assert.equal(h.requests.length, requests, 'reason churn alone must not refetch runtime configuration');
  const reason = h.document.getElementById('session-last-reason')!;
  assert.equal(reason.textContent, 'virtual-device on en6; firmware unknown.');
  assert.ok(reason.closest('details'), 'connection details belong inside collapsed diagnostics');
  assert.equal(reason.closest('details')!.hasAttribute('open'), false);
  observer.disconnect();
});

test('UI: diagnostic reason survives a transient null and resets when the connection session changes', async () => {
  const h = await harness(), state = seed();
  h.receive({ type: 'snapshot', ...state, session: { ...state.session, state: 'degraded', reason: 'source unavailable' } }); h.advance(1);
  assert.equal(h.document.getElementById('session-last-reason')!.textContent, 'source unavailable');
  h.receive({ type: 'snapshot', ...state }); h.advance(50);
  assert.equal(h.document.getElementById('session-status')!.textContent, '受信中');
  assert.equal(h.document.getElementById('session-last-reason')!.textContent, 'source unavailable');
  assert.equal(h.document.getElementById('session-detail-interface')!.textContent, 'en6');
  h.receive({ type: 'snapshot', ...state, session: { ...state.session, id: 'new-session', state: 'observing', interfaceId: 'en0', reason: null }, decks: [] }); h.advance(50);
  assert.equal(h.document.getElementById('session-status')!.textContent, '検出中');
  assert.equal(h.document.getElementById('session-detail-interface')!.textContent, 'en0');
  assert.doesNotMatch(h.document.getElementById('session-last-reason')!.textContent ?? '', /source unavailable/);
});

test('UI: a reason received and cleared within one render frame is retained in diagnostics', async () => {
  const h = await harness(), state = seed();
  h.receive({ type: 'snapshot', ...state, session: { ...state.session, reason: 'a brief connection message' } });
  h.receive({ type: 'delta', schemaVersion: 1, baseRevision: state.revision, revision: state.revision + 1,
    session: { ...state.session, reason: null }, decks: [], removedDeckIds: [], diagnostics: state.diagnostics });
  h.advance(1);
  assert.equal(h.document.getElementById('session-last-reason')!.textContent, 'a brief connection message');
  assert.equal(h.document.getElementById('session-status')!.textContent, '受信中');
});

test('UI: four decks retain metadata, identity and fixed accent keys through out-of-order arrival and removal', async () => {
  const h = await harness(), state = seedFourDecks();
  const arriving = state.decks.filter(deck => [3, 4].includes(deck.logicalDeck!));
  h.receive({ type: 'snapshot', ...state, decks: arriving }); h.advance(1);
  const original = new Map([...h.document.querySelectorAll('.deck')].map(card => [card.getAttribute('data-logical-deck'), card]));
  assert.deepEqual([...original.keys()], ['3', '4']);
  let revision = state.revision;
  h.receive({ type: 'delta', schemaVersion: 1, baseRevision: revision, revision: ++revision, session: state.session,
    decks: state.decks.filter(deck => [1, 2].includes(deck.logicalDeck!)), removedDeckIds: [], diagnostics: state.diagnostics }); h.advance(50);
  const cards = [...h.document.querySelectorAll('.deck')];
  assert.equal(h.document.getElementById('deck-count')!.textContent, '4 デッキ');
  assert.deepEqual(cards.map(card => card.getAttribute('data-logical-deck')), ['1', '2', '3', '4']);
  for (const [index, card] of cards.entries()) {
    assert.equal(card.querySelector('.deck-label')!.textContent, `Deck ${index + 1}`);
    assert.equal(card.querySelector('.track-artist')!.textContent, `アーティスト ${index + 1}`);
    assert.match(card.querySelector('.track-title')!.textContent ?? '', new RegExp(`デッキ${index + 1}の長い曲名`));
    assert.equal(card.querySelector('.track-title')!.getAttribute('title'), card.querySelector('.track-title')!.textContent, 'full metadata remains accessible if visually clamped');
  }
  assert.equal(cards[2], original.get('3')); assert.equal(cards[3], original.get('4'));
  const detail = cards[2].querySelector('details')!; detail.setAttribute('open', ''); detail.querySelector('summary')!.focus();
  const focus = h.document.activeElement;
  h.receive({ type: 'delta', schemaVersion: 1, baseRevision: revision, revision: ++revision, session: state.session,
    decks: [], removedDeckIds: [state.decks.find(deck => deck.logicalDeck === 2)!.deckId], diagnostics: state.diagnostics }); h.advance(50);
  assert.deepEqual([...h.document.querySelectorAll('.deck')].map(card => card.getAttribute('data-logical-deck')), ['1', '3', '4']);
  assert.equal(h.document.querySelector('[data-logical-deck="3"]'), original.get('3'));
  assert.equal(h.document.querySelector('[data-logical-deck="4"]'), original.get('4'));
  assert.equal(h.document.activeElement, focus); assert.equal(detail.hasAttribute('open'), true);
});

test('UI: fresh playback highlights the whole card and clears reliably for stopped, unknown and stale decks', async () => {
  const h = await harness(), state = seedFourDecks();
  const playingStates = new Map([[1, 'playing'], [2, 'looping'], [3, 'cue_playing'], [4, 'paused']]);
  h.receive({ type: 'snapshot', ...state, decks: state.decks.map(deck => ({ ...deck, playbackState: { ...deck.playbackState, value: playingStates.get(deck.logicalDeck!) } })) }); h.advance(1);
  const cards = [...h.document.querySelectorAll('.deck')];
  assert.deepEqual(cards.map(card => card.classList.contains('is-playing')), [true, true, true, false]);
  assert.deepEqual(cards.map(card => card.querySelector('.play-state span')!.textContent), ['再生中', 'ループ再生', 'CUE再生', '一時停止']);
  let revision = state.revision;
  for (const playback of ['paused', 'cued', 'loading', 'stopped', 'unknown', null]) {
    h.receive({ type: 'delta', schemaVersion: 1, baseRevision: revision, revision: ++revision, session: state.session,
      decks: state.decks.map(deck => ({ ...deck, stateRevision: deck.stateRevision + revision, playbackState: { ...deck.playbackState, value: playback } })),
      removedDeckIds: [], diagnostics: state.diagnostics }); h.advance(50);
    assert.equal(h.document.querySelectorAll('.deck.is-playing').length, 0, `${playback} must clear prior active frames`);
    assert.equal(h.document.querySelectorAll('.play-state.playing').length, 0);
  }
  h.receive({ type: 'snapshot', ...state }); h.advance(50);
  assert.equal(h.document.querySelectorAll('.deck.is-playing').length, 4);
  h.socket.emit('close'); h.advance(50);
  assert.equal(h.document.querySelectorAll('.deck.is-playing').length, 0);
  assert.equal(h.document.querySelectorAll('.deck.stale').length, 4);
  h.receive({ type: 'snapshot', ...state }); h.advance(50);
  assert.equal(h.document.querySelectorAll('.deck.is-playing').length, 4);
  assert.deepEqual([...h.document.querySelectorAll('.deck')], cards, 'state changes must preserve the same four cards');
  h.receive({ type: 'delta', schemaVersion: 1, baseRevision: state.revision, revision: state.revision + 1, session: state.session,
    decks: state.decks.map(deck => ({ ...deck, stateRevision: deck.stateRevision + 1, playbackState: { ...deck.playbackState, quality: 'unknown' } })),
    removedDeckIds: [], diagnostics: state.diagnostics }); h.advance(50);
  assert.equal(h.document.querySelectorAll('.deck.is-playing').length, 0, 'unknown playback quality must not assert active playback');
});

test('UI: notification setting defaults off, preserves unsaved changes and applies only through its API', async () => {
  const h = await harness();
  const toggle: any = h.document.getElementById('notifications-enabled');
  const apply: any = h.document.getElementById('notifications-apply');
  const status = h.document.getElementById('notifications-status')!;
  assert.equal(toggle.checked, false); assert.equal(toggle.disabled, false); assert.equal(apply.disabled, true);
  assert.equal(status.textContent, 'OFF');
  h.document.getElementById('settings-button')!.click();
  toggle.checked = true; toggle.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const host: any = h.document.getElementById('osc-host'); host.value = '192.0.2.55'; host.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.document.getElementById('settings-close')!.click();
  h.document.getElementById('settings-button')!.click(); await h.poll();
  assert.equal(toggle.checked, true); assert.equal(status.textContent, 'OFF', 'selection is separate from the actual runtime setting');
  assert.equal(h.document.getElementById('notifications-unsaved')!.hidden, false);
  assert.equal(h.requests.some(request => request.method === 'POST'), false, 'opening the menu and editing a checkbox must not send settings');
  h.document.getElementById('notifications-form')!.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(toggle.disabled, true); await turn();
  const notificationsRequests = h.requests.filter(request => request.url === '/api/notifications');
  assert.equal(notificationsRequests.length, 1); assert.deepEqual(notificationsRequests[0].body, { enabled: true });
  assert.equal(status.textContent, 'ON'); assert.equal(toggle.checked, true); assert.equal(apply.disabled, true);
  assert.equal(h.document.getElementById('notifications-unsaved')!.hidden, true);
  assert.equal(host.value, '192.0.2.55', 'notification runtime response must preserve unrelated OSC edits');
  assert.equal(h.document.getElementById('osc-unsaved')!.hidden, false);
  toggle.checked = false; toggle.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(status.textContent, 'ON');
  h.document.getElementById('notifications-form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await turn();
  assert.deepEqual(h.requests.filter(request => request.url === '/api/notifications').at(-1)!.body, { enabled: false });
  assert.equal(status.textContent, 'OFF');
});

test('UI: unsupported notification platforms are explicit and cannot submit an enable request', async () => {
  const h = await harness();
  const unsupported = initialRuntime(); unsupported.notifications.supported = false;
  await h.poll(unsupported);
  const toggle: any = h.document.getElementById('notifications-enabled');
  const apply: any = h.document.getElementById('notifications-apply');
  assert.equal(toggle.disabled, true); assert.equal(apply.disabled, true);
  assert.equal(h.document.getElementById('notifications-status')!.textContent, '未対応のOS');
  assert.match(h.document.getElementById('notifications-hint')!.textContent ?? '', /このOSでは通知を利用できません/);
  h.document.getElementById('notifications-form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await turn();
  assert.equal(h.requests.some(request => request.url === '/api/notifications'), false);
});

test('UI: notification API errors retain dirty selection and remote errors clear independently', async () => {
  const h = await harness();
  const toggle: any = h.document.getElementById('notifications-enabled');
  const form = h.document.getElementById('notifications-form')!;
  const error = h.document.getElementById('notifications-error')!;
  toggle.checked = true; toggle.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  h.rejectNotifications('通知設定を適用できませんでした。');
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await turn();
  assert.equal(error.textContent, '通知設定を適用できませんでした。'); assert.equal(error.hidden, false);
  assert.equal(toggle.checked, true); assert.equal(h.document.getElementById('notifications-unsaved')!.hidden, false);
  const failed = initialRuntime(); failed.notifications.error = 'OS側で通知の送信に失敗しました。';
  await h.poll(failed);
  assert.match(error.textContent ?? '', /適用できません/); assert.match(error.textContent ?? '', /OS側/);
  assert.equal(h.document.getElementById('notifications-status')!.textContent, 'エラー');
  await h.poll(initialRuntime());
  assert.equal(error.textContent, '通知設定を適用できませんでした。', 'healthy polling only clears the remote error');
  assert.equal(toggle.checked, true, 'polling must not replace a rejected user selection');
  h.rejectNotifications(null); form.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await turn();
  assert.equal(error.hidden, true); assert.equal(h.document.getElementById('notifications-status')!.textContent, 'ON');
  assert.match(h.document.getElementById('notifications-hint')!.textContent ?? '', /OSの通知設定/);
});

test('UI: LAN discovery shows all models and distinguishes announcements, status reception and unassigned interfaces', async () => {
  const h = await harness();
  const found = initialRuntime();
  found.discovery.devices = [
    { id: 'az', model: 'XDJ-AZ', sourceIp: '192.0.2.22', wireDeviceId: 2, ageMs: 1200, status: 'receiving', interfaceId: 'en6', interfaceEvidence: 'subnet', reason: null },
    { id: 'az-deck4', model: 'XDJ-AZ', sourceIp: '192.0.2.22', wireDeviceId: 4, ageMs: 1500, status: 'announced', interfaceId: 'en6', interfaceEvidence: 'subnet', reason: null, lastStatusAt: 0 },
    { id: 'cdj', model: 'CDJ-3000', sourceIp: '192.0.2.21', wireDeviceId: 1, ageMs: 0, status: 'announced', interfaceId: 'en6', interfaceEvidence: 'subnet', reason: null },
    { id: 'old', model: 'CDJ-2000', sourceIp: '192.0.2.23', wireDeviceId: 3, ageMs: 62000, status: 'stale', interfaceId: 'en6', interfaceEvidence: 'capture', reason: null, lastStatusAt: null },
    { id: 'unknown-lan', model: 'CDJ-3000X', sourceIp: '198.51.100.1', wireDeviceId: 4, ageMs: 4000, status: 'unassigned', interfaceId: null, interfaceEvidence: 'unknown', reason: '受信元が選択インターフェースと異なるサブネットです。' },
  ];
  await h.poll(found);
  assert.equal((h.document.getElementById('device-select') as any).value, 'xdj-rx3');
  const rows = [...h.document.querySelectorAll('.discovery-device')];
  assert.equal(rows.length, 5, 'the selected RX3 profile must not hide AZ or CDJ announcements, including multiple wire IDs on one unit');
  assert.match(h.document.getElementById('discovery-status')!.textContent ?? '', /検出 5件/);
  assert.deepEqual(rows.map(row => row.querySelector('.discovery-device-model')!.textContent), ['CDJ-3000', 'XDJ-AZ', 'XDJ-AZ', 'CDJ-2000', 'CDJ-3000X']);
  assert.deepEqual(rows.map(row => row.querySelector('.discovery-device-state')!.textContent), ['機器通知のみ', '状態受信中', '状態受信停止', '通知が途絶', 'LAN未確定']);
  assert.match(rows[0].querySelector('.discovery-device-address')!.textContent ?? '', /192\.0\.2\.21 · 通信番号 1/);
  assert.match(rows[0].querySelector('.discovery-device-last-seen')!.textContent ?? '', /たった今.*en6（IF推定）/);
  assert.match(rows[3].querySelector('.discovery-device-last-seen')!.textContent ?? '', /1分前.*IF確認/);
  assert.match(rows[4].querySelector('.discovery-device-last-seen')!.textContent ?? '', /IF未確定/);
  assert.match(rows[4].querySelector('.discovery-device-reason')!.textContent ?? '', /異なるサブネット/);
  assert.match(h.document.getElementById('discovery-profile-hint')!.textContent ?? '', /自動検出/);
  const device: any = h.document.getElementById('device-select'); device.value = 'xdj-az'; device.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const reordered = structuredClone(found); reordered.discovery.devices.reverse(); await h.poll(reordered);
  assert.deepEqual([...h.document.querySelectorAll('.discovery-device')], rows, 'arrival order changes must not rebuild or reorder stable device rows');
  assert.equal(device.value, 'xdj-az', 'discovery updates must preserve an uncommitted profile choice');
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
  assert.ok(h.document.getElementById('discovery-devices')!.closest('dialog'), 'device discovery belongs inside the settings menu');
});

test('UI: discovery observes the active LAN without connection changes and retains every unsaved setting', async () => {
  const h = await harness();
  h.document.getElementById('settings-button')!.click();
  const device: any = h.document.getElementById('device-select'); device.value = 'auto'; device.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const host: any = h.document.getElementById('osc-host'); host.value = '192.0.2.55'; host.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  const notifications: any = h.document.getElementById('notifications-enabled'); notifications.checked = true; notifications.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const button: any = h.document.getElementById('discovery-button');
  assert.equal(h.document.getElementById('discovery-help')!.hidden, true);
  button.click(); assert.equal(button.disabled, true); await turn();
  const posts = h.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].url, '/api/discovery'); assert.deepEqual(posts[0].body, { interfaceName: 'en6' });
  assert.equal(button.textContent, '探索中…'); assert.equal(button.disabled, true);
  assert.match(h.document.getElementById('discovery-status')!.textContent ?? '', /接続中の受信を確認/);
  assert.equal((h.document.getElementById('disconnect-button') as any).disabled, false, 'discovery must not disconnect the existing source');
  assert.equal(device.value, 'auto'); assert.equal(host.value, '192.0.2.55'); assert.equal(notifications.checked, true);
  assert.equal(h.document.getElementById('notifications-unsaved')!.hidden, false);
  assert.equal(h.document.getElementById('osc-unsaved')!.hidden, false);
  const completed = initialRuntime(); completed.discovery.attempted = true; await h.poll(completed);
  assert.equal(button.disabled, false); assert.equal(button.textContent, '機器を探す');
  assert.match(h.document.querySelector('.discovery-empty')!.textContent ?? '', /この探索時間内に機器通知を受信できませんでした/);
  assert.match(h.document.getElementById('discovery-help')!.textContent ?? '', /WindowsではNode.jsの受信許可/);
  assert.equal(h.document.getElementById('discovery-az-note')!.hidden, true);
  assert.equal(device.value, 'auto'); assert.equal(host.value, '192.0.2.55'); assert.equal(notifications.checked, true);
  device.value = 'xdj-az'; device.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.match(h.document.getElementById('discovery-az-note')!.textContent ?? '', /PRO DJ LINK.*Deck 3\/4/);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1, 'hints and profile selection must not change equipment settings');
});

test('UI: discovery errors preserve LAN selection and do not fall back to disconnecting the active source', async () => {
  const h = await harness();
  const select: any = h.document.getElementById('interface-select'); select.value = 'en0'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const button: any = h.document.getElementById('discovery-button'); button.click(); await turn();
  assert.match(h.document.getElementById('discovery-error')!.textContent ?? '', /別のLANは探索できません/);
  assert.equal(select.value, 'en0'); assert.equal((h.document.getElementById('disconnect-button') as any).disabled, false);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(h.requests.some(request => request.url === '/api/connection'), false);
  await h.poll(); assert.equal(select.value, 'en0'); assert.equal(h.document.getElementById('discovery-error')!.hidden, false);
  select.value = 'en6'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  h.rejectDiscovery('UDP 50000を確保できません。'); button.click(); await turn();
  assert.match(h.document.getElementById('discovery-error')!.textContent ?? '', /UDP 50000/);
  h.rejectDiscovery(null); button.click(); await turn();
  assert.equal(h.document.getElementById('discovery-error')!.hidden, true);
});

test('UI: AZ standalone is explicit, experimental and submits only a compatible native connection', async () => {
  const h = await harness();
  h.document.getElementById('settings-button')!.click();
  const method: any = h.document.getElementById('method-select');
  const device: any = h.document.getElementById('device-select');
  const connect: any = h.document.getElementById('connect-button');
  assert.match(method.querySelector('option[value="az-standalone"]')!.textContent ?? '', /試験/);
  method.value = 'az-standalone'; method.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  for (const incompatible of ['xdj-rx3', 'generic-prolink']) {
    device.value = incompatible; device.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.equal(connect.disabled, true); assert.equal(device.value, incompatible, 'an incompatible profile must not be switched automatically');
    assert.match(h.document.getElementById('connection-error')!.textContent ?? '', /自動検出.*XDJ-AZ/);
    h.document.getElementById('connection-form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  }
  assert.equal(h.requests.some(request => request.method === 'POST'), false, 'selecting an experimental mode must not transmit');
  device.value = 'auto'; device.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const host: any = h.document.getElementById('osc-host'); host.value = '192.0.2.88'; host.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  const notifications: any = h.document.getElementById('notifications-enabled'); notifications.checked = true; notifications.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.poll();
  assert.equal(method.value, 'az-standalone'); assert.equal(device.value, 'auto'); assert.equal(connect.disabled, false);
  assert.match(h.document.getElementById('connection-hint')!.textContent ?? '', /ModeはOFFのまま.*PC型参加.*実機未検証/);
  assert.equal(h.document.getElementById('connection-error')!.hidden, true);
  h.document.getElementById('connection-form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await turn();
  const posts = h.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(posts[0].url, '/api/connection');
  assert.deepEqual(posts[0].body, { action: 'connect', profile: 'auto', interfaceName: 'en6', mode: 'az-standalone', backend: 'native' });
  assert.equal(method.value, 'az-standalone'); assert.equal(host.value, '192.0.2.88'); assert.equal(notifications.checked, true);
  assert.equal(h.document.getElementById('osc-unsaved')!.hidden, false); assert.equal(h.document.getElementById('notifications-unsaved')!.hidden, false);
  const active = initialRuntime(); active.connection.mode = 'az-standalone'; active.connection.profile = 'auto'; active.discovery.attempted = true;
  await h.poll(active);
  const state = seedFourDecks(); h.receive({ type: 'snapshot', ...state, session: { ...state.session, mode: 'az-standalone' } }); h.advance(1);
  assert.equal(h.document.getElementById('source-mode')!.textContent, 'AZスタンドアロン・試験');
  assert.equal(h.document.getElementById('session-status')!.textContent, '受信中');
  assert.equal(h.document.querySelectorAll('.deck').length, 4);
  assert.equal(h.document.getElementById('discovery-az-note')!.hidden, true, 'standalone must not suggest the setting that disables Deck 3/4');
  assert.doesNotMatch(h.document.getElementById('discovery-help')!.textContent ?? '', /PRO DJ LINK|有効/);
  assert.match(h.document.getElementById('connection-hint')!.textContent ?? '', /実機未検証/);
});

test('UI: AZ standalone runtime restores its selection and uncommitted normal methods remain intact', async () => {
  const h = await harness();
  const active = initialRuntime(); active.connection.mode = 'az-standalone'; active.connection.profile = 'xdj-az'; active.discovery.attempted = true;
  await h.poll(active);
  const method: any = h.document.getElementById('method-select');
  const device: any = h.document.getElementById('device-select');
  assert.equal(method.value, 'az-standalone'); assert.equal(device.value, 'xdj-az');
  assert.equal((h.document.getElementById('connect-button') as any).disabled, false);
  assert.equal(h.document.getElementById('discovery-az-note')!.hidden, true);
  assert.equal(h.requests.some(request => request.method === 'POST'), false);
  device.value = 'xdj-rx3'; device.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  for (const normal of ['virtual-device', 'passive', 'pcap']) {
    method.value = normal; method.dispatchEvent(new h.window.Event('change', { bubbles: true })); await h.poll(active);
    assert.equal(method.value, normal); assert.equal(device.value, 'xdj-rx3');
    assert.equal((h.document.getElementById('connect-button') as any).disabled, false);
    assert.doesNotMatch(h.document.getElementById('connection-hint')!.textContent ?? '', /PC型参加|実機未検証/);
  }
  h.document.getElementById('connection-form')!.dispatchEvent(new h.window.Event('submit', { cancelable: true })); await turn();
  const post = h.requests.find(request => request.method === 'POST')!;
  assert.deepEqual(post.body, { action: 'connect', profile: 'xdj-rx3', interfaceName: 'en6', mode: 'passive', backend: 'alphatheta' });
});
