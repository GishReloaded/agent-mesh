/**
 * Protocol version identifier carried by every AgentMesh frame.
 *
 * Format: `agentmesh/v<major>`. Clients and servers negotiate on the major
 * version only: a server rejects frames whose major version it does not
 * implement, and additive changes (new event types, new optional fields)
 * never bump the major.
 */
export const PROTOCOL_VERSION = 'agentmesh/v1' as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Major versions this build can speak. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION];

export function isSupportedProtocolVersion(value: string): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(value);
}

/**
 * Hard limits every conforming implementation must enforce. They exist so an
 * agent cannot accidentally (or deliberately) flood a session.
 */
export const PROTOCOL_LIMITS = {
  /** Maximum size of a single message body, in bytes of UTF-8. */
  messageBodyBytes: 32_768,
  /** Maximum serialized size of a single event payload, in bytes of UTF-8. */
  eventPayloadBytes: 131_072,
  /** Maximum size of an entire websocket frame, in bytes. */
  frameBytes: 262_144,
  /** Maximum number of events a single history/resume page may return. */
  maxPageSize: 200,
  /** Default page size when the caller does not ask for one. */
  defaultPageSize: 50,
  /**
   * How many agent-authored messages may address other agents within
   * `agentChainWindowSeconds`, before a human has to take a turn.
   *
   * Guards against two models talking each other into an infinite loop while
   * still leaving room for a real exchange: a rate over a window allows a
   * genuine back-and-forth to finish, where a hard consecutive count cuts off
   * conversations that were going somewhere.
   */
  agentChainLimit: 10,
  agentChainWindowSeconds: 300,
} as const;
