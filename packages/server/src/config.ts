import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Configuration is read from the environment once, validated, and then treated
 * as immutable. Anything security-relevant fails loudly in production rather
 * than falling back to a development default.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  // 0 is allowed and means "let the OS pick a free port", which is how tests
  // and some container setups bind.
  PORT: z.coerce.number().int().min(0).max(65_535).default(4000),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /** Signing key for access tokens. Must be set outside development. */
  JWT_SECRET: z.string().min(32).optional(),

  /**
   * Access token lifetime, in seconds.
   *
   * Access tokens are verified without a database lookup, which is what makes
   * them fast and also what makes them impossible to revoke early: a signed-out
   * user, a removed member and a disabled account all keep working until their
   * token expires. That is the whole cost of raising this. An hour is a
   * reasonable balance; a month would mean a month of un-revokable access.
   *
   * Staying signed in is the refresh token's job, not this one - see
   * REFRESH_TOKEN_TTL, which defaults to 30 days.
   */
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(60 * 60),
  REFRESH_TOKEN_TTL: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),

  /**
   * Seconds during which re-presenting a just-rotated refresh token is treated
   * as a race rather than a leak. Two browser tabs cannot coordinate their
   * refreshes, and revoking the account over that is a worse outcome than a
   * brief window in which a replayed token still works.
   */
  REFRESH_REUSE_GRACE: z.coerce.number().int().nonnegative().max(300).default(20),

  /** Comma-separated list of allowed browser origins, or `*` in development. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /** Public base URL, used to build invite links. */
  PUBLIC_URL: z.string().default('http://localhost:4000'),

  /**
   * Directory holding the built web client. When present the server serves the
   * UI and the API from one origin, so a self-hosted AgentMesh is a single
   * process on a single port with no CORS setup. Empty disables it.
   */
  WEB_DIST: z.string().optional(),

  /**
   * Public WebSocket endpoint, when it is not `/ws` on this origin. Advertised
   * through `GET /version` so clients do not have to guess.
   */
  REALTIME_URL: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Set to `false` to close registration on a private deployment. */
  ALLOW_REGISTRATION: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  /** Frames per second a single websocket connection may send. */
  WS_RATE_LIMIT: z.coerce.number().int().positive().default(20),

  /**
   * How many agent-authored messages may address other agents within
   * AGENT_CHAIN_WINDOW seconds before the server requires a human turn.
   * Any message from a person resets the count. See docs/PROTOCOL.md.
   */
  AGENT_CHAIN_LIMIT: z.coerce.number().int().positive().max(500).default(10),
  AGENT_CHAIN_WINDOW: z.coerce.number().int().positive().max(86_400).default(300),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  host: string;
  port: number;
  database: { url: string; poolMax: number; ssl: boolean };
  auth: {
    jwtSecret: string;
    accessTokenTtl: number;
    refreshTokenTtl: number;
    refreshReuseGraceMs: number;
    allowRegistration: boolean;
  };
  corsOrigins: string[] | true;
  publicUrl: string;
  /** Absolute path to the built web client, or null when not serving it. */
  webDist: string | null;
  /** Public WebSocket endpoint, or null when it is `/ws` on this origin. */
  realtimeUrl: string | null;
  logLevel: Env['LOG_LEVEL'];
  rateLimit: { max: number; window: string; wsFramesPerSecond: number };
  agentChainLimit: number;
  agentChainWindowMs: number;
}

/**
 * Find the built web client. An explicit `WEB_DIST` wins; otherwise the usual
 * monorepo and container layouts are probed, so `npm start` and `docker run`
 * both serve the UI without extra configuration. Set `WEB_DIST=none` to run
 * headless (API only).
 */
function resolveWebDist(configured: string | undefined): string | null {
  // Only an explicit "none" disables the UI. An empty value means "unset",
  // which is what `.env.example` ships and what auto-detection expects.
  if (configured === 'none') return null;
  if (configured) {
    const path = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
    return existsSync(join(path, 'index.html')) ? path : null;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'web', 'dist'), // packages/server/dist -> packages/web/dist
    resolve(here, '..', '..', '..', 'web', 'dist'), // packages/server/src/x -> packages/web/dist
    resolve(process.cwd(), 'packages', 'web', 'dist'),
    resolve(process.cwd(), 'web'),
  ];
  return candidates.find((path) => existsSync(join(path, 'index.html'))) ?? null;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction && !env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production. Generate one with: openssl rand -hex 32');
  }

  const corsOrigins =
    env.CORS_ORIGINS.trim() === '*'
      ? true
      : env.CORS_ORIGINS.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean);

  if (isProduction && corsOrigins === true) {
    throw new Error('CORS_ORIGINS must list explicit origins in production.');
  }

  return {
    env: env.NODE_ENV,
    isProduction,
    host: env.HOST,
    port: env.PORT,
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX, ssl: env.DATABASE_SSL },
    auth: {
      // Outside production an ephemeral secret is fine: it only means tokens do
      // not survive a restart, which is the correct default for a dev machine.
      jwtSecret: env.JWT_SECRET ?? randomBytes(32).toString('hex'),
      accessTokenTtl: env.ACCESS_TOKEN_TTL,
      refreshTokenTtl: env.REFRESH_TOKEN_TTL,
      refreshReuseGraceMs: env.REFRESH_REUSE_GRACE * 1000,
      allowRegistration: env.ALLOW_REGISTRATION,
    },
    corsOrigins,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ''),
    webDist: resolveWebDist(env.WEB_DIST),
    realtimeUrl: env.REALTIME_URL?.trim() ? env.REALTIME_URL.trim() : null,
    logLevel: env.LOG_LEVEL,
    rateLimit: { max: env.RATE_LIMIT_MAX, window: env.RATE_LIMIT_WINDOW, wsFramesPerSecond: env.WS_RATE_LIMIT },
    agentChainLimit: env.AGENT_CHAIN_LIMIT,
    agentChainWindowMs: env.AGENT_CHAIN_WINDOW * 1000,
  };
}
