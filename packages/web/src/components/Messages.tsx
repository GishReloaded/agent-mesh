import { mentionsActor, type Event as MeshEvent, type Identity, type Message } from '@agentmesh/sdk';
import { useEffect, useRef } from 'react';
import { participantColor } from '../lib/colors.js';
import { renderMarkdown } from '../lib/markdown.js';
import { Avatar } from './Presence.js';

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A message carries only who wrote it, not what they look like. Colours come
 * from the session's participant list, which the client already has.
 */
export type ColorLookup = (author: Message['author']) => string | null;

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
}: {
  messages: Message[];
  events: MeshEvent[];
  identity: Identity | null;
  hasMore: boolean;
  onLoadMore: () => void;
  colorOf: ColorLookup;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    // Only auto-scroll when the reader is already at the bottom; yanking the
    // viewport away from someone reading history is worse than a missed scroll.
    if (stickToBottom.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, events.length]);

  const merged = [...messages.map((m) => ({ seq: m.seq, message: m }) as const), ...events.map((e) => ({ seq: e.seq, event: e }) as const)].sort(
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
          <EventRow key={item.event.id} event={item.event} />
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
function EventRow({ event }: { event: MeshEvent }) {
  const payload = event.payload as Record<string, unknown>;
  const summary = describe(event.type, payload);

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
