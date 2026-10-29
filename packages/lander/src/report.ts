// What the lander writes (design §1.1, §2.2.6 step 4, §2.2.8, §2.2.9): the
// candidate's commit message with its trailers, the fix-it conflict report,
// and the send-back texts. Every text here is the lander's own; agent-written
// text (summaries, task titles, commit subjects) only enters through
// sanitizeMessageText, and code or check output only in the fields the
// protocol marks untrusted.

import { createHash } from 'node:crypto';
import { humanOf, landingKey, TRAILER } from '@agenthub/contract';
import { sanitizeMessageText, type ConflictEntry } from '@agenthub/gitops';
import type {
  ApprovalKind,
  ApprovalRequirement,
  ConflictHunk,
  ConflictReport,
  Decision,
  Landing,
  LandingFailureCode,
  LandingReport,
  ResolvedBy,
  Task,
  TrunkChange,
} from '@agenthub/hub/protocol';
import type { GitPort, HubPort, PathChange } from './ports.js';
import { hunkSymbols } from './symbols.js';

export const SUBJECT_MAX = 72;
export const SUMMARY_MAX = 4000;
export const LISTED_COMMITS = 20;
export const MAX_HUNKS = 10;
export const MAX_TRUNK_CHANGES = 5;
export const MAX_DECISIONS = 3;
export const HUNK_SIDE_LINES = 80;
export const HUNK_SIDE_BYTES = 4096;
/** Agent text quoted in a report (another agent's summary, a decision): untrusted, and short. */
const QUOTE_MAX = 500;
const LISTED_PATHS = 10;

/** First 12 hex of sha256 of the check command: the Agenthub-Checked trailer and CheckReport.command_hash. */
export function commandHash(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex').slice(0, 12);
}

/** C0/C1 controls and bidi/zero-width characters: never in a line the lander writes. */
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g;

/** One line of text for a lander-written sentence (a path, a name): no controls, no line breaks. */
function plain(s: string): string {
  return s.replace(UNPRINTABLE_RE, '?');
}

/** Agent text reduced to one trimmed line (trailer lines and controls removed), capped. */
function firstLine(s: string | null | undefined, max: number): string {
  const line =
    sanitizeMessageText(s ?? '', 10_000)
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find((l) => l.length > 0) ?? '';
  return cap(line, max);
}

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Agent text quoted as data in a report: sanitized and capped, paragraphs kept. */
function quote(s: string | null | undefined, max = QUOTE_MAX): string {
  return sanitizeMessageText(s ?? '', max).trim();
}

// ------------------------------------------------------------------ the commit message (design §1.1)

export interface ResolvedTrailer {
  /** Paths whose stage-2 (structural driver) result was taken. */
  structural: string[];
  /** Paths the AI resolver resolved, and its model. */
  ai: { model: string; paths: string[] } | null;
}

export interface CommitMessageInput {
  project: string;
  landingId: string;
  /** The hub database's epoch (Agenthub-Hub). */
  epoch: string;
  /** The landed commit H (Agenthub-Source). */
  source: string;
  attempt: number;
  agent: string;
  taskId: string | null;
  /** Agent-written: sanitized here. */
  taskTitle: string | null;
  /** Agent-written: sanitized here, at most 4000 characters. */
  summary: string;
  /** The squashed commits (base..H), oldest first, and how many there are in all. */
  commits: { total: number; commits: Array<{ sha: string; subject: string }> };
  resolved: ResolvedTrailer;
  /** Trunk's check command (Agenthub-Checked is its hash). */
  checkCommand: string;
  /** Approvals the landing needed, in the order granted (Agenthub-Approved). */
  approvals: Array<{ kind: ApprovalKind; by: string }>;
}

/** The Agenthub-Resolved value: `clean`, `structural <paths>`, `ai:<model> <paths>`, or both kinds separated by `; `. */
export function resolvedValue(r: ResolvedTrailer): string {
  const paths = (ps: string[]) => ps.slice(0, LISTED_PATHS).map(plain).join(' ') + (ps.length > LISTED_PATHS ? ` (+${ps.length - LISTED_PATHS} more)` : '');
  const parts: string[] = [];
  if (r.structural.length > 0) parts.push(`structural ${paths(r.structural)}`);
  if (r.ai && r.ai.paths.length > 0) parts.push(`ai:${plain(r.ai.model)} ${paths(r.ai.paths)}`);
  return parts.length > 0 ? parts.join('; ') : 'clean';
}

/** A trailer value is the lander's own (ids, shas, names); a line break in one is a bug, never written. */
function trailer(key: string, value: string | number): string {
  const v = String(value);
  if (!v || /[\u0000-\u001f\u007f]/.test(v)) throw new Error(`lander: bad ${key} trailer value ${JSON.stringify(v)}`);
  return `${key}: ${v}`;
}

/**
 * The candidate's message (design §1.1): subject (task title, else the
 * summary's first line, ≤ 72 characters) with the landing id, the sanitized
 * summary, the squashed commits, and the Agenthub trailers as the last
 * paragraph, so git reads exactly these and nothing an agent wrote.
 */
export function commitMessage(i: CommitMessageInput): string {
  const summary = sanitizeMessageText(i.summary, SUMMARY_MAX)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const subject = firstLine(i.taskTitle, SUBJECT_MAX) || firstLine(summary, SUBJECT_MAX) || `Landing ${i.landingId}`;
  const parts = [`${subject} (${i.landingId})`];
  if (summary) parts.push(summary);
  if (i.commits.total > 0) {
    const listed = i.commits.commits.slice(0, LISTED_COMMITS);
    const lines = [`Squashed from ${i.commits.total} commit${i.commits.total === 1 ? '' : 's'}:`];
    for (const c of listed) {
      const s = firstLine(c.subject, 100);
      lines.push(`- ${c.sha.slice(0, 12)}${s ? ` ${s}` : ''}`);
    }
    if (i.commits.total > listed.length) lines.push(`- … and ${i.commits.total - listed.length} more`);
    parts.push(lines.join('\n'));
  }
  const trailers = [
    trailer(TRAILER.landing, landingKey(i.project, i.landingId)),
    trailer(TRAILER.hub, i.epoch),
    trailer(TRAILER.source, i.source),
    trailer(TRAILER.attempt, i.attempt),
    ...(i.taskId ? [trailer(TRAILER.task, i.taskId)] : []),
    trailer(TRAILER.agent, i.agent),
    trailer(TRAILER.resolved, resolvedValue(i.resolved)),
    trailer(TRAILER.checked, commandHash(i.checkCommand)),
    ...(i.approvals.length > 0 ? [trailer(TRAILER.approved, i.approvals.map((a) => `${a.kind}:${a.by}`).join(', '))] : []),
  ];
  parts.push(trailers.join('\n'));
  return `${parts.join('\n\n')}\n`;
}

// ------------------------------------------------------------------ check reports

/** design §2.2.8: one shell line that rebuilds the exact checked tree on the agent's machine and runs the check. */
export function reproduceLine(o: { remote: string; candidateRef: string; candidate: string; landingId: string; command: string }): string {
  const dir = `/tmp/agenthub-${o.landingId}`;
  return `git fetch ${o.remote} ${o.candidateRef} && git worktree add ${dir} ${o.candidate} && (cd ${dir} && ${o.command})`;
}

// ------------------------------------------------------------------ conflict hunks

export interface MarkedHunk {
  /** Lines of the conflict-marked file, 1-based, marker lines included. */
  start_line: number;
  end_line: number;
  trunk: string;
  base: string;
  yours: string;
}

/**
 * The conflict regions of `git merge-file -p --diff3` output whose markers
 * are `markerSize` long (`<<<<<<< trunk`, `||||||| base`, `=======`,
 * `>>>>>>> yours`), in file order.
 */
export function parseConflictMarkers(text: string, markerSize = 7): MarkedHunk[] {
  const [lt, bar, eq, gt] = ['<', '|', '=', '>'].map((c) => c.repeat(markerSize)) as [string, string, string, string];
  // A CRLF file's marker lines end in '\r'; the sides keep their line endings as they are.
  const bare = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);
  const isMarker = (line: string, m: string) => bare(line) === m || line.startsWith(`${m} `);
  const join = (ls: string[]) => ls.map((l) => `${l}\n`).join('');
  const out: MarkedHunk[] = [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let side: 'trunk' | 'base' | 'yours' | null = null;
  let start = 0;
  let sides: Record<'trunk' | 'base' | 'yours', string[]> = { trunk: [], base: [], yours: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (side === null) {
      if (isMarker(line, lt)) {
        side = 'trunk';
        start = i + 1;
        sides = { trunk: [], base: [], yours: [] };
      }
    } else if (side === 'trunk' && isMarker(line, bar)) side = 'base';
    else if (side !== 'yours' && bare(line) === eq) side = 'yours';
    else if (side === 'yours' && isMarker(line, gt)) {
      out.push({ start_line: start, end_line: i + 1, trunk: join(sides.trunk), base: join(sides.base), yours: join(sides.yours) });
      side = null;
    } else sides[side].push(line);
  }
  return out;
}

/** One side of a hunk, capped at 80 lines or 4 KiB, with a line saying how much was left out. */
export function capSide(text: string, maxLines = HUNK_SIDE_LINES, maxBytes = HUNK_SIDE_BYTES): string {
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  if (text === '' || (lines.length <= maxLines && Buffer.byteLength(text) <= maxBytes)) return text;
  const marker = (n: number) => (n > 0 ? `… (${n} more line${n === 1 ? '' : 's'})\n` : '');
  const size = (kept: string[]) => Buffer.byteLength(kept.map((l) => `${l}\n`).join('') + marker(lines.length - kept.length));
  const kept = lines.slice(0, maxLines);
  while (kept.length > 0 && size(kept) > maxBytes) kept.pop();
  if (kept.length === 0) {
    // Not even the first line fits: keep the start of it.
    const room = maxBytes - Buffer.byteLength(`…\n${marker(lines.length - 1)}`);
    return `${headBytes(lines[0]!, room)}…\n${marker(lines.length - 1)}`;
  }
  return kept.map((l) => `${l}\n`).join('') + marker(lines.length - kept.length);
}

function headBytes(s: string, n: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= n) return s;
  let end = Math.max(0, n);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

// ------------------------------------------------------------------ the fix-it conflict report (design §2.2.6 step 4)

export interface ConflictReporterOptions {
  git: Pick<GitPort, 'mergeFile' | 'pathHistory'>;
  hub: Pick<HubPort, 'landing' | 'tasks' | 'decisions'>;
  project: string;
  /** The hub database's epoch: only trailers carrying it can name this hub's landings. */
  epoch: string;
  /** The landed base the attempt merged from, and the trunk tip T0. */
  base: string;
  trunk: string;
  /** Told about a part of the report that couldn't be built (it is left empty). */
  onError?: (what: string, err: unknown) => void;
}

/**
 * Builds ConflictReports for one attempt. Hub reads are shared across the
 * attempt's files, and best effort: a trunk commit is attributed to a landing
 * only when its Landing, Hub and Source trailers name a landing of this hub
 * whose commit is that source (the identity of design §1.1). Anything else is
 * reported as pushed outside the queue.
 */
export class ConflictReporter {
  private readonly landings = new Map<string, Promise<Landing | null>>();
  private readonly changes = new Map<string, Promise<TrunkChange[]>>();
  private decisionList: Promise<Decision[]> | null = null;
  private taskList: Promise<Task[]> | null = null;

  constructor(private readonly o: ConflictReporterOptions) {}

  async report(entry: ConflictEntry, o: { tried: ResolvedBy[]; aiEligible: boolean; explanation: string | null }): Promise<ConflictReport> {
    const [hunks, trunkChanges] = await Promise.all([this.hunks(entry), this.trunkChanges(entry.path)]);
    return { file: entry.path, kind: entry.kind, hunks, trunk_changes: trunkChanges, tried: [...o.tried], ai_eligible: o.aiEligible, explanation: o.explanation };
  }

  /**
   * Content conflicts only: the regions of merge-file's diff3 output, at most
   * 10, each side capped, each with the declarations it lies in (Phase 3).
   */
  async hunks(entry: ConflictEntry): Promise<ConflictHunk[]> {
    if (entry.kind !== 'content') return [];
    try {
      const merged = await this.o.git.mergeFile({ trunk: entry.stages[2] ?? null, base: entry.stages[1] ?? null, yours: entry.stages[3] ?? null });
      const symbols = await hunkSymbols(entry.path, merged.text, merged.markerSize).catch((err: unknown) => {
        this.o.onError?.(`declarations of the hunks of ${entry.path}`, err);
        return new Map<number, string[]>();
      });
      return parseConflictMarkers(merged.text, merged.markerSize)
        .slice(0, MAX_HUNKS)
        .map((h) => ({ start_line: h.start_line, end_line: h.end_line, symbols: symbols.get(h.start_line) ?? [], base: capSide(h.base), trunk: capSide(h.trunk), yours: capSide(h.yours) }));
    } catch (err) {
      this.o.onError?.(`hunks of ${entry.path}`, err);
      return [];
    }
  }

  /** The trunk commits since the base that changed `path`, newest first, at most 5, attributed. */
  trunkChanges(path: string): Promise<TrunkChange[]> {
    let p = this.changes.get(path);
    if (!p) {
      p = (async () => {
        try {
          const commits = await this.o.git.pathHistory(this.o.base, this.o.trunk, path, MAX_TRUNK_CHANGES);
          return await Promise.all(commits.map((c) => this.attribute(c, path)));
        } catch (err) {
          this.o.onError?.(`trunk changes of ${path}`, err);
          return [];
        }
      })();
      this.changes.set(path, p);
    }
    return p;
  }

  private async attribute(c: PathChange, path: string): Promise<TrunkChange> {
    const foreign: TrunkChange = { commit: c.sha, landing_id: null, agent: null, task_id: null, summary: firstLine(c.subject, QUOTE_MAX), decisions: [] };
    const prefix = `${this.o.project}/`;
    if (c.hub !== this.o.epoch || !c.landing?.startsWith(prefix) || !c.source) return foreign;
    const id = c.landing.slice(prefix.length);
    if (!/^L-[1-9][0-9]*$/.test(id)) return foreign;
    const landing = await this.landing(id);
    if (!landing || landing.commit !== c.source) return foreign;
    const summary = quote(landing.summary) || (landing.task_id ? await this.taskTitle(landing.task_id) : '');
    return { commit: c.sha, landing_id: id, agent: landing.agent, task_id: landing.task_id, summary, decisions: await this.decisionsFor(landing, path) };
  }

  private landing(id: string): Promise<Landing | null> {
    let p = this.landings.get(id);
    if (!p) {
      p = this.o.hub.landing(id).catch(() => null);
      this.landings.set(id, p);
    }
    return p;
  }

  private async taskTitle(id: string): Promise<string> {
    this.taskList ??= this.o.hub.tasks().catch(() => []);
    return firstLine((await this.taskList).find((t) => t.id === id)?.title, QUOTE_MAX);
  }

  /** The landing's decisions, newest first: those of its task, or (without a task) the author's that name the file. */
  private async decisionsFor(landing: Landing, path: string): Promise<Array<{ id: string; summary: string }>> {
    this.decisionList ??= this.o.hub.decisions(200).catch(() => []);
    const all = await this.decisionList;
    const mine = all.filter((d) => (landing.task_id !== null ? d.task_id === landing.task_id : d.agent === landing.agent && d.files.includes(path)));
    return mine.slice(0, MAX_DECISIONS).map((d) => ({ id: d.id, summary: firstLine(d.summary, 300) }));
  }
}

// ------------------------------------------------------------------ send-back texts (design §2.2.9, §2.3.3)

export interface SendbackContext {
  landingId: string;
  taskId: string | null;
  /** The trunk branch's name (`main`). */
  trunk: string;
  /** The failed landing's retry count (0 for a first landing). */
  retry: number;
  keepPlaceRetries: number;
  sendbackGraceMin: number;
  command?: string;
  reproduce?: string;
  exitCode?: number | null;
  durationMs?: number;
  failedTests?: string[];
  checkTimeoutMin?: number;
  conflictFiles?: string[];
  /** too_large: how many files the change touches, and trunk's limit. */
  files?: number;
  maxFiles?: number;
  /** contains_unlanded: the landing the branch contains. */
  unlanded?: { landingId: string; agent: string } | null;
  protectedPaths?: string[];
  /** Who may approve; null = any approver. */
  approvers?: string[] | null;
}

function listPaths(paths: string[] | undefined, n = 5): string {
  const ps = (paths ?? []).map(plain);
  if (ps.length === 0) return 'your files';
  return ps.length <= n ? ps.join(', ') : `${ps.slice(0, n).join(', ')} and ${ps.length - n} more`;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Whether the next re-land keeps the queue place (design §1.4 T1, keepPlaceRetries). */
function place(ctx: SendbackContext): string {
  const next = ctx.retry + 1;
  return next <= ctx.keepPlaceRetries
    ? `you keep your place (retry ${next} of ${ctx.keepPlaceRetries})`
    : `it goes to the back of the queue (the ${ctx.keepPlaceRetries} retries that keep a place are used up)`;
}

/** Failure codes the change didn't cause: lander, remote or trunk trouble, or a human's call. */
const NOT_THE_CHANGE: ReadonlySet<LandingFailureCode> = new Set(['trunk_busy', 'push_rejected', 'lander_lost', 'lander_stuck', 'lander_error']);

/** What happened, in a few words, for the report message and the direct message. */
function what(code: LandingFailureCode, ctx: SendbackContext): string {
  const tests = ctx.failedTests?.length ? `; ${ctx.failedTests.length} failing test${ctx.failedTests.length === 1 ? '' : 's'}` : '';
  const ran = ctx.command ? `\`${ctx.command}\`` : 'the check';
  switch (code) {
    case 'not_pushed':
      return 'not_pushed (its land ref is missing or does not point at the commit)';
    case 'nothing_to_land':
      return `nothing_to_land (no changes compared with ${ctx.trunk})`;
    case 'too_large':
      return `too_large (${ctx.files ?? 'too many'} files; the limit is ${ctx.maxFiles ?? 'lower'})`;
    case 'claim_conflict':
      return 'claim_conflict (it changes code other agents hold)';
    case 'contains_unlanded':
      return `contains_unlanded (your branch contains ${ctx.unlanded ? `${ctx.unlanded.landingId} by ${ctx.unlanded.agent}` : 'another landing'}, which didn't land)`;
    case 'conflict':
      return `conflict (your change conflicts with ${ctx.trunk} in ${listPaths(ctx.conflictFiles)})`;
    case 'resolver_failed':
      return `resolver_failed (the AI resolution of ${listPaths(ctx.conflictFiles)} didn't hold)`;
    case 'checks_failed':
      return `checks_failed (${ran} exited ${ctx.exitCode ?? 'non-zero'}${ctx.durationMs !== undefined ? ` after ${duration(ctx.durationMs)}` : ''}${tests})`;
    case 'check_timeout':
      return `check_timeout (${ran} didn't finish within ${ctx.checkTimeoutMin ?? 'its'} min)`;
    case 'checks_modified_tree':
      return `checks_modified_tree (${ran} changed tracked files)`;
    case 'trunk_busy':
      return `trunk_busy (${ctx.trunk} was pushed outside the landing queue more than 3 times while it ran)`;
    case 'push_rejected':
      return 'push_rejected (the remote refused the trunk update)';
    case 'approval_rejected':
      return 'approval_rejected (an approver rejected it)';
    case 'approval_timeout':
      return 'approval_timeout (nobody approved it in time)';
    case 'lander_lost':
      return 'lander_lost (the lander stopped while running it, more than 3 times)';
    case 'lander_stuck':
      return 'lander_stuck (a lander step outlived its deadline, more than twice)';
    case 'lander_error':
      return 'lander_error (the lander hit an error of its own)';
  }
}

/** The report's `message`: one paragraph, written by the lander. */
export function failureMessage(code: LandingFailureCode, ctx: SendbackContext): string {
  const head = `${ctx.landingId}${ctx.taskId ? ` for ${ctx.taskId}` : ''} came back: ${what(code, ctx)}.`;
  if (NOT_THE_CHANGE.has(code)) return `${head} This is not caused by your change.`;
  const back = ctx.taskId ? `${ctx.taskId} is back with you and your claims stay yours` : 'Your claims stay yours';
  return `${head} ${back} for at least ${ctx.sendbackGraceMin} min.`;
}

/** The lander's direct message to the author of a landing that came back (design §2.2.9). */
export function sendbackMessage(code: LandingFailureCode, ctx: SendbackContext): string {
  const tail = NOT_THE_CHANGE.has(code) ? 'land again once it is fixed' : `fix, commit, and land again (${place(ctx)})`;
  return `${failureMessage(code, ctx)} landing_status ${ctx.landingId} has the details; ${tail}.`;
}

/**
 * Who may approve these requirements (CP3: the configured approvers or the
 * rule, never a bare "an approver"): `maya or sam`, the author's own human
 * left out where a rule says distinct; for rules that name nobody, `any of the
 * hub's approvers except sam; trunk protects migrations/** without naming
 * approvers`; mixed rules, rule by rule. An `ai_resolution` requirement's rule
 * is the resolver's requireApproval (design §2.6), not a protected path, and
 * the phrase says so.
 */
export function approverPhrase(required: readonly ApprovalRequirement[], agent: string): string {
  const human = humanOf(agent);
  const seen = new Set<string>();
  const rules = required
    .flatMap((r) => r.rules.map((rule) => ({ ...rule, ai: r.kind === 'ai_resolution' })))
    .filter((r) => {
      const key = JSON.stringify([r.paths, r.approvers, r.distinct, r.ai]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const named = (r: ApprovalRequirement['rules'][number]) => (r.approvers ?? []).filter((a) => !(r.distinct && a === human)).map(plain);
  const list = (paths: readonly string[]) => [...new Set(paths)].map(plain).join(', ');
  const open = rules.filter((r) => r.approvers === null);
  if (open.length === 0) {
    const names = [...new Set(rules.flatMap(named))];
    if (names.length > 0) return names.join(' or ');
  } else if (open.length === rules.length) {
    const except = open.some((r) => r.distinct) ? ` except ${plain(human)}` : '';
    const globs = open.filter((r) => !r.ai).flatMap((r) => r.paths);
    const resolved = open.filter((r) => r.ai).flatMap((r) => r.paths);
    const why = [
      ...(globs.length ? [`trunk protects ${list(globs)} without naming approvers`] : []),
      ...(resolved.length ? [`trunk's resolver.requireApproval asks for a human review of the AI-resolved ${list(resolved)}`] : []),
    ].join(' and ');
    return `any of the hub's approvers${except}; ${why}`;
  }
  return rules
    .map((r) => `${r.ai ? 'AI-resolved ' : ''}${r.paths.map(plain).join(', ')}: ${r.approvers === null ? `any approver${r.distinct ? ` except ${plain(human)}` : ''}` : named(r).join(' or ') || 'nobody else'}`)
    .join('; ');
}

/** The direct message for a landing parked for approval (design §2.2.9); `who` from approverPhrase. */
export function parkedMessage(o: { landingId: string; paths: string[]; who: string }): string {
  return `${o.landingId} passed its checks and waits for an approval of ${listPaths(o.paths)} (${o.who}). Tell your human: \`hub approve ${o.landingId}\` in a terminal.`;
}

/** The direct message to both sides of an AI-resolved conflict that landed (design §2.2.9, §2.6). */
export function aiLandedMessage(o: { landingId: string; sha: string; paths: string[]; trunkLandings: string[] }): string {
  const between = o.trunkLandings.length > 0 ? `between ${o.trunkLandings.join(', ')} and ${o.landingId}` : `between ${o.landingId} and trunk`;
  return `${o.landingId} landed with an AI-resolved conflict in ${listPaths(o.paths)} (${between}; checks passed). Review: \`git show ${o.sha.slice(0, 12)} -- ${(o.paths.map(plain)).join(' ')}\`.`;
}

/** The report's `next_steps` for a send-back: exact tool calls and commands, in order. */
export function nextSteps(code: LandingFailureCode, ctx: SendbackContext): string[] {
  const land = `call land again: ${place(ctx)}`;
  const claims = `Your claims are yours for at least ${ctx.sendbackGraceMin} min.`;
  const merge = `hub_sync {"mode": "merge"} merges ${ctx.trunk} into your branch and stops at the conflicts in ${listPaths(ctx.conflictFiles)}; keep both intents, commit, then ${land}.`;
  const reproduce = ctx.reproduce ? [`To reproduce exactly: ${ctx.reproduce}`] : [];
  const run = ctx.command ? `\`${ctx.command}\`` : 'the checks';
  switch (code) {
    case 'not_pushed':
      return ['The land ref is missing or does not point at your commit: call land again, which pushes it again (never amend a commit after landing it).'];
    case 'nothing_to_land':
      return [`Nothing to land: your commit has no changes compared with ${ctx.trunk}, or all of it already landed. Commit your work, then call land.`];
    case 'too_large':
      return [`Split the change: it touches ${ctx.files ?? 'more'} files and ${ctx.trunk} accepts at most ${ctx.maxFiles ?? 'fewer'} per landing. Land it in smaller parts.`];
    case 'claim_conflict':
      return [
        'Your change touches code other agents hold (the conflicts name who and what). Coordinate through hub_post, or wait with hub_wait {"files": [...]} until they are free.',
        `Then ${land}. ${claims}`,
      ];
    case 'contains_unlanded': {
      const u = ctx.unlanded ? `${ctx.unlanded.landingId} by ${plain(ctx.unlanded.agent)}` : 'another landing';
      return [`Your branch contains ${u}, which didn't land: rebase your commits off it or wait for it to land, then ${land}.`];
    }
    case 'conflict':
      return [merge];
    case 'resolver_failed':
      return [
        `The AI resolver's merge of ${listPaths(ctx.conflictFiles)} didn't hold, so the failing code may not be yours: compare it with both sides.`,
        ...reproduce,
        merge,
      ];
    case 'checks_failed':
      return [...reproduce, `Or: hub_sync {"mode": "merge"} (merges ${ctx.trunk} into your branch), then run ${run}.`, `Fix it, commit, and ${land}. ${claims}`];
    case 'check_timeout':
      return [
        `${run} didn't finish within ${ctx.checkTimeoutMin ?? 'the'} min on your change merged with ${ctx.trunk}: look for a hang or a much slower test.`,
        ...reproduce,
        `Fix it, commit, and ${land}. ${claims}`,
      ];
    case 'checks_modified_tree':
      return [
        `${run} changed tracked files (a formatter, a code generator or a snapshot update?), and a check must leave the tree as committed. Run it, commit what it changes, or make it stop writing.`,
        ...reproduce,
        `Then ${land}. ${claims}`,
      ];
    case 'trunk_busy':
      return [`Not caused by your change: ${ctx.trunk} was pushed outside the landing queue more than 3 times while it ran. Tell your human; call land again once ${ctx.trunk} is quiet.`];
    case 'push_rejected':
      return ["Not caused by your change: the remote refused the lander's trunk update (a branch rule or a hook). Tell your human to fix the remote's rule for the lander and run `hub lander resume`."];
    case 'approval_rejected':
      return [`An approver rejected it (their note is with the approvals). Change what they asked for, commit, and ${land}, or ask your human.`];
    case 'approval_timeout': {
      const who = ctx.approvers && ctx.approvers.length > 0 ? ctx.approvers.map(plain).join(' or ') : 'an approver';
      return [`Nobody approved ${listPaths(ctx.protectedPaths)} in time. Tell your human (${who} must run \`hub approve\` in a terminal), then ${land}.`];
    }
    case 'lander_lost':
      return ['Not caused by your change: the lander stopped while running it more than 3 times. Tell your human to check the lander, then call land again once one runs.'];
    case 'lander_stuck':
      return ['Not caused by your change: a lander step outlived its deadline more than twice. Tell your human to check the lander, then call land again once it is fixed.'];
    case 'lander_error':
      return ['Not caused by your change: the lander hit an error of its own. Call land again once it is fixed; this kind of retry keeps your place.'];
  }
}

/** An empty lander report, to fill in. */
export function emptyReport(): LandingReport {
  return { message: '', resolved_by: null, files_via: [], conflicts: [], check: null, resolver: null, next_steps: [], warnings: [], foreign_commits: [], timings: null };
}
