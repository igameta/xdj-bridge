import dgram, { type Socket } from 'node:dgram';
import { networkInterfaces, type NetworkInterfaceInfoIPv4 } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { StateStore } from '../core/store.js';
import { decodePacket } from '../core/decoder.js';
import type { DeviceObservation, PacketEnvelope, Profile } from '../core/types.js';

export const MAGIC = Buffer.from('5173707431576d4a4f4c', 'hex');
export interface SelectedInterface extends NetworkInterfaceInfoIPv4 { name: string; broadcast: string }
export interface NetworkServices {
  createSocket(options: { type: 'udp4'; reuseAddr: false }): Socket;
  listInterfaces(): SelectedInterface[];
  wait(ms: number, signal: AbortSignal): Promise<void>;
  now(): number;
}
const defaults: NetworkServices = { createSocket: options => dgram.createSocket(options), listInterfaces,
  wait: async (ms, signal) => { await delay(ms, undefined, { signal }); }, now: () => performance.now() };

/** Closing a socket while bind is pending can suppress its ready callback.
 * Abort must reject the waiter independently, then the owner awaits release. */
function bindOwnedSocket(socket: Socket, port: number, address: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; socket.off('error', onError); signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error) => finish(new Error(`UDP ${port}: ${error.message}. Another application may own the port.`));
    const onAbort = () => finish(new Error(`UDP ${port} startup cancelled.`));
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('error', onError);
    if (signal.aborted) { onAbort(); return; }
    try { socket.bind(port, address, () => finish()); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

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
/** Experimental PC-role presence. Independently encoded from observed field
 * facts; no foreign implementation is copied. It is not a CDJ claim or
 * Lighting/Stagehand request, and does not alter the unit's Mode setting. */
export function azStandalonePresence(iface: SelectedInterface, number: 5 | 6, peerCount = 1): Buffer {
  if (![5, 6].includes(number) || !Number.isInteger(peerCount) || peerCount < 1 || peerCount > 255) throw new Error('Invalid AZ experimental presence number/count');
  return announcementPacket(6, 3, Buffer.concat([
    Buffer.from([number, 1]), Buffer.from(iface.mac.replaceAll(':', ''), 'hex'),
    Buffer.from(iface.address.split('.').map(Number)), Buffer.from([peerCount, 1, 0, 0, 4, 8]),
  ]));
}
export function pickAzStandaloneNumber(used: Set<number>): 5 | 6 {
  if (!used.has(5)) return 5;
  if (!used.has(6)) return 6;
  throw new Error('AZスタンドアロン（試験）で使用する番号5/6が両方とも占有されています。送信しません。');
}

export function claimedNumber(packet: Buffer): number | null {
  if (packet.length < 38 || !packet.subarray(0, 10).equals(MAGIC)) return null;
  const kind = packet[10];
  const minimum: Record<number, number> = { 6: 54, 8: 41, 4: 38, 2: 50 };
  const length = minimum[kind];
  if (!length || packet.length < length || packet[0x20] !== 1 || ![2, 3].includes(packet[0x21]) || packet.readUInt16BE(0x22) < length || packet.readUInt16BE(0x22) > packet.length) return null;
  const name = packet.subarray(12, 32).toString('ascii').replace(/\0.*$/, '').trim();
  if (!name || !/^[\x20-\x7e]+$/.test(name)) return null;
  return kind === 2 ? packet[46] || null : packet[36] || null;
}
export function pickNumber(used: Set<number>, requested?: number): number {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 7 || requested > 9)) throw new Error('Virtual number must be 7, 8 or 9.');
  const result = (requested === undefined ? [7, 8, 9] : [requested]).find(n => !used.has(n));
  if (result === undefined) throw new Error(`No free virtual number (${requested ?? '7–9'}).`);
  return result;
}

/** UDP has no ingress ancillary information in Node. A unique subnet match
 * is an inference, never proof of the physical receiving interface. */
export function sourceMembership(ip: string, iface: SelectedInterface, interfaces: SelectedInterface[]): 'selected' | 'self' | 'other-interface' | 'unknown' {
  try {
    const current = selectInterface(iface.name, interfaces);
    if (current.address !== iface.address || current.netmask !== iface.netmask || current.mac !== iface.mac) return 'other-interface';
    const number = ipv4Number(ip), first = number >>> 24;
    if (interfaces.some(value => value.address === ip)) return 'self';
    if (first === 0 || first === 127 || first >= 224 || number === 0xffffffff) return 'other-interface';
    if (inNetwork(ip, iface) && ip !== iface.broadcast) return 'selected';
    if (interfaces.some(value => value.name !== iface.name && inNetwork(ip, value))) return 'other-interface';
    return 'unknown';
  } catch { return 'other-interface'; }
}
function envelope(store: StateStore, bytes: Buffer, remote: { address: string; port: number }, iface: SelectedInterface, port: number, at: number): PacketEnvelope {
  return { sessionId: store.snapshot().session.id, interfaceId: iface.name, interfaceEvidence: 'subnet', sourceIp: remote.address,
    sourcePort: remote.port, destinationIp: '0.0.0.0', destinationPort: port, transport: 'udp', bytes, receivedAt: at };
}
function deviceObservation(packet: PacketEnvelope, iface: SelectedInterface, membership: 'selected' | 'unknown'): DeviceObservation | null {
  const decoded = decodePacket(packet);
  if (decoded?.kind !== 'announcement' || !/^(CDJ|XDJ|DJM|rekordbox|Stagehand|ProLink)/i.test(decoded.model) || /^0+$/.test(decoded.mac)) return null;
  return { model: decoded.model, sourceIp: packet.sourceIp, wireDeviceId: decoded.wireDeviceId, receivedAt: packet.receivedAt,
    interfaceId: membership === 'selected' ? iface.name : null, interfaceEvidence: membership === 'selected' ? 'subnet' : 'unknown',
    advertisedIp: decoded.advertisedIp, mac: decoded.mac,
    reason: membership === 'unknown' ? '機器通知を受信しましたが、選択したLANと送信元のサブネットが異なり、受信IFは未確定です。この機器への参加通知や再生情報の取得は行いません。' : undefined };
}
/** Mixer type 1 carries the sender's identity, not the target player.
 * Type 3 carries an assigned number; only our in-progress claim can reject. */
export function mixerNegotiation(packet: Buffer, number: number | undefined, joining: boolean): 'ignore' | 'ambiguous' | 'reject' {
  if (number === undefined || packet.length < 0x27 || !packet.subarray(0, 10).equals(MAGIC) || packet[0x20] !== 1 || ![2, 3].includes(packet[0x21])) return 'ignore';
  const declared = packet.readUInt16BE(0x22);
  if (declared > packet.length || declared < 0x27 || !/^[\x20-\x7e]+$/.test(packet.subarray(12, 32).toString('ascii').replace(/\0.*$/, '').trim())) return 'ignore';
  if (packet[10] === 1 && packet.length >= 0x2f && declared >= 0x2f) return 'ambiguous';
  if (packet[10] === 3 && joining && packet[0x0b] === 1 && packet[0x24] === number) return 'reject';
  return 'ignore';
}

export interface DiscoveryOptions { interfaceName: string; durationMs?: number; signal?: AbortSignal }
/** One bounded, receive-only announcement listener. It never starts a
 * virtual participant, sends probes, or creates deck/OSC/notification state. */
export async function discoverDevices(store: StateStore, options: DiscoveryOptions, dependencies: Partial<NetworkServices> = {}): Promise<void> {
  const services = { ...defaults, ...dependencies }, interfaces = services.listInterfaces();
  const iface = selectInterface(options.interfaceName, interfaces);
  const duration = options.durationMs ?? 6000;
  if (!Number.isFinite(duration) || duration < 1 || duration > 30_000) throw new Error('Discovery duration must be 1–30000ms');
  options.signal?.throwIfAborted();
  const socket = services.createSocket({ type: 'udp4', reuseAddr: false });
  const controller = new AbortController(), origin = services.now();
  const at = () => Math.max(0, services.now() - origin);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= new Promise<void>(resolve => { try { socket.close(() => resolve()); } catch { resolve(); } });
  const abort = () => { controller.abort(); void close(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let failed: Error | undefined;
  const validateInterface = () => {
    const current = selectInterface(iface.name, services.listInterfaces());
    if (current.address !== iface.address || current.netmask !== iface.netmask || current.mac !== iface.mac) throw new Error(`IF ${iface.name} disappeared or changed during discovery.`);
  };
  const watchdog = setInterval(() => {
    try { validateInterface(); } catch (error) { failed = error instanceof Error ? error : new Error(String(error)); controller.abort(); void close(); }
  }, 250);
  socket.on('error', error => { failed = error; controller.abort(); void close(); });
  socket.on('message', (bytes, remote) => {
    if (controller.signal.aborted) return;
    try { validateInterface(); } catch (error) { failed = error instanceof Error ? error : new Error(String(error)); controller.abort(); void close(); return; }
    const membership = sourceMembership(remote.address, iface, services.listInterfaces());
    if (membership === 'self' || membership === 'other-interface') return;
    const observation = deviceObservation(envelope(store, bytes, remote, iface, 50000, at()), iface, membership);
    if (observation) store.observeDevice(observation);
  });
  try {
    controller.signal.throwIfAborted();
    await bindOwnedSocket(socket, 50000, '0.0.0.0', controller.signal);
    if (controller.signal.aborted) throw failed ?? new Error('Discovery cancelled');
    await services.wait(duration, controller.signal);
    store.tick(at());
    if (failed) throw failed;
  } catch (error) { if (!options.signal?.aborted) throw failed ?? error; }
  finally { clearInterval(watchdog); controller.abort(); options.signal?.removeEventListener('abort', abort); await close(); }
}

export interface LiveOptions {
  interfaceName: string;
  mode: 'passive' | 'virtual-device' | 'az-standalone';
  profile?: Profile | 'auto';
  deviceNumber?: number;
  discoveryMs?: number;
  onError?: (error: Error) => void;
  signal?: AbortSignal;
}

export async function startLive(store: StateStore, options: LiveOptions, dependencies: Partial<NetworkServices> = {}): Promise<{ close(): Promise<void> }> {
  const experimentalAz = options.mode === 'az-standalone';
  if (experimentalAz && options.deviceNumber !== undefined) throw new Error('AZスタンドアロン（試験）ではdeviceNumberを強制できません。未使用の5/6を観測から選びます。');
  if (experimentalAz && options.profile !== undefined && !['auto', 'xdj-az'].includes(options.profile)) throw new Error('AZ standalone requires profile auto or xdj-az');
  const services = { ...defaults, ...dependencies };
  const iface = selectInterface(options.interfaceName, services.listInterfaces());
  if (experimentalAz && iface.broadcast === '255.255.255.255') throw new Error('AZスタンドアロン（試験）は明確なサブネットbroadcastが必要です。global broadcastへ送信しません。');
  const sockets = new Map<number, Socket>();
  const peers = new Set<string>();
  const azPeers = new Set<string>();
  const foreignPlayers = new Set<string>();
  const used = new Set<number>();
  const origin = services.now();
  const now = () => Math.max(0, services.now() - origin);
  const controller = new AbortController();
  let number: number | undefined;
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let lastStatus: number | null = null;
  let azReplyAfterPresence: number | null = null;
  let onlineAt: number | null = null;
  let joining = false;
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
  if (experimentalAz) store.addDiagnostic('az-standalone-experimental', 'warning', 'AZスタンドアロン（試験）: Mode OFFを維持したPC型参加候補です。現場FW1.23・Windowsは実機未検証で、参考報告FW1.30での成功を保証しません。本体設定は変更しません。', 0);
  store.setSession({ state: 'observing', interfaceId: iface.name, now: 0, reason: options.mode === 'passive' ? 'Capture only: no network requests or announcements.' : experimentalAz ? 'AZスタンドアロン（試験）: 送信せず6秒間、LAN内の占有番号を観測します。' : 'Observing peer numbers before joining.' });
  try {
    for (const port of [50000, 50001, 50002]) {
      if (closed || controller.signal.aborted) throw new Error('Session startup cancelled.');
      const socket = services.createSocket({ type: 'udp4', reuseAddr: false });
      sockets.set(port, socket);
      socket.on('message', (bytes, remote) => {
        if (closed || sourceMembership(remote.address, iface, services.listInterfaces()) !== 'selected') return;
        if (bytes.length < 11 || !bytes.subarray(0, 10).equals(MAGIC)) return;
        const at = now();
        if (port === 50000) {
          const packet = envelope(store, bytes, remote, iface, port, at);
          const decodedAnnouncement = decodePacket(packet);
          const claimed = bytes[10] === 6 && decodedAnnouncement?.kind !== 'announcement' ? null : claimedNumber(bytes);
          if (claimed !== null) {
            used.add(claimed);
            if (number !== undefined && claimed === number) { fail(new Error(`Virtual number ${number} conflicts with ${remote.address}; transmission stopped.`)); return; }
          }
          const observation = deviceObservation(envelope(store, bytes, remote, iface, port, at), iface, 'selected');
          if (observation && /^(CDJ|XDJ)/.test(observation.model)) peers.add(remote.address);
          if (observation?.model === 'XDJ-AZ') azPeers.add(remote.address);
          const foreignModel = decodedAnnouncement?.kind === 'announcement' ? decodedAnnouncement.model : null;
          if (experimentalAz && foreignModel && foreignModel !== 'XDJ-AZ' && /^(CDJ-|XDJ-|OPUS-QUAD$|OMNIS-DUO$)/.test(foreignModel)) {
            foreignPlayers.add(`${foreignModel}@${remote.address}`);
            if (number !== undefined) { fail(new Error('AZスタンドアロン（試験）中に別機種のプレーヤーを検出しました。この混在LANは試験対象外のため送信を停止します。')); return; }
          }
          const negotiation = mixerNegotiation(bytes, number, joining);
          if (negotiation === 'reject') { fail(new Error('Mixer assignment for our in-progress virtual number is not verified; transmission stopped.')); return; }
          if (negotiation === 'ambiguous') store.addDiagnostic('mixer-assignment-ambiguous', 'warning', 'Mixer assignment intention observed. Node UDP does not expose the destination IP, so the target player cannot be proven; no automatic assignment is applied.', at);
        }
        // A valid status can establish reception in passive mode even if announcements were missed.
        const packet = envelope(store, bytes, remote, iface, port, at);
        const decoded = decodePacket(packet);
        if (decoded?.kind === 'status') {
          used.add(decoded.status.wireDeviceId);
          if (number === decoded.status.wireDeviceId) { fail(new Error(`Virtual number ${number} conflicts with an observed deck; transmission stopped.`)); return; }
          if (experimentalAz && decoded.status.model !== 'XDJ-AZ') {
            if (/^(CDJ-|XDJ-|OPUS-QUAD$|OMNIS-DUO$)/.test(decoded.status.model)) {
              foreignPlayers.add(`${decoded.status.model}@${remote.address}`);
              if (number !== undefined) fail(new Error('AZスタンドアロン（試験）中に別機種の状態を受信しました。この混在LANは試験対象外のため送信を停止します。'));
            }
            return;
          }
          if (experimentalAz) azPeers.add(remote.address);
          lastStatus = at;
          if (experimentalAz && onlineAt !== null) azReplyAfterPresence = at;
          store.setSession({ state: 'online', now: at, reason: experimentalAz ? `AZスタンドアロン（試験）: ${iface.name}で状態を受信。FW1.23・4デッキ取得・曲情報は未検証です。` : `${options.mode} on ${iface.name}; firmware unknown.` });
        }
        if (experimentalAz) {
          if (!decoded || decoded.kind === 'media') return;
          const model = decoded.kind === 'status' ? decoded.status.model : decoded.model;
          if (model !== 'XDJ-AZ') return;
        }
        store.ingest(packet);
      });
      await bindOwnedSocket(socket, port, port === 50002 && options.mode !== 'passive' ? iface.address : '0.0.0.0', controller.signal);
      socket.on('error', fail);
      if (closed || controller.signal.aborted) throw new Error('Session startup cancelled.');
    }
    if (experimentalAz) {
      // PC-role presence uses a dedicated ephemeral source port, matching the
      // observed client role, while the fixed status receiver stays on 50002.
      // Both sockets bind the selected IPv4; no wildcard transmitter is used.
      const sender = services.createSocket({ type: 'udp4', reuseAddr: false });
      sockets.set(0, sender);
      await bindOwnedSocket(sender, 0, iface.address, controller.signal);
      sender.on('error', fail);
      if (closed || controller.signal.aborted) throw new Error('Session startup cancelled.');
    }
    const sender = sockets.get(experimentalAz ? 0 : 50002)!;
    sender.setBroadcast(true);
    const send = async (bytes: Buffer) => {
      if (closed || controller.signal.aborted) throw new Error('Session closed.');
      const devices = store.snapshot().devices;
      const rx3 = devices.some(device => device.model === 'XDJ-RX3');
      if (rx3 && devices.some(device => /stagehand/i.test(device.model))) throw new Error('RX3 broadcast participation conflicts with a Stagehand peer. No duplicate participant is started.');
      // RX3 retains the locally verified broadcast route. Standard LAN peers
      // get individual unicast announcements, as in alphatheta Announcer.
      const targets = experimentalAz ? [...new Set([iface.broadcast, ...azPeers])] : rx3 ? [iface.broadcast] : [...peers];
      for (const target of targets) {
        if (closed || controller.signal.aborted) throw new Error('Session closed.');
        await new Promise<void>((resolve, reject) => sender.send(bytes, 50000, target, error => error ? reject(error) : resolve()));
      }
    };
    watchdog = setInterval(() => {
      const at = now();
      try {
        const current = selectInterface(iface.name, services.listInterfaces());
        if (current.address !== iface.address || current.mac !== iface.mac || current.netmask !== iface.netmask) throw new Error(`IF ${iface.name} disappeared or changed. Restart the session after reconnection.`);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
      const azExpired = experimentalAz && onlineAt !== null && (azReplyAfterPresence == null ? at - onlineAt > 10_000 : at - azReplyAfterPresence > 5000);
      if (azExpired || (!experimentalAz && ((lastStatus !== null && at - lastStatus > 5000) || (lastStatus === null && onlineAt !== null && at - onlineAt > 10_000)))) {
        if (azExpired) {
          fail(new Error(azReplyAfterPresence == null ? 'AZスタンドアロン（試験）: PC型参加通知後10秒間、解釈できるAZ状態を受信できなかったため送信を停止しました。FW1.23で未対応、IF/サブネット、ファイアウォール、他アプリの占有などを切り分けてください。Mode OFFは変更していません。' : 'AZスタンドアロン（試験）: AZ状態が5秒以上途絶えたため送信を停止しました。最後の値はstaleです。'));
          return;
        }
        store.setSession({ state: 'degraded', now: at, reason: 'No fresh status packets. Reconnect the device or restart this session.' });
      }
      store.tick(at);
    }, 250);
    if (experimentalAz) {
      await services.wait(Math.max(6000, options.discoveryMs ?? 6000), controller.signal);
      if (foreignPlayers.size) throw new Error(`AZスタンドアロン（試験）はAZ専用LANを対象にします。別機種のプレーヤー(${[...foreignPlayers].slice(0, 8).join(', ')})を検出したため、参加通知を送信しません。`);
      number = pickAzStandaloneNumber(used);
      onlineAt = now();
      // The observed PC client uses the template's default count=1 even when
      // other participants are known. Do not add an unmeasured variation.
      const presence = () => azStandalonePresence(iface, number as 5 | 6);
      store.setSession({ state: 'joining', now: now(), reason: `AZスタンドアロン（試験）: 未使用番号${number}でPC型参加候補を送信します。AZの事前通知がなくても、この明示試験モードだけで送信します。FW1.23は未検証です。` });
      await send(presence());
      if (closed || controller.signal.aborted) throw new Error('Session startup cancelled.');
      heartbeat = setInterval(() => { void send(presence()).catch(fail); }, 1500);
    } else if (options.mode === 'virtual-device') {
      await services.wait(Math.max(3000, options.discoveryMs ?? 6000), controller.signal);
      if (!peers.size) throw new Error(`No CDJ/XDJ announcements were received during the observation window on ${iface.name}. Check the selected LAN, IP subnet, device PRO DJ LINK mode, firewall and other applications. No participation packets were sent.`);
      number = pickNumber(used, options.deviceNumber);
      joining = true;
      store.setSession({ state: 'joining', now: now(), reason: `Claiming observed-free virtual number ${number}.` });
      for (const packet of joinPackets(iface, number)) {
        await send(packet);
        await services.wait(300, controller.signal);
      }
      joining = false;
      onlineAt = now();
      await send(keepAlive(iface, number));
      if (closed || controller.signal.aborted) throw new Error('Session startup cancelled.');
      heartbeat = setInterval(() => { void send(keepAlive(iface, number!)).catch(fail); }, 1500);
      store.setSession({ state: lastStatus === null ? 'joining' : 'online', now: now(), reason: `Virtual ${number} joined ${iface.name}; waiting for verified status reception.` });
    }
    return { close };
  } catch (error) { await close(); throw error; }
}
