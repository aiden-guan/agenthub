// The shape of a language table (design §2.4 "Declarations": a data-driven
// extractor, one table per language). A table classifies each child node of a
// scope; the engine in outline.ts turns that into keyed items, attaches
// comments and decorators, cuts container shells and classifies errors.

import type { Node } from 'web-tree-sitter';
import { blankLineBetween, sameLine, trimEnd } from './text.js';
import type { ItemKind, LanguageId } from './types.js';

/** Tokens of `node` inside `ranges` (absolute UTF-16 offsets), in order, make up a signature. */
export interface SignatureSpec {
  node: Node;
  ranges: Array<[number, number]>;
}

/** One declaration a table found: becomes one item (a statement with several declarators gives several). */
export interface Decl {
  /** The key segment (`login`, `Session`, `Session.Refresh` for a Go method). null when it has no usable name: the engine then treats the node as plain content. */
  name: string | null;
  kind: ItemKind;
  /** The span before attached comments and decorators: the unwrapped node's range (export_statement and the like kept). */
  start: number;
  end: number;
  /** Text put before the span in the item's text: a later declarator carries its statement's header (`export const `). */
  textPrefix?: string;
  /** The node whose descendants count as inside this declaration's body, for error containment. */
  body: Node | null;
  /**
   * Also inside the body, for error containment: the children of `node` that start at or after `from`
   * (Python, where tree-sitter can put an error between a header's `:` and its block).
   */
  region?: { node: Node; from: number } | null;
  /**
   * A container: the node whose children are scanned for members (only those
   * from offset `from` on, when given: what follows a Python header's `:`),
   * and the scope name the table classifies them under.
   */
  members?: { node: Node; scope: string; from?: number } | null;
  signature: SignatureSpec | null;
}

/** One token of a signature, as the spacing rule sees it. */
export interface SigToken {
  text: string;
  /** An anonymous word token: a keyword such as `function`, `async`, `func`. */
  keyword: boolean;
  /** The node type of the token (of the leaf, or of the atom taken whole); '' for text no token covers. */
  type: string;
  /** The node type of its parent; '' at the root. */
  parent: string;
}

export type Classified =
  | { type: 'comment' }
  | { type: 'decorator' }
  | { type: 'imports' }
  | { type: 'other' }
  | { type: 'decls'; decls: Decl[] };

export const COMMENT: Classified = { type: 'comment' };
export const DECORATOR: Classified = { type: 'decorator' };
export const IMPORT: Classified = { type: 'imports' };
export const OTHER: Classified = { type: 'other' };

export interface LanguageSpec {
  id: LanguageId;
  /** Node types that are comments: trivia in scopes, dropped from signatures. */
  comments: ReadonlySet<string>;
  /** Node types left out of signatures besides comments (decorators, annotations, attributes). */
  sigSkip: ReadonlySet<string>;
  /** Node types taken whole as one signature token (string literals keep their inner spacing). */
  atoms: ReadonlySet<string>;
  /** Operators spaced on both sides in signatures, beyond the common ones (`&` is binary in TypeScript, a prefix in Rust). */
  binaryOps: ReadonlySet<string>;
  /** Tokens that, right after an item on the same line, belong to it (`;` after a TypeScript class member). */
  terminators: ReadonlySet<string>;
  /** Node types a scope scan replaces with their children (a Python `block`, whose leading comments tree-sitter puts before it). */
  transparent?: ReadonlySet<string>;
  /** The language's own spacing between two signature tokens, consulted before the common rule; undefined defers to it. */
  space?: (a: SigToken, b: SigToken) => boolean | undefined;
  /** Classify one child of a scope (`top` for the file, otherwise a scope name the table gave in `Decl.members`) of the file `src`. */
  classify(node: Node, scope: string, src: string): Classified;
}

/** One item spanning `wrapper` (attached trivia aside). */
export function single(wrapper: Node, d: Omit<Decl, 'start' | 'end'>): Classified {
  return { type: 'decls', decls: [{ ...d, start: wrapper.startIndex, end: wrapper.endIndex }] };
}

/** A signature from the start of `node` to the start of `stop` (a body), or to its end without one. */
export function upTo(node: Node, stop: Node | null): SignatureSpec {
  return { node, ranges: [[node.startIndex, stop ? stop.startIndex : node.endIndex]] };
}

/** A signature that is the whole of `node` (interfaces, aliases, enums: all of it is API). */
export function whole(node: Node): SignatureSpec {
  return { node, ranges: [[node.startIndex, node.endIndex]] };
}

/**
 * A statement that declares several names one by one (a Go `const (...)`
 * group, a Java `int a = 1, b = 2;`), split into one decl per spec. The first
 * spans from the statement start (its header and leading comments included),
 * the last to the statement end (its closing token included). A later spec
 * starts at its own leading comments (those with no blank line before it that
 * don't trail the previous spec on its line), and each spec but the last ends
 * at its last non-whitespace character before the next one starts, so a
 * trailing or detached comment stays with the spec before it. A later spec's
 * text starts with `header`, so a header change touches every key.
 */
export function splitSpecs(
  wrapper: Node,
  specs: Node[],
  src: string,
  opts: { comments: ReadonlySet<string>; header: string },
  make: (spec: Node) => Omit<Decl, 'start' | 'end' | 'textPrefix'>,
): Classified {
  const starts = specs.map((spec, i) => (i === 0 ? wrapper.startIndex : leadStart(spec, specs[i - 1]!, src, opts.comments)));
  return {
    type: 'decls',
    decls: specs.map(
      (spec, i): Decl => ({
        ...make(spec),
        start: starts[i]!,
        end: i === specs.length - 1 ? wrapper.endIndex : trimEnd(src, spec.endIndex, starts[i + 1]!),
        textPrefix: i === 0 ? '' : opts.header,
      }),
    ),
  };
}

/** Where `spec` starts with its attached leading comments. */
function leadStart(spec: Node, prev: Node, src: string, comments: ReadonlySet<string>): number {
  let start = spec.startIndex;
  for (let p = spec.previousSibling; p && comments.has(p.type); p = p.previousSibling) {
    if (blankLineBetween(src, p.endIndex, start) || sameLine(src, prev.endIndex, p.startIndex)) break;
    start = p.startIndex;
  }
  return start;
}

/** The last anonymous `token` child of `node` that ends at or before `limit` (a Python header's `:`). */
export function lastToken(node: Node, token: string, limit: number): Node | null {
  let found: Node | null = null;
  for (const c of node.children) {
    if (c.startIndex >= limit) break;
    if (!c.isNamed && c.type === token && c.endIndex <= limit) found = c;
  }
  return found;
}
