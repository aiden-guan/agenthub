// S3: the mapping soundness property (design §1.10 "The mapping invariant"):
// thousands of seeded random line insertions, deletions and replacements (and
// moves of lines and of whole declarations, and some character-level edits) on
// every outline fixture, each mapped with
// changedSymbols. For every symbol-level result, every offset where `before`
// and `after` differ must lie inside the span of a returned key (in `before` or
// in `after`) or inside a whitespace-only gap.
//
// "Where they differ" needs an alignment of the two texts, and a fixed one (a
// common prefix and suffix, say) can blame an unchanged declaration that the
// edit merely shifted. So the test checks the alignment-free form: blank out,
// on each side, the spans of the returned keys (a container key covers its
// members) and the whitespace-only gaps; what remains must be the same text on
// both sides. Then the unchanged remainder aligns with itself, and every other
// offset is claimed or gap whitespace. Whitespace counts inside a non-container
// item (a body's indentation is part of it); between items, and between a
// container's members, it is gap whitespace.
//
// Replay one case with SYMBOLS_PROPERTY_SEED=<seed> (printed on failure);
// SYMBOLS_PROPERTY_EDITS sets the number of edits per fixture.
import { describe, expect, it } from 'vitest';
import { isValidSymbolKey } from '@agenthub/contract';
import { changedSymbols, outline } from '../src/index.js';
import type { Item, LanguageId, Outline } from '../src/types.js';
import { fixture } from './helpers.js';

const EDITS = Number(process.env.SYMBOLS_PROPERTY_EDITS ?? 500);
const ONLY_SEED = process.env.SYMBOLS_PROPERTY_SEED === undefined ? null : Number(process.env.SYMBOLS_PROPERTY_SEED);

/** Kinds whose own text between members is a shell (whitespace there is gap whitespace). */
const CONTAINER_KINDS = new Set(['class', 'namespace', 'impl', 'trait', 'interface', 'enum']);

interface Case {
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

const CASES: Case[] = [
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
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
}

function int(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
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
function mutate(text: string, rng: () => number, snippets: string[], items: Item[] | null): string {
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

// ------------------------------------------------------------------ the invariant

const GAP = 0;
const OWN = 1;
const LEAF = 2;
const CLAIMED = 3;

function covered(key: string, claimed: readonly string[]): boolean {
  return claimed.some((k) => key === k || key.startsWith(`${k}.`));
}

/**
 * What the claim leaves of `src`: every character outside the returned keys'
 * spans, except whitespace in a gap (between top-level items, or between a
 * container's members). Positions kept are returned too, for the report.
 */
function residue(src: string, o: Outline, claimed: readonly string[]): { text: string; at: number[] } {
  const mark = new Uint8Array(src.length);
  const visit = (items: Item[]): void => {
    for (const item of items) {
      if (covered(item.key, claimed)) {
        mark.fill(CLAIMED, item.start, item.end);
        continue;
      }
      const container = item.members.length > 0 || CONTAINER_KINDS.has(item.kind);
      mark.fill(container ? OWN : LEAF, item.start, item.end);
      visit(item.members);
    }
  };
  visit(o.items);
  let text = '';
  const at: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const m = mark[i]!;
    if (m === CLAIMED) continue;
    if (m === LEAF || !/\s/.test(src[i]!)) {
      text += src[i];
      at.push(i);
    }
  }
  return { text, at };
}

function allKeys(items: Item[]): string[] {
  return items.flatMap((i) => [i.key, ...allKeys(i.members)]);
}

function report(c: Case, seed: number, before: string, after: string, claimed: string[], rb: { text: string; at: number[] }, ra: { text: string; at: number[] }): string {
  let k = 0;
  while (k < rb.text.length && k < ra.text.length && rb.text[k] === ra.text[k]) k++;
  const ob = rb.at[k] ?? before.length;
  const oa = ra.at[k] ?? after.length;
  return [
    `mapping invariant broken for ${c.file}, seed ${seed} (replay: SYMBOLS_PROPERTY_SEED=${seed})`,
    `claimed: ${JSON.stringify(claimed)}`,
    `unclaimed text differs at before offset ${ob} / after offset ${oa}:`,
    `before: ${JSON.stringify(before.slice(Math.max(0, ob - 60), ob + 60))}`,
    `after:  ${JSON.stringify(after.slice(Math.max(0, oa - 60), oa + 60))}`,
  ].join('\n');
}

describe.each(CASES)('the mapping invariant on $file', (c) => {
  const source = fixture(c.file);
  const base = c.file.split('').reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

  it(`holds for ${EDITS} seeded random edits`, async () => {
    const baseOutline = await outline(source, c.lang);
    const seeds = ONLY_SEED !== null ? [ONLY_SEED] : Array.from({ length: EDITS }, (_, i) => (base + i) >>> 0);
    let symbolLevel = 0;
    const reasons: Record<string, number> = {};
    for (const seed of seeds) {
      const rng = prng(seed);
      // Mostly the fixture itself; sometimes an already edited (perhaps broken) version of it.
      let before = source;
      if (rng() < 0.3) for (let n = int(rng, 1, 3); n > 0; n--) before = mutate(before, rng, c.snippets, before === source ? baseOutline.items : null);
      const ob = before === source ? baseOutline : await outline(before, c.lang);
      const after = mutate(before, rng, c.snippets, ob.items);
      const d = await changedSymbols(c.path, before, after, { maxSymbols: Number.POSITIVE_INFINITY });
      if (d.fileLevel) {
        // Only an uncontained parse error may give up on symbols here.
        expect(d.reason, `seed ${seed}`).toBe('parse_error');
        reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
        continue;
      }
      symbolLevel++;
      const oa = await outline(after, c.lang);
      // @toplevel may be claimed for a whitespace-only change even where neither side has a @toplevel item.
      const known = new Set([...allKeys(ob.items), ...allKeys(oa.items), '@toplevel']);
      for (const key of d.symbols) {
        expect(isValidSymbolKey(key), `seed ${seed}: ${key} is a valid key`).toBe(true);
        expect(known.has(key), `seed ${seed}: ${key} is a key of before or after`).toBe(true);
      }
      if (before !== after) expect(d.symbols.length, `seed ${seed}: a change claims something`).toBeGreaterThan(0);
      const rb = residue(before, ob, d.symbols);
      const ra = residue(after, oa, d.symbols);
      if (rb.text !== ra.text) expect.fail(report(c, seed, before, after, d.symbols, rb, ra));
    }
    // The property must not hold vacuously: many edits map below file level.
    if (process.env.SYMBOLS_PROPERTY_STATS) console.log(`${c.file}: ${symbolLevel} of ${seeds.length} symbol level; file level ${JSON.stringify(reasons)}`);
    if (ONLY_SEED === null) expect(symbolLevel, `symbol-level results (file level: ${JSON.stringify(reasons)})`).toBeGreaterThan(seeds.length * 0.3);
  }, 120_000);
});
