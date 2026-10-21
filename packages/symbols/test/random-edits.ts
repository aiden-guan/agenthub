// Seeded random edits for the property tests (mapping-property.test.ts,
// incremental.test.ts): lines inserted, deleted, replaced or moved (from the
// fixture itself or per-language snippets), whole declarations moved, and a
// few characters changed. No dependencies: the PRNG is splitmix32.
import type { Item, LanguageId } from '../src/types.js';

export interface Case {
  file: string;
  path: string;
  lang: LanguageId;
  /** Lines the generator inserts besides the fixture's own: declarations, comments, imports, stray tokens. */
  snippets: string[];
}

const ECMA = [
  'function added() { return 1; }',
  'export function login(user) { return user; }',
  'const added = 2;',
  "import { z } from 'z';",
  '  extra() {}',
  'class Added {}',
  '// a new comment',
  '/** a doc comment */',
  '@decorated',
  '',
  '}',
  '{',
];

export const CASES: Case[] = [
  { file: 'outline/sample.ts', path: 'src/sample.ts', lang: 'typescript', snippets: [...ECMA, '  extra(): void;', 'type Added = string;', 'interface Added { a: string }'] },
  { file: 'outline/sample.tsx', path: 'src/sample.tsx', lang: 'tsx', snippets: [...ECMA, '  return <div>{added}</div>;', 'const Added = () => <span />;'] },
  { file: 'outline/sample.js', path: 'src/sample.js', lang: 'javascript', snippets: [...ECMA, "module.exports = { added };", '  #priv = 1;'] },
  {
    file: 'outline/sample.py',
    path: 'pkg/sample.py',
    lang: 'python',
    snippets: ['def added():', '    return 1', '    def method(self):', '        pass', 'ADDED = 2', 'import zz', '# a new comment', '@decorated', 'class Added:', '    x: int = 1', '', '    """doc"""'],
  },
  {
    file: 'outline/sample.go',
    path: 'pkg/sample.go',
    lang: 'go',
    snippets: ['func Added() {}', 'func (s *Session) Added() {}', 'var Added = 2', 'import "zz"', '// a new comment', 'type Added struct{}', '\tx int', '}', '{', ''],
  },
  {
    file: 'outline/sample.rs',
    path: 'src/sample.rs',
    lang: 'rust',
    snippets: ['fn added() {}', '    fn method(&self) {}', 'const ADDED: u8 = 2;', 'use zz;', '// a new comment', '#[inline]', 'impl Session { fn added(&self) {} }', 'struct Added;', '}', '{', ''],
  },
  {
    file: 'outline/Sample.java',
    path: 'src/Sample.java',
    lang: 'java',
    snippets: ['    void added() {}', '    int added = 2;', 'import zz.Z;', '// a new comment', '    @Override', 'class Added {}', '    static class Nested {}', '}', '{', ''],
  },
];

// ------------------------------------------------------------------ a seeded generator (no dependencies)

/** splitmix32: a small, well-mixed 32-bit PRNG. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
}

export function int(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

const CHARS = ['{', '}', '(', ')', ';', ':', ',', ' ', '\n', 'x', '"', "'", '#', '/', '*', '=', '\t', '.', '<', '>'];

/** The span of `item` widened to whole lines when only whitespace shares them (its line break included). */
function lineSpan(text: string, item: Item): [number, number] {
  const ls = text.lastIndexOf('\n', item.start - 1) + 1;
  const start = text.slice(ls, item.start).trim() === '' ? ls : item.start;
  const nl = text.indexOf('\n', item.end);
  const le = nl === -1 ? text.length : nl + 1;
  const end = text.slice(item.end, le).trim() === '' ? le : item.end;
  return [start, end];
}

/** A declaration (top-level or a member, from `items`) cut out and pasted before another one, or at the end. */
function moveItem(text: string, rng: () => number, items: Item[]): string {
  const all: Item[] = [];
  const walk = (xs: Item[]): void => {
    for (const x of xs) {
      all.push(x);
      walk(x.members);
    }
  };
  walk(items);
  if (all.length < 2) return text;
  const [s, e] = lineSpan(text, pick(rng, all));
  const targets = [...all.map((x) => lineSpan(text, x)[0]).filter((t) => t <= s || t >= e), text.length];
  const t = pick(rng, targets);
  const block = text.slice(s, e);
  if (t <= s) return text.slice(0, t) + block + text.slice(t, s) + text.slice(e);
  return text.slice(0, s) + text.slice(e, t) + block + text.slice(t);
}

/**
 * One random edit of `text`: lines inserted, deleted or replaced (from the
 * fixture itself or the snippets), a run of lines or a whole declaration of
 * `items` (the outline of `text`, when known) moved, or a few characters.
 */
export function mutate(text: string, rng: () => number, snippets: string[], items: Item[] | null): string {
  const lines = text.split('\n');
  const poolLine = (): string => (rng() < 0.6 ? pick(rng, lines) : pick(rng, snippets));
  const block = (n: number): string[] => {
    // Sometimes a run of consecutive lines from the file (a whole declaration moves or is duplicated).
    if (rng() < 0.4) {
      const at = int(rng, 0, lines.length - 1);
      return lines.slice(at, at + n);
    }
    return Array.from({ length: n }, poolLine);
  };
  const op = rng();
  if (op < 0.25) {
    const at = int(rng, 0, lines.length);
    lines.splice(at, 0, ...block(int(rng, 1, 4)));
  } else if (op < 0.45) {
    const at = int(rng, 0, lines.length - 1);
    lines.splice(at, int(rng, 1, 4));
  } else if (op < 0.7) {
    const at = int(rng, 0, lines.length - 1);
    lines.splice(at, int(rng, 1, 3), ...block(int(rng, 1, 3)));
  } else if (op < 0.9) {
    if (items && rng() < 0.75) return moveItem(text, rng, items);
    const at = int(rng, 0, lines.length - 1);
    const cut = lines.splice(at, int(rng, 1, 6));
    lines.splice(int(rng, 0, lines.length), 0, ...cut);
  } else {
    let at = int(rng, 0, text.length);
    // Never split a surrogate pair.
    if (at > 0 && at < text.length && /[\udc00-\udfff]/.test(text[at]!)) at -= 1;
    const del = rng() < 0.5 ? int(rng, 0, 3) : 0;
    let end = Math.min(text.length, at + del);
    if (end < text.length && /[\udc00-\udfff]/.test(text[end]!)) end += 1;
    const ins = Array.from({ length: int(rng, del === 0 ? 1 : 0, 3) }, () => pick(rng, CHARS)).join('');
    return text.slice(0, at) + ins + text.slice(end);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ edits that mostly keep the syntax valid

/** Whole declarations per language: at top level, and as a member of a container (indented to fit). */
const DECLARATIONS: Record<LanguageId, { top: string[]; member: string[] }> = {
  typescript: { top: ['function added(): number { return 1; }', 'const added = 2;', 'class Added { m(): number { return 1; } }', '// a new comment'], member: ['added(): number { return 1; }', 'extra = 3;'] },
  tsx: { top: ['function added() { return <b>{1}</b>; }', 'const added = 2;', 'class Added { m() { return 1; } }', '// a new comment'], member: ['added() { return 1; }'] },
  javascript: { top: ['function added() { return 1; }', 'const added = 2;', 'class Added { m() { return 1; } }', '// a new comment'], member: ['added() { return 1; }'] },
  python: { top: ['def added():\n    return 1', 'ADDED = 2', 'class Added:\n    def m(self):\n        return 1', '# a new comment'], member: ['def added(self):\n    return 1', 'extra = 3'] },
  go: { top: ['func Added() int { return 1 }', 'var Added = 2', 'type Added struct{}', '// a new comment'], member: [] },
  rust: { top: ['fn added() -> u8 { 1 }', 'const ADDED: u8 = 2;', 'struct Added;', '// a new comment'], member: ['fn added(&self) -> u8 { 1 }'] },
  java: { top: ['class Added { int m() { return 1; } }', '// a new comment'], member: ['int added() { return 1; }', 'int extra = 3;'] },
};

function allItems(items: Item[], depth = 0, out: Array<{ item: Item; depth: number }> = []): Array<{ item: Item; depth: number }> {
  for (const item of items) {
    out.push({ item, depth });
    allItems(item.members, depth + 1, out);
  }
  return out;
}

/**
 * One edit that usually leaves a valid file: a declaration (top-level or a
 * member) moved, deleted, duplicated next to itself, or a new one inserted
 * before it; or one letter of a declaration changed. `items` is the outline
 * of `text`.
 */
export function declarationEdit(text: string, rng: () => number, lang: LanguageId, items: Item[]): string {
  const all = allItems(items).filter(({ item }) => item.key !== '@imports');
  if (all.length === 0) return `${text}\n${pick(rng, DECLARATIONS[lang].top)}\n`;
  const { item, depth } = pick(rng, all);
  const [s, e] = lineSpan(text, item);
  const op = rng();
  if (op < 0.2) return moveItem(text, rng, items);
  if (op < 0.35) return text.slice(0, s) + text.slice(e);
  if (op < 0.5) return text.slice(0, e) + text.slice(s, e) + text.slice(e);
  if (op < 0.75) {
    const pool = depth === 0 ? DECLARATIONS[lang].top : DECLARATIONS[lang].member;
    if (pool.length === 0) return text;
    const indent = /^[ \t]*/.exec(text.slice(s))![0];
    const decl = pick(rng, pool)
      .split('\n')
      .map((l) => indent + l)
      .join('\n');
    return `${text.slice(0, s)}${decl}\n${rng() < 0.5 ? '\n' : ''}${text.slice(s)}`;
  }
  // A letter of the declaration changed (perhaps in its name).
  const letters: number[] = [];
  for (let i = item.start; i < item.end; i++) if (/[a-z]/.test(text[i]!)) letters.push(i);
  if (letters.length === 0) return text;
  const at = pick(rng, letters);
  const ch = String.fromCharCode(97 + ((text.charCodeAt(at) - 97 + int(rng, 1, 25)) % 26));
  return text.slice(0, at) + ch + text.slice(at + 1);
}
