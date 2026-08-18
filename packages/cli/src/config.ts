import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CliProfile {
  url: string;
  accessToken?: string;
  refreshToken?: string;
  userId?: string;
  displayName?: string;
  /** Session the CLI acts on when `--session` is not given. */
  currentSession?: string;
  /** Agent tokens keyed by `sessionId:agentName`, for `agentmesh agent connect`. */
  agentTokens?: Record<string, string>;
}

export interface CliConfig {
  profile: string;
  profiles: Record<string, CliProfile>;
}

const DEFAULT_URL = process.env.AGENTMESH_URL ?? 'http://localhost:4000';

export function configPath(): string {
  const override = process.env.AGENTMESH_CONFIG;
  if (override) return override;
  return join(process.env.AGENTMESH_HOME ?? join(homedir(), '.agentmesh'), 'config.json');
}

export function loadConfig(): CliConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { profile: 'default', profiles: { default: { url: DEFAULT_URL } } };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CliConfig;
    if (!parsed.profiles?.[parsed.profile]) {
      return { profile: 'default', profiles: { default: { url: DEFAULT_URL }, ...parsed.profiles } };
    }
    return parsed;
  } catch {
    return { profile: 'default', profiles: { default: { url: DEFAULT_URL } } };
  }
}

/**
 * The config file holds refresh and agent tokens, so it is written with
 * owner-only permissions. On Windows `chmod` is a no-op and the file inherits
 * the user profile's ACL, which is the equivalent protection.
 */
export function saveConfig(config: CliConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not all filesystems support it; the write above already restricts mode.
  }
}

export function currentProfile(config: CliConfig): CliProfile {
  return config.profiles[config.profile] ?? { url: DEFAULT_URL };
}

export function updateProfile(patch: Partial<CliProfile>): CliConfig {
  const config = loadConfig();
  const profile = { ...currentProfile(config), ...patch };
  config.profiles[config.profile] = profile;
  saveConfig(config);
  return config;
}
