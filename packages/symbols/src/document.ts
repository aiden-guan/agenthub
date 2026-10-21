// Parsed documents (design §2.4 "Performance"): a source text with its tree
// and its outline, the unit changedSymbols and the reference lookups work on.
//
// - Signatures are lazy. A document's outline leaves `Item.signature` null and
//   records what each one is made of; `signatureOf` (signatures.ts) computes it
//   from the tree on demand. The diff needs only the changed keys' signatures,
//   and computing all of them is about two thirds of an outline's cost.
// - Reparsing is incremental. A document can be parsed from another one's
//   tree: the edit between the two texts (their common prefix and suffix) is
//   applied to a copy of that tree, and the parser reuses everything outside
//   it. The other document's tree is left as it was. An incremental parse
//   that reports a syntax error is redone from scratch, so how an error is
//   recovered never depends on which text came before (an error-free tree is
//   the same either way: test/incremental.test.ts compares trees and outlines
//   with fresh parses along chains of seeded random edits).
// - Extraction is incremental too. The subtrees an incremental parse kept
//   have the same node ids, so a top-level node the other document had keeps
//   its classification, and its items are moved to their new offsets when
//   their text is unchanged (outline.ts, `ExtractOptions.reuse`).
// - A small cache per runtime keeps the most recent documents, trees
//   included, keyed by language and exact text. Each edit's `before` is
//   usually the previous edit's `after`, so a process that maps a sequence of
//   edits (the lander, a long-running `hub mcp`) parses each text once, and
//   incrementally. It is bounded by count and by total size, and an evicted
//   document's tree is deleted.
//
// Lifetimes: a document's tree lives until it is evicted (or, for one never
// added, until `release`). Every use of a document, lazy signatures included,
// happens synchronously between taking it and adding it back, so no other
// call can evict it meanwhile: callers await the grammar first, then do the
// rest without an await. An evicted tree is deleted once the current task is
// done (setImmediate), off the caller's path, with at most 8 waiting.

import { Edit, type Point, type Tree } from 'web-tree-sitter';
import { extract, specFor, type ItemDetail, type TopMemo } from './outline.js';
import type { Grammar, GrammarRuntime } from './runtime.js';
import type { LanguageSpec } from './spec.js';
import type { Item, LanguageId, Outline } from './types.js';

export interface Doc {
  language: LanguageId;
  spec: LanguageSpec;
  src: string;
  /** Alive while the document is cached or in use. */
  tree: Tree;
  /** Lazily signed: every `Item.signature` is null here; use `signatureOf`. */
  outline: Outline;
  details: Map<Item, ItemDetail>;
  /** The signatures computed so far. */
  signatures: Map<Item, string | null>;
  /** Per top-level node id: what extraction learned about it, for a document parsed from this one to carry over. */
  tops: Map<number, TopMemo>;
}

/** At most this many documents are cached per runtime... */
export const MAX_CACHED_DOCS = 8;
/** ...holding at most this many UTF-16 units of text together (two sides of a 1 MiB file). */
export const MAX_CACHED_CHARS = 2 * 1024 * 1024;

/**
 * Parse `src` into a document: incrementally from `base` (whose tree is left
 * intact) when given, otherwise from scratch. An incremental parse with a
 * syntax error is redone from scratch.
 */
export function parseDoc(grammar: Grammar, src: string, base?: Doc | null): Doc {
  const { parser, language } = grammar;
  let tree: Tree | null = null;
  let incremental = false;
  if (base && base.language === language) {
    const old = base.tree.copy();
    try {
      old.edit(editBetween(base.src, src));
      tree = parser.parse(src, old);
    } finally {
      old.delete();
    }
    if (tree && tree.rootNode.hasError) {
      tree.delete();
      tree = null;
    }
    incremental = tree !== null;
  }
  tree ??= parser.parse(src);
  if (!tree) throw new Error(`@agenthub/symbols: the ${language} parser returned no tree`);
  try {
    const spec = specFor(language);
    const details = new Map<Item, ItemDetail>();
    const tops = new Map<number, TopMemo>();
    const reuse = incremental && base ? { src: base.src, tops: base.tops, details: base.details } : undefined;
    const outline = extract(tree.rootNode, src, spec, { details, lazy: true, memo: tops, reuse });
    return { language, spec, src, tree, outline, details, signatures: new Map(), tops };
  } catch (err) {
    tree.delete();
    throw err;
  }
}

/** The single edit that turns `a` into `b`: their common prefix and suffix are kept (never splitting a surrogate pair). */
export function editBetween(a: string, b: string): Edit {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(a.charCodeAt(start - 1))) start--;
  let suffix = 0;
  while (suffix < max - start && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
  if (suffix > 0 && isLowSurrogate(a.charCodeAt(a.length - suffix))) suffix--;
  const oldEnd = a.length - suffix;
  const newEnd = b.length - suffix;
  const startPosition = pointAt(a, start);
  return new Edit({
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition,
    oldEndPosition: pointAt(a, oldEnd, start, startPosition),
    newEndPosition: pointAt(b, newEnd, start, startPosition),
  });
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** The row and column (in UTF-16 units, as web-tree-sitter counts them) of `offset`, counted on from a known point. */
function pointAt(s: string, offset: number, from = 0, at: Point = { row: 0, column: 0 }): Point {
  let row = at.row;
  let lineStart = from - at.column;
  for (let i = s.indexOf('\n', from); i !== -1 && i < offset; i = s.indexOf('\n', i + 1)) {
    row++;
    lineStart = i + 1;
  }
  return { row, column: offset - lineStart };
}

/** Delete a document's tree now (one that was never added to a cache). */
export function release(doc: Doc): void {
  doc.tree.delete();
}

/** Evicted trees waiting to be deleted: off the caller's path, once the current task is done. */
const doomed: Tree[] = [];
let flushing = false;
/** At most this many evicted trees wait; beyond it the oldest is deleted at once (a loop that never yields still frees them). */
const MAX_DOOMED = 8;

function flushDoomed(): void {
  flushing = false;
  for (const tree of doomed.splice(0)) tree.delete();
}

/** Delete an evicted document's tree soon (nothing can use it any more). */
function dispose(doc: Doc): void {
  doomed.push(doc.tree);
  if (doomed.length > MAX_DOOMED) doomed.shift()!.delete();
  if (!flushing) {
    flushing = true;
    setImmediate(flushDoomed).unref();
  }
}

/** The most recently used documents of one runtime, trees included. */
export class DocCache {
  /** Least recently used first. */
  private readonly docs: Doc[] = [];

  constructor(
    private readonly maxDocs = MAX_CACHED_DOCS,
    private readonly maxChars = MAX_CACHED_CHARS,
  ) {}

  get size(): number {
    return this.docs.length;
  }

  /** The cached document of exactly this text, or null. */
  get(language: LanguageId, src: string): Doc | null {
    for (let i = this.docs.length - 1; i >= 0; i--) {
      const doc = this.docs[i]!;
      if (doc.language === language && doc.src.length === src.length && doc.src === src) return doc;
    }
    return null;
  }

  /** Make `doc` the most recently used (adding it if new), then evict the least recently used beyond the limits, deleting their trees. */
  add(doc: Doc): void {
    const at = this.docs.indexOf(doc);
    if (at !== -1) this.docs.splice(at, 1);
    else {
      const twin = this.get(doc.language, doc.src);
      if (twin) {
        // The same text parsed twice (a caller didn't look first): keep one.
        this.docs.splice(this.docs.indexOf(twin), 1);
        dispose(twin);
      }
    }
    this.docs.push(doc);
    let chars = 0;
    for (const d of this.docs) chars += d.src.length;
    while (this.docs.length > 1 && (this.docs.length > this.maxDocs || chars > this.maxChars)) {
      const old = this.docs.shift()!;
      chars -= old.src.length;
      dispose(old);
    }
  }

  /** Evict everything. */
  clear(): void {
    for (const doc of this.docs.splice(0)) dispose(doc);
  }
}

const caches = new WeakMap<GrammarRuntime, DocCache>();

/** The document cache of `runtime`. */
export function docCache(runtime: GrammarRuntime): DocCache {
  let cache = caches.get(runtime);
  if (!cache) {
    cache = new DocCache();
    caches.set(runtime, cache);
  }
  return cache;
}

/**
 * The document of `src`: cached, or parsed (incrementally from `base` when
 * given). Synchronous; the caller adds it back to the cache when done with it.
 */
export function docFor(cache: DocCache, grammar: Grammar, src: string, base?: Doc | null): Doc {
  return cache.get(grammar.language, src) ?? parseDoc(grammar, src, base);
}
