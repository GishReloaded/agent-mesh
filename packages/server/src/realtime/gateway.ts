import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  AgentMeshError,
  ClientFrameType,
  CloseCode,
  ErrorCode,
  HEARTBEAT,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  ServerFrameType,
  type ClientFrame,
} from '@agentmesh/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Principal } from '../auth/principal.js';
import type { Services } from '../container.js';
import { IdPrefix, newId } from '../ids.js';
import {
  authenticate,
  dispatchCommand,
  helloOkPayload,
  parseFrame,
  announcePresenceLeft,
  subscribeToSession,
} from './commands.js';
import type { ConnectionHandle } from './registry.js';

/** A connection that never says `hello` is dropped. */
const HELLO_TIMEOUT_MS = 10_000;

class Connection implements ConnectionHandle {
  readonly id = newId(IdPrefix.Frame);
  readonly subscriptions = new Set<string>();
  principal!: Principal;
  authenticated = false;
  alive = true;

  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    readonly socket: WebSocket,
    private readonly framesPerSecond: number,
  ) {
    this.tokens = framesPerSecond;
  }

  /** Token bucket: a steady `framesPerSecond` with a one-second burst. */
  takeToken(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.framesPerSecond * 2, this.tokens + elapsed * this.framesPerSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  send(frame: { type: string; payload?: unknown }, id?: string): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        id: id ?? newId(IdPrefix.Frame),
        type: frame.type,
        ts: new Date().toISOString(),
        payload: frame.payload ?? {},
      }),
    );
  }

  sendError(error: AgentMeshError, ref?: string): void {
    this.send({ type: ServerFrameType.Error, payload: { ...error.toBody(), ...(ref ? { ref } : {}) } });
  }

  close(code: number, reason: string): void {
    try {
      this.socket.close(code, reason.slice(0, 120));
    } catch {
      this.socket.terminate();
    }
  }
}

export interface Gateway {
  close(): Promise<void>;
}

const connectionsBySocket = new WeakMap<WebSocket, Connection>();

/**
 * The websocket transport for a self-hosted server: this process owns the
 * sockets. Frame handling itself lives in `commands.ts` and is shared with the
 * Lambda transport, so both deployments speak exactly the same protocol.
 */
export function attachGateway(server: Server, services: Services, log: FastifyBaseLogger): Gateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: PROTOCOL_LIMITS.frameBytes });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const connection = new Connection(socket, services.config.rateLimit.wsFramesPerSecond);
    connectionsBySocket.set(socket, connection);

    // Authentication happens in the first frame, not in the URL: query strings
    // end up in proxy logs, browser history and error reports.
    const helloTimer = setTimeout(() => {
      if (!connection.authenticated) {
        connection.sendError(new AgentMeshError(ErrorCode.Unauthorized, 'No hello frame received.'));
        connection.close(CloseCode.Unauthorized, 'hello timeout');
      }
    }, HELLO_TIMEOUT_MS);

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('message', (raw: Buffer | string) => {
      void handleMessage(connection, raw, services, log).catch((error: unknown) => {
        log.error({ err: error }, 'websocket frame handling failed');
      });
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      void handleClose(connection, services, log);
    });

    socket.on('error', (error: Error) => {
      log.debug({ err: error, remote: request.socket.remoteAddress }, 'websocket error');
    });
  });

  // Liveness: a socket that misses a ping/pong round trip is gone, whatever TCP
  // believes. Presence is only as honest as this loop.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const connection = connectionsBySocket.get(socket);
      if (!connection) {
        socket.terminate();
        continue;
      }
      if (!connection.alive) {
        connection.close(CloseCode.HeartbeatTimeout, 'heartbeat timeout');
        continue;
      }
      connection.alive = false;
      try {
        socket.ping();
      } catch {
        connection.close(CloseCode.HeartbeatTimeout, 'ping failed');
      }
    }
  }, HEARTBEAT.intervalMs);
  heartbeat.unref?.();

  return {
    close: async () => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.close(CloseCode.GoingAway, 'server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

async function handleMessage(
  connection: Connection,
  raw: Buffer | string,
  services: Services,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!connection.takeToken()) {
    connection.sendError(new AgentMeshError(ErrorCode.RateLimited, 'Too many frames.'));
    connection.close(CloseCode.RateLimited, 'rate limited');
    return;
  }

  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const { frame, error, id } = parseFrame(text);

  if (error) {
    connection.sendError(error, id);
    if (error.code === ErrorCode.ProtocolVersionUnsupported) {
      connection.close(CloseCode.UnsupportedVersion, 'unsupported protocol version');
    }
    return;
  }
  if (!frame) return;

  try {
    if (frame.type === ClientFrameType.Hello) {
      await handleHello(connection, frame, services, log);
      return;
    }
    if (!connection.authenticated) {
      throw new AgentMeshError(ErrorCode.Unauthorized, 'Send a hello frame first.');
    }
    await dispatchCommand(services, connection, frame);
  } catch (caught) {
    if (caught instanceof AgentMeshError) {
      connection.sendError(caught, frame.id);
    } else {
      log.error({ err: caught }, 'websocket command failed');
      connection.sendError(new AgentMeshError(ErrorCode.Internal, 'Internal server error.'), frame.id);
    }
  }
}

async function handleHello(
  connection: Connection,
  frame: Extract<ClientFrame, { type: 'hello' }>,
  services: Services,
  log: FastifyBaseLogger,
): Promise<void> {
  if (connection.authenticated) {
    connection.sendError(new AgentMeshError(ErrorCode.Conflict, 'Already authenticated.'), frame.id);
    return;
  }

  let principal: Principal;
  try {
    principal = await authenticate(services, frame.payload.token);
  } catch (error) {
    const failure =
      error instanceof AgentMeshError ? error : new AgentMeshError(ErrorCode.Unauthorized, 'Authentication failed.');
    connection.sendError(failure, frame.id);
    connection.close(CloseCode.Unauthorized, failure.code);
    return;
  }

  connection.principal = principal;
  connection.authenticated = true;
  await services.registry.add(connection);

  connection.send({ type: ServerFrameType.HelloOk, payload: helloOkPayload(principal) }, frame.id);

  // An agent token names its session, so there is nothing to choose: subscribe
  // it immediately and let the session see it come online.
  if (principal.kind === 'agent') {
    try {
      await subscribeToSession(services, connection, principal.sessionId, undefined);
    } catch (error) {
      log.warn({ err: error }, 'agent auto-subscribe failed');
    }
  }
}

async function handleClose(connection: Connection, services: Services, log: FastifyBaseLogger): Promise<void> {
  if (!connection.authenticated) return;
  const sessions = [...connection.subscriptions];
  await services.registry.remove(connection.id);

  for (const sessionId of sessions) {
    try {
      await announcePresenceLeft(services, connection.principal, sessionId);
    } catch (error) {
      log.warn({ err: error, sessionId }, 'failed to announce disconnect');
    }
  }
}
