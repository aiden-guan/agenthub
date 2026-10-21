// The Rust table of design §2.4.
//
// - Preceding `attribute_item`s attach as leading trivia, like decorators (even
//   across a blank line). Inner attributes (`#![...]`) are other content.
// - Declarations: `function_item`, `struct_item`, `union_item`, `enum_item`,
//   `trait_item` (a container), `type_item`, `const_item`, `static_item`,
//   `macro_definition`, and `mod_item` with a body (a container whose members
//   are nested declarations). A bodiless `mod a;` is `@toplevel`, as are
//   foreign blocks, macro calls and names that don't fit SYMBOL_KEY_RE
//   (`r#type`).
// - `impl_item` is a container keyed by its `type`, with type arguments and a
//   reference (`&'a`, `&mut`) stripped, inherent and trait impls alike, so
//   `impl Session` and `impl Display for Session<T>` both hold `Session.*`
//   members; a type that isn't a plain name (`crate::Foo`, a tuple) can't be
//   keyed, so the impl is `@toplevel`. Its members: `function_item`,
//   `const_item` and `type_item` (an associated type, the counterpart of the
//   trait's).
// - Trait members: `function_item`, `function_signature_item`, `const_item`,
//   `associated_type`.
// - `@imports`: `use_declaration`, `extern_crate_declaration`.
// - Kinds: functions in an impl or trait are `method`, their consts `field`;
//   top-level consts and statics are `variable`, a macro is a `function`, a
//   union a `struct`, a module a `namespace`.
// - Signatures: functions up to the body; traits, impls and modules up to the
//   body; structs, unions, enums and type aliases in full; consts and statics
//   without the value; none for a macro. Attributes are left out.

import type { Node } from 'web-tree-sitter';
import { COMMENT, DECORATOR, IMPORT, OTHER, single, upTo, whole, type Classified, type LanguageSpec, type SigToken } from '../spec.js';

const COMMENTS: ReadonlySet<string> = new Set(['line_comment', 'block_comment']);
const WORDISH = /^[\p{L}\p{N}_$[(&*']/u;

function nameOf(node: Node): string | null {
  const n = node.childForFieldName('name');
  return n && (n.type === 'identifier' || n.type === 'type_identifier') ? n.text : null;
}

/** The key of an impl: its type's name, with type arguments and a reference stripped; null when it isn't a plain name. */
function implName(impl: Node): string | null {
  let t = impl.childForFieldName('type');
  while (t) {
    if (t.type === 'generic_type' || t.type === 'reference_type') t = t.childForFieldName('type');
    else break;
  }
  return t && t.type === 'type_identifier' ? t.text : null;
}

/** A const or static: without its value. */
function valueSignature(node: Node): ReturnType<typeof upTo> {
  const type = node.childForFieldName('type');
  return type ? { node, ranges: [[node.startIndex, type.endIndex]] } : whole(node);
}

/** An item in a scope: `top` (the file), `mod` (a module body), `impl` or `trait`. */
function item(node: Node, scope: string): Classified | null {
  const member = scope === 'impl' || scope === 'trait';
  const body = node.childForFieldName('body');
  switch (node.type) {
    case 'function_item':
      return single(node, { name: nameOf(node), kind: member ? 'method' : 'function', body, signature: upTo(node, body) });
    case 'function_signature_item':
      return scope === 'trait' ? single(node, { name: nameOf(node), kind: 'method', body: null, signature: whole(node) }) : null;
    case 'const_item':
      return single(node, { name: nameOf(node), kind: member ? 'field' : 'variable', body: node.childForFieldName('value'), signature: valueSignature(node) });
    case 'type_item':
      return scope === 'trait' ? null : single(node, { name: nameOf(node), kind: 'type', body: node.childForFieldName('type'), signature: whole(node) });
    case 'associated_type':
      return scope === 'trait' ? single(node, { name: nameOf(node), kind: 'type', body: null, signature: whole(node) }) : null;
  }
  if (member) return null;
  switch (node.type) {
    case 'struct_item':
    case 'union_item':
      return single(node, { name: nameOf(node), kind: 'struct', body, signature: whole(node) });
    case 'enum_item':
      return single(node, { name: nameOf(node), kind: 'enum', body, signature: whole(node) });
    case 'trait_item':
      return single(node, { name: nameOf(node), kind: 'trait', body, members: body && { node: body, scope: 'trait' }, signature: upTo(node, body) });
    case 'impl_item':
      return single(node, { name: implName(node), kind: 'impl', body, members: body && { node: body, scope: 'impl' }, signature: upTo(node, body) });
    case 'mod_item':
      return body ? single(node, { name: nameOf(node), kind: 'namespace', body, members: { node: body, scope: 'mod' }, signature: upTo(node, body) }) : null;
    case 'static_item':
      return single(node, { name: nameOf(node), kind: 'variable', body: node.childForFieldName('value'), signature: valueSignature(node) });
    case 'macro_definition':
      return single(node, { name: nameOf(node), kind: 'function', body: null, signature: null });
    default:
      return null;
  }
}

function space(a: SigToken, b: SigToken): boolean | undefined {
  if (a.parent === 'visibility_modifier' && b.text === '(') return false; // pub(crate)
  if (a.text === 'fn' && b.text === '(') return false; // fn(u8) -> u8
  if (a.type === 'lifetime') return !/^[,>:)\];]/.test(b.text); // &'a str, <'a>
  if (a.type === 'mutable_specifier') return WORDISH.test(b.text); // &mut [u8]
  if (b.text === '?' && b.parent === 'removed_trait_bound') return true; // T: ?Sized
  if (a.text === '?' && a.parent === 'removed_trait_bound') return false;
  return undefined;
}

export const rust: LanguageSpec = {
  id: 'rust',
  comments: COMMENTS,
  sigSkip: new Set(['attribute_item', 'inner_attribute_item']),
  atoms: new Set(['string_literal', 'raw_string_literal', 'char_literal', 'lifetime']),
  binaryOps: new Set(['+']),
  terminators: new Set([';']),
  space,
  classify(node: Node, scope: string): Classified {
    if (COMMENTS.has(node.type)) return COMMENT;
    if (node.type === 'attribute_item') return DECORATOR;
    if (scope !== 'impl' && scope !== 'trait' && (node.type === 'use_declaration' || node.type === 'extern_crate_declaration')) return IMPORT;
    return item(node, scope) ?? OTHER;
  },
};
