-- AgentMesh initial schema.
--
-- The `events` table is the source of truth for everything that happens in a
-- session: it is append-only and ordered by a per-session `seq`. The
-- `messages`, `tasks` and `context_entries` tables are projections of that log,
-- kept so the API can answer "what is true now" without a replay.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_color  TEXT NOT NULL DEFAULT '#6366f1',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  owner_id     TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  project_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Cursor for the session event log. Bumped inside the same transaction that
  -- appends the event, which is what makes `seq` gap-free and totally ordered.
  last_seq     BIGINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);
CREATE INDEX sessions_owner_idx ON sessions (owner_id);

CREATE TABLE session_members (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX session_members_user_idx ON session_members (user_id);

CREATE TABLE invites (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- Only the hash is stored; the token itself is shown to its creator once.
  token_hash TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL CHECK (role IN ('member', 'viewer')),
  created_by TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invites_session_idx ON invites (session_id);

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'custom',
  model         TEXT NOT NULL DEFAULT 'unknown',
  machine_id    TEXT,
  capabilities  JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'offline'
                CHECK (status IN ('idle', 'working', 'blocked', 'offline')),
  autonomy      TEXT NOT NULL DEFAULT 'semi'
                CHECK (autonomy IN ('manual', 'semi', 'auto')),
  token_hash    TEXT NOT NULL UNIQUE,
  -- An agent is a delegate of the human who registered it, never an
  -- independent principal. Removing that human removes the agent.
  owner_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_seen_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, name)
);
CREATE INDEX agents_session_idx ON agents (session_id);

CREATE TABLE events (
  id         TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq        BIGINT NOT NULL,
  type       TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id   TEXT,
  actor_name TEXT,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX events_session_type_idx ON events (session_id, type);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent', 'system')),
  author_id   TEXT,
  author_name TEXT,
  body        TEXT NOT NULL,
  mentions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  parent_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_session_seq_idx ON messages (session_id, seq DESC);
CREATE INDEX messages_body_search_idx ON messages USING gin (to_tsvector('simple', body));

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'todo'
                   CHECK (status IN ('todo', 'in_progress', 'blocked', 'review', 'done')),
  creator_type     TEXT NOT NULL,
  creator_id       TEXT,
  creator_name     TEXT,
  assignee_type    TEXT,
  assignee_id      TEXT,
  assignee_name    TEXT,
  related_files    JSONB NOT NULL DEFAULT '[]'::jsonb,
  related_commits  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_session_status_idx ON tasks (session_id, status);
CREATE INDEX tasks_assignee_idx ON tasks (session_id, assignee_id);

CREATE TABLE context_entries (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  -- (session, kind, key) is unique: re-publishing the same contract supersedes
  -- the previous version instead of leaving two contradictory descriptions.
  key             TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  version         INTEGER NOT NULL DEFAULT 1,
  created_by_type TEXT NOT NULL,
  created_by_id   TEXT,
  created_by_name TEXT,
  updated_by_type TEXT NOT NULL,
  updated_by_id   TEXT,
  updated_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, kind, key)
);
CREATE INDEX context_entries_session_kind_idx ON context_entries (session_id, kind);
CREATE INDEX context_entries_search_idx
  ON context_entries USING gin (to_tsvector('simple', title || ' ' || coalesce(body, '')));

CREATE TABLE context_revisions (
  id          TEXT PRIMARY KEY,
  entry_id    TEXT NOT NULL REFERENCES context_entries (id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  author_type TEXT NOT NULL,
  author_id   TEXT,
  author_name TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entry_id, version)
);
