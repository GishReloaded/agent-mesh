import { API_PREFIX, AgentMeshError, ErrorCode, type ErrorResponse } from '@agentmesh/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/** Parse a request body/query with zod, converting failures into API errors. */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AgentMeshError(ErrorCode.ValidationFailed, 'Request payload is not valid.', {
      details: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function toResponse(error: AgentMeshError): ErrorResponse {
  return { error: error.toBody() };
}

export function registerErrorHandler(app: FastifyInstance, options: { serveSpa?: boolean } = {}): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    // When the server also hosts the web client, unknown non-API paths are
    // client-side routes (/s/:id, /invite/:token) and must return the app
    // shell rather than a JSON 404.
    const isApiPath = request.url.startsWith(API_PREFIX) || request.url.startsWith('/ws');
    if (options.serveSpa && !isApiPath) {
      reply.type('text/html').sendFile('index.html');
      return;
    }
    reply
      .code(404)
      .send(toResponse(new AgentMeshError(ErrorCode.NotFound, `No route for ${request.method} ${request.url}.`)));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AgentMeshError) {
      if (error.httpStatus >= 500) request.log.error({ err: error }, 'request failed');
      reply.code(error.httpStatus).send(toResponse(error));
      return;
    }

    if (error instanceof z.ZodError) {
      reply.code(400).send(
        toResponse(
          new AgentMeshError(ErrorCode.ValidationFailed, 'Request payload is not valid.', {
            details: error.issues,
          }),
        ),
      );
      return;
    }

    // Fastify's own errors (rate limit, body limit, malformed JSON) carry a
    // statusCode; map them onto the protocol's codes so clients only ever see
    // one error vocabulary.
    const status: number = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : 'Malformed request.';
    if (status === 429) {
      reply
        .code(429)
        .send(toResponse(new AgentMeshError(ErrorCode.RateLimited, 'Too many requests. Slow down.')));
      return;
    }
    if (status === 413) {
      reply.code(413).send(toResponse(new AgentMeshError(ErrorCode.PayloadTooLarge, 'Request body is too large.')));
      return;
    }
    if (status === 400) {
      reply
        .code(400)
        .send(toResponse(new AgentMeshError(ErrorCode.ValidationFailed, message || 'Malformed request.')));
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    reply
      .code(status >= 400 && status < 600 ? status : 500)
      .send(toResponse(new AgentMeshError(ErrorCode.Internal, 'Internal server error.')));
  });
}
