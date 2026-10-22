import { isValidSymbolKey } from '@agenthub/contract';
import { HubError, assertNotReserved, cleanText, idOf, normalizeRepoPath, type HubInternals } from './common.js';
import type { Landing, SymbolChange, SymbolChangeKind, SymbolChangeStatus } from './protocol.js';
import type { Store, SymbolChangeRow } from './store.js';

// Signature changes (design §2.5, Phase 3). An agent's post-edit hook posts
// the signature changes of each edit it made (POST /symbol-changes): one
// in-progress row per (agent, file, symbol), measured from the signature the
// symbol had before the agent's first change of it, so an edit that brings it
// back withdraws the row. The lander reports what a landing changed (T0 vs
// the candidate) with advance/resolve landed: those rows are recorded as
// landed, and they supersede the author's in-progress rows for the task.
// Reads link up to 3 decisions to each change. Every new or changed row emits
// symbol.changed with ids and names only: signature text is code another
// agent wrote, read through GET /symbol-changes, never put in an event.

/** Signature text is cut to this (design §2.4: the extractor reports at most 500 characters). */
const MAX_SIGNATURE = 500;
/** At most this many changes in one POST: an edit's are at most symbols.maxSymbolsPerEdit (100 at the most). */
export const MAX_POSTED_CHANGES = 200;
/** A listing returns at most this many changes, the most recently updated first. */
const MAX_LISTED = 1000;
/** Decisions linked to each change. */
const MAX_LINKED = 3;
/** Linkage looks at the project's newest decisions, at most this many. */
const DECISIONS_SCANNED = 2000;
/** The default listing window: the last 24 hours. */
const RECENT_MS = 24 * 60 * 60 * 1000;

const KINDS: readonly SymbolChangeKind[] = ['signature', 'removed', 'renamed'];
export const SYMBOL_CHANGE_STATUSES: readonly SymbolChangeStatus[] = ['in_progress', 'landed', 'withdrawn', 'superseded'];
const DEFAULT_STATUSES: readonly SymbolChangeStatus[] = ['in_progress', 'landed'];

/** A SymbolChangeInput, validated and normalized. */
export interface ChangeInput {
  file: string;
  /** A declaration key (not @imports or @toplevel), NFC. */
  symbol: string;
  kind: SymbolChangeKind;
  before: string;
  /** null for removed; for renamed, the new key's signature (or null). */
  after: string | null;
  renamed_to: string | null;
  /** As the request names it; a landed change takes its landing's task instead. */
  task_id: string | undefined;
}

/** What a listing asks for: `since_ms` (a time, ms since the epoch; null: the last 24 hours) and the statuses. */
export interface ListingFilter {
  since_ms: number | null;
  statuses: SymbolChangeStatus[];
}

// ------------------------------------------------------------------ requests

/** POST /symbol-changes: 400 bad_request, invalid_path or invalid_symbol, 403 forbidden for a reserved path; nothing is written then. */
export function parseSymbolChangesRequest(body: unknown): ChangeInput[] {
  const req = isObject(body) ? body : null;
  if (!req || !Array.isArray(req.changes)) throw bad('the request is {changes: [...]}, the signature changes of your edit');
  if (req.changes.length > MAX_POSTED_CHANGES) throw bad(`at most ${MAX_POSTED_CHANGES} changes at a time`);
  return req.changes.map((c, i) => parseSymbolChange(c, `changes[${i}]`));
}

/** The lander's changes of a landing: each one checked like an agent's, and one the hub can't record left out. */
export function landedChangeInputs(raw: readonly unknown[]): ChangeInput[] {
  const out: ChangeInput[] = [];
  for (const [i, c] of raw.entries()) {
    try {
      out.push(parseSymbolChange(c, `symbol_changes[${i}]`));
    } catch (err) {
      if (!(err instanceof HubError)) throw err;
    }
  }
  return out;
}

/**
 * One SymbolChangeInput. `symbol` (and a rename's `renamed_to`) must be a
 * declaration key: SYMBOL_KEY_RE once NFC-normalized, at most 200 characters,
 * and not one of the regions @imports or @toplevel, which have no signature
 * (400 invalid_symbol). Signature text loses control and bidi characters and
 * is cut to 500 characters. `after` is required for a signature change and
 * must be null for a removed symbol; `renamed_to` goes with renamed only.
 */
export function parseSymbolChange(value: unknown, at: string): ChangeInput {
  if (!isObject(value)) throw bad(`${at} must be an object: {file, symbol, kind, before, after, renamed_to?, task_id?}`);
  const file = assertNotReserved(normalizeRepoPath(value.file));
  const symbol = declarationKey(value.symbol, `${at}.symbol`);
  if (typeof value.kind !== 'string' || !KINDS.includes(value.kind as SymbolChangeKind)) throw bad(`${at}.kind must be one of ${KINDS.join(', ')}`);
  const kind = value.kind as SymbolChangeKind;
  const before = signature(value.before, `${at}.before`);
  const after = value.after === undefined || value.after === null ? null : signature(value.after, `${at}.after`);
  if (kind === 'signature' && after === null) throw bad(`${at}: a signature change needs after, the new signature`);
  if (kind === 'removed' && after !== null) throw bad(`${at}: a removed symbol has no after (null)`);
  let renamed_to: string | null = null;
  if (kind === 'renamed') {
    if (value.renamed_to === undefined || value.renamed_to === null) throw bad(`${at}: a rename needs renamed_to, the new key`);
    renamed_to = declarationKey(value.renamed_to, `${at}.renamed_to`);
  } else if (value.renamed_to !== undefined && value.renamed_to !== null) {
    throw bad(`${at}: renamed_to goes with kind renamed only`);
  }
  return { file, symbol, kind, before, after, renamed_to, task_id: idOf(value.task_id, 'task_id') };
}

/** GET /symbol-changes?since_ms=&status=: since_ms a time in ms (default: 24 hours ago); status a list (default in_progress and landed). */
export function parseListing(opts: { since_ms?: unknown; statuses?: unknown }): ListingFilter {
  let since_ms: number | null = null;
  if (opts.since_ms !== undefined && opts.since_ms !== null && opts.since_ms !== '') {
    const n = typeof opts.since_ms === 'number' || typeof opts.since_ms === 'string' ? Number(opts.since_ms) : NaN;
    if (!Number.isFinite(n) || n < 0) throw bad('since_ms must be a time: milliseconds since the Unix epoch');
    since_ms = n;
  }
  let statuses = [...DEFAULT_STATUSES];
  if (opts.statuses !== undefined && opts.statuses !== null) {
    if (!Array.isArray(opts.statuses) || opts.statuses.some((st) => !SYMBOL_CHANGE_STATUSES.includes(st as SymbolChangeStatus))) {
      throw bad(`status must be among ${SYMBOL_CHANGE_STATUSES.join(', ')}`);
    }
    if (opts.statuses.length > 0) statuses = [...new Set(opts.statuses as SymbolChangeStatus[])];
  }
  return { since_ms, statuses };
}

// ------------------------------------------------------------------ writes

/**
 * An agent's in-progress changes, in order, inside Hub.write. Each one
 * updates the agent's open row of its (file, symbol) or opens one (S-n); the
 * row keeps the `before` of the agent's first change of the symbol. A change
 * whose `after` equals its own `before`, or the open row's, withdraws that row
 * (and records nothing when none is open). The task is the one the change
 * names, else the agent's only task in progress, else the open row's. A change
 * that leaves its row as it was is not written again. Returns the rows each
 * change ended up in, once each.
 */
export function recordSymbolChanges(ix: HubInternals, project: string, agent: string, changes: readonly ChangeInput[], now: number): SymbolChangeRow[] {
  const { store } = ix;
  const out = new Map<string, SymbolChangeRow>();
  for (const c of changes) {
    const open = openChange(store, project, agent, c.file, c.symbol);
    const taskId = ix.resolveTaskId(project, agent, c.task_id) ?? open?.task_id ?? null;
    if (c.after !== null && (c.after === c.before || c.after === open?.before)) {
      if (!open) continue;
      const [withdrawn] = store.updateSymbolChanges({ project, ids: [open.id] }, { status: 'withdrawn', updated_at: now });
      emitChanged(ix, project, withdrawn, agent);
      out.set(withdrawn.id, withdrawn);
      continue;
    }
    const next: Omit<SymbolChangeRow, 'id'> = {
      project,
      agent,
      task_id: taskId,
      landing_id: null,
      file: c.file,
      symbol: c.symbol,
      name: nameOf(c.symbol),
      kind: c.kind,
      before: open?.before ?? c.before,
      after: c.after,
      renamed_to: c.renamed_to,
      status: 'in_progress',
      created_at: now,
      updated_at: now,
    };
    if (open && sameChange(open, next)) {
      out.set(open.id, open);
      continue;
    }
    const row = store.upsertSymbolChange(next);
    emitChanged(ix, project, row, agent);
    out.set(row.id, row);
  }
  return [...out.values()];
}

/**
 * The landed effect of Phase 3 (design §1.4, §2.5), inside the landed write
 * of advance or resolve: the changes the lander reported become landed rows
 * of the landing (its author and its task; one per file and symbol, the last
 * reported; none where after equals before), then the author's in-progress
 * rows for the landing's task (those without a task, for a landing without
 * one) are superseded, whether or not the landing reported a change.
 */
export function recordLandedChanges(
  ix: HubInternals,
  project: string,
  landing: Pick<Landing, 'id' | 'agent' | 'task_id'>,
  changes: readonly ChangeInput[],
  now: number,
  actor: string,
): { landed: SymbolChangeRow[]; superseded: SymbolChangeRow[] } {
  const { store } = ix;
  const byKey = new Map<string, ChangeInput>();
  for (const c of changes) {
    if (c.after !== null && c.after === c.before) continue;
    byKey.set(`${c.file}\u0000${c.symbol}`, c);
  }
  const landed = [...byKey.values()].map((c) => {
    const row = store.upsertSymbolChange({
      project,
      agent: landing.agent,
      task_id: landing.task_id,
      landing_id: landing.id,
      file: c.file,
      symbol: c.symbol,
      name: nameOf(c.symbol),
      kind: c.kind,
      before: c.before,
      after: c.after,
      renamed_to: c.renamed_to,
      status: 'landed',
      created_at: now,
      updated_at: now,
    });
    emitChanged(ix, project, row, actor);
    return row;
  });
  const superseded = store.updateSymbolChanges({ project, agent: landing.agent, task_id: landing.task_id, statuses: ['in_progress'] }, { status: 'superseded', updated_at: now });
  for (const row of superseded) emitChanged(ix, project, row, actor);
  return { landed, superseded };
}

// ------------------------------------------------------------------ reads

/** The changes updated since `filter.since_ms` (default: 24 hours before `now`) in its statuses, newest first, with their decisions. */
export function listSymbolChanges(store: Store, project: string, filter: ListingFilter, now: number): SymbolChange[] {
  const since = filter.since_ms ?? now - RECENT_MS;
  return linkDecisions(store, project, store.listSymbolChanges(project, { since, statuses: filter.statuses, limit: MAX_LISTED }));
}

/**
 * Each row with up to 3 decisions, newest first: those of the row's task, and
 * those whose symbols name its key or its name (`Session.refresh` or
 * `refresh`), also as `file#key` or `file#name` of its file, with or without a
 * trailing `()`. Decisions are agent-written: the id, author and summary only.
 */
export function linkDecisions(store: Store, project: string, rows: readonly SymbolChangeRow[]): SymbolChange[] {
  if (rows.length === 0) return [];
  const decisions = store.listDecisions(project, DECISIONS_SCANNED);
  const byTask = new Map<string, number[]>();
  const bySymbol = new Map<string, number[]>();
  decisions.forEach((d, i) => {
    if (d.task_id) push(byTask, d.task_id, i);
    for (const ref of new Set(d.symbols.map(symbolRef))) push(bySymbol, ref, i);
  });
  return rows.map((row) => {
    const hits = new Set<number>(row.task_id ? (byTask.get(row.task_id) ?? []) : []);
    for (const ref of new Set([row.symbol, row.name, `${row.file}#${row.symbol}`, `${row.file}#${row.name}`])) {
      for (const i of bySymbol.get(ref) ?? []) hits.add(i);
    }
    const linked = [...hits]
      .sort((a, b) => a - b)
      .slice(0, MAX_LINKED)
      .map((i) => ({ id: decisions[i].id, agent: decisions[i].agent, summary: decisions[i].summary }));
    return { ...row, decisions: linked };
  });
}

// ------------------------------------------------------------------ parts

/** The part of a key references are matched by: its last segment (`refresh` of `Session.refresh`). */
export function nameOf(symbol: string): string {
  return symbol.slice(symbol.lastIndexOf('.') + 1);
}

/** The agent's open (in-progress) row of a file and symbol: an empty patch only reads. */
function openChange(store: Store, project: string, agent: string, file: string, symbol: string): SymbolChangeRow | null {
  return store.updateSymbolChanges({ project, agent, file, symbol, statuses: ['in_progress'] }, {})[0] ?? null;
}

function sameChange(a: Omit<SymbolChangeRow, 'id'>, b: Omit<SymbolChangeRow, 'id'>): boolean {
  return a.kind === b.kind && a.before === b.before && a.after === b.after && a.renamed_to === b.renamed_to && a.task_id === b.task_id && a.name === b.name;
}

/** symbol.changed: ids, file, key, name, kind and status (design §1.8). No signature text, no rename target. */
function emitChanged(ix: HubInternals, project: string, row: SymbolChangeRow, actor: string): void {
  ix.emit(project, 'symbol.changed', actor, {
    change_id: row.id,
    agent: row.agent,
    file: row.file,
    symbol: row.symbol,
    name: row.name,
    kind: row.kind,
    status: row.status,
    landing_id: row.landing_id,
    task_id: row.task_id,
  });
}

function declarationKey(value: unknown, at: string): string {
  const key = typeof value === 'string' ? value.normalize('NFC') : '';
  if (!isValidSymbolKey(key) || key.startsWith('@')) {
    throw new HubError('invalid_symbol', `${at} must be a declaration key such as login or Session.refresh (SYMBOL_KEY_RE, at most 200 characters; @imports and @toplevel have no signature)`);
  }
  return key;
}

function signature(value: unknown, at: string): string {
  if (typeof value !== 'string') throw bad(`${at} must be the signature text`);
  const text = cleanText(value, MAX_SIGNATURE, true);
  if (!text) throw bad(`${at} is empty`);
  return text;
}

/** How a decision names a symbol: as written, NFC, without a trailing `()`. */
function symbolRef(s: string): string {
  return s.normalize('NFC').trim().replace(/\(\)$/, '');
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bad(message: string): HubError {
  return new HubError('bad_request', message);
}
