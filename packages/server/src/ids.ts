import { ulid } from 'ulid';

/**
 * Prefixed ULIDs. The prefix makes ids self-describing in logs and API
 * responses; the ULID body keeps them lexicographically sortable by creation
 * time, which is convenient for debugging and harmless to expose.
 */
export const IdPrefix = {
  User: 'usr',
  Session: 'ses',
  Member: 'mem',
  Invite: 'inv',
  Agent: 'agt',
  Event: 'evt',
  Message: 'msg',
  Task: 'tsk',
  Context: 'ctx',
  Revision: 'rev',
  RefreshToken: 'rtk',
  Frame: 'frm',
} as const;

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
