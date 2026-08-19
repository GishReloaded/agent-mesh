import type { ColumnType, Generated } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/**
 * `jsonb` columns: selected as parsed values, written as whatever node-postgres
 * can serialize (it JSON-encodes objects and arrays for us).
 */
type Json<T> = ColumnType<T, unknown, unknown>;

export interface UsersTable {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  avatar_color: Generated<string>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface RefreshTokensTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  replaced_by: string | null;
  user_agent: string | null;
  created_at: Timestamp;
}

export interface SessionsTable {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  owner_id: string;
  project_meta: Json<Record<string, unknown>>;
  last_seq: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
}

export interface SessionMembersTable {
  session_id: string;
  user_id: string;
  role: 'owner' | 'member' | 'viewer';
  joined_at: Timestamp;
}

export interface InvitesTable {
  id: string;
  session_id: string;
  token_hash: string;
  role: 'member' | 'viewer';
  created_by: string;
  expires_at: Timestamp;
  max_uses: Generated<number>;
  uses: Generated<number>;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
}

export interface AgentsTable {
  id: string;
  session_id: string;
  name: string;
  provider: Generated<string>;
  model: Generated<string>;
  machine_id: string | null;
  avatar_color: Generated<string>;
  capabilities: Json<Record<string, boolean>>;
  metadata: Json<Record<string, unknown>>;
  status: Generated<'idle' | 'working' | 'blocked' | 'offline'>;
  autonomy: Generated<'manual' | 'semi' | 'auto'>;
  token_hash: string;
  owner_user_id: string;
  last_seen_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
}

export interface EventsTable {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  actor_type: 'user' | 'agent' | 'system';
  actor_id: string | null;
  actor_name: string | null;
  payload: Json<unknown>;
  created_at: Timestamp;
}

export interface MessagesTable {
  id: string;
  session_id: string;
  seq: number;
  author_type: 'user' | 'agent' | 'system';
  author_id: string | null;
  author_name: string | null;
  body: string;
  mentions: Json<unknown>;
  parent_id: string | null;
  created_at: Timestamp;
}

export interface TasksTable {
  id: string;
  session_id: string;
  title: string;
  description: string | null;
  status: Generated<'todo' | 'in_progress' | 'blocked' | 'review' | 'done'>;
  creator_type: string;
  creator_id: string | null;
  creator_name: string | null;
  assignee_type: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  related_files: Json<unknown>;
  related_commits: Json<unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ContextEntriesTable {
  id: string;
  session_id: string;
  kind: string;
  key: string;
  title: string;
  body: string | null;
  data: Json<Record<string, unknown>>;
  version: Generated<number>;
  created_by_type: string;
  created_by_id: string | null;
  created_by_name: string | null;
  updated_by_type: string;
  updated_by_id: string | null;
  updated_by_name: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ContextRevisionsTable {
  id: string;
  entry_id: string;
  version: number;
  title: string;
  body: string | null;
  data: Json<Record<string, unknown>>;
  author_type: string;
  author_id: string | null;
  author_name: string | null;
  created_at: Timestamp;
}

export interface WsConnectionsTable {
  id: string;
  principal_kind: 'user' | 'agent';
  user_id: string | null;
  agent_id: string | null;
  display_name: string;
  agent_session_id: string | null;
  agent_owner_id: string | null;
  connected_at: Timestamp;
  last_seen_at: Timestamp;
}

export interface WsSubscriptionsTable {
  connection_id: string;
  session_id: string;
  subscribed_at: Timestamp;
}

export interface MigrationsTable {
  name: string;
  applied_at: Timestamp;
}

export interface Database {
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  sessions: SessionsTable;
  session_members: SessionMembersTable;
  invites: InvitesTable;
  agents: AgentsTable;
  events: EventsTable;
  messages: MessagesTable;
  tasks: TasksTable;
  context_entries: ContextEntriesTable;
  context_revisions: ContextRevisionsTable;
  ws_connections: WsConnectionsTable;
  ws_subscriptions: WsSubscriptionsTable;
  _agentmesh_migrations: MigrationsTable;
}

