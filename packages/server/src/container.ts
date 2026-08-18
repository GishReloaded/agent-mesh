import type { Config } from './config.js';
import { AccessTokenService } from './auth/tokens.js';
import { createDb, type DbHandle } from './db/client.js';
import { Hub } from './realtime/hub.js';
import { AccessService } from './services/access.js';
import { AgentService } from './services/agents.js';
import { ContextService } from './services/sharedContext.js';
import { DevEventService } from './services/devEvents.js';
import { EventLog } from './services/eventLog.js';
import { InviteService } from './services/invites.js';
import { MessageService } from './services/messages.js';
import { SessionService } from './services/sessions.js';
import { TaskService } from './services/tasks.js';
import { UserService } from './services/users.js';

/**
 * Everything the HTTP and websocket layers need, wired once. Plain constructor
 * injection — a DI framework would add indirection to a graph that fits in one
 * function.
 */
export interface Services {
  config: Config;
  db: DbHandle;
  hub: Hub;
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
}

export function createServices(config: Config, existingDb?: DbHandle): Services {
  const db = existingDb ?? createDb(config);
  const hub = new Hub();
  const log = new EventLog(db.db, hub);
  const accessTokens = new AccessTokenService(config.auth.jwtSecret, config.auth.accessTokenTtl);

  const sessions = new SessionService(db.db, log, hub);

  return {
    config,
    db,
    hub,
    log,
    accessTokens,
    users: new UserService(db.db, accessTokens, config.auth.refreshTokenTtl, config.auth.allowRegistration),
    access: new AccessService(db.db),
    sessions,
    invites: new InviteService(db.db, sessions, config.publicUrl),
    agents: new AgentService(db.db, log, hub),
    messages: new MessageService(db.db, log, config.agentChainLimit),
    tasks: new TaskService(db.db, log),
    context: new ContextService(db.db, log),
    devEvents: new DevEventService(log),
  };
}
