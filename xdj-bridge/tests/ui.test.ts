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
const initialRuntime = () => ({
  connection: { mode: 'virtual-device', backend: 'native', profile: 'xdj-rx3', interfaceName: 'en6', connected: true, connecting: false, error: null },
  interfaces: [{ name: 'en6', address: '169.254.60.99' }, { name: 'en0', address: '192.0.2.1' }],
  osc: { enabled: false, host: '127.0.0.1', port: 9000, maxHz: 20, snapshotIntervalMs: 1000 },
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
  // linkedom has no select setter, focus manager or modal top layer; provide
  // their browser contracts while exercising the actual application script.
  Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { const options = [...this.querySelectorAll('option')]; return (options.find(option => option.selected) ?? options[0])?.value ?? ''; },
    set(value: string) { for (const option of this.querySelectorAll('option')) option.selected = option.value === String(value); },
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
  const requests: Array<{ url: string; method: string }> = [];
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
    fetch: async (url: string, options: { method?: string } = {}) => {
      requests.push({ url, method: options.method ?? 'GET' });
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
