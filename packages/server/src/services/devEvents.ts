import {
  AgentMeshError,
  ErrorCode,
  PROTOCOL_LIMITS,
  isLifecycleEventType,
  isPublishableEventType,
  parseEventPayload,
  type Event,
} from '@agentmesh/protocol';
import { z } from 'zod';
import type { SessionAccess } from '../auth/principal.js';
import type { EventLog } from './eventLog.js';

/**
 * Publishing of development events (`API_CONTRACT_CREATED`, `BUILD_FAILED`, …).
 *
 * The server validates the shape and then stores the payload verbatim. It does
 * not act on these events, and deliberately does not try to verify them: a
 * commit hash reported by an agent is a claim about a repository the server has
 * never seen. Consumers should treat development events as self-reported.
 */
export class DevEventService {
  constructor(private readonly log: EventLog) {}

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

    return this.log.write(access.sessionId, async (ctx) =>
      ctx.append(type, access.actor, validated as Record<string, unknown>),
    );
  }
}
