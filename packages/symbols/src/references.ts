// References (design §2.5): which items of a file use a name, for the impact
// warnings' `relevant()` check, `who_uses` and `callers_free`.
//
// - A reference is an identifier token: `identifier`, `property_identifier`,
//   `type_identifier`, `field_identifier`, the shorthand property and field
//   names, and (since tree-sitter-python's `attribute` names are identifiers)
//   Python attribute names. Never comments or strings: those are other nodes.
//   Code inside a string (a template substitution, an f-string
//   interpolation) is code, and counts. So do JSX tag and attribute names,
//   and the arguments of Rust macro calls.
// - Each one is attributed to the innermost item it occurs in: a member
//   (`Session.refresh`), a container's own text (`Session`), a top-level
//   declaration, `@imports` or `@toplevel`.
// - A declaration's own name is not a use of it: in each item, the first
//   identifier spelled like the last segment of its key, before its body, is
//   its name and is skipped. A recursive call is a use.
// - null means the file can't be read at symbol level: an unsupported
//   language, an unverified grammar, a binary file or one over 1 MiB (and, for
//   freeKeys, an uncontained parse error). A file with a parse error still
//   has its identifiers, so referencesIn and identifierIndex answer for it
//   (names are advisory).
//
// referencesIn looks for each name in the text first and asks the tree only
// about the places it occurs, so a file that never spells the name is not
// parsed at all. identifierIndex runs one tree-sitter query over the whole
// tree. Both use the runtime's document cache (document.ts).

import { entriesOverlap, IMPORTS, TOPLEVEL } from '@agenthub/contract';
import { Query, type Language, type Node } from 'web-tree-sitter';
import { binary, tooLarge } from './diff.js';
import { docCache, docFor, type Doc } from './document.js';
import { SymbolsError } from './errors.js';
import { languageFor } from './languages/index.js';
import { grammarFor } from './outline.js';
import type { Grammar, GrammarRuntime } from './runtime.js';
import type { Item, LanguageId } from './types.js';

/** The identifier node types per language (those a grammar lacks are left out). */
const IDENTIFIER_TYPES: Readonly<Record<LanguageId, readonly string[]>> = {
  typescript: ['identifier', 'property_identifier', 'type_identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'],
  tsx: ['identifier', 'property_identifier', 'type_identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'],
  javascript: ['identifier', 'property_identifier', 'type_identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'],
  python: ['identifier'],
  go: ['identifier', 'field_identifier', 'type_identifier'],
  rust: ['identifier', 'field_identifier', 'type_identifier', 'shorthand_field_identifier'],
  java: ['identifier', 'type_identifier'],
};

/** The import statements per language, as query patterns capturing `@import` (and `@callee` for a call that must be `require`). */
const IMPORT_PATTERNS: Readonly<Record<LanguageId, readonly string[]>> = {
  typescript: ['(import_statement) @import', '(export_statement source: (_)) @import', '(call_expression function: (import)) @import', '(call_expression function: (identifier) @callee) @import'],
  tsx: ['(import_statement) @import', '(export_statement source: (_)) @import', '(call_expression function: (import)) @import', '(call_expression function: (identifier) @callee) @import'],
  javascript: ['(import_statement) @import', '(export_statement source: (_)) @import', '(call_expression function: (import)) @import', '(call_expression function: (identifier) @callee) @import'],
  python: ['(import_statement) @import', '(import_from_statement) @import', '(future_import_statement) @import'],
  go: ['(import_declaration) @import'],
  rust: ['(use_declaration) @import', '(extern_crate_declaration) @import', '(mod_item !body) @import'],
  java: ['(import_declaration) @import'],
};

interface Queries {
  identifierTypes: ReadonlySet<string>;
  identifiers: Query;
  imports: Query;
}

const queries = new WeakMap<Language, Queries>();

function queriesFor(grammar: Grammar): Queries {
  const language = grammar.parser.language!;
  let q = queries.get(language);
  if (!q) {
    const types = IDENTIFIER_TYPES[grammar.language].filter((t) => language.idForNodeType(t, true) !== null);
    q = {
      identifierTypes: new Set(types),
      identifiers: new Query(language, `[${types.map((t) => `(${t})`).join(' ')}] @id`),
      imports: new Query(language, IMPORT_PATTERNS[grammar.language].join('\n')),
    };
    queries.set(language, q);
  }
  return q;
}

/** The language and verified grammar for `path` and `source`, or null when the file can't be read at symbol level. */
async function prepare(runtime: GrammarRuntime, path: string, source: string): Promise<Grammar | null> {
  const language = languageFor(path);
  if (language === null || tooLarge(source) || binary(source)) return null;
  try {
    return await grammarFor(runtime, language);
  } catch (err) {
    if (err instanceof SymbolsError) return null;
    throw err;
  }
}

/** Run `use` on the document of `source` (cached or parsed), then cache it. Synchronous. */
function withDoc<T>(runtime: GrammarRuntime, grammar: Grammar, source: string, use: (doc: Doc) => T): T {
  const cache = docCache(runtime);
  const doc = docFor(cache, grammar, source);
  try {
    return use(doc);
  } finally {
    cache.add(doc);
  }
}

// ------------------------------------------------------------------ attribution

/** The innermost item of `items` (sorted, not overlapping, members nested) whose span holds `offset`, or null. */
function itemAt(items: Item[], offset: number): Item | null {
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = items[mid]!;
    if (offset < item.start) hi = mid - 1;
    else if (offset >= item.end) lo = mid + 1;
    else return itemAt(item.members, offset) ?? item;
  }
  return null;
}

function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf('.') + 1);
}

/**
 * Attributes identifiers, visited in source order, to their items' keys:
 * returns the key, or null for a declaration's own name (the first
 * identifier spelled like its key's last segment, before its body).
 */
function attributor(doc: Doc): (name: string, offset: number) => string | null {
  const named = new Set<Item>();
  return (name, offset) => {
    const item = itemAt(doc.outline.items, offset);
    if (!item) return null; // gaps are whitespace: not reached
    if (item.key === IMPORTS || item.key === TOPLEVEL || named.has(item)) return item.key;
    const bodyStart = doc.details.get(item)?.body?.[0] ?? item.end;
    if (offset < bodyStart && name === lastSegment(item.key)) {
      named.add(item);
      return null;
    }
    return item.key;
  };
}

function addKey(keys: string[], key: string): void {
  if (!keys.includes(key)) keys.push(key);
}

// ------------------------------------------------------------------ the four lookups

/** For each name `source` uses as an identifier, the keys of the items it occurs in (names it doesn't use are absent). null = unsupported. */
export async function referencesInWith(runtime: GrammarRuntime, path: string, source: string, names: string[]): Promise<Map<string, string[]> | null> {
  const grammar = await prepare(runtime, path, source);
  if (!grammar) return null;
  const wanted = [...new Set(names)].filter((n) => n !== '' && source.includes(n));
  if (wanted.length === 0) return new Map();
  return withDoc(runtime, grammar, source, (doc) => {
    const { identifierTypes } = queriesFor(grammar);
    const root = doc.tree.rootNode;
    const out = new Map<string, string[]>();
    for (const name of wanted) {
      const attribute = attributor(doc);
      const keys: string[] = [];
      for (let at = source.indexOf(name); at !== -1; at = source.indexOf(name, at + 1)) {
        const node = root.descendantForIndex(at, at + name.length);
        if (!node || node.startIndex !== at || node.endIndex !== at + name.length || !identifierTypes.has(node.type)) continue;
        const key = attribute(name, at);
        if (key !== null) addKey(keys, key);
      }
      if (keys.length > 0) out.set(name, keys);
    }
    return out;
  });
}

/** Every identifier `source` uses → the keys of the items it occurs in, in order of first use (a null-prototype object). null = unsupported. */
export async function identifierIndexWith(runtime: GrammarRuntime, path: string, source: string): Promise<Record<string, string[]> | null> {
  const grammar = await prepare(runtime, path, source);
  if (!grammar) return null;
  return withDoc(runtime, grammar, source, (doc) => {
    const attribute = attributor(doc);
    const index = Object.create(null) as Record<string, string[]>;
    for (const { node } of queriesFor(grammar).identifiers.captures(doc.tree.rootNode)) {
      const start = node.startIndex;
      const name = source.slice(start, node.endIndex);
      const key = attribute(name, start);
      if (key === null) continue;
      const keys = index[name];
      if (keys) addKey(keys, key);
      else index[name] = [key];
    }
    return index;
  });
}

/** The top-level keys of `source`, once each in source order, that no entry of `held` (entries of this file) overlaps. null = unsupported or not mappable. */
export async function freeKeysWith(runtime: GrammarRuntime, path: string, source: string, held: Array<{ symbol?: string }>): Promise<string[] | null> {
  const grammar = await prepare(runtime, path, source);
  if (!grammar) return null;
  return withDoc(runtime, grammar, source, (doc) => {
    if (doc.outline.errors === 'uncontained') return null;
    const keys = [...new Set(doc.outline.items.map((i) => i.key))];
    const entries = held.map((h) => (h.symbol === undefined ? { file: path } : { file: path, symbol: h.symbol }));
    return keys.filter((key) => !entries.some((e) => entriesOverlap(e, { file: path, symbol: key })));
  });
}

/**
 * The import statements of `source` that name a module, anywhere in the file
 * (a Python import inside a function, a dynamic `import()` or `require()`),
 * one per line in source order, comments removed and whitespace collapsed;
 * '' when there are none. null = unsupported.
 */
export async function importsTextWith(runtime: GrammarRuntime, path: string, source: string): Promise<string | null> {
  const grammar = await prepare(runtime, path, source);
  if (!grammar) return null;
  return withDoc(runtime, grammar, source, (doc) => {
    const found = new Map<number, Node>();
    for (const match of queriesFor(grammar).imports.matches(doc.tree.rootNode)) {
      const node = match.captures.find((c) => c.name === 'import')?.node;
      const callee = match.captures.find((c) => c.name === 'callee')?.node;
      if (!node || (callee && callee.text !== 'require')) continue;
      found.set(node.startIndex, node);
    }
    return [...found.values()]
      .sort((x, y) => x.startIndex - y.startIndex)
      .map((node) => withoutComments(source, node, doc.spec.comments))
      .join('\n');
  });
}

/** The text of `node` with its comments cut out and whitespace collapsed. */
function withoutComments(source: string, node: Node, comments: ReadonlySet<string>): string {
  let text = '';
  let pos = node.startIndex;
  for (const c of node.descendantsOfType([...comments])) {
    if (!c || c.startIndex < pos) continue;
    text += `${source.slice(pos, c.startIndex)} `;
    pos = c.endIndex;
  }
  text += source.slice(pos, node.endIndex);
  return text.replace(/\s+/g, ' ').trim();
}
