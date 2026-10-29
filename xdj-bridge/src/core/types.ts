export type Quality = 'observed' | 'estimated' | 'unknown';
export interface Field<T> {
  value: T | null;
  quality: Quality;
  source: string;
  observedAt: number | null;
  freshness: 'fresh' | 'stale';
}
export type Profile = 'xdj-rx3' | 'xdj-az' | 'generic-prolink';
export interface PacketEnvelope {
  sessionId: string;
  interfaceId: string;
  sourceIp: string;
  sourcePort: number;
  destinationIp: string;
  destinationPort: number;
  transport: 'udp' | 'pcap' | 'replay' | 'alphatheta';
  bytes: Buffer;
  /** Monotonic session-relative milliseconds, never Date.now(). */
  receivedAt: number;
}
export interface SessionState {
  id: string;
  mode: 'idle' | 'replay' | 'demo' | 'passive' | 'virtual-device' | 'alphatheta';
  state: 'disconnected' | 'observing' | 'joining' | 'online' | 'degraded';
  interfaceId: string | null;
  reason: string | null;
  now: number;
}
export interface Diagnostic {
  code: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  observedAt: number;
  deckId?: string;
}
export interface Capability {
  verification: 'unknown' | 'implemented-unverified' | 'verified' | 'unsupported';
  availability: 'idle' | 'available' | 'unavailable' | 'error';
  reason: string;
  source: string;
  firmware: string | null;
  os: string;
  mode: SessionState['mode'];
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}
export interface TrackRef {
  sourceDeviceId: string;
  sourceWireDeviceId: number;
  protocolSlot: number;
  mediaGeneration: number;
  trackId: number;
  trackType: number;
}
export type PlaybackState = 'playing' | 'paused' | 'cued' | 'loading' | 'stopped' | 'searching' | 'scratching' | 'unknown';
export interface DeckState {
  schemaVersion: 1;
  sessionId: string;
  deckId: string;
  physicalDeviceId: string;
  publicDeckId: string | null;
  logicalDeck: number | null;
  wireDeviceId: number;
  model: string;
  profile: Profile;
  stateRevision: number;
  loadGeneration: number;
  trackRef: TrackRef | null;
  title: Field<string>;
  artist: Field<string>;
  playbackState: Field<PlaybackState>;
  trackBpm: Field<number>;
  effectiveBpm: Field<number>;
  pitchPercent: Field<number>;
  beat: Field<number>;
  beatPhase: Field<number>;
  positionMs: Field<number>;
  onAir: Field<boolean>;
  capabilities: Record<string, Capability>;
  raw: Record<string, unknown>;
}
export interface Snapshot {
  schemaVersion: 1;
  revision: number;
  session: SessionState;
  decks: DeckState[];
  diagnostics: Diagnostic[];
}
export interface StateSource {
  snapshot(): Snapshot;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
}
/** Public alphatheta-connect status events are adapted to this boundary. */
export interface StatusObservation {
  sessionId?: string;
  interfaceId: string;
  sourceIp: string;
  receivedAt: number;
  wireDeviceId: number;
  model: string;
  trackId: number;
  sourceWireDeviceId: number;
  protocolSlot: number;
  trackType: number;
  playState: number;
  trackBpm: number | null;
  pitchPercent: number | null;
  statusFlags?: number;
  beat?: number | null;
  beatInMeasure?: number | null;
  positionMs?: number | null;
  source?: string;
  raw?: Record<string, unknown>;
}
