/**
 * `@agentmesh/protocol` — the wire contract for AgentMesh.
 *
 * This package contains no transport, no storage and no provider-specific
 * code. It is the single definition of what an AgentMesh session looks like,
 * shared by the server, the SDK, the CLI and the web client, so that any
 * third-party implementation can be checked against the same schemas.
 */
export * from './version.js';
export * from './errors.js';
export * from './primitives.js';
export * from './entities.js';
export * from './events.js';
export * from './ws.js';
export * from './rest.js';
export * from './permissions.js';
export * from './mentions.js';
