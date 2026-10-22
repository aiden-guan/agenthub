// Trailers and the landing identity (design §1.1): sanitizing agent text so
// it can't forge trailers, reading trunk's first-parent trailers, the
// three-key identity, and the landed base.

import { isAncestorIfPresent, mergeBase, presentCommits } from './queries.js';
import { assertRev, FULL_SHA_RE, validRepoPath } from './run.js';
import type { Git, LandedBase, LandingTrailers } from './types.js';

// gitops has no dependencies, so these mirror TRAILER and TRAILER_LINE_RE of
// @agenthub/contract (the tests check they agree).
export const TRAILER_KEYS = {
  landing: 'Agenthub-Landing',
  hub: 'Agenthub-Hub',
  source: 'Agenthub-Source',
  attempt: 'Agenthub-Attempt',
  task: 'Agenthub-Task',
  agent: 'Agenthub-Agent',
  resolved: 'Agenthub-Resolved',
  checked: 'Agenthub-Checked',
} as const;
/** One line of agent text that would read as an Agenthub trailer. */
const TRAILER_LINE = /^\s*Agenthub-[A-Za-z-]*\s*:/i;

/**
 * C0 and C1 controls (but tab and newline), DEL, bidi controls, zero-width
 * and other invisible format characters: removed from agent text, so nothing
 * in a commit message hides or reorders what a reader sees.
 */
const INVISIBLE_RE = /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}-\u{9F}\u{AD}\u{61C}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{FEFF}\u{FFF9}-\u{FFFB}]/gu;

/** Strips TRAILER_LINE_RE lines and control/bidi characters; caps length (in UTF-16 units, an ellipsis included). */
export function sanitizeMessageText(s: string, max: number): string {
  const lines = s
    .replace(/\r\n?|[\u{2028}\u{2029}\u{85}]/gu, '\n')
    .replace(INVISIBLE_RE, '')
    .split('\n')
    .filter((line) => !TRAILER_LINE.test(line));
  const text = lines.join('\n');
  if (max <= 0) return '';
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const FIELDS = ['landing', 'hub', 'source', 'attempt', 'task', 'agent', 'resolved', 'checked'] as const;
const FORMAT = `%H%x00${FIELDS.map((f) => `%(trailers:key=${TRAILER_KEYS[f]},valueonly,unfold,separator=%x01)%x00`).join('')}`;

const SUBJECT_FORMAT = `%H%x00%s%x00${FIELDS.map((f) => `%(trailers:key=${TRAILER_KEYS[f]},valueonly,unfold,separator=%x01)%x00`).join('')}`;

function parseTrailerLog(stdout: string): LandingTrailers[];
function parseTrailerLog(stdout: string, withSubject: true): Array<LandingTrailers & { subject: string }>;
function parseTrailerLog(stdout: string, withSubject = false): Array<LandingTrailers & { subject?: string }> {
  const parts = stdout.split('\0');
  const out: Array<LandingTrailers & { subject?: string }> = [];
  const skip = withSubject ? 2 : 1;
  const per = FIELDS.length + skip;
  for (let i = 0; i + per <= parts.length; i += per) {
    const sha = parts[i]!.trim();
    if (!FULL_SHA_RE.test(sha)) break;
    const rec: LandingTrailers & { subject?: string } = { sha, landing: null, hub: null, source: null, attempt: null, task: null, agent: null, resolved: null, checked: null };
    if (withSubject) rec.subject = parts[i + 1]!;
    FIELDS.forEach((f, j) => {
      // A key given twice with different values is ambiguous: no lander writes that, so it counts as absent.
      const values = [...new Set(parts[i + skip + j]!.split('\u0001').map((v) => v.trim()).filter((v) => v.length > 0))];
      rec[f] = values.length === 1 ? values[0]! : null;
    });
    out.push(rec);
  }
  return out;
}

async function logTrailers(g: Git, from: string | null, to: string, extra: string[]): Promise<LandingTrailers[]> {
  assertRev(to);
  if (from !== null) assertRev(from);
  const r = await g.run(['log', '--first-parent', `--format=${FORMAT}`, ...extra, to, ...(from !== null ? [`^${from}`] : [])]);
  return parseTrailerLog(r.stdout).reverse();
}

/** First-parent commits after `from` (exclusive) up to `to`, oldest first; with `limit`, the newest `limit` of them. */
export async function trunkTrailers(g: Git, from: string | null, to: string, limit?: number): Promise<LandingTrailers[]> {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`gitops: bad limit ${limit}`);
  return logTrailers(g, from, to, limit !== undefined ? [`-n${limit}`] : []);
}

/**
 * First-parent commits in from..to (from exclusive; null = all) that changed
 * `path` against their first parent, newest first, at most `limit`, with
 * their subjects and Agenthub trailers: who changed the trunk side of a
 * conflicted file (design §2.2.6 step 4, `trunk_changes`).
 */
export async function pathHistory(g: Git, from: string | null, to: string, path: string, limit: number): Promise<Array<LandingTrailers & { subject: string }>> {
  assertRev(to);
  if (from !== null) assertRev(from);
  if (!validRepoPath(path)) throw new Error(`gitops: bad path ${JSON.stringify(path)}`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`gitops: bad limit ${limit}`);
  const r = await g.run(['log', '--first-parent', `-n${limit}`, `--format=${SUBJECT_FORMAT}`, to, ...(from !== null ? [`^${from}`] : []), '--', path], {
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  return parseTrailerLog(r.stdout, true);
}

/**
 * The first-parent commit in from..to whose Landing, Hub and Source trailers
 * all match (design §1.1 "Identity"), or null. A recreated database reuses
 * landing ids but not its epoch, and an agent's own commits merged some other
 * way are never first-parent, so neither can match.
 */
export async function findLandingCommit(g: Git, from: string | null, to: string, key: { landing: string; hub: string; source: string }): Promise<string | null> {
  if (!key.landing || !key.hub || !FULL_SHA_RE.test(key.source)) return null;
  // Only commits that mention the source sha can carry it as a trailer: let git skip the rest.
  const candidates = await logTrailers(g, from, to, ['--fixed-strings', `--grep=${key.source}`]);
  return candidates.find((c) => c.landing === key.landing && c.hub === key.hub && c.source === key.source)?.sha ?? null;
}

/**
 * design §1.1 "Landed base":
 *   1. B = merge-base(trunk, tip);
 *   2. S* = the newest Agenthub-Source on trunk's first-parent history (depth, any epoch) that is an ancestor of tip;
 *   3. the base is S* if it exists and is not an ancestor of B, else B.
 */
export async function landedBase(g: Git, trunk: string, tip: string, depth = 500): Promise<LandedBase> {
  assertRev(trunk);
  assertRev(tip);
  if (!Number.isInteger(depth) || depth < 1) throw new Error(`gitops: bad depth ${depth}`);
  const b = await mergeBase(g, trunk, tip);
  if (!b) throw new Error(`gitops: ${tip} has no history in common with ${trunk}`);
  const atB: LandedBase = { base: b, landedSource: null, reason: 'merge-base' };

  const log = await g.run(['log', '--first-parent', `-n${depth}`, `--format=%(trailers:key=${TRAILER_KEYS.source},valueonly,unfold,separator=%x00)%x00`, trunk]);
  const sources = [...new Set(log.stdout.split('\0').map((s) => s.trim()).filter((s) => FULL_SHA_RE.test(s)))];
  if (sources.length === 0) return atB;

  // An ancestor of tip that is not an ancestor of B is exactly a commit in B..tip.
  const ahead = new Set((await g.run(['rev-list', tip, `^${b}`])).stdout.split('\n').filter(Boolean));
  const first = sources.findIndex((s) => ahead.has(s));
  // Any newer source that is an ancestor of tip is an ancestor of B (it isn't in B..tip): then S* is that one, and the base is B.
  const newer = first < 0 ? sources : sources.slice(0, first);
  const present = await presentCommits(g, newer);
  for (const batch of chunks(newer.filter((s) => present.has(s)), 8)) {
    const anc = await Promise.all(batch.map((s) => isAncestorIfPresent(g, s, b)));
    if (anc.some(Boolean)) return atB;
  }
  if (first < 0) return atB;
  return { base: sources[first]!, landedSource: sources[first]!, reason: 'landed-source' };
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
