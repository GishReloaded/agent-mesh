import type { Config } from './config.js';
import { AccessTokenService } from './auth/tokens.js';
import { createDb, type DbHandle } from './db/client.js';
import { Hub } from './realtime/hub.js';
import type { ConnectionRegistry, EventSink } from './realtime/registry.js';
import { AccessService } from './services/access.js';
import { AgentService } from './services/agents.js';
import { ContextService } from './services/sharedContext.js';
import { DevEventService } from './services/devEvents.js';
import { EventLog } from './services/eventLog.js';
import { InviteService } from './services/invites.js';
import { ProfileService } from './services/profile.js';
import { LocalAvatarStore, defaultAvatarDir, type AvatarStore } from './storage/avatars.js';
import { S3AvatarStore } from './storage/s3Avatars.js';
import { MessageService } from './services/messages.js';
import { SessionService } from './services/sessions.js';
import { TaskService } from './services/tasks.js';
import { UserService } from './services/users.js';

/**
 * Everything the HTTP and websocket layers need, wired once. Plain constructor
 * injection - a DI framework would add indirection to a graph that fits in one
 * function.
 */
export interface Services {
  config: Config;
  db: DbHandle;
  /** Where live connections and presence live. In-process, or in PostgreSQL. */
  registry: ConnectionRegistry;
  log: EventLog;
  accessTokens: AccessTokenService;
  users: UserService;
  access: AccessService;
  sessions: SessionService;
  invites: InviteService;
  agents: AgentService;
  messages: MessageService;
  tasks: TaskService;
  context: ContextService;
  devEvents: DevEventService;
  profile: ProfileService;
  avatars: AvatarStore;
}

export interface ServiceOverrides {
  /** Reuse an already-built graph, so one process has exactly one of each. */
  services?: Services;
  db?: DbHandle;
  /**
   * Connection registry and event sink. The single-process server uses the
   * in-memory `Hub`; the serverless deployment injects a PostgreSQL-backed
   * registry that fans out through the API Gateway management API.
   */
  registry?: ConnectionRegistry & EventSink;
  avatars?: AvatarStore;
}

export function createServices(config: Config, overrides: ServiceOverrides = {}): Services {
  if (overrides.services) return overrides.services;
  const db = overrides.db ?? createDb(config);
  const registry = overrides.registry ?? new Hub();
  const log = new EventLog(db.db, registry);
  const accessTokens = new AccessTokenService(config.auth.jwtSecret, config.auth.accessTokenTtl);

  const sessions = new SessionService(db.db, log, registry);

  // A bucket where one is configured, a directory otherwise: the same split
  // the connection registry makes between the two deployments.
  const avatars =
    overrides.avatars ??
    (config.avatars.bucket
      ? new S3AvatarStore(config.avatars.bucket)
      : new LocalAvatarStore(config.avatars.dir ?? defaultAvatarDir()));

  return {
    config,
    db,
    registry,
    log,
    accessTokens,
    users: new UserService(
      db.db,
      accessTokens,
      config.auth.refreshTokenTtl,
      config.auth.allowRegistration,
      config.auth.refreshReuseGraceMs,
    ),
    access: new AccessService(db.db),
    sessions,
    invites: new InviteService(db.db, sessions, config.publicUrl),
    agents: new AgentService(db.db, log, registry),
    messages: new MessageService(db.db, log, config.agentChainLimit, config.agentChainWindowMs),
    tasks: new TaskService(db.db, log),
    context: new ContextService(db.db, log),
    devEvents: new DevEventService(db.db, log),
    profile: new ProfileService(db.db, log, avatars),
    avatars,
  };
}
