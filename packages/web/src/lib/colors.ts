/**
 * Participant colours.
 *
 * The server assigns each account and agent one of nine named colours, once,
 * for life. The web client maps those names to values chosen for legibility on
 * this UI rather than using the raw CSS keywords: `yellow` and `cyan` on a dark
 * background are painful to read, and `blue` on a light one disappears.
 *
 * Two values per colour: one for text on the panel background, one for the
 * avatar tile it sits on.
 */
export interface ParticipantColor {
  text: string;
  tile: string;
}

const DARK: Record<string, ParticipantColor> = {
  red: { text: '#f87171', tile: '#dc2626' },
  blue: { text: '#60a5fa', tile: '#2563eb' },
  green: { text: '#4ade80', tile: '#16a34a' },
  skyblue: { text: '#7dd3fc', tile: '#0284c7' },
  violet: { text: '#c084fc', tile: '#7c3aed' },
  pink: { text: '#f9a8d4', tile: '#db2777' },
  orange: { text: '#fdba74', tile: '#ea580c' },
  yellow: { text: '#fde047', tile: '#ca8a04' },
  cyan: { text: '#67e8f9', tile: '#0891b2' },
};

const LIGHT: Record<string, ParticipantColor> = {
  red: { text: '#dc2626', tile: '#ef4444' },
  blue: { text: '#1d4ed8', tile: '#2563eb' },
  green: { text: '#15803d', tile: '#16a34a' },
  skyblue: { text: '#0369a1', tile: '#0284c7' },
  violet: { text: '#6d28d9', tile: '#7c3aed' },
  pink: { text: '#be185d', tile: '#db2777' },
  orange: { text: '#c2410c', tile: '#ea580c' },
  yellow: { text: '#a16207', tile: '#ca8a04' },
  cyan: { text: '#0e7490', tile: '#0891b2' },
};

const FALLBACK: ParticipantColor = { text: 'var(--text)', tile: '#6b7280' };

function prefersDark(): boolean {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'dark') return true;
  if (explicit === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

/** Resolve a participant's assigned colour name into usable values. */
export function participantColor(name: string | null | undefined): ParticipantColor {
  if (!name) return FALLBACK;
  const table = prefersDark() ? DARK : LIGHT;
  // Accounts created before colours were named still carry a hex value; using
  // it directly is better than showing them all in the fallback grey.
  if (name.startsWith('#')) return { text: name, tile: name };
  return table[name.toLowerCase()] ?? FALLBACK;
}
