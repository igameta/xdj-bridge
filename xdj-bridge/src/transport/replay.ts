import { readFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { MAGIC } from '../core/decoder.js';
import type { PacketEnvelope } from '../core/types.js';

interface CapturedFrame { bytes: Buffer; at: number; linkType: number; interfaceId: string }
const MAX_CAPTURE_SIZE = 128 * 1024 * 1024;
const ipv4 = (b: Buffer, offset: number) => [...b.subarray(offset, offset + 4)].join('.');
function udpFrame(frame: CapturedFrame, sessionId: string, receivedAt: number): PacketEnvelope | null {
  const b = frame.bytes;
  let offset: number;
  if (frame.linkType === 1) {
    if (b.length < 14) return null;
    offset = 14;
    let etherType = b.readUInt16BE(12);
    while ([0x8100, 0x88a8, 0x9100].includes(etherType)) {
      if (b.length < offset + 4) return null;
      etherType = b.readUInt16BE(offset + 2); offset += 4;
    }
    if (etherType !== 0x0800) return null;
  } else if ([101, 12, 228].includes(frame.linkType)) offset = 0;
  else if ([0, 108].includes(frame.linkType)) {
    if (b.length < 4 || !(b.readUInt32LE(0) === 2 || b.readUInt32BE(0) === 2)) return null;
    offset = 4;
  } else if (frame.linkType === 113) {
    if (b.length < 16 || b.readUInt16BE(14) !== 0x0800) return null;
    offset = 16;
  } else if (frame.linkType === 276) {
    if (b.length < 20 || b.readUInt16BE(0) !== 0x0800) return null;
    offset = 20;
  } else return null;
  if (b.length < offset + 20 || b[offset] >>> 4 !== 4 || b[offset + 9] !== 17) return null;
  const ihl = (b[offset] & 15) * 4;
  const ipLength = b.readUInt16BE(offset + 2);
  // Fragmented datagrams require reassembly and are deliberately skipped.
  if (ihl < 20 || ipLength < ihl + 8 || b.length < offset + ipLength || (b.readUInt16BE(offset + 6) & 0x3fff) !== 0) return null;
  const udpOffset = offset + ihl;
  const sourcePort = b.readUInt16BE(udpOffset), destinationPort = b.readUInt16BE(udpOffset + 2);
  if (![50000, 50001, 50002].includes(destinationPort)) return null;
  const length = b.readUInt16BE(udpOffset + 4);
  if (length < 8 || length > ipLength - ihl) return null;
  const bytes = Buffer.from(b.subarray(udpOffset + 8, udpOffset + length));
  if (bytes.length < 10 || !bytes.subarray(0, 10).equals(MAGIC)) return null;
  return { sessionId, interfaceId: frame.interfaceId, sourceIp: ipv4(b, offset + 12), sourcePort, destinationIp: ipv4(b, offset + 16), destinationPort, transport: 'replay', bytes, receivedAt };
}

function classicFrames(b: Buffer): CapturedFrame[] {
  if (b.length < 24) throw new Error('Truncated pcap header');
  const magic = b.subarray(0, 4).toString('hex');
  const little = magic === 'd4c3b2a1' || magic === '4d3cb2a1';
  const nano = magic === '4d3cb2a1' || magic === 'a1b23c4d';
  if (!['d4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic)) throw new Error('Unsupported capture: expected pcap or pcapng');
  const u16 = (n: number) => little ? b.readUInt16LE(n) : b.readUInt16BE(n);
  const u32 = (n: number) => little ? b.readUInt32LE(n) : b.readUInt32BE(n);
  if (u16(4) !== 2 || u16(6) !== 4) throw new Error('Unsupported pcap version');
  const linkType = u32(20) & 0xffff;
  const result: CapturedFrame[] = [];
  let p = 24;
  while (p < b.length) {
    if (b.length - p < 16) throw new Error('Truncated pcap record');
    const length = u32(p + 8);
    if (length > b.length - p - 16) throw new Error('Truncated pcap packet');
    const subsecond = u32(p + 4);
    if (subsecond >= (nano ? 1e9 : 1e6)) throw new Error('Invalid pcap timestamp fraction');
    result.push({ bytes: b.subarray(p + 16, p + 16 + length), at: u32(p) * 1000 + subsecond / (nano ? 1e6 : 1e3), linkType, interfaceId: 'capture:0' });
    p += 16 + length;
  }
  return result;
}
interface CaptureInterface { linkType: number; resolution: number; offset: number; name: string }
function ngFrames(b: Buffer): CapturedFrame[] {
  let p = 0, little = true, interfaces: CaptureInterface[] = [], section = -1;
  const result: CapturedFrame[] = [];
  while (p < b.length) {
    if (b.length - p < 12) throw new Error('Truncated pcapng block');
    const isSection = b.readUInt32LE(p) === 0x0a0d0d0a;
    if (isSection) {
      if (b.length - p < 28) throw new Error('Truncated pcapng section');
      const marker = b.readUInt32LE(p + 8);
      if (marker === 0x1a2b3c4d) little = true;
      else if (marker === 0x4d3c2b1a) little = false;
      else throw new Error('Invalid pcapng byte order');
      interfaces = []; section++;
    } else if (section < 0) throw new Error('pcapng requires a section header');
    const u16 = (n: number) => little ? b.readUInt16LE(n) : b.readUInt16BE(n);
    const u32 = (n: number) => little ? b.readUInt32LE(n) : b.readUInt32BE(n);
    const type = u32(p), length = u32(p + 4);
    if (length < 12 || length % 4 !== 0 || length > b.length - p || u32(p + length - 4) !== length) throw new Error('Invalid pcapng block length');
    const end = p + length - 4;
    if (type === 1) {
      if (length < 20) throw new Error('Truncated pcapng interface');
      const iface: CaptureInterface = { linkType: u16(p + 8), resolution: 1e-6, offset: 0, name: `capture:${section}:${interfaces.length}` };
      let option = p + 16;
      while (option + 4 <= end) {
        const code = u16(option), size = u16(option + 2); option += 4;
        if (code === 0) break;
        if (option + size > end) throw new Error('Invalid pcapng interface option');
        if (code === 2 && size) iface.name = `capture:${section}:${interfaces.length}:${b.subarray(option, option + size).toString('utf8')}`;
        if (code === 9 && size === 1) iface.resolution = b[option] & 0x80 ? 2 ** -(b[option] & 0x7f) : 10 ** -b[option];
        if (code === 14 && size === 8) iface.offset = Number(little ? b.readBigInt64LE(option) : b.readBigInt64BE(option));
        option += (size + 3) & ~3;
      }
      interfaces.push(iface);
    } else if (type === 6 || type === 2) {
      if (length < 32) throw new Error('Truncated pcapng packet header');
      const index = type === 6 ? u32(p + 8) : u16(p + 8);
      const iface = interfaces[index];
      if (!iface) throw new Error('pcapng packet references an unknown interface');
      const size = u32(p + 20);
      if (size > end - (p + 28)) throw new Error('Truncated pcapng packet');
      const ticks = (BigInt(u32(p + 12)) << 32n) | BigInt(u32(p + 16));
      const at = (Number(ticks) * iface.resolution + iface.offset) * 1000;
      if (!Number.isFinite(at)) throw new Error('Invalid pcapng timestamp');
      result.push({ bytes: b.subarray(p + 28, p + 28 + size), at, linkType: iface.linkType, interfaceId: iface.name });
    }
    p += length;
  }
  return result;
}

export async function readCapture(path: string, sessionId: string): Promise<PacketEnvelope[]> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_CAPTURE_SIZE) throw new Error('Capture must be a regular file of at most 128 MiB');
  const b = await readFile(path);
  if (b.length < 4) throw new Error('Empty or truncated capture');
  const frames = b.readUInt32LE(0) === 0x0a0d0d0a ? ngFrames(b) : classicFrames(b);
  const baseline = frames[0]?.at ?? 0;
  let previousTime = 0;
  const packets: PacketEnvelope[] = [];
  for (const frame of frames) {
    // Capture wall-clock adjustments may move backwards; never feed a
    // nonmonotonic timeline to the reducer or replay scheduler.
    const time = Math.max(previousTime, frame.at - baseline);
    previousTime = time;
    const packet = udpFrame(frame, sessionId, time);
    if (packet) packets.push(packet);
  }
  return packets;
}
export interface ReplayOptions {
  speed?: number;
  signal?: AbortSignal;
  onPacket: (packet: PacketEnvelope) => void;
  onEnd?: () => void;
}
export async function replayPackets(packets: PacketEnvelope[], options: ReplayOptions): Promise<void> {
  const speed = options.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0 || speed > 1000) throw new Error('Replay speed must be > 0 and <= 1000');
  const started = performance.now();
  const initial = packets[0]?.receivedAt ?? 0;
  for (const packet of packets) {
    const target = (packet.receivedAt - initial) / speed;
    while (!options.signal?.aborted && target > performance.now() - started) {
      try { await delay(Math.min(100, target - (performance.now() - started)), undefined, { signal: options.signal }); }
      catch (error) { if (options.signal?.aborted) return; throw error; }
    }
    if (options.signal?.aborted) return;
    // Do not overwrite receivedAt with processing time or replay speed.
    options.onPacket(packet);
  }
  if (!options.signal?.aborted) options.onEnd?.();
}

/** Synthetic showcase packets; callers must use SessionState.mode='demo'.
 * Four-deck AZ-format data exercises routing, not hardware compatibility. */
export function makeDemoPackets(sessionId: string, deckCount: 2 | 4 = 2): PacketEnvelope[] {
  if (deckCount !== 2 && deckCount !== 4) throw new Error('Demo deck count must be 2 or 4');
  const result: PacketEnvelope[] = [];
  const wires = deckCount === 4 ? [1, 2, 3, 4] : [11, 12];
  for (let frame = 0; frame < 120; frame++) for (const wire of wires) {
    const b = Buffer.alloc(292);
    const az = deckCount === 4;
    MAGIC.copy(b); b[10] = 0x0a; b.write(az ? 'XDJ-AZ' : 'XDJ-RX3', 11, 'ascii'); b[0x1f] = 1; b[0x20] = az ? 3 : 5; b[0x21] = wire;
    b[0x28] = az ? 1 : 11; b[0x29] = 3; b[0x2a] = 1;
    b.writeUInt32BE(az ? wire * 100 + (wire === 2 && frame >= 60 ? 1 : 0) : wire === 11 ? 1 : frame < 60 ? 43 : 2, 0x2c);
    b[0x7b] = az ? wire === 3 ? 5 : wire === 2 && frame <= 15 ? 6 : 3 : wire === 11 || frame > 15 ? 3 : 6;
    if (az && b[0x7b] === 3) b[0x89] = 0x40;
    const pitch = az ? 1 + (wire - 2) * 0.02 * Math.sin(frame / 20) : wire === 11 ? 1 - 0.085 * Math.sin(frame / 20) : 1;
    b.writeUIntBE(Math.round(pitch * 0x100000), 0x8d, 3);
    b.writeUInt16BE(az ? [12200, 12500, 12800, 13000][wire - 1] : wire === 11 ? 12200 : frame < 60 ? 12500 : 12600, 0x92);
    b.writeUInt32BE(0xffffffff, 0xa0);
    result.push({ sessionId, interfaceId: 'demo', sourceIp: '192.0.2.10', sourcePort: 50002, destinationIp: '192.0.2.20', destinationPort: 50002, transport: 'replay', bytes: b, receivedAt: frame * 250 });
  }
  return result;
}
