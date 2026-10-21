// S4: documents (src/document.ts): incremental reparsing gives exactly the
// tree and the outline a fresh parse gives, lazy signatures are the eager
// ones, the edit between two texts is computed right (surrogate pairs, line
// breaks), and the document cache stays bounded and deletes what it evicts.
//
// The property part reuses the mapping test's seeded random edits on every
// fixture. Replay a case with SYMBOLS_PROPERTY_SEED=<seed>;
// SYMBOLS_INCREMENTAL_EDITS sets the number of edits per fixture.
import { describe, expect, it, vi } from 'vitest';
import { DocCache, docCache, editBetween, parseDoc, release, type Doc } from '../src/document.js';
import { changedSymbolsWith } from '../src/diff.js';
import { outline } from '../src/index.js';
import { grammarFor } from '../src/outline.js';
import { defaultRuntime, GrammarRuntime, type Grammar } from '../src/runtime.js';
import { signatureOf } from '../src/signatures.js';
import type { Item, LanguageId, Outline } from '../src/types.js';
import { fixture } from './helpers.js';
import { CASES, declarationEdit, int, mutate, prng } from './random-edits.js';

const EDITS = Number(process.env.SYMBOLS_INCREMENTAL_EDITS ?? 300);
const ONLY_SEED = process.env.SYMBOLS_PROPERTY_SEED === undefined ? null : Number(process.env.SYMBOLS_PROPERTY_SEED);

/** The document's outline with every signature filled in, as `outline()` returns it. */
function signed(doc: Doc): Outline {
  const fill = (items: Item[]): Item[] => items.map((i) => ({ ...i, signature: signatureOf(doc, i), members: fill(i.members) }));
  return { ...doc.outline, items: fill(doc.outline.items) };
}

async function grammar(lang: LanguageId): Promise<Grammar> {
  return grammarFor(defaultRuntime, lang);
}

describe.each(CASES)('incremental reparsing on $file', (c) => {
  const source = fixture(c.file);
  const base = c.file.split('').reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 11);

  it(`gives the tree and the outline of a fresh parse, along chains of seeded random edits (${EDITS} in all)`, async () => {
    const g = await grammar(c.lang);
    const baseOutline = await outline(source, c.lang);
    const seeds = ONLY_SEED !== null ? [ONLY_SEED] : Array.from({ length: Math.ceil(EDITS / 3) }, (_, i) => (base + i) >>> 0);
    let steps = 0;
    let clean = 0;
    let carried = 0;
    for (const seed of seeds) {
      const rng = prng(seed);
      let text = source;
      if (rng() < 0.3) text = mutate(text, rng, c.snippets, baseOutline.items);
      // A chain: each document is parsed from the one before (whose items were perhaps carried over in turn).
      let doc = parseDoc(g, text);
      const docs = [doc];
      try {
        for (let n = int(rng, 1, 5); n > 0; n--) {
          const before = doc.src;
          const items = (await outline(before, c.lang)).items;
          // Mostly edits that keep the file valid, so chains of carried-over items get long; sometimes anything.
          const after = rng() < 0.75 ? declarationEdit(before, rng, c.lang, items) : mutate(before, rng, c.snippets, items);
          const next = parseDoc(g, after, doc);
          docs.push(next);
          const fresh = parseDoc(g, after);
          docs.push(fresh);
          steps++;
          if (!next.tree.rootNode.hasError) clean++;
          for (const detail of next.details.values()) if ('sigAt' in detail) carried++;
          expect(next.tree.rootNode.toString(), `seed ${seed}, step ${docs.length / 2}: the tree`).toBe(fresh.tree.rootNode.toString());
          expect(signed(next), `seed ${seed}, step ${docs.length / 2}: the outline`).toEqual(await outline(after, c.lang));
          // The base document is untouched by the edit of its tree's copy.
          expect(signed(doc), `seed ${seed}: the base document`).toEqual(await outline(before, c.lang));
          doc = next;
        }
      } finally {
        for (const d of docs) release(d);
      }
    }
    // Not vacuous: many steps leave a file that parses without errors, so the incremental tree and the items carried over are the ones compared.
    if (process.env.SYMBOLS_PROPERTY_STATS) console.log(`${c.file}: ${steps} steps, ${clean} without errors, ${carried} items carried over`);
    if (ONLY_SEED === null) {
      expect(clean).toBeGreaterThan(steps * 0.25);
      // tree-sitter-python's indentation scanner rarely lets a top-level subtree be reused, so Python files carry little over.
      if (c.lang !== 'python') expect(carried).toBeGreaterThan(clean);
    }
  }, 300_000);
});

describe('lazy signatures', () => {
  it('are the eager ones, and are computed once', async () => {
    const g = await grammar('typescript');
    const src = fixture('outline/sample.ts');
    const doc = parseDoc(g, src);
    try {
      for (const item of doc.outline.items) expect(item.signature).toBeNull();
      expect(signed(doc)).toEqual(await outline(src, 'typescript'));
      const first = doc.outline.items.find((i) => i.kind === 'function')!;
      expect(signatureOf(doc, first)).toBe(signatureOf(doc, first));
      expect(doc.signatures.has(first)).toBe(true);
    } finally {
      release(doc);
    }
  });
});

describe('editBetween', () => {
  it('keeps the common prefix and suffix, with rows and UTF-16 columns', () => {
    const e = editBetween('ab\ncd\nef', 'ab\ncXd\nef');
    expect({ ...e }).toEqual({
      startIndex: 4,
      oldEndIndex: 4,
      newEndIndex: 5,
      startPosition: { row: 1, column: 1 },
      oldEndPosition: { row: 1, column: 1 },
      newEndPosition: { row: 1, column: 2 },
    });
    const del = editBetween('a\nb\nc\nd', 'a\nd');
    expect({ ...del }).toMatchObject({ startIndex: 2, oldEndIndex: 6, newEndIndex: 2, oldEndPosition: { row: 3, column: 0 }, newEndPosition: { row: 1, column: 0 } });
  });

  it('never splits a surrogate pair', () => {
    // 😀 and 😁 share their high surrogate; the edit must start before it.
    const e = editBetween('x😀y', 'x😁y');
    expect([e.startIndex, e.oldEndIndex, e.newEndIndex]).toEqual([1, 3, 3]);
    // ...and their low surrogates differ, so the suffix can't split one either.
    const f = editBetween('a😀', 'b😀');
    expect([f.startIndex, f.oldEndIndex, f.newEndIndex]).toEqual([0, 1, 1]);
    const g = editBetween('😀z', '🨀z');
    expect([g.startIndex, g.oldEndIndex, g.newEndIndex]).toEqual([0, 2, 2]);
  });

  it('handles identical texts, and an edit at either end', () => {
    expect([editBetween('abc', 'abc').startIndex, editBetween('abc', 'abc').oldEndIndex]).toEqual([3, 3]);
    expect([editBetween('abc', 'xabc').startIndex, editBetween('abc', 'xabc').newEndIndex]).toEqual([0, 1]);
    expect([editBetween('abc', 'abcx').startIndex, editBetween('abc', 'abcx').newEndIndex]).toEqual([3, 4]);
    expect({ ...editBetween('', 'a\nb') }).toMatchObject({ startIndex: 0, oldEndIndex: 0, newEndIndex: 3, newEndPosition: { row: 1, column: 1 } });
  });
});

const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('the document cache', () => {
  const docs = async (n: number, size = 10): Promise<{ g: Grammar; list: Doc[] }> => {
    const g = await grammar('typescript');
    return { g, list: Array.from({ length: n }, (_, i) => parseDoc(g, `export const v${i} = ${'1'.repeat(size)};\n`)) };
  };

  it('keeps the most recently used documents, up to its count, and deletes the trees it evicts', async () => {
    const { g, list } = await docs(4);
    const deleted = list.map((d) => vi.spyOn(d.tree, 'delete'));
    const cache = new DocCache(3, 1_000_000);
    for (const d of list) cache.add(d);
    expect(cache.size).toBe(3);
    expect(cache.get('typescript', list[0]!.src)).toBeNull();
    // Deleted once the current task is done.
    expect(deleted.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
    await nextTask();
    expect(deleted.map((spy) => spy.mock.calls.length)).toEqual([1, 0, 0, 0]);
    expect(cache.get('typescript', list[1]!.src)).toBe(list[1]);
    // Using a document makes it the most recently used: adding a new one evicts list[2], not list[1].
    cache.add(list[1]!);
    const extra = parseDoc(g, 'export const z = 1;\n');
    cache.add(extra);
    expect(cache.get('typescript', list[1]!.src)).toBe(list[1]);
    expect(cache.get('typescript', list[2]!.src)).toBeNull();
    await nextTask();
    expect(deleted.map((spy) => spy.mock.calls.length)).toEqual([1, 0, 1, 0]);
    expect(cache.get('javascript', list[1]!.src)).toBeNull();
    cache.clear();
    expect(cache.size).toBe(0);
    await nextTask();
    expect(deleted.map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it('a loop that never yields still frees evicted trees: at most 8 wait', async () => {
    const { list } = await docs(20);
    const deleted = list.map((d) => vi.spyOn(d.tree, 'delete'));
    const cache = new DocCache(1, 1_000_000);
    for (const d of list) cache.add(d);
    // 19 evicted: 11 deleted at once, 8 waiting.
    expect(deleted.filter((spy) => spy.mock.calls.length === 1)).toHaveLength(11);
    await nextTask();
    expect(deleted.filter((spy) => spy.mock.calls.length === 1)).toHaveLength(19);
    cache.clear();
    await nextTask();
  });

  it('is bounded by total size too, and never evicts the document just added', async () => {
    const { list } = await docs(3, 400);
    const cache = new DocCache(10, 900);
    cache.add(list[0]!);
    cache.add(list[1]!);
    expect(cache.size).toBe(2);
    cache.add(list[2]!);
    expect(cache.size).toBe(2);
    expect(cache.get('typescript', list[0]!.src)).toBeNull();
    const big = (await docs(1, 2000)).list[0]!;
    cache.add(big);
    expect(cache.size).toBe(1);
    expect(cache.get('typescript', big.src)).toBe(big);
    cache.clear();
  });

  it('a second parse of a cached text replaces the first', async () => {
    const { g } = await docs(0);
    const cache = new DocCache();
    const a = parseDoc(g, 'export const q = 1;\n');
    const b = parseDoc(g, 'export const q = 1;\n');
    cache.add(a);
    cache.add(b);
    expect(cache.size).toBe(1);
    expect(cache.get('typescript', a.src)).toBe(b);
    cache.clear();
  });

  it('changedSymbols caches both sides, and maps the same whether a side was cached or not', async () => {
    const rt = new GrammarRuntime();
    const src = fixture('outline/sample.ts');
    const edited = src.replace(/return/, 'return  ');
    const cold = await changedSymbolsWith(rt, 'a.ts', src, edited);
    const cache = docCache(rt);
    expect(cache.get('typescript', src)).not.toBeNull();
    expect(cache.get('typescript', edited)).not.toBeNull();
    expect(await changedSymbolsWith(rt, 'a.ts', src, edited)).toEqual(cold);
    // Only `after` cached: `before` is parsed from it.
    cache.clear();
    await changedSymbolsWith(rt, 'a.ts', edited, `${edited}\n`);
    expect(cache.get('typescript', src)).toBeNull();
    expect(await changedSymbolsWith(rt, 'a.ts', src, edited)).toEqual(cold);
    cache.clear();
  });
});
