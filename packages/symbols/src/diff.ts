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
//    `@imports` and `@toplevel` never appear.
//
// Every offset where the two texts differ then lies inside a returned key's
// span, on one side or the other, or inside a whitespace-only gap: the spans
// of the top-level items, plus whitespace, partition each file, unclaimed
// items are matched one to one in order with equal texts, and a container's
// own text (header, footer, the runs between members) is compared in place
// (test/mapping-property.test.ts checks this on thousands of seeded edits).

import { IMPORTS, TOPLEVEL, matchesAny } from '@agenthub/contract';
import { SymbolsError } from './errors.js';
import { languageFor } from './languages/index.js';
import { outlineWith, type ItemDetail } from './outline.js';
import { MAPPER_VERSION, type GrammarRuntime } from './runtime.js';
import { truncate } from './signatures.js';
import type { FileLevelReason, Item, LanguageId, Outline, SignatureChange, SymbolDiff } from './types.js';

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

/** One side of a diff: its text, its outline, and the details the outline engine recorded for its items. */
export interface Side {
  src: string;
  outline: Outline;
  details: Map<Item, ItemDetail>;
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

  let b: Side;
  let a: Side;
  try {
    b = await side(runtime, before, language);
    a = await side(runtime, after, language);
  } catch (err) {
    if (err instanceof SymbolsError) return whole(err.reason);
    throw err;
  }
  if (b.outline.errors === 'uncontained' || a.outline.errors === 'uncontained') return whole('parse_error');
  const max = o.maxSymbols === undefined || Number.isNaN(o.maxSymbols) ? DEFAULT_MAX_SYMBOLS : o.maxSymbols;
  const result = diffSides(b, a, max);
  return result ? { fileLevel: false, ...result, mapper } : whole('too_many_symbols');
}

async function side(runtime: GrammarRuntime, src: string, language: LanguageId): Promise<Side> {
  const details = new Map<Item, ItemDetail>();
  return { src, outline: await outlineWith(runtime, src, language, details), details };
}

function tooLarge(s: string): boolean {
  // A UTF-16 unit is at least one UTF-8 byte and at most three.
  if (s.length > MAX_FILE_BYTES) return true;
  if (s.length * 3 <= MAX_FILE_BYTES) return false;
  return Buffer.byteLength(s, 'utf8') > MAX_FILE_BYTES;
}

function binary(s: string): boolean {
  const nul = s.indexOf('\u0000');
  return nul !== -1 && nul < BINARY_PROBE;
}

/** The changed keys and signature changes of two outlined sides with no uncontained error; null when there are more than `maxSymbols` keys. */
export function diffSides(b: Side, a: Side, maxSymbols: number): { symbols: string[]; signatureChanges: SignatureChange[] } | null {
  const fb = flatten(b.outline.items);
  const fa = flatten(a.outline.items);
  const changed = new Set<string>();

  // Texts that differ (shells for containers), and keys on one side only.
  for (const [key, items] of fb) {
    const other = fa.get(key);
    if (!other || !sameTexts(items, other)) changed.add(key);
  }
  for (const key of fa.keys()) if (!fb.has(key)) changed.add(key);

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
  return { symbols, signatureChanges: signatureChanges(b, a, fb, fa) };
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

function topElements(side: Side): Element[] {
  return side.outline.items.map((item) => ({ key: item.key, claim: item.key, text: side.src.slice(item.start, item.end), item }));
}

/** A container's members, with each non-blank run of its own text between two of them. (Its header, footer and what lies before the first member or after the last are in its shell.) */
function memberElements(side: Side, container: Item): Element[] {
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

function compareLevel(b: Side, a: Side, xs: Element[], ys: Element[], changed: Set<string>): void {
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

function compareMatched(b: Side, a: Side, x: Element, y: Element, changed: Set<string>): void {
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

// ------------------------------------------------------------------ signature changes

/** The signatures of a key's items (overloads, a struct and its impls) joined with newlines; null when none has one. Compared whole, reported cut to 500 characters. */
function signatureOf(items: Item[]): string | null {
  const sigs = items.map((i) => i.signature).filter((s): s is string => s !== null);
  return sigs.length === 0 ? null : sigs.join('\n');
}

/** The bodies of a key's items with whitespace collapsed, joined; '' when none has a body. */
function bodyOf(side: Side, items: Item[]): string {
  const parts = items.map((item) => {
    const body = side.details.get(item)?.body;
    return body ? side.src.slice(body[0], body[1]).replace(/\s+/g, ' ').trim() : '';
  });
  return parts.every((p) => p === '') ? '' : parts.join('\n');
}

function signatureChanges(b: Side, a: Side, fb: Map<string, Item[]>, fa: Map<string, Item[]>): SignatureChange[] {
  const out: SignatureChange[] = [];
  const isRegion = (key: string): boolean => key === IMPORTS || key === TOPLEVEL;
  let added: Array<{ key: string; kind: string; body: string }> | null = null;
  for (const [key, items] of fb) {
    if (isRegion(key)) continue;
    const before = signatureOf(items);
    if (before === null) continue;
    const other = fa.get(key);
    if (other) {
      const after = signatureOf(other);
      if (after !== null && after !== before) out.push({ symbol: key, kind: 'signature', before: truncate(before), after: truncate(after) });
      continue;
    }
    added ??= [...fa]
      .filter(([k]) => !fb.has(k) && !isRegion(k))
      .map(([k, xs]) => ({ key: k, kind: xs[0]!.kind, body: bodyOf(a, xs) }));
    const body = bodyOf(b, items);
    const kind = items[0]!.kind;
    const candidates = body === '' ? [] : added.filter((c) => c.kind === kind && c.body === body);
    if (candidates.length === 1) {
      const to = candidates[0]!.key;
      const after = signatureOf(fa.get(to)!);
      out.push({ symbol: key, kind: 'renamed', before: truncate(before), after: after === null ? null : truncate(after), renamed_to: to });
    } else {
      out.push({ symbol: key, kind: 'removed', before: truncate(before), after: null });
    }
  }
  return out;
}
