import type { Agent, SessionMember } from '@agentmesh/sdk';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function Avatar({ name, color }: { name: string; color: string }) {
  return (
    <div className="avatar" style={{ background: color }} aria-hidden="true">
      {initials(name)}
    </div>
  );
}

/**
 * Participants list. Humans and agents are visually distinct on purpose: in a
 * session where both are talking, knowing which is which is the difference
 * between reading a conversation and reading a transcript.
 */
export function ParticipantList({
  members,
  agents,
  onMention,
}: {
  members: SessionMember[];
  agents: Agent[];
  onMention: (handle: string) => void;
}) {
  return (
    <div className="panel-scroll">
      <div className="panel-title">People ({members.filter((m) => m.online).length} online)</div>
      {members.map((member) => (
        <div
          key={member.user.id}
          className="participant kind-user"
          onClick={() => onMention(member.user.displayName)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => event.key === 'Enter' && onMention(member.user.displayName)}
          title={`Mention ${member.user.displayName}`}
        >
          <span className={`dot${member.online ? ' online' : ''}`} />
          <span className="name">{member.user.displayName}</span>
          <span className="meta">{member.role}</span>
        </div>
      ))}

      <div className="panel-title">Agents ({agents.filter((a) => a.online).length} online)</div>
      {agents.length === 0 && <div className="sub">No agents connected yet.</div>}
      {agents.map((agent) => (
        <div
          key={agent.id}
          className="participant kind-agent"
          onClick={() => onMention(agent.name)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => event.key === 'Enter' && onMention(agent.name)}
          title={`${agent.provider} / ${agent.model} - ${agent.status}`}
        >
          <span className={`dot ${agent.online ? agent.status : ''}${agent.online ? ' online' : ''}`} />
          <span className="name">{agent.name}</span>
          <span className="meta">{agent.online ? agent.status : 'offline'}</span>
        </div>
      ))}
    </div>
  );
}

export function ConnectionBadge({ state }: { state: string }) {
  const label =
    state === 'connected'
      ? 'Connected'
      : state === 'reconnecting'
        ? 'Reconnecting...'
        : state === 'connecting'
          ? 'Connecting...'
          : 'Offline';
  return (
    <span className="connection">
      <span className={`dot${state === 'connected' ? ' online' : state === 'reconnecting' ? ' working' : ''}`} />
      {label}
    </span>
  );
}
