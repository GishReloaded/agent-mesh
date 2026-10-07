#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), 'tandryx-pack-'));
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? resolve(root, process.argv[outputIndex + 1]) : join(temporary, 'packages');
mkdirSync(output, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this through npm run release:check or npm run release:pack.');
const npm = (args, cwd = root) =>
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const tarballs = [];
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

for (const name of ['protocol', 'sdk', 'cli']) {
  const directory = join(root, 'packages', name);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.version, version, `${name}: release versions must match`);
  for (const [dependency, dependencyVersion] of Object.entries(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@gish_reloaded/tandryx-')) assert.equal(dependencyVersion, version);
  }
  const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', output], directory));
  const files = new Set(pack.files.map((file) => file.path));
  for (const file of ['package.json', 'README.md', 'LICENSE', 'dist/index.js']) {
    assert(files.has(file), `${manifest.name} is missing ${file}`);
  }
  if (name !== 'cli') assert(files.has('dist/index.d.ts'), `${manifest.name} is missing type declarations`);
  for (const file of files) {
    assert(
      !/(^|\/)(\.env[^/]*|node_modules|test|src|config\.json)(\/|$)/.test(file),
      `Unexpected package file: ${file}`,
    );
  }
  tarballs.push(join(output, pack.filename));
  console.log(`${manifest.name}@${version}: ${pack.files.length} files, ${pack.size} bytes`);
}

// Install the actual packed files outside the monorepo: workspace symlinks
// must not conceal missing exports, licenses or unpublished dependencies.
const consumer = join(temporary, 'consumer');
mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], consumer);
execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
  import assert from 'node:assert/strict';
  import { PROTOCOL_VERSION, clientFrameSchema } from '@gish_reloaded/tandryx-protocol';
  import { RestClient, connect } from '@gish_reloaded/tandryx-sdk';
  assert.equal(PROTOCOL_VERSION, 'tandryx/v1');
  assert.equal(typeof clientFrameSchema.safeParse, 'function');
  assert.equal(new RestClient({ url: 'http://localhost:4000' }).baseUrl, 'http://localhost:4000');
  assert.equal(typeof connect, 'function');
`,
  ],
  { cwd: consumer, stdio: 'pipe' },
);
const cli = join(consumer, 'node_modules', '@gish_reloaded', 'tandryx-cli', 'dist', 'index.js');
const help = execFileSync(process.execPath, [cli, '--help'], { cwd: consumer, encoding: 'utf8' });
assert(help.includes('agent') && help.includes('session'), 'Packed CLI does not expose expected commands');
const reportedVersion = execFileSync(process.execPath, [cli, '--version'], {
  cwd: consumer,
  encoding: 'utf8',
}).trim();
assert.equal(reportedVersion, version, 'Packed CLI version differs from release');
const commandVersion = npm(['exec', '--offline', '--', 'tandryx', '--version'], consumer).trim();
assert.equal(commandVersion, version, 'Installed CLI command is missing or has the wrong version');
const sums = tarballs.map(
  (path) => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${path.split(/[\\/]/).at(-1)}`,
);
writeFileSync(join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(`Clean consumer install, SDK imports and CLI checks passed.${outputIndex >= 0 ? ` Packages: ${output}` : ''}`);
assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
assert(temporary.startsWith(join(tmpdir(), 'tandryx-pack-')));
rmSync(temporary, { recursive: true, force: true });
