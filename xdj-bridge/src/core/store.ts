import { decodePacket, resolveProfile } from './decoder.js';
import type { Capability, DeckState, Diagnostic, Field, PacketEnvelope, PlaybackState, Profile, SessionState, Snapshot, StatusObservation, TrackRef } from './types.js';

const empty = <T>(source = 'unavailable'): Field<T> => ({ value: null, quality: 'unknown', source, observedAt: null, freshness: 'fresh' });
const observed = <T>(value: T | null | undefined, at: number, source: string): Field<T> => value == null ? empty<T>(source) : ({ value, quality: 'observed', source, observedAt: at, freshness: 'fresh' });
const fieldNames = ['title', 'artist', 'playbackState', 'trackBpm', 'effectiveBpm', 'pitchPercent', 'beat', 'beatPhase', 'positionMs', 'onAir'] as const;
const trackKey = (t: TrackRef | null) => t ? JSON.stringify(t) : '';
const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export interface StoreOptions {
  sessionId: string;
  mode: SessionState['mode'];
  interfaceId?: string;
  staleAfterMs?: number;
  profile?: Profile | 'auto';
  /** Keys may be full deckId or '<sourceIp>:<wireDeviceId>'. */
  publicDeckIds?: Record<string, string>;
}

export class StateStore {
  private state: Snapshot;
  private readonly options: StoreOptions;
  private readonly staleAfterMs: number;
  private readonly listeners = new Set<(snapshot: Snapshot) => void>();
  private readonly lastStatus = new Map<string, number>();
  private readonly owners = new Map<string, string>();
  private readonly mediaGenerations = new Map<string, number>();
  private readonly mediaFingerprints = new Map<string, string>();
  constructor(options: StoreOptions) {
    this.options = options;
    this.staleAfterMs = options.staleAfterMs ?? 3000;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs <= 0) throw new Error('staleAfterMs must be positive');
    this.state = { schemaVersion: 1, revision: 0, session: { id: options.sessionId, mode: options.mode, state: 'disconnected', interfaceId: options.interfaceId ?? null, reason: null, now: 0 }, decks: [], diagnostics: [] };
    this.diagnostic('media-observation-limit', 'info', 'Media removal cannot always be observed; metadata is invalidated after a receive gap or reconnect.', 0);
    if (options.mode === 'demo') this.diagnostic('synthetic-demo', 'warning', 'DEMO: all packets are synthetic and do not verify hardware support.', 0);
  }
  snapshot(): Snapshot { return structuredClone(this.state); }
  /** Order output reconfiguration without changing observed values/freshness. */
  advanceRevision(): void {
    for (const deck of this.state.decks) deck.stateRevision++;
    this.publish();
  }
  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(): void {
    this.state.revision++;
    for (const listener of this.listeners) listener(this.snapshot());
  }
  private diagnostic(code: string, level: Diagnostic['level'], message: string, now: number, deckId?: string): void {
    if (this.state.diagnostics.some(d => d.code === code && d.deckId === deckId && d.message === message)) return;
    this.state.diagnostics.push({ code, level, message, observedAt: now, ...(deckId ? { deckId } : {}) });
    if (this.state.diagnostics.length > 120) this.state.diagnostics.shift();
  }
  addDiagnostic(code: string, level: Diagnostic['level'], message: string, now = this.state.session.now): void {
    this.diagnostic(code, level, message, now);
    this.publish();
  }
  setSession(update: Partial<SessionState>): void {
    const was = this.state.session.state;
    // A session ID is immutable: consumers use it to reject old UDP revisions.
    const { id: _id, now, ...rest } = update;
    Object.assign(this.state.session, rest);
    if (finite(now)) this.state.session.now = Math.max(this.state.session.now, now);
    if (update.state === 'disconnected' || update.state === 'degraded') {
      for (const d of this.state.decks) {
        for (const k of fieldNames) d[k].freshness = 'stale';
        // Availability describes this session's usable values. Ending a
        // session does not erase historical provider successes/failures or
        // manufacture a new provider failure.
        for (const capability of Object.values(d.capabilities)) if (capability.availability === 'available') {
          capability.availability = 'unavailable';
          capability.reason = `Session ${update.state}; retained values are stale.`;
        }
        d.stateRevision++;
      }
    }
    if (update.state === 'disconnected' && was !== 'disconnected') {
      const media = new Map<string, { source: string; slot: number }>();
      for (const d of this.state.decks) if (d.trackRef) media.set(`${d.trackRef.sourceDeviceId}:${d.trackRef.protocolSlot}`, { source: d.trackRef.sourceDeviceId, slot: d.trackRef.protocolSlot });
      for (const m of media.values()) this.bumpMedia(m.source, m.slot, this.state.session.now, false);
    }
    this.publish();
  }
  ingest(envelope: PacketEnvelope): void {
    if (envelope.sessionId !== this.state.session.id) return;
    const event = decodePacket(envelope);
    if (!event) return;
    const now = envelope.receivedAt;
    this.state.session.now = Math.max(this.state.session.now, now);
    if (event.kind === 'status') { this.ingestStatus(event.status); return; }
    if (event.kind === 'announcement') {
      const physical = this.physicalId(envelope.interfaceId, envelope.sourceIp, event.model);
      this.registerOwner(envelope.interfaceId, event.wireDeviceId, physical, now);
      if (this.state.session.state === 'disconnected') this.state.session.state = 'observing';
      this.publish();
      return;
    }
    if (event.kind === 'media') {
      const source = this.owners.get(`${envelope.interfaceId}:${event.wireDeviceId}`) ?? `${this.state.session.id}/${envelope.interfaceId}/source-${event.wireDeviceId}`;
      const key = `${source}:${event.slot}`;
      const previous = this.mediaFingerprints.get(key);
      this.mediaFingerprints.set(key, event.fingerprint);
      if (previous !== undefined && previous !== event.fingerprint) this.bumpMedia(source, event.slot, now, true);
      this.publish();
      return;
    }
    // Beat/position updates cannot create phantom decks before a status packet.
    const d = this.state.decks.find(d => d.wireDeviceId === event.wireDeviceId && d.raw.sourceIp === envelope.sourceIp && d.raw.interfaceId === envelope.interfaceId);
    if (!d || now < (this.lastStatus.get(d.deckId) ?? 0)) return;
    if (event.kind === 'beat') {
      // Beat phase zero is directly observed at the notification; it is not an
      // absolute track beat or position and is never extrapolated from BPM.
      if (event.beatInMeasure != null) d.beatPhase = observed(0, now, `${envelope.transport}:beat-notification`);
      else d.beatPhase = empty('invalid-beat-notification');
      d.capabilities.beat = this.capability('implemented-unverified', event.beatInMeasure != null ? 'available' : 'unavailable', 'Beat notification received; track beat remains independent.', now, `${envelope.transport}:beat`);
    } else {
      d.positionMs = observed(event.positionMs, now, `${envelope.transport}:absolute-position`);
      d.capabilities.position = this.capability('implemented-unverified', 'available', 'Absolute position packet received; no BPM-derived track position.', now, `${envelope.transport}:position`);
    }
    d.stateRevision++;
    this.publish();
  }
  private physicalId(iface: string, ip: string, model: string): string {
    // Identity is scoped to this session and receiving interface, never a
    // persistent IP-only key. RX3/AZ logical decks share one physical device.
    return `${this.state.session.id}/${iface}/${encodeURIComponent(model || 'unknown')}@${ip}`;
  }
  private registerOwner(iface: string, wire: number, physical: string, now: number): void {
    this.owners.set(`${iface}:${wire}`, physical);
    const unresolved = `${this.state.session.id}/${iface}/source-${wire}`;
    const dependents = this.state.decks.filter(d => d.trackRef?.sourceDeviceId === unresolved && d.trackRef.sourceWireDeviceId === wire && d.raw.interfaceId === iface);
    // Resolve only the exact wire source actually observed on this interface.
    // A model's anticipated deck count is never evidence that an external
    // linked media source belongs to the same physical unit.
    for (const slot of new Set(dependents.map(d => d.trackRef!.protocolSlot))) {
      const oldKey = `${unresolved}:${slot}`, newKey = `${physical}:${slot}`;
      const generation = Math.max(this.mediaGenerations.get(oldKey) ?? 0, this.mediaGenerations.get(newKey) ?? 0);
      this.mediaGenerations.set(newKey, generation);
      for (const d of dependents) if (d.trackRef!.protocolSlot === slot) {
        d.trackRef!.sourceDeviceId = physical;
        d.trackRef!.mediaGeneration = generation;
      }
      const fingerprint = this.mediaFingerprints.get(oldKey);
      if (fingerprint !== undefined && !this.mediaFingerprints.has(newKey)) this.mediaFingerprints.set(newKey, fingerprint);
      this.mediaGenerations.delete(oldKey); this.mediaFingerprints.delete(oldKey);
      // Earlier metadata was requested under an unresolved owner. Invalidate
      // those generations and all shared-media dependents before publishing.
      this.bumpMedia(physical, slot, now, true);
    }
    if (dependents.length) this.diagnostic('source-owner-resolved', 'info', `Observed wire source ${wire} resolved to a physical device; previous metadata generations were invalidated.`, now);
  }
  private capability(verification: Capability['verification'], availability: Capability['availability'], reason: string, now: number, source: string): Capability {
    return { verification, availability, reason, source, firmware: null, os: process.platform, mode: this.state.session.mode, lastSuccessAt: availability === 'available' ? now : null, lastFailureAt: availability === 'error' || availability === 'unavailable' ? now : null };
  }
  private resetMediaCapabilities(d: DeckState, now: number, reason: string): void {
    for (const feature of ['metadata', 'analysis', 'position']) {
      const previous = d.capabilities[feature] ?? this.capability('implemented-unverified', 'idle', '', now, `${feature}-provider`);
      d.capabilities[feature] = { ...previous, availability: feature === 'position' ? 'unavailable' : 'idle', reason };
    }
    // The status beat counter can remain independently observed. A cleared
    // notification alone cannot keep beat capability available.
    if (d.beat.value == null && d.capabilities.beat?.availability === 'available') {
      d.capabilities.beat.availability = 'unavailable';
      d.capabilities.beat.reason = reason;
    }
  }
  private playback(s: StatusObservation, profile: Profile): PlaybackState | null {
    if (profile === 'xdj-rx3') {
      const rx: Record<number, PlaybackState> = { 0: 'stopped', 2: 'loading', 3: 'playing', 4: 'playing', 5: 'paused', 6: 'cued', 7: 'playing', 8: 'scratching', 9: 'searching', 0x11: 'stopped' };
      return rx[s.playState] ?? null;
    }
    const known: Record<number, PlaybackState> = { 0: 'stopped', 2: 'loading', 3: 'playing', 4: 'playing', 5: 'paused', 6: 'cued', 7: 'playing', 8: 'scratching', 9: 'searching', 0x0e: 'stopped', 0x11: 'stopped' };
    if (!(s.playState in known)) return null;
    // Keep an observed transport state; do not turn absent standard flags
    // into a false assertion of pause.
    return known[s.playState];
  }
  ingestStatus(s: StatusObservation): void {
    if (s.sessionId && s.sessionId !== this.state.session.id) return;
    if (!finite(s.receivedAt) || s.receivedAt < 0 || !Number.isInteger(s.wireDeviceId) || s.wireDeviceId < 1 || s.wireDeviceId > 255) return;
    const now = s.receivedAt;
    const resolved = resolveProfile(s.model, this.options.profile);
    const profile = resolved.profile;
    const physical = this.physicalId(s.interfaceId, s.sourceIp, s.model);
    const logicalDeck = profile === 'xdj-rx3' ? ({ 11: 1, 12: 2 } as Record<number, number>)[s.wireDeviceId] ?? null : profile === 'xdj-az' ? (s.wireDeviceId >= 1 && s.wireDeviceId <= 4 ? s.wireDeviceId : null) : (s.wireDeviceId <= 6 ? s.wireDeviceId : null);
    const deckId = `${physical}/deck-${logicalDeck ?? `wire-${s.wireDeviceId}`}`;
    let d = this.state.decks.find(d => d.deckId === deckId);
    const previousAt = this.lastStatus.get(deckId);
    if (previousAt !== undefined && now < previousAt) return;
    this.registerOwner(s.interfaceId, s.wireDeviceId, physical, now);
    if (!d) {
      let publicDeckId = this.options.publicDeckIds?.[deckId] ?? this.options.publicDeckIds?.[`${s.sourceIp}:${s.wireDeviceId}`] ?? (logicalDeck == null ? null : String(logicalDeck));
      if (publicDeckId && this.state.decks.some(other => other.publicDeckId === publicDeckId)) {
        this.diagnostic('public-deck-collision', 'warning', `Public deck ${publicDeckId} is already assigned; configure an explicit unique mapping.`, now, deckId);
        publicDeckId = null;
      }
      d = { schemaVersion: 1, sessionId: this.state.session.id, deckId, physicalDeviceId: physical, publicDeckId, logicalDeck, wireDeviceId: s.wireDeviceId, model: s.model, profile, stateRevision: 0, loadGeneration: 0, trackRef: null, title: empty(), artist: empty(), playbackState: empty(), trackBpm: empty(), effectiveBpm: empty(), pitchPercent: empty(), beat: empty(), beatPhase: empty(), positionMs: empty(), onAir: empty(), capabilities: {}, raw: {} };
      this.state.decks.push(d);
      this.diagnostic('profile-resolved', resolved.forced ? 'warning' : 'info', resolved.reason + (resolved.forced ? '; forced trial remains unverified.' : ''), now, deckId);
      if (logicalDeck == null) this.diagnostic('unmapped-deck', 'warning', `Wire device ${s.wireDeviceId} has no confirmed logical deck mapping.`, now, deckId);
    }
    if (previousAt !== undefined && (now - previousAt > this.staleAfterMs || d.playbackState.freshness === 'stale') && d.trackRef) this.bumpMedia(d.trackRef.sourceDeviceId, d.trackRef.protocolSlot, now, true);
    this.lastStatus.set(deckId, now);
    let owner = this.owners.get(`${s.interfaceId}:${s.sourceWireDeviceId}`);
    if (profile === 'xdj-rx3' && [11, 12].includes(s.sourceWireDeviceId)) owner = physical;
    if (!owner) owner = `${this.state.session.id}/${s.interfaceId}/source-${s.sourceWireDeviceId}`;
    const mediaGeneration = this.mediaGenerations.get(`${owner}:${s.protocolSlot}`) ?? 0;
    const nextRef: TrackRef | null = s.trackId > 0 && s.sourceWireDeviceId > 0 && s.protocolSlot > 0 && s.trackType > 0 ? { sourceDeviceId: owner, sourceWireDeviceId: s.sourceWireDeviceId, protocolSlot: s.protocolSlot, mediaGeneration, trackId: s.trackId, trackType: s.trackType } : null;
    // A loading transition also invalidates same-ID reloads and delayed work.
    const loadingTransition = s.playState === 2 && d.raw.playState !== 2;
    if (trackKey(nextRef) !== trackKey(d.trackRef) || loadingTransition) {
      d.loadGeneration++;
      d.title = empty('track-change'); d.artist = empty('track-change');
      d.positionMs = empty('track-change'); d.beatPhase = empty('track-change');
      this.resetMediaCapabilities(d, now, 'New track load; metadata, analysis and absolute position require observations for this generation.');
    }
    d.trackRef = nextRef;
    const source = s.source ?? 'alphatheta:status';
    const bpm = finite(s.trackBpm) && s.trackBpm > 0 && s.trackBpm < 1000 ? s.trackBpm : null;
    const pitch = finite(s.pitchPercent) && s.pitchPercent >= -100 && s.pitchPercent <= 100 ? s.pitchPercent : null;
    const playback = this.playback(s, profile);
    d.playbackState = observed(playback, now, profile === 'xdj-rx3' ? `${source}:rx3-playState` : `${source}:playState`);
    d.trackBpm = observed(bpm, now, source);
    d.pitchPercent = observed(pitch, now, source);
    d.effectiveBpm = observed(bpm != null && pitch != null ? bpm * (1 + pitch / 100) : null, now, `${source}:effective-pitch`);
    // Invalid counters must never become zero or a synthetic beat.
    d.beat = observed(finite(s.beat) && s.beat > 0 && s.beat < 0xffffffff ? s.beat : null, now, source);
    if (s.positionMs !== undefined) {
      d.positionMs = observed(finite(s.positionMs) && s.positionMs >= 0 ? s.positionMs : null, now, `${source}:absolute-position`);
      d.capabilities.position = this.capability('implemented-unverified', d.positionMs.value == null ? 'unavailable' : 'available', 'Absolute position observation; no BPM-derived track position.', now, `${source}:absolute-position`);
    }
    d.onAir = empty('unverified-on-air-semantics');
    const verification = profile === 'xdj-rx3' && this.state.session.mode === 'replay' && !resolved.forced ? 'verified' : 'implemented-unverified';
    d.capabilities.status = this.capability(verification, 'available', profile === 'xdj-rx3' ? 'RX3 packet interpretation matches saved captures; live firmware support requires hardware verification.' : 'Generic decoder; this model/firmware requires hardware verification.', now, source);
    d.capabilities.bpm = this.capability(verification, bpm == null ? 'unavailable' : 'available', bpm == null ? 'No valid track BPM.' : 'Track BPM and effective pitch are separate observations.', now, source);
    d.capabilities.playback = this.capability(verification, playback == null ? 'unavailable' : 'available', playback == null ? `Unknown playState ${s.playState}.` : 'Decoded playState.', now, source);
    const hasBeat = d.beat.value != null || (d.beatPhase.value != null && d.beatPhase.freshness === 'fresh' && d.beatPhase.observedAt != null && now - d.beatPhase.observedAt <= this.staleAfterMs);
    d.capabilities.beat = this.capability('implemented-unverified', hasBeat ? 'available' : 'unavailable', 'Beat counter and fresh notifications are checked independently of BPM.', now, source);
    d.capabilities.position ??= this.capability('implemented-unverified', 'unavailable', 'No absolute position observed; BPM is not a track-position source.', now, source);
    d.capabilities.metadata ??= this.capability('implemented-unverified', 'idle', 'Metadata provider has not succeeded.', now, 'metadata-provider');
    d.capabilities.analysis ??= this.capability('implemented-unverified', 'idle', 'Analysis provider has not succeeded.', now, 'analysis-provider');
    d.capabilities.onAir = this.capability('unknown', 'unavailable', 'Mixer/model-specific audible-state semantics have not been verified.', now, source);
    d.raw = { ...s.raw, sourceIp: s.sourceIp, interfaceId: s.interfaceId, playState: s.playState, statusFlags: s.statusFlags ?? null, playingFlag: s.statusFlags == null ? null : Boolean(s.statusFlags & 0x40), beatInMeasure: s.beatInMeasure ?? null, firmware: null };
    d.stateRevision++;
    this.state.session.now = Math.max(this.state.session.now, now);
    this.state.session.state = this.state.decks.some(other => other.deckId !== deckId && other.playbackState.freshness === 'stale') ? 'degraded' : 'online';
    this.state.session.interfaceId ??= s.interfaceId;
    this.state.session.reason = null;
    this.publish();
  }
  tick(now: number): void {
    if (!finite(now) || now < this.state.session.now) return;
    this.state.session.now = now;
    let changed = false;
    let freshDecks = 0;
    for (const d of this.state.decks) {
      const silent = now - (this.lastStatus.get(d.deckId) ?? 0) > this.staleAfterMs;
      if (!silent) freshDecks++;
      let deckChanged = false;
      for (const k of fieldNames) {
        const field = d[k];
        const expiresIndependently = k === 'beatPhase' || k === 'positionMs';
        if ((silent || (expiresIndependently && field.observedAt != null && now - field.observedAt > this.staleAfterMs)) && field.freshness !== 'stale') { field.freshness = 'stale'; deckChanged = true; }
      }
      if (silent && d.capabilities.status?.availability === 'available') {
        d.capabilities.status.availability = 'unavailable'; d.capabilities.status.reason = 'Status reception exceeded freshness limit.'; d.capabilities.status.lastFailureAt = now; deckChanged = true;
      }
      const usable = (field: Field<unknown>) => field.value != null && field.quality !== 'unknown' && field.freshness === 'fresh';
      const available: Record<string, boolean> = {
        bpm: usable(d.trackBpm), playback: usable(d.playbackState),
        beat: usable(d.beat) || usable(d.beatPhase), position: usable(d.positionMs),
        metadata: usable(d.title) || usable(d.artist),
      };
      for (const [feature, valid] of Object.entries(available)) {
        const capability = d.capabilities[feature];
        if (!valid && capability?.availability === 'available') {
          capability.availability = 'unavailable'; capability.reason = 'Feature values exceeded the freshness limit or became unknown.'; capability.lastFailureAt = now; deckChanged = true;
        }
      }
      if (deckChanged) { d.stateRevision++; changed = true; }
    }
    if (this.state.decks.length && freshDecks < this.state.decks.length && this.state.session.state === 'online') {
      this.state.session.state = 'degraded'; this.state.session.reason = 'One or more decks exceeded the receive freshness limit.'; changed = true;
    }
    if (changed) this.publish();
  }
  applyMetadata(response: { deckId: string; loadGeneration: number; mediaGeneration: number; title?: string; artist?: string }, now: number): boolean {
    const d = this.state.decks.find(d => d.deckId === response.deckId);
    if (!d?.trackRef || d.loadGeneration !== response.loadGeneration || d.trackRef.mediaGeneration !== response.mediaGeneration || d.playbackState.freshness === 'stale' || this.state.session.state === 'disconnected') return false;
    if (response.title !== undefined) d.title = observed(response.title, now, 'metadata-provider');
    if (response.artist !== undefined) d.artist = observed(response.artist, now, 'metadata-provider');
    d.capabilities.metadata = this.capability('implemented-unverified', 'available', 'Provider response matched current load and media generations.', now, 'metadata-provider');
    d.stateRevision++; this.publish(); return true;
  }
  setCapability(deckId: string, feature: string, update: Partial<Capability>): void {
    const d = this.state.decks.find(d => d.deckId === deckId);
    if (!d) return;
    d.capabilities[feature] = { ...this.capability('implemented-unverified', 'idle', '', this.state.session.now, 'provider'), ...d.capabilities[feature], ...update };
    d.stateRevision++; this.publish();
  }
  private bumpMedia(source: string, slot: number, now: number, clear: boolean): void {
    const key = `${source}:${slot}`;
    const generation = (this.mediaGenerations.get(key) ?? 0) + 1;
    this.mediaGenerations.set(key, generation);
    for (const d of this.state.decks) if (d.trackRef?.sourceDeviceId === source && d.trackRef.protocolSlot === slot) {
      d.trackRef.mediaGeneration = generation;
      d.loadGeneration++;
      if (clear) {
        d.title = empty('media-change'); d.artist = empty('media-change'); d.positionMs = empty('media-change'); d.beatPhase = empty('media-change');
        this.resetMediaCapabilities(d, now, 'Media generation changed; metadata, analysis and absolute position require observations for this generation.');
      }
      d.stateRevision++;
    }
    this.diagnostic('media-generation', 'info', `Media generation ${generation} for wire slot ${slot}; physical USB label is unverified.`, now);
  }
  invalidateMedia(sourceDeviceId: string, slot: number, now: number): void {
    this.bumpMedia(sourceDeviceId, slot, now, true); this.publish();
  }
}
