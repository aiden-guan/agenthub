// Phase 3 symbol scopes in the adapter (design §1.10, §2.3.6): which
// declarations an edit, a staged commit or a landing changes, as claim and
// check scopes the hub compares entry by entry.
//
// - editScope: the pre-edit hook's scope. Edit and MultiEdit are deterministic
//   string replacements, so the hook simulates the exact post-edit text
//   (applyEdit, in order) and diffs the two outlines (changedSymbols). Write,
//   NotebookEdit, new files and anything that can't be mapped claim the whole
//   file.
// - The edit state: for a symbol-level edit, the file before it and the hash
//   of the simulated result, saved beside the call's in-flight marker
//   (G/agenthub/edits/<session>~<tool>), so post-edit can tell whether the tool
//   wrote something else and claim what it really changed (§4.2 #2).
// - stagedScope / diffScope: the guard's and land's scopes, from blob pairs
//   (HEAD → index, landed base → HEAD). Only modifications of regular files
//   are mapped, at most `maxFiles` of them within `budgetMs`; added, deleted,
//   renamed and type-changed files, merges, and anything beyond the cap or the
//   budget are whole files.
// - claimTargets: `path#Symbol` arguments of the claim and hub_wait tools.
//
// @agenthub/symbols (tree-sitter) is loaded only when something is mapped, so
// hooks that map nothing never load it.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { entryCovers, isValidSymbolKey, matchesAny, type SymbolsConfig } from '@agenthub/contract';
import type { ScopeEntry } from '@agenthub/hub/protocol';
import type { FileLevelReason } from '@agenthub/symbols';
import { stagedPaths } from './git.js';
import { MARKER_STALE_MS, markerName, syncPaths } from './sync.js';

type SymbolsModule = typeof import('@agenthub/symbols');

let loading: Promise<SymbolsModule | null> | null = null;

/** @agenthub/symbols, loaded once on first use; null when it can't be loaded (everything is then file-level). */
export function symbolsModule(): Promise<SymbolsModule | null> {
  loading ??= import('@agenthub/symbols').catch(() => null);
  return loading;
}

/** Files larger than this are never read for mapping (the symbols package maps them whole-file anyway). */
export const MAX_MAPPED_BYTES = 1024 * 1024;
/** The guard and land map at most this many modified files ... */
export const MAX_MAPPED_FILES = 200;
/** ... within this budget; the rest are whole files (design §2.3.6). */
export const MAPPING_BUDGET_MS = 10_000;
/** A commit or a landing diff with more keys than this in one file claims the whole file (design §1.10). */
export const MAX_SYMBOLS_PER_FILE = 40;
/** At most this many symbol entries go into a land request; files beyond them are sent whole (the hub's body limit). */
export const MAX_LAND_SYMBOL_ENTRIES = 4000;

/**
 * Extensions @agenthub/symbols maps (design §2.4 "Languages"), only as a fast
 * negative filter: an edit of any other file claims it whole without loading
 * tree-sitter (about 40 ms). The package's languageFor decides for these. A
 * language the package adds later is file-level here until this list has it.
 */
const MAPPED_EXTENSIONS = new Set(['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'py', 'pyi', 'go', 'rs', 'java']);

function mappedExtension(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 && MAPPED_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** Why an edit claims its whole file: the symbols package's reasons, plus `unchanged` (the edit changes no text). */
export type WholeFileReason = FileLevelReason | 'unchanged';

export interface EditScope {
  /** The repo path. */
  file: string;
  /** The keys the edit changes, in source order; null: the whole file. */
  symbols: string[] | null;
  /** MAPPER_VERSION of the symbols; null for the whole file. */
  mapper: string | null;
  /** Why the whole file; null when symbol-level. */
  reason: WholeFileReason | null;
  /** The file as it is, and as the edit will leave it (symbol-level only, for post-edit). */
  before: string | null;
  after: string | null;
}

interface TextEditInput {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function textEdits(tool: string, input: Record<string, unknown>): TextEditInput[] | null {
  const list = tool === 'MultiEdit' ? input.edits : [input];
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: TextEditInput[] = [];
  for (const e of list as Array<Record<string, unknown>>) {
    if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null;
    out.push({ old_string: e.old_string, new_string: e.new_string, replace_all: e.replace_all === true });
  }
  return out;
}

/**
 * The scope of one edit tool call on `abs` (repo path `file`), design §1.10
 * "How edits map to keys": the declarations an Edit or MultiEdit changes, or
 * the whole file (with the reason).
 */
export async function editScope(o: { tool: string; input: Record<string, unknown>; abs: string; file: string; config: SymbolsConfig }): Promise<EditScope> {
  const whole = (reason: WholeFileReason): EditScope => ({ file: o.file, symbols: null, mapper: null, reason, before: null, after: null });
  if (o.tool === 'NotebookEdit') return whole('notebook');
  if (o.tool !== 'Edit' && o.tool !== 'MultiEdit') return whole('whole_file_write');
  if (!o.config.enabled) return whole('disabled');
  const edits = textEdits(o.tool, o.input);
  if (!edits) return whole('edit_not_applicable');
  if (!mappedExtension(o.file)) return whole('unsupported_language');
  const sym = await symbolsModule();
  if (!sym) return whole('grammar_unverified');
  if (!sym.languageFor(o.file)) return whole('unsupported_language');
  if (matchesAny(o.file, o.config.exclude)) return whole('excluded');
  let size: number;
  try {
    const st = statSync(o.abs);
    if (!st.isFile()) return whole('new_file');
    size = st.size;
  } catch {
    return whole('new_file');
  }
  if (size > MAX_MAPPED_BYTES) return whole('too_large');
  let before: string;
  try {
    before = readFileSync(o.abs, 'utf8');
  } catch {
    return whole('new_file');
  }
  let after: string | null = before;
  for (const e of edits) {
    after = sym.applyEdit(after, e);
    if (after === null) return whole('edit_not_applicable');
  }
  let diff: Awaited<ReturnType<SymbolsModule['changedSymbols']>>;
  try {
    diff = await sym.changedSymbols(o.file, before, after, { maxSymbols: o.config.maxSymbolsPerEdit, exclude: o.config.exclude });
  } catch {
    return whole('parse_error'); // a parser failure: the safe side
  }
  if (diff.fileLevel) return whole(diff.reason);
  if (diff.symbols.length === 0) return whole('unchanged');
  if (diff.symbols.some((k) => !isValidSymbolKey(k))) return whole('parse_error');
  return { file: o.file, symbols: diff.symbols, mapper: diff.mapper, reason: null, before, after };
}

/** What a whole-file claim of an edit is for, in a deny reason: "it ...". */
export function wholeFileWhy(reason: WholeFileReason | null, maxSymbols: number): string {
  switch (reason) {
    case 'parse_error':
      return 'it leaves a syntax error outside any one declaration';
    case 'too_many_symbols':
      return `it changes more than ${maxSymbols} declarations`;
    case 'edit_not_applicable':
      return "its old_string doesn't occur exactly once";
    case 'too_large':
      return 'the file is over 1 MiB';
    case 'binary':
      return 'the file is binary';
    case 'new_file':
      return 'the file is new';
    case 'grammar_unverified':
      return "the file's grammar couldn't be verified";
    case 'disabled':
      return 'symbol claims are off in agenthub.json';
    case 'excluded':
      return 'agenthub.json excludes it from symbol claims';
    case 'unsupported_language':
      return "its language isn't mapped to declarations";
    case 'notebook':
      return 'notebooks are claimed whole';
    case 'unchanged':
      return 'it changes no text';
    default:
      return "it can't be mapped to declarations";
  }
}

// ------------------------------------------------------------------ the edit state, for post-edit

export interface EditState {
  v: 1;
  session: string;
  tool: string;
  /** The repo path and where the file is. */
  file: string;
  abs: string;
  before: string;
  /** sha256 of the simulated result: what the tool should write. */
  after_sha256: string;
  /** The keys pre-edit claimed, and their mapper. */
  symbols: string[];
  mapper: string;
  at: number;
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Save the state of a symbol-level edit beside its marker. Best effort: without it post-edit just checks nothing. */
export function saveEditState(root: string, call: { session: string; tool: string }, scope: EditScope, abs: string): void {
  const p = syncPaths(root);
  if (!p || scope.symbols === null || scope.before === null || scope.after === null || scope.mapper === null) return;
  try {
    mkdirSync(p.edits, { recursive: true });
    pruneEditStates(p.edits);
    const state: EditState = {
      v: 1,
      session: call.session,
      tool: call.tool,
      file: scope.file,
      abs,
      before: scope.before,
      after_sha256: sha256(scope.after),
      symbols: scope.symbols,
      mapper: scope.mapper,
      at: Date.now(),
    };
    writeFileSync(path.join(p.edits, markerName(call)), JSON.stringify(state));
  } catch {
    // then post-edit has nothing to compare with
  }
}

/** The saved state of this call, removed as it is read (null when there is none, or it is another call's). */
export function takeEditState(root: string, call: { session: string; tool: string }): EditState | null {
  const p = syncPaths(root);
  if (!p) return null;
  const file = path.join(p.edits, markerName(call));
  let state: Partial<EditState> | null = null;
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) as Partial<EditState>;
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
  const ok =
    state?.v === 1 &&
    state.session === call.session &&
    state.tool === call.tool &&
    typeof state.file === 'string' &&
    typeof state.abs === 'string' &&
    typeof state.before === 'string' &&
    typeof state.after_sha256 === 'string' &&
    typeof state.mapper === 'string' &&
    Array.isArray(state.symbols) &&
    state.symbols.every((k) => typeof k === 'string');
  return ok ? (state as EditState) : null;
}

function pruneEditStates(dir: string): void {
  const now = Date.now();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      if (now - statSync(path.join(dir, name)).mtimeMs >= MARKER_STALE_MS) rmSync(path.join(dir, name), { force: true });
    } catch {
      // gone meanwhile
    }
  }
}

/**
 * What the tool really changed, when it wrote something other than the
 * simulated result: the entries pre-edit's claim doesn't cover (whole file
 * when the change can't be mapped), with their mapper. Null when it wrote
 * exactly what was simulated, or nothing is missing.
 */
export async function missingAfterEdit(state: EditState, config: SymbolsConfig): Promise<{ entries: ScopeEntry[]; mapper: string | null; reason: WholeFileReason | null } | null> {
  const whole = (reason: WholeFileReason) => ({ entries: [{ file: state.file }], mapper: null, reason });
  let actual: string | null;
  try {
    if (statSync(state.abs).size > MAX_MAPPED_BYTES) return whole('too_large');
    actual = readFileSync(state.abs, 'utf8');
  } catch {
    actual = null; // deleted meanwhile
  }
  if (actual !== null && sha256(actual) === state.after_sha256) return null;
  const sym = await symbolsModule();
  if (!sym) return whole('grammar_unverified');
  let diff: Awaited<ReturnType<SymbolsModule['changedSymbols']>>;
  try {
    diff = await sym.changedSymbols(state.file, state.before, actual, { maxSymbols: config.maxSymbolsPerEdit, exclude: config.exclude });
  } catch {
    return whole('parse_error');
  }
  if (diff.fileLevel) return whole(diff.reason);
  // A key pre-edit's claim covers (itself or its container), under the same mapper, is held already.
  const held = diff.mapper === state.mapper ? state.symbols : [];
  const missing = diff.symbols.filter((k) => isValidSymbolKey(k) && !held.some((h) => entryCovers({ file: state.file, symbol: h }, { file: state.file, symbol: k })));
  if (diff.symbols.some((k) => !isValidSymbolKey(k))) return whole('parse_error');
  return missing.length ? { entries: missing.map((symbol) => ({ file: state.file, symbol })), mapper: diff.mapper, reason: null } : null;
}

// ------------------------------------------------------------------ blob pairs: the guard and land

interface RawChange {
  path: string;
  status: string;
  srcMode: string;
  dstMode: string;
  src: string;
  dst: string;
}

/** `git diff --raw -z --no-renames` output: `:<mode> <mode> <sha> <sha> <status>\0<path>\0`. */
function parseRaw(out: string): RawChange[] {
  const parts = out.split('\0');
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(parts[i]!);
    if (!m) continue;
    changes.push({ srcMode: m[1]!, dstMode: m[2]!, src: m[3]!, dst: m[4]!, status: m[5]!, path: parts[i + 1]!.normalize('NFC') });
  }
  return changes;
}

const REGULAR = new Set(['100644', '100755']);

/** Run git and return its stdout as bytes; rejects on a failure or a timeout. */
function gitBytes(root: string, args: string[], input: string | null, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0]} timed out`));
    }, Math.max(1, timeoutMs));
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`git ${args[0]} exited ${code}: ${err.trim().split('\n')[0] ?? ''}`));
    });
    child.stdin.on('error', () => {
      // git may exit before reading all of its input: its exit code says what happened
    });
    child.stdin.end(input ?? '');
  });
}

/** Blob contents by sha, through one `git cat-file --batch`; blobs over MAX_MAPPED_BYTES are left out. */
async function readBlobs(root: string, shas: string[], timeoutMs: number): Promise<Map<string, Buffer>> {
  const unique = [...new Set(shas)];
  const out = new Map<string, Buffer>();
  if (!unique.length) return out;
  const sizes = new Map<string, number>();
  const check = (await gitBytes(root, ['cat-file', '--batch-check'], `${unique.join('\n')}\n`, timeoutMs)).toString('utf8');
  for (const line of check.split('\n')) {
    const [sha, type, size] = line.split(' ');
    if (sha && type === 'blob' && Number(size) <= MAX_MAPPED_BYTES) sizes.set(sha, Number(size));
  }
  const wanted = unique.filter((s) => sizes.has(s));
  if (!wanted.length) return out;
  const buf = await gitBytes(root, ['cat-file', '--batch'], `${wanted.join('\n')}\n`, timeoutMs);
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    if (nl < 0) break;
    const [sha, type, size] = buf.subarray(at, nl).toString('utf8').split(' ');
    const n = Number(size);
    if (type !== 'blob' || !Number.isFinite(n)) break;
    out.set(sha!, buf.subarray(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1; // the content, then a newline
  }
  return out;
}

export interface MappedScope {
  /** Every changed path, in git's order. */
  files: string[];
  /** One entry per changed key of a mapped file, and a whole-file entry for every other path. */
  scope: ScopeEntry[];
  /** MAPPER_VERSION when mapping was possible (symbols enabled, the package loaded), else null. */
  mapper: string | null;
}

interface MapOptions {
  symbols: SymbolsConfig;
  /** Default MAX_MAPPED_FILES. */
  maxFiles?: number;
  /** Default MAPPING_BUDGET_MS. */
  budgetMs?: number;
  /** Load the symbols package for its mapper even when no file can be mapped (land: the agent's own symbol claims go by it). */
  wantMapper?: boolean;
}

async function mapChanges(root: string, changes: RawChange[], o: MapOptions): Promise<MappedScope> {
  const started = Date.now();
  const deadline = started + (o.budgetMs ?? MAPPING_BUDGET_MS);
  const files = [...new Set(changes.map((c) => c.path))];
  const mappable = changes.filter((c) => c.status === 'M' && REGULAR.has(c.srcMode) && REGULAR.has(c.dstMode) && mappedExtension(c.path) && !matchesAny(c.path, o.symbols.exclude));
  // tree-sitter is loaded only when there is something to map (or the mapper itself is wanted).
  const sym = o.symbols.enabled && (mappable.length > 0 || o.wantMapper) ? await symbolsModule() : null;
  const whole = (): MappedScope => ({ files, scope: files.map((file) => ({ file })), mapper: sym ? sym.MAPPER_VERSION : null });
  if (!sym) return whole();
  const candidates = mappable.filter((c) => sym.languageFor(c.path) !== null).slice(0, o.maxFiles ?? MAX_MAPPED_FILES);
  if (!candidates.length || Date.now() >= deadline) return whole();
  let blobs: Map<string, Buffer>;
  try {
    blobs = await readBlobs(root, candidates.flatMap((c) => [c.src, c.dst]), deadline - Date.now());
  } catch {
    return whole();
  }
  const keys = new Map<string, string[]>();
  for (const c of candidates) {
    if (Date.now() >= deadline) break;
    const before = blobs.get(c.src);
    const after = blobs.get(c.dst);
    if (!before || !after) continue;
    try {
      const diff = await sym.changedSymbols(c.path, before.toString('utf8'), after.toString('utf8'), { maxSymbols: MAX_SYMBOLS_PER_FILE, exclude: o.symbols.exclude });
      if (!diff.fileLevel && diff.symbols.length > 0 && diff.symbols.every(isValidSymbolKey) && diff.mapper === sym.MAPPER_VERSION) keys.set(c.path, diff.symbols);
    } catch {
      // that file stays whole
    }
  }
  const scope = files.flatMap((file): ScopeEntry[] => keys.get(file)?.map((symbol) => ({ file, symbol })) ?? [{ file }]);
  return { files, scope, mapper: sym.MAPPER_VERSION };
}

/**
 * The guard's scope (design §2.3.6): each staged modification mapped from its
 * HEAD blob to its index blob. In a merge (`merging`: the commits it brings
 * in), every path the merge changes itself is a whole file, as in Phase 1.
 * Throws when git fails, so a failure never reads as "nothing staged".
 */
export async function stagedScope(root: string, o: MapOptions & { merging: string[] }): Promise<MappedScope> {
  if (o.merging.length) {
    const files = stagedPaths(root, o.merging);
    return { files, scope: files.map((file) => ({ file })), mapper: null };
  }
  const raw = await gitBytes(root, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev'], null, 120_000).catch((err: Error) => {
    throw new Error(`git diff --cached failed: ${err.message}`);
  });
  return mapChanges(root, parseRaw(raw.toString('utf8')), o);
}

/** Land's advisory scope (design §2.3.2 step 5): the change from `base` to `head`, mapped the same way. */
export async function diffScope(root: string, base: string, head: string, o: MapOptions): Promise<MappedScope> {
  const raw = await gitBytes(root, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', base, head], null, 120_000);
  return mapChanges(root, parseRaw(raw.toString('utf8')), o);
}

// ------------------------------------------------------------------ path#Symbol

export interface Target {
  /** The repo path. */
  file: string;
  /** A declaration key, or null for the whole file. */
  symbol: string | null;
}

/**
 * Split `path#Symbol` into its path and key. A suffix that isn't a valid key,
 * or a name that is itself an existing file (`notes#1`), is all path.
 */
export function splitTarget(raw: string, cwd: string): { path: string; symbol: string | null } {
  const at = raw.lastIndexOf('#');
  if (at > 0) {
    const symbol = raw.slice(at + 1).normalize('NFC');
    if (isValidSymbolKey(symbol) && !existsSync(path.resolve(cwd, raw))) return { path: raw.slice(0, at), symbol };
  }
  return { path: raw, symbol: null };
}

/** Targets keyed as the edit hook keys files (`keyOf`), in order, without repeats. */
export function claimTargets(raw: readonly string[], cwd: string, keyOf: (p: string) => string): Target[] {
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const r of raw) {
    const t = splitTarget(r, cwd);
    const target = { file: keyOf(t.path), symbol: t.symbol };
    const id = `${target.file}\0${target.symbol ?? ''}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(target);
    }
  }
  return out;
}

/** The scope entries of targets: a whole-file target subsumes the symbols of its file. */
export function targetEntries(targets: readonly Target[]): ScopeEntry[] {
  const whole = new Set(targets.filter((t) => t.symbol === null).map((t) => t.file));
  return targets.filter((t) => t.symbol === null || !whole.has(t.file)).map((t) => (t.symbol === null ? { file: t.file } : { file: t.file, symbol: t.symbol }));
}
