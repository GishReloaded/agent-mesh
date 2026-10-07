import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import type { AuthTokens } from '@gish_reloaded/tandryx-sdk';
import { clearAuth, currentAccessToken, persist, refreshAccessToken, storedUser } from '../src/lib/auth.js';

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const data = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  },
});
const tokens = (name: string): AuthTokens => ({
  accessToken: `${name}-access`,
  refreshToken: `${name}-refresh`,
  expiresIn: 3600,
  user: {
    id: name,
    displayName: name,
    email: `${name}@example.test`,
    avatarColor: '#00ff00',
    avatarUrl: null,
    createdAt: new Date().toISOString(),
  },
});
beforeEach(() => {
  clearAuth();
  data.clear();
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('an old refresh cannot sign the previous account back in after logout', async () => {
  persist(tokens('alice'), 'http://localhost:4000');
  let respond!: (response: Response) => void;
  globalThis.fetch = () =>
    new Promise<Response>((resolve) => {
      respond = resolve;
    });
  const pending = refreshAccessToken();
  clearAuth();
  persist(tokens('bob'), 'http://localhost:4000');
  respond(new Response(JSON.stringify(tokens('alice'))));
  assert.equal(await pending, null);
  assert.equal(storedUser()?.id, 'bob');
  assert.equal(currentAccessToken(), 'bob-access');
});

test('a failed old refresh does not sign out the newly logged-in account', async () => {
  persist(tokens('alice'), 'http://localhost:4000');
  let reject!: (reason: Error) => void;
  globalThis.fetch = () =>
    new Promise<Response>((_resolve, fail) => {
      reject = fail;
    });
  const pending = refreshAccessToken();
  clearAuth();
  persist(tokens('bob'), 'http://localhost:4000');
  reject(new Error('Old request failed'));
  assert.equal(await pending, null);
  assert.equal(storedUser()?.id, 'bob');
});
