import { z } from 'zod';

/**
 * Stable, machine-readable error codes. Clients branch on `code`, never on
 * `message` — messages are for humans and may be reworded at any time.
 */
export const ErrorCode = {
  /** No credentials, or credentials the server cannot verify. */
  Unauthorized: 'UNAUTHORIZED',
  /** Credentials are valid but the actor may not perform this action. */
  Forbidden: 'FORBIDDEN',
  /** Token is malformed, revoked, or not of the expected kind. */
  InvalidToken: 'INVALID_TOKEN',
  /** Token was valid but has passed its expiry. */
  TokenExpired: 'TOKEN_EXPIRED',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  ValidationFailed: 'VALIDATION_FAILED',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  RateLimited: 'RATE_LIMITED',
  /** The frame declared a protocol version this server does not speak. */
  ProtocolVersionUnsupported: 'PROTOCOL_VERSION_UNSUPPORTED',
  /** The frame was not valid JSON, or not a valid protocol frame at all. */
  MalformedFrame: 'MALFORMED_FRAME',
  /** The session exists but is archived and accepts no new writes. */
  SessionArchived: 'SESSION_ARCHIVED',
  /** Caller must subscribe to the session before addressing it. */
  NotSubscribed: 'NOT_SUBSCRIBED',
  /**
   * The connection is open but the server no longer recognises it, so the
   * client must send `hello` again. Distinct from `UNAUTHORIZED` because the
   * credential is fine and the client can recover by itself - a deployment
   * where the socket outlives the server's memory of it needs a way to say so.
   */
  Reauthenticate: 'REAUTHENTICATE',
  /** Agent-to-agent chain limit reached; a human turn is required. */
  AgentChainLimit: 'AGENT_CHAIN_LIMIT',
  /** Requested `since_seq` is no longer replayable; refetch history instead. */
  ResyncRequired: 'RESYNC_REQUIRED',
  Internal: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const errorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  /** Frame id this error responds to, when it was triggered by a request. */
  ref: z.string().optional(),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;

/** Envelope used by every non-2xx REST response. */
export const errorResponseSchema = z.object({ error: errorBodySchema });

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Default HTTP status for each error code. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_FAILED: 400,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  PROTOCOL_VERSION_UNSUPPORTED: 400,
  MALFORMED_FRAME: 400,
  SESSION_ARCHIVED: 409,
  NOT_SUBSCRIBED: 409,
  REAUTHENTICATE: 401,
  AGENT_CHAIN_LIMIT: 429,
  RESYNC_REQUIRED: 409,
  INTERNAL: 500,
};

/** Error type shared by the server, the SDK and the CLI. */
export class AgentMeshError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly ref?: string;

  constructor(code: ErrorCode, message: string, options?: { details?: unknown; ref?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AgentMeshError';
    this.code = code;
    this.details = options?.details;
    this.ref = options?.ref;
  }

  get httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code] ?? 500;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { code: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    if (this.ref !== undefined) body.ref = this.ref;
    return body;
  }

  static fromBody(body: ErrorBody): AgentMeshError {
    const code = (Object.values(ErrorCode) as string[]).includes(body.code)
      ? (body.code as ErrorCode)
      : ErrorCode.Internal;
    return new AgentMeshError(code, body.message, { details: body.details, ref: body.ref });
  }
}
