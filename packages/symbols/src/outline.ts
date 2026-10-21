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
//   otherwise.

import { IMPORTS, TOPLEVEL, isValidSymbolKey } from '@agenthub/contract';
import type { Node } from 'web-tree-sitter';
import { SymbolsError } from './errors.js';
import { SPECS } from './languages/index.js';
import { signatureText } from './signatures.js';
import type { Decl, LanguageSpec } from './spec.js';
import type { GrammarRuntime } from './runtime.js';
import type { Item, LanguageId, Outline } from './types.js';

/** Outline `source` with the grammars of `runtime`. Rejects with SymbolsError('grammar_unverified') when the grammar failed its integrity check. */
export async function outlineWith(runtime: GrammarRuntime, source: string, language: LanguageId): Promise<Outline> {
  const spec = SPECS[language];
  if (!spec) throw new Error(`@agenthub/symbols: no outline table for language ${String(language)}`);
  const grammar = await runtime.load(language);
  if (!grammar) throw new SymbolsError('grammar_unverified', `the ${language} grammar does not match grammars.manifest.json`);
  const tree = grammar.parser.parse(source);
  if (!tree) throw new Error(`@agenthub/symbols: the ${language} parser returned no tree`);
  try {
    return extract(tree.rootNode, source, spec);
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
}

/** One stretch of a scope: a declaration's item, an import group, or other content. */
interface Element {
  kind: 'item' | 'imports' | 'other';
  start: number;
  end: number;
  decl?: Decl;
  key?: string;
  /** An anonymous token that opens or closes the scope (`{`, `}`): goes to the shell's header or footer. */
  delimiter?: boolean;
}

export function extract(root: Node, src: string, spec: LanguageSpec): Outline {
  const ctx: Ctx = { src, spec, lines: lineStarts(src), bodies: new Map() };
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
  return { language: spec.id, items, ...classifyErrors(root, ctx.bodies) };
}

function scanScope(parent: Node, scope: string, prefix: string | null, ctx: Ctx): Element[] {
  const { src, spec } = ctx;
  const children = parent.children.filter((c) => c.endIndex > c.startIndex);
  const out: Element[] = [];
  let pending: Node[] = [];
  let pendingDecorator = false;
  const flush = (): void => {
    if (pending.length > 0) out.push({ kind: 'other', start: pending[0]!.startIndex, end: pending[pending.length - 1]!.endIndex });
    pending = [];
    pendingDecorator = false;
  };
  /** A blank line between the pending trivia and `n` detaches the trivia, unless a decorator is among it. */
  const detachIfBlank = (n: Node): void => {
    if (pending.length > 0 && !pendingDecorator && blankLineBetween(src, pending[pending.length - 1]!.endIndex, n.startIndex)) flush();
  };

  for (let i = 0; i < children.length; i++) {
    const c = children[i]!;
    const prev = out[out.length - 1];
    const cls = spec.classify(c, scope, src);

    if (cls.type === 'comment') {
      if (pending.length === 0 && prev && sameLine(src, prev.end, c.startIndex) && !leadsNext(children, i, ctx)) {
        prev.end = c.endIndex;
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
    if (spec.terminators.has(c.type) && pending.length === 0 && prev && sameLine(src, prev.end, c.startIndex)) {
      prev.end = c.endIndex;
      continue;
    }
    if (!c.isNamed && cls.type === 'other') {
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
      const keyed = cls.decls.map((d) => ({ d, key: d.name === null ? null : prefix === null ? d.name : `${prefix}.${d.name}` }));
      if (keyed.length > 0 && keyed.every((k) => k.key !== null && isValidSymbolKey(k.key))) {
        keyed.forEach(({ d, key }, j) => out.push({ kind: 'item', start: j === 0 ? (lead ?? d.start) : d.start, end: d.end, decl: d, key: key! }));
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

function buildItem(el: Element, ctx: Ctx): Item {
  const d = el.decl!;
  const key = el.key!;
  let members: Item[] = [];
  let text: string;
  if (d.members) {
    const inner = scanScope(d.members.node, d.members.scope, key, ctx);
    members = inner.filter((e) => e.kind === 'item').map((e) => buildItem(e, ctx));
    text = shellText(el, d.members.node, inner, ctx.src);
  } else {
    text = (d.textPrefix ?? '') + ctx.src.slice(el.start, el.end);
  }
  if (d.body) ctx.bodies.set(d.body.id, key);
  return {
    key,
    kind: d.kind,
    start: el.start,
    end: el.end,
    startLine: lineOf(ctx, el.start),
    endLine: lineOf(ctx, el.end - 1),
    text,
    signature: d.signature ? signatureText(ctx.src, d.signature, ctx.spec) : null,
    members,
  };
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
function shellText(el: Element, body: Node, inner: Element[], src: string): string {
  let lo = 0;
  let hi = inner.length;
  let headerEnd = body.startIndex;
  let footerStart = body.endIndex;
  const first = inner[0];
  if (first && first.kind === 'other' && first.delimiter && first.start === body.startIndex) {
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

function classifyErrors(root: Node, bodies: Map<number, string>): Pick<Outline, 'errors' | 'errorKeys'> {
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
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const c = children[i]!;
      if (c.hasError) stack.push({ node: c, key });
    }
  }
  return { errors: uncontained ? 'uncontained' : 'contained', errorKeys };
}

// ------------------------------------------------------------------ text helpers

function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

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

/** No line break between `a` (an end) and `b` (a start). */
function sameLine(src: string, a: number, b: number): boolean {
  return src[a - 1] !== '\n' && !src.slice(a, b).includes('\n');
}

function blankLineBetween(src: string, a: number, b: number): boolean {
  const gap = (src[a - 1] === '\n' ? '\n' : '') + src.slice(a, b);
  return /\n[^\S\n]*\n/.test(gap);
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
