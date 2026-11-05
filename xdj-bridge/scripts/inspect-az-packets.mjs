// Offline inspection only: this module never opens sockets or transmits.
// Byte offsets follow the existing local RX3 packet probe. Interpreted values
// remain candidates until compared with the AZ display and deck controls.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const magic = Buffer.from('5173707431576d4a4f4c', 'hex');
const name = (b, offset) => b.subarray(offset, offset + 20).toString('ascii').replace(/\0.*$/, '').trim();

export function inspectPacket(bytes, port) {
  const b = Buffer.from(bytes);
  if (b.length < 11 || !b.subarray(0, 10).equals(magic)) return null;
  const base = { port, type: b[10], length: b.length };
  if (port === 50000 && b[10] === 6 && b.length >= 54) {
    return { ...base, kind: 'announcement', model: name(b, 12), wireDeviceId: b[0x24],
      advertisedIp: [...b.subarray(0x2c, 0x30)].join('.'), mac: b.subarray(0x26, 0x2c).toString('hex'),
      raw: { headerLayout: b[0x21], announcedLength: b.readUInt16BE(0x22), tailHex: b.subarray(0x30).toString('hex') } };
  }
  if (port === 50001 && b[10] === 0x28 && b.length >= 96) {
    const rawPitch = b.readUIntBE(0x55, 3), rawBpm = b.readUInt16BE(0x5a);
    const bpm = rawBpm === 0xffff ? null : rawBpm / 100;
    const pitch = rawPitch <= 0x200000 ? rawPitch / 0x100000 : null;
    const predictionOffsets = [0x24, 0x28, 0x2c, 0x30, 0x34, 0x38];
    return { ...base, kind: 'beat', model: name(b, 11), wireDeviceId: b[0x21],
      raw: { pitch: rawPitch, bpm: rawBpm, beatWithinBar: b[0x5c],
        predictions: predictionOffsets.map(offset => ({ offset, value: b.readUInt32BE(offset) })) },
      candidates: { trackBpm: bpm, pitchPercent: pitch === null ? null : (pitch - 1) * 100,
        effectiveBpm: bpm === null || pitch === null ? null : bpm * pitch,
        beatWithinBar: b[0x5c] >= 1 && b[0x5c] <= 4 ? b[0x5c] : null },
      unavailable: ['confirmedPlaying', 'trackId', 'title', 'artist', 'absolutePosition', 'tempoMaster', 'onAir'] };
  }
  return { ...base, kind: 'unclassified', model: name(b, port === 50000 ? 12 : 11),
    wireDeviceId: b.length > 0x21 ? b[0x21] : null };
}

export function summarizeRows(rows) {
  const groups = new Map(); let decodedCount = 0, malformedCount = 0;
  for (const row of rows) {
    const hex = row.hex ?? row.payloadHex ?? row.bytesHex;
    const port = Number(row.destinationPort ?? row.port);
    if (typeof hex !== 'string' || !/^(?:[\da-f]{2})+$/i.test(hex)) { malformedCount++; continue; }
    const decoded = inspectPacket(Buffer.from(hex, 'hex'), port);
    if (!decoded) continue;
    decodedCount++;
    const sourceIp = row.sourceIp ?? row.source ?? row.address ?? null;
    const key = JSON.stringify([sourceIp, port, decoded.type, decoded.length, decoded.wireDeviceId]);
    const group = groups.get(key) ?? { sourceIp, port, type: decoded.type, length: decoded.length,
      wireDeviceId: decoded.wireDeviceId, model: decoded.model, count: 0, candidateValues: {}, latest: null };
    group.count++; group.latest = decoded;
    for (const [field, value] of Object.entries(decoded.candidates ?? {})) {
      const values = group.candidateValues[field] ?? [];
      if (!values.includes(value) && values.length < 32) values.push(value);
      group.candidateValues[field] = values;
    }
    groups.set(key, group);
  }
  return { interpretation: 'RX3-compatible byte-offset candidates; AZ display/control comparison required. Beat receipt does not prove playing.',
    decodedCount, malformedCount, groups: [...groups.values()] };
}

async function main() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || extra.length) throw new Error('Usage: node scripts/inspect-az-packets.mjs INPUT.jsonl [OUTPUT.json]');
  const rows = (await readFile(input, 'utf8')).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  const result = JSON.stringify(summarizeRows(rows), null, 2) + '\n';
  if (output) await writeFile(output, result);
  else process.stdout.write(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
