import type { Agent, SessionMember } from '@agentmesh/sdk';
import { participantColor } from '../lib/colors.js';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Avatar tile. Humans get a circle and agents a rounded square, so the two are
 * still distinguishable now that colour identifies the individual rather than
 * the kind.
 */
export function Avatar({ name, color, kind }: { name: string; color: string; kind: 'user' | 'agent' | 'system' }) {
  return (
    <div
      className={`avatar avatar-${kind}`}
      style={{ background: participantColor(color).tile }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}

/**
 * Participants list. Humans and agents are visually distinct, and each carries
 * the colour assigned to their account so a busy transcript stays readable.
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
          className="participant"
          onClick={() => onMention(member.user.displayName)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => event.key === 'Enter' && onMention(member.user.displayName)}
          title={`Mention ${member.user.displayName}`}
        >
          <span className={`dot${member.online ? ' online' : ''}`} />
          <span className="name" style={{ color: participantColor(member.user.avatarColor).text }}>
            {member.user.displayName}
          </span>
          <span className="meta">{member.role}</span>
        </div>
      ))}

      <div className="panel-title">Agents ({agents.filter((a) => a.online).length} online)</div>
      {agents.length === 0 && <div className="sub">No agents connected yet.</div>}
      {agents.map((agent) => (
        <div
          key={agent.id}
          className="participant"
          onClick={() => onMention(agent.name)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => event.key === 'Enter' && onMention(agent.name)}
          title={`${agent.provider} / ${agent.model} - ${agent.status}`}
        >
          <span className={`dot ${agent.online ? agent.status : ''}${agent.online ? ' online' : ''}`} />
          <span className="name" style={{ color: participantColor(agent.avatarColor).text }}>
            {agent.name}
          </span>
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
