#!/usr/bin/env node
/**
 * Build the Lambda deployment package.
 *
 * Two bundles - the HTTP handler and the WebSocket handler - plus the built web
 * client, which the HTTP function serves directly. Bundling with esbuild rather
 * than shipping node_modules keeps the package small enough that cold starts
 * stay tolerable, which matters more here than anywhere else in the project.
 */
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const serverSrc = join(repoRoot, 'packages', 'server', 'src');
const outDir = join(repoRoot, 'dist-lambda');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: false,
  sourcemap: false,
  // The AWS SDK is part of the Node 22 Lambda runtime; bundling it would add
  // megabytes to every cold start for no benefit.
  external: ['@aws-sdk/*', 'pg-native'],
  // Several dependencies still call require() internally. In an ESM bundle
  // that identifier does not exist unless we provide it.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      "import { fileURLToPath as __fileURLToPath } from 'url';",
      "import { dirname as __dirname_ } from 'path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirname_(__filename);',
    ].join('\n'),
  },
};

console.log('bundling handlers...');
await build({
  ...shared,
  entryPoints: { http: join(serverSrc, 'lambda', 'http.ts') },
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
});
await build({
  ...shared,
  entryPoints: { ws: join(serverSrc, 'lambda', 'ws.ts') },
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
});

// Migrations are applied by the deploy script against the database directly,
// but shipping them keeps the package self-describing.
console.log('copying migrations and web client...');
await cp(join(serverSrc, 'db', 'migrations'), join(outDir, 'migrations'), { recursive: true });

const webDist = join(repoRoot, 'packages', 'web', 'dist');
try {
  await stat(webDist);
  await cp(webDist, join(outDir, 'web'), { recursive: true });
} catch {
  console.warn('  web client not built - run "npm run build -w @agentmesh/web" first');
}

const files = await readdir(outDir);
console.log(`\ndist-lambda/ contains: ${files.join(', ')}`);
