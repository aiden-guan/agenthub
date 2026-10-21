import { PATH_FORBIDDEN_RE, type Claim, type ClaimConflict, type HubEventType, type ScopeEntry, type Task } from './protocol.js';
import type { Store } from './store.js';

// What hub.ts shares with the modules it delegates to (landings.ts, holds.ts):
// the error type, the text and path rules, and the narrow view of the hub's
// internals those modules get. Nothing here imports hub.ts, so there is no
// import cycle.

export class HubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    /** Structured data sent with the error (claim_conflict: { conflicts }). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

/**
 * What the caller proved besides its agent id (design §1.7), as the server
 * computes it from the request headers. `lander`: a lander route with a valid
 * lander token (or a loopback hub without one). `approver`: the human name a
 * valid approver token belongs to. Tests pass it directly.
 */
export interface HubAuth {
  lander: boolean;
  approver: string | null;
}

/** An agent request with no lander or approver credentials. */
export const NO_AUTH: Readonly<HubAuth> = Object.freeze({ lander: false, approver: null });

/**
 * What the landing and hold helpers may do inside the hub's one write path.
 * Every call happens inside `Hub.write`, so it is serialized with claim
 * decisions and its events publish only once the transaction commits.
 */
export interface HubInternals {
  readonly store: Store;
  /** The hub's default lease TTL and heartbeat interval: a hold's, and the lease it turns back into. */
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
  emit(project: string, type: HubEventType, actor: string | null, data: Record<string, unknown>, targets?: string[] | null): void;
  /** The single place a claim ends. */
  endClaim(project: string, c: Claim, status: 'released' | 'expired', reason: string, now: number): Claim;
  promoteQueued(project: string, now: number): Claim[];
  /**
   * Ends the agent's queued claims that wait, directly or through others, for
   * the agent itself, then promotes what that frees. claim() never queues such
   * a claim, but a hold turned back into a lease can close a cycle.
   */
  breakWaitCycles(project: string, agent: string, now: number, reason: string): Claim[];
  announceUnblocked(project: string, doneId: string, actor: string): string[];
  touch(project: string, agent: string, now: number): void;
  withBlocked(project: string, task: Omit<Task, 'blocked_by'>): Task;
  /** Throws 409 task_blocked when a dependency isn't done. */
  assertUnblocked(project: string, task: Pick<Task, 'id' | 'deps'>, what: 'taken' | 'completed' | 'landed'): void;
}

const MAX_PATH = 4096;

/**
 * The claim key for a repo-relative POSIX path: the NFC form of the path as
 * sent, nothing else changed, so every client names a file the same way.
 * Refuses PATH_FORBIDDEN_RE characters, absolute paths (`/x`, or a Windows
 * drive root like `C:/x`) and `.`, `..` or empty segments. `a:b.md` and
 * `..env` are legal.
 */
export function normalizeRepoPath(input: unknown): string {
  if (typeof input !== 'string') throw new HubError('invalid_path', 'file paths must be strings');
  const p = input.normalize('NFC');
  const bad = PATH_FORBIDDEN_RE.exec(p);
  if (bad) throw invalidPath(p, `contains ${codePoint(bad[0])}; control, line-separator and bidi characters and unpaired surrogates are not allowed`);
  if (p.length > MAX_PATH) throw invalidPath(p, `is longer than ${MAX_PATH} characters`);
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) throw invalidPath(p, 'is absolute; use a path relative to the repository root');
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw invalidPath(p, 'has a ".", ".." or empty segment');
  }
  return p;
}

function invalidPath(p: string, reason: string): HubError {
  return new HubError('invalid_path', `invalid path ${escapePath(p)}: ${reason}`);
}

/** JSON-quote a path for a message with every invisible or line-breaking character escaped; long paths are cut short. */
function escapePath(p: string): string {
  const shown = p.length > 200 ? `${p.slice(0, 200)}…` : p;
  return JSON.stringify(shown).replace(/[\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

function codePoint(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Strip control and bidi-override characters, collapse whitespace unless multiline, cap length. */
export function cleanText(value: unknown, max: number, multiline = false): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HubError('bad_request', 'expected a string');
  let s = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '');
  s = multiline ? s.replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return capText(s.trim(), max);
}

/** `s`, cut to at most `max` characters with a trailing ellipsis, never between the halves of a surrogate pair. */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  if (/[\uD800-\uDBFF]/.test(s[end - 1] ?? '')) end--;
  return `${s.slice(0, end)}…`;
}

/**
 * A task or claim id from a request body: a string, or a number taken as its
 * digits; missing or empty means none. Anything else is refused with 400, not
 * handed to the store (which would fail with a 500).
 */
export function idOf(value: unknown, name: 'task_id' | 'claim_id'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new HubError('bad_request', `${name} must be an id such as ${name === 'task_id' ? 'T-3' : 'C-3'}`);
}

export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function claimFiles(c: Pick<Claim, 'scope'>): string[] {
  return unique(c.scope.map((s) => s.file));
}

/** `file` or `file#symbol`, as agents and messages name an entry. */
export function entryName(e: ScopeEntry): string {
  return e.symbol === undefined ? e.file : `${e.file}#${e.symbol}`;
}

/**
 * Another agent's claim `c` in the way of a request for `files`. `scope` is
 * the claim's entries that overlap the request (by default those in `files`).
 */
export function toConflict(c: Claim, files: string[], scope?: ScopeEntry[]): ClaimConflict {
  const overlap = scope ?? c.scope.filter((s) => files.includes(s.file));
  return {
    claim_id: c.id,
    holder: c.holder,
    mode: c.mode,
    status: c.status,
    intent: c.intent,
    task_id: c.task_id,
    files: scope ? claimFiles({ scope: overlap }) : claimFiles(c).filter((f) => files.includes(f)),
    expires_at: c.expires_at,
    scope: overlap,
    landing_id: c.landing_id,
  };
}
