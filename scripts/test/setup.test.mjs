import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const databaseUrl = process.env.TEST_DATABASE_URL;
test(
  'setup preserves existing deployment settings and signing secret on reruns',
  {
    skip: !databaseUrl ? 'TEST_DATABASE_URL is required for setup integration' : false,
  },
  () => {
    assert(/test/i.test(new URL(databaseUrl).pathname), 'Setup test requires a dedicated test database');
    const fixture = mkdtempSync(join(tmpdir(), 'tandryx-setup-'));
    try {
      mkdirSync(join(fixture, 'scripts'));
      copyFileSync(join(root, 'scripts', 'setup.mjs'), join(fixture, 'scripts', 'setup.mjs'));
      copyFileSync(join(root, '.env.example'), join(fixture, '.env.example'));
      writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
      symlinkSync(
        join(root, 'node_modules'),
        join(fixture, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      writeFileSync(
        join(fixture, '.env'),
        `DATABASE_URL=${databaseUrl}\nTEST_DATABASE_URL=${databaseUrl}\nJWT_SECRET=existing-signing-secret-0123456789\nHOST=127.0.0.1\nWEB_DIST=none\nALLOW_REGISTRATION=false\nCUSTOM_SETTING=keep-me\n`,
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        execFileSync(process.execPath, [join(fixture, 'scripts', 'setup.mjs')], {
          cwd: fixture,
          env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl },
          stdio: 'pipe',
        });
        const text = readFileSync(join(fixture, '.env'), 'utf8');
        for (const expected of [
          'JWT_SECRET=existing-signing-secret-0123456789',
          'HOST=127.0.0.1',
          'WEB_DIST=none',
          'ALLOW_REGISTRATION=false',
          'CUSTOM_SETTING=keep-me',
        ]) {
          assert(text.split('\n').includes(expected), `Lost configuration: ${expected}`);
        }
      }
    } finally {
      assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
      assert(fixture.startsWith(join(tmpdir(), 'tandryx-setup-')));
      rmSync(fixture, { recursive: true, force: true });
    }
  },
);
