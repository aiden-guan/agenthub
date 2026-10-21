// S1: the parse-error classification (design §1.10 "Parse errors", §0.3 #32): an
// error counts as contained only when it lies inside the body of a named
// declaration, and then that declaration's key is recorded.
import { describe, expect, it } from 'vitest';
import { outline } from '../src/index.js';
import type { LanguageId } from '../src/types.js';
import { expectWellFormed, keys } from './helpers.js';

// The three shapes verified for the design (§0, "Where tree-sitter puts errors").
const BODY_ERROR = 'function a() {\n  return 1 +;\n}\n\nfunction b() {\n  return 2;\n}\n';
const UNCLOSED_BRACE = 'function a() {\n  if (x) {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
const BROKEN_HEADER = 'function a( {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';

const LANGS: LanguageId[] = ['typescript', 'tsx', 'javascript'];

describe.each(LANGS)('%s', (lang) => {
  it('a syntax error inside a function body is contained in that function, and the next one is intact', async () => {
    const o = await outline(BODY_ERROR, lang);
    expect(o.errors).toBe('contained');
    expect(o.errorKeys).toEqual(['a']);
    expect(keys(o.items)).toEqual(['a', 'b']);
    expectWellFormed(BODY_ERROR, o);
  });

  it('an unclosed brace is uncontained (the file becomes one statement)', async () => {
    const o = await outline(UNCLOSED_BRACE, lang);
    expect(o.errors).toBe('uncontained');
    expect(keys(o.items)).toEqual(['@toplevel']);
    expectWellFormed(UNCLOSED_BRACE, o);
  });

  it('a broken function header is uncontained (a top-level ERROR)', async () => {
    const o = await outline(BROKEN_HEADER, lang);
    expect(o.errors).toBe('uncontained');
    expect(keys(o.items)[0]).toBe('@toplevel');
    expectWellFormed(BROKEN_HEADER, o);
  });

  it('a clean file has no errors', async () => {
    const o = await outline('function a() {}\n', lang);
    expect(o.errors).toBe('none');
    expect(o.errorKeys).toEqual([]);
  });
});

describe('typescript, more shapes', () => {
  it('records the innermost declaration: a method body error claims the method, not its class', async () => {
    const src = 'class S {\n  m() { return 1 +; }\n  n() {}\n}\nfunction z() { return [1,; }\n';
    const o = await outline(src, 'typescript');
    expect(o.errors).toBe('contained');
    expect(o.errorKeys).toEqual(['S.m', 'z']);
    expect(keys(o.items)).toEqual(['S', 'S.m', 'S.n', 'z']);
  });

  it('an error between members is contained in the class', async () => {
    const src = 'class S {\n  m() {}\n  )\n  n() {}\n}\n';
    const o = await outline(src, 'typescript');
    expect(o.errors).toBe('contained');
    expect(o.errorKeys).toEqual(['S']);
  });

  it('an error in a parameter list, an import or a top-level statement is uncontained', async () => {
    for (const src of ['function f(a: ) {}\nfunction g() {}\n', "import { a from 'x';\nfunction g() {}\n", 'foo(1 +;\nfunction g() {}\n']) {
      const o = await outline(src, 'typescript');
      expect(o.errors, src).toBe('uncontained');
    }
  });

  it('an error in an initializer is contained in its variable', async () => {
    const src = 'const x = { a: 1 b: 2 };\nconst y = 2;\n';
    const o = await outline(src, 'typescript');
    expect(o.errors).toBe('contained');
    expect(o.errorKeys).toEqual(['x']);
    expect(keys(o.items)).toEqual(['x', 'y']);
  });

  it('a contained error and an uncontained one together are uncontained', async () => {
    const src = 'function a() { return 1 +; }\nfoo(;\n';
    expect((await outline(src, 'typescript')).errors).toBe('uncontained');
  });
});
