import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'xdj-runtime-'));
const folder = join(temp, 'xdj-bridge');
await mkdir(folder);
try {
  for (const file of ['package.json', 'package-lock.json', 'public', 'README.md', 'config.example.json', 'AUDIT.md', 'docs']) {
    await cp(join(root, file), join(folder, file), { recursive: true });
  }
  await mkdir(join(folder, 'dist'), { recursive: true });
  await cp(join(root, 'dist/src'), join(folder, 'dist/src'), { recursive: true });
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const name = `xdj-bridge-${pkg.version}-runtime.tar.gz`;
  const target = join(root, 'artifacts', name);
  execFileSync('tar', ['-czf', target, '-C', temp, 'xdj-bridge']);
  const hash = createHash('sha256').update(await readFile(target)).digest('hex');
  await writeFile(join(root, 'artifacts/SHA256SUMS'), `${hash}  ${name}\n`);
  console.log(target);
} finally { await rm(temp, { recursive: true, force: true }); }
