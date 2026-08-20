import type { SearchResponse, Task } from '@agentmesh/sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Composer, type ComposerHandle } from '../components/Composer.js';
import { CodexAgentSettings, deriveCodexView } from '../components/CodexPanel.js';
import { ContextPanel } from '../components/ContextPanel.js';
import { MessageList } from '../components/Messages.js';
import { ConnectionBadge, ParticipantList } from '../components/Presence.js';
import { api } from '../lib/auth.js';
import { store, useMesh } from '../lib/useStore.js';

export function SessionPage() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const state = useMesh();
  const composer = useRef<ComposerHandle | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [showInvite, setShowInvite] = useState<string | null>(null);

  useEffect(() => {
    void store.openSession(sessionId);
    return () => store.closeSession();
  }, [sessionId]);

  const view = state.view;
  const readOnly = view.session === null || view.session.archivedAt !== null;
  const codexView = useMemo(() => deriveCodexView(view.context, view.events), [view.context, view.events]);

  const canControlCodexAgent = (agentId: string) => {
    if (readOnly || state.connection !== 'connected' || state.identity?.kind !== 'user') return false;
    const agent = view.agents.find((candidate) => candidate.id === agentId);
    return Boolean(agent?.online && (view.session?.ownerId === state.identity.userId || agent.ownerUserId === state.identity.userId));
  };

  // Message authors carry only an id; their colour lives on the participant
  // list, which is already in memory and updates as people join.
  const colorOf = useMemo(() => {
    const byId = new Map<string, string>();
    for (const member of view.members) byId.set(member.user.id, member.user.avatarColor);
    for (const agent of view.agents) byId.set(agent.id, agent.avatarColor);
    return (author: { id: string | null }) => (author.id ? (byId.get(author.id) ?? null) : null);
  }, [view.members, view.agents]);

  const avatarOf = useMemo(() => {
    const byId = new Map<string, string>();
    for (const member of view.members) {
      if (member.user.avatarUrl) byId.set(member.user.id, member.user.avatarUrl);
    }
    return (author: { id: string | null }) => (author.id ? (byId.get(author.id) ?? null) : null);
  }, [view.members]);

  const runSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!search.trim()) {
      setResults(null);
      return;
    }
    setResults(await api().search(sessionId, search.trim()));
  };

  const createInvite = async () => {
    const invite = await api().createInvite(sessionId, { role: 'member' });
    setShowInvite(invite.token);
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="ghost" onClick={() => navigate('/')}>
          &lsaquo; Sessions
        </button>
        <span className="brand">{view.session?.name ?? 'Loading...'}</span>
        <form onSubmit={runSearch} className="row" style={{ marginLeft: 16 }}>
          <input
            value={search}
            placeholder="Search messages, tasks, context"
            onChange={(event) => setSearch(event.target.value)}
            style={{ width: 260 }}
          />
        </form>
        <span className="spacer" />
        <button className="ghost" onClick={() => void createInvite()}>
          Invite
        </button>
        <ConnectionBadge state={state.connection} />
      </header>

      {showInvite && (
        <div className="error-banner" style={{ borderColor: 'var(--accent)', color: 'var(--text)' }}>
          <span>
            Invite token (shown once): <code>{showInvite}</code>
          </span>
          <button className="ghost" onClick={() => setShowInvite(null)}>
            done
          </button>
        </div>
      )}

      {state.error && (
        <div className="error-banner">
          <span>{state.error}</span>
          <button className="ghost" onClick={() => store.clearError()}>
            dismiss
          </button>
        </div>
      )}

      {results && (
        <div className="search-results">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>Search results</strong>
            <button className="ghost" onClick={() => setResults(null)}>
              close
            </button>
          </div>
          <div className="panel-title">Messages ({results.messages.length})</div>
          {results.messages.map((message) => (
            <div key={message.id} className="sub">
              <strong>{message.author.name}</strong>: {message.body.slice(0, 160)}
            </div>
          ))}
          <div className="panel-title">Tasks ({results.tasks.length})</div>
          {results.tasks.map((task) => (
            <div key={task.id} className="sub">
              [{task.status}] {task.title}
            </div>
          ))}
          <div className="panel-title">Context ({results.context.length})</div>
          {results.context.map((entry) => (
            <div key={entry.id} className="sub">
              {entry.kind}:{entry.key} - {entry.title}
            </div>
          ))}
        </div>
      )}

      <div className="session-layout">
        <div className="panel panel-left">
          <ParticipantList
            members={view.members}
            agents={view.agents}
            onMention={(name) => composer.current?.insertMention(name)}
          />
        </div>

        <div className="panel">
          <CodexAgentSettings
            view={codexView}
            agents={view.agents}
            identity={state.identity}
            session={view.session}
            disabled={readOnly || state.connection !== 'connected'}
            onControl={async (payload) => {
              await store.realtime?.controlCodex(sessionId, payload);
            }}
          />
          <MessageList
            messages={view.messages}
            events={view.events}
            identity={state.identity}
            hasMore={view.hasMoreMessages}
            onLoadMore={() => void store.loadOlderMessages()}
            colorOf={colorOf}
            avatarOf={avatarOf}
            canApproveCodex={canControlCodexAgent}
            onCodexApproval={async (payload) => {
              await store.realtime?.respondToCodexApproval(sessionId, payload);
            }}
          />
          {state.typing.length > 0 && (
            <div style={{ padding: '0 16px 6px', color: 'var(--text-dim)', fontSize: 12 }}>
              {state.typing.map((entry) => entry.name).join(', ')} typing...
            </div>
          )}
          <Composer
            members={view.members}
            agents={view.agents}
            disabled={readOnly || state.connection !== 'connected'}
            registerHandle={(handle) => {
              composer.current = handle;
            }}
            onTyping={(active) => store.realtime?.setTyping(sessionId, active)}
            onSend={async (body) => {
              await store.realtime?.sendMessage(sessionId, body);
            }}
          />
        </div>

        <ContextPanel
          tasks={view.tasks}
          context={view.context}
          events={view.events}
          onCreateTask={async (title) => {
            await store.realtime?.createTask(sessionId, { title });
          }}
          onUpdateTaskStatus={async (taskId: string, status: Task['status']) => {
            await store.realtime?.updateTask(sessionId, taskId, { status });
          }}
        />
      </div>
    </div>
  );
}
