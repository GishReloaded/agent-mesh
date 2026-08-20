import {
  AgentMeshError,
  DevEventType,
  ErrorCode,
  Permission,
  PROTOCOL_LIMITS,
  SessionRole,
  can,
  isLifecycleEventType,
  isPublishableEventType,
  parseEventPayload,
  type Event,
} from '@agentmesh/protocol';
import { z } from 'zod';
import type { SessionAccess } from '../auth/principal.js';
import type { Db } from '../db/client.js';
import type { EventLog } from './eventLog.js';

const CODEX_AGENT_EVENTS = new Set<string>([
  DevEventType.CodexThreadState,
  DevEventType.CodexActivity,
  DevEventType.CodexApprovalRequest,
]);

const CODEX_HUMAN_EVENTS = new Set<string>([
  DevEventType.CodexControlRequest,
  DevEventType.CodexApprovalResponse,
]);

/** Enforce direction and ownership for events that can execute code locally. */
export function assertCodexEventAuthority(
  access: SessionAccess,
  type: string,
  targetAgentId: string,
  agentOwnerUserId: string,
): void {
  if (CODEX_AGENT_EVENTS.has(type)) {
    if (access.principal.kind !== 'agent') {
      throw new AgentMeshError(ErrorCode.Forbidden, 'Only agents may publish Codex runtime state.');
    }
    if (access.principal.agentId !== targetAgentId) {
      throw new AgentMeshError(ErrorCode.Forbidden, 'Agents may publish only their own Codex state.');
    }
    return;
  }

  if (CODEX_HUMAN_EVENTS.has(type)) {
    if (access.principal.kind !== 'user') {
      throw new AgentMeshError(ErrorCode.Forbidden, 'Only human users may control Codex agents.');
    }
    if (!can(access.role, Permission.ControlAgent)) {
      throw new AgentMeshError(ErrorCode.Forbidden, 'This session role cannot control agents.');
    }
    if (access.role !== SessionRole.Owner && access.principal.userId !== agentOwnerUserId) {
      throw new AgentMeshError(
        ErrorCode.Forbidden,
        'Only the session owner or the user who registered this agent may control it.',
      );
    }
  }
}

/**
 * Publishing of development events (`API_CONTRACT_CREATED`, `BUILD_FAILED`, …).
 *
 * The server validates the shape and then stores the payload verbatim. It does
 * not act on these events, and deliberately does not try to verify them: a
 * commit hash reported by an agent is a claim about a repository the server has
 * never seen. Consumers should treat development events as self-reported.
 */
export class DevEventService {
  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
  ) {}

  async publish(access: SessionAccess, type: string, payload: unknown): Promise<Event> {
    if (isLifecycleEventType(type)) {
      throw new AgentMeshError(
        ErrorCode.Forbidden,
        `"${type}" is a lifecycle event produced by the server and cannot be published directly.`,
      );
    }
    if (!isPublishableEventType(type)) {
      throw new AgentMeshError(
        ErrorCode.ValidationFailed,
        `Unknown event type "${type}". Use a documented development event or an X_-prefixed custom type.`,
      );
    }

    const serialized = JSON.stringify(payload ?? {});
    if (Buffer.byteLength(serialized, 'utf8') > PROTOCOL_LIMITS.eventPayloadBytes) {
      throw new AgentMeshError(
        ErrorCode.PayloadTooLarge,
        `Event payload exceeds ${PROTOCOL_LIMITS.eventPayloadBytes} bytes.`,
      );
    }

    let validated: unknown;
    try {
      validated = parseEventPayload(type, payload ?? {});
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new AgentMeshError(ErrorCode.ValidationFailed, `Invalid payload for ${type}.`, {
          details: error.issues,
        });
      }
      throw error;
    }

    if (CODEX_AGENT_EVENTS.has(type) || CODEX_HUMAN_EVENTS.has(type)) {
      const targetAgentId = (validated as { agentId: string }).agentId;
      const agent = await this.db
        .selectFrom('agents')
        .select('owner_user_id')
        .where('id', '=', targetAgentId)
        .where('session_id', '=', access.sessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!agent) throw new AgentMeshError(ErrorCode.NotFound, 'Target agent not found.');
      assertCodexEventAuthority(access, type, targetAgentId, agent.owner_user_id);
    }

    return this.log.write(access.sessionId, async (ctx) =>
      ctx.append(type, access.actor, validated as Record<string, unknown>),
    );
  }
}
