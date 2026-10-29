import type { PacketEnvelope, Profile, StatusObservation } from './types.js';

export const MAGIC = Buffer.from('5173707431576d4a4f4c', 'hex');
const nameAt = (b: Buffer, offset: number) => b.subarray(offset, offset + 20).toString('ascii').replace(/\0.*$/, '').trim();
export type DecodedPacket =
  | { kind: 'status'; status: StatusObservation }
  | { kind: 'announcement'; wireDeviceId: number; model: string; mac: string }
  | { kind: 'beat'; wireDeviceId: number; model: string; beatInMeasure: number | null }
  | { kind: 'position'; wireDeviceId: number; model: string; positionMs: number }
  | { kind: 'media'; wireDeviceId: number; slot: number; fingerprint: string };

/** Pure parser. Length, destination port and packet type are checked before reading. */
export function decodePacket(e: PacketEnvelope): DecodedPacket | null {
  const b = e.bytes;
  if (!Number.isFinite(e.receivedAt) || e.receivedAt < 0 || b.length < 11 || !b.subarray(0, 10).equals(MAGIC)) return null;
  const type = b[10];
  if (e.destinationPort === 50000 && type === 6 && b.length >= 0x36 && b[0x24] > 0) {
    return { kind: 'announcement', wireDeviceId: b[0x24], model: nameAt(b, 12), mac: b.subarray(0x26, 0x2c).toString('hex') };
  }
  if (e.destinationPort === 50002 && type === 0x0a && b.length >= 0xcc && b[0x21] > 0) {
    // 0x03/0x04 are standard player layouts; 0x05 is captured RX3. Unknown
    // formats remain unparsed even under an explicit profile override.
    if (![3, 4, 5].includes(b[0x20]) || b[0x1f] !== 1) return null;
    const bpm = b.readUInt16BE(0x92);
    const rawPitch = b.readUIntBE(0x8d, 3);
    const rawBeat = b.readUInt32BE(0xa0);
    const model = nameAt(b, 11);
    if (!model || !/^[\x20-\x7e]+$/.test(model)) return null;
    return { kind: 'status', status: {
      sessionId: e.sessionId, interfaceId: e.interfaceId, sourceIp: e.sourceIp,
      receivedAt: e.receivedAt, model, wireDeviceId: b[0x21],
      sourceWireDeviceId: b[0x28], protocolSlot: b[0x29], trackType: b[0x2a], trackId: b.readUInt32BE(0x2c),
      playState: b[0x7b], statusFlags: b.length >= 0xd4 ? b[0x89] : undefined,
      trackBpm: bpm === 0xffff ? null : bpm / 100,
      pitchPercent: rawPitch <= 0x200000 ? (rawPitch / 0x100000 - 1) * 100 : null,
      beat: rawBeat === 0xffffffff || rawBeat === 0 ? null : rawBeat,
      beatInMeasure: b[0xa6] >= 1 && b[0xa6] <= 4 ? b[0xa6] : null,
      source: `${e.transport}:status`,
      raw: { packetLength: b.length, subtype: b[0x20], playState: b[0x7b], statusFlags: b[0x89], beat: rawBeat, beatInMeasure: b[0xa6] },
    } };
  }
  if (e.destinationPort === 50001 && type === 0x28 && b.length >= 0x60 && b[0x21] > 0) {
    return { kind: 'beat', wireDeviceId: b[0x21], model: nameAt(b, 11), beatInMeasure: b[0x5c] >= 1 && b[0x5c] <= 4 ? b[0x5c] : null };
  }
  // Absolute position packets use type 0x0b, subtype 0. Never infer a
  // position from another long packet on the beat port.
  if (e.destinationPort === 50001 && type === 0x0b && b.length >= 0x34 && b[0x20] === 0 && b[0x21] > 0 && b.readUInt16BE(0x22) >= 0x0c) {
    const positionMs = b.readUInt32BE(0x28);
    const duration = b.readUInt32BE(0x24) * 1000;
    // Track length is truncated whole seconds; the final fractional second
    // is valid. A zero length cannot establish a useful bound.
    if (positionMs === 0xffffffff || (duration > 0 && positionMs > duration + 999)) return null;
    return { kind: 'position', wireDeviceId: b[0x21], model: nameAt(b, 11), positionMs };
  }
  if (e.destinationPort === 50002 && type === 6 && b.length >= 0xc0 && b[0x27] > 0) {
    return { kind: 'media', wireDeviceId: b[0x27], slot: b[0x2b], fingerprint: b.subarray(0x2c, 0x84).toString('hex') + ':' + b.readUInt16BE(0xa6) };
  }
  return null;
}

export function resolveProfile(model: string, explicit: Profile | 'auto' = 'auto'): { profile: Profile; forced: boolean; reason: string } {
  const detected: Profile = model === 'XDJ-RX3' ? 'xdj-rx3' : model === 'XDJ-AZ' ? 'xdj-az' : 'generic-prolink';
  if (explicit !== 'auto') return { profile: explicit, forced: explicit !== detected, reason: `Explicit profile ${explicit}; firmware unknown` };
  return { profile: detected, forced: false, reason: `Model ${model || 'unknown'}; firmware unknown; ${detected} decoder` };
}
