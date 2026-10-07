import { RestClient, type AuthTokens, type User } from '@gish_reloaded/agentmesh-sdk';

/**
 * Token handling for the browser client.
 *
 * The refresh token lives in `localStorage`, which is a deliberate trade for a
 * self-hosted developer tool: httpOnly cookies would need a same-site
 * deployment and CSRF protection, and AgentMesh is designed to be reachable
 * from a CLI and agents on other machines too. The access token is short-lived
 * and kept in memory only.
 */
const STORAGE_KEY = 'agentmesh.auth';

interface StoredAuth {
  serverUrl: string;
  refreshToken: string;
  user: User;
}

let accessToken: string | undefined;
let generation = 0;

export function serverUrl(): string {
  const stored = read();
  return stored?.serverUrl ?? import.meta.env.VITE_AGENTMESH_URL ?? window.location.origin;
}

function read(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

export function storedUser(): User | null {
  return read()?.user ?? null;
}

/** Keep the cached account in step after the person edits their profile. */
export function persistUser(user: User): void {
  const stored = read();
  if (!stored) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, user }));
}

export function isAuthenticated(): boolean {
  return read() !== null;
}

export function persist(tokens: AuthTokens, url = serverUrl()): void {
  generation += 1;
  accessToken = tokens.accessToken;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      serverUrl: url,
      refreshToken: tokens.refreshToken,
      user: tokens.user,
    } satisfies StoredAuth),
  );
}

export function clearAuth(): void {
  generation += 1;
  refreshInFlight = null;
  accessToken = undefined;
  localStorage.removeItem(STORAGE_KEY);
}

export function currentAccessToken(): string | undefined {
  return accessToken;
}

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Exchange the stored refresh token for a fresh access token.
 *
 * Refresh tokens are single-use: presenting a consumed one is treated as a
 * leak and revokes the whole family. A page that fires several requests at
 * once - loading a session fetches its detail, messages, tasks and context in
 * parallel - would otherwise have every one of them try to refresh with the
 * same token, and all but the first would look exactly like an attack. So
 * concurrent callers share one exchange.
 */
export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  const started = generation;
  const pending = (async () => {
    const stored = read();
    if (!stored) return null;
    try {
      const tokens = await new RestClient({ url: stored.serverUrl }).refresh(stored.refreshToken);
      if (started !== generation) return null;
      persist(tokens, stored.serverUrl);
      return tokens.accessToken;
    } catch {
      if (started !== generation) return null;
      clearAuth();
      return null;
    }
  })().finally(() => {
    if (refreshInFlight === pending) refreshInFlight = null;
  });

  refreshInFlight = pending;
  return pending;
}

/** A REST client that refreshes and retries once on 401. */
export function api(): RestClient {
  return new RestClient({
    url: serverUrl(),
    ...(accessToken ? { token: accessToken } : {}),
    onUnauthorized: refreshAccessToken,
  });
}

/** Ensure a usable access token exists, refreshing if necessary. */
export async function ensureAccessToken(): Promise<string | null> {
  if (accessToken) return accessToken;
  return refreshAccessToken();
}
