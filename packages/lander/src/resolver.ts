// The AI conflict resolver (design §2.6): stage 3 of the merge ladder, the
// ResolverPort. For the conflicts git and the structural drivers left, it
// decides what may go to the resolver at all (eligibility: content conflicts
// with all three stages, regular UTF-8 text files, nothing protected or
// excluded, within maxFiles, maxFileBytes, 40 hunks and the hourly cap), and
// sends nothing unless every conflict can go: one that can't makes the
// landing come back anyway. Per file it builds a ResolverInput (the three
// blobs, `git merge-file -p --diff3 -L trunk -L base -L incoming` with its
// conflict regions numbered, both sides' intents as untrusted data, and a
// nonce no part of the input contains), runs the resolver command with that
// JSON on stdin (PATH and a scratch HOME only; the API key for the built-in
// command alone), and accepts the answer only through the deterministic gates,
// in order: schema and hunk ids, conflict markers, the splice (hunk texts
// replace the numbered regions, so nothing outside them can change), size,
// novelty, and (Phase 3) parse. The accepted blobs are spliced into the
// merged tree; the checks are still the real gate. With requireApproval the
// resolution becomes an ai_resolution requirement over (path, base, ours,
// theirs, result), and a later attempt whose stages are byte-identical reuses
// the approved blobs instead of calling the resolver again (I8: agent text
// and model output reach trunk only through the splice, the gates and the
// checks).

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULL_SHA_RE, matchesAny, protectedMatches, type ProtectedRule, type ResolverConfig } from '@agenthub/contract';
import { approvalDigest, sanitizeMessageText, type ConflictEntry } from '@agenthub/gitops';
import type { ApprovalRequirement, Decision, Landing, ResolverReport, Task } from '@agenthub/hub/protocol';
import { z } from 'zod';
import { systemClock, type Clock, type GitPort, type HubPort, type PathChange, type ResolveRequest, type ResolveResult, type ResolverPort } from './ports.js';
import { redact } from './redact.js';
import type { ResolverInput, ResolverIntent, ResolverOutput } from './resolver-protocol.js';

/** Per file (design §2.6 "Limits and cost"). */
export const RESOLVER_TIMEOUT_MS = 180_000;
export const MAX_RESOLVER_HUNKS = 40;
/** Trunk-side changes in the input, newest first. */
export const MAX_TRUNK_INTENTS = 5;
export const EXPLANATION_MAX = 2000;
/** Novel lines allowed: max(5, 25% of the conflict-region lines). */
export const NOVELTY_FLOOR = 5;
export const NOVELTY_SHARE = 0.25;
/** A rejected-by-the-checks proposal kept in the report as a suggestion. */
export const SUGGESTION_MAX_BYTES = 8192;

const KILL_GRACE_MS = 5_000;
/** After the command's own process exits, how long a leftover of its group may hold the pipes. */
const PIPE_GRACE_MS = 2_000;
const STDERR_MAX = 16_384;
const HOUR_MS = 60 * 60_000;
const NONCE_TRIES = 64;
const MAX_HOLD_INTENTS = 10;
const MAX_DECISIONS = 5;
const TEXT_MAX = { title: 200, description: 4000, summary: 4000, intent: 500, decision: 500, rationale: 1000 };
/** A model name as it may appear in the Agenthub-Resolved trailer. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** design §2.6 gate 2, for markers of any length (merge-file makes them longer than any marker-like run in the inputs). */
const MARKER_LINE_RE = /^(<{7,}|={7,}|>{7,}|\|{7,})( |$)/;
const REGULAR_MODES = new Set(['100644', '100755']);
const LANDING_ID_RE = /^L-[1-9][0-9]*$/;

/** The built-in command: this package's own `hub-lander resolve-anthropic`. */
export const BUILTIN_ARGV: readonly string[] = [process.execPath, fileURLToPath(new URL('../bin/hub-lander.js', import.meta.url)), 'resolve-anthropic'];

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', cs: 'csharp', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp',
  hpp: 'cpp', swift: 'swift', scala: 'scala', sh: 'shell', bash: 'shell', sql: 'sql', css: 'css', scss: 'scss', html: 'html', vue: 'vue',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown', txt: 'text',
};

/** A language hint for the prompt, from the file name; null when unknown. */
export function languageOf(p: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(p)?.[1]?.toLowerCase();
  return ext ? (LANGUAGES[ext] ?? null) : null;
}

// ------------------------------------------------------------------ conflict regions and the splice

/** One numbered conflict region of `git merge-file -p --diff3` output. */
export interface ConflictRegion {
  id: number;
  /** Offsets in the merged text: from the start of the opening marker line to the end of the closing one. */
  start: number;
  end: number;
  /** Lines of the merged text, 1-based, marker lines included. */
  start_line: number;
  end_line: number;
  trunk: string;
  base: string;
  incoming: string;
  /** The closing marker line's line end ('' at the end of a file without a final newline). */
  eol: string;
}

/**
 * The conflict regions of diff3 output whose markers are `markerSize` long
 * (`<<<<<<< trunk`, `||||||| base`, `=======`, `>>>>>>> incoming`), numbered
 * 0..n-1 in file order. Each side keeps its lines' own line ends.
 */
export function conflictRegions(merged: string, markerSize: number): ConflictRegion[] {
  const [lt, bar, eq, gt] = ['<', '|', '=', '>'].map((c) => c.repeat(markerSize)) as [string, string, string, string];
  const isMarker = (line: string, m: string) => line === m || line.startsWith(`${m} `);
  const out: ConflictRegion[] = [];
  let side: 'trunk' | 'base' | 'incoming' | null = null;
  let open = { start: 0, start_line: 0, trunk: [] as string[], base: [] as string[], incoming: [] as string[] };
  let offset = 0;
  let lineNo = 0;
  for (const m of merged.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const full = m[0];
    lineNo++;
    const at = offset;
    offset += full.length;
    const eol = full.endsWith('\r\n') ? '\r\n' : full.endsWith('\n') ? '\n' : '';
    const line = full.slice(0, full.length - eol.length);
    if (side === null) {
      if (isMarker(line, lt)) {
        side = 'trunk';
        open = { start: at, start_line: lineNo, trunk: [], base: [], incoming: [] };
      }
      continue;
    }
    if (side === 'trunk' && isMarker(line, bar)) side = 'base';
    else if (side !== 'incoming' && line === eq) side = 'incoming';
    else if (side === 'incoming' && isMarker(line, gt)) {
      out.push({ id: out.length, start: open.start, end: offset, start_line: open.start_line, end_line: lineNo, trunk: open.trunk.join(''), base: open.base.join(''), incoming: open.incoming.join(''), eol });
      side = null;
    } else open[side].push(full);
  }
  return out;
}

/**
 * The merged text with region i replaced by texts[i], and every byte outside
 * the regions exactly as it was (design §2.6 gate 3). A non-empty text gets
 * the region's own line end if it lacks one, so the next line stays a line.
 */
export function spliceRegions(merged: string, regions: readonly ConflictRegion[], texts: readonly string[]): string {
  let out = '';
  let at = 0;
  regions.forEach((r, i) => {
    let t = texts[i] ?? '';
    if (t !== '' && r.eol !== '' && !t.endsWith('\n')) t += r.eol;
    out += merged.slice(at, r.start) + t;
    at = r.end;
  });
  return out + merged.slice(at);
}

// ------------------------------------------------------------------ the gates

/** One conflicted file, ready for the resolver: its stages, its texts, git's merge text and the numbered regions. */
export interface PreparedFile {
  path: string;
  mode: string;
  /** Blob ids: 1 base, 2 ours (trunk), 3 theirs (incoming). */
  stages: { 1: string; 2: string; 3: string };
  base: string;
  ours: string;
  theirs: string;
  merged: string;
  markerSize: number;
  regions: ConflictRegion[];
}

export function prepareFile(o: Omit<PreparedFile, 'regions'>): PreparedFile {
  return { ...o, regions: conflictRegions(o.merged, o.markerSize) };
}

export type Gate = 'schema' | 'ids' | 'markers' | 'size' | 'novelty' | 'parse';
type Usage = NonNullable<ResolverOutput['usage']>;

export type Verdict =
  | { kind: 'resolved'; text: string; hunks: string[]; novel: string[]; explanation: string; usage: Usage | null }
  | { kind: 'declined'; explanation: string; usage: Usage | null }
  | { kind: 'rejected'; gate: Gate; detail: string; explanation: string; usage: Usage | null };

const OUTPUT_SCHEMA = z.object({
  status: z.enum(['resolved', 'cannot_resolve']),
  hunks: z.array(z.object({ id: z.number().int(), text: z.string() })).optional(),
  explanation: z.string(),
  usage: z.unknown().optional(),
});

const USAGE_SCHEMA = z.object({ model: z.string(), input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() });

/** Model text for a report: control and bidi characters stripped, at most 2000 characters. */
export function cleanExplanation(s: unknown): string {
  return typeof s === 'string' ? sanitizeMessageText(s, EXPLANATION_MAX).trim() : '';
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const lineList = (s: string) => (s === '' ? [] : s.replace(/\r?\n$/, '').split(/\r?\n/));

/**
 * The verification gates of design §2.6, in order, over a resolver's raw
 * output for one prepared file: 1 the schema, the status, every hunk id
 * exactly once and no unknown ids; 2 no conflict-marker line unless that same
 * line is in base, ours or theirs; 3 the splice; 4 each hunk's text at most
 * 2 × (its trunk side + its incoming side) + 200 bytes, and the file at most
 * 2 × max(|ours|, |theirs|); 5 at most max(5, 25% of the conflict-region
 * lines) novel lines (trimmed, non-empty, in none of base, ours, theirs).
 * The parse gate (6) is async and runs after these (AiResolver).
 */
export function verifyOutput(f: PreparedFile, raw: unknown): Verdict {
  const explanation = cleanExplanation((raw as { explanation?: unknown } | null)?.explanation);
  const parsed = OUTPUT_SCHEMA.safeParse(raw);
  const usageOf = (u: unknown): Usage | null => {
    const r = USAGE_SCHEMA.safeParse(u);
    return r.success ? r.data : null;
  };
  if (!parsed.success) {
    return { kind: 'rejected', gate: 'schema', detail: `the answer doesn't match the resolver protocol (${parsed.error.issues[0]?.path.join('.') || 'its shape'}: ${parsed.error.issues[0]?.message ?? 'invalid'})`, explanation, usage: usageOf((raw as { usage?: unknown } | null)?.usage) };
  }
  const out = parsed.data;
  const usage = usageOf(out.usage);
  if (out.status === 'cannot_resolve') return { kind: 'declined', explanation, usage };
  const reject = (gate: Gate, detail: string): Verdict => ({ kind: 'rejected', gate, detail, explanation, usage });

  // 1. Every hunk id exactly once, no unknown ids.
  const hunks = out.hunks;
  if (!hunks) return reject('ids', 'it answered "resolved" without hunks');
  const texts: string[] = new Array<string>(f.regions.length);
  for (const h of hunks) {
    if (h.id < 0 || h.id >= f.regions.length) return reject('ids', `it answered an unknown hunk id ${h.id} (the hunks are 0..${f.regions.length - 1})`);
    if (texts[h.id] !== undefined) return reject('ids', `it answered hunk ${h.id} twice`);
    texts[h.id] = h.text;
  }
  const missing = f.regions.filter((r) => texts[r.id] === undefined).map((r) => r.id);
  if (missing.length > 0) return reject('ids', `it left out hunk${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`);

  // 2. No conflict-marker line, unless that same line is in base, ours or theirs.
  const sideLines = new Set([...lineList(f.base), ...lineList(f.ours), ...lineList(f.theirs)]);
  for (const r of f.regions) {
    for (const line of lineList(texts[r.id]!)) {
      if (MARKER_LINE_RE.test(line) && !sideLines.has(line)) return reject('markers', `hunk ${r.id} has a conflict-marker line (${JSON.stringify(line.slice(0, 40))})`);
    }
  }

  // 3. The splice: git's merge text outside the regions, byte for byte.
  const text = spliceRegions(f.merged, f.regions, texts);

  // 4. Size.
  for (const r of f.regions) {
    const limit = 2 * (bytes(r.trunk) + bytes(r.incoming)) + 200;
    const size = bytes(texts[r.id]!);
    if (size > limit) return reject('size', `hunk ${r.id} is ${size} bytes; at most ${limit} (2 × its trunk and incoming sides + 200)`);
  }
  const fileLimit = 2 * Math.max(bytes(f.ours), bytes(f.theirs));
  if (bytes(text) > fileLimit) return reject('size', `the file would be ${bytes(text)} bytes; at most ${fileLimit} (2 × the larger of trunk and incoming)`);

  // 5. Novelty.
  const known = new Set([...lineList(f.base), ...lineList(f.ours), ...lineList(f.theirs)].map((l) => l.trim()));
  const novel: string[] = [];
  for (const r of f.regions) for (const line of lineList(texts[r.id]!)) if (line.trim() !== '' && !known.has(line.trim())) novel.push(line.trim());
  const regionLines = f.regions.reduce((n, r) => n + lineList(r.trunk).length + lineList(r.base).length + lineList(r.incoming).length, 0);
  const allowed = Math.max(NOVELTY_FLOOR, Math.floor(NOVELTY_SHARE * regionLines));
  if (novel.length > allowed) return reject('novelty', `${novel.length} lines of its hunks are in none of base, trunk and incoming; at most ${allowed} (max(5, 25% of ${regionLines} conflict-region lines))`);

  return { kind: 'resolved', text, hunks: texts, novel, explanation, usage };
}

// ------------------------------------------------------------------ the nonce

function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

/** A nonce that appears in no string of `values` (design §2.6: no content can close a tag early). */
export function drawNonce(values: unknown, next: () => string = () => randomBytes(4).toString('hex')): string {
  const strings = stringsOf(values);
  for (let i = 0; i < NONCE_TRIES; i++) {
    const n = next();
    if (/^[0-9a-f]{4,32}$/.test(n) && !strings.some((s) => s.includes(n))) return n;
  }
  throw new Error(`lander: no nonce found in ${NONCE_TRIES} tries that the resolver input doesn't contain`);
}

// ------------------------------------------------------------------ the command

export type CommandResult =
  | { kind: 'output'; value: unknown; stderr: string }
  | { kind: 'failed'; reason: 'spawn' | 'timeout' | 'exit' | 'json' | 'too_large' | 'aborted'; detail: string; stderr: string };

function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Runs a resolver command (design §2.6 "Command protocol"): the input as JSON
 * on stdin, the output as JSON from stdout, in its own process group so a
 * timeout or an abort kills everything it started. A non-zero exit, the
 * timeout, too much output or invalid JSON is a failure (cannot_resolve).
 */
export function runResolverCommand(
  argv: readonly string[],
  input: unknown,
  o: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      resolve({ kind: 'failed', reason: 'spawn', detail: `couldn't start it: ${(err as Error).message}`, stderr: '' });
      return;
    }
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let stopped: Extract<CommandResult, { kind: 'failed' }> | null = null;
    let done = false;
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, fn: () => void) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      timers.push(t);
    };
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const stop = (reason: Extract<CommandResult, { kind: 'failed' }>['reason'], detail: string) => {
      if (stopped || done) return;
      stopped = { kind: 'failed', reason, detail, stderr: '' };
      killGroup('SIGTERM');
      later(KILL_GRACE_MS, () => killGroup('SIGKILL'));
    };
    const onAbort = () => stop('aborted', 'stopped: the lander is stopping or lost its lease');
    const finish = (r: CommandResult) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    later(o.timeoutMs, () => stop('timeout', `timed out after ${seconds(o.timeoutMs)}`));
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.signal?.aborted) onAbort();
    child.stdout!.on('data', (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > o.maxOutputBytes) stop('too_large', `printed more than ${o.maxOutputBytes} bytes`);
      else out.push(d);
    });
    child.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < STDERR_MAX) stderr += d.toString('utf8').slice(0, STDERR_MAX - stderr.length);
    });
    // It may exit without reading its input.
    child.stdin!.on('error', () => undefined);
    child.on('error', (err) => finish({ kind: 'failed', reason: 'spawn', detail: `couldn't start it: ${err.message}`, stderr }));
    // Something it started may hold the pipes open after it exited: the group is still there then, so it can be killed.
    child.on('exit', () => later(PIPE_GRACE_MS, () => killGroup('SIGKILL')));
    child.on('close', (code, signal) => {
      if (stopped) return finish({ ...stopped, stderr });
      if (code !== 0) return finish({ kind: 'failed', reason: 'exit', detail: code === null ? `was killed by ${signal ?? 'a signal'}` : `exited ${code}`, stderr });
      const text = Buffer.concat(out).toString('utf8').trim();
      try {
        finish({ kind: 'output', value: JSON.parse(text) as unknown, stderr });
      } catch {
        finish({ kind: 'failed', reason: 'json', detail: 'printed something that is not JSON', stderr });
      }
    });
    child.stdin!.end(JSON.stringify(input));
  });
}

// ------------------------------------------------------------------ intents

const clean = (s: string | null | undefined, max: number): string => sanitizeMessageText(s ?? '', max).trim();

function namesFile(d: Decision, file: string): boolean {
  return d.files.includes(file) || d.symbols.some((s) => s === file || s.startsWith(`${file}#`));
}

/** Hub reads for one resolve() call, shared across its files; every read is best effort. */
class Intents {
  private tasks: Promise<Task[]> | null = null;
  private decisions: Promise<Decision[]> | null = null;
  private readonly landings = new Map<string, Promise<Landing | null>>();

  constructor(
    private readonly hub: AiResolverOptions['hub'],
    private readonly project: string,
    private readonly epoch: string,
  ) {}

  private task(id: string | null): Promise<Task | null> {
    if (!id) return Promise.resolve(null);
    this.tasks ??= this.hub.tasks().catch(() => [] as Task[]);
    return this.tasks.then((ts) => ts.find((t) => t.id === id) ?? null);
  }

  private landing(id: string): Promise<Landing | null> {
    let p = this.landings.get(id);
    if (!p) {
      p = this.hub.landing(id).catch(() => null);
      this.landings.set(id, p);
    }
    return p;
  }

  /** A landing's decisions: those of its task, or its author's that name the file. */
  private async decisionsOf(l: Pick<Landing, 'agent' | 'task_id'>, file: string): Promise<ResolverIntent['decisions']> {
    this.decisions ??= this.hub.decisions(200).catch(() => [] as Decision[]);
    const all = await this.decisions;
    return all
      .filter((d) => (l.task_id !== null && d.task_id === l.task_id) || (d.agent === l.agent && namesFile(d, file)))
      .slice(0, MAX_DECISIONS)
      .map((d) => ({ id: d.id, summary: clean(d.summary, TEXT_MAX.decision), rationale: clean(d.rationale, TEXT_MAX.rationale) }));
  }

  private async intentOf(l: Landing, file: string, holds: string[]): Promise<ResolverIntent> {
    const task = await this.task(l.task_id);
    return {
      landing_id: l.id,
      agent: l.agent,
      task_title: task ? clean(task.title, TEXT_MAX.title) || null : null,
      task_description: task ? clean(task.description, TEXT_MAX.description) || null : null,
      summary: clean(l.summary, TEXT_MAX.summary),
      intents: holds,
      decisions: await this.decisionsOf(l, file),
    };
  }

  /** The landing being resolved: its task, summary, hold intents and decisions. */
  async incoming(l: Landing, file: string): Promise<ResolverIntent> {
    const holds: string[] = [];
    for (const id of (l.hold_ids ?? []).slice(0, MAX_HOLD_INTENTS)) {
      const c = await this.hub.getClaim(id).catch(() => null);
      const text = clean(c?.intent, TEXT_MAX.intent);
      if (text && !holds.includes(text)) holds.push(text);
    }
    return this.intentOf(l, file, holds);
  }

  /**
   * A trunk commit that changed the file since the base, attributed only
   * through its trailers (this hub's epoch, one of its landings, whose commit
   * is the trailer's source: design §1.1); anything else was pushed outside
   * the queue and carries just its subject.
   */
  async trunk(c: PathChange, file: string): Promise<{ intent: ResolverIntent; landing: Landing | null }> {
    const foreign = { intent: { landing_id: null, agent: null, task_title: null, task_description: null, summary: clean(c.subject, TEXT_MAX.title), intents: [], decisions: [] }, landing: null };
    const prefix = `${this.project}/`;
    if (c.hub !== this.epoch || !c.landing?.startsWith(prefix) || !c.source) return foreign;
    const id = c.landing.slice(prefix.length);
    if (!LANDING_ID_RE.test(id)) return foreign;
    const l = await this.landing(id);
    if (!l || l.commit !== c.source) return foreign;
    return { intent: await this.intentOf(l, file, []), landing: l };
  }
}

// ------------------------------------------------------------------ the port

/** design §2.6 gate 6 (Phase 3, injected by L6): why the result doesn't parse when both sides do, or null. */
export type ParseCheck = (file: { path: string; ours: string; theirs: string; result: string }) => Promise<string | null>;

export interface AiResolverOptions {
  git: Pick<GitPort, 'mergeFile' | 'catBlob' | 'spliceTree' | 'blobId' | 'pathHistory' | 'revParse' | 'fetch'>;
  hub: Pick<HubPort, 'landing' | 'tasks' | 'decisions' | 'getClaim'>;
  project: string;
  clock?: Clock;
  /** The operator's resolver command (`--resolver-command`, run with /bin/sh -c); null = the built-in `hub-lander resolve-anthropic`. */
  command: string | null;
  /** ANTHROPIC_API_KEY, from lander memory: passed to the built-in command only. */
  apiKey: string | null;
  /** resolverMaxPerHour: calls in any hour, for this lander process. */
  maxPerHour: number;
  /** Per file (default 180 s). */
  timeoutMs?: number;
  /** Where each run's scratch HOME is made and removed (default the OS temp dir). */
  scratchDir?: string | null;
  /** The lander's environment: PATH, and NODE_ENV=test's AGENTHUB_RESOLVER_STUB (default process.env). */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Phase 3: the parse gate. */
  parseCheck?: ParseCheck | null;
  /** Tests: the nonce source, and the argv the built-in command runs as. */
  nonce?: () => string;
  builtinArgv?: readonly string[];
}

interface Checked {
  entry: ConflictEntry;
  file: PreparedFile | null;
  /** Why it can't go to the resolver; null when it can. */
  why: string | null;
}

interface FileOutcome {
  path: string;
  verdict: Verdict | null;
  /** The command gave no answer: why. */
  failure: string | null;
}

export class AiResolver implements ResolverPort {
  private readonly o: AiResolverOptions;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  /** When each call of the last hour started (the hourly cap). */
  private calls: number[] = [];

  constructor(o: AiResolverOptions) {
    this.o = o;
    this.clock = o.clock ?? systemClock;
    this.timeoutMs = o.timeoutMs ?? RESOLVER_TIMEOUT_MS;
    this.env = o.env ?? process.env;
  }

  private log(line: string): void {
    this.o.log?.(redact(line, [this.o.apiKey]));
  }

  async resolve(req: ResolveRequest): Promise<ResolveResult> {
    const cfg = req.config;
    const warnings: string[] = [];
    const checked: Checked[] = [];
    for (const entry of req.conflicts) checked.push(await this.check(entry, req));
    const ready = checked.filter((c) => c.why === null);
    const skip = (unresolved: ResolveResult['unresolved']): ResolveResult => ({
      tree: req.tree,
      resolved: [],
      unresolved,
      report: this.report(cfg, 'skipped', [], [], 0),
      requirement: null,
      warnings,
      trunkSide: [],
      suggestions: {},
    });

    // Every conflict must be able to go, or nothing goes: the landing would come back anyway.
    if (ready.length > cfg.maxFiles) {
      warnings.push(`${checked.length} files conflict and land.resolver.maxFiles is ${cfg.maxFiles}: nothing was sent to the AI resolver`);
      return skip(checked.map((c) => ({ path: c.entry.path, eligible: false, explanation: null })));
    }
    const refused = checked.filter((c) => c.why !== null);
    if (refused.length > 0) {
      for (const c of refused) warnings.push(`${c.entry.path}: not sent to the AI resolver: ${c.why}`);
      if (ready.length > 0) warnings.push(`nothing was sent to the AI resolver: ${refused.map((c) => c.entry.path).join(', ')} can't go to it, so the landing comes back either way`);
      return skip(checked.map((c) => ({ path: c.entry.path, eligible: c.why === null, explanation: null })));
    }
    const files = ready.map((c) => c.file!);
    const intents = new Intents(this.o.hub, this.o.project, req.epoch);
    const trunkSide = await this.trunkSide(files, req, intents);

    // An approved resolution of byte-identical stages is reused without calling the resolver.
    const reused = await this.reusable(files, req);
    if (reused) {
      for (const f of files) warnings.push(`${f.path}: reused the resolution approved earlier (its conflict is byte-identical), without calling the AI resolver`);
      const tree = await this.o.git.spliceTree(req.tree, reused.map((r) => ({ path: r.path, mode: r.mode, content: r.content })));
      return {
        tree,
        resolved: files.map((f) => f.path),
        unresolved: [],
        report: this.report(cfg, 'resolved', files.map((f) => f.path), [], 0),
        requirement: cfg.requireApproval ? this.requirement(files, reused.map((r) => r.oid), req) : null,
        warnings,
        trunkSide: trunkSide.landings,
        suggestions: {},
      };
    }

    // The hourly cap: the calls this needs must all fit.
    const now = this.clock.now();
    this.calls = this.calls.filter((t) => now - t < HOUR_MS);
    if (this.calls.length + files.length > this.o.maxPerHour) {
      const cap = this.o.maxPerHour;
      warnings.push(`the lander's cap of ${cap} resolver call${cap === 1 ? '' : 's'} per hour is used up (${this.calls.length} in the last hour, ${files.length} needed): nothing was sent to the AI resolver`);
      return skip(files.map((f) => ({ path: f.path, eligible: true, explanation: null })));
    }

    // One call per file, in turn; the first file that isn't resolved ends the round.
    const outcomes: FileOutcome[] = [];
    for (const [i, f] of files.entries()) {
      const outcome = await this.resolveFile(f, req, intents, trunkSide.intents.get(f.path) ?? []);
      outcomes.push(outcome);
      if (outcome.verdict?.kind === 'resolved') continue;
      const rest = files.slice(i + 1).map((x) => x.path);
      if (rest.length > 0) warnings.push(`${rest.join(', ')}: not sent to the AI resolver, since ${f.path} wasn't resolved`);
      break;
    }

    const explanations: Record<string, string> = {};
    const suggestions: Record<string, string> = {};
    for (const o of outcomes) {
      const v = o.verdict;
      if (o.failure) warnings.push(`${o.path}: the AI resolver gave no answer: it ${o.failure}`);
      if (v?.kind === 'rejected') warnings.push(`${o.path}: the AI resolver's output was rejected (${v.gate}): ${v.detail}`);
      let text = v?.explanation ?? '';
      if (v?.kind === 'resolved') {
        if (v.novel.length > 0) text = `${text}${text ? '\n\n' : ''}Lines in none of base, trunk and incoming (review them):\n${v.novel.slice(0, 20).map((l) => `+ ${l.slice(0, 200)}`).join('\n')}`;
        const f = files.find((x) => x.path === o.path)!;
        suggestions[o.path] = suggestion(f, v.hunks);
      }
      if (text) explanations[o.path] = text;
    }
    const all = outcomes.length === files.length && outcomes.every((o) => o.verdict?.kind === 'resolved');
    const outcome: ResolverReport['outcome'] = all ? 'resolved' : outcomes.some((o) => o.verdict?.kind === 'rejected') ? 'rejected_output' : 'cannot_resolve';
    const novel = outcomes.reduce((n, o) => n + (o.verdict?.kind === 'resolved' ? o.verdict.novel.length : 0), 0);
    const report = this.report(cfg, outcome, outcomes.map((o) => o.path), outcomes.map((o) => o.verdict?.usage ?? null), novel, explanations);
    if (!all) {
      return {
        tree: req.tree,
        resolved: [],
        unresolved: files.map((f) => {
          const v = outcomes.find((o) => o.path === f.path)?.verdict;
          return { path: f.path, eligible: true, explanation: v && v.kind !== 'resolved' && v.explanation ? v.explanation : null };
        }),
        report,
        requirement: null,
        warnings,
        trunkSide: [],
        suggestions: {},
      };
    }
    const blobs = outcomes.map((o) => {
      const f = files.find((x) => x.path === o.path)!;
      return { path: f.path, mode: f.mode, content: (o.verdict as Extract<Verdict, { kind: 'resolved' }>).text };
    });
    const tree = await this.o.git.spliceTree(req.tree, blobs);
    let requirement: ApprovalRequirement | null = null;
    if (cfg.requireApproval) {
      const results: string[] = [];
      for (const f of files) {
        const oid = await this.o.git.blobId(tree, f.path);
        if (!oid) throw new Error(`lander: the resolved ${f.path} is missing from the spliced tree ${tree}`);
        results.push(oid);
      }
      requirement = this.requirement(files, results, req);
    }
    this.log(`AI resolver: resolved ${files.map((f) => f.path).join(', ')} for ${req.landing.id}`);
    return { tree, resolved: files.map((f) => f.path), unresolved: [], report, requirement, warnings, trunkSide: trunkSide.landings, suggestions };
  }

  /** design §2.2.6 step 3, for one conflict: why it can't go to the resolver, or the prepared file. */
  private async check(entry: ConflictEntry, req: ResolveRequest): Promise<Checked> {
    const no = (why: string): Checked => ({ entry, file: null, why });
    const p = entry.path;
    const s = entry.stages;
    if (entry.kind !== 'content' || !s[1] || !s[2] || !s[3]) return no(`a ${entry.kind} conflict, not a content conflict with base, trunk and incoming versions`);
    if (!REGULAR_MODES.has(entry.mode ?? '')) return no(`not a regular file (mode ${entry.mode ?? 'unknown'})`);
    if (protectedMatches([p], req.protectedRules).length > 0) return no('it is protected (land.protected): a human resolves it');
    if (matchesAny(p, req.config.exclude)) return no('it matches land.resolver.exclude');
    const texts: string[] = [];
    let merged: { text: string; markerSize: number };
    try {
      for (const oid of [s[1], s[2], s[3]]) {
        const text = await this.o.git.catBlob(oid);
        if (text.includes('\0') || gitBlobId(text, oid.length) !== oid) return no('not UTF-8 text');
        if (bytes(text) > req.config.maxFileBytes) return no(`a version of it is ${bytes(text)} bytes, over land.resolver.maxFileBytes (${req.config.maxFileBytes})`);
        texts.push(text);
      }
      merged = await this.o.git.mergeFile({ trunk: s[2], base: s[1], yours: s[3] }, ['trunk', 'base', 'incoming']);
    } catch (err) {
      this.log(`AI resolver: can't prepare ${p}: ${(err as Error).message}`);
      return no("the lander couldn't read its versions or merge them with git merge-file");
    }
    const file = prepareFile({ path: p, mode: entry.mode!, stages: { 1: s[1], 2: s[2], 3: s[3] }, base: texts[0]!, ours: texts[1]!, theirs: texts[2]!, merged: merged.text, markerSize: merged.markerSize });
    if (file.regions.length === 0) return no("git merge-file finds no conflict hunks in it (the conflict is in its attributes or mode)");
    if (file.regions.length > MAX_RESOLVER_HUNKS) return no(`${file.regions.length} conflict hunks (at most ${MAX_RESOLVER_HUNKS})`);
    return { entry, file, why: null };
  }

  /** The trunk-side changes of each file (input context) and the landings among them (they are told when it lands). */
  private async trunkSide(files: PreparedFile[], req: ResolveRequest, intents: Intents): Promise<{ intents: Map<string, ResolverIntent[]>; landings: ResolveResult['trunkSide'] }> {
    const byFile = new Map<string, ResolverIntent[]>();
    const landings: ResolveResult['trunkSide'] = [];
    for (const f of files) {
      const changes = await this.o.git.pathHistory(req.base, req.trunk, f.path, MAX_TRUNK_INTENTS).catch(() => [] as PathChange[]);
      const list: ResolverIntent[] = [];
      for (const c of changes) {
        const t = await intents.trunk(c, f.path);
        list.push(t.intent);
        if (t.landing && !landings.some((x) => x.landingId === t.landing!.id)) landings.push({ landingId: t.landing.id, agent: t.landing.agent });
      }
      byFile.set(f.path, list);
    }
    return { intents: byFile, landings };
  }

  /**
   * design §2.6 "Approval binding": the landing's last candidate holds an
   * earlier attempt's resolution; it is reused when the ai_resolution digest
   * over the current stages and the candidate's blobs is one a human approved.
   */
  private async reusable(files: PreparedFile[], req: ResolveRequest): Promise<Array<{ path: string; mode: string; oid: string; content: string }> | null> {
    const { candidate, candidateRef, approved } = req.reuse;
    if (!candidate || !FULL_SHA_RE.test(candidate) || approved.length === 0) return null;
    try {
      if ((await this.o.git.revParse(candidate)) === null) {
        const local = candidateRef ? localCandidateRef(candidateRef) : null;
        if (!local || (await this.o.git.fetch([`+${candidateRef}:${local}`])).kind !== 'ok' || (await this.o.git.revParse(candidate)) === null) return null;
      }
      const out: Array<{ path: string; mode: string; oid: string; content: string }> = [];
      for (const f of files) {
        const oid = await this.o.git.blobId(candidate, f.path);
        if (!oid) return null;
        out.push({ path: f.path, mode: f.mode, oid, content: '' });
      }
      const digest = approvalDigest('ai_resolution', files.map((f, i) => ({ path: f.path, blobs: [f.stages[1], f.stages[2], f.stages[3], out[i]!.oid] })));
      if (!approved.includes(digest)) return null;
      for (const r of out) r.content = await this.o.git.catBlob(r.oid);
      // The content must round-trip exactly, or the splice would write other bytes than the ones approved.
      if (out.some((r) => gitBlobId(r.content, r.oid.length) !== r.oid)) return null;
      return out;
    } catch (err) {
      this.log(`AI resolver: can't reuse the approved resolution of ${req.landing.id}: ${(err as Error).message}`);
      return null;
    }
  }

  private requirement(files: PreparedFile[], results: string[], req: ResolveRequest): ApprovalRequirement {
    const paths = files.map((f) => f.path).sort();
    return {
      kind: 'ai_resolution',
      digest: approvalDigest('ai_resolution', files.map((f, i) => ({ path: f.path, blobs: [f.stages[1], f.stages[2], f.stages[3], results[i]!] }))),
      paths,
      rules: [{ paths: [...paths], approvers: null, distinct: req.distinct }],
      candidate: null,
      candidate_ref: null,
      trunk_base: req.trunk,
    };
  }

  /** One file: the input, the command, the gates. */
  private async resolveFile(f: PreparedFile, req: ResolveRequest, intents: Intents, trunk: ResolverIntent[]): Promise<FileOutcome> {
    const incoming = await intents.incoming(req.landing, f.path);
    const body: Omit<ResolverInput, 'nonce'> = {
      version: 1,
      model: req.config.model,
      file: {
        path: f.path,
        language: languageOf(f.path),
        base: f.base,
        trunk: f.ours,
        incoming: f.theirs,
        merged: f.merged,
        hunks: f.regions.map((r) => ({ id: r.id, start_line: r.start_line, end_line: r.end_line, base: r.base, trunk: r.trunk, incoming: r.incoming })),
      },
      incoming,
      trunk,
      limits: { timeout_ms: this.timeoutMs, max_output_bytes: 4 * req.config.maxFileBytes + 65_536 },
    };
    const input: ResolverInput = { ...body, nonce: drawNonce(body, this.o.nonce) };
    this.calls.push(this.clock.now());
    const run = await this.run(input, req.signal);
    if (run.stderr.trim()) this.log(`AI resolver (${f.path}): ${run.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 500)}`);
    if (run.kind === 'failed') return { path: f.path, verdict: null, failure: run.detail };
    let verdict = verifyOutput(f, run.value);
    if (verdict.kind === 'resolved' && this.o.parseCheck) {
      const why = await this.o.parseCheck({ path: f.path, ours: f.ours, theirs: f.theirs, result: verdict.text });
      if (why) verdict = { kind: 'rejected', gate: 'parse', detail: why, explanation: verdict.explanation, usage: verdict.usage };
    }
    return { path: f.path, verdict, failure: null };
  }

  /** The command, with PATH and a scratch HOME only (and the key for the built-in one), removed afterwards. */
  private async run(input: ResolverInput, signal?: AbortSignal): Promise<CommandResult> {
    const root = this.o.scratchDir ?? tmpdir();
    mkdirSync(root, { recursive: true });
    const home = mkdtempSync(path.join(root, 'resolver-'));
    try {
      const env: NodeJS.ProcessEnv = { PATH: this.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home };
      if (this.o.command === null && this.o.apiKey) env.ANTHROPIC_API_KEY = this.o.apiKey;
      if (this.env.NODE_ENV === 'test' && this.env.AGENTHUB_RESOLVER_STUB) env.AGENTHUB_RESOLVER_STUB = this.env.AGENTHUB_RESOLVER_STUB;
      const argv = this.o.command === null ? (this.o.builtinArgv ?? BUILTIN_ARGV) : ['/bin/sh', '-c', this.o.command];
      return await runResolverCommand(argv, input, { env, cwd: home, timeoutMs: this.timeoutMs, maxOutputBytes: input.limits.max_output_bytes, signal });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  private report(cfg: ResolverConfig, outcome: ResolverReport['outcome'], files: string[], usages: Array<Usage | null>, novel: number, explanations: Record<string, string> = {}): ResolverReport {
    const models = [...new Set(usages.filter((u): u is Usage => u !== null && MODEL_RE.test(u.model)).map((u) => u.model))];
    return {
      model: models.length > 0 ? models.join('+') : cfg.model,
      outcome,
      files,
      novel_lines: novel,
      input_tokens: usages.reduce((n, u) => n + (u?.input_tokens ?? 0), 0),
      output_tokens: usages.reduce((n, u) => n + (u?.output_tokens ?? 0), 0),
      explanations,
    };
  }
}

/** The proposed hunk texts of a resolution, for the author when the checks fail on it (≤ 8 KiB). */
function suggestion(f: PreparedFile, texts: string[]): string {
  const parts = f.regions.map((r) => `--- hunk ${r.id} (lines ${r.start_line}-${r.end_line} of the conflict-marked file)\n${texts[r.id] ?? ''}`);
  let out = `The AI resolver's proposed text for the conflict hunks (model output, unchecked):\n${parts.join('\n')}`;
  if (bytes(out) > SUGGESTION_MAX_BYTES) {
    out = Buffer.from(out, 'utf8').subarray(0, SUGGESTION_MAX_BYTES - 20).toString('utf8').replace(/�$/, '');
    out += '\n… (cut at 8 KiB)';
  }
  return out;
}

/** The git object id of a blob with this content (sha1, or sha256 for a 64-hex repository). */
export function gitBlobId(text: string, oidLength: number): string {
  const body = Buffer.from(text, 'utf8');
  return createHash(oidLength === 64 ? 'sha256' : 'sha1')
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest('hex');
}

/** The mirror's copy of a staged candidate ref (`<P>cand/<rest>` → `refs/agenthub/cand/<rest>`). */
function localCandidateRef(ref: string): string | null {
  const i = ref.indexOf('cand/');
  return i > 0 ? `refs/agenthub/${ref.slice(i)}` : null;
}

// ------------------------------------------------------------------ doctor's probe

const SELF_TEST = {
  base: 'export function greet(name: string): string {\n  return "Hello " + name;\n}\n',
  ours: 'export function greet(who: string): string {\n  return "Hello " + who;\n}\n',
  theirs: 'export function greet(name: string): string {\n  return "Hello, " + name + "!";\n}\n',
};

/**
 * `hub-lander doctor`'s resolver check (design §2.2.10): the built-in command
 * runs (a probe with no hunks, which it answers without an API call); an
 * operator's command answers a small self-test conflict within the protocol,
 * and its answer is put through the gates.
 */
export async function probeResolver(o: { command: string | null; apiKey: string | null; env?: NodeJS.ProcessEnv; timeoutMs?: number; builtinArgv?: readonly string[] }): Promise<{ ok: boolean; detail: string }> {
  const marked = [
    '<<<<<<< trunk',
    ...SELF_TEST.ours.replace(/\n$/, '').split('\n').slice(0, 2),
    '||||||| base',
    ...SELF_TEST.base.replace(/\n$/, '').split('\n').slice(0, 2),
    '=======',
    ...SELF_TEST.theirs.replace(/\n$/, '').split('\n').slice(0, 2),
    '>>>>>>> incoming',
    '}',
    '',
  ].join('\n');
  const file = prepareFile({ path: 'selftest.ts', mode: '100644', stages: { 1: gitBlobId(SELF_TEST.base, 40), 2: gitBlobId(SELF_TEST.ours, 40), 3: gitBlobId(SELF_TEST.theirs, 40) }, ...SELF_TEST, merged: marked, markerSize: 7 });
  const builtin = o.command === null;
  const none: ResolverIntent = { landing_id: null, agent: null, task_title: 'hub-lander doctor self-test', task_description: null, summary: 'A self-test conflict: trunk renamed the parameter, the change adds punctuation.', intents: [], decisions: [] };
  const body: Omit<ResolverInput, 'nonce'> = {
    version: 1,
    model: 'claude-opus-5-5',
    file: {
      path: file.path,
      language: 'typescript',
      base: file.base,
      trunk: file.ours,
      incoming: file.theirs,
      merged: file.merged,
      // The built-in command gets no hunks, so it answers without calling the API.
      hunks: builtin ? [] : file.regions.map((r) => ({ id: r.id, start_line: r.start_line, end_line: r.end_line, base: r.base, trunk: r.trunk, incoming: r.incoming })),
    },
    incoming: none,
    trunk: [],
    limits: { timeout_ms: o.timeoutMs ?? 30_000, max_output_bytes: 1_048_576 },
  };
  const input: ResolverInput = { ...body, nonce: drawNonce(body) };
  const home = mkdtempSync(path.join(tmpdir(), 'hub-lander-resolver-probe-'));
  try {
    const parent = o.env ?? process.env;
    const env: NodeJS.ProcessEnv = { PATH: parent.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home };
    if (builtin && o.apiKey) env.ANTHROPIC_API_KEY = o.apiKey;
    if (parent.NODE_ENV === 'test' && parent.AGENTHUB_RESOLVER_STUB) env.AGENTHUB_RESOLVER_STUB = parent.AGENTHUB_RESOLVER_STUB;
    const argv = builtin ? (o.builtinArgv ?? BUILTIN_ARGV) : ['/bin/sh', '-c', o.command!];
    const run = await runResolverCommand(argv, input, { env, cwd: home, timeoutMs: o.timeoutMs ?? 30_000, maxOutputBytes: 1_048_576 });
    if (run.kind === 'failed') return { ok: false, detail: `the resolver command ${run.detail}${run.stderr.trim() ? ` (${redact(run.stderr.trim().split('\n').pop()!, [o.apiKey]).slice(0, 200)})` : ''}` };
    if (builtin) {
      const v = OUTPUT_SCHEMA.safeParse(run.value);
      return v.success ? { ok: true, detail: 'the built-in resolve-anthropic runs (the probe made no API call)' } : { ok: false, detail: "the built-in resolve-anthropic's answer doesn't match the resolver protocol" };
    }
    const v = verifyOutput(file, run.value);
    if (v.kind === 'resolved') return { ok: true, detail: 'the resolver command resolves the self-test conflict, and its answer passes the gates' };
    if (v.kind === 'declined') return { ok: true, detail: 'the resolver command answers within the protocol (it declined the self-test conflict)' };
    return { ok: false, detail: `the resolver command's answer to the self-test conflict fails the ${v.gate} gate: ${v.detail}` };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
