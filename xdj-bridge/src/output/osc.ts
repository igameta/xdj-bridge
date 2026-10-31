import dgram from 'node:dgram';
import type { DeckState, Field, Snapshot, StateSource } from '../core/types.js';
import { selectRepresentative } from '../core/representative.js';

export type OscArgument = number | string;
export interface OscMessage { address: string; args: OscArgument[]; types?: string }
export const OSC_QUALITY = { unknown: 0, observed: 1, estimated: 2 } as const;

function oscString(value: string): Buffer {
  if (value.includes('\0')) throw new Error('OSC strings cannot contain NUL');
  const bytes = Buffer.from(value, 'utf8');
  const result = Buffer.alloc(Math.ceil((bytes.length + 1) / 4) * 4);
  bytes.copy(result);
  return result;
}

/** Integer tags are explicit; ordinary numeric arguments use OSC float32. */
export function encodeOscMessage(message: OscMessage): Buffer {
  if (!message.address.startsWith('/') || message.address.includes('\0')) throw new Error('Invalid OSC address');
  const types = message.types ?? message.args.map(value => typeof value === 'string' ? 's' : 'f').join('');
  if (types.length !== message.args.length) throw new Error('OSC type/argument count mismatch');
  const args = message.args.map((value, index) => {
    const type = types[index];
    if (type === 's' && typeof value === 'string') return oscString(value);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid OSC argument');
    const bytes = Buffer.alloc(4);
    if (type === 'i' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) bytes.writeInt32BE(value);
    else if (type === 'f') bytes.writeFloatBE(value);
    else throw new Error('Invalid OSC type or integer range');
    return bytes;
  });
  return Buffer.concat([oscString(message.address), oscString(',' + types), ...args]);
}

export function encodeOscBundle(messages: OscMessage[]): Buffer {
  const immediate = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]);
  return Buffer.concat([oscString('#bundle'), immediate, ...messages.flatMap(message => {
    const bytes = encodeOscMessage(message);
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    return [size, bytes];
  })]);
}

export function decodeOscPacket(bytes: Buffer): OscMessage[] {
  let offset = 0;
  const readString = () => {
    const end = bytes.indexOf(0, offset);
    if (end < offset) throw new Error('Invalid OSC string');
    const value = bytes.toString('utf8', offset, end);
    offset = Math.ceil((end + 1) / 4) * 4;
    if (offset > bytes.length) throw new Error('Truncated OSC padding');
    return value;
  };
  const address = readString();
  if (address === '#bundle') {
    offset += 8;
    if (offset > bytes.length) throw new Error('Truncated OSC timetag');
    const messages: OscMessage[] = [];
    while (offset < bytes.length) {
      if (offset + 4 > bytes.length) throw new Error('Truncated OSC bundle');
      const length = bytes.readUInt32BE(offset); offset += 4;
      if (!length || offset + length > bytes.length) throw new Error('Invalid OSC bundle size');
      messages.push(...decodeOscPacket(bytes.subarray(offset, offset + length))); offset += length;
    }
    return messages;
  }
  if (!address.startsWith('/')) throw new Error('Invalid OSC address');
  const tags = readString();
  if (!tags.startsWith(',')) throw new Error('Invalid OSC tags');
  const args: OscArgument[] = [];
  for (const tag of tags.slice(1)) {
    if (tag === 's') args.push(readString());
    else if (tag === 'i' || tag === 'f') {
      if (offset + 4 > bytes.length) throw new Error('Truncated OSC argument');
      args.push(tag === 'i' ? bytes.readInt32BE(offset) : bytes.readFloatBE(offset)); offset += 4;
    } else throw new Error('Unsupported OSC tag');
  }
  return [{ address, args, types: tags.slice(1) }];
}

function fieldMessages(path: string, field: Field<unknown>, transform?: (value: unknown) => string | number | boolean): OscMessage[] {
  const value = field.value !== null && transform ? transform(field.value) : field.value;
  // A field too large for our bounded datagram must invalidate any previous
  // receiver value; never announce valid=1 and then omit its payload.
  const fits = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') <= 512 : typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean';
  const valid = field.value !== null && field.quality !== 'unknown' && field.freshness === 'fresh' && fits;
  const messages: OscMessage[] = [
    { address: path + '/valid', args: [valid ? 1 : 0], types: 'i' },
    { address: path + '/quality', args: [OSC_QUALITY[field.quality]], types: 'i' },
    { address: path + '/fresh', args: [field.freshness === 'fresh' ? 1 : 0], types: 'i' },
  ];
  if (valid) {
    if (typeof value === 'number' && Number.isFinite(value)) messages.push({ address: path, args: [value] });
    else if (typeof value === 'string') messages.push({ address: path, args: [value.replaceAll('\0', '')] });
    else if (typeof value === 'boolean') messages.push({ address: path, args: [value ? 1 : 0], types: 'i' });
  }
  return messages;
}

function playbackMessages(base: string, deck?: DeckState): OscMessage[] {
  const knownPlayback = ['playing', 'looping', 'cue_playing', 'paused', 'cued', 'stopped', 'ended', 'no_track'];
  const playing: Field<unknown> = deck ? { ...deck.playbackState } : unavailableField();
  if (!knownPlayback.includes(String(playing.value))) { playing.value = null; playing.quality = 'unknown'; }
  return fieldMessages(base + '/playing', playing, value => ['playing', 'looping', 'cue_playing'].includes(String(value)));
}

function unavailableField(): Field<unknown> {
  return { value: null, quality: 'unknown', source: 'representative-unavailable', observedAt: null, freshness: 'stale' };
}

/** The shared selector rechecks private OSC invalidation views as well as the
 * ordinary normalized snapshot; retained representative IDs cannot outlive a
 * disconnected or stale source. */
function representativeMessages(snapshot: Snapshot): OscMessage[] {
  const representative = selectRepresentative(snapshot, snapshot.representative?.deckId);
  const deck = snapshot.decks.find(item => item.deckId === representative.deckId);
  const base = '/dj/representative';
  const messages: OscMessage[] = [
    { address: base + '/valid', args: [deck ? 1 : 0], types: 'i' },
    { address: base + '/reason', args: [representative.reason] },
  ];
  if (deck) {
    messages.push({ address: base + '/public_deck_id', args: [deck.publicDeckId!] });
  }
  const identity: Field<string> = deck ? { value: deck.deckId, quality: 'observed', source: 'representative-identity', observedAt: deck.playbackState.observedAt, freshness: 'fresh' } : { ...unavailableField(), value: null };
  messages.push(...fieldMessages(base + '/deck_id', identity));
  for (const [name, field] of [
    ['bpm', deck?.trackBpm], ['effective_bpm', deck?.effectiveBpm],
    ['pitch_percent', deck?.pitchPercent], ['tempo_master', deck?.tempoMaster],
  ] as const) messages.push(...fieldMessages(base + '/' + name, field ?? unavailableField()));
  messages.push(...playbackMessages(base, deck));
  return messages;
}

const REPRESENTATIVE_HEADERS = new Set([
  '/dj/representative/valid', '/dj/representative/reason',
  '/dj/representative/public_deck_id',
]);

export function snapshotToOsc(snapshot: Snapshot): OscMessage[] {
  const messages: OscMessage[] = [
    { address: '/dj/schema_version', args: [snapshot.schemaVersion], types: 'i' },
    { address: '/dj/session_id', args: [snapshot.session.id] },
    { address: '/dj/revision', args: [String(snapshot.revision)] },
  ];
  messages.push(...representativeMessages(snapshot));
  for (const deck of snapshot.decks) {
    if (typeof deck.publicDeckId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(deck.publicDeckId)) continue;
    const base = '/dj/decks/' + deck.publicDeckId;
    messages.push({ address: base + '/revision', args: [String(deck.stateRevision)] });
    messages.push({ address: base + '/deck_id', args: [deck.deckId] });
    const referenceField = <T>(value: T | null): Field<T> => ({ value, quality: value === null ? 'unknown' : 'observed', source: 'track-reference', observedAt: deck.playbackState.observedAt, freshness: deck.playbackState.freshness });
    const fields = [
      ['bpm', deck.trackBpm], ['effective_bpm', deck.effectiveBpm], ['pitch_percent', deck.pitchPercent],
      ['position_ms', deck.positionMs], ['beat', deck.beat], ['beat_phase', deck.beatPhase],
      ['on_air', deck.onAir], ['tempo_master', deck.tempoMaster ?? unavailableField()], ['title', deck.title], ['artist', deck.artist],
      ['track_id', referenceField(deck.trackRef ? String(deck.trackRef.trackId) : null)],
      ['source_slot', referenceField(deck.trackRef?.protocolSlot ?? null)],
      ['source_device_id', referenceField(deck.trackRef?.sourceDeviceId ?? null)],
    ] as const;
    for (const [name, field] of fields) messages.push(...fieldMessages(base + '/' + name, field));
    messages.push(...playbackMessages(base, deck));
  }
  return messages;
}

export interface OscOptions { host: string; port: number; maxHz?: number; snapshotIntervalMs?: number; onError?: (error: Error) => void }

/** Sends only the newest pending state, with bounded rate and periodic snapshots. */
export function startOsc(store: StateSource, options: OscOptions): { close(): Promise<void> } {
  const maxHz = options.maxHz ?? 30;
  const snapshotInterval = options.snapshotIntervalMs ?? 1000;
  if (!options.host || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid OSC destination');
  if (!Number.isFinite(maxHz) || maxHz < 1 || maxHz > 120) throw new Error('OSC maxHz must be between 1 and 120');
  if (!Number.isFinite(snapshotInterval) || snapshotInterval < 100) throw new Error('OSC snapshot interval must be >=100ms');
  const socket = dgram.createSocket('udp4');
  let closed = false;
  let stopping = false;
  let sending = false;
  let pending: Snapshot | undefined = store.snapshot();
  let lastSentAt = -Infinity;
  let lastErrorAt = -Infinity;
  let inFlight: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  const report = (error: Error) => {
    if (closed || performance.now() - lastErrorAt < 1000) return;
    lastErrorAt = performance.now(); options.onError?.(error);
  };
  socket.on('error', report);
  const unsubscribe = store.subscribe(snapshot => { pending = snapshot; });
  const intervalMs = Math.ceil(1000 / maxHz);
  const transmit = async (snapshot: Snapshot): Promise<void> => {
    const allMessages = snapshotToOsc(snapshot);
    // Every datagram names the representative for this revision. A receiver
    // can never mistake a BPM fragment for a previously selected deck.
    const headers = [...allMessages.slice(0, 3), ...allMessages.filter(message => REPRESENTATIVE_HEADERS.has(message.address))];
    const headerBytes = headers.reduce((size, message) => size + encodeOscMessage(message).length + 4, 16);
    const messages = allMessages.slice(3).filter(message => !REPRESENTATIVE_HEADERS.has(message.address));
    // Keep UDP packets below the usual Ethernet MTU; strings are capped per packet.
    const batches: OscMessage[][] = [];
    let batch: OscMessage[] = [...headers];
    let size = headerBytes;
    for (const message of messages) {
      let bytes: Buffer;
      try { bytes = encodeOscMessage(message); } catch (error) { report(error as Error); continue; }
      if (bytes.length + headerBytes + 4 > 1200) { report(new Error('OSC field exceeds UDP packet limit: ' + message.address)); continue; }
      if (size + bytes.length + 4 > 1200) { batches.push(batch); batch = [...headers]; size = headerBytes; }
      batch.push(message); size += bytes.length + 4;
    }
    if (batch.length) batches.push(batch);
    lastSentAt = performance.now();
    await Promise.all(batches.map(messages => new Promise<void>(resolve => {
      try {
        socket.send(encodeOscBundle(messages), options.port, options.host, error => {
          if (error) report(error);
          resolve();
        });
      } catch (error) { report(error as Error); resolve(); }
    })));
  };
  const timer = setInterval(() => {
    if (stopping || closed || sending) return;
    const now = performance.now();
    if (now - lastSentAt < intervalMs || (!pending && now - lastSentAt < snapshotInterval)) return;
    const snapshot = pending ?? store.snapshot(); pending = undefined;
    sending = true;
    inFlight = transmit(snapshot).catch(report).finally(() => { sending = false; });
  }, intervalMs);
  return { close() {
    if (closePromise) return closePromise;
    stopping = true; clearInterval(timer); unsubscribe();
    const finalSnapshot = store.snapshot();
    closePromise = (async () => {
      await inFlight;
      // Shutdown gets one final complete snapshot. Respect the same minimum
      // interval as ordinary updates, then wait for every UDP send callback so
      // a preceding disconnected transition's valid=0 is not discarded.
      const delay = intervalMs - (performance.now() - lastSentAt);
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, Math.ceil(delay)));
      await transmit(finalSnapshot).catch(report);
      closed = true;
      await new Promise<void>(resolve => { try { socket.close(() => resolve()); } catch { resolve(); } });
    })();
    return closePromise;
  } };
}
