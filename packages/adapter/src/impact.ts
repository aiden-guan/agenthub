// Phase 3 impact warnings in the adapter (design §2.5, §3.12, §2.3.6).
//
// When another agent changes a declaration's signature (in progress, from its
// post-edit hook, or landed, from the lander), the hub records it and emits
// `symbol.changed` with ids and names only. There is no hub-stored reference
// index (§0.4 #4): each agent's adapter decides relevance against its own
// claimed bytes, so uncommitted callers count too.
//
// - relevant(change, me): one of my live claims (holds included) names a file
//   whose current bytes use the changed name as an identifier (never in a
//   comment or a string), in a declaration the claim holds (any, for a
//   whole-file claim or one made under another mapper), and, for a top-level
//   symbol used from another file, the import filter passes.
// - The reference cache (who_uses, callers_free): candidates from `git grep`,
//   each read once per content: the key is the blob id plus the mapper, the
//   value symbols.identifierIndex() (and importsText(), for the filter), under
//   <git-common-dir>/agenthub/refcache, so an entry can never be stale.
//   Entries unused for 30 days are pruned.
// - Acks (the impacts tool): <git-dir>/agenthub/impacts-acked.json, id →
//   the updated_at acknowledged; a change updated since is shown again.
// - The pre-edit note reads the recent changes through a 60 s cache
//   (<git-dir>/agenthub/symbol-changes.json) and says each change once per
//   session (<git-dir>/agenthub/impact-shown).
//
// All of it is advisory: a failure means no warning, never a blocked edit.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IMPORTS, isValidSymbolKey, overlappingEntries } from '@agenthub/contract';
import type { Claim, SymbolChange, SymbolChangeStatus } from '@agenthub/hub/protocol';
import type { HubClient } from './client.js';
import { gitCommonDir, gitDir } from './git.js';
import { MAX_MAPPED_BYTES, mappedExtension, symbolsModule } from './symbol-scope.js';

type SymbolsModule = NonNullable<Awaited<ReturnType<typeof symbolsModule>>>;

/** The statuses other agents are told of: a change being made, and a change on trunk. */
const TOLD: ReadonlySet<SymbolChangeStatus> = new Set(['in_progress', 'landed']);

export function isNews(c: Pick<SymbolChange, 'status'>): boolean {
  return TOLD.has(c.status);
}

/** Languages whose files name what they use in import statements (design §2.5); Go goes by package directory. */
const IMPORTING = new Set(['typescript', 'tsx', 'javascript', 'python', 'rust', 'java']);

/** Two keys of one file touch when they are equal or one holds the other (`Session` and `Session.refresh`). */
export function keysTouch(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf('.') + 1);
}

function dirOf(file: string): string {
  const at = file.lastIndexOf('/');
  return at < 0 ? '' : file.slice(0, at);
}

/**
 * What another file's imports name a module by: the basename without its
 * extension, or the directory's name for index.*, __init__.py and mod.rs.
 */
export function moduleStem(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  if (stem === 'index' || stem === '__init__' || (stem === 'mod' && ext === 'rs')) {
    const dir = dirOf(file);
    return dir ? dir.slice(dir.lastIndexOf('/') + 1) : stem;
  }
  return stem;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `word` occurs in `text` as a whole name: not inside a longer identifier (`auth` in `./auth.js` or `app.auth`, not in `oauth`). */
export function mentions(text: string, word: string): boolean {
  if (!word) return true;
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRe(word)}(?![\\p{L}\\p{N}_$])`, 'u').test(text);
}

/** The import paths of Go import text: its quoted strings. */
function goImportPaths(imports: string): string[] {
  return [...imports.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? '');
}

/**
 * The import filter (design §2.5): a top-level symbol used from another file
 * counts only when that file's imports name the declaring module (by its
 * stem), or for Go when the file is in the declaring directory or imports a
 * path whose last segment is that directory's. Members (`Session.refresh`)
 * are reached through objects, so no import names them. When the imports
 * can't be read, the use counts (a warning too many, not one too few).
 */
export function passesImportFilter(o: { file: string; language: string | null; imports: string | null }, change: Pick<SymbolChange, 'file' | 'symbol'>): boolean {
  if (change.symbol.includes('.') || o.file === change.file || o.language === null) return true;
  if (o.language === 'go') {
    const dir = dirOf(change.file);
    if (dirOf(o.file) === dir || !dir || o.imports === null) return true;
    const segment = dir.slice(dir.lastIndexOf('/') + 1);
    return goImportPaths(o.imports).some((p) => p.slice(p.lastIndexOf('/') + 1) === segment);
  }
  if (!IMPORTING.has(o.language) || o.imports === null) return true;
  return mentions(o.imports, moduleStem(change.file));
}

// ------------------------------------------------------------------ relevance

export interface ImpactSite {
  claim_id: string;
  /** Set when the claim is a landing's hold. */
  landing_id: string | null;
  file: string;
  /** The file's keys that use the changed name and that the claim holds (all that use it, for a whole-file claim). */
  keys: string[];
  /** The claim counts as the whole file: no symbols, or made under another mapper. */
  whole: boolean;
}

export interface Impact {
  change: SymbolChange;
  sites: ImpactSite[];
}

export interface RelevanceContext {
  /** The checkout whose bytes count: the agent's own. */
  root: string;
  /** Claims; the live ones of `me` (active or queued, holds included) are what is checked. */
  claims: readonly Claim[];
}

function readSmall(abs: string): string | null {
  try {
    if (statSync(abs).size > MAX_MAPPED_BYTES) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

interface FileView {
  file: string;
  language: string | null;
  text: string;
  refs: Map<string, string[]>;
  imports?: string | null;
}

/** relevant(change, me) of design §2.5: the sites of my live claims that use what `change` changed, or null. */
export async function relevant(change: SymbolChange, me: string, ctx: RelevanceContext): Promise<Impact | null> {
  return (await relevantAll([change], me, ctx))[0] ?? null;
}

/** relevant() for many changes at once: each claimed file is read and parsed once. In the order given. */
export async function relevantAll(changes: readonly SymbolChange[], me: string, ctx: RelevanceContext): Promise<Impact[]> {
  const wanted = changes.filter((c) => c.agent !== me && isNews(c) && c.name);
  if (!wanted.length) return [];
  const mine = ctx.claims.filter((c) => c.holder === me && (c.status === 'active' || c.status === 'queued'));
  if (!mine.length) return [];
  const sym = await symbolsModule();
  if (!sym) return [];
  const byFile = new Map<string, Claim[]>();
  for (const c of mine) {
    for (const file of new Set(c.scope.map((e) => e.file))) {
      const list = byFile.get(file);
      if (list) list.push(c);
      else byFile.set(file, [c]);
    }
  }
  const names = [...new Set(wanted.map((c) => c.name))];
  const views = new Map<string, FileView | null>();
  const viewOf = async (file: string): Promise<FileView | null> => {
    if (views.has(file)) return views.get(file)!;
    let view: FileView | null = null;
    const language = mappedExtension(file) ? sym.languageFor(file) : null;
    const text = language ? readSmall(path.join(ctx.root, file)) : null;
    if (language && text !== null && names.some((n) => text.includes(n))) {
      const refs = await sym.referencesIn(file, text, names).catch(() => null);
      if (refs) view = { file, language, text, refs };
    }
    views.set(file, view);
    return view;
  };
  const importsOf = async (view: FileView): Promise<string | null> => {
    if (view.imports === undefined) view.imports = await sym.importsText(view.file, view.text).catch(() => null);
    return view.imports;
  };

  const out: Impact[] = [];
  for (const change of wanted) {
    const sites: ImpactSite[] = [];
    for (const [file, claims] of byFile) {
      const view = await viewOf(file);
      const keys = view?.refs.get(change.name);
      if (!view || !keys?.length) continue;
      const imports = change.symbol.includes('.') || file === change.file ? null : await importsOf(view);
      if (!passesImportFilter({ file, language: view.language, imports }, change)) continue;
      for (const c of claims) {
        const entries = c.scope.filter((e) => e.file === file);
        const whole = c.mapper !== sym.MAPPER_VERSION || entries.some((e) => e.symbol === undefined);
        const hit = whole ? keys : keys.filter((k) => entries.some((e) => keysTouch(e.symbol!, k)));
        if (hit.length) sites.push({ claim_id: c.id, landing_id: c.landing_id, file, keys: hit, whole });
      }
    }
    if (sites.length) out.push({ change, sites });
  }
  return out;
}

/** Impacts in the order an agent reads them: those not acknowledged first, then the newest first. */
export function sortImpacts(impacts: readonly Impact[], acks: ReadonlyMap<string, number>): Impact[] {
  return [...impacts].sort((a, b) => Number(isAcked(acks, a.change)) - Number(isAcked(acks, b.change)) || b.change.updated_at - a.change.updated_at);
}

/**
 * The recent changes (the hub's default: the last 24 h, in progress and
 * landed), the agent's claims, and which of the changes touch them, sorted.
 */
export async function currentImpacts(root: string, me: string, project: string, client: HubClient, claims?: readonly Claim[]): Promise<{ impacts: Impact[]; acks: Map<string, number>; changes: SymbolChange[]; now: number }> {
  const listing = await client.symbolChanges();
  const mine = claims ?? (await client.claims({ holder: me }));
  const acks = readAcks(root, project);
  const impacts = sortImpacts(await relevantAll(listing.changes, me, { root, claims: mine }), acks);
  return { impacts, acks, changes: listing.changes, now: listing.now };
}

// ------------------------------------------------------------------ the pre-edit note

/**
 * Recent changes by others whose names the edited item uses (design §2.3.6
 * (5)): `keys` are the declarations the edit changes (null: the whole file),
 * `text` the file as the edit leaves it (or as it is). Acknowledged changes
 * stay out. For each change, the keys that use its name.
 */
export async function editImpacts(o: {
  file: string;
  text: string;
  keys: readonly string[] | null;
  me: string;
  changes: readonly SymbolChange[];
  acks: ReadonlyMap<string, number>;
}): Promise<Array<{ change: SymbolChange; keys: string[] }>> {
  const candidates = o.changes.filter((c) => c.agent !== o.me && isNews(c) && c.name && !isAcked(o.acks, c) && o.text.includes(c.name));
  if (!candidates.length || !mappedExtension(o.file)) return [];
  const sym = await symbolsModule();
  const language = sym?.languageFor(o.file) ?? null;
  if (!sym || !language) return [];
  const refs = await sym.referencesIn(o.file, o.text, [...new Set(candidates.map((c) => c.name))]).catch(() => null);
  if (!refs) return [];
  let imports: string | null | undefined;
  const out: Array<{ change: SymbolChange; keys: string[] }> = [];
  for (const change of candidates) {
    const used = (refs.get(change.name) ?? []).filter((k) => k !== IMPORTS);
    const keys = o.keys === null ? used : used.filter((k) => o.keys!.some((e) => keysTouch(e, k)));
    if (!keys.length) continue;
    if (!change.symbol.includes('.') && o.file !== change.file) imports ??= await sym.importsText(o.file, o.text).catch(() => null);
    if (!passesImportFilter({ file: o.file, language, imports: imports ?? null }, change)) continue;
    out.push({ change, keys });
  }
  return out;
}

/** The recent changes, from a listing at most `maxAgeMs` old (one per checkout, shared by its hook processes); null when there is none to be had. */
export async function cachedChanges(root: string, client: HubClient, o: { maxAgeMs?: number } = {}): Promise<SymbolChange[] | null> {
  const dir = agenthubDir(root);
  const file = dir ? path.join(dir, 'symbol-changes.json') : null;
  const maxAge = o.maxAgeMs ?? 60_000;
  let cached: { v: 1; url: string; project: string; at: number; changes: SymbolChange[] } | null = null;
  try {
    if (file) cached = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    cached = null;
  }
  const same = cached?.v === 1 && cached.url === client.cfg.url && cached.project === client.cfg.project && Array.isArray(cached.changes);
  if (same && Date.now() - cached!.at < maxAge && Date.now() >= cached!.at) return cached!.changes;
  try {
    const listing = await client.symbolChanges();
    if (file) writeAtomically(file, JSON.stringify({ v: 1, url: client.cfg.url, project: client.cfg.project, at: Date.now(), changes: listing.changes }));
    return listing.changes;
  } catch {
    return same && Date.now() - cached!.at < 10 * maxAge ? cached!.changes : null;
  }
}

/** Which of these changes this session was already told of by pre-edit; the rest are recorded as told. */
export function firstTimeInSession(root: string, session: string, changes: ReadonlyArray<Pick<SymbolChange, 'id' | 'updated_at'>>): Set<string> {
  const dir = agenthubDir(root);
  const fresh = new Set(changes.map((c) => c.id));
  if (!dir) return fresh;
  const file = path.join(dir, 'impact-shown');
  let lines: string[] = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    // none told yet
  }
  const seen = new Set(lines);
  const line = (c: Pick<SymbolChange, 'id' | 'updated_at'>) => `${session.replace(/\s/g, '_')}\t${c.id}@${c.updated_at}`;
  for (const c of changes) if (seen.has(line(c))) fresh.delete(c.id);
  const added = changes.filter((c) => fresh.has(c.id)).map(line);
  if (added.length) {
    try {
      writeAtomically(file, `${[...lines, ...added].slice(-500).join('\n')}\n`);
    } catch {
      // then it may be said again
    }
  }
  return fresh;
}

// ------------------------------------------------------------------ acknowledgements

function agenthubDir(root: string): string | null {
  const g = gitDir(root);
  return g ? path.join(g, 'agenthub') : null;
}

/** Where a checkout keeps the changes its agent acknowledged. */
export function acksPath(root: string): string | null {
  const dir = agenthubDir(root);
  return dir ? path.join(dir, 'impacts-acked.json') : null;
}

/** Change id → the updated_at acknowledged, for this project (another project's, or a broken file, reads as none). */
export function readAcks(root: string, project: string): Map<string, number> {
  const file = acksPath(root);
  try {
    const v = JSON.parse(readFileSync(file!, 'utf8'));
    if (v?.v !== 1 || v.project !== project || typeof v.acked !== 'object' || v.acked === null) return new Map();
    return new Map(Object.entries(v.acked as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number'));
  } catch {
    return new Map();
  }
}

/** Acknowledge changes as they are now; those acknowledged more than 30 days ago are forgotten. */
export function writeAcks(root: string, project: string, changes: ReadonlyArray<Pick<SymbolChange, 'id' | 'updated_at'>>): void {
  const file = acksPath(root);
  if (!file || !changes.length) return;
  const acks = readAcks(root, project);
  for (const c of changes) acks.set(c.id, Math.max(acks.get(c.id) ?? 0, c.updated_at));
  const cutoff = Date.now() - 30 * 24 * 3600_000;
  const kept = [...acks].filter(([, at]) => at >= cutoff);
  writeAtomically(file, JSON.stringify({ v: 1, project, acked: Object.fromEntries(kept) }));
}

export function isAcked(acks: ReadonlyMap<string, number>, c: Pick<SymbolChange, 'id' | 'updated_at'>): boolean {
  return (acks.get(c.id) ?? -1) >= c.updated_at;
}

function writeAtomically(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ------------------------------------------------------------------ the reference cache

/** Counters for tests and diagnostics: files parsed for the cache, and cache entries reused. */
export const refcacheStats = { parses: 0, hits: 0 };

const DAY_MS = 24 * 3600_000;
/** Entries not used for this long are pruned. */
const REFCACHE_KEEP_MS = 30 * DAY_MS;
/** A used entry's mtime is bumped at most this often (it marks it as used). */
const TOUCH_AFTER_MS = DAY_MS;
/** who_uses reads at most this many candidate files. */
const MAX_CANDIDATES = 1000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** `<blob>.<first 8 hex of sha256(mapper)>`: content and mapper decide the entry, so it never goes stale. */
export function refcacheKey(blob: string, mapper: string): string {
  return `${blob}.${sha256(mapper).slice(0, 8)}`;
}

/** <git-common-dir>/agenthub/refcache: every worktree of the repository shares it. */
export function refcacheDir(root: string): string | null {
  const common = gitCommonDir(root);
  return common ? path.join(common, 'agenthub', 'refcache') : null;
}

/** Remove entries unused for 30 days; runs at most once a day per cache unless forced. */
export function pruneRefcache(dir: string, o: { force?: boolean; now?: number } = {}): void {
  const now = o.now ?? Date.now();
  const stamp = path.join(dir, '.pruned');
  try {
    if (!o.force && now - statSync(stamp).mtimeMs < DAY_MS) return;
  } catch {
    // never pruned
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(stamp, '');
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
      const p = path.join(dir, name);
      try {
        if (now - statSync(p).mtimeMs >= REFCACHE_KEEP_MS) rmSync(p, { force: true });
      } catch {
        // gone meanwhile
      }
    }
  } catch {
    // a cache: pruning is a courtesy
  }
}

interface RefEntry {
  v: 1;
  /** identifierIndex(): identifier → the keys it occurs in. */
  ids: Record<string, string[]>;
  /** importsText(), for the import filter. */
  imports: string | null;
}

function readEntry(file: string): RefEntry | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    if (v?.v !== 1 || typeof v.ids !== 'object' || v.ids === null) return null;
    return { v: 1, ids: v.ids, imports: typeof v.imports === 'string' ? v.imports : null };
  } catch {
    return null;
  }
}

/** The cached index of one file's content (`blob`), parsing it on a miss; null when it can't be read at symbol level. */
async function refEntry(sym: SymbolsModule, dir: string | null, root: string, file: string, blob: string | null): Promise<RefEntry | null> {
  const cacheFile = dir && blob ? path.join(dir, `${refcacheKey(blob, sym.MAPPER_VERSION)}.json`) : null;
  if (cacheFile) {
    const hit = readEntry(cacheFile);
    if (hit) {
      refcacheStats.hits++;
      try {
        const now = Date.now();
        if (now - statSync(cacheFile).mtimeMs >= TOUCH_AFTER_MS) utimesSync(cacheFile, now / 1000, now / 1000);
      } catch {
        // the mtime only marks it used
      }
      return hit;
    }
  }
  const text = readSmall(path.join(root, file));
  if (text === null) return null;
  const ids = await sym.identifierIndex(file, text).catch(() => null);
  if (!ids) return null; // not cached: an unsupported or unverified file costs nothing to ask about again
  const imports = await sym.importsText(file, text).catch(() => null);
  refcacheStats.parses++;
  const entry: RefEntry = { v: 1, ids: { ...ids }, imports };
  if (cacheFile) {
    try {
      writeAtomically(cacheFile, JSON.stringify(entry));
    } catch {
      // read again next time
    }
  }
  return entry;
}

/** Run git in `root`: its exit code and stdout (bytes), within `timeoutMs`; never rejects. */
function runGit(root: string, args: string[], o: { input?: string; timeoutMs: number }): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return resolve({ code: null, stdout: Buffer.alloc(0) });
    }
    const out: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, o.timeoutMs));
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: Buffer.alloc(0) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out) });
    });
    child.stdin.on('error', () => {
      // git may exit before reading its input
    });
    child.stdin.end(o.input ?? '');
  });
}

const zList = (b: Buffer) => b.toString('utf8').split('\0').filter(Boolean);

/** Tracked and untracked (not ignored) files whose text has `name` as a whole word: the candidates. Null when git failed. */
async function grepCandidates(root: string, name: string, timeoutMs: number): Promise<string[] | null> {
  // -w counts letters, digits and _ as word characters: a name with others ($, non-ASCII) is searched as a plain string.
  const word = /^[A-Za-z0-9_]+$/.test(name) ? ['-w'] : [];
  const r = await runGit(root, ['grep', '--untracked', '-I', '-l', '-z', '-F', ...word, '-e', name], { timeoutMs });
  if (r.code === 1) return [];
  if (r.code !== 0) return null;
  return zList(r.stdout);
}

/**
 * The blob id of each file as it is in the worktree now: the index's for a
 * clean tracked file (`ls-files -s`), `hash-object` for a modified or
 * untracked one. A file missing here is read without the cache.
 */
async function blobIds(root: string, files: string[], timeoutMs: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!files.length) return out;
  const deadline = Date.now() + timeoutMs;
  const index = await runGit(root, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...files], { timeoutMs });
  const staged = new Map<string, string>();
  for (const rec of zList(index.stdout)) {
    const m = /^(\d{6}) ([0-9a-f]+) (\d)\t(.*)$/s.exec(rec);
    if (m && m[3] === '0') staged.set(m[4]!, m[2]!);
  }
  const changed = new Set(zList((await runGit(root, ['--literal-pathspecs', 'diff-files', '--name-only', '-z', '--', ...files], { timeoutMs: Math.max(1, deadline - Date.now()) })).stdout));
  const hash: string[] = [];
  for (const f of files) {
    const blob = staged.get(f);
    if (blob && !changed.has(f)) out.set(f, blob);
    else if (!f.includes('\n')) hash.push(f);
  }
  if (hash.length) {
    const r = await runGit(root, ['hash-object', '--stdin-paths'], { input: `${hash.join('\n')}\n`, timeoutMs: Math.max(1, deadline - Date.now()) });
    const shas = r.code === 0 ? r.stdout.toString('utf8').split('\n').filter(Boolean) : [];
    if (shas.length === hash.length) hash.forEach((f, i) => out.set(f, shas[i]!));
  }
  return out;
}

export interface UseSite {
  file: string;
  /** The key of the item that uses the name (`handleLogin`, `Session.refresh`, `@toplevel`, or `@imports` when the file only imports it). */
  key: string;
  /** Other agents' active claims and holds overlapping it. */
  holders: Claim[];
  /** This agent's own. */
  mine: Claim[];
}

export interface WhoUses {
  file: string;
  symbol: string;
  name: string;
  /** Places others hold first, then this agent's, then the free ones; by file within each. */
  sites: UseSite[];
  /** callers_free: places no other agent's claim or hold overlaps. */
  free: UseSite[];
  /** Files that spell the name and were read. */
  read: number;
  /** Files that spell the name. */
  candidates: number;
  /** The budget ran out (or git failed) before every candidate was read. */
  partial: boolean;
}

/**
 * who_uses (design §2.5): where this checkout uses `target`'s name as code,
 * from the content-addressed reference cache, with the import filter of
 * relevant(), joined with the hub's live claims (mapper gating) into holders
 * and callers_free. The declaration itself is not a use. Throws only when
 * @agenthub/symbols can't be loaded.
 */
export async function whoUses(root: string, target: { file: string; symbol: string }, o: { me: string | null; claims: () => Promise<Claim[]>; budgetMs?: number }): Promise<WhoUses> {
  const sym = await symbolsModule();
  if (!sym) throw new Error('@agenthub/symbols could not be loaded here, so references can\'t be read');
  const deadline = Date.now() + (o.budgetMs ?? 30_000);
  const name = lastSegment(target.symbol);
  const result: WhoUses = { file: target.file, symbol: target.symbol, name, sites: [], free: [], read: 0, candidates: 0, partial: false };
  const left = () => Math.max(1, deadline - Date.now());
  const claimsP = o.claims().catch(() => null);
  const grep = await grepCandidates(root, name, left());
  if (grep === null) result.partial = true;
  const candidates = (grep ?? []).filter((f) => mappedExtension(f) && sym.languageFor(f) !== null).sort();
  result.candidates = candidates.length;
  const files = candidates.slice(0, MAX_CANDIDATES);
  if (files.length < candidates.length) result.partial = true;
  const dir = refcacheDir(root);
  if (dir) pruneRefcache(dir);
  const blobs = files.length ? await blobIds(root, files, left()) : new Map<string, string>();
  const found: Array<{ file: string; key: string }> = [];
  for (const raw of files) {
    if (Date.now() >= deadline) {
      result.partial = true;
      break;
    }
    const entry = await refEntry(sym, dir, root, raw, blobs.get(raw) ?? null);
    result.read++;
    const file = raw.normalize('NFC');
    // The declaration's own body (a recursive call, its members) is not a use of it.
    const keys = (entry?.ids[name] ?? []).filter((k) => !(file === target.file && (k === target.symbol || k.startsWith(`${target.symbol}.`))));
    if (!keys.length || !entry) continue;
    if (!passesImportFilter({ file, language: sym.languageFor(file), imports: entry.imports }, target)) continue;
    // An import is not a use of its own, unless it is all the file has (a re-export).
    const uses = keys.some((k) => k !== IMPORTS) ? keys.filter((k) => k !== IMPORTS) : keys;
    for (const key of uses) if (isValidSymbolKey(key)) found.push({ file, key });
  }
  const claims = (await claimsP) ?? [];
  const live = claims.filter((c) => c.status === 'active');
  for (const f of found) {
    const entry = { scope: [{ file: f.file, symbol: f.key }], mapper: sym.MAPPER_VERSION };
    const over = live.filter((c) => overlappingEntries(entry, c).length > 0);
    result.sites.push({ file: f.file, key: f.key, holders: over.filter((c) => c.holder !== o.me), mine: over.filter((c) => c.holder === o.me) });
  }
  const rank = (s: UseSite) => (s.holders.length ? 0 : s.mine.length ? 1 : 2);
  result.sites.sort((a, b) => rank(a) - rank(b));
  result.free = result.sites.filter((s) => s.holders.length === 0);
  return result;
}
