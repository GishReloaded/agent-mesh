import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { root } from './build.mjs';
const dist = resolve(root, 'dist');
const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const key = path === '/' ? 'index.html' : path.slice(1);
  const file = resolve(dist, key);
  const entry = manifest.find((item) => item.key === key);
  if (!entry || !file.startsWith(`${dist}${sep}`)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await readFile(resolve(dist, '404.html')));
    return;
  }
  res.writeHead(200, { 'Content-Type': entry.contentType });
  res.end(await readFile(file));
});
server.listen(4178, '127.0.0.1', () => console.log('Website preview: http://localhost:4178'));
