// The shape of a language table (design §2.4 "Declarations": a data-driven
// extractor, one table per language). A table classifies each child node of a
// scope; the engine in outline.ts turns that into keyed items, attaches
// comments and decorators, cuts container shells and classifies errors.

import type { Node } from 'web-tree-sitter';
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
  /** A container: the node whose children are scanned for members, and the scope name the table classifies them under. */
  members?: { node: Node; scope: string } | null;
  signature: SignatureSpec | null;
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
