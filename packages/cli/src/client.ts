import { TandryxError, ErrorCode, RestClient } from '@gish_reloaded/tandryx-sdk';
import { currentProfile, loadConfig, updateProfile, type CliProfile } from './config.js';

export interface CliContext {
  profile: CliProfile;
  rest: RestClient;
}

/**
 * Build a REST client from the stored profile, with transparent token refresh:
 * a 15-minute access token would otherwise expire between two CLI invocations
 * and force a re-login for no reason.
 */
export function createContext(options: { url?: string; token?: string } = {}): CliContext {
  const config = loadConfig();
  const profile = currentProfile(config);
  const url = options.url ?? process.env.TANDRYX_URL ?? profile.url;
  const token = options.token ?? process.env.TANDRYX_TOKEN ?? profile.accessToken;

  const rest = new RestClient({
    url,
    ...(token ? { token } : {}),
    onUnauthorized: async () => {
      const refreshToken = profile.refreshToken;
      if (!refreshToken) return null;
      try {
        const tokens = await new RestClient({ url }).refresh(refreshToken);
        updateProfile({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          userId: tokens.user.id,
          displayName: tokens.user.displayName,
        });
        return tokens.accessToken;
      } catch {
        return null;
      }
    },
  });

  return { profile: { ...profile, url }, rest };
}

/** Resolve the session to act on: `--session`, env, or the stored default. */
export function resolveSession(explicit?: string): string {
  const profile = currentProfile(loadConfig());
  const sessionId = explicit ?? process.env.TANDRYX_SESSION ?? profile.currentSession;
  if (!sessionId) {
    throw new TandryxError(
      ErrorCode.ValidationFailed,
      'No session selected. Pass --session <id>, or run: tandryx session use <id>',
    );
  }
  return sessionId;
}

export function requireAuth(context: CliContext): void {
  if (!context.profile.accessToken && !process.env.TANDRYX_TOKEN) {
    throw new TandryxError(ErrorCode.Unauthorized, 'Not logged in. Run: tandryx login');
  }
}
