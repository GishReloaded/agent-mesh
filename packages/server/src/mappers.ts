import type {
  Actor,
  Agent,
  ContextEntry,
  ContextRevision,
  Event,
  Invite,
  Message,
  PublicUser,
  Session,
  SessionMember,
  Task,
  User,
} from '@agentmesh/protocol';
import type { Selectable } from 'kysely';
import type {
  AgentsTable,
  ContextEntriesTable,
  ContextRevisionsTable,
  EventsTable,
  InvitesTable,
  MessagesTable,
  SessionsTable,
  TasksTable,
  UsersTable,
} from './db/types.js';

/** Rows come back as `Date`; the wire format is always ISO-8601 UTC. */
export function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function actor(type: string, id: string | null, name: string | null): Actor {
  return { type: type as Actor['type'], id, name };
}

/** jsonb columns are untyped at runtime; never hand a non-array to callers. */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function toUser(row: Selectable<UsersTable>): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    createdAt: iso(row.created_at),
  };
}

export function toPublicUser(row: Pick<Selectable<UsersTable>, 'id' | 'display_name' | 'avatar_color'>): PublicUser {
  return { id: row.id, displayName: row.display_name, avatarColor: row.avatar_color };
}

export function toSession(row: Selectable<SessionsTable>): Session {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerId: row.owner_id,
    projectMeta: row.project_meta ?? {},
    lastSeq: Number(row.last_seq),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: isoOrNull(row.archived_at),
  };
}

export function toSessionMember(
  row: {
    session_id: string;
    role: string;
    joined_at: Date | string;
    user_id: string;
    display_name: string;
    avatar_color: string;
  },
  online: boolean,
): SessionMember {
  return {
    sessionId: row.session_id,
    user: { id: row.user_id, displayName: row.display_name, avatarColor: row.avatar_color },
    role: row.role as SessionMember['role'],
    joinedAt: iso(row.joined_at),
    online,
  };
}

export function toAgent(row: Selectable<AgentsTable>, online: boolean): Agent {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    machineId: row.machine_id,
    capabilities: row.capabilities ?? {},
    status: online ? row.status : 'offline',
    autonomy: row.autonomy,
    online,
    ownerUserId: row.owner_user_id,
    metadata: row.metadata ?? {},
    lastSeenAt: isoOrNull(row.last_seen_at),
    createdAt: iso(row.created_at),
  };
}

export function toMessage(row: Selectable<MessagesTable>): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: Number(row.seq),
    author: actor(row.author_type, row.author_id, row.author_name),
    body: row.body,
    mentions: asArray<Message['mentions'][number]>(row.mentions),
    parentId: row.parent_id,
    createdAt: iso(row.created_at),
  };
}

export function toEvent(row: Selectable<EventsTable>): Event {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: Number(row.seq),
    type: row.type,
    actor: actor(row.actor_type, row.actor_id, row.actor_name),
    payload: row.payload,
    createdAt: iso(row.created_at),
  };
}

export function toTask(row: Selectable<TasksTable>): Task {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    description: row.description,
    status: row.status,
    creator: actor(row.creator_type, row.creator_id, row.creator_name),
    assignee: row.assignee_type ? actor(row.assignee_type, row.assignee_id, row.assignee_name) : null,
    relatedFiles: asArray<Task['relatedFiles'][number]>(row.related_files),
    relatedCommits: asArray<string>(row.related_commits),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toContextEntry(row: Selectable<ContextEntriesTable>): ContextEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind as ContextEntry['kind'],
    key: row.key,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
    version: row.version,
    createdBy: actor(row.created_by_type, row.created_by_id, row.created_by_name),
    updatedBy: actor(row.updated_by_type, row.updated_by_id, row.updated_by_name),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toContextRevision(row: Selectable<ContextRevisionsTable>): ContextRevision {
  return {
    id: row.id,
    entryId: row.entry_id,
    version: row.version,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
    author: actor(row.author_type, row.author_id, row.author_name),
    createdAt: iso(row.created_at),
  };
}

export function toInvite(row: Selectable<InvitesTable>): Invite {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    createdBy: row.created_by,
    expiresAt: iso(row.expires_at),
    maxUses: row.max_uses,
    uses: row.uses,
    revokedAt: isoOrNull(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}
