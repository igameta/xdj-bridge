import { pathToFileURL } from 'node:url';
import { parseConfig, HELP } from './config.js';
import { listInterfaces } from './transport/live.js';
import { startServer } from './output/server.js';
import { RuntimeController } from './runtime.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return; }
  if (args.includes('--list-interfaces')) {
    console.table(listInterfaces().map(x => ({ interface: x.name, address: x.address, netmask: x.netmask, mac: x.mac })));
    return;
  }
  const config = await parseConfig(args);
  const runtime = new RuntimeController(config);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let durationTimer: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  const shutdown = () => stopping ??= (async () => {
    clearTimeout(durationTimer);
    await runtime.close(); await server?.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  })();
  const stop = () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await runtime.initialize();
    if (stopping) return;
    server = await startServer(runtime, { host: config.host, port: config.port,
      runtime: () => runtime.getRuntime(), controls: runtime });
    if (stopping) { await server.close(); return; }
    console.log(`XDJ Bridge: ${server.url}`);
    const info = runtime.getRuntime();
    console.log(`${config.mode} · ${config.backend} · OSC ${info.osc.enabled ? `${info.osc.host}:${info.osc.port}` : 'off'}`);
    if (config.duration) durationTimer = setTimeout(stop, config.duration * 1000);
  } catch (error) {
    const interrupted = Boolean(stopping);
    await shutdown();
    if (!interrupted) throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`XDJ Bridge: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
