-- Connection registry for the serverless deployment.
--
-- On a normal server the open sockets live in one process, so presence is
-- simply "is there a socket". On Lambda the sockets belong to API Gateway and
-- nothing survives between frames, so the same information has to be written
-- down. This table is that registry - and, deliberately, it lives in the
-- database the deployment already has rather than adding another service.
--
-- Unused by the single-process deployment.

CREATE TABLE ws_connections (
  -- API Gateway's connectionId.
  id             TEXT PRIMARY KEY,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'agent')),
  user_id        TEXT REFERENCES users (id) ON DELETE CASCADE,
  agent_id       TEXT REFERENCES agents (id) ON DELETE CASCADE,
  display_name   TEXT NOT NULL,
  -- The agent's session and owner, for agent connections; NULL for users.
  -- Denormalized so restoring a principal needs no join on the hot path.
  agent_session_id TEXT REFERENCES sessions (id) ON DELETE CASCADE,
  agent_owner_id   TEXT REFERENCES users (id) ON DELETE CASCADE,
  connected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Refreshed on every frame. A row older than the idle timeout is stale:
  -- $disconnect is not guaranteed to arrive, so presence cannot rely on it.
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (principal_kind = 'user'  AND user_id  IS NOT NULL) OR
    (principal_kind = 'agent' AND agent_id IS NOT NULL)
  )
);
CREATE INDEX ws_connections_last_seen_idx ON ws_connections (last_seen_at);

CREATE TABLE ws_subscriptions (
  connection_id TEXT NOT NULL REFERENCES ws_connections (id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, session_id)
);
-- The hot path: "who must receive this event".
CREATE INDEX ws_subscriptions_session_idx ON ws_subscriptions (session_id);
