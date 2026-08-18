import { toHandle, type Agent, type SessionMember } from '@agentmesh/sdk';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface ComposerHandle {
  insertMention: (displayName: string) => void;
}

/**
 * Message composer with `@` autocomplete.
 *
 * Mentions are the routing mechanism of a session - they decide which agent
 * wakes up - so the composer makes the candidate list explicit rather than
 * letting people guess at handles.
 */
export function Composer({
  members,
  agents,
  disabled,
  onSend,
  onTyping,
  registerHandle,
}: {
  members: SessionMember[];
  agents: Agent[];
  disabled?: boolean;
  onSend: (body: string) => Promise<void>;
  onTyping: (active: boolean) => void;
  registerHandle?: (handle: ComposerHandle) => void;
}) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const candidates = useMemo(
    () => [
      { handle: 'all', label: 'everyone in the session', kind: 'broadcast' as const },
      ...agents.map((agent) => ({
        handle: toHandle(agent.name),
        label: `${agent.provider} / ${agent.model}`,
        kind: 'agent' as const,
      })),
      ...members.map((member) => ({
        handle: toHandle(member.user.displayName),
        label: member.role,
        kind: 'user' as const,
      })),
    ],
    [agents, members],
  );

  const query = useMemo(() => {
    const match = /(?:^|\s)@([a-zA-Z0-9._-]*)$/.exec(value);
    return match?.[1] ?? null;
  }, [value]);

  const matches = useMemo(() => {
    if (query === null) return [];
    const needle = query.toLowerCase();
    return candidates.filter((candidate) => candidate.handle.startsWith(needle)).slice(0, 8);
  }, [candidates, query]);

  useEffect(() => setMenuIndex(0), [query]);

  useEffect(() => {
    registerHandle?.({
      insertMention: (displayName: string) => {
        const handle = displayName === 'all' ? 'all' : toHandle(displayName);
        setValue((current) => (current.endsWith(' ') || current === '' ? `${current}@${handle} ` : `${current} @${handle} `));
        textarea.current?.focus();
      },
    });
  }, [registerHandle]);

  const applyCompletion = (handle: string) => {
    setValue((current) => current.replace(/@([a-zA-Z0-9._-]*)$/, `@${handle} `));
    textarea.current?.focus();
  };

  const send = async () => {
    const body = value.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body);
      setValue('');
      onTyping(false);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMenuIndex((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMenuIndex((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        const candidate = matches[menuIndex];
        if (candidate) {
          event.preventDefault();
          applyCompletion(candidate.handle);
          return;
        }
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="composer">
      <div className="row" style={{ position: 'relative' }}>
        {matches.length > 0 && (
          <div className="mention-menu">
            {matches.map((candidate, index) => (
              <button
                key={candidate.handle}
                className={index === menuIndex ? 'active' : ''}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyCompletion(candidate.handle);
                }}
              >
                <span style={{ color: candidate.kind === 'agent' ? 'var(--agent)' : 'var(--human)' }}>
                  @{candidate.handle}
                </span>
                <span style={{ color: 'var(--text-dim)', marginLeft: 'auto' }}>{candidate.label}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          value={value}
          disabled={disabled}
          placeholder="Write a message. Use @name to address a person or an agent."
          rows={1}
          onChange={(event) => {
            setValue(event.target.value);
            onTyping(true);
            if (typingTimer.current) clearTimeout(typingTimer.current);
            typingTimer.current = setTimeout(() => onTyping(false), 3000);
          }}
          onKeyDown={handleKeyDown}
        />
        <button className="primary" onClick={() => void send()} disabled={disabled || sending || !value.trim()}>
          Send
        </button>
      </div>
      <div className="hint">
        <span>Enter to send, Shift+Enter for a new line</span>
        <span>@all broadcasts to everyone</span>
      </div>
    </div>
  );
}
