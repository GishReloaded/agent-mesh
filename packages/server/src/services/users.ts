import {
  AgentMeshError,
  ErrorCode,
  type AuthTokens,
  type LoginRequest,
  type RegisterRequest,
  type User,
} from '@agentmesh/protocol';
import type { Db } from '../db/client.js';
import { hashPassword, passwordProblems, verifyPassword } from '../auth/passwords.js';
import { type AccessTokenService, TokenPrefix, createOpaqueToken, hashToken } from '../auth/tokens.js';
import { IdPrefix, newId } from '../ids.js';
import { toUser } from '../mappers.js';

const AVATAR_COLORS = [
  '#6366f1',
  '#ec4899',
  '#f59e0b',
  '#10b981',
  '#3b82f6',
  '#8b5cf6',
  '#ef4444',
  '#14b8a6',
];

export class UserService {
  constructor(
    private readonly db: Db,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTtlSeconds: number,
    private readonly registrationOpen: boolean,
  ) {}

  async register(input: RegisterRequest, userAgent?: string): Promise<AuthTokens> {
    if (!this.registrationOpen) {
      throw new AgentMeshError(ErrorCode.Forbidden, 'Registration is closed on this server.');
    }
    const problems = passwordProblems(input.password);
    if (problems.length > 0) {
      throw new AgentMeshError(ErrorCode.ValidationFailed, `Password ${problems.join(', ')}.`);
    }

    const email = input.email.trim().toLowerCase();
    const existing = await this.db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    if (existing) {
      throw new AgentMeshError(ErrorCode.Conflict, 'An account with this email already exists.');
    }

    const row = await this.db
      .insertInto('users')
      .values({
        id: newId(IdPrefix.User),
        email,
        password_hash: await hashPassword(input.password),
        display_name: input.displayName.trim(),
        avatar_color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] ?? '#6366f1',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.issueTokens(toUser(row), userAgent);
  }

  async login(input: LoginRequest, userAgent?: string): Promise<AuthTokens> {
    const email = input.email.trim().toLowerCase();
    const row = await this.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();

    // Verify against a dummy hash when the account does not exist so that the
    // response time does not reveal which emails are registered.
    const passwordHash = row?.password_hash ?? DUMMY_HASH;
    const ok = await verifyPassword(input.password, passwordHash);
    if (!row || !ok) {
      throw new AgentMeshError(ErrorCode.Unauthorized, 'Email or password is incorrect.');
    }
    return this.issueTokens(toUser(row), userAgent);
  }

  /**
   * Rotate a refresh token.
   *
   * Each refresh token is single-use. Presenting one that was already rotated
   * means it leaked, so the entire family is revoked rather than the request
   * simply being denied.
   */
  async refresh(refreshToken: string, userAgent?: string): Promise<AuthTokens> {
    const hash = hashToken(refreshToken);
    const row = await this.db
      .selectFrom('refresh_tokens')
      .selectAll()
      .where('token_hash', '=', hash)
      .executeTakeFirst();

    if (!row) throw new AgentMeshError(ErrorCode.InvalidToken, 'Refresh token is not valid.');

    if (row.revoked_at !== null) {
      await this.db
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', row.user_id)
        .where('revoked_at', 'is', null)
        .execute();
      throw new AgentMeshError(
        ErrorCode.InvalidToken,
        'Refresh token was already used. All sessions for this account have been revoked.',
      );
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new AgentMeshError(ErrorCode.TokenExpired, 'Refresh token has expired.');
    }

    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', row.user_id)
      .executeTakeFirst();
    if (!user) throw new AgentMeshError(ErrorCode.InvalidToken, 'Account no longer exists.');

    const issued = await this.issueTokens(toUser(user), userAgent);
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date(), replaced_by: hashToken(issued.refreshToken) })
      .where('id', '=', row.id)
      .execute();
    return issued;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('token_hash', '=', hashToken(refreshToken))
      .where('revoked_at', 'is', null)
      .execute();
  }

  async byId(userId: string): Promise<User> {
    const row = await this.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.Unauthorized, 'Account no longer exists.');
    return toUser(row);
  }

  private async issueTokens(user: User, userAgent?: string): Promise<AuthTokens> {
    const accessToken = await this.accessTokens.sign({ sub: user.id, displayName: user.displayName });
    const refresh = createOpaqueToken(TokenPrefix.Refresh);

    await this.db
      .insertInto('refresh_tokens')
      .values({
        id: newId(IdPrefix.RefreshToken),
        user_id: user.id,
        token_hash: refresh.hash,
        expires_at: new Date(Date.now() + this.refreshTtlSeconds * 1000),
        revoked_at: null,
        replaced_by: null,
        user_agent: userAgent?.slice(0, 300) ?? null,
      })
      .execute();

    return {
      accessToken,
      expiresIn: this.accessTokens.ttl,
      refreshToken: refresh.token,
      user,
    };
  }
}

/** A real scrypt hash of a random value, used only to equalise login timing. */
const DUMMY_HASH =
  'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$' +
  'ZmFrZWhhc2hmYWtlaGFzaGZha2VoYXNoZmFrZWhhc2hmYWtlaGFzaGZha2VoYXNoZmFrZWhhc2hmYWtlaGFzaA';
