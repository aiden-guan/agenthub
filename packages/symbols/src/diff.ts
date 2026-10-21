// changedSymbols (design §2.4 "changedSymbols", §1.10 the mapping table and
// the mapping invariant): the keys a change from `before` to `after` touches,
// found by diffing the two outlines key by key, with no range heuristics.
//
// 1. Fallbacks, in order: an unsupported language, an excluded path, a side
//    that is absent (new or deleted file), a side over 1 MiB, a NUL in the
//    first 8 KiB of a side, an unverified grammar. Identical sides change
//    nothing.
// 2. Both sides are outlined; an uncontained parse error on either is
//    `parse_error`.
// 3. Changed keys, the union of:
//    - flattening (every item by key, same-key siblings in order, a
//      container's text being its shell): keys whose texts differ, and keys
//      present on one side only. The `@toplevel` texts are the non-whitespace
//      gap contents, so any change to them claims `@toplevel`;
//    - moves: at the top level and inside each pair of matched containers, the
//      LCS of the two key sequences is taken, and every item outside it is
//      claimed. Inside a container, each run of its own text between two
//      members (a computed member, a stray statement) takes part as an element
//      of the container's, so moving it across a member claims the container,
//      and each matched pair of items is compared by its exact text (a
//      container by its shell, then its members in turn);
//    - the keys of contained parse errors, on either side;
//    - `@toplevel` when the text changed but nothing above did (a
//      whitespace-only change between declarations).
//    A key whose container is also claimed is dropped: the container's claim
//    covers it (and conflicts with every claim on it) already.
// 4. More than `maxSymbols` keys (default 12) is `too_many_symbols`.
// 5. signatureChanges: a key on both sides whose (non-null) signatures differ
//    is `signature`; a key only `before` has, with a signature, is `renamed`
//    when exactly one key only `after` has is of the same kind with the same
//    body (whitespace collapsed), otherwise `removed`. Same-key siblings
//    (overloads) are compared by their signatures joined with newlines.
//    `@imports` and `@toplevel` never appear (signatures.ts).
//
// Every offset where the two texts differ then lies inside a returned key's
// span, on one side or the other, or inside a whitespace-only gap: the spans
// of the top-level items, plus whitespace, partition each file, unclaimed
// items are matched one to one in order with equal texts, and a container's
// own text (header, footer, the runs between members) is compared in place
// (test/mapping-property.test.ts checks this on thousands of seeded edits).
//
// Performance (design §2.4): the two sides are documents (document.ts). The
// side not in the runtime's cache is parsed incrementally from the other one
// (or `before` from scratch when neither is cached), signatures are computed
// only for the keys whose texts differ, and both documents are cached for the
// next edit, whose `before` is usually this one's `after`.

import { TOPLEVEL, matchesAny } from '@agenthub/contract';
import { docCache, parseDoc, release, type Doc } from './document.js';
import { SymbolsError } from './errors.js';
import { languageFor } from './languages/index.js';
import { grammarFor } from './outline.js';
import { MAPPER_VERSION, type Grammar, type GrammarRuntime } from './runtime.js';
import { signatureChanges } from './signatures.js';
import type { FileLevelReason, Item, SignatureChange, SymbolDiff } from './types.js';

/** A side over this many UTF-8 bytes is mapped whole-file (`too_large`). */
export const MAX_FILE_BYTES = 1024 * 1024;
/** A NUL among this many leading characters makes a side `binary`. */
export const BINARY_PROBE = 8 * 1024;
/** The default limit on the keys of one diff (`maxSymbolsPerEdit`). */
export const DEFAULT_MAX_SYMBOLS = 12;
/** Beyond this many cells, the middle of two key sequences is not aligned (every item there counts as moved). */
const LCS_CELLS = 4_000_000;
/** The LCS key of a run of a container's own text between two of its members. */
const OWN_TEXT = '\u0000';

export interface ChangedOptions {
  /** More keys than this make the diff file level (`too_many_symbols`). Default 12. */
  maxSymbols?: number;
  /** Repo-path globs (`symbols.exclude`) mapped whole-file (`excluded`). */
  exclude?: string[];
}

/** changedSymbols with the grammars of `runtime` (the package's default runtime behind the exported function). */
export async function changedSymbolsWith(
  runtime: GrammarRuntime,
  path: string,
  before: string | null,
  after: string | null,
  o: ChangedOptions = {},
): Promise<SymbolDiff> {
  const mapper = MAPPER_VERSION;
  const whole = (reason: FileLevelReason): SymbolDiff => ({ fileLevel: true, reason, mapper });
  const none: SymbolDiff = { fileLevel: false, symbols: [], signatureChanges: [], mapper };
  const language = languageFor(path);
  if (language === null) return whole('unsupported_language');
  if (o.exclude && o.exclude.length > 0 && matchesAny(path, o.exclude)) return whole('excluded');
  if (before === null && after === null) return none;
  if (before === null) return whole('new_file');
  if (after === null) return whole('deleted_file');
  if (tooLarge(before) || tooLarge(after)) return whole('too_large');
  if (binary(before) || binary(after)) return whole('binary');
  if (before === after) return none;

  let grammar: Grammar;
  try {
    grammar = await grammarFor(runtime, language);
  } catch (err) {
    if (err instanceof SymbolsError) return whole(err.reason);
    throw err;
  }
  const max = o.maxSymbols === undefined || Number.isNaN(o.maxSymbols) ? DEFAULT_MAX_SYMBOLS : o.maxSymbols;
  // From here on synchronous (document.ts, "Lifetimes").
  return withDocs(runtime, grammar, before, after, (b, a) => {
    if (b.outline.errors === 'uncontained' || a.outline.errors === 'uncontained') return whole('parse_error');
    const result = diffSides(b, a, max);
    return result ? { fileLevel: false, ...result, mapper } : whole('too_many_symbols');
  });
}

/**
 * Run `use` on the documents of `before` and `after` (cached, or parsed: the
 * one not cached incrementally from the other), then cache both. Synchronous.
 */
export function withDocs<T>(runtime: GrammarRuntime, grammar: Grammar, before: string, after: string, use: (b: Doc, a: Doc) => T): T {
  const cache = docCache(runtime);
  let b = cache.get(grammar.language, before);
  let a = cache.get(grammar.language, after);
  const made: Doc[] = [];
  try {
    if (!b) made.push((b = parseDoc(grammar, before, a)));
    if (!a) made.push((a = parseDoc(grammar, after, b)));
  } catch (err) {
    for (const doc of made) release(doc);
    throw err;
  }
  try {
    return use(b, a);
  } finally {
    cache.add(b);
    cache.add(a);
  }
}

export function tooLarge(s: string): boolean {
  // A UTF-16 unit is at least one UTF-8 byte and at most three.
  if (s.length > MAX_FILE_BYTES) return true;
  if (s.length * 3 <= MAX_FILE_BYTES) return false;
  return Buffer.byteLength(s, 'utf8') > MAX_FILE_BYTES;
}

export function binary(s: string): boolean {
  const nul = s.indexOf('\u0000');
  return nul !== -1 && nul < BINARY_PROBE;
}

/** The changed keys and signature changes of two documents with no uncontained error; null when there are more than `maxSymbols` keys. */
export function diffSides(b: Doc, a: Doc, maxSymbols: number): { symbols: string[]; signatureChanges: SignatureChange[] } | null {
  const fb = flatten(b.outline.items);
  const fa = flatten(a.outline.items);

  // Texts that differ (shells for containers), and keys on one side only.
  const differing = new Set<string>();
  for (const [key, items] of fb) {
    const other = fa.get(key);
    if (!other || !sameTexts(items, other)) differing.add(key);
  }
  for (const key of fa.keys()) if (!fb.has(key)) differing.add(key);
  const changed = new Set(differing);

  // Moves, level by level, and each matched pair in place.
  compareLevel(b, a, topElements(b), topElements(a), changed);

  for (const key of b.outline.errorKeys) changed.add(key);
  for (const key of a.outline.errorKeys) changed.add(key);

  // The text changed (the caller saw to that), so something is claimed: a whitespace-only change between declarations is @toplevel's.
  if (changed.size === 0) changed.add(TOPLEVEL);

  // In source order: the keys of before, then those only after has (and @toplevel when neither has it).
  const kept = withoutCovered(changed);
  const symbols = [...new Set([...fb.keys(), ...fa.keys(), ...kept])].filter((k) => kept.has(k));
  if (symbols.length > maxSymbols) return null;
  return { symbols, signatureChanges: signatureChanges(b, a, fb, fa, differing) };
}

// ------------------------------------------------------------------ flattening

/** Every item by key, in source order (a container before its members); same-key siblings in order. */
function flatten(items: Item[], out = new Map<string, Item[]>()): Map<string, Item[]> {
  for (const item of items) {
    const list = out.get(item.key);
    if (list) list.push(item);
    else out.set(item.key, [item]);
    if (item.members.length > 0) flatten(item.members, out);
  }
  return out;
}

function sameTexts(x: Item[], y: Item[]): boolean {
  return x.length === y.length && x.every((item, i) => item.text === y[i]!.text);
}

/** The keys not covered by another key in the set (`Session` covers `Session.refresh`). */
function withoutCovered(keys: Set<string>): Set<string> {
  const kept = new Set<string>();
  for (const key of keys) {
    let covered = false;
    for (let i = key.indexOf('.'); i !== -1 && !covered; i = key.indexOf('.', i + 1)) covered = keys.has(key.slice(0, i));
    if (!covered) kept.add(key);
  }
  return kept;
}

// ------------------------------------------------------------------ moves and matched pairs

/** One element of a level: an item, or a run of a container's own text between two members (`item` null). */
interface Element {
  /** What the LCS compares: the item's key, or OWN_TEXT. */
  key: string;
  /** The key claimed when this element changed: the item's, or its container's. */
  claim: string;
  /** The exact text of its span. */
  text: string;
  item: Item | null;
}

function topElements(side: Doc): Element[] {
  return side.outline.items.map((item) => ({ key: item.key, claim: item.key, text: side.src.slice(item.start, item.end), item }));
}

/** A container's members, with each non-blank run of its own text between two of them. (Its header, footer and what lies before the first member or after the last are in its shell.) */
function memberElements(side: Doc, container: Item): Element[] {
  const out: Element[] = [];
  const members = container.members;
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!;
    if (i > 0) {
      const own = side.src.slice(members[i - 1]!.end, m.start).trim();
      if (own !== '') out.push({ key: OWN_TEXT, claim: container.key, text: own, item: null });
    }
    out.push({ key: m.key, claim: m.key, text: side.src.slice(m.start, m.end), item: m });
  }
  return out;
}

function compareLevel(b: Doc, a: Doc, xs: Element[], ys: Element[], changed: Set<string>): void {
  const match = lcs(
    xs.map((e) => e.key),
    ys.map((e) => e.key),
  );
  const matched = new Uint8Array(ys.length);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    const j = match[i]!;
    if (j < 0) {
      changed.add(x.claim);
      continue;
    }
    matched[j] = 1;
    compareMatched(b, a, x, ys[j]!, changed);
  }
  for (let j = 0; j < ys.length; j++) if (!matched[j]) changed.add(ys[j]!.claim);
}

function compareMatched(b: Doc, a: Doc, x: Element, y: Element, changed: Set<string>): void {
  if (x.item === null || y.item === null) {
    if (x.text !== y.text) changed.add(x.claim);
    return;
  }
  const cx = b.details.get(x.item)?.container ?? false;
  const cy = a.details.get(y.item)?.container ?? false;
  if (cx !== cy) {
    changed.add(x.claim);
  } else if (!cx) {
    if (x.text !== y.text || x.item.text !== y.item.text) changed.add(x.claim);
  } else {
    if (x.item.text !== y.item.text) changed.add(x.claim);
    // A claimed container covers its members: no need to look inside.
    if (!changed.has(x.claim)) compareLevel(b, a, memberElements(b, x.item), memberElements(a, y.item), changed);
  }
}

/**
 * For each element of `xs`, the index in `ys` it is matched with in a longest
 * common subsequence of the two lists, or -1. The common prefix and suffix are
 * matched directly; a middle too large to align stays unmatched.
 */
export function lcs(xs: readonly string[], ys: readonly string[]): Int32Array {
  const match = new Int32Array(xs.length).fill(-1);
  let lo = 0;
  while (lo < xs.length && lo < ys.length && xs[lo] === ys[lo]) {
    match[lo] = lo;
    lo++;
  }
  let hx = xs.length;
  let hy = ys.length;
  while (hx > lo && hy > lo && xs[hx - 1] === ys[hy - 1]) {
    hx--;
    hy--;
    match[hx] = hy;
  }
  const n = hx - lo;
  const m = hy - lo;
  if (n === 0 || m === 0 || n * m > LCS_CELLS) return match;
  // dp[i][j]: the LCS length of the suffixes from i and j of the middle (at most min(n, m) <= 2000, so 16 bits).
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = xs[lo + i] === ys[lo + j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (xs[lo + i] === ys[lo + j]) {
      match[lo + i] = lo + j;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return match;
}
