// The outline engine (design §1.10 keys, §2.4 declarations): parses a file with
// its pinned grammar and turns the tree into keyed items, driven by the
// language's table (src/languages/*).
//
// The rules every language shares:
// - Each child of a scope (the file, or a container's body) is a declaration
//   (keyed), an import (`@imports` at top level), or other content (`@toplevel`
//   at top level, part of the container's shell inside one).
// - Leading comments attach to the next node when no blank line separates
//   them; decorators always do. A comment that starts on the line where an
//   item ends (and leads nothing else on that line) is that item's trailing
//   comment. Unattached comments are other content.
// - Spans of the top-level items, plus whitespace, partition the file:
//   adjacent imports form one `@imports` item, adjacent other content one
//   `@toplevel` item. Same-key siblings (overloads, accessors, redefinitions)
//   stay separate items with one key.
// - A name that doesn't fit SYMBOL_KEY_RE (string, computed, private names)
//   makes the declaration other content: part of its container, or of
//   `@toplevel` at top level.
// - A container's text is its shell (see `shellText`).
// - Errors: `contained` when every ERROR or MISSING node lies inside the body of
//   a keyed declaration (the innermost such key is recorded), `uncontained`
//   otherwise. A table names the body as a node, or as the children of a node
//   from an offset on (`Decl.region`).
// - A comment's span ends at its last non-whitespace character (the Rust
//   grammar ends a line comment after its newline).

import { IMPORTS, TOPLEVEL, isValidSymbolKey } from '@agenthub/contract';
import type { Node } from 'web-tree-sitter';
import { SymbolsError } from './errors.js';
import { loadedSpec, loadSpec } from './languages/index.js';
import { signatureText } from './signatures.js';
import type { Classified, Decl, LanguageSpec, SignatureSpec } from './spec.js';
import { blankLineBetween, lineStarts, sameLine, trimEnd } from './text.js';
import type { Grammar, GrammarRuntime } from './runtime.js';
import type { Item, LanguageId, Outline } from './types.js';

/** What the diff and the reference lookups need to know about an item beyond `Item` (kept out of the frozen type). */
export interface ItemDetail {
  /** Built from a declaration with members (a class, namespace, impl, trait, Java type, Python class): its `text` is a shell. */
  container: boolean;
  /** The declaration's body (UTF-16 offsets), for rename detection and to tell a declared name from a use; null when it has none. */
  body: [number, number] | null;
  /** What the item's signature is made of (null for none): with lazy signatures, `signatureOf` (signatures.ts) computes it from this while the tree lives. */
  sig: SignatureSpec | null;
  /** For an item carried over from another document's outline (`ExtractOptions.reuse`): where its signature's node is in this one, found again on demand. */
  sigAt?: SigLocation | null;
}

/** A signature's node by position (it is the deepest node of this type with exactly this range), and the signature's ranges. */
export interface SigLocation {
  type: string;
  start: number;
  end: number;
  ranges: Array<[number, number]>;
}

/**
 * What extraction learned about one top-level node: how the table classified
 * it, and the items built from its declarations. An incremental parse keeps
 * the subtrees outside the edit, so a top-level node with the same id in the
 * new tree is the same text with the same structure (only, perhaps, at
 * another offset): its classification carries over, and so does each item
 * whose span (attached comments included) is the same relative to the node.
 */
export interface TopMemo {
  /** The node's start in the document the memo was made for. */
  start: number;
  cls: LiteClass;
  /** Not a named node (a bare token), and a terminator of the language; found when first needed. */
  anonymous?: boolean;
  terminator?: boolean;
  /** Per declaration of `cls`: the item built for it and its span, in that document. */
  built: Array<{ start: number; end: number; item: Item } | undefined>;
}

/** A classification without nodes: what the scan needs to cut a scope into elements (declaration offsets relative to the node's start). */
type LiteClass = { type: 'comment' | 'decorator' | 'imports' | 'other' } | { type: 'decls'; decls: Array<{ name: string | null; from: number; to: number }> };

export interface ExtractOptions {
  /** Record an ItemDetail for every item. */
  details?: Map<Item, ItemDetail>;
  /** Leave every `Item.signature` null for `signatureOf` to compute on demand (needs `details`). */
  lazy?: boolean;
  /** Fill this with a TopMemo per top-level node, by node id. */
  memo?: Map<number, TopMemo>;
  /**
   * The memos and details of a document whose tree the tree being outlined
   * was incrementally parsed from (and which is still alive, so node ids are
   * unambiguous), for a tree with no syntax error: top-level declarations are
   * carried over from it instead of being built again.
   */
  reuse?: { src: string; tops: Map<number, TopMemo>; details: Map<Item, ItemDetail> };
}

/** The outline table of `language`, which `grammarFor` has loaded. */
export function specFor(language: LanguageId): LanguageSpec {
  const spec = loadedSpec(language);
  if (!spec) throw new Error(`@agenthub/symbols: the outline table for language ${String(language)} is not loaded`);
  return spec;
}

/**
 * The verified grammar of `language`, with its outline table loaded too.
 * Rejects with SymbolsError('grammar_unverified') when the grammar failed its
 * integrity check, and with a plain Error for a language without a table.
 */
export async function grammarFor(runtime: GrammarRuntime, language: LanguageId): Promise<Grammar> {
  const [, grammar] = await Promise.all([loadSpec(language), runtime.load(language)]);
  if (!grammar) throw new SymbolsError('grammar_unverified', `the ${language} grammar does not match grammars.manifest.json`);
  return grammar;
}

/**
 * Outline `source` with the grammars of `runtime`. Rejects with
 * SymbolsError('grammar_unverified') when the grammar failed its integrity
 * check. With `details`, records an ItemDetail for every item it builds.
 */
export async function outlineWith(runtime: GrammarRuntime, source: string, language: LanguageId, details?: Map<Item, ItemDetail>): Promise<Outline> {
  const grammar = await grammarFor(runtime, language);
  const spec = specFor(language);
  const tree = grammar.parser.parse(source);
  if (!tree) throw new Error(`@agenthub/symbols: the ${language} parser returned no tree`);
  try {
    return extract(tree.rootNode, source, spec, { details });
  } finally {
    tree.delete();
  }
}

interface Ctx {
  src: string;
  spec: LanguageSpec;
  lines: number[];
  /** Body node id → the key of the declaration it belongs to, for error containment. */
  bodies: Map<number, string>;
  /** Node id → the key whose body its children from `from` on are (`Decl.region`). */
  regions: Map<number, { from: number; key: string }>;
  details: Map<Item, ItemDetail> | undefined;
  /** Leave `Item.signature` null and record what it is made of in `details` instead. */
  lazy: boolean;
  memo: Map<number, TopMemo> | undefined;
  reuse: { src: string; tops: Map<number, TopMemo>; details: Map<Item, ItemDetail> } | undefined;
}

/** One stretch of a scope: a declaration's item, an import group, or other content. */
interface Element {
  kind: 'item' | 'imports' | 'other';
  start: number;
  end: number;
  /** For an item: its declaration (absent for one whose classification was carried over, until it is needed). */
  decl?: Decl;
  key?: string;
  /** An anonymous token that opens or closes the scope (`{`, `}`): goes to the shell's header or footer. */
  delimiter?: boolean;
  /** For a top-level item: its node, the declaration's index in the node's classification, and the node's memo (new, or carried over). */
  node?: Node;
  index?: number;
  memo?: TopMemo;
  /** The memo was carried over from another document, whose offsets are this much smaller. */
  shift?: number;
  carried?: boolean;
}

/**
 * The outline of the tree under `root` (the parse of `src`); see
 * ExtractOptions. Lazy signatures save about two thirds of the work (the diff
 * needs only the changed keys'), and carrying top-level declarations over
 * from the previous version of the text most of the rest.
 */
export function extract(root: Node, src: string, spec: LanguageSpec, opts: ExtractOptions = {}): Outline {
  const { details, lazy = false, memo, reuse } = opts;
  if (lazy && !details) throw new Error('@agenthub/symbols: lazy signatures need details');
  if (reuse && (!details || !lazy || root.hasError)) throw new Error('@agenthub/symbols: carrying items over needs lazy details and an error-free tree');
  const ctx: Ctx = { src, spec, lines: lineStarts(src), bodies: new Map(), regions: new Map(), details, lazy, memo, reuse };
  const items: Item[] = [];
  for (const el of scanScope(root, 'top', null, ctx)) {
    if (el.kind === 'item') {
      items.push(buildItem(el, ctx));
      continue;
    }
    const key = el.kind === 'imports' ? IMPORTS : TOPLEVEL;
    const prev = items[items.length - 1];
    if (prev && prev.key === key) {
      prev.end = el.end;
      prev.endLine = lineOf(ctx, el.end - 1);
      prev.text = src.slice(prev.start, prev.end);
    } else {
      items.push({
        key,
        kind: key === IMPORTS ? 'imports' : 'toplevel',
        start: el.start,
        end: el.end,
        startLine: lineOf(ctx, el.start),
        endLine: lineOf(ctx, el.end - 1),
        text: src.slice(el.start, el.end),
        signature: null,
        members: [],
      });
    }
  }
  return { language: spec.id, items, ...classifyErrors(root, ctx) };
}

/** The children of `parent` a scope scan visits: non-empty, from `from` on, with transparent nodes replaced by theirs. */
function scopeChildren(parent: Node, spec: LanguageSpec, from: number | undefined): Node[] {
  const out: Node[] = [];
  const add = (node: Node, floor: number | undefined): void => {
    for (const c of node.children) {
      if (c.endIndex <= c.startIndex || (floor !== undefined && c.startIndex < floor)) continue;
      if (spec.transparent?.has(c.type)) add(c, undefined);
      else out.push(c);
    }
  };
  add(parent, from);
  return out;
}

function scanScope(parent: Node, scope: string, prefix: string | null, ctx: Ctx, from?: number): Element[] {
  const { src, spec } = ctx;
  const children = scopeChildren(parent, spec, from);
  const out: Element[] = [];
  let pending: Node[] = [];
  let pendingDecorator = false;
  /** A node's end, a comment's trimmed of trailing whitespace. */
  const endOf = (n: Node): number => (spec.comments.has(n.type) ? trimEnd(src, n.startIndex, n.endIndex) : n.endIndex);
  const flush = (): void => {
    if (pending.length > 0) out.push({ kind: 'other', start: pending[0]!.startIndex, end: endOf(pending[pending.length - 1]!) });
    pending = [];
    pendingDecorator = false;
  };
  /** A blank line between the pending trivia and `n` detaches the trivia, unless a decorator is among it. */
  const detachIfBlank = (n: Node): void => {
    if (pending.length > 0 && !pendingDecorator && blankLineBetween(src, pending[pending.length - 1]!.endIndex, n.startIndex)) flush();
  };

  const top = prefix === null && (ctx.memo !== undefined || ctx.reuse !== undefined);
  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    const prev = out[out.length - 1];
    // At top level, a node the previous version had (the same subtree) is classified as it was there.
    const carried = top ? ctx.reuse?.tops.get(c.id) : undefined;
    let memo: TopMemo | undefined;
    let cls: Classified | LiteClass;
    if (carried) {
      memo = { ...carried, start: c.startIndex, built: [] };
      cls = carried.cls;
    } else {
      const fresh = spec.classify(c, scope, src);
      cls = fresh;
      if (top) memo = { start: c.startIndex, cls: lite(fresh, c.startIndex), built: [] };
    }
    if (memo) ctx.memo?.set(c.id, memo);
    const terminator = (): boolean => (memo ? (memo.terminator ??= spec.terminators.has(c.type)) : spec.terminators.has(c.type));
    const anonymous = (): boolean => (memo ? (memo.anonymous ??= !c.isNamed) : !c.isNamed);

    if (cls.type === 'comment') {
      if (pending.length === 0 && prev && sameLine(src, prev.end, c.startIndex) && !leadsNext(children, i, ctx)) {
        prev.end = endOf(c);
        continue;
      }
      detachIfBlank(c);
      pending.push(c);
      continue;
    }
    if (cls.type === 'decorator') {
      detachIfBlank(c);
      pending.push(c);
      pendingDecorator = true;
      continue;
    }
    if (pending.length === 0 && prev && terminator() && sameLine(src, prev.end, c.startIndex)) {
      prev.end = c.endIndex;
      continue;
    }
    if (cls.type === 'other' && anonymous()) {
      // A bare token (a brace, a stray `;`) takes no leading trivia.
      flush();
      out.push({ kind: 'other', start: c.startIndex, end: c.endIndex, delimiter: i === 0 || i === children.length - 1 });
      continue;
    }

    detachIfBlank(c);
    const lead = pending.length > 0 ? pending[0]!.startIndex : null;
    pending = [];
    pendingDecorator = false;
    if (cls.type === 'decls') {
      const decls: Array<{ name: string | null; start: number; end: number }> =
        cls === carried?.cls ? carried.cls.decls.map((d) => ({ name: d.name, start: c.startIndex + d.from, end: c.startIndex + d.to })) : (cls.decls as Decl[]);
      const keyed = decls.map((d) => ({ d, key: d.name === null ? null : prefix === null ? d.name : `${prefix}.${d.name}` }));
      if (keyed.length > 0 && keyed.every((k) => k.key !== null && isValidSymbolKey(k.key))) {
        keyed.forEach(({ d, key }, j) => {
          const el: Element = { kind: 'item', start: j === 0 ? (lead ?? d.start) : d.start, end: d.end, key: key! };
          if (carried) Object.assign(el, { node: c, index: j, memo, shift: c.startIndex - carried.start, carried: true });
          else {
            el.decl = d as Decl;
            if (memo) Object.assign(el, { node: c, index: j, memo });
          }
          out.push(el);
        });
        continue;
      }
      out.push({ kind: 'other', start: lead ?? c.startIndex, end: c.endIndex });
      continue;
    }
    out.push({ kind: cls.type, start: lead ?? c.startIndex, end: c.endIndex });
  }
  flush();
  return out;
}

/** A classification without its nodes, the declarations' offsets relative to the node's `start` (for a memo). */
function lite(cls: Classified, start: number): LiteClass {
  return cls.type === 'decls' ? { type: 'decls', decls: cls.decls.map((d) => ({ name: d.name, from: d.start - start, to: d.end - start })) } : { type: cls.type };
}

function buildItem(el: Element, ctx: Ctx): Item {
  const item = el.carried ? carryOver(el, ctx) : buildFresh(el, ctx);
  if (el.memo) el.memo.built[el.index!] = { start: el.start, end: el.end, item };
  return item;
}

/**
 * A top-level item from a carried-over memo: the item the previous version
 * built, moved to its new offsets, when its span has the same text there
 * (the node is the same; its attached comments and trailing tokens must be
 * too); otherwise built again from the node.
 */
function carryOver(el: Element, ctx: Ctx): Item {
  const shift = el.shift!;
  const reuse = ctx.reuse!;
  const old = reuse.tops.get(el.node!.id)!.built[el.index!];
  if (old && old.start + shift === el.start && old.end + shift === el.end && reuse.src.slice(old.start, old.end) === ctx.src.slice(el.start, el.end)) {
    return moved(old.item, shift, lineOf(ctx, el.start) - old.item.startLine, ctx);
  }
  const cls = ctx.spec.classify(el.node!, 'top', ctx.src);
  const d = cls.type === 'decls' ? cls.decls[el.index!] : undefined;
  if (!d) throw new Error('@agenthub/symbols: a carried-over declaration classified differently');
  el.decl = d;
  return buildFresh(el, ctx);
}

/** `item` (and its members) `shift` units and `lines` lines further on, with its details carried over (its signature located by position). */
function moved(item: Item, shift: number, lines: number, ctx: Ctx): Item {
  const out: Item = {
    ...item,
    start: item.start + shift,
    end: item.end + shift,
    startLine: item.startLine + lines,
    endLine: item.endLine + lines,
    members: item.members.map((m) => moved(m, shift, lines, ctx)),
  };
  const d = ctx.reuse!.details.get(item);
  if (!d) throw new Error('@agenthub/symbols: a carried-over item has no details');
  ctx.details!.set(out, { container: d.container, body: d.body && [d.body[0] + shift, d.body[1] + shift], sig: null, sigAt: relocated(d, shift) });
  return out;
}

/** Where an item's signature node is, `shift` units further on. */
function relocated(d: ItemDetail, shift: number): SigLocation | null {
  const ranges = (r: Array<[number, number]>): Array<[number, number]> => r.map(([a, b]) => [a + shift, b + shift]);
  if (d.sigAt) return { type: d.sigAt.type, start: d.sigAt.start + shift, end: d.sigAt.end + shift, ranges: ranges(d.sigAt.ranges) };
  if (d.sig) return { type: d.sig.node.type, start: d.sig.node.startIndex + shift, end: d.sig.node.endIndex + shift, ranges: ranges(d.sig.ranges) };
  return null;
}

function buildFresh(el: Element, ctx: Ctx): Item {
  const d = el.decl!;
  const key = el.key!;
  let members: Item[] = [];
  let text: string;
  if (d.members) {
    const inner = scanScope(d.members.node, d.members.scope, key, ctx, d.members.from);
    members = inner.filter((e) => e.kind === 'item').map((e) => buildItem(e, ctx));
    text = shellText(el, d.members.node, d.members.from ?? d.members.node.startIndex, inner, ctx.src);
  } else {
    text = (d.textPrefix ?? '') + ctx.src.slice(el.start, el.end);
  }
  if (d.body) ctx.bodies.set(d.body.id, key);
  if (d.region) ctx.regions.set(d.region.node.id, { from: d.region.from, key });
  const item: Item = {
    key,
    kind: d.kind,
    start: el.start,
    end: el.end,
    startLine: lineOf(ctx, el.start),
    endLine: lineOf(ctx, el.end - 1),
    text,
    signature: d.signature && !ctx.lazy ? signatureText(ctx.src, d.signature, ctx.spec) : null,
    members,
  };
  if (ctx.details) {
    const body: [number, number] | null = d.body ? [d.body.startIndex, d.body.endIndex] : d.region ? [d.region.from, d.region.node.endIndex] : null;
    ctx.details.set(item, { container: Boolean(d.members), body, sig: d.signature });
  }
  return item;
}

/**
 * A container's shell: its own text with its members cut out. The header (up
 * to and including the body's opening token) and the footer (from its closing
 * token) are kept as written, trimmed where they meet the body. Content
 * between them that belongs to no member (a computed or private member, a
 * stray statement, a detached comment) is kept as written, each piece tagged
 * `«key»` with the member before it (`«^»` before the first). Pieces are joined
 * by one space. So adding, removing or editing members, or changing the
 * whitespace between them, leaves the shell alone, while any other change to
 * the container, or moving a piece across a member, changes it.
 */
function shellText(el: Element, body: Node, bodyStart: number, inner: Element[], src: string): string {
  let lo = 0;
  let hi = inner.length;
  let headerEnd = bodyStart;
  let footerStart = body.endIndex;
  const first = inner[0];
  if (first && first.kind === 'other' && first.delimiter && first.start === bodyStart) {
    headerEnd = first.end;
    lo = 1;
  }
  const last = inner[hi - 1];
  if (hi > lo && last && last.kind === 'other' && last.delimiter && last.end >= body.endIndex) {
    footerStart = last.start;
    hi -= 1;
  }
  const parts = [src.slice(el.start, headerEnd).trimEnd()];
  let anchor = '^';
  for (let k = lo; k < hi; k++) {
    const e = inner[k]!;
    if (e.kind === 'item') anchor = e.key!;
    else parts.push(`«${anchor}»${src.slice(e.start, e.end)}`);
  }
  parts.push(src.slice(footerStart, el.end).trimStart());
  return parts.filter((p) => p !== '').join(' ');
}

function classifyErrors(root: Node, ctx: Ctx): Pick<Outline, 'errors' | 'errorKeys'> {
  const { bodies, regions } = ctx;
  if (!root.hasError) return { errors: 'none', errorKeys: [] };
  const errorKeys: string[] = [];
  let uncontained = false;
  const stack: Array<{ node: Node; key: string | null }> = [{ node: root, key: null }];
  while (stack.length > 0) {
    const { node, key: outer } = stack.pop()!;
    const key = bodies.get(node.id) ?? outer;
    if (node.isError || node.isMissing) {
      if (key === null) uncontained = true;
      else if (!errorKeys.includes(key)) errorKeys.push(key);
      continue;
    }
    const region = regions.get(node.id);
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const c = children[i]!;
      if (c.hasError) stack.push({ node: c, key: region && c.startIndex >= region.from ? region.key : key });
    }
  }
  return { errors: uncontained ? 'uncontained' : 'contained', errorKeys };
}

// ------------------------------------------------------------------ text helpers

/** 1-based line of a UTF-16 offset. */
function lineOf(ctx: Ctx, offset: number): number {
  const { lines } = ctx;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The comment at `i` shares its line with the next non-comment node, which it then leads. */
function leadsNext(children: Node[], i: number, ctx: Ctx): boolean {
  for (let j = i + 1; j < children.length; j++) {
    const n = children[j]!;
    if (ctx.spec.comments.has(n.type)) continue;
    return sameLine(ctx.src, children[i]!.endIndex, n.startIndex);
  }
  return false;
}
