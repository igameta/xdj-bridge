import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { StateStore } from '../src/core/store.js';
import { makeDemoPackets, readCapture, replayPackets } from '../src/transport/replay.js';

const fixture = Buffer.from((await readFile(new URL('../../tests/fixtures/rx3-loop-master-sync.hex', import.meta.url), 'utf8')).trim(), 'hex');
function frame(payload = fixture): Buffer {
  const b = Buffer.alloc(14 + 20 + 8 + payload.length);
  b.writeUInt16BE(0x0800, 12); b[14] = 0x45; b.writeUInt16BE(20 + 8 + payload.length, 16); b[23] = 17;
  Buffer.from([169, 254, 95, 63, 169, 254, 77, 195]).copy(b, 26);
  b.writeUInt16BE(50002, 34); b.writeUInt16BE(50002, 36); b.writeUInt16BE(8 + payload.length, 38); payload.copy(b, 42);
  return b;
}
function pcap(): Buffer {
  const header = Buffer.alloc(24); header.writeUInt32LE(0xa1b2c3d4); header.writeUInt16LE(2, 4); header.writeUInt16LE(4, 6); header.writeUInt32LE(65535, 16); header.writeUInt32LE(1, 20);
  const record = (sec: number, usec: number) => { const b = Buffer.alloc(16); b.writeUInt32LE(sec); b.writeUInt32LE(usec, 4); b.writeUInt32LE(frame().length, 8); b.writeUInt32LE(frame().length, 12); return Buffer.concat([b, frame()]); };
  return Buffer.concat([header, record(1000, 500000), record(1002, 0)]);
}
function pcapng(little: boolean): Buffer {
  const u16 = (b: Buffer, n: number, v: number) => little ? b.writeUInt16LE(v, n) : b.writeUInt16BE(v, n);
  const u32 = (b: Buffer, n: number, v: number) => little ? b.writeUInt32LE(v, n) : b.writeUInt32BE(v, n);
  const block = (type: number, body: Buffer) => { const b = Buffer.alloc(12 + body.length); u32(b, 0, type); u32(b, 4, b.length); body.copy(b, 8); u32(b, b.length - 4, b.length); return b; };
  const shb = Buffer.alloc(16); u32(shb, 0, 0x1a2b3c4d); u16(shb, 4, 1); shb.fill(0xff, 8);
  const idb = Buffer.alloc(8 + 8 + 12 + 4); u16(idb, 0, 1); u32(idb, 4, 65535);
  u16(idb, 8, 9); u16(idb, 10, 1); idb[12] = 3; // timestamps in milliseconds
  u16(idb, 16, 14); u16(idb, 18, 8);
  if (little) idb.writeBigInt64LE(1000n, 20); else idb.writeBigInt64BE(1000n, 20);
  const epb = (ticks: number) => { const bytes = frame(); const body = Buffer.alloc(20 + ((bytes.length + 3) & ~3)); u32(body, 8, ticks); u32(body, 12, bytes.length); u32(body, 16, bytes.length); bytes.copy(body, 20); return block(6, body); };
  return Buffer.concat([block(0x0a0d0d0a, shb), block(1, idb), epb(500), epb(2000)]);
}
async function withCapture(bytes: Buffer, callback: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'xdj-replay-test-'));
  try { const path = join(directory, 'capture.pcap'); await writeFile(path, bytes); await callback(path); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
test('classic pcap extracts validated UDP envelopes with session-relative timestamps', async () => {
  await withCapture(pcap(), async path => {
    const packets = await readCapture(path, 'capture-test');
    assert.equal(packets.length, 2); assert.deepEqual(packets.map(p => p.receivedAt), [0, 1500]);
    assert.equal(packets[0].sourceIp, '169.254.95.63'); assert.equal(packets[0].destinationIp, '169.254.77.195');
    assert.equal(packets[0].destinationPort, 50002); assert.equal(packets[0].sourcePort, 50002);
    assert.equal(packets[0].sessionId, 'capture-test'); assert.deepEqual(packets[0].bytes, fixture);
  });
});
for (const little of [true, false]) test(`pcapng ${little ? 'little' : 'big'} endian honors timestamp resolution and offset`, async () => {
  await withCapture(pcapng(little), async path => {
    const packets = await readCapture(path, 'capture-test');
    assert.equal(packets.length, 2); assert.deepEqual(packets.map(p => p.receivedAt), [0, 1500]);
    assert.equal(packets[0].interfaceId, 'capture:0:0'); assert.deepEqual(packets[0].bytes, fixture);
  });
});
test('pcapng new sections reset endian and interface definitions', async () => {
  await withCapture(Buffer.concat([pcapng(true), pcapng(false)]), async path => {
    const packets = await readCapture(path, 'capture-test');
    assert.equal(packets.length, 4); assert.deepEqual(packets.map(p => p.receivedAt), [0, 1500, 1500, 1500]);
    assert.equal(packets[2].interfaceId, 'capture:1:0');
  });
});
test('malformed lengths fail clearly without buffer overreads', async () => {
  for (const bytes of [Buffer.alloc(3), pcap().subarray(0, 30), pcapng(true).subarray(0, 70)]) {
    await withCapture(bytes, async path => { await assert.rejects(readCapture(path, 'bad')); });
  }
});
test('replay speed changes scheduling only, preserving source timestamps; abort stops callbacks', async () => {
  const packets = makeDemoPackets('demo').slice(0, 6);
  const seen: number[] = [];
  await replayPackets(packets, { speed: 1000, onPacket: p => { seen.push(p.receivedAt); } });
  assert.deepEqual(seen, packets.map(p => p.receivedAt));
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await replayPackets(packets, { signal: abort.signal, onPacket: () => { calls++; } }); assert.equal(calls, 0);
  await assert.rejects(replayPackets(packets, { speed: 0, onPacket() {} }));
});
test('demo has explicit synthetic diagnostics and no fabricated beat/position/metadata', () => {
  const store = new StateStore({ sessionId: 'demo', mode: 'demo' });
  for (const p of makeDemoPackets('demo')) store.ingest(p);
  const snapshot = store.snapshot();
  assert.ok(snapshot.diagnostics.some(d => d.code === 'synthetic-demo'));
  assert.deepEqual(snapshot.decks.map(d => d.publicDeckId), ['1', '2']);
  for (const d of snapshot.decks) {
    assert.equal(d.title.value, null); assert.equal(d.beat.value, null); assert.equal(d.positionMs.value, null);
    assert.equal(d.capabilities.status.verification, 'implemented-unverified');
  }
});
test('saved hardware pcapng replays both RX3 logical decks when local capture exists', async t => {
  const path = new URL('../../../captures/rx3-20261005-python-virtual-cdj.pcapng', import.meta.url);
  let packets;
  try { packets = await readCapture(fileURLToPath(path), 'hardware-regression'); }
  catch (error) {
    // Captures are intentionally excluded from distribution for DJ privacy.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { t.skip('Local private capture not distributed'); return; }
    throw error;
  }
  const store = new StateStore({ sessionId: 'hardware-regression', mode: 'replay' });
  for (const p of packets) store.ingest(p);
  const decks = store.snapshot().decks;
  assert.equal(packets.length, 400); assert.deepEqual(decks.map(d => d.wireDeviceId), [11, 12]);
  assert.deepEqual(decks.map(d => d.trackBpm.value), [122, 126]); assert.deepEqual(decks.map(d => d.trackRef?.trackId), [1, 2]);
  assert.ok(decks.every(d => d.beat.value == null && d.positionMs.value == null));
});
