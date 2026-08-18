import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { AgentMeshError, ErrorCode } from '@agentmesh/protocol';

/**
 * Two token families, chosen for different revocation needs:
 *
 * - **Access tokens** are short-lived JWTs. They are verified without a
 *   database round trip, which is why they must expire quickly.
 * - **Refresh, invite and agent tokens** are opaque random strings. Only their
 *   SHA-256 hash is stored, and every use is checked against the database, so
 *   revoking one takes effect immediately.
 */

export const TokenPrefix = {
  Refresh: 'amr',
  Invite: 'ami',
  Agent: 'ama',
} as const;
export type TokenPrefix = (typeof TokenPrefix)[keyof typeof TokenPrefix];

const OPAQUE_BYTES = 32;

export interface OpaqueToken {
  /** Shown to the caller exactly once. */
  token: string;
  /** What gets persisted. */
  hash: string;
}

export function createOpaqueToken(prefix: TokenPrefix): OpaqueToken {
  const token = `${prefix}_${randomBytes(OPAQUE_BYTES).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** Constant-time comparison for token hashes. */
export function tokenHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function tokenLooksLike(token: string, prefix: TokenPrefix): boolean {
  return token.startsWith(`${prefix}_`);
}

export interface AccessTokenClaims {
  sub: string;
  displayName: string;
}

const ISSUER = 'agentmesh';
const AUDIENCE = 'agentmesh-api';

export class AccessTokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  get ttl(): number {
    return this.ttlSeconds;
  }

  async sign(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ displayName: claims.displayName })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE });
      if (typeof payload.sub !== 'string') {
        throw new AgentMeshError(ErrorCode.InvalidToken, 'Access token is missing a subject.');
      }
      return {
        sub: payload.sub,
        displayName: typeof payload.displayName === 'string' ? payload.displayName : '',
      };
    } catch (error) {
      if (error instanceof AgentMeshError) throw error;
      const code = (error as { code?: string }).code;
      if (code === 'ERR_JWT_EXPIRED') {
        throw new AgentMeshError(ErrorCode.TokenExpired, 'Access token has expired.');
      }
      throw new AgentMeshError(ErrorCode.InvalidToken, 'Access token is not valid.');
    }
  }
}
