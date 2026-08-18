import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://user:pass@localhost:5432/agentmesh' };

describe('configuration', () => {
  it('accepts PORT=0, which means "let the OS pick"', () => {
    assert.equal(loadConfig({ ...base, PORT: '0' }).port, 0);
  });

  it('treats an empty WEB_DIST as unset, not as disabled', () => {
    // `.env.example` ships `WEB_DIST=`, and that must still auto-detect the
    // built client - otherwise a fresh setup serves an API with no UI.
    const withEmpty = loadConfig({ ...base, WEB_DIST: '' });
    const withNothing = loadConfig(base);
    assert.equal(withEmpty.webDist, withNothing.webDist);
  });

  it('disables the UI only on an explicit "none"', () => {
    assert.equal(loadConfig({ ...base, WEB_DIST: 'none' }).webDist, null);
  });

  it('rejects a missing database url', () => {
    assert.throws(() => loadConfig({}), /DATABASE_URL/);
  });

  it('refuses to start in production without a signing secret', () => {
    assert.throws(
      () => loadConfig({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://example.com' }),
      /JWT_SECRET/,
    );
  });

  it('refuses a wildcard CORS origin in production', () => {
    assert.throws(
      () =>
        loadConfig({
          ...base,
          NODE_ENV: 'production',
          JWT_SECRET: 'a-secret-long-enough-to-be-accepted-here',
          CORS_ORIGINS: '*',
        }),
      /CORS_ORIGINS/,
    );
  });

  it('parses an explicit origin allowlist', () => {
    const config = loadConfig({ ...base, CORS_ORIGINS: 'https://a.example, https://b.example' });
    assert.deepEqual(config.corsOrigins, ['https://a.example', 'https://b.example']);
  });
});
