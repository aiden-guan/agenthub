import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { HUMAN_RE } from './landing-requests.js';

// What the server checks before a lander or an approver reaches the hub
// (design §1.2, §1.7): the lander token, the approvers file of per-human
// sha256 token digests, and whether an address is loopback. The Hub itself
// only sees the result, as HubAuth.

const APPROVER_DIGEST_RE = /^sha256:([0-9a-fA-F]{64})$/;

/**
 * The approvers-file entry for a human's approver token: `sha256:` and the
 * hex sha256 of the token. The file holds these, never the tokens.
 */
export function approverTokenDigest(token: string): string {
  return `sha256:${sha256(token).toString('hex')}`;
}

/**
 * Validates the parsed `--approvers` file: a JSON object naming at least one
 * human, `{"maya": "sha256:<64 hex>", ...}`. Returns each name's token digest
 * as bytes. Throws an Error naming the first problem (after `source`, when
 * given, which names where the value came from).
 */
export function parseApprovers(value: unknown, source = ''): Map<string, Buffer> {
  const problem = (message: string) => new Error(source ? `${source}: ${message}` : message);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw problem('expected a JSON object {"<name>": "sha256:<hex of their token>", ...}');
  }
  const out = new Map<string, Buffer>();
  for (const [name, entry] of Object.entries(value)) {
    if (!HUMAN_RE.test(name)) throw problem(`${JSON.stringify(name)} is not a human name (letters, digits, ".", "_" and "-", as in maya)`);
    const m = typeof entry === 'string' ? APPROVER_DIGEST_RE.exec(entry) : null;
    if (!m) throw problem(`the entry for ${name} must be "sha256:" and the 64 hex digits of the sha256 of their token, not the token itself`);
    out.set(name, Buffer.from(m[1].toLowerCase(), 'hex'));
  }
  if (out.size === 0) throw problem('names no approvers; add {"<name>": "sha256:<hex of their token>"} entries, or leave it out to disable approvals');
  return out;
}

/** Reads and validates an approvers file (see parseApprovers); returns its entries, hex lowercased. Errors are one line. */
export function readApproversFile(file: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(e.code === 'ENOENT' ? 'no such file' : `can't read it (${e.code ?? e.message})`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('not JSON; expected {"<name>": "sha256:<hex of their token>", ...}');
  }
  const map = parseApprovers(value);
  return Object.fromEntries([...map].map(([name, digest]) => [name, `sha256:${digest.toString('hex')}`]));
}

/** Whether an approver token is the one whose digest the approvers file holds, in constant time. */
export function approverTokenMatches(token: string, digest: Buffer | undefined): boolean {
  const got = sha256(token);
  // Compare against something of the same length even for an unknown name, so timing tells nothing.
  const same = timingSafeEqual(got, digest ?? DUMMY_DIGEST);
  return same && digest !== undefined && token.length > 0;
}

/** Whether two secrets are equal, in time that depends on neither (their sha256 digests are compared). */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

/** Whether a listening address only accepts connections from this machine (`0.0.0.0` and `::` don't). */
export function isLoopbackAddress(address: string): boolean {
  const v4 = address.replace(/^::ffff:/i, '');
  return isIP(v4) === 4 ? v4.startsWith('127.') : address === '::1';
}

/**
 * Whether a `--host` value binds loopback: a 127.x or ::1 address, or the
 * name localhost. Other names are not known to be loopback until bound.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (isIP(h) !== 0) return isLoopbackAddress(h);
  return h === 'localhost' || h.endsWith('.localhost');
}

const DUMMY_DIGEST = Buffer.alloc(32);

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}
