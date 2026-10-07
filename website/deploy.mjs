import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './build.mjs';

const bucket = process.env.WEBSITE_BUCKET;
const distribution = process.env.WEBSITE_DISTRIBUTION_ID;
if (!bucket || !distribution) throw new Error('Set WEBSITE_BUCKET and WEBSITE_DISTRIBUTION_ID');
if (!/^tandryx-website-[0-9]{12}-[a-z0-9-]+$/.test(bucket) || !/^E[A-Z0-9]+$/.test(distribution))
  throw new Error('Unexpected website resource identifiers');
const aws = (args) =>
  execFileSync('aws', [...args, '--region', 'us-east-1', '--no-cli-pager'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const manifest = JSON.parse(await readFile(join(root, 'dist/manifest.json'), 'utf8'));
const temporary = join(root, 'dist', '.deployment');
await mkdir(temporary, { recursive: true });
let previous;
try {
  aws([
    's3api',
    'get-object',
    '--bucket',
    bucket,
    '--key',
    '.deployment-manifest.json',
    join(temporary, 'previous.json'),
  ]);
  previous = JSON.parse(await readFile(join(temporary, 'previous.json'), 'utf8'));
} catch (error) {
  // A missing manifest is expected only on the first deployment. Do not swallow access/network errors.
  const detail = String(error.stderr || error.message);
  if (!detail.includes('NoSuchKey')) throw error;
  previous = [];
}
const changed = manifest.filter(
  (item) => previous.find((old) => old.key === item.key)?.sha256 !== item.sha256,
);
// Upload assets before HTML so a visitor never receives a document with missing assets.
const ordered = [...changed].sort(
  (a, b) => Number(!a.key.startsWith('assets/')) - Number(!b.key.startsWith('assets/')),
);
for (const item of ordered) {
  aws([
    's3api',
    'put-object',
    '--bucket',
    bucket,
    '--key',
    item.key,
    '--body',
    join(root, 'dist', item.key),
    '--content-type',
    item.contentType,
    '--cache-control',
    item.cacheControl,
  ]);
}
const paths = changed
  .filter((item) => !item.cacheControl.includes('immutable'))
  .flatMap((item) => (item.key === 'index.html' ? ['/', '/index.html'] : [`/${item.key}`]));
if (paths.length) {
  const batch = { Paths: { Quantity: paths.length, Items: paths }, CallerReference: `tandryx-${Date.now()}` };
  const batchPath = join(temporary, 'invalidation.json');
  await writeFile(batchPath, JSON.stringify(batch));
  const result = JSON.parse(
    aws([
      'cloudfront',
      'create-invalidation',
      '--distribution-id',
      distribution,
      '--invalidation-batch',
      `file://${batchPath}`,
    ]),
  );
  console.log(`Invalidation ${result.Invalidation.Id}: ${paths.join(', ')}`);
}
aws([
  's3api',
  'put-object',
  '--bucket',
  bucket,
  '--key',
  '.deployment-manifest.json',
  '--body',
  join(root, 'dist/manifest.json'),
  '--content-type',
  'application/json',
  '--cache-control',
  'no-store',
]);
console.log(
  `Published ${changed.length} changed objects. No wildcard invalidation; unchanged and hashed assets retained.`,
);
