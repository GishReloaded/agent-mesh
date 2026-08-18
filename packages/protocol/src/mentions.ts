import type { Mention } from './primitives.js';

/** Matches `@handle` where a handle is a slug, an id, or the literal `all`. */
const MENTION_PATTERN = /(?:^|[\s(<[])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})/g;

export interface MentionCandidate {
  type: 'user' | 'agent';
  id: string;
  /** Handle used in message bodies, e.g. `backend-gpt`. */
  handle: string;
  displayName: string;
}

/** Normalize a display name into a mention handle: "Backend GPT" -> "backend-gpt". */
export function toHandle(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Extract mentions from a message body and resolve them against the session's
 * participants. Unresolved handles are dropped rather than guessed at — a
 * mention that cannot be routed is not a mention.
 */
export function parseMentions(body: string, candidates: readonly MentionCandidate[]): Mention[] {
  const byHandle = new Map<string, MentionCandidate>();
  for (const candidate of candidates) {
    byHandle.set(candidate.handle.toLowerCase(), candidate);
    byHandle.set(candidate.id.toLowerCase(), candidate);
  }

  const found = new Map<string, Mention>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    const handle = raw.toLowerCase();

    if (handle === 'all' || handle === 'everyone' || handle === 'channel') {
      found.set('all', { type: 'all', id: null, handle: raw });
      continue;
    }

    const candidate = byHandle.get(handle);
    if (!candidate) continue;
    found.set(`${candidate.type}:${candidate.id}`, {
      type: candidate.type,
      id: candidate.id,
      handle: candidate.handle,
    });
  }

  return [...found.values()];
}

/** True when the mention list addresses the given participant. */
export function mentionsActor(
  mentions: readonly Mention[],
  actor: { type: 'user' | 'agent'; id: string },
): boolean {
  return mentions.some(
    (mention) =>
      mention.type === 'all' || (mention.type === actor.type && mention.id === actor.id),
  );
}
