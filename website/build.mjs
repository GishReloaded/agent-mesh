import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const root = dirname(fileURLToPath(import.meta.url));
export async function build() {
  const output = join(root, 'dist');
  if (resolve(output) !== resolve(root, 'dist')) throw new Error('Unexpected build directory');
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, 'assets'), { recursive: true });
  const mapping = {};
  const manifest = [];
  const types = {
    '.css': 'text/css',
    '.mjs': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  for (const name of await readdir(join(root, 'src/assets'))) {
    if (name === 'og.svg') continue; // Editable source; social crawlers receive its PNG export.
    const bytes = await readFile(join(root, 'src/assets', name));
    const extension = name.slice(name.lastIndexOf('.'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    // Stable OG path lets canonical metadata work across releases. Other assets are immutable.
    const key =
      name === 'og.png'
        ? `assets/${name}`
        : `assets/${name.slice(0, -extension.length)}.${hash.slice(0, 12)}${extension}`;
    mapping[`/assets/${name}`] = `/${key}`;
    await writeFile(join(output, key), bytes);
    manifest.push({
      key,
      sha256: hash,
      contentType: types[extension],
      cacheControl: name === 'og.png' ? 'public,max-age=300' : 'public,max-age=31536000,immutable',
    });
  }
  const add = async (key, content, contentType) => {
    await writeFile(join(output, key), content);
    manifest.push({
      key,
      sha256: createHash('sha256').update(content).digest('hex'),
      contentType,
      cacheControl: 'public,max-age=300',
    });
  };
  for (const [source, key] of [
    ['index.html', 'index.html'],
    ['privacy.html', 'privacy'],
    ['terms.html', 'terms'],
    ['404.html', '404.html'],
  ]) {
    let html = await readFile(join(root, 'src', source), 'utf8');
    for (const [from, to] of Object.entries(mapping)) html = html.replaceAll(from, to);
    await add(key, html, 'text/html; charset=utf-8');
  }
  await add(
    'robots.txt',
    'User-agent: *\nAllow: /\nSitemap: https://tandryx.js.org/sitemap.xml\n',
    'text/plain; charset=utf-8',
  );
  await add('CNAME', await readFile(join(root, 'src/CNAME'), 'utf8'), 'text/plain; charset=utf-8');
  await add(
    'sitemap.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://tandryx.js.org/</loc></url><url><loc>https://tandryx.js.org/privacy</loc></url><url><loc>https://tandryx.js.org/terms</loc></url></urlset>\n',
    'application/xml',
  );
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Website built: ${manifest.length} objects, ${manifest.filter((x) => x.key.startsWith('assets/')).length} assets.`,
  );
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
