import dgram, { type Socket } from 'node:dgram';
import { networkInterfaces, type NetworkInterfaceInfoIPv4 } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { StateStore } from '../core/store.js';
import { decodePacket } from '../core/decoder.js';

export const MAGIC = Buffer.from('5173707431576d4a4f4c', 'hex');
export interface SelectedInterface extends NetworkInterfaceInfoIPv4 { name: string; broadcast: string }

export function ipv4Number(ip: string): number {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`Invalid IPv4: ${ip}`);
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error(`Invalid IPv4: ${ip}`);
  return octets.reduce((n, b) => (n * 256 + b) >>> 0, 0);
}

export function listInterfaces(): SelectedInterface[] {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
    .filter((x): x is NetworkInterfaceInfoIPv4 => x.family === 'IPv4' && !x.internal && x.mac !== '00:00:00:00:00:00')
    .map(x => ({ ...x, name, broadcast: numberIp((ipv4Number(x.address) | ~ipv4Number(x.netmask)) >>> 0) })));
}
function numberIp(n: number): string { return [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.'); }
export function inNetwork(ip: string, iface: SelectedInterface): boolean {
  const mask = ipv4Number(iface.netmask);
  return (ipv4Number(ip) & mask) === (ipv4Number(iface.address) & mask);
}

/** Node does not expose IP_BOUND_IF. Refuse routing ambiguity rather than guessing an ingress IF. */
export function selectInterface(name: string, interfaces = listInterfaces()): SelectedInterface {
  const found = interfaces.filter(x => x.name === name);
  if (found.length !== 1) throw new Error(`IF ${name}: a single active IPv4 address is required. Use --list-interfaces.`);
  const selected = found[0];
  const overlaps = interfaces.filter(x => x !== selected && (inNetwork(x.address, selected) || inNetwork(selected.address, x)));
  if (overlaps.length) throw new Error(`IF ${name}: overlapping IPv4 networks (${overlaps.map(x => x.name).join(', ')}). Disable the overlapping connection or use pcap passive mode; source-address binding cannot ensure interface routing.`);
  if (ipv4Number(selected.netmask) === 0xffffffff) throw new Error('A broadcast-capable IPv4 network is required.');
  return selected;
}

export function announcementPacket(kind: number, version: number, tail: Buffer, name = 'XDJ-Bridge'): Buffer {
  if (!/^[\x20-\x7e]{1,20}$/.test(name)) throw new Error('Device name must be 1–20 ASCII characters.');
  const head = Buffer.alloc(36);
  MAGIC.copy(head); head[10] = kind; head.write(name, 12, 20, 'ascii'); head[32] = 1; head[33] = version;
  head.writeUInt16BE(36 + tail.length, 34);
  return Buffer.concat([head, tail]);
}

export function joinPackets(iface: SelectedInterface, number: number): Buffer[] {
  const mac = Buffer.from(iface.mac.replaceAll(':', ''), 'hex');
  const ip = Buffer.from(iface.address.split('.').map(Number));
  return [
    ...Array.from({ length: 3 }, () => announcementPacket(0x0a, 4, Buffer.from([1, 0x40]))),
    ...[1, 2, 3].map(counter => announcementPacket(0, 3, Buffer.concat([Buffer.from([counter, 1]), mac]))),
    ...[1, 2, 3].map(counter => announcementPacket(2, 3, Buffer.concat([ip, mac, Buffer.from([number, counter, 1, 2])]))),
    ...[1, 2, 3].map(counter => announcementPacket(4, 3, Buffer.from([number, counter]))),
  ];
}
export function keepAlive(iface: SelectedInterface, number: number): Buffer {
  return announcementPacket(6, 2, Buffer.concat([
    Buffer.from([number, 1]), Buffer.from(iface.mac.replaceAll(':', ''), 'hex'),
    Buffer.from(iface.address.split('.').map(Number)), Buffer.from('020000000164', 'hex'),
  ]));
}

export function claimedNumber(packet: Buffer): number | null {
  if (packet.length < 38 || !packet.subarray(0, 10).equals(MAGIC)) return null;
  const kind = packet[10];
  if ([6, 8, 4].includes(kind)) return packet[36];
  return kind === 2 && packet.length >= 50 ? packet[46] : null;
}
export function pickNumber(used: Set<number>, requested?: number): number {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 7 || requested > 9)) throw new Error('Virtual number must be 7, 8 or 9.');
  const result = (requested === undefined ? [7, 8, 9] : [requested]).find(n => !used.has(n));
  if (result === undefined) throw new Error(`No free virtual number (${requested ?? '7–9'}).`);
  return result;
}

export interface LiveOptions {
  interfaceName: string;
  mode: 'passive' | 'virtual-device';
  deviceNumber?: number;
  discoveryMs?: number;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}

export async function startLive(store: StateStore, options: LiveOptions): Promise<{ close(): Promise<void> }> {
  const iface = selectInterface(options.interfaceName);
  const sockets = new Map<number, Socket>();
  const peers = new Set<string>();
  const used = new Set<number>();
  const origin = performance.now();
  const now = () => performance.now() - origin;
  const controller = new AbortController();
  let number: number | undefined;
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let lastStatus: number | null = null;
  let onlineAt: number | null = null;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true; controller.abort(); clearInterval(heartbeat); clearInterval(watchdog);
    closing = Promise.all([...sockets.values()].map(socket => new Promise<void>(resolve => {
      try { socket.close(() => resolve()); } catch { resolve(); }
    }))).then(() => {
      sockets.clear();
      store.setSession({ state: 'disconnected', now: now(), reason: 'Network session stopped; values are stale.' });
      options.signal?.removeEventListener('abort', onAbort);
    });
    return closing;
  };
  const onAbort = () => { void close(); };
  options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const fail = (error: Error) => {
    // Stop announcing immediately, then release every port owned by this session.
    if (closed) return;
    clearInterval(heartbeat); options.onError?.(error);
    void close().then(() => store.setSession({ state: 'degraded', now: now(), reason: error.message }));
  };
  store.setSession({ state: 'observing', interfaceId: iface.name, now: 0, reason: options.mode === 'passive' ? 'Capture only: no network requests or announcements.' : 'Observing peer numbers before joining.' });
  try {
    for (const port of [50000, 50001, 50002]) {
      if (closed || controller.signal.aborted) throw new Error('Session startup cancelled.');
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      sockets.set(port, socket);
      socket.on('message', (bytes, remote) => {
        if (closed || remote.address === iface.address || !inNetwork(remote.address, iface)) return;
        if (bytes.length < 11 || !bytes.subarray(0, 10).equals(MAGIC)) return;
        const at = now();
        if (port === 50000) {
          const claimed = claimedNumber(bytes);
          if (claimed !== null) {
            used.add(claimed);
            if (number !== undefined && claimed === number) { fail(new Error(`Virtual number ${number} conflicts with ${remote.address}; transmission stopped.`)); return; }
          }
          if (bytes[10] === 6 && bytes.length >= 54) {
            const model = bytes.subarray(12, 32).toString('ascii').replace(/\0.*$/, '').trim();
            if (/^(CDJ|XDJ)/.test(model)) peers.add(remote.address);
          }
          if (number !== undefined && [1, 3].includes(bytes[10])) { fail(new Error('Mixer number-assignment strategy is not verified for this native session.')); return; }
        }
        // A valid status can establish reception in passive mode even if announcements were missed.
        const envelope = { sessionId: store.snapshot().session.id, interfaceId: iface.name,
          sourceIp: remote.address, sourcePort: remote.port, destinationIp: iface.address,
          destinationPort: port, transport: 'udp' as const, bytes, receivedAt: at };
        const decoded = decodePacket(envelope);
        if (decoded?.kind === 'status') {
          used.add(decoded.status.wireDeviceId);
          if (number === decoded.status.wireDeviceId) { fail(new Error(`Virtual number ${number} conflicts with an observed deck; transmission stopped.`)); return; }
          lastStatus = at;
          store.setSession({ state: 'online', now: at, reason: `${options.mode} on ${iface.name}; firmware unknown.` });
        }
        store.ingest(envelope);
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(new Error(`UDP ${port}: ${error.message}. Stop rekordbox/BLT or another bridge.`));
        socket.once('error', onError);
        socket.bind(port, port === 50002 ? iface.address : '0.0.0.0', () => { socket.off('error', onError); resolve(); });
      });
      socket.on('error', fail);
      if (closed || controller.signal.aborted) throw new Error('Session startup cancelled.');
    }
    sockets.get(50002)!.setBroadcast(true);
    const send = async (bytes: Buffer) => {
      if (closed || controller.signal.aborted) throw new Error('Session closed.');
      await new Promise<void>((resolve, reject) => sockets.get(50002)!.send(bytes, 50000, iface.broadcast, error => error ? reject(error) : resolve()));
    };
    watchdog = setInterval(() => {
      const at = now();
      try {
        const current = selectInterface(iface.name);
        if (current.address !== iface.address || current.mac !== iface.mac || current.netmask !== iface.netmask) throw new Error(`IF ${iface.name} disappeared or changed. Restart the session after reconnection.`);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
      if ((lastStatus !== null && at - lastStatus > 5000) || (lastStatus === null && onlineAt !== null && at - onlineAt > 10_000)) {
        store.setSession({ state: 'degraded', now: at, reason: 'No fresh status packets. Reconnect the device or restart this session.' });
      }
      store.tick(at);
    }, 250);
    if (options.mode === 'virtual-device') {
      await delay(Math.max(3000, options.discoveryMs ?? 3000), undefined, { signal: controller.signal });
      if (!peers.size) throw new Error(`No CDJ/XDJ announcements on ${iface.name}. No participation packets were sent.`);
      number = pickNumber(used, options.deviceNumber);
      store.setSession({ state: 'joining', now: now(), reason: `Claiming observed-free virtual number ${number}.` });
      for (const packet of joinPackets(iface, number)) {
        await send(packet);
        await delay(300, undefined, { signal: controller.signal });
      }
      onlineAt = now();
      await send(keepAlive(iface, number));
      heartbeat = setInterval(() => { void send(keepAlive(iface, number!)).catch(fail); }, 1500);
      store.setSession({ state: lastStatus === null ? 'joining' : 'online', now: now(), reason: `Virtual ${number} joined ${iface.name}; waiting for verified status reception.` });
    }
    return { close };
  } catch (error) { await close(); throw error; }
}
