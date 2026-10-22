import { comparable, entriesOverlap, isValidSymbolKey, overlappingEntries, type ScopeLike, type ScopedLike } from '@agenthub/contract';
import { HubError, cleanText, normalizeRepoPath } from './common.js';
import type { Claim, ScopeEntry } from './protocol.js';

// Scope entries of claim and check requests (design §1.10). An entry is
// {file, symbol?}; without a symbol it is the whole file. Symbols count only
// between claims made with the same non-null mapper (MAPPER_VERSION), so a
// request with a symbol must say which mapper produced it. The overlap and
// coverage rules themselves are the contract's (entriesOverlap, entryCovers,
// overlappingEntries, claimCovers); nothing here decides them differently.

const MAX_MAPPER = 200;
/** Up to this many pairs of entries, comparing two scopes entry by entry is cheaper than indexing one by file. */
const SMALL_PRODUCT = 64;

/** What a claim or check request asks about: its entries, and the mapper their symbols came from. */
export interface RequestScope {
  scope: ScopeEntry[];
  mapper: string | null;
}

/**
 * The mapper of a request: absent, null or '' is none. Otherwise it must be a
 * version string the landing path keeps as it is (at most 200 characters, no
 * control characters, no runs of or surrounding whitespace), so a claim's
 * mapper and a landing's compare equal exactly when the client sent the same
 * one (400 bad_request otherwise).
 */
export function parseMapper(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_MAPPER || cleanText(value, MAX_MAPPER) !== value) {
    throw new HubError('bad_request', `mapper must be the MAPPER_VERSION that produced the symbols: a string of at most ${MAX_MAPPER} characters, without control characters or extra spaces`);
  }
  return value;
}

/**
 * The entries of a claim or check request: `scope`, then `files` as whole
 * files, deduplicated, paths in NFC form (400 invalid_path). A symbol must be
 * a declaration key (SYMBOL_KEY_RE, at most 200 characters, compared in NFC
 * form) and needs the request's mapper (400 invalid_symbol). A whole-file
 * entry subsumes the symbol entries of its file. Entries keep the request's
 * order (Phase 1's: scope first, then files).
 */
export function requestScope(req: { files?: unknown; scope?: unknown; mapper?: unknown }): RequestScope {
  if (req.scope !== undefined && req.scope !== null && !Array.isArray(req.scope)) throw new HubError('bad_request', 'scope must be a list of {file, symbol?} entries');
  if (req.files !== undefined && req.files !== null && !Array.isArray(req.files)) throw new HubError('bad_request', 'files must be a list of repo paths');
  const mapper = parseMapper(req.mapper);
  const raw: unknown[] = [...((req.scope as unknown[] | null | undefined) ?? []), ...((req.files as unknown[] | null | undefined) ?? []).map((file) => ({ file }))];
  const entries: ScopeEntry[] = raw.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new HubError('bad_request', 'scope entries look like {file, symbol?}');
    const { file, symbol } = entry as { file?: unknown; symbol?: unknown };
    const path = normalizeRepoPath(file);
    if (symbol === undefined || symbol === null) return { file: path };
    const key = typeof symbol === 'string' ? symbol.normalize('NFC') : '';
    if (!isValidSymbolKey(key)) {
      throw new HubError('invalid_symbol', 'scope symbols are declaration keys such as login, Session.refresh, @imports or @toplevel, at most 200 characters');
    }
    if (mapper === null) throw new HubError('invalid_symbol', 'symbol entries need the mapper (MAPPER_VERSION) that produced them');
    return { file: path, symbol: key };
  });
  const whole = new Set(entries.filter((e) => e.symbol === undefined).map((e) => e.file));
  const seen = new Set<string>();
  const scope: ScopeEntry[] = [];
  for (const e of entries) {
    const entry = whole.has(e.file) ? { file: e.file } : e;
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    scope.push(entry);
  }
  return { scope, mapper };
}

/** The mapper a claim with these entries keeps: the request's when it names a symbol; null when every entry is a whole file. */
export function claimMapper(scope: readonly ScopeEntry[], mapper: string | null): string | null {
  return scope.some((e) => e.symbol !== undefined) ? mapper : null;
}

/**
 * Whether the scopes of two claims overlap (design §1.10, with mapper
 * gating): exactly when the contract's overlappingEntries(a, b) is non-empty,
 * without building the list. The wait graph asks this for every pair of
 * claims that share a file, so it stops at the first overlap, and for large
 * scopes (a landing's hold) it looks up the other side's entries by file
 * instead of comparing every pair: two entries of different files never
 * overlap.
 */
export function scopesOverlap(a: ScopedLike, b: ScopedLike): boolean {
  const same = comparable(a, b);
  const meets = (x: ScopeLike, y: ScopeLike) => (same ? entriesOverlap(x, y) : x.file === y.file);
  if (a.scope.length * b.scope.length <= SMALL_PRODUCT) return b.scope.some((y) => a.scope.some((x) => meets(x, y)));
  const [small, large] = a.scope.length <= b.scope.length ? [a.scope, b.scope] : [b.scope, a.scope];
  const byFile = groupByFile(small);
  return large.some((y) => byFile.get(y.file)?.some((x) => meets(x, y)) ?? false);
}

/**
 * The contract's overlappingEntries(a, b): the entries of `b` that some
 * entry of `a` overlaps, with mapper gating, in `b`'s order. For large
 * scopes (a big commit's guard check, a landing's hold) `a` is looked up by
 * file first, which gives the same entries, since entries of different files
 * never overlap.
 */
export function overlapping<T extends ScopeLike>(a: ScopedLike, b: { scope: T[]; mapper: string | null }): T[] {
  if (a.scope.length * b.scope.length <= SMALL_PRODUCT) return overlappingEntries(a, b);
  const byFile = groupByFile(a.scope);
  return b.scope.filter((y) => {
    const xs = byFile.get(y.file);
    return xs !== undefined && overlappingEntries({ scope: xs, mapper: a.mapper }, { scope: [y], mapper: b.mapper }).length > 0;
  });
}

/** Entries by file, each file's in their order. */
export function groupByFile<T extends ScopeLike>(entries: readonly T[]): Map<string, T[]> {
  const byFile = new Map<string, T[]>();
  for (const e of entries) (byFile.get(e.file) ?? byFile.set(e.file, []).get(e.file)!).push(e);
  return byFile;
}

/** Whether claim `c` has exactly `scope`'s entries, and, when they name symbols, the same mapper. */
export function sameScope(c: Pick<Claim, 'scope' | 'mapper'>, scope: readonly ScopeEntry[], mapper: string | null): boolean {
  if (c.scope.length !== scope.length) return false;
  const keys = new Set(c.scope.map(entryKey));
  if (!scope.every((e) => keys.has(entryKey(e)))) return false;
  return claimMapper(scope, mapper) === null || c.mapper === mapper;
}

/** `entries` in `order`'s order (a claim's scope), keeping those `keep` has. */
export function inOrderOf(order: readonly ScopeEntry[], keep: readonly ScopeEntry[]): ScopeEntry[] {
  const keys = new Set(keep.map(entryKey));
  return order.filter((e) => keys.has(entryKey(e)));
}

export function entryKey(e: ScopeEntry): string {
  return `${e.file}\u0000${e.symbol ?? ''}`;
}
