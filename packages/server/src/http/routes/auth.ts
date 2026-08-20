import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  AgentMeshError,
  ErrorCode,
  loginRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  updateProfileRequestSchema,
} from '@agentmesh/protocol';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../container.js';
import { authenticate, requireUser } from '../auth.js';
import { parse } from '../errors.js';

export async function authRoutes(app: FastifyInstance, services: Services): Promise<void> {
  // Credential endpoints get a much tighter rate limit than the rest of the
  // API: they are the ones worth brute-forcing.
  const credentialLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/auth/register', credentialLimit, async (request, reply) => {
    const body = parse(registerRequestSchema, request.body);
    const tokens = await services.users.register(body, request.headers['user-agent']);
    reply.code(201).send(tokens);
  });

  app.post('/auth/login', credentialLimit, async (request) => {
    const body = parse(loginRequestSchema, request.body);
    return services.users.login(body, request.headers['user-agent']);
  });

  app.post('/auth/refresh', credentialLimit, async (request) => {
    const body = parse(refreshRequestSchema, request.body);
    return services.users.refresh(body.refreshToken, request.headers['user-agent']);
  });

  app.post('/auth/logout', async (request, reply) => {
    const body = parse(refreshRequestSchema, request.body);
    await services.users.logout(body.refreshToken);
    reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: authenticate(services) }, async (request) => {
    const principal = requireUser(request);
    return services.users.byId(principal.userId);
  });

  app.patch('/auth/me', { preHandler: authenticate(services) }, async (request) => {
    const principal = requireUser(request);
    const body = parse(updateProfileRequestSchema, request.body);
    return services.profile.update(principal.userId, body);
  });

  /**
   * Avatar upload. The body is the image itself rather than a multipart form:
   * one file, no fields, and every client here can send raw bytes far more
   * easily than it can assemble a multipart envelope.
   */
  app.post(
    '/auth/me/avatar',
    {
      preHandler: authenticate(services),
      // Base64 through API Gateway inflates by a third; leave room for it.
      bodyLimit: Math.ceil(AVATAR_MAX_BYTES * 1.4),
    },
    async (request) => {
      const principal = requireUser(request);
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new AgentMeshError(
          ErrorCode.ValidationFailed,
          `Send the image bytes as the request body with one of: ${AVATAR_MIME_TYPES.join(', ')}.`,
        );
      }
      return services.profile.setAvatar(principal.userId, body);
    },
  );

  app.delete('/auth/me/avatar', { preHandler: authenticate(services) }, async (request) => {
    const principal = requireUser(request);
    return services.profile.clearAvatar(principal.userId);
  });

  /**
   * Avatars are served through the API rather than from a public bucket: the
   * store stays private, and there are no signed URLs to leak. Anyone who can
   * reach the deployment can fetch one - they are shown next to every message
   * already - so this needs no authentication, only a valid key.
   */
  app.get('/users/:id/avatar/:fragment', async (request, reply) => {
    const { id, fragment } = request.params as { id: string; fragment: string };
    const image = await services.profile.readAvatar(id, fragment);
    if (!image) {
      reply.code(404).send({ error: { code: ErrorCode.NotFound, message: 'No avatar.' } });
      return;
    }
    // The key changes on every upload, so this can be cached forever.
    reply
      .header('content-type', image.contentType)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('content-disposition', 'inline')
      .header('x-content-type-options', 'nosniff')
      .send(image.body);
  });
}
