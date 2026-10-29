import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { decodeOscPacket } from '../dist/src/output/osc.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), 'xdj-clean-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 90_000 });
try {
  const source = join(temp, 'source');
  await mkdir(source);
  for (const item of ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'tests', 'public']) {
    await cp(join(root, item), join(source, item), { recursive: true });
  }
  run('npm', ['ci', '--omit=optional', '--offline', '--no-audit', '--no-fund'], source);
  const sourceTest = run('npm', ['test'], source);
  console.log('Clean source install without optional library: build and tests passed.');
  console.log(sourceTest.split('\n').filter(line => /ℹ (tests|pass|fail|skipped)/.test(line)).join('\n'));

  run('tar', ['-xzf', join(root, 'artifacts/xdj-bridge-0.1.0-runtime.tar.gz'), '-C', temp], root);
  const runtime = join(temp, 'xdj-bridge');
  run('npm', ['ci', '--omit=dev', '--omit=optional', '--offline', '--no-audit', '--no-fund'], runtime);
  const receiver = dgram.createSocket('udp4');
  receiver.bind(0, '127.0.0.1'); await once(receiver, 'listening');
  const oscPort = receiver.address().port;
  const messages = [];
  receiver.on('message', bytes => messages.push(...decodeOscPacket(bytes)));
  const child = spawn(process.execPath, ['dist/src/main.js', '--mode', 'demo', '--demo-decks', '4', '--duration', '0.8', '--port', '0', '--osc', `127.0.0.1:${oscPort}`], { cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      out += chunk;
      const found = /XDJ Bridge: (http:\/\/[^\s]+)/.exec(out);
      if (found) resolve(found[1]);
    });
    child.once('error', reject);
    child.once('exit', code => { if (!/XDJ Bridge:/.test(out)) reject(new Error(`Runtime failed ${code}: ${errors}`)); });
  });
  const response = await fetch(`${url}/api/state`);
  const state = await response.json();
  assert.equal(state.session.mode, 'demo'); assert.equal(state.decks.length, 4);
  assert.deepEqual(state.decks.map(deck => deck.publicDeckId), ['1', '2', '3', '4']);
  assert.deepEqual(state.decks.map(deck => deck.trackBpm.value), [122, 125, 128, 130]);
  for (const deck of state.decks) {
    assert.equal(deck.positionMs.value, null); assert.equal(deck.beat.value, null); assert.equal(deck.title.value, null);
    assert.equal(deck.capabilities.status.verification, 'implemented-unverified');
  }
  const html = await (await fetch(url)).text(); assert.match(html, /接続先/);
  const [exitCode] = await exited;
  assert.equal(exitCode, 0, errors);
  await new Promise(resolve => setTimeout(resolve, 20));
  receiver.close();
  for (const deck of ['1', '2', '3', '4']) {
    const validity = messages.filter(x => x.address === `/dj/decks/${deck}/bpm/valid`).map(x => x.args[0]);
    assert.ok(validity.includes(1), `runtime should emit demo OSC for deck ${deck}`);
    assert.equal(validity.at(-1), 0, `runtime shutdown must invalidate OSC deck ${deck}`);
  }
  console.log('Extracted compiled runtime: production-only install, HTTP/UI, four decks, OSC UDP for decks 1–4, final invalidation and clean shutdown passed.');
} finally { await rm(temp, { recursive: true, force: true }); }
