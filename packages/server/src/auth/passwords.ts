import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing uses scrypt from Node's own crypto module.
 *
 * Argon2id would be the textbook choice, but every Node binding for it is a
 * native module: it turns `npm install` into a compiler invocation and breaks
 * on machines without build tools. scrypt is memory-hard, standardised
 * (RFC 7914), and ships with the runtime — for a self-hosted collaboration
 * server that is the better trade. Parameters below are the OWASP-recommended
 * scrypt settings (N=2^16, r=8, p=1).
 */
const PARAMS = { N: 65_536, r: 8, p: 1, keylen: 64, saltBytes: 16 } as const;
const MAXMEM = 256 * 1024 * 1024;

/** Encoded as `scrypt$N$r$p$salt$hash`, all binary parts base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PARAMS.saltBytes);
  const derived = await scrypt(password.normalize('NFKC'), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: MAXMEM,
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string];
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const salt = Buffer.from(saltRaw, 'base64url');
  const expected = Buffer.from(hashRaw, 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Basic strength check. Deliberately not a policy engine: length is what
 * actually matters, and complexity rules mostly produce `Password1!`.
 */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('must be at least 12 characters long');
  if (password.length > 200) problems.push('must be at most 200 characters long');
  if (/^\s|\s$/.test(password)) problems.push('must not start or end with whitespace');
  return problems;
}
