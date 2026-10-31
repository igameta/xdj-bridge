import { readFile } from 'node:fs/promises';
import type { Profile, SessionState } from './core/types.js';

export interface AppConfig {
  mode: Exclude<SessionState['mode'], 'alphatheta'>;
  backend: 'native' | 'alphatheta';
  capture?: string;
  interfaceName?: string;
  deviceNumber?: number;
  profile: Profile | 'auto';
  /** Synthetic demo size; live deck count always follows received packets. */
  demoDecks?: 2 | 4;
  speed: number;
  loop: boolean;
  host: string;
  port: number;
  staleAfterMs: number;
  publicDeckIds: Record<string, string>;
  duration?: number;
  osc?: { enabled?: boolean; host: string; port: number; maxHz?: number; snapshotIntervalMs?: number };
  notifications?: { enabled?: boolean };
}
export const HELP = `XDJ Bridge — information acquisition / visualizer / OSC

  npm run demo
  npm run demo -- --demo-decks 4 --port 8081
  npm start -- --mode replay --capture ../captures/FILE.pcapng
  npm start -- --mode virtual-device --interface en6 --osc 127.0.0.1:9000
  npm start -- --mode az-standalone --profile xdj-az --interface Ethernet
  npm start -- --mode passive --interface en6
  npm start -- --mode passive --backend alphatheta --interface en6

Options:
  --config FILE          JSON configuration (see config.example.json)
  --mode MODE            idle (default), demo, replay, passive, virtual-device, az-standalone
  --backend NAME         native (default) or alphatheta (pcap passive only)
  --interface NAME       Explicit IPv4 interface for live acquisition
  --list-interfaces      List interfaces without network participation
  --capture FILE         Read a saved .pcap/.pcapng; never sends to hardware
  --profile NAME         auto, xdj-rx3, xdj-az, generic-prolink
  --demo-decks N         2 (RX3, default) or 4 (synthetic AZ); demo only
  --device-number N      Optional virtual-device number 7–9; not used by az-standalone
  --speed N              Capture playback speed >0..1000 (default 1)
  --loop / --no-loop     Repeat replay/demo (demo repeats by default)
  --port N               Visualizer port (default 8080)
  --host IP              Visualizer bind address (default 127.0.0.1)
  --osc HOST:PORT        Enable OSC UDP output (disabled by default)
  --no-osc              Disable configured OSC output
  --duration SECONDS     Stop after this wall-clock duration
  --help                 Show this help

RX3: BPM/pitch/track ID/playback have capture evidence. Title, artist,
waveform and position remain unknown until a real provider succeeds.
AZ standalone: explicit experimental PC-presence mode. Keeps device Mode OFF;
uses an observed-free number 5/6. Firmware 1.23 and Windows hardware unverified.
`;

export async function parseConfig(args: string[]): Promise<AppConfig> {
  const configIndex = args.indexOf('--config');
  let json: Partial<AppConfig> = {};
  if (configIndex >= 0) {
    const file = args[configIndex + 1];
    if (!file || file.startsWith('--')) throw new Error('--config needs a file path');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Configuration must be a JSON object');
    json = parsed;
  }
  const result: AppConfig = { mode: 'idle', backend: 'native', profile: 'auto', demoDecks: 2, speed: 1,
    loop: true, host: '127.0.0.1', port: 8080, staleAfterMs: 3000, publicDeckIds: {}, ...json };
  let loopSpecified = json.loop !== undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      const next = args[++i];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--config') { value(); continue; }
    if (arg === '--mode') result.mode = value() as AppConfig['mode'];
    else if (arg === '--backend') result.backend = value() as AppConfig['backend'];
    else if (arg === '--interface') result.interfaceName = value();
    else if (arg === '--capture') result.capture = value();
    else if (arg === '--profile') result.profile = value() as AppConfig['profile'];
    else if (arg === '--demo-decks') result.demoDecks = Number(value()) as 2 | 4;
    else if (arg === '--device-number') result.deviceNumber = Number(value());
    else if (arg === '--speed') result.speed = Number(value());
    else if (arg === '--host') result.host = value();
    else if (arg === '--port') result.port = Number(value());
    else if (arg === '--duration') result.duration = Number(value());
    else if (arg === '--loop' || arg === '--no-loop') { result.loop = arg === '--loop'; loopSpecified = true; }
    else if (arg === '--no-osc') result.osc = undefined;
    else if (arg === '--osc') {
      const address = value();
      const match = /^([^\s:]+):(\d+)$/.exec(address);
      if (!match) throw new Error('--osc expects HOST:PORT (IPv4 or hostname)');
      result.osc = { enabled: true, host: match[1], port: Number(match[2]) };
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!loopSpecified) result.loop = result.mode === 'demo';
  if (!['idle', 'demo', 'replay', 'passive', 'virtual-device', 'az-standalone'].includes(result.mode)) throw new Error('Invalid --mode');
  if (!['native', 'alphatheta'].includes(result.backend)) throw new Error('Invalid --backend');
  if (!['auto', 'xdj-rx3', 'xdj-az', 'generic-prolink'].includes(result.profile)) throw new Error('Invalid --profile');
  if (result.demoDecks !== 2 && result.demoDecks !== 4) throw new Error('--demo-decks must be 2 or 4');
  if (result.mode === 'demo' && ((result.demoDecks === 4 && result.profile === 'xdj-rx3') || (result.demoDecks === 2 && result.profile === 'xdj-az'))) throw new Error('Demo profile mismatch: use RX3/2 decks or AZ/4 decks (auto and generic-prolink are also allowed).');
  if (result.backend === 'alphatheta' && result.mode !== 'passive') throw new Error('alphatheta backend currently supports capture-only passive mode. Use native for virtual-device participation.');
  if (['passive', 'virtual-device', 'az-standalone'].includes(result.mode) && !result.interfaceName) throw new Error('Live acquisition requires --interface; use --list-interfaces');
  if (result.mode === 'az-standalone' && !['auto', 'xdj-az'].includes(result.profile)) throw new Error('AZ standalone requires profile auto or xdj-az');
  if (result.mode === 'az-standalone' && result.deviceNumber !== undefined) throw new Error('AZ standalone chooses an observed-free number 5/6; remove the forced deviceNumber/--device-number setting.');
  if (result.mode === 'replay' && !result.capture) throw new Error('Replay requires --capture FILE');
  if (!Number.isFinite(result.speed) || result.speed <= 0 || result.speed > 1000) throw new Error('Speed must be >0 and <=1000');
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error('Invalid HTTP port');
  if (typeof result.host !== 'string' || !result.host) throw new Error('Invalid HTTP host');
  if (result.interfaceName !== undefined && (typeof result.interfaceName !== 'string' || !result.interfaceName.trim())) throw new Error('interfaceName must be a nonempty string');
  if (result.capture !== undefined && (typeof result.capture !== 'string' || !result.capture.trim())) throw new Error('capture must be a nonempty string');
  if (typeof result.loop !== 'boolean') throw new Error('loop must be boolean');
  if (!Number.isFinite(result.staleAfterMs) || result.staleAfterMs <= 0) throw new Error('Invalid staleAfterMs');
  if (result.duration !== undefined && (!Number.isFinite(result.duration) || result.duration <= 0)) throw new Error('Duration must be positive');
  if (result.deviceNumber !== undefined && ![7, 8, 9].includes(result.deviceNumber)) throw new Error('Virtual number must be 7, 8 or 9');
  if (result.publicDeckIds === null || typeof result.publicDeckIds !== 'object' || Array.isArray(result.publicDeckIds) || Object.values(result.publicDeckIds).some(x => typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(x))) throw new Error('publicDeckIds must map source keys to short OSC-safe strings');
  const ids = Object.values(result.publicDeckIds);
  if (new Set(ids).size !== ids.length) throw new Error('publicDeckIds must be unique');
  if (result.osc !== undefined) {
    if (!result.osc || typeof result.osc !== 'object' || Array.isArray(result.osc) || typeof result.osc.host !== 'string' || !result.osc.host.trim() || !Number.isInteger(result.osc.port) || result.osc.port < 1 || result.osc.port > 65535) throw new Error('Invalid OSC destination');
    if (result.osc.enabled !== undefined && typeof result.osc.enabled !== 'boolean') throw new Error('osc.enabled must be boolean');
    if (result.osc.maxHz !== undefined && (!Number.isFinite(result.osc.maxHz) || result.osc.maxHz < 1 || result.osc.maxHz > 120)) throw new Error('osc.maxHz must be >=1 and <=120');
    if (result.osc.snapshotIntervalMs !== undefined && (!Number.isFinite(result.osc.snapshotIntervalMs) || result.osc.snapshotIntervalMs < 100)) throw new Error('osc.snapshotIntervalMs must be >=100');
  }
  if (result.notifications !== undefined && (!result.notifications || typeof result.notifications !== 'object' || Array.isArray(result.notifications) || (result.notifications.enabled !== undefined && typeof result.notifications.enabled !== 'boolean'))) throw new Error('notifications must be an object with optional boolean enabled');
  return result;
}
