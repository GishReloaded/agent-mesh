import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load `.env` files without a dependency: Node has had `process.loadEnvFile`
 * since 20.12. Values already present in the real environment win, which keeps
 * container and CI configuration authoritative over a stray local file.
 */
export function loadEnvFiles(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [process.cwd(), resolve(here, '..'), resolve(here, '..', '..', '..')];
  const seen = new Set<string>();

  for (const root of roots) {
    for (const name of ['.env.local', '.env']) {
      const path = join(root, name);
      if (seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      try {
        process.loadEnvFile(path);
      } catch {
        // A malformed .env should not take the process down before the config
        // validator has had a chance to produce a readable error.
      }
    }
  }
}
