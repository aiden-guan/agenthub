// The Python table of design §2.4.
//
// - Unwrapped, range kept: `decorated_definition` (field `definition`), so its
//   decorators are part of the item.
// - Declarations: `function_definition`, `class_definition` (a container), and
//   a top-level `expression_statement` holding one `assignment` whose `left` is
//   an identifier (annotated or not, `X: int` included). A chained assignment
//   (`X = Y = 1`) declares names the table can't key one by one: `@toplevel`,
//   like destructuring, attribute and subscript targets and augmented
//   assignments.
// - Class members: methods (`__init__` has kind `constructor`), assignments to a
//   plain name (fields), and nested classes (`Outer.Inner`, containers in turn).
//   Anything else in a class body (its docstring, imports, `if` blocks) is part
//   of its shell. A class body is scanned from the header's `:` (or a comment
//   on its line) on, because tree-sitter puts the comments right after the `:`
//   before the `block`, which the scan sees through.
// - `@imports`: `import_statement`, `import_from_statement`,
//   `future_import_statement`.
// - Signatures: a function or class up to the `:` before its body (decorators
//   left out); an assignment up to its annotation, or up to a lambda's `:`, or
//   null.
// - Errors: tree-sitter can put an ERROR between a header's `:` and its block,
//   so a definition's body is everything after that `:` (`Decl.region`).

import type { Node } from 'web-tree-sitter';
import { COMMENT, IMPORT, OTHER, lastToken, single, type Classified, type LanguageSpec, type SigToken, type SignatureSpec } from '../spec.js';
import { sameLine } from '../text.js';

const COMMENTS: ReadonlySet<string> = new Set(['comment']);
/** Where `=` takes no spaces: `f(x=1)`, `def f(x=1)` (but `def f(x: int = 1)`, as PEP 8 writes them). */
const TIGHT_EQUALS: ReadonlySet<string> = new Set(['keyword_argument', 'default_parameter']);

function nameOf(node: Node): string | null {
  const n = node.childForFieldName('name');
  return n && n.type === 'identifier' ? n.text : null;
}

/** The end of a class header: its `:`, or a comment after it on the same line. */
function headerEnd(colon: Node, src: string): number {
  const next = colon.nextSibling;
  return next && COMMENTS.has(next.type) && sameLine(src, colon.endIndex, next.startIndex) ? next.endIndex : colon.endIndex;
}

/** A function or class definition, `wrapper` being the node whose range the item keeps (a decorated_definition). */
function definition(node: Node, wrapper: Node, scope: string, src: string): Classified | null {
  const body = node.childForFieldName('body');
  const colon = lastToken(node, ':', body ? body.startIndex : node.endIndex);
  const signature: SignatureSpec = { node, ranges: [[node.startIndex, colon ? colon.startIndex : (body ?? node).startIndex]] };
  const region = colon ? { node, from: colon.endIndex } : null;
  if (node.type === 'function_definition') {
    const name = nameOf(node);
    const kind = scope === 'top' ? 'function' : name === '__init__' ? 'constructor' : 'method';
    return single(wrapper, { name, kind, body: null, region, signature });
  }
  if (node.type === 'class_definition') {
    // Members are scanned from the `:` on, since tree-sitter puts the comments right after it before the
    // block; a comment on the header's own line stays in the header.
    const members = colon ? { node, scope: 'class', from: headerEnd(colon, src) } : body && { node: body, scope: 'class' };
    return single(wrapper, { name: nameOf(node), kind: 'class', body: null, region, members, signature });
  }
  return null;
}

/** `X = 1`, `X: int = 1`, `X: int`: one assignment to a plain name, as a variable or a field. */
function assignment(node: Node, scope: string): Classified | null {
  const named = node.namedChildren.filter((c) => !COMMENTS.has(c.type));
  const a = named[0];
  if (named.length !== 1 || !a || a.type !== 'assignment') return null;
  const left = a.childForFieldName('left');
  const right = a.childForFieldName('right');
  if (!left || left.type !== 'identifier' || right?.type === 'assignment') return null;
  const type = a.childForFieldName('type');
  let signature: SignatureSpec | null = null;
  if (type) signature = { node: a, ranges: [[a.startIndex, type.endIndex]] };
  else if (right?.type === 'lambda') {
    const colon = lastToken(right, ':', (right.childForFieldName('body') ?? right).startIndex);
    signature = { node: a, ranges: [[a.startIndex, colon ? colon.startIndex : right.endIndex]] };
  }
  return single(node, { name: left.text, kind: scope === 'top' ? 'variable' : 'field', body: right, signature });
}

function declaration(node: Node, scope: string, src: string): Classified | null {
  switch (node.type) {
    case 'decorated_definition': {
      const def = node.childForFieldName('definition');
      return def ? definition(def, node, scope, src) : null;
    }
    case 'function_definition':
    case 'class_definition':
      return definition(node, node, scope, src);
    case 'expression_statement':
      return assignment(node, scope);
    default:
      return null;
  }
}

function space(a: SigToken, b: SigToken): boolean | undefined {
  if ((a.text === '=' && TIGHT_EQUALS.has(a.parent)) || (b.text === '=' && TIGHT_EQUALS.has(b.parent))) return false;
  return undefined;
}

export const python: LanguageSpec = {
  id: 'python',
  comments: COMMENTS,
  sigSkip: new Set(['decorator']),
  atoms: new Set(['string', 'concatenated_string']),
  binaryOps: new Set(),
  terminators: new Set([';']),
  transparent: new Set(['block']),
  space,
  classify(node: Node, scope: string, src: string): Classified {
    if (COMMENTS.has(node.type)) return COMMENT;
    if (scope === 'top' && (node.type === 'import_statement' || node.type === 'import_from_statement' || node.type === 'future_import_statement')) return IMPORT;
    return declaration(node, scope, src) ?? OTHER;
  },
};
