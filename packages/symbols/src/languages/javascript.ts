// The TS/TSX/JS table of design §2.4. The JavaScript, TypeScript and TSX
// grammars share their node names, so one table serves all three
// (typescript.ts instantiates it for the two TypeScript grammars); node types a
// grammar doesn't have simply never occur.
//
// - Unwrapped, range kept: `export_statement` (field `declaration`, or `value`
//   for an anonymous default → `default`), `ambient_declaration`, and the
//   `expression_statement` a bare `namespace` sits in.
// - Declarations: functions, generators and overload signatures (`function`),
//   classes (containers), interfaces, type aliases, enums, namespaces and
//   modules (containers); each `variable_declarator` of a
//   `lexical_declaration`/`variable_declaration`, while a statement with a
//   destructuring pattern goes to `@toplevel`.
// - Class members: methods, method signatures, abstract signatures and fields;
//   a constructor is `C.constructor`. Namespace members: nested declarations.
// - `@imports`: `import_statement` (and `import x = require()`), and
//   `export_statement` with a `source`.

import type { Node } from 'web-tree-sitter';
import { COMMENT, DECORATOR, IMPORT, OTHER, single, upTo, whole, type Classified, type Decl, type LanguageSpec, type SignatureSpec } from '../spec.js';
import type { LanguageId } from '../types.js';

const COMMENTS: ReadonlySet<string> = new Set(['comment', 'html_comment']);
const FUNCTION_VALUES: ReadonlySet<string> = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const NAME_TYPES: ReadonlySet<string> = new Set(['identifier', 'type_identifier', 'property_identifier', 'nested_identifier']);

/** The usable name in field `field` of `node`: identifiers only (string, computed and private names give null). */
function nameOf(node: Node, field = 'name'): string | null {
  const n = node.childForFieldName(field);
  if (!n || !NAME_TYPES.has(n.type)) return null;
  return n.type === 'nested_identifier' ? n.text.replace(/\s+/g, '') : n.text;
}

/**
 * The signature of a variable or field: the declaration without its
 * initializer, or null without a type annotation; when the value is a function,
 * up to that function's body (its parameters are API).
 */
function valueSignature(node: Node, ranges: Array<[number, number]>, decl: Node): SignatureSpec | null {
  const value = decl.childForFieldName('value');
  const type = decl.childForFieldName('type');
  let end: number;
  if (value && FUNCTION_VALUES.has(value.type)) end = (value.childForFieldName('body') ?? value).startIndex;
  else if (type) end = type.endIndex;
  else return null;
  return { node, ranges: [...ranges, [decl.startIndex, end]] };
}

function declarators(node: Node, wrapper: Node, src: string): Classified | null {
  const decls = node.namedChildren.filter((c) => c.type === 'variable_declarator');
  if (decls.length === 0) return null;
  // Destructuring declares names the table can't key one by one: the statement is @toplevel.
  if (decls.some((d) => d.childForFieldName('name')?.type !== 'identifier')) return null;
  const first = decls[0]!;
  const header = src.slice(wrapper.startIndex, first.startIndex);
  const sigHeader: [number, number] = [node.startIndex, first.startIndex];
  return {
    type: 'decls',
    decls: decls.map(
      (d, i): Decl => ({
        name: nameOf(d),
        kind: 'variable',
        start: i === 0 ? wrapper.startIndex : d.startIndex,
        end: i === decls.length - 1 ? wrapper.endIndex : decls[i + 1]!.startIndex,
        textPrefix: i === 0 ? '' : header,
        body: d.childForFieldName('value'),
        signature: valueSignature(node, [sigHeader], d),
      }),
    ),
  };
}

/** A declaration statement (unwrapped), with `wrapper` the outermost node whose range the item keeps. */
function declaration(node: Node, wrapper: Node, src: string): Classified | null {
  switch (node.type) {
    case 'ambient_declaration': {
      const inner = node.namedChildren.find((c) => !COMMENTS.has(c.type));
      return inner ? declaration(inner, wrapper, src) : null;
    }
    case 'expression_statement': {
      const named = node.namedChildren;
      return named.length === 1 && named[0]!.type === 'internal_module' ? declaration(named[0]!, wrapper, src) : null;
    }
    case 'function_declaration':
    case 'generator_function_declaration': {
      const body = node.childForFieldName('body');
      return single(wrapper, { name: nameOf(node), kind: 'function', body, signature: upTo(node, body) });
    }
    case 'function_signature':
      return single(wrapper, { name: nameOf(node), kind: 'function', body: null, signature: whole(node) });
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const body = node.childForFieldName('body');
      return single(wrapper, { name: nameOf(node), kind: 'class', body, members: body && { node: body, scope: 'class' }, signature: upTo(node, body) });
    }
    case 'interface_declaration':
      return single(wrapper, { name: nameOf(node), kind: 'interface', body: node.childForFieldName('body'), signature: whole(node) });
    case 'type_alias_declaration':
      return single(wrapper, { name: nameOf(node), kind: 'type', body: node.childForFieldName('value'), signature: whole(node) });
    case 'enum_declaration':
      return single(wrapper, { name: nameOf(node), kind: 'enum', body: node.childForFieldName('body'), signature: whole(node) });
    case 'internal_module':
    case 'module': {
      const body = node.childForFieldName('body');
      return single(wrapper, { name: nameOf(node), kind: 'namespace', body, members: body && { node: body, scope: 'namespace' }, signature: upTo(node, body) });
    }
    case 'lexical_declaration':
    case 'variable_declaration':
      return declarators(node, wrapper, src);
    default:
      return null;
  }
}

/** `export default <value>` of something anonymous: the key `default`. */
function defaultExport(value: Node, wrapper: Node): Classified {
  if (value.type === 'class') {
    const body = value.childForFieldName('body');
    return single(wrapper, { name: 'default', kind: 'class', body, members: body && { node: body, scope: 'class' }, signature: upTo(value, body) });
  }
  if (FUNCTION_VALUES.has(value.type)) {
    const body = value.childForFieldName('body');
    return single(wrapper, { name: 'default', kind: 'function', body, signature: upTo(value, body) });
  }
  return single(wrapper, { name: 'default', kind: 'variable', body: value, signature: null });
}

function classMember(node: Node): Classified {
  switch (node.type) {
    case 'comment':
    case 'html_comment':
      return COMMENT;
    case 'decorator':
      return DECORATOR;
    case 'method_definition': {
      const name = nameOf(node);
      const body = node.childForFieldName('body');
      return single(node, { name, kind: name === 'constructor' ? 'constructor' : 'method', body, signature: upTo(node, body) });
    }
    case 'method_signature':
    case 'abstract_method_signature':
      return single(node, { name: nameOf(node), kind: 'method', body: null, signature: whole(node) });
    case 'public_field_definition':
    case 'field_definition':
      return single(node, {
        name: node.type === 'field_definition' ? nameOf(node, 'property') : nameOf(node),
        kind: 'field',
        body: node.childForFieldName('value'),
        signature: valueSignature(node, [], node),
      });
    default:
      return OTHER;
  }
}

/** The TS/TSX/JS table for one of the three grammars. */
export function ecmascript(id: LanguageId): LanguageSpec {
  return {
    id,
    comments: COMMENTS,
    sigSkip: new Set(['decorator']),
    atoms: new Set(['string', 'template_string', 'regex']),
    binaryOps: new Set(['&']),
    terminators: new Set([';', 'empty_statement']),
    classify(node: Node, scope: string, src: string): Classified {
      if (COMMENTS.has(node.type)) return COMMENT;
      if (scope === 'class') return classMember(node);
      // `top` and `namespace` (a namespace body holds nested declarations).
      switch (node.type) {
        case 'import_statement':
        case 'import_alias':
          return IMPORT;
        case 'export_statement': {
          if (node.childForFieldName('source')) return IMPORT;
          const decl = node.childForFieldName('declaration');
          if (decl) return declaration(decl, node, src) ?? (decl.type === 'import_alias' ? IMPORT : OTHER);
          const value = node.childForFieldName('value');
          if (value && scope === 'top') return defaultExport(value, node);
          return OTHER;
        }
        default:
          return declaration(node, node, src) ?? OTHER;
      }
    },
  };
}

export const javascript: LanguageSpec = ecmascript('javascript');
