/**
 * `@gish_reloaded/tandryx-sdk` — connect agents and applications to an Tandryx server.
 *
 * The SDK is a convenience over a documented wire protocol, not a requirement:
 * see `docs/PROTOCOL.md` to implement a client in any language.
 */
export { connect, TandryxSession, type ConnectOptions } from './agent.js';
export { RealtimeClient, type ConnectionState, type RealtimeEvents, type RealtimeOptions } from './realtime.js';
export { RestClient, type RestClientOptions } from './rest.js';
export { Emitter } from './emitter.js';
export * from '@gish_reloaded/tandryx-protocol';
