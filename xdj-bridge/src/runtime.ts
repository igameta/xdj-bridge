import { randomUUID } from 'node:crypto';
import { StateStore } from './core/store.js';
import type { Profile, Snapshot, StateSource } from './core/types.js';
import type { AppConfig } from './config.js';
import { listInterfaces, selectInterface, startLive, type LiveOptions, type SelectedInterface } from './transport/live.js';
import { startAlphathetaCapture } from './adapters/alphatheta.js';
import { startOsc, type OscOptions } from './output/osc.js';
import { makeDemoPackets, readCapture, replayPackets } from './transport/replay.js';

interface SourceHandle { close(): Promise<void> }
export interface RuntimeServices {
  listInterfaces(): SelectedInterface[];
  startLive(store: StateStore, options: LiveOptions): Promise<SourceHandle>;
  startCapture(store: StateStore, interfaceName: string): Promise<SourceHandle>;
  startOsc(store: StateSource, options: OscOptions): SourceHandle;
}
export interface ConnectionSettings {
  mode: 'virtual-device' | 'passive';
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
  constructor(private config: AppConfig, services: Partial<RuntimeServices> = {}) {
    this.services = { listInterfaces, startLive, startCapture: startAlphathetaCapture, startOsc, ...services };
    this.settings = { mode: config.mode, backend: config.backend, interfaceName: config.interfaceName, profile: config.profile };
    this.oscSettings = { enabled: Boolean(config.osc && config.osc.enabled !== false), host: config.osc?.host ?? '127.0.0.1', port: config.osc?.port ?? 9000, maxHz: config.osc?.maxHz ?? 20, snapshotIntervalMs: config.osc?.snapshotIntervalMs ?? 1000 };
    this.store = this.createStore();
    this.unsubscribe = this.forward(this.store);
  }
  private createStore(): StateStore {
    return new StateStore({ sessionId: randomUUID(), mode: this.settings.mode, interfaceId: this.settings.interfaceName,
      profile: this.settings.profile, staleAfterMs: this.config.staleAfterMs, publicDeckIds: this.config.publicDeckIds });
  }
  private forward(store: StateStore): () => void {
    return store.subscribe(snapshot => {
      if (store !== this.store) return;
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
    };
  }
  private replaceStore(): void {
    this.unsubscribe(); this.store = this.createStore(); this.unsubscribe = this.forward(this.store);
    for (const listener of this.listeners) listener(this.snapshot());
  }
  private change(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new RuntimeError('アプリは終了しています。', 503));
    if (this.changing) return Promise.reject(new RuntimeError('設定を変更しています。完了後に再試行してください。', 409));
    this.changing = true;
    const task = Promise.resolve().then(operation);
    this.activeChange = task.catch(() => {});
    return task.finally(() => { this.changing = false; });
  }
  private validateConnection(input: unknown): ConnectionSettings {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeError('接続設定が不正です。');
    const value = input as Record<string, unknown>;
    if (typeof value.mode !== 'string' || !['virtual-device', 'passive'].includes(value.mode) || typeof value.backend !== 'string' || !['native', 'alphatheta'].includes(value.backend) || typeof value.profile !== 'string' || !['auto', 'xdj-rx3', 'xdj-az', 'generic-prolink'].includes(value.profile)) throw new RuntimeError('接続方法・機器の設定が不正です。');
    if (typeof value.interfaceName !== 'string' || !value.interfaceName.trim()) throw new RuntimeError('ネットワーク接続を選択してください。');
    if (value.backend === 'alphatheta' && value.mode !== 'passive') throw new RuntimeError('pcapは受信のみで使用できます。');
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
    if (['passive', 'virtual-device'].includes(this.config.mode)) {
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
      await this.stopSource(); await this.stopOutput();
      this.settings = settings; this.lastError = null; this.replaceStore();
      this.phase = 'connecting';
      const store = this.store, abort = new AbortController(); this.sourceAbort = abort;
      store.setSession({ state: 'observing', reason: '選択した接続先を確認しています。' });
      this.startOutput();
      const start = settings.backend === 'alphatheta' ? () => this.services.startCapture(store, settings.interfaceName) :
        () => this.services.startLive(store, { interfaceName: settings.interfaceName, mode: settings.mode, deviceNumber: this.config.deviceNumber, signal: abort.signal,
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
    return this.change(async () => { await this.stopSource(); await this.stopOutput(); this.lastError = null; });
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
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      this.sourceAbort?.abort();
      await this.activeChange;
      await this.stopSource(); await this.stopOutput();
      this.unsubscribe(); this.listeners.clear();
    })();
    return this.closing;
  }
}
