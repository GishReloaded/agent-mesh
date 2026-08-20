import { AVATAR_MIME_TYPES } from '@agentmesh/protocol';
import awsLambdaFastify from '@fastify/aws-lambda';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { app } from './runtime.js';

/**
 * REST and web-UI handler for the serverless deployment.
 *
 * `@fastify/aws-lambda` translates API Gateway events into Fastify requests, so
 * every route, hook and validator is the same code the self-hosted server runs.
 * There is no second implementation of the API to keep in step.
 */
type Proxy = (event: APIGatewayProxyEventV2, context: Context) => Promise<APIGatewayProxyResultV2>;

let proxy: Proxy | null = null;

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  // Returning before the event loop drains keeps the container warm with its
  // database pool intact, which is the point of caching the app at all.
  context.callbackWaitsForEmptyEventLoop = false;

  // The public URL is learned from the first request rather than configured.
  // Passing it in would mean the function's environment referencing the API
  // that routes to the function - a dependency cycle CloudFormation refuses.
  // Invite links need it to be right, so it is set before the app is built.
  if (!process.env.PUBLIC_URL) {
    const host = event.requestContext?.domainName ?? event.headers?.host;
    if (host) {
      process.env.PUBLIC_URL = `https://${host}`;
      process.env.CORS_ORIGINS ??= `https://${host}`;
    }
  }

  if (!proxy) {
    proxy = awsLambdaFastify(await app(), {
      // Anything not listed here is handed back as a UTF-8 string, which
      // silently destroys it: a JPEG came out as replacement characters, twice
      // its original size. Every type the API can serve as bytes belongs in
      // this list, so it is derived from the accepted types rather than
      // hand-written.
      binaryMimeTypes: [...AVATAR_MIME_TYPES, 'image/x-icon', 'image/svg+xml', 'font/woff2', 'application/octet-stream'],
      serializeLambdaArguments: false,
    }) as unknown as Proxy;
  }
  return proxy(event, context);
};
