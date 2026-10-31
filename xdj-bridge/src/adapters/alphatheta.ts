import { performance } from 'node:perf_hooks';
import type { StateStore } from '../core/store.js';
import type { StatusObservation } from '../core/types.js';
import { decodePacket } from '../core/decoder.js';
import { listInterfaces } from '../transport/live.js';

/** Structural public API boundary: no library-internal imports or socket patching. */
export interface LibraryStatus {
  deviceId: number; trackId: number; trackDeviceId: number; trackSlot: number; trackType: number;
  playState: number; trackBPM: number | null; effectivePitch: number;
  beat?: number | null; beatInMeasure?: number; isSync?: boolean; isMaster?: boolean;
}
interface CaptureAdapter {
  on(event: string, listener: (...args: any[]) => void): void;
  start(): void;
  stop(): void;
}
interface CaptureLibrary { PcapAdapter: new (options: { iface: string; bufferSize: number }) => CaptureAdapter }
export function statusObservationFromLibrary(status: LibraryStatus, context: {
  interfaceId: string; sourceIp: string; model: string; receivedAt: number; sessionId?: string;
}): StatusObservation {
  return { ...context, wireDeviceId: status.deviceId, trackId: status.trackId,
    sourceWireDeviceId: status.trackDeviceId, protocolSlot: status.trackSlot, trackType: status.trackType,
    playState: status.playState, trackBpm: status.trackBPM, pitchPercent: status.effectivePitch,
    tempoMaster: typeof status.isMaster === 'boolean' ? status.isMaster : undefined,
    beat: status.beat, beatInMeasure: status.beatInMeasure, source: 'alphatheta:public-status',
    raw: { playState: status.playState, isSync: status.isSync, isMaster: status.isMaster } };
}

/** Uses the library's public raw capture hook; our pure decoder guards every packet. */
export async function startAlphathetaCapture(store: StateStore, interfaceName: string): Promise<{ close(): Promise<void> }> {
  if (!listInterfaces().some(x => x.name === interfaceName)) throw new Error(`No active IPv4 IF ${interfaceName}.`);
  let library: CaptureLibrary;
  const moduleName = 'alphatheta-connect';
  try { library = await import(moduleName) as CaptureLibrary; }
  catch { throw new Error('alphatheta-connect 0.28.5 is unavailable. Install optional dependencies with npm ci --include=optional.'); }
  const adapter = new library.PcapAdapter({ iface: interfaceName, bufferSize: 1024 * 1024 });
  const origin = performance.now();
  let stopped = false;
  let errorsInWindow = 0;
  let errorWindowAt = 0;
  const at = () => performance.now() - origin;
  const close = async () => {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    adapter.stop();
    store.setSession({ state: 'disconnected', now: at(), reason: 'Packet capture stopped.' });
  };
  for (const [event, port] of [['announce', 50000], ['beat', 50001], ['status', 50002]] as const) {
    // Its public PacketInfo lacks source port/destination IP. Preserve that
    // absence as 0 / 0.0.0.0 rather than asserting captured values.
    adapter.on(event, (bytes: Buffer, info: { srcAddr: string }) => {
      if (stopped) return;
      const envelope = { sessionId: store.snapshot().session.id, interfaceId: interfaceName,
        sourceIp: info.srcAddr, sourcePort: 0, destinationIp: '0.0.0.0', destinationPort: port,
        transport: 'pcap' as const, bytes, receivedAt: at() };
      if (decodePacket(envelope)?.kind === 'status') store.setSession({ state: 'online', now: at(), reason: 'alphatheta public pcap capture; no announcements or metadata requests.' });
      store.ingest(envelope);
    });
  }
  adapter.on('error', (error: Error) => {
    // Upstream emits both malformed-frame errors and capture failures here.
    // A single corrupt frame must not tear down an otherwise healthy session.
    const time = at();
    if (time - errorWindowAt > 1000) { errorsInWindow = 0; errorWindowAt = time; }
    errorsInWindow++;
    if (errorsInWindow === 1) store.addDiagnostic('pcap-frame-error', 'warning', error.message, time);
    if (errorsInWindow >= 5) {
      store.addDiagnostic('pcap-error', 'error', 'Repeated capture errors; session stopped: ' + error.message, time);
      void close();
    }
  });
  const timer = setInterval(() => {
    if (!listInterfaces().some(x => x.name === interfaceName)) {
      store.addDiagnostic('interface-lost', 'error', `IF ${interfaceName} disappeared; restart capture after reconnect.`);
      void close();
    } else store.tick(at());
  }, 250);
  store.addDiagnostic('alphatheta-boundary', 'info', 'alphatheta-connect 0.28.5 public PcapAdapter. Capture-only: NFS/dbserver are disabled. Port and destination details unavailable in the upstream event are recorded as unknown sentinels.');
  store.setSession({ state: 'observing', interfaceId: interfaceName, now: 0, reason: 'Passive pcap on explicitly selected IF; waiting for traffic.' });
  try { adapter.start(); }
  catch (error) { await close(); throw error; }
  return { close };
}
