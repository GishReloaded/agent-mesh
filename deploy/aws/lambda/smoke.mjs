#!/usr/bin/env node
/**
 * Invoke the built Lambda bundles locally with synthetic API Gateway events.
 *
 * This is the check that matters before a first deploy: an ESM bundle of
 * Fastify and pg either loads in a Node 22 runtime or it does not, and finding
 * that out from CloudWatch after a stack update is a slow way to learn it.
 *
 *   DATABASE_URL=postgres://... node deploy/aws/lambda/smoke.mjs
 */
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV ??= 'production';
process.env.JWT_SECRET ??= 'smoke-test-secret-that-is-long-enough-here';
process.env.WEB_DIST ??= 'none';
process.env.PUBLIC_URL ??= 'https://example.invalid';
process.env.CORS_ORIGINS ??= 'https://example.invalid';

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL to a database with migrations applied.');
  process.exit(1);
}

const { handler: http } = await import('../../../dist-lambda/http.mjs');

const context = { callbackWaitsForEmptyEventLoop: true, awsRequestId: randomUUID() };

function request(method, path, body, headers = {}) {
  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', host: 'example.invalid', ...headers },
    requestContext: {
      domainName: 'example.invalid',
      http: { method, path, sourceIp: '127.0.0.1' },
      requestId: randomUUID(),
      stage: '$default',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    isBase64Encoded: false,
  };
}

let failures = 0;
async function check(label, event, expected) {
  const response = await http(event, context);
  const ok = response.statusCode === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${response.statusCode} (expected ${expected})`);
  return response;
}

console.log('invoking the HTTP bundle...\n');

const version = await check('GET /api/v1/version', request('GET', '/api/v1/version'), 200);
console.log('     ', version.body);

await check('GET /api/v1/healthz', request('GET', '/api/v1/healthz'), 200);
await check('GET /api/v1/sessions without a token', request('GET', '/api/v1/sessions'), 401);

const email = `smoke-${Date.now()}@example.test`;
const registered = await check(
  'POST /api/v1/auth/register',
  request('POST', '/api/v1/auth/register', {
    email,
    password: 'correct horse battery staple',
    displayName: 'Smoke Test',
  }),
  201,
);

const tokens = JSON.parse(registered.body);
const auth = { authorization: `Bearer ${tokens.accessToken}` };

const created = await check(
  'POST /api/v1/sessions',
  request('POST', '/api/v1/sessions', { name: `Smoke ${Date.now()}` }, auth),
  201,
);
const session = JSON.parse(created.body);

await check(
  'POST /api/v1/sessions/:id/messages',
  request('POST', `/api/v1/sessions/${session.id}/messages`, { body: 'hello from lambda' }, auth),
  201,
);
await check(
  'GET /api/v1/sessions/:id/messages',
  request('GET', `/api/v1/sessions/${session.id}/messages`, undefined, auth),
  200,
);

// --- realtime ---------------------------------------------------------------

console.log('\ninvoking the WebSocket bundle against a stub management API...\n');

const { createServer } = await import('node:http');

/** Stands in for API Gateway's PostToConnection endpoint. */
const delivered = [];
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      delivered.push({ connectionId: decodeURIComponent(req.url.split('/@connections/')[1] ?? ''), frame: JSON.parse(body) });
    } catch {
      delivered.push({ connectionId: 'unparsed', frame: body });
    }
    res.writeHead(200).end();
  });
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const port = mock.address().port;

process.env.REALTIME_MANAGEMENT_ENDPOINT = `http://127.0.0.1:${port}`;
process.env.AWS_REGION ??= 'eu-north-1';
process.env.AWS_ACCESS_KEY_ID ??= 'smoke';
process.env.AWS_SECRET_ACCESS_KEY ??= 'smoke';

const { handler: wsHandler } = await import('../../../dist-lambda/ws.mjs');

const connectionId = `smoke-${Date.now()}`;
const wsEvent = (routeKey, body) => ({
  requestContext: { connectionId, routeKey, domainName: '127.0.0.1', stage: 'prod' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const frame = (type, payload) => ({ v: 'agentmesh/v1', id: `t${Date.now()}`, type, payload });

function expectFrame(label, type) {
  const found = delivered.some((item) => item.frame?.type === type);
  if (!found) failures += 1;
  console.log(`${found ? 'ok  ' : 'FAIL'} ${label} -> ${type}`);
}

await wsHandler(wsEvent('$connect'));
console.log('ok   $connect accepted');

await wsHandler(wsEvent('$default', frame('hello', { token: tokens.accessToken })));
expectFrame('hello authenticates', 'hello.ok');

await wsHandler(wsEvent('$default', frame('subscribe', { sessionId: session.id })));
expectFrame('subscribe returns a snapshot', 'subscribed');

delivered.length = 0;
await wsHandler(wsEvent('$default', frame('message.send', { sessionId: session.id, body: 'hi over the socket' })));
expectFrame('message.send is acknowledged', 'ack');
expectFrame('the message is fanned out', 'event');

const echoed = delivered.find((item) => item.frame?.type === 'event');
const body = echoed?.frame?.payload?.event?.payload?.message?.body;
const bodyOk = body === 'hi over the socket';
if (!bodyOk) failures += 1;
console.log(`${bodyOk ? 'ok  ' : 'FAIL'} the fanned-out event carries the message (${body ?? 'nothing'})`);

await wsHandler(wsEvent('$disconnect'));
console.log('ok   $disconnect accepted');

mock.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
