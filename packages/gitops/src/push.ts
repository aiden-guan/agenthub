// The only code that writes to the remote (design §2.2.5 P9–P10, §4.3):
// pushTrunk, the compare-and-swap that alone moves trunk, and pushRef, plain
// pushes of land and candidate refs. Plus lsRemote.

import { isAncestor, revParse } from './queries.js';
import { assertRemote, assertSha, firstLine, GitError, redactUrls, runAny, validRefName } from './run.js';
import type { Git, GitResult, PushOutcome } from './types.js';

const DEFAULT_PUSH_TIMEOUT_MS = 120_000;

/** A branch name that makes `refs/heads/<trunk>` a plain ref (no refspec syntax, no pattern). */
function assertTrunk(trunk: string): void {
  if (!validRefName(`refs/heads/${trunk}`)) throw new Error(`gitops: bad trunk branch ${JSON.stringify(trunk)}`);
}

/**
 * The only function that updates trunk. It asserts `C^1 == expected` and
 * `isAncestor(expected, C)` (a matching lease alone would force a
 * non-fast-forward), then runs exactly
 *   git push --atomic --porcelain --force-with-lease=refs/heads/<trunk>:<expected> <remote> <C>:refs/heads/<trunk> [:<deleteRef>]
 * The lease makes it a compare-and-swap on `expected`: a trunk that moved, or
 * was rewound below `expected`, is `stale`, never overwritten.
 */
export async function pushTrunk(g: Git, o: { remote: string; trunk: string; candidate: string; expected: string; deleteRef?: string; timeoutMs?: number }): Promise<PushOutcome> {
  assertRemote(o.remote);
  assertTrunk(o.trunk);
  assertSha(o.candidate, 'candidate');
  assertSha(o.expected, 'expected trunk tip');
  const trunkRef = `refs/heads/${o.trunk}`;
  if (o.deleteRef !== undefined && (!validRefName(o.deleteRef) || o.deleteRef === trunkRef)) throw new Error(`gitops: bad ref to delete ${JSON.stringify(o.deleteRef)}`);

  const parent = await revParse(g, `${o.candidate}^1`);
  if (parent !== o.expected) throw new Error(`gitops: refusing to push ${o.candidate} to ${trunkRef}: its first parent is ${parent ?? 'missing'}, not the expected tip ${o.expected}`);
  if (!(await isAncestor(g, o.expected, o.candidate))) throw new Error(`gitops: refusing to push ${o.candidate} to ${trunkRef}: ${o.expected} is not its ancestor`);

  const args = ['push', '--atomic', '--porcelain', `--force-with-lease=${trunkRef}:${o.expected}`, o.remote, `${o.candidate}:${trunkRef}`];
  if (o.deleteRef !== undefined) args.push(`:${o.deleteRef}`);
  return push(g, args, trunkRef, o.timeoutMs);
}

/**
 * Plain (never forced) push, or deletion, of a ref under `<prefix>land/` or
 * `<prefix>cand/`; any other ref is refused before git runs.
 */
export async function pushRef(g: Git, o: { remote: string; prefix: string; sha: string | null; ref: string; timeoutMs?: number }): Promise<PushOutcome> {
  assertRemote(o.remote);
  if (!o.prefix.endsWith('/') || !validRefName(o.prefix.slice(0, -1))) throw new Error(`gitops: bad ref prefix ${JSON.stringify(o.prefix)}`);
  const allowed = [`${o.prefix}land/`, `${o.prefix}cand/`];
  if (!validRefName(o.ref) || !allowed.some((a) => o.ref.startsWith(a) && o.ref.length > a.length)) {
    throw new Error(`gitops: refusing to push ref ${JSON.stringify(o.ref)}: only refs under ${allowed.join(' and ')} may be pushed`);
  }
  if (o.sha !== null) assertSha(o.sha, 'sha');
  return push(g, ['push', '--porcelain', o.remote, `${o.sha ?? ''}:${o.ref}`], o.ref, o.timeoutMs);
}

async function push(g: Git, args: string[], target: string, timeoutMs = DEFAULT_PUSH_TIMEOUT_MS): Promise<PushOutcome> {
  let r: GitResult;
  try {
    r = await runAny(g, args, { timeoutMs });
  } catch (e) {
    if (e instanceof GitError && e.timedOut) return { kind: 'unknown', detail: `git push timed out after ${timeoutMs} ms` };
    return { kind: 'unknown', detail: redactUrls(e instanceof Error ? e.message : String(e)) };
  }
  return classifyPush(r, target);
}

interface PorcelainLine {
  flag: string;
  from: string;
  to: string;
  summary: string;
}

/** `git push --porcelain` status lines: `<flag> TAB <from>:<to> TAB <summary>`. */
export function porcelainLines(stdout: string): PorcelainLine[] {
  const out: PorcelainLine[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([ +\-*=!])\t([^\t]*)\t(.*)$/.exec(line);
    if (!m) continue;
    const spec = m[2]!;
    const colon = spec.lastIndexOf(':');
    out.push({ flag: m[1]!, from: spec.slice(0, colon), to: spec.slice(colon + 1), summary: m[3]! });
  }
  return out;
}

/**
 * Classify a push by the status line of `target`:
 * - ` ` `+` `*` `-`: ok; `=`: up_to_date;
 * - `!` `[rejected] (stale info | non-fast-forward | fetch first | already exists)`: stale (trunk moved);
 * - `!` `[remote rejected] (…)`: rejected (a host rule or hook; the push did not happen);
 * - `!` because another ref of an atomic push failed: whatever that ref's status was;
 * - no status line (network, a remote that died, a timeout): unknown.
 */
export function classifyPush(r: GitResult, target: string): PushOutcome {
  const lines = porcelainLines(r.stdout);
  const detail = (extra?: string) => redactUrls([extra, firstLine(r.stderr)].filter(Boolean).join('; ')).slice(0, 500);
  const line = lines.find((l) => l.to === target);
  if (!line) return { kind: 'unknown', detail: detail(`git push exited ${r.code} without a status for ${target}`) };
  if (line.flag === '=') return { kind: 'up_to_date' };
  if (line.flag !== '!') return { kind: 'ok' };
  const atomic = (l: PorcelainLine) => /atomic push fail/.test(l.summary);
  // The atomic push failed because of another ref: classify by the cause.
  const cause = atomic(line) ? (lines.find((l) => l.flag === '!' && !atomic(l)) ?? line) : line;
  const summary = `${cause.to}: ${cause.summary}`;
  if (/^\[remote failure\]/.test(cause.summary)) return { kind: 'unknown', detail: detail(summary) };
  if (/^\[rejected\] \((stale info|non-fast-forward|fetch first|already exists)\)/.test(cause.summary)) return { kind: 'stale', detail: detail(summary) };
  return { kind: 'rejected', detail: detail(summary) };
}

/** `git ls-remote` of exactly one ref (ls-remote matches patterns by suffix; only the exact name counts). */
export async function lsRemote(g: Git, remote: string, ref: string): Promise<string | null> {
  assertRemote(remote);
  if (!ref || ref.startsWith('-') || /[\0\n\r]/.test(ref)) throw new Error(`gitops: bad ref ${JSON.stringify(ref)}`);
  const r = await g.run(['ls-remote', remote, ref], { timeoutMs: 60_000 });
  for (const line of r.stdout.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name === ref && sha) return sha;
  }
  return null;
}
