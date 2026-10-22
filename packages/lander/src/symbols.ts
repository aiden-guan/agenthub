// Phase 3 in the lander (design §1.10, §2.4, §2.5, §2.2.4 step 4, §2.2.6
// step 4, §2.6 gate 6), over @agenthub/symbols:
//
// - the admission scope: the lander's own, authoritative mapping of a
//   landing's change (base..commit) to symbol keys, at most 40 per file, with
//   MAPPER_VERSION; anything the extractor can't map precisely names the
//   whole file. The hub makes the holds from it through the claim gate, so an
//   edit that never went through the edit hooks still can't land over another
//   agent's claim (§4.2 #5), and two agents' changes to different
//   declarations of one file both hold and land;
// - the landed signature changes: what a landed commit changed (its first
//   parent T0 vs itself), reported with advance/resolve landed, so the hub
//   records them and other agents are told (§2.5);
// - the declarations each conflict hunk lies in, for the fix-it report;
// - the resolver's parse gate: when trunk's and the incoming version both
//   parse without an uncontained error, the resolved file must too.
//
// None of it is a safety gate (§4.2: claims are coordination, the checks are
// the gate): a mapping that fails falls back to the whole file, a landed
// change that can't be read is left out, and nothing here ever fails a
// landing by itself.

import { matchesAny, type SymbolsConfig } from '@agenthub/contract';
import type { ScopeEntry, SymbolChangeInput } from '@agenthub/hub/protocol';
import { changedSymbols, languageFor, MAPPER_VERSION, outline, type Item, type Outline, type SignatureChange } from '@agenthub/symbols';
import type { GitPort } from './ports.js';
import { conflictRegions, sideView } from './regions.js';
import type { ParseCheck } from './resolver.js';

/** design §1.10: more changed keys than this in one file of a landing diff make that file whole-file (too_many_symbols). */
export const ADMISSION_MAX_SYMBOLS = 40;
/** The hub's limit on the entries of one admit request's scope. */
export const MAX_SCOPE_ENTRIES = 20_000;
/** Signature changes are looked for in a landed file with up to this many changed keys. */
export const LANDED_MAX_SYMBOLS = 1000;
/** The hub takes at most this many symbol_changes in one landed request. */
export const MAX_SYMBOL_CHANGES = 1000;
/** Declarations named per conflict hunk. */
export const MAX_HUNK_SYMBOLS = 20;
/** The extractor maps whole-file past this size (design §2.4); views of a conflict are left alone past it too. */
const MAX_SOURCE_BYTES = 1024 * 1024;
/** Blob pairs read at once while mapping a landing's files. */
const CONCURRENCY = 8;

/** trunk's `symbols` section as the lander uses it. */
export type SymbolsSettings = Pick<SymbolsConfig, 'enabled' | 'exclude'>;

/** The section's defaults (design §1.2), for when trunk's config can't be read. */
export const DEFAULT_SYMBOLS: SymbolsSettings = { enabled: true, exclude: [] };

type Log = (line: string) => void;

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 300);
}

/** fn over items with at most `limit` in flight, results in the items' order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Whether the extractor can map `file` at all (a known language, not excluded): the others are whole-file without reading them. */
function mappable(file: string, cfg: SymbolsSettings): boolean {
  return languageFor(file) !== null && !(cfg.exclude.length > 0 && matchesAny(file, cfg.exclude));
}

// ------------------------------------------------------------------ the admission scope (design §2.2.4 step 4)

/**
 * The scope of a landing's change: for each changed file,
 * `changedSymbols(path, blob(base:path), blob(head:path), {maxSymbols: 40})`;
 * a file-level result (a new or deleted file, an unsupported or excluded
 * language, a parse error, too many keys, …), a file with no keys, or a
 * mapping that fails names the whole file. `scope` is null when no entry
 * names a symbol (the landing is file-level only); `mapper` is
 * MAPPER_VERSION. With trunk's `symbols.enabled` false both are null, as in
 * Phase 2. The request stays within the hub's limit on entries: past it, the
 * files with the most keys go whole-file first.
 */
export async function admissionScope(
  git: Pick<GitPort, 'showBlob'>,
  o: { files: readonly string[]; base: string; head: string; config: SymbolsSettings; maxEntries?: number; log?: Log },
): Promise<{ scope: ScopeEntry[] | null; mapper: string | null }> {
  if (!o.config.enabled) return { scope: null, mapper: null };
  const keys = await mapLimit(o.files, CONCURRENCY, async (file): Promise<string[] | null> => {
    if (!mappable(file, o.config)) return null;
    try {
      const [before, after] = await Promise.all([git.showBlob(o.base, file), git.showBlob(o.head, file)]);
      const d = await changedSymbols(file, before, after, { maxSymbols: ADMISSION_MAX_SYMBOLS, exclude: o.config.exclude });
      return d.fileLevel || d.symbols.length === 0 ? null : d.symbols;
    } catch (err) {
      o.log?.(`mapping ${file} to symbols failed (${firstLine(err)}); it is held as a whole file`);
      return null;
    }
  });
  const max = o.maxEntries ?? MAX_SCOPE_ENTRIES;
  let total = keys.reduce((n, k) => n + (k?.length ?? 1), 0);
  while (total > max) {
    let widest = -1;
    keys.forEach((k, i) => {
      if (k && k.length > 1 && (widest < 0 || k.length > keys[widest]!.length)) widest = i;
    });
    if (widest < 0) break;
    total -= keys[widest]!.length - 1;
    keys[widest] = null;
  }
  const scope: ScopeEntry[] = o.files.flatMap((file, i) => keys[i]?.map((symbol) => ({ file, symbol })) ?? [{ file }]);
  return { scope: scope.some((e) => e.symbol !== undefined) ? scope : null, mapper: MAPPER_VERSION };
}

// ------------------------------------------------------------------ the landed signature changes (design §2.5 "Producers")

function changeInput(file: string, c: SignatureChange, taskId: string | null): SymbolChangeInput {
  return {
    file,
    symbol: c.symbol,
    kind: c.kind,
    before: c.before,
    after: c.after,
    ...(c.renamed_to !== undefined ? { renamed_to: c.renamed_to } : {}),
    ...(taskId ? { task_id: taskId } : {}),
  };
}

/**
 * The signature changes a landed commit made: for each file it changed
 * against its first parent (T0 vs C), `changedSymbols(...).signatureChanges`,
 * as the hub's SymbolChangeInput with the landing's task. A file-level result
 * (a new or deleted file, an unsupported language, a parse error) has none.
 * Best effort: whatever can't be read is left out (the landing lands either
 * way), and a commit without a parent has none.
 */
export async function landedSymbolChanges(
  git: Pick<GitPort, 'revParse' | 'diffNames' | 'showBlob'>,
  o: { commit: string; taskId: string | null; config: SymbolsSettings; log?: Log },
): Promise<SymbolChangeInput[]> {
  if (!o.config.enabled) return [];
  let parent: string | null;
  let files: string[];
  try {
    parent = await git.revParse(`${o.commit}^1`);
    if (!parent) return [];
    files = (await git.diffNames(parent, o.commit)).filter((f) => mappable(f, o.config));
  } catch (err) {
    o.log?.(`reading the signature changes of ${o.commit.slice(0, 12)} failed (${firstLine(err)}); none are reported`);
    return [];
  }
  const T0 = parent;
  const per = await mapLimit(files, CONCURRENCY, async (file): Promise<SymbolChangeInput[]> => {
    try {
      const [before, after] = await Promise.all([git.showBlob(T0, file), git.showBlob(o.commit, file)]);
      const d = await changedSymbols(file, before, after, { maxSymbols: LANDED_MAX_SYMBOLS, exclude: o.config.exclude });
      return d.fileLevel ? [] : d.signatureChanges.map((c) => changeInput(file, c, o.taskId));
    } catch (err) {
      o.log?.(`reading the signature changes of ${file} failed (${firstLine(err)}); its are not reported`);
      return [];
    }
  });
  return per.flat().slice(0, MAX_SYMBOL_CHANGES);
}

// ------------------------------------------------------------------ conflict hunks (design §2.2.6 step 4)

/** Line numbers (1-based) of offsets in `text`. */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** A hunk's side in a view, by lines: [first, last], or an insertion point between `last` and `first` (= last + 1) when empty. */
interface LineSpan {
  first: number;
  last: number;
  empty: boolean;
}

function touches(item: Pick<Item, 'startLine' | 'endLine'>, s: LineSpan): boolean {
  // An empty side touches what it lies strictly inside of: the lines on both sides of its point.
  if (s.empty) return item.startLine <= s.last && item.endLine >= s.first;
  return item.startLine <= s.last && s.first <= item.endLine;
}

/** The innermost declarations a span lies in: a container's members when the span stays within them, else the container (and the members it touches). */
function declarationsAt(items: readonly Item[], s: LineSpan): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (!touches(item, s)) continue;
    const inner = item.members.filter((m) => touches(m, s));
    const within = inner.length > 0 && (s.empty || (s.first >= inner[0]!.startLine && s.last <= inner[inner.length - 1]!.endLine));
    if (!within) out.push(item.key);
    for (const m of inner) out.push(...declarationsAt([m], s));
  }
  return out;
}

/**
 * The declarations each conflict region of a diff3-marked file lies in, by
 * the region's start line: the file is outlined three times, as trunk's side,
 * the incoming side and base would have it inside the regions (git's merge
 * text outside them), and each region names the innermost keys its side
 * touches, in that order of sides, without repeats. A view that doesn't
 * parse (an uncontained error) names nothing; neither does a language the
 * extractor doesn't know.
 */
export async function hunkSymbols(path: string, merged: string, markerSize: number): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const language = languageFor(path);
  if (language === null || merged.length > MAX_SOURCE_BYTES) return out;
  const regions = conflictRegions(merged, markerSize);
  const keys = regions.map(() => [] as string[]);
  for (const side of ['trunk', 'incoming', 'base'] as const) {
    if (regions.length === 0) break;
    const view = sideView(merged, regions, side);
    let o: Outline;
    try {
      o = await outline(view.text, language);
    } catch {
      continue;
    }
    if (o.errors === 'uncontained') continue;
    const lineOf = lineIndex(view.text);
    view.spans.forEach((span, i) => {
      const empty = span.end === span.start;
      const first = lineOf(span.start);
      const s: LineSpan = empty ? { first, last: first - 1, empty } : { first, last: lineOf(span.end - 1), empty };
      for (const k of declarationsAt(o.items, s)) if (!keys[i]!.includes(k)) keys[i]!.push(k);
    });
  }
  regions.forEach((r, i) => out.set(r.start_line, keys[i]!.slice(0, MAX_HUNK_SYMBOLS)));
  return out;
}

// ------------------------------------------------------------------ the parse gate (design §2.6 gate 6)

/**
 * Gate 6: if trunk's and the incoming version both parse without an
 * uncontained error, the resolved file must too (a syntax error inside one
 * declaration's body is contained, and the checks judge it). Nothing to say
 * for a language the extractor doesn't know, or when a side already doesn't
 * parse; a file that can't be outlined at all (an unverified grammar) isn't
 * gated here either: the checks still are.
 */
export const symbolsParseCheck: ParseCheck = async (f) => {
  const language = languageFor(f.path);
  if (language === null) return null;
  try {
    for (const side of [f.ours, f.theirs]) if ((await outline(side, language)).errors === 'uncontained') return null;
    if ((await outline(f.result, language)).errors !== 'uncontained') return null;
  } catch {
    return null;
  }
  return `the resolved file doesn't parse: it has a syntax error outside any one declaration's body (an uncontained ${language} parse error), while trunk's and the incoming version both parse`;
};
