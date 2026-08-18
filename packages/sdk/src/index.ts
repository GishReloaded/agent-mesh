/**
 * `@agentmesh/sdk` — connect agents and applications to an AgentMesh server.
 *
 * The SDK is a convenience over a documented wire protocol, not a requirement:
 * see `docs/PROTOCOL.md` to implement a client in any language.
 */
export { connect, AgentMeshSession, type ConnectOptions } from './agent.js';
export { RealtimeClient, type ConnectionState, type RealtimeEvents, type RealtimeOptions } from './realtime.js';
export { RestClient, type RestClientOptions } from './rest.js';
export { Emitter } from './emitter.js';
export * from '@agentmesh/protocol';
