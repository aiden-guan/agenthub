// The Java table of design §2.4.
//
// - Declarations: `class_declaration`, `record_declaration`,
//   `interface_declaration`, `annotation_type_declaration` and
//   `enum_declaration`, all containers. Annotations sit inside a declaration's
//   `modifiers`, so they are part of its span.
// - Members: `method_declaration`, `constructor_declaration` and a record's
//   `compact_constructor_declaration` (both `C.constructor`, overloads sharing
//   the key), each declarator of a `field_declaration` or an interface's
//   `constant_declaration` (split as `splitSpecs` says), an annotation type's
//   elements, and nested types (`Outer.Inner`). Initializer blocks and stray
//   content are part of the shell. An enum's members are those after its
//   constants (`enum_body_declarations`); the constants are part of its shell,
//   and an enum with nothing after them is a plain item.
// - `@imports`: `package_declaration`, `import_declaration`.
// - Kinds: classes and records are `class`, interfaces and annotation types
//   `interface`.
// - Signatures (annotations left out): a type up to its body, an enum up to its
//   body plus its constants (without their bodies); methods and constructors up
//   to the body; a field without its initializer.

import type { Node } from 'web-tree-sitter';
import { COMMENT, IMPORT, OTHER, single, splitSpecs, upTo, whole, type Classified, type LanguageSpec, type SigToken, type SignatureSpec } from '../spec.js';
import type { ItemKind } from '../types.js';

const COMMENTS: ReadonlySet<string> = new Set(['line_comment', 'block_comment']);
const TYPES: ReadonlyMap<string, ItemKind> = new Map([
  ['class_declaration', 'class'],
  ['record_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['annotation_type_declaration', 'interface'],
  ['enum_declaration', 'enum'],
]);

function nameOf(node: Node): string | null {
  const n = node.childForFieldName('name');
  return n && n.type === 'identifier' ? n.text : null;
}

function typeDeclaration(node: Node, kind: ItemKind): Classified {
  const body = node.childForFieldName('body');
  if (node.type !== 'enum_declaration') {
    return single(node, { name: nameOf(node), kind, body, members: body && { node: body, scope: 'class' }, signature: upTo(node, body) });
  }
  const decls = body?.namedChildren.find((c) => c.type === 'enum_body_declarations') ?? null;
  return single(node, { name: nameOf(node), kind, body, members: decls && { node: decls, scope: 'class' }, signature: body ? enumSignature(node, body) : whole(node) });
}

/** An enum's header and constants: `enum Role { ADMIN("a"), USER("u") }`, the constants' class bodies left out. */
function enumSignature(node: Node, body: Node): SignatureSpec {
  const ranges: Array<[number, number]> = [[node.startIndex, body.startIndex + 1]];
  const constants = body.namedChildren.filter((c) => c.type === 'enum_constant');
  if (constants.length > 0) {
    let pos = constants[0]!.startIndex;
    for (const c of constants) {
      const own = c.childForFieldName('body');
      if (own) {
        ranges.push([pos, own.startIndex]);
        pos = own.endIndex;
      }
    }
    ranges.push([pos, constants[constants.length - 1]!.endIndex]);
  }
  ranges.push([body.endIndex - 1, body.endIndex]);
  return { node, ranges };
}

/** `private static final int A = 1, B = 2;`: one field per declarator. */
function fields(node: Node, src: string): Classified | null {
  const declarators = node.childrenForFieldName('declarator');
  if (declarators.length === 0) return null;
  const first = declarators[0]!;
  const sigHeader: [number, number] = [node.startIndex, first.startIndex];
  return splitSpecs(node, declarators, src, { comments: COMMENTS, header: src.slice(node.startIndex, first.startIndex) }, (d) => {
    const end = (d.childForFieldName('dimensions') ?? d.childForFieldName('name') ?? d).endIndex;
    return { name: nameOf(d), kind: 'field', body: d.childForFieldName('value'), signature: { node, ranges: [sigHeader, [d.startIndex, end]] } };
  });
}

function member(node: Node, src: string): Classified | null {
  const body = node.childForFieldName('body');
  switch (node.type) {
    case 'method_declaration':
      return single(node, { name: nameOf(node), kind: 'method', body, signature: upTo(node, body) });
    case 'constructor_declaration':
    case 'compact_constructor_declaration':
      return single(node, { name: 'constructor', kind: 'constructor', body, signature: upTo(node, body) });
    case 'annotation_type_element_declaration':
      return single(node, { name: nameOf(node), kind: 'method', body: node.childForFieldName('value'), signature: whole(node) });
    case 'field_declaration':
    case 'constant_declaration':
      return fields(node, src);
    default:
      return null;
  }
}

function space(a: SigToken, b: SigToken): boolean | undefined {
  if (b.text === '<' && a.keyword) return true; // public <T> T get()
  if (a.text === '...') return true; // T... rest
  if (b.text === '...') return false;
  if (b.text === '?' && b.parent === 'wildcard') return a.text === ','; // List<? extends T>
  if (a.text === '?' && a.parent === 'wildcard') return b.text !== '>' && b.text !== ',';
  return undefined;
}

export const java: LanguageSpec = {
  id: 'java',
  comments: COMMENTS,
  sigSkip: new Set(['marker_annotation', 'annotation']),
  atoms: new Set(['string_literal', 'character_literal', 'text_block']),
  binaryOps: new Set(['&']),
  terminators: new Set([';']),
  space,
  classify(node: Node, scope: string, src: string): Classified {
    if (COMMENTS.has(node.type)) return COMMENT;
    if (scope === 'top' && (node.type === 'package_declaration' || node.type === 'import_declaration')) return IMPORT;
    const kind = TYPES.get(node.type);
    if (kind) return typeDeclaration(node, kind);
    return (scope === 'class' ? member(node, src) : null) ?? OTHER;
  },
};
