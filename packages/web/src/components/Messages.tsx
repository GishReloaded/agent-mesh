import {
  mentionsActor,
  type CodexApprovalResponse,
  type Event as MeshEvent,
  type Identity,
  type Message,
} from '@agentmesh/sdk';
import { useEffect, useRef } from 'react';
import { participantColor } from '../lib/colors.js';
import { localFileHref, renderMarkdown } from '../lib/markdown.js';
import { Avatar } from './Presence.js';

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A message carries only who wrote it, not what they look like. Colours come
 * from the session's participant list, which the client already has.
 */
export type ColorLookup = (author: Message['author']) => string | null;

/** A Session has one timeline. Codex thread ids correlate activity but never split the room. */
export function selectTimelineEvents(events: MeshEvent[], _codexThreadId: string | null = null): MeshEvent[] {
  const latestTechnicalItem = new Map<string, string>();
  const singleFileDiffs = new Map<string, string>();
  const enrichedEvents = events.map((event) => {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === 'CODEX_ACTIVITY' && payload.itemId && !['reasoningSummary', 'message'].includes(String(payload.kind))) {
      latestTechnicalItem.set(`${String(payload.threadId)}:${String(payload.turnId)}:${String(payload.itemId)}:${String(payload.kind)}`, event.id);
    }

    const files = Array.isArray(payload.files) ? payload.files.map(String) : [];
    if (
      event.type === 'CODEX_ACTIVITY' &&
      payload.kind === 'fileChange' &&
      files.length === 1 &&
      typeof payload.diff === 'string' &&
      payload.diff
    ) {
      singleFileDiffs.set(
        [payload.agentId, payload.threadId, payload.turnId, files[0]].map(String).join('\0'),
        payload.diff,
      );
    }

    if (event.type !== 'CODEX_ACTIVITY' || payload.kind !== 'turnSummary') return event;
    const stats = Array.isArray(payload.fileStats)
      ? payload.fileStats.map(asObject)
      : files.length === 1
        ? [{ path: files[0], additions: Number(payload.additions ?? 0), deletions: Number(payload.deletions ?? 0) }]
        : [];
    let addedHistoricalDiff = false;
    const fileStats = stats.map((stat) => {
      if (typeof stat.diff === 'string' && stat.diff) return stat;
      const path = String(stat.path ?? '');
      const diff = singleFileDiffs.get(
        [payload.agentId, payload.threadId, payload.turnId, path].map(String).join('\0'),
      );
      if (!diff) return stat;
      addedHistoricalDiff = true;
      return { ...stat, diff };
    });
    return addedHistoricalDiff ? { ...event, payload: { ...payload, fileStats } } : event;
  });

  return enrichedEvents.filter((event) => {
    const payload = event.payload as Record<string, unknown>;
    // Presence and the settings rail already expose routine runtime state.
    // Repeating it in the conversation obscures useful activity and replies.
    if (
      event.type === 'CODEX_THREAD_STATE' &&
      ['starting', 'working', 'idle'].includes(String(payload.status ?? '')) &&
      !payload.error
    ) return false;
    if (
      event.type === 'CODEX_ACTIVITY' &&
      payload.kind === 'status' &&
      ['inProgress', 'completed', 'working', 'idle'].includes(String(payload.status ?? ''))
    ) return false;
    // Older runners published the final App Server agentMessage both as an
    // activity and as a normal chat reply. Keep historical timelines singular.
    if (event.type === 'CODEX_ACTIVITY' && payload.kind === 'message') return false;
    if (
      event.type === 'CODEX_ACTIVITY' &&
      (payload.kind === 'reasoningSummary' || payload.kind === 'message') &&
      String(payload.summary ?? '').trim() === ''
    ) return false;
    if (event.type === 'CODEX_ACTIVITY' && payload.itemId && !['reasoningSummary', 'message'].includes(String(payload.kind))) {
      const key = `${String(payload.threadId)}:${String(payload.turnId)}:${String(payload.itemId)}:${String(payload.kind)}`;
      if (latestTechnicalItem.get(key) !== event.id) return false;
    }
    return true;
  });
}

function isAddressedTo(message: Message, identity: Identity | null): boolean {
  if (!identity) return false;
  const me =
    identity.kind === 'agent'
      ? { type: 'agent' as const, id: identity.agentId }
      : { type: 'user' as const, id: identity.userId };
  return mentionsActor(message.mentions, me);
}


export function MessageList({
  messages,
  events,
  identity,
  hasMore,
  onLoadMore,
  colorOf,
  onCodexApproval,
  canApproveCodex = () => false,
}: {
  messages: Message[];
  events: MeshEvent[];
  identity: Identity | null;
  hasMore: boolean;
  onLoadMore: () => void;
  colorOf: ColorLookup;
  onCodexApproval?: (payload: CodexApprovalResponse) => Promise<void>;
  canApproveCodex?: (agentId: string) => boolean;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const inlineEvents = selectTimelineEvents(events);
  const visibleMessages = messages;
  const answeredApprovals = new Set(
    events
      .filter((event) => event.type === 'CODEX_APPROVAL_RESPONSE')
      .map((event) => String((event.payload as Record<string, unknown>).requestId ?? '')),
  );

  useEffect(() => {
    // Only auto-scroll when the reader is already at the bottom; yanking the
    // viewport away from someone reading history is worse than a missed scroll.
    if (stickToBottom.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [visibleMessages.length, inlineEvents.length]);

  const merged = [...visibleMessages.map((m) => ({ seq: m.seq, message: m }) as const), ...inlineEvents.map((e) => ({ seq: e.seq, event: e }) as const)].sort(
    (a, b) => a.seq - b.seq,
  );

  return (
    <div
      className="messages"
      ref={container}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {hasMore && (
        <button className="ghost" onClick={onLoadMore}>
          Load earlier messages
        </button>
      )}

      {merged.length === 0 && (
        <div className="empty">
          Nothing here yet. Say hello, or address an agent with <code>@name</code>.
        </div>
      )}

      {merged.map((item) =>
        'message' in item ? (
          <MessageRow
            key={item.message.id}
            message={item.message}
            mentioned={isAddressedTo(item.message, identity)}
            color={colorOf(item.message.author)}
          />
        ) : (
          <EventRow
            key={item.event.id}
            event={item.event}
            approvalAnswered={answeredApprovals.has(String((item.event.payload as Record<string, unknown>).requestId ?? ''))}
            onCodexApproval={onCodexApproval}
            canApproveCodex={canApproveCodex}
          />
        ),
      )}
      <div ref={bottom} />
    </div>
  );
}

function MessageRow({
  message,
  mentioned,
  color,
}: {
  message: Message;
  mentioned: boolean;
  color: string | null;
}) {
  const palette = participantColor(color);
  return (
    <div className={`message ${message.author.type}${mentioned ? ' mentioned' : ''}`}>
      <Avatar
        name={message.author.name ?? '?'}
        color={color ?? ''}
        kind={message.author.type as 'user' | 'agent' | 'system'}
      />
      <div>
        <div className="head">
          <span className="author" style={{ color: palette.text }}>
            {message.author.name ?? 'unknown'}
          </span>
          {message.author.type === 'agent' && <span className="badge">agent</span>}
          <span className="time">{time(message.createdAt)}</span>
        </div>
        <div className="body md">{renderMarkdown(message.body)}</div>
      </div>
    </div>
  );
}

/** Development events appear inline so the conversation keeps its context. */
function EventRow({
  event,
  approvalAnswered,
  onCodexApproval,
  canApproveCodex,
}: {
  event: MeshEvent;
  approvalAnswered: boolean;
  onCodexApproval?: (payload: CodexApprovalResponse) => Promise<void>;
  canApproveCodex: (agentId: string) => boolean;
}) {
  const payload = event.payload as Record<string, unknown>;
  const summary = describe(event.type, payload);

  if (event.type === 'CODEX_CONTROL_REQUEST' && payload.action === 'startTurn') {
    const author = event.actor.name ?? 'user';
    return (
      <div className="message user codex-user-message">
        <Avatar name={author} color="" kind="user" />
        <div>
          <div className="head">
            <span className="author">{author}</span>
            <span className="time">{time(event.createdAt)}</span>
          </div>
          <div className="body md">{renderMarkdown(String(payload.prompt ?? ''))}</div>
        </div>
      </div>
    );
  }

  if (event.type === 'CODEX_ACTIVITY') {
    const kind = String(payload.kind ?? 'activity');
    if (kind === 'reasoningSummary' || kind === 'message') {
      const text = String(payload.summary ?? '').trim();
      if (!text) return null;
      const author = event.actor.name ?? 'GPT';
      return (
        <div className="message agent codex-agent-message">
          <Avatar name={author} color="" kind="agent" />
          <div>
            <div className="head">
              <span className="author">{author}</span>
              <span className="badge">agent</span>
              {kind === 'reasoningSummary' && <span className="codex-reasoning-label">summary</span>}
              <span className="time">{time(event.createdAt)}</span>
            </div>
            <div className="body md">{renderMarkdown(text)}</div>
          </div>
        </div>
      );
    }

    if (kind === 'command') {
      const command = String(payload.command ?? '').trim();
      const output = String(payload.output ?? '').trim();
      return (
        <details className="codex-technical-event codex-command-card">
          <summary>
            <span className="codex-tech-icon" aria-hidden="true">›_</span>
            <span className="type">{payload.status === 'completed' ? 'Ran command' : 'Running command'}</span>
            <code className="codex-command-preview">{command}</code>
            <span className="codex-tech-meta">{commandMeta(payload)}</span>
          </summary>
          <div className="codex-terminal">
            {typeof payload.cwd === 'string' && <div className="codex-terminal-cwd">{payload.cwd}</div>}
            <div className="codex-terminal-command">$ {command}</div>
            {output && <pre>{output}</pre>}
          </div>
        </details>
      );
    }

    if (kind === 'fileChange') {
      const files = Array.isArray(payload.files) ? payload.files.map(String) : [];
      return (
        <details className="codex-technical-event codex-file-card">
          <summary>
            <span className="codex-tech-icon" aria-hidden="true">±</span>
            <span className="type">Changed {files.length || ''} {files.length === 1 ? 'file' : 'files'}</span>
            <span className="codex-technical-summary">{files[0] ?? String(payload.status ?? '')}</span>
          </summary>
          <div className="codex-technical-detail">
            {files.map((file) => <LocalFileLink path={file} key={file} />)}
            {typeof payload.diff === 'string' && payload.diff && <DiffPreview diff={payload.diff} />}
          </div>
        </details>
      );
    }

    if (kind === 'turnSummary') {
      const files = Array.isArray(payload.files) ? payload.files.map(String) : [];
      const fileStats = Array.isArray(payload.fileStats)
        ? payload.fileStats.map(asObject).flatMap((stat) => {
            const path = String(stat.path ?? '');
            const diff = typeof stat.diff === 'string' ? stat.diff : '';
            return path ? [{ path, additions: Number(stat.additions ?? 0), deletions: Number(stat.deletions ?? 0), diff }] : [];
          })
        : files.map((path) => ({
            path,
            additions: files.length === 1 ? Number(payload.additions ?? 0) : null,
            deletions: files.length === 1 ? Number(payload.deletions ?? 0) : null,
            diff: '',
          }));
      return (
        <div className="codex-technical-event codex-turn-summary">
          <div className="codex-turn-summary-head">
            <span className="codex-tech-icon" aria-hidden="true">±</span>
            <span className="type">Changed {fileStats.length} {fileStats.length === 1 ? 'file' : 'files'}</span>
          </div>
          <div className="codex-turn-summary-files">
            {fileStats.map((file) => file.diff ? (
              <details className="codex-file-stat" key={file.path}>
                <summary className="codex-file-stat-head">
                  <span className="codex-file-link">{file.path}</span>
                  {file.additions !== null && <span className="codex-change-additions">+{file.additions}</span>}
                  {file.deletions !== null && <span className="codex-change-deletions">−{file.deletions}</span>}
                </summary>
                <DiffPreview diff={file.diff} />
              </details>
            ) : (
              <div className="codex-file-stat" key={file.path}>
                <div className="codex-file-stat-head codex-file-stat-static">
                  <span className="codex-file-link">{file.path}</span>
                  {file.additions !== null && <span className="codex-change-additions">+{file.additions}</span>}
                  {file.deletions !== null && <span className="codex-change-deletions">−{file.deletions}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (kind === 'contextCompaction') {
      return (
        <div className="codex-technical-event codex-context-compaction">
          <span className="codex-tech-icon" aria-hidden="true">↻</span>
          <span className="type">Context compacted</span>
          <span>Codex compressed earlier conversation history and continued.</span>
        </div>
      );
    }

    return (
      <details className={`codex-technical-event kind-${kind}`}>
        <summary>
          <span className="time">{time(event.createdAt)}</span>
          <span className="type">{codexKindLabel(kind)}</span>
          {summary && <span className="codex-technical-summary">{summary}</span>}
        </summary>
        <div className="codex-technical-detail">
          {Array.isArray(payload.files) && payload.files.map(String).map((file) => <div className="sub" key={file}>{file}</div>)}
          {typeof payload.diff === 'string' && payload.diff && <pre className="codex-diff">{payload.diff}</pre>}
        </div>
      </details>
    );
  }

  if (event.type === 'CODEX_APPROVAL_REQUEST') {
    const agentId = String(payload.agentId ?? '');
    const decisions = Array.isArray(payload.availableDecisions) ? payload.availableDecisions.map(String) : ['decline'];
    return (
      <div className="codex-chat-event codex-approval">
        <div className="codex-event-head">
          <span className="type">Approval · {String(payload.kind ?? 'operation')}</span>
          <span className="time">{time(event.createdAt)}</span>
        </div>
        {summary && <div className="codex-event-detail">{summary}</div>}
        {typeof payload.cwd === 'string' && <div className="sub">cwd: {payload.cwd}</div>}
        {Array.isArray(payload.files) && payload.files.map(String).map((file) => <div className="sub" key={file}>{file}</div>)}
        {approvalAnswered ? (
          <div className="sub">Answered</div>
        ) : (
          <div className="row codex-approval-actions">
            {decisions.map((decision) => (
              <button
                key={decision}
                disabled={!onCodexApproval || !canApproveCodex(agentId)}
                className={decision.startsWith('accept') ? '' : 'ghost'}
                onClick={() => void onCodexApproval?.({
                  requestId: String(payload.requestId ?? ''),
                  agentId,
                  threadId: String(payload.threadId ?? ''),
                  decision: decision as CodexApprovalResponse['decision'],
                })}
              >
                {decision}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (event.type === 'CODEX_THREAD_STATE' || event.type === 'CODEX_APPROVAL_RESPONSE' || event.type === 'CODEX_CONTROL_REQUEST') {
    return (
      <div className="system-event codex-system-event">
        <span className="time">{time(event.createdAt)}</span>
        <span className="type">Codex</span>
        <span>{summary}</span>
      </div>
    );
  }

  // Progress is a running commentary, not an event to announce: it gets a
  // quieter treatment so it never competes with what people are saying.
  if (event.type === 'AGENT_PROGRESS') {
    return (
      <div className="system-event progress">
        <span className="time">{time(event.createdAt)}</span>
        <span className="progress-actor">{event.actor.name ?? 'agent'}</span>
        <span className="progress-kind">{String(payload.kind ?? '')}</span>
        <span className="progress-detail">{summary}</span>
      </div>
    );
  }

  return (
    <div className="system-event">
      <span className="time">{time(event.createdAt)}</span>
      <span className="type">{event.type}</span>
      <span>{summary}</span>
      <span className="time">- {event.actor.name ?? 'system'}</span>
    </div>
  );
}

function describe(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'CODEX_CONTROL_REQUEST':
      if (payload.action === 'createThread') return 'New chat requested';
      if (payload.action === 'interruptTurn') return 'Stop requested';
      if (payload.action === 'archiveThread') return 'Chat archived';
      if (payload.action === 'setModel') return `Model changed to ${String(payload.model ?? '')}`;
      if (payload.action === 'configureThread') return 'Agent settings changed';
      return String(payload.prompt ?? payload.action ?? '');
    case 'CODEX_THREAD_STATE':
      return String(payload.error ?? payload.status ?? '');
    case 'CODEX_ACTIVITY':
      return String(payload.summary ?? payload.command ?? payload.tool ?? payload.status ?? '');
    case 'CODEX_APPROVAL_REQUEST':
      return String(payload.reason ?? payload.command ?? 'Codex needs confirmation');
    case 'CODEX_APPROVAL_RESPONSE':
      return `Approval ${String(payload.decision ?? 'answered')}`;
    case 'API_CONTRACT_CREATED':
    case 'API_CONTRACT_UPDATED':
      return `${String(payload.method ?? '')} ${String(payload.endpoint ?? '')}`;
    case 'GIT_COMMIT_CREATED': {
      const git = payload.git as { branch?: string; commit?: string } | undefined;
      return `${git?.branch ?? ''} ${git?.commit?.slice(0, 8) ?? ''}`.trim();
    }
    case 'BUILD_FAILED':
    case 'BUILD_SUCCEEDED':
      return String(payload.target ?? payload.pipeline ?? '');
    case 'TEST_FAILED':
    case 'TEST_PASSED':
      return `${String(payload.passed ?? 0)} passed, ${String(payload.failed ?? 0)} failed`;
    case 'AGENT_PROGRESS': {
      const detail = payload.detail ? ` ${String(payload.detail)}` : '';
      if (payload.kind === 'tool') return `${String(payload.tool ?? 'tool')}${detail}`;
      if (payload.kind === 'thinking') return String(payload.detail ?? 'thinking');
      return String(payload.detail ?? payload.kind ?? '');
    }
    case 'AGENT_BLOCKED':
      return String(payload.reason ?? '');
    case 'AGENT_HANDOFF':
      return String(payload.summary ?? '');
    case 'DECISION_CREATED':
      return String(payload.title ?? '');
    case 'HELP_REQUESTED':
      return String(payload.question ?? '');
    default:
      return JSON.stringify(payload).slice(0, 120);
  }
}

function LocalFileLink({ path }: { path: string }) {
  const href = localFileHref(path);
  return href
    ? <a className="codex-file-link" href={href} target="_blank" rel="noreferrer noopener">{path}</a>
    : <span className="codex-file-link">{path}</span>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function DiffPreview({ diff }: { diff: string }) {
  const changedLines: Array<{
    content: string;
    kind: 'hunk' | 'add' | 'remove';
    oldLine?: number;
    newLine?: number;
  }> = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      changedLines.push({ content: line, kind: 'hunk' });
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      changedLines.push({ content: line, kind: 'add', newLine });
      if (newLine !== undefined) newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      changedLines.push({ content: line, kind: 'remove', oldLine });
      if (oldLine !== undefined) oldLine += 1;
    } else if (line.startsWith(' ')) {
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
    }
  }

  return (
    <pre className="codex-diff">
      {changedLines.map((line, index) => (
        <span
          className={`diff-${line.kind}`}
          data-old-line={line.oldLine ?? ''}
          data-new-line={line.newLine ?? ''}
          key={`${index}:${line.content}`}
        >
          <span className="codex-diff-line-number" aria-hidden="true">{line.oldLine ?? ''}</span>
          <span className="codex-diff-line-number" aria-hidden="true">{line.newLine ?? ''}</span>
          <span className="codex-diff-code">{line.content || ' '}{'\n'}</span>
        </span>
      ))}
    </pre>
  );
}

function commandMeta(payload: Record<string, unknown>): string {
  const values: string[] = [];
  if (typeof payload.exitCode === 'number') values.push(`exit ${payload.exitCode}`);
  if (typeof payload.durationMs === 'number') values.push(payload.durationMs < 1000 ? `${payload.durationMs}ms` : `${(payload.durationMs / 1000).toFixed(1)}s`);
  return values.join(' · ');
}

function codexKindLabel(kind: string): string {
  switch (kind) {
    case 'reasoningSummary': return 'Reasoning summary';
    case 'mcpTool': return 'MCP tool';
    case 'fileChange': return 'File change';
    case 'message': return 'Codex';
    default: return kind;
  }
}
