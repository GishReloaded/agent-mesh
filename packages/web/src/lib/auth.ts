import { RestClient, type AuthTokens, type User } from '@agentmesh/sdk';

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

export function isAuthenticated(): boolean {
  return read() !== null;
}

export function persist(tokens: AuthTokens, url = serverUrl()): void {
  accessToken = tokens.accessToken;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ serverUrl: url, refreshToken: tokens.refreshToken, user: tokens.user } satisfies StoredAuth),
  );
}

export function clearAuth(): void {
  accessToken = undefined;
  localStorage.removeItem(STORAGE_KEY);
}

export function currentAccessToken(): string | undefined {
  return accessToken;
}

/** Exchange the stored refresh token for a fresh access token. */
export async function refreshAccessToken(): Promise<string | null> {
  const stored = read();
  if (!stored) return null;
  try {
    const tokens = await new RestClient({ url: stored.serverUrl }).refresh(stored.refreshToken);
    persist(tokens, stored.serverUrl);
    return tokens.accessToken;
  } catch {
    clearAuth();
    return null;
  }
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
