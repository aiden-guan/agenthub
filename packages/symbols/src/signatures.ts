// Normalized signatures (design §2.4 "Signatures"): the tokens of a
// declaration's API part with comments (and decorators) removed, joined with a
// fixed spacing rule, at most 500 characters. Because the spacing comes from
// the tokens and never from the source, a whitespace-only or comment-only
// change keeps a signature byte for byte, while any token change alters it.
// A language can refine the spacing (`LanguageSpec.space`), from the tokens'
// node types alone, so that stays true.

import type { Node } from 'web-tree-sitter';
import type { LanguageSpec, SigToken, SignatureSpec } from './spec.js';

export const MAX_SIGNATURE = 500;

type Token = SigToken;

const WORD = /[\p{L}\p{N}_$]/u;
const KEYWORD = /^[A-Za-z_]+$/;
/** No space before these. */
const TIGHT_BEFORE = new Set([')', ']', ',', ';', '.', ':', '>', '::', '?.', '!']);
/** No space after these. */
const TIGHT_AFTER = new Set(['(', '[', '<', '.', '::', '?.', '@', '#', '...', '!', '~', '&', '*', '-', '+']);
/** Spaced on both sides in every language. */
const SPACED = new Set(['=', '=>', '->', '|', '||', '&&', '??', '==', '!=', '===', '!==', '<=', '>=', '+=', '-=', ':=']);
/** A `?` followed by one of these marks an optional item (`a?: T`), not a conditional. */
const OPTIONAL_FOLLOWERS = new Set([':', '.', ')', ',', '=', ']', ';', '>']);
const CLOSERS = new Set([')', ']', '>', '}', '"', "'", '`']);
const QUOTES = new Set(['"', "'", '`']);

/** The normalized signature `spec` describes in `source`, or null when it has no tokens. */
export function signatureText(source: string, spec: SignatureSpec, lang: LanguageSpec): string | null {
  const tokens: Token[] = [];
  let budget = MAX_SIGNATURE * 2;
  for (const [start, end] of spec.ranges) {
    if (end <= start) continue;
    let pos = start;
    const gap = (upTo: number): void => {
      const text = source.slice(pos, upTo).trim();
      if (text !== '') tokens.push({ text: text.replace(/\s+/g, ' '), keyword: false, type: '', parent: '' });
    };
    walkTokens(spec.node, start, end, lang, (s, e, skip, named, type, parent) => {
      if (budget <= 0) return false;
      if (s < pos) return true;
      gap(s);
      pos = Math.min(e, end);
      if (skip || e <= s) return true;
      const text = source.slice(s, e);
      tokens.push({ text, keyword: KEYWORD.test(text) && !named(), type, parent });
      budget -= text.length + 1;
      return true;
    });
    if (budget > 0) gap(end);
  }
  while (tokens.length > 0 && (tokens[tokens.length - 1]!.text === ';' || tokens[tokens.length - 1]!.text === ',')) tokens.pop();
  if (tokens.length === 0) return null;
  return truncate(join(tokens, lang));
}

/**
 * Visit the tokens of `root` that overlap [start, end), in source order: leaves,
 * atoms (taken whole) and skipped nodes (comments, decorators: `skip` true), each
 * with its node type and its parent's, with a tree cursor so no Node objects are
 * made. `emit` returns false to stop.
 */
function walkTokens(
  root: Node,
  start: number,
  end: number,
  lang: LanguageSpec,
  emit: (s: number, e: number, skip: boolean, named: () => boolean, type: string, parent: string) => boolean,
): void {
  const cur = root.walk();
  const parents: string[] = [];
  try {
    const named = (): boolean => cur.nodeIsNamed;
    for (;;) {
      const s = cur.startIndex;
      if (s >= end) return; // pre-order: everything after starts later
      if (cur.endIndex > start) {
        const type = cur.nodeType;
        const skip = lang.comments.has(type) || lang.sigSkip.has(type);
        if (skip || lang.atoms.has(type) || !cur.gotoFirstChild()) {
          if (!emit(s, cur.endIndex, skip, named, type, parents[parents.length - 1] ?? '')) return;
        } else {
          parents.push(type);
          continue; // now on the first child
        }
      }
      while (!cur.gotoNextSibling()) {
        if (!cur.gotoParent()) return;
        parents.pop();
      }
    }
  } finally {
    cur.delete();
  }
}

function join(tokens: Token[], lang: LanguageSpec): string {
  let out = tokens[0]!.text;
  for (let i = 1; i < tokens.length; i++) {
    if (lang.space?.(tokens[i - 1]!, tokens[i]!) ?? spaceBefore(tokens, i, lang.binaryOps)) out += ' ';
    out += tokens[i]!.text;
  }
  return out;
}

function isConditional(tokens: Token[], i: number): boolean {
  const next = tokens[i + 1];
  return tokens[i]!.text === '?' && next !== undefined && !OPTIONAL_FOLLOWERS.has(next.text);
}

function spaceBefore(tokens: Token[], i: number, binaryOps: ReadonlySet<string>): boolean {
  const prev = tokens[i - 1]!;
  const a = prev.text;
  const b = tokens[i]!.text;
  const la = a[a.length - 1]!;
  const fb = b[0]!;
  if (a === '{') return b !== '}';
  if (b === '}') return true;
  if (SPACED.has(a) || SPACED.has(b) || binaryOps.has(a) || binaryOps.has(b)) return !(TIGHT_AFTER.has(a) && !binaryOps.has(a)) && !TIGHT_BEFORE.has(b);
  if (TIGHT_BEFORE.has(b)) return false;
  if (a === '?') return isConditional(tokens, i - 1);
  if (b === '?') return isConditional(tokens, i);
  if (a === '*' && i >= 2 && tokens[i - 2]!.keyword) return true; // function* gen
  if (TIGHT_AFTER.has(a)) return false;
  if (b === '{') return true; // `interface I {`, `enum E {`
  if (a === ',' || a === ';' || a === ':') return true;
  if (WORD.test(la) && WORD.test(fb)) return true;
  if (WORD.test(la) && QUOTES.has(fb)) return true; // `default ""`, `x is "a"`, a Go struct tag
  if (CLOSERS.has(la) && WORD.test(fb)) return true; // `) Refresh`, `> extends`, `] args`
  if (a === ')' && b === '(') return true; // Go results: `() (int, error)`
  if (b === '@') return true;
  if (prev.keyword && b === '(') return true; // `async (`, `func (`, `function (`
  if ((b === '*' || b === '&') && !prev.keyword && (WORD.test(la) || CLOSERS.has(la))) return true; // Go `s *Session`
  return false;
}

function truncate(s: string): string {
  if (s.length <= MAX_SIGNATURE) return s;
  let cut = s.slice(0, MAX_SIGNATURE - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}
