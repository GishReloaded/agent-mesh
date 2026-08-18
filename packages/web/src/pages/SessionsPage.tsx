import type { SessionSummary } from '@agentmesh/sdk';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearAuth, storedUser } from '../lib/auth.js';
import { useMesh } from '../lib/useStore.js';
import { ConnectionBadge } from '../components/Presence.js';

export function SessionsPage() {
  const navigate = useNavigate();
  const { unread, connection } = useMesh();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [inviteToken, setInviteToken] = useState('');

  const load = () => {
    api()
      .listSessions()
      .then(setSessions)
      .catch((caught: Error) => setError(caught.message));
  };

  useEffect(load, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const session = await api().createSession({ name: name.trim() });
      navigate(`/s/${session.id}`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const join = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!inviteToken.trim()) return;
    try {
      const detail = await api().acceptInvite(inviteToken.trim().replace(/^.*\/invite\//, ''));
      navigate(`/s/${detail.session.id}`);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">AgentMesh</span>
        <span className="spacer" />
        <ConnectionBadge state={connection} />
        <span style={{ color: 'var(--text-dim)' }}>{storedUser()?.displayName}</span>
        <button
          className="ghost"
          onClick={() => {
            clearAuth();
            navigate('/login');
          }}
        >
          Sign out
        </button>
      </header>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="ghost" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <div style={{ padding: '16px 20px 0', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <form className="row" onSubmit={create}>
          <input
            value={name}
            placeholder="New session name"
            onChange={(event) => setName(event.target.value)}
            style={{ minWidth: 220 }}
          />
          <button className="primary" type="submit" disabled={creating || !name.trim()}>
            Create session
          </button>
        </form>

        <form className="row" onSubmit={join}>
          <input
            value={inviteToken}
            placeholder="Invite token or link"
            onChange={(event) => setInviteToken(event.target.value)}
            style={{ minWidth: 220 }}
          />
          <button type="submit" disabled={!inviteToken.trim()}>
            Join
          </button>
        </form>
      </div>

      {sessions.length === 0 ? (
        <div className="empty">
          No sessions yet. Create one, or join with an invite token from a teammate.
        </div>
      ) : (
        <div className="sessions-grid">
          {sessions.map((session) => (
            <button key={session.id} className="session-card" onClick={() => navigate(`/s/${session.id}`)}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{session.name}</strong>
                {(unread[session.id] ?? 0) > 0 && <span className="unread">{unread[session.id]}</span>}
              </div>
              <div className="sub" style={{ color: 'var(--text-dim)' }}>
                {session.description || session.slug}
              </div>
              <div className="sub" style={{ color: 'var(--text-dim)', marginTop: 8 }}>
                {session.memberCount} people - {session.agentCount} agents - {session.onlineCount} online
              </div>
              <div className="badge" style={{ marginTop: 8, display: 'inline-block' }}>
                {session.role}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
