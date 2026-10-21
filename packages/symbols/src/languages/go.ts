// The Go table of design §2.4. Go has no containers: everything is top level.
//
// - Declarations: `function_declaration`; `method_declaration` keyed
//   `<Receiver>.<name>`, with the receiver's `*`, parentheses and type
//   arguments stripped (a receiver that isn't a plain type name can't be keyed,
//   so the method is `@toplevel`); and each `type_spec` (or `type_alias`),
//   `const_spec` and `var_spec` by its name. A group (`const ( ... )`) is split
//   per spec (`splitSpecs`). A spec that declares several names (`var a, b = 1,
//   2`) can't be keyed one by one, so its whole declaration is `@toplevel`, like
//   TypeScript destructuring.
// - `@imports`: `package_clause` and `import_declaration`.
// - Kinds: a struct type is `struct`, an interface `interface`, any other type
//   `type`; consts and vars are `variable`.
// - Signatures: a function or method up to its body (the receiver included); a
//   type spec in full, after the `type` keyword; a const or var up to its type,
//   or up to a function literal's body, or null.

import type { Node } from 'web-tree-sitter';
import { COMMENT, IMPORT, OTHER, single, splitSpecs, upTo, type Classified, type LanguageSpec, type SigToken, type SignatureSpec } from '../spec.js';

const COMMENTS: ReadonlySet<string> = new Set(['comment']);
/** Type literals whose `[...]` prefix binds tightly: `[]T`, `[4]T`, `map[K]V`. */
const BRACKET_TYPES: ReadonlySet<string> = new Set(['slice_type', 'array_type', 'implicit_length_array_type', 'map_type']);
const SLICE_TYPES: ReadonlySet<string> = new Set(['slice_type', 'array_type', 'implicit_length_array_type']);
/** A token that ends an operand (a name, `)` or `]`), after which a type literal takes a space: `xs []T`, `) []T`. */
const ENDS_OPERAND = /[\p{L}\p{N}_$)\]]$/u;

/** The receiver's type name: `Session` for `(s *Session)`, `(Session)`, `(m Map[K, V])`; null for anything else. */
function receiverName(method: Node): string | null {
  const param = method.childForFieldName('receiver')?.namedChildren.find((c) => c.type === 'parameter_declaration');
  let t = param?.childForFieldName('type') ?? null;
  while (t) {
    if (t.type === 'pointer_type' || t.type === 'parenthesized_type') t = t.namedChildren.find((c) => !COMMENTS.has(c.type)) ?? null;
    else if (t.type === 'generic_type') t = t.childForFieldName('type');
    else break;
  }
  return t && t.type === 'type_identifier' ? t.text : null;
}

/** The one name a spec declares, or null when it declares several (or none). */
function specName(spec: Node): string | null {
  const names = spec.childrenForFieldName('name');
  return names.length === 1 ? names[0]!.text : null;
}

function typeKind(spec: Node): 'struct' | 'interface' | 'type' {
  const t = spec.type === 'type_spec' ? spec.childForFieldName('type') : null;
  return t?.type === 'struct_type' ? 'struct' : t?.type === 'interface_type' ? 'interface' : 'type';
}

/** A `type`, `const` or `var` declaration, one decl per spec. */
function specs(node: Node, src: string): Classified | null {
  const keyword = node.child(0);
  const list = node.namedChildren.find((c) => c.type === 'var_spec_list') ?? node;
  const found = list.namedChildren.filter((c) => c.type === 'type_spec' || c.type === 'type_alias' || c.type === 'const_spec' || c.type === 'var_spec');
  if (!keyword || found.length === 0) return null;
  const open = list.children.find((c) => c.type === '(');
  const header = `${src.slice(node.startIndex, (open ?? keyword).endIndex)} `;
  const kw: [number, number] = [node.startIndex, keyword.endIndex];
  return splitSpecs(node, found, src, { comments: COMMENTS, header }, (spec) => {
    if (spec.type === 'type_spec' || spec.type === 'type_alias') {
      return { name: specName(spec), kind: typeKind(spec), body: spec.childForFieldName('type'), signature: { node, ranges: [kw, [spec.startIndex, spec.endIndex]] } };
    }
    return { name: specName(spec), kind: 'variable', body: spec.childForFieldName('value'), signature: valueSignature(node, kw, spec) };
  });
}

/** A const or var: up to its type, or up to the body of a function literal it holds, or null. */
function valueSignature(node: Node, kw: [number, number], spec: Node): SignatureSpec | null {
  const values = spec.childForFieldName('value')?.namedChildren ?? [];
  const fn = values.length === 1 && values[0]!.type === 'func_literal' ? values[0]! : null;
  const type = spec.childForFieldName('type');
  let end: number;
  if (fn) end = (fn.childForFieldName('body') ?? fn).startIndex;
  else if (type) end = type.endIndex;
  else return null;
  return { node, ranges: [kw, [spec.startIndex, end]] };
}

function space(a: SigToken, b: SigToken): boolean | undefined {
  if (a.text === ']' && BRACKET_TYPES.has(a.parent)) return false; // []T, map[K]V
  if (b.text === '[' && SLICE_TYPES.has(b.parent)) return ENDS_OPERAND.test(a.text); // xs []T, ) []T
  if (a.text === 'func' && b.text === '(') return a.parent === 'method_declaration'; // func (s *S) M(), func(x int)
  if (b.text === '...' && b.parent === 'variadic_parameter_declaration') return ENDS_OPERAND.test(a.text); // xs ...T
  if (a.text === '<-' && a.parent === 'channel_type') return b.text !== 'chan'; // chan<- T, <-chan T
  return undefined;
}

export const go: LanguageSpec = {
  id: 'go',
  comments: COMMENTS,
  sigSkip: new Set(),
  atoms: new Set(['interpreted_string_literal', 'raw_string_literal', 'rune_literal']),
  binaryOps: new Set(),
  terminators: new Set([';']),
  space,
  classify(node: Node, _scope: string, src: string): Classified {
    switch (node.type) {
      case 'comment':
        return COMMENT;
      case 'package_clause':
      case 'import_declaration':
        return IMPORT;
      case 'function_declaration': {
        const body = node.childForFieldName('body');
        return single(node, { name: node.childForFieldName('name')?.text ?? null, kind: 'function', body, signature: upTo(node, body) });
      }
      case 'method_declaration': {
        const body = node.childForFieldName('body');
        const receiver = receiverName(node);
        const name = node.childForFieldName('name')?.text;
        return single(node, { name: receiver && name ? `${receiver}.${name}` : null, kind: 'method', body, signature: upTo(node, body) });
      }
      case 'type_declaration':
      case 'const_declaration':
      case 'var_declaration':
        return specs(node, src) ?? OTHER;
      default:
        return OTHER;
    }
  },
};
