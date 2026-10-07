import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, root } from '../build.mjs';
test('built site resolves its local links and keeps truthful, indexable pages', async () => {
  const manifest = await build();
  const keys = new Set(manifest.map((item) => item.key));
  for (const key of ['index.html', 'privacy', 'terms', '404.html']) {
    const html = await readFile(join(root, 'dist', key), 'utf8');
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<title>[^<]*Tandryx[^<]*<\/title>/);
    assert.match(html, /name="viewport"/);
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (target.startsWith('#')) assert.ok(ids.has(target.slice(1)), `${key}: missing ${target}`);
      if (target.startsWith('/'))
        assert.ok(keys.has(target === '/' ? 'index.html' : target.slice(1)), `${key}: missing ${target}`);
    }
    if (key !== '404.html') assert.match(html, /rel="canonical" href="https:\/\/tandryx\.com\//);
  }
  const index = await readFile(join(root, 'dist/index.html'), 'utf8');
  assert.match(index, /scripted SDK demo/);
  assert.match(index, /Planned/);
  assert.match(index.replace(/\s+/g, ' '), /does not imply an Anthropic partnership/);
  assert.equal((index.match(/<h1>/g) || []).length, 1);
  assert.ok(
    manifest
      .filter((item) => item.key.startsWith('assets/') && item.key !== 'assets/og.png')
      .every((item) => item.cacheControl.includes('immutable')),
  );
});
