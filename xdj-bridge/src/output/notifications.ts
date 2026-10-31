import { execFile, type ExecFileOptions } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { DeckState, PlaybackState, Snapshot, StateSource } from '../core/types.js';

export interface NativeNotification { title: string; subtitle: string; body: string }
export interface NotificationSender {
  supported: boolean;
  send(notification: NativeNotification, signal: AbortSignal): Promise<void>;
}
export interface NotificationStatus { enabled: boolean; supported: boolean; error: string | null }
export type NotificationExecutor = (file: string, args: string[], options: ExecFileOptions, callback: (error: Error | null) => void) => unknown;
export const MAC_NOTIFICATION_SCRIPT = `on run argv
  display notification (item 3 of argv) with title (item 1 of argv) subtitle (item 2 of argv)
end run`;
const text = (value: string, limit: number) => [...value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, limit).join('');

/** The program is fixed. Received text is argv data, never script or shell code. */
export function createMacNotificationSender(platform: NodeJS.Platform = process.platform, executor: NotificationExecutor = (file, args, options, callback) => execFile(file, args, options, error => callback(error))): NotificationSender {
  return {
    supported: platform === 'darwin',
    send(notification, signal) {
      if (platform !== 'darwin') return Promise.reject(new Error('OS通知は現在macOSのみ対応しています。'));
      if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Notification cancelled'));
      return new Promise<void>((resolve, reject) => {
        executor('/usr/bin/osascript', ['-l', 'AppleScript', '-e', MAC_NOTIFICATION_SCRIPT, '--', text(notification.title, 80), text(notification.subtitle, 80), text(notification.body, 300)],
          { shell: false, signal, timeout: 2500, maxBuffer: 4096, windowsHide: true }, error => error ? reject(error) : resolve());
      });
    },
  };
}

const LABELS: Record<Exclude<PlaybackState, 'unknown'>, string> = {
  playing: '再生中', paused: '一時停止', cued: 'キュー待機', stopped: '停止', loading: '読み込み中', searching: 'サーチ中', scratching: 'スクラッチ中',
};
interface Baseline { state: Exclude<PlaybackState, 'unknown'>; loadGeneration: number }
interface Pending {
  deckId: string; sessionId: string; loadGeneration: number;
  from: Exclude<PlaybackState, 'unknown'>; to: Exclude<PlaybackState, 'unknown'>;
  notification: NativeNotification; readyAt: number;
}
export interface NotifierOptions {
  enabled?: boolean;
  coalesceMs?: number;
  minIntervalMs?: number;
  timeoutMs?: number;
  maxPending?: number;
  failureBackoffMs?: number;
  onError?: (error: Error) => void;
}

/** Observes common state independently of acquisition and OSC. A failed or
 * uncooperative sender cannot stop reception or create unbounded processes. */
export class PlaybackNotifier {
  private enabled = false;
  private error: string | null = null;
  private closed = false;
  private sessionId = '';
  private baseline = new Map<string, Baseline>();
  private pending = new Map<string, Pending>();
  private timer?: NodeJS.Timeout;
  private active?: { job: Pending; abort: AbortController; timer: NodeJS.Timeout; failed: boolean };
  private nextSendAt = 0;
  private backoffUntil = 0;
  private unsubscribe: () => void;
  private options: Required<Omit<NotifierOptions, 'onError'>> & Pick<NotifierOptions, 'onError'>;
  constructor(private source: StateSource, private sender: NotificationSender, options: NotifierOptions = {}) {
    this.options = { enabled: false, coalesceMs: 300, minIntervalMs: 1000, timeoutMs: 2500, maxPending: 8, failureBackoffMs: 30_000, ...options };
    for (const key of ['coalesceMs', 'minIntervalMs', 'failureBackoffMs'] as const) if (!Number.isFinite(this.options[key]) || this.options[key] < 0) throw new Error(`Invalid notification ${key}`);
    if (!Number.isFinite(this.options.timeoutMs) || this.options.timeoutMs <= 0 || !Number.isInteger(this.options.maxPending) || this.options.maxPending < 1 || this.options.maxPending > 64) throw new Error('Invalid notification limits');
    this.unsubscribe = source.subscribe(snapshot => this.observe(snapshot));
    if (this.options.enabled && !sender.supported) this.error = 'OS通知は現在macOSのみ対応しています。';
    else this.enabled = this.options.enabled;
    this.observe(source.snapshot(), true);
  }
  getStatus(): NotificationStatus { return { enabled: this.enabled, supported: this.sender.supported, error: this.error }; }
  setEnabled(enabled: boolean): void {
    if (this.closed) throw new Error('Notification observer is closed');
    if (enabled && !this.sender.supported) throw new Error('OS通知は現在macOSのみ対応しています。');
    if (enabled === this.enabled) return;
    this.cancelAll(); this.baseline.clear(); this.enabled = enabled;
    if (enabled) { this.error = null; this.backoffUntil = 0; }
    this.observe(this.source.snapshot(), true);
  }
  private known(deck: DeckState): Exclude<PlaybackState, 'unknown'> | null {
    const field = deck.playbackState;
    return field.quality === 'observed' && field.freshness === 'fresh' && field.value != null && Object.hasOwn(LABELS, field.value) ? field.value as Exclude<PlaybackState, 'unknown'> : null;
  }
  private cancelDeck(deckId: string): void {
    this.pending.delete(deckId);
    if (this.active?.job.deckId === deckId) { clearTimeout(this.active.timer); this.active.abort.abort(new Error('Notification state was superseded')); }
  }
  private cancelAll(): void {
    clearTimeout(this.timer); this.timer = undefined; this.pending.clear();
    if (this.active) { clearTimeout(this.active.timer); this.active.abort.abort(new Error('Notification cancelled')); }
  }
  private observe(snapshot: Snapshot, baselineOnly = false): void {
    if (this.closed) return;
    if (snapshot.session.id !== this.sessionId) {
      this.cancelAll(); this.baseline.clear(); this.sessionId = snapshot.session.id; baselineOnly = true;
    }
    const existing = new Set(snapshot.decks.map(d => d.deckId));
    for (const id of this.baseline.keys()) if (!existing.has(id)) { this.baseline.delete(id); this.cancelDeck(id); }
    for (const deck of snapshot.decks) {
      const state = snapshot.session.state === 'disconnected' ? null : this.known(deck);
      if (state == null) { this.baseline.delete(deck.deckId); this.cancelDeck(deck.deckId); continue; }
      const previous = this.baseline.get(deck.deckId);
      this.baseline.set(deck.deckId, { state, loadGeneration: deck.loadGeneration });
      if (!previous || previous.loadGeneration !== deck.loadGeneration || baselineOnly || !this.enabled) { this.cancelDeck(deck.deckId); continue; }
      if (previous.state === state) continue;
      if (performance.now() < this.backoffUntil) { this.cancelDeck(deck.deckId); continue; }
      const queued = this.pending.get(deck.deckId);
      const from = queued?.from ?? previous.state;
      // A short pause/play bounce ending where it began has no net change.
      if (from === state) { this.pending.delete(deck.deckId); continue; }
      const publicId = deck.publicDeckId ?? (deck.logicalDeck != null ? String(deck.logicalDeck) : `wire ${deck.wireDeviceId}`);
      const title = deck.title.quality === 'observed' && deck.title.freshness === 'fresh' && typeof deck.title.value === 'string' ? text(deck.title.value, 180) : '';
      const sourceLabel = snapshot.session.mode === 'demo' ? ' · デモ' : snapshot.session.mode === 'replay' ? ' · キャプチャ再生' : '';
      const notification = { title: 'XDJ Bridge' + sourceLabel, subtitle: text(`Deck ${publicId}`, 80), body: LABELS[state] + (title ? ' — ' + title : '') };
      this.pending.set(deck.deckId, { deckId: deck.deckId, sessionId: snapshot.session.id, loadGeneration: deck.loadGeneration, from, to: state, notification, readyAt: performance.now() + this.options.coalesceMs });
      if (this.pending.size > this.options.maxPending) this.pending.delete(this.pending.keys().next().value!);
    }
    this.schedule();
  }
  private schedule(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.closed || !this.enabled || this.active || !this.pending.size) return;
    const earliest = Math.min(...[...this.pending.values()].map(job => job.readyAt));
    const delay = Math.max(0, earliest - performance.now(), this.nextSendAt - performance.now(), this.backoffUntil - performance.now());
    this.timer = setTimeout(() => this.flush(), Math.ceil(delay));
  }
  private flush(): void {
    this.timer = undefined;
    if (this.closed || !this.enabled || this.active) return;
    const now = performance.now();
    const job = [...this.pending.values()].find(value => value.readyAt <= now);
    if (!job || now < this.nextSendAt || now < this.backoffUntil) { this.schedule(); return; }
    this.pending.delete(job.deckId);
    const snapshot = this.source.snapshot();
    const deck = snapshot.decks.find(value => value.deckId === job.deckId);
    if (snapshot.session.state === 'disconnected' || snapshot.session.id !== job.sessionId || !deck || deck.loadGeneration !== job.loadGeneration || this.known(deck) !== job.to) { this.schedule(); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const active = this.active;
      if (!active || active.abort !== abort || abort.signal.aborted) return;
      this.failed(active, new Error('OS通知の送信がタイムアウトしました。'));
      abort.abort(new Error('Notification timed out'));
    }, this.options.timeoutMs);
    const active = { job, abort, timer, failed: false }; this.active = active;
    this.nextSendAt = now + this.options.minIntervalMs;
    void Promise.resolve().then(() => this.sender.send(job.notification, abort.signal)).then(() => {
      if (!this.closed && !abort.signal.aborted) this.error = null;
    }).catch(error => {
      if (!abort.signal.aborted) this.failed(active, error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      clearTimeout(timer);
      if (this.active === active) this.active = undefined;
      this.schedule();
    });
  }
  private failed(active: NonNullable<PlaybackNotifier['active']>, error: Error): void {
    if (this.closed || active.failed || active.abort.signal.aborted) return;
    active.failed = true;
    this.error = text(error.message, 300); this.pending.clear();
    this.backoffUntil = performance.now() + this.options.failureBackoffMs;
    try { this.options.onError?.(new Error(this.error)); } catch { /* Notification diagnostics must not stop acquisition. */ }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.enabled = false; this.unsubscribe(); this.cancelAll(); this.baseline.clear();
    if (this.active) clearTimeout(this.active.timer);
    // Native execFile observes AbortSignal and kills osascript. Do not wait
    // indefinitely for an injected sender that ignores cancellation.
  }
}
