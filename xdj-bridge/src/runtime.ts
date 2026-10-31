import { randomUUID } from 'node:crypto';
import { StateStore } from './core/store.js';
import type { Profile, Snapshot, StateSource } from './core/types.js';
import type { AppConfig } from './config.js';
import { listInterfaces, selectInterface, startLive, discoverDevices, type DiscoveryOptions, type LiveOptions, type SelectedInterface } from './transport/live.js';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { startAlphathetaCapture } from './adapters/alphatheta.js';
import { startOsc, type OscOptions } from './output/osc.js';
import { makeDemoPackets, readCapture, replayPackets } from './transport/replay.js';
import { createMacNotificationSender, PlaybackNotifier, type NotificationSender } from './output/notifications.js';

interface SourceHandle { close(): Promise<void> }
export interface RuntimeServices {
  listInterfaces(): SelectedInterface[];
  startLive(store: StateStore, options: LiveOptions): Promise<SourceHandle>;
  startCapture(store: StateStore, interfaceName: string): Promise<SourceHandle>;
  startOsc(store: StateSource, options: OscOptions): SourceHandle;
  notificationSender: NotificationSender;
  discoverDevices(store: StateStore, options: DiscoveryOptions): Promise<void>;
}
export interface ConnectionSettings {
  mode: 'virtual-device' | 'passive' | 'az-standalone';
  backend: 'native' | 'alphatheta';
  interfaceName: string;
  profile: Profile | 'auto';
}
export interface OscSettings {
  enabled: boolean;
  host: string;
  port: number;
  maxHz: number;
  snapshotIntervalMs: number;
}
export class RuntimeError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Each OSC destination has a private view so its final invalidation never
 * marks a still-running XDJ session stale for other subscribers. */
class OscView implements StateSource {
  private invalid = false;
  private listeners = new Set<(snapshot: Snapshot) => void>();
  private unsubscribe: () => void;
  constructor(private store: StateStore) {
    this.unsubscribe = store.subscribe(() => { for (const listener of this.listeners) listener(this.snapshot()); });
  }
  snapshot(): Snapshot {
    const snapshot = this.store.snapshot();
    if (this.invalid) {
      snapshot.session.state = 'disconnected';
      for (const deck of snapshot.decks) for (const field of Object.values(deck)) {
        if (field && typeof field === 'object' && 'freshness' in field) field.freshness = 'stale';
      }
    }
    return snapshot;
  }
  subscribe(listener: (snapshot: Snapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  invalidate(): void {
    this.invalid = true;
    for (const listener of this.listeners) listener(this.snapshot());
  }
  dispose(): void { this.unsubscribe(); this.listeners.clear(); }
}

export class RuntimeController implements StateSource {
  private store: StateStore;
  private unsubscribe: () => void;
  private listeners = new Set<(snapshot: Snapshot) => void>();
  private services: RuntimeServices;
  private settings: Pick<AppConfig, 'mode' | 'backend' | 'interfaceName' | 'profile'>;
  private oscSettings: OscSettings;
  private source?: SourceHandle;
  private sourceAbort?: AbortController;
  private startup?: Promise<void>;
  private replayTask?: Promise<void>;
  private output?: SourceHandle;
  private outputView?: OscView;
  private phase: 'idle' | 'connecting' | 'connected' | 'error' = 'idle';
  private changing = false;
  private activeChange: Promise<void> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  private lastError: string | null = null;
  private notifications: PlaybackNotifier;
  private discovery = { searching: false, attempted: false, interfaceName: null as string | null, source: 'session' as 'scan' | 'session', error: null as string | null };
  private discoveryStore?: StateStore;
  private discoveryAbort?: AbortController;
  private discoveryTask?: Promise<void>;
  private discoveryStartedAt = 0;
  private discoveryFinishedAt: number | null = null;
  private storeClockAt = performance.now();
  private storeClockNow = 0;
  constructor(private config: AppConfig, services: Partial<RuntimeServices> = {}) {
    this.services = { listInterfaces, startLive, startCapture: startAlphathetaCapture, startOsc, notificationSender: createMacNotificationSender(), discoverDevices, ...services };
    this.settings = { mode: config.mode, backend: config.backend, interfaceName: config.interfaceName, profile: config.profile };
    this.oscSettings = { enabled: Boolean(config.osc && config.osc.enabled !== false), host: config.osc?.host ?? '127.0.0.1', port: config.osc?.port ?? 9000, maxHz: config.osc?.maxHz ?? 20, snapshotIntervalMs: config.osc?.snapshotIntervalMs ?? 1000 };
    this.store = this.createStore();
    this.unsubscribe = this.forward(this.store);
    this.notifications = new PlaybackNotifier(this, this.services.notificationSender, { enabled: config.notifications?.enabled === true,
      onError: error => this.store.addDiagnostic('notification-error', 'warning', error.message) });
  }
  private createStore(): StateStore {
    return new StateStore({ sessionId: randomUUID(), mode: this.settings.mode, interfaceId: this.settings.interfaceName,
      profile: this.settings.profile, staleAfterMs: this.config.staleAfterMs, publicDeckIds: this.config.publicDeckIds });
  }
  private forward(store: StateStore): () => void {
    return store.subscribe(snapshot => {
      if (store !== this.store) return;
      this.storeClockAt = performance.now(); this.storeClockNow = snapshot.session.now;
      if (this.phase === 'connected' && snapshot.session.state === 'disconnected') this.phase = 'idle';
      for (const listener of this.listeners) listener(snapshot);
    });
  }
  snapshot(): Snapshot { return this.store.snapshot(); }
  subscribe(listener: (snapshot: Snapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  getRuntime() {
    return {
      connection: { ...this.settings, connected: this.phase === 'connected', connecting: this.phase === 'connecting', error: this.lastError },
      interfaces: this.services.listInterfaces().map(({ name, address, netmask, mac }) => ({ name, address, netmask, mac })),
      osc: { ...this.oscSettings },
      notifications: this.notifications.getStatus(),
      discovery: this.getDiscovery(),
    };
  }
  private replaceStore(): void {
    this.unsubscribe(); this.store = this.createStore(); this.unsubscribe = this.forward(this.store);
    this.storeClockAt = performance.now(); this.storeClockNow = 0;
    this.discovery = { searching: false, attempted: false, interfaceName: this.settings.interfaceName ?? null, source: 'session', error: null };
    this.discoveryStore = undefined; this.discoveryTask = undefined;
    for (const listener of this.listeners) listener(this.snapshot());
  }
  private change(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new RuntimeError('アプリは終了しています。', 503));
    if (this.changing) return Promise.reject(new RuntimeError('設定を変更しています。完了後に再試行してください。', 409));
    this.changing = true;
    const task = Promise.resolve().then(() => {
      if (this.closed) throw new RuntimeError('アプリは終了しています。', 503);
      return operation();
    });
    this.activeChange = task.catch(() => {});
    return task.finally(() => { this.changing = false; });
  }
  private validateConnection(input: unknown): ConnectionSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeError('接続設定が不正です。');
    const value = input as Record<string, unknown>;
    if (typeof value.mode !== 'string' || !['virtual-device', 'passive', 'az-standalone'].includes(value.mode) || typeof value.backend !== 'string' || !['native', 'alphatheta'].includes(value.backend) || typeof value.profile !== 'string' || !['auto', 'xdj-rx3', 'xdj-az', 'generic-prolink'].includes(value.profile)) throw new RuntimeError('接続方法・機器の設定が不正です。');
    if (typeof value.interfaceName !== 'string' || !value.interfaceName.trim()) throw new RuntimeError('ネットワーク接続を選択してください。');
    if (value.backend === 'alphatheta' && value.mode !== 'passive') throw new RuntimeError('pcapは受信のみで使用できます。');
    if (value.mode === 'az-standalone' && !['auto', 'xdj-az'].includes(value.profile)) throw new RuntimeError('AZスタンドアロン（試験）は機器をXDJ-AZまたは自動検出にしてください。');
    if (value.mode === 'az-standalone' && this.config.deviceNumber !== undefined) throw new RuntimeError('AZスタンドアロン（試験）は観測から未使用の5/6を選びます。設定ファイルのdeviceNumber指定を解除してください。');
    const interfaces = this.services.listInterfaces();
    if (value.backend === 'native') {
      try { selectInterface(value.interfaceName, interfaces); }
      catch (error) { throw new RuntimeError(error instanceof Error ? error.message : String(error)); }
    }
    else if (!interfaces.some(x => x.name === value.interfaceName)) throw new RuntimeError('選択したネットワーク接続が見つかりません。');
    return { mode: value.mode as ConnectionSettings['mode'], backend: value.backend as ConnectionSettings['backend'], profile: value.profile as ConnectionSettings['profile'], interfaceName: value.interfaceName };
  }
  private validateOsc(input: unknown): OscSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeError('OSC設定が不正です。');
    const value = input as Record<string, unknown>;
    if (typeof value.enabled !== 'boolean' || typeof value.host !== 'string' || !value.host.trim() || !/^[A-Za-z0-9_.-]{1,253}$/.test(value.host) || typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.maxHz !== 'number' || !Number.isFinite(value.maxHz) || value.maxHz < 1 || value.maxHz > 120) throw new RuntimeError('OSCの宛先・ポート(1〜65535)・送信頻度(1〜120Hz)を確認してください。');
    const snapshotIntervalMs = value.snapshotIntervalMs ?? 1000;
    if (typeof snapshotIntervalMs !== 'number' || !Number.isFinite(snapshotIntervalMs) || snapshotIntervalMs < 100 || snapshotIntervalMs > 60_000) throw new RuntimeError('OSC再送間隔は100〜60000msで指定してください。');
    return { enabled: value.enabled, host: value.host.trim(), port: value.port, maxHz: value.maxHz, snapshotIntervalMs };
  }
  private startOutput(): void {
    if (!this.oscSettings.enabled) return;
    const view = new OscView(this.store);
    try {
      this.output = this.services.startOsc(view, { ...this.oscSettings, onError: error => {
        if (view === this.outputView) this.store.addDiagnostic('osc-error', 'error', error.message);
      } });
      this.outputView = view;
    } catch (error) { view.dispose(); throw error; }
  }
  private async stopOutput(): Promise<void> {
    const output = this.output, view = this.outputView;
    this.output = undefined; this.outputView = undefined;
    view?.invalidate();
    try { await output?.close(); } finally { view?.dispose(); }
  }
  private async stopSource(): Promise<void> {
    this.sourceAbort?.abort();
    await this.startup;
    await this.replayTask;
    await this.source?.close();
    this.source = undefined; this.sourceAbort = undefined; this.startup = undefined; this.replayTask = undefined;
    this.phase = 'idle';
    this.store.setSession({ state: 'disconnected', reason: '接続を終了しました。' });
  }
  async initialize(): Promise<void> {
    if (this.config.mode === 'idle') { await this.change(async () => { this.startOutput(); }); return; }
    if (['passive', 'virtual-device', 'az-standalone'].includes(this.config.mode)) {
      await this.connect({ ...this.settings }); return;
    }
    await this.change(async () => {
      const packets = this.config.mode === 'demo' ? makeDemoPackets(this.store.snapshot().session.id, this.config.demoDecks ?? 2) : await readCapture(this.config.capture!, this.store.snapshot().session.id);
      if (!packets.length) throw new RuntimeError('キャプチャに対応パケットがありません。');
      this.sourceAbort = new AbortController();
      const signal = this.sourceAbort.signal, store = this.store;
      this.phase = 'connected'; this.startOutput();
      this.replayTask = (async () => {
        let offset = 0;
        do {
          if (signal.aborted) return;
          store.setSession({ state: 'online', now: offset, reason: this.config.mode === 'demo' ? 'デモデータ' : '保存キャプチャ再生' });
          await replayPackets(packets.map(packet => ({ ...packet, receivedAt: packet.receivedAt + offset })), {
            speed: this.config.speed, signal, onPacket: packet => { store.tick(packet.receivedAt); store.ingest(packet); },
          });
          offset += packets[packets.length - 1].receivedAt + 250;
        } while (this.config.loop && !signal.aborted);
        if (!signal.aborted) store.setSession({ state: 'disconnected', reason: 'キャプチャの再生が終了しました。' });
      })().catch(error => {
        if (!signal.aborted) { this.lastError = error instanceof Error ? error.message : String(error); store.addDiagnostic('replay-error', 'error', this.lastError); store.setSession({ state: 'degraded', reason: this.lastError }); }
      });
    });
  }
  async connect(input: unknown): Promise<void> {
    const settings = this.validateConnection(input);
    await this.change(async () => {
      if (this.discovery.searching) throw new RuntimeError('機器を探索しています。完了後に接続してください。', 409);
      await this.stopSource(); await this.stopOutput();
      if (this.closed) throw new RuntimeError('アプリは終了しています。', 503);
      this.settings = settings; this.lastError = null; this.replaceStore();
      this.phase = 'connecting';
      const store = this.store, abort = new AbortController(); this.sourceAbort = abort;
      store.setSession({ state: 'observing', reason: '選択した接続先を確認しています。' });
      this.startOutput();
      const start = settings.backend === 'alphatheta' ? () => this.services.startCapture(store, settings.interfaceName) :
        () => this.services.startLive(store, { interfaceName: settings.interfaceName, mode: settings.mode, profile: settings.profile, deviceNumber: this.config.deviceNumber, signal: abort.signal,
          onError: error => {
            if (!abort.signal.aborted && this.store === store) { this.phase = 'error'; this.lastError = error.message; store.addDiagnostic('connection-error', 'error', error.message); }
          } });
      this.startup = Promise.resolve().then(start).then(async handle => {
        if (abort.signal.aborted || this.closed || this.store !== store) { await handle.close(); return; }
        this.source = handle;
        if (this.phase !== 'error') this.phase = 'connected';
      }).catch(error => {
        if (abort.signal.aborted || this.store !== store) return;
        this.phase = 'error'; this.lastError = error instanceof Error ? error.message : String(error);
        store.addDiagnostic('connection-error', 'error', this.lastError);
        store.setSession({ state: 'degraded', reason: this.lastError });
      });
    });
  }
  disconnect(): Promise<void> {
    return this.change(async () => {
      this.discoveryAbort?.abort(); await this.discoveryTask;
      await this.stopSource(); await this.stopOutput(); this.lastError = null;
    });
  }
  private getDiscovery() {
    const useScan = this.discovery.source === 'scan' && this.discoveryStore;
    const snapshot = useScan ? this.discoveryStore!.snapshot() : this.store.snapshot();
    const hasLiveSession = ['passive', 'virtual-device', 'az-standalone', 'alphatheta'].includes(snapshot.session.mode);
    const clock = useScan ? this.discoveryFinishedAt == null ? Math.max(snapshot.session.now, performance.now() - this.discoveryStartedAt) : snapshot.session.now + performance.now() - this.discoveryFinishedAt : Math.max(snapshot.session.now, this.storeClockNow + performance.now() - this.storeClockAt);
    const devices = useScan || hasLiveSession ? snapshot.devices.map(device => {
      const ageMs = Math.max(0, clock - device.lastSeenAt);
      return { ...device, ageMs, status: ageMs > 6000 ? 'stale' as const : device.status };
    }).sort((a, b) => a.sourceIp.localeCompare(b.sourceIp, 'en', { numeric: true }) || a.wireDeviceId - b.wireDeviceId) : [];
    return { ...this.discovery, interfaceName: this.discovery.interfaceName ?? (hasLiveSession ? this.settings.interfaceName ?? null : null), devices };
  }
  async discover(input: unknown): Promise<void> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { interfaceName?: unknown }).interfaceName !== 'string') throw new RuntimeError('探索するネットワーク接続を選択してください。');
    const interfaceName = (input as { interfaceName: string }).interfaceName;
    try { selectInterface(interfaceName, this.services.listInterfaces()); } catch (error) { throw new RuntimeError(error instanceof Error ? error.message : String(error)); }
    await this.change(async () => {
      if (this.discovery.searching) throw new RuntimeError('機器を探索しています。完了後に再試行してください。', 409);
      // A failed source may already have closed its sockets. Await both its
      // startup and close before opening a fresh receive-only scan; tapping a
      // dead listener would otherwise make retries permanently empty.
      if (this.phase === 'error' && ['passive', 'virtual-device', 'az-standalone'].includes(this.settings.mode)) await this.stopSource();
      if (this.closed) throw new RuntimeError('アプリは終了しています。', 503);
      const activeLive = ['passive', 'virtual-device', 'az-standalone'].includes(this.settings.mode) && (this.phase === 'connecting' || this.phase === 'connected');
      if (activeLive && this.settings.interfaceName !== interfaceName) throw new RuntimeError('別のLANを受信中です。現在の接続を切断してから探索してください。', 409);
      this.discoveryAbort = new AbortController(); const abort = this.discoveryAbort;
      this.discovery = { searching: true, attempted: true, interfaceName, source: activeLive ? 'session' : 'scan', error: null };
      this.discoveryStartedAt = performance.now(); this.discoveryFinishedAt = null;
      const store = activeLive ? this.store : new StateStore({ sessionId: randomUUID(), mode: 'passive', interfaceId: interfaceName });
      if (!activeLive) this.discoveryStore = store;
      this.discoveryTask = (async () => {
        try {
          if (activeLive) await delay(6000, undefined, { signal: abort.signal });
          else await this.services.discoverDevices(store, { interfaceName, durationMs: 6000, signal: abort.signal });
        } catch (error) { if (!abort.signal.aborted) this.discovery.error = error instanceof Error ? error.message : String(error); }
        finally {
          if (this.discoveryAbort === abort) {
            this.discovery.searching = false; this.discoveryFinishedAt = performance.now();
            this.discoveryAbort = undefined;
          }
        }
      })();
    });
  }
  async setOsc(input: unknown): Promise<void> {
    const settings = this.validateOsc(input);
    await this.change(async () => {
      // The old destination must see a later revision for valid=0, and the
      // new destination a later one again, even when the destination is reused.
      this.store.advanceRevision();
      await this.stopOutput();
      this.store.advanceRevision();
      const previous = this.oscSettings; this.oscSettings = settings;
      try { this.startOutput(); }
      catch (error) { this.oscSettings = previous; this.startOutput(); throw error; }
    });
  }
  async setNotifications(input: unknown): Promise<void> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as { enabled?: unknown }).enabled !== 'boolean') throw new RuntimeError('通知設定はenabledにtrue/falseを指定してください。');
    const enabled = (input as { enabled: boolean }).enabled;
    if (enabled && !this.notifications.getStatus().supported) throw new RuntimeError('OS通知は現在macOSのみ対応しています。');
    await this.change(async () => { this.notifications.setEnabled(enabled); });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      // Stop notification observation and signal acquisition synchronously:
      // callers can rely on close() aborting an in-flight startup immediately.
      const notificationsClosing = this.notifications.close();
      this.sourceAbort?.abort();
      this.discoveryAbort?.abort();
      await notificationsClosing;
      await this.activeChange;
      await this.discoveryTask;
      await this.stopSource(); await this.stopOutput();
      this.unsubscribe(); this.listeners.clear();
    })();
    return this.closing;
  }
}
