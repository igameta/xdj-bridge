import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { Snapshot, StateSource } from '../core/types.js';

export interface RuntimeControls {
  connect(input: unknown): Promise<void>;
  disconnect(): Promise<void>;
  setOsc(input: unknown): Promise<void>;
}
export interface ServerOptions {
  host?: string; port?: number; publicDir?: string;
  runtime?: Record<string, unknown> | (() => unknown);
  controls?: RuntimeControls;
}
class HttpError extends Error { constructor(message: string, public status: number) { super(message); } }
function jsonBody(req: http.IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') { req.resume(); return Promise.reject(new HttpError('Content-Type must be application/json', 415)); }
  if (Number(req.headers['content-length']) > 4096) { req.resume(); return Promise.reject(new HttpError('Request body exceeds 4096 bytes', 413)); }
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []; let size = 0; let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > 4096) { failed = true; chunks.length = 0; reject(new HttpError('Request body exceeds 4096 bytes', 413)); return; }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError('Request aborted', 400)));
    req.on('end', () => {
      if (failed) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError('Invalid JSON', 400)); }
    });
  });
}
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export async function startServer(store: StateSource, options: ServerOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8080;
  const publicDir = resolve(options.publicDir ?? fileURLToPath(new URL('../../../public/', import.meta.url)));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid HTTP port');
  let authority = '';
  const runtime = () => typeof options.runtime === 'function' ? options.runtime() : options.runtime ?? {};
  const validRequest = (req: http.IncomingMessage) => {
    if (req.headers.host !== authority) return false;
    if (!req.headers.origin) return true;
    try { return new URL(req.headers.origin).origin === 'http://' + authority; } catch { return false; }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!validRequest(req)) { res.writeHead(403).end('Forbidden origin or host'); return; }
    try {
      const path = new URL(req.url ?? '/', 'http://' + authority).pathname;
      if (req.method === 'POST' && (path === '/api/connection' || path === '/api/osc') && options.controls) {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) throw new HttpError('Settings can only be changed from this computer', 403);
        const body = await jsonBody(req);
        if (path === '/api/osc') await options.controls.setOsc(body);
        else {
          const action = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).action : undefined;
          if (action === 'connect') await options.controls.connect(body);
          else if (action === 'disconnect') await options.controls.disconnect();
          else throw new HttpError('Invalid connection action', 400);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(runtime())); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
      if (path === '/api/state' || path === '/api/health' || path === '/api/runtime') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const snapshot = store.snapshot();
        const value = path === '/api/state' ? snapshot : path === '/api/runtime' ? runtime() : {
          ok: true, schemaVersion: snapshot.schemaVersion, revision: snapshot.revision,
          sessionState: snapshot.session.state, mode: snapshot.session.mode,
        };
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value)); return;
      }
      const decoded = decodeURIComponent(path);
      const target = resolve(publicDir, '.' + (decoded === '/' ? '/index.html' : decoded));
      if (!target.startsWith(publicDir + sep)) { res.writeHead(403).end(); return; }
      const content = await readFile(target);
      res.setHeader('Content-Type', MIME[extname(target)] ?? 'application/octet-stream');
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (req.method === 'POST') {
        const status = error && typeof error === 'object' && 'status' in error && Number.isInteger(error.status) ? Number(error.status) : 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error instanceof Error ? error.message : '設定を変更できませんでした。' }));
      } else {
        const status = error instanceof URIError ? 400 : 404;
        res.writeHead(status).end(status === 400 ? 'Invalid URL' : 'Not found');
      }
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (!validRequest(req) || req.url !== '/ws') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
  });
  const clients = new Map<WebSocket, { revision: number; sessionId: string; needsSnapshot: boolean; decks: Map<string, number>; }>();
  const send = (client: WebSocket, snapshot: Snapshot, forceSnapshot = false) => {
    const state = clients.get(client);
    if (!state || client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 64 * 1024) { state.needsSnapshot = true; return; }
    const currentDecks = new Map(snapshot.decks.map(deck => [deck.deckId, deck.stateRevision]));
    const message = forceSnapshot || state.needsSnapshot || state.sessionId !== snapshot.session.id ? { type: 'snapshot', ...snapshot } : {
      type: 'delta', schemaVersion: snapshot.schemaVersion, baseRevision: state.revision, revision: snapshot.revision,
      decks: snapshot.decks.filter(deck => state.decks.get(deck.deckId) !== deck.stateRevision),
      removedDeckIds: [...state.decks.keys()].filter(id => !currentDecks.has(id)), session: snapshot.session, diagnostics: snapshot.diagnostics,
    };
    client.send(JSON.stringify(message), error => { if (error) client.terminate(); });
    state.revision = snapshot.revision; state.sessionId = snapshot.session.id; state.decks = currentDecks; state.needsSnapshot = false;
  };
  wss.on('connection', client => {
    clients.set(client, { revision: -1, sessionId: '', needsSnapshot: true, decks: new Map() });
    send(client, store.snapshot(), true);
    client.on('error', () => client.terminate());
    client.on('close', () => clients.delete(client));
    client.on('message', data => {
      try { if (JSON.parse(data.toString()).type === 'resync') send(client, store.snapshot(), true); } catch { client.close(1003, 'Invalid message'); }
    });
  });
  const unsubscribe = store.subscribe(snapshot => { for (const client of clients.keys()) send(client, snapshot); });
  // A slow subscriber receives the latest snapshot after its OS buffer drains.
  const drainTimer = setInterval(() => {
    for (const [client, state] of clients) if (state.needsSnapshot) send(client, store.snapshot(), true);
  }, 250);
  try {
    await new Promise<void>((resolveListening, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolveListening(); });
    });
  } catch (error) { clearInterval(drainTimer); unsubscribe(); wss.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP address unavailable');
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? '[' + host + ']' : host;
  authority = displayHost + ':' + address.port;
  let closed = false;
  return { url: 'http://' + authority, async close() {
    if (closed) return;
    closed = true; unsubscribe(); clearInterval(drainTimer);
    for (const client of clients.keys()) client.terminate();
    await new Promise<void>(done => wss.close(() => done()));
    await new Promise<void>(done => server.close(() => done()));
  } };
}
