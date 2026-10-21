// S3: changedSymbols beyond the vector suite (design §2.4 "changedSymbols"):
// the file-level fallbacks in their order, the mapper, flattening and shells,
// moves at every level, contained errors, the @toplevel rule, the limit, the
// keys a container claim already covers, and signatureChanges.
import { describe, expect, it } from 'vitest';
import { changedSymbols, MAPPER_VERSION, symbols } from '../src/index.js';
import { changedSymbolsWith } from '../src/diff.js';
import { GrammarRuntime, MANIFEST, type GrammarManifest } from '../src/runtime.js';
import type { SymbolDiff } from '../src/types.js';

const TS = [
  "import { a } from './a';",
  '',
  'export function login(user: string): string {',
  '  return user;',
  '}',
  '',
  'export function logout(): void {}',
  '',
].join('\n');

function symbolsOf(d: SymbolDiff): string[] {
  if (d.fileLevel) throw new Error(`expected a symbol-level diff, got file level (${d.reason})`);
  return d.symbols;
}

const fileLevel = (reason: string): SymbolDiff => ({ fileLevel: true, reason, mapper: MAPPER_VERSION }) as SymbolDiff;

describe('file-level fallbacks', () => {
  it('an unsupported language', async () => {
    expect(await changedSymbols('README.md', 'a', 'b')).toEqual(fileLevel('unsupported_language'));
    expect(await changedSymbols('Makefile', null, 'b')).toEqual(fileLevel('unsupported_language'));
  });

  it('an excluded path (symbols.exclude globs), before the sides are looked at', async () => {
    const exclude = ['**/*.generated.ts', 'vendor/**'];
    expect(await changedSymbols('src/api.generated.ts', TS, `${TS}// x\n`, { exclude })).toEqual(fileLevel('excluded'));
    expect(await changedSymbols('vendor/lib/x.go', null, 'package x\n', { exclude })).toEqual(fileLevel('excluded'));
    expect(symbolsOf(await changedSymbols('src/api.ts', TS, TS.replace('return user;', 'return user + 1;'), { exclude }))).toEqual(['login']);
    expect(symbolsOf(await changedSymbols('src/api.ts', TS, TS.replace('return user;', 'return user + 1;'), { exclude: [] }))).toEqual(['login']);
  });

  it('a new file and a deleted file', async () => {
    expect(await changedSymbols('a.ts', null, TS)).toEqual(fileLevel('new_file'));
    expect(await changedSymbols('a.ts', TS, null)).toEqual(fileLevel('deleted_file'));
  });

  it('a file absent on both sides changes nothing', async () => {
    expect(await changedSymbols('a.ts', null, null)).toEqual({ fileLevel: false, symbols: [], signatureChanges: [], mapper: MAPPER_VERSION });
  });

  it('over 1 MiB (in UTF-8 bytes) on either side is too_large', async () => {
    const big = `${TS}// ${'x'.repeat(1024 * 1024)}\n`;
    expect(await changedSymbols('a.ts', TS, big)).toEqual(fileLevel('too_large'));
    expect(await changedSymbols('a.ts', big, TS)).toEqual(fileLevel('too_large'));
    // Fewer UTF-16 units than 1 MiB, but more bytes: é is two bytes in UTF-8.
    const wide = `${TS}// ${'é'.repeat(600 * 1024)}\n`;
    expect(wide.length).toBeLessThan(1024 * 1024);
    expect(await changedSymbols('a.ts', TS, wide)).toEqual(fileLevel('too_large'));
    // Exactly 1 MiB is not over it.
    const exact = `${TS}//`.padEnd(1024 * 1024 - 1, 'x') + '\n';
    expect(Buffer.byteLength(exact)).toBe(1024 * 1024);
    expect((await changedSymbols('a.ts', TS, exact)).fileLevel).toBe(false);
  });

  it('a NUL in the first 8 KiB of either side is binary; one further on is not', async () => {
    expect(await changedSymbols('a.ts', TS, `${TS}\0`)).toEqual(fileLevel('binary'));
    expect(await changedSymbols('a.ts', `\0${TS}`, TS)).toEqual(fileLevel('binary'));
    // (tree-sitter reads a NUL as an error: in a string it is contained in the declaration.)
    const late = `${TS}// ${'x'.repeat(9000)}\nconst s = "\0";\n`;
    expect(symbolsOf(await changedSymbols('a.ts', TS, late))).toEqual(['s']);
  });

  it('the fallbacks apply in order: unsupported, excluded, absent side, too large, binary', async () => {
    expect(await changedSymbols('a.md', null, '\0', { exclude: ['*.md'] })).toEqual(fileLevel('unsupported_language'));
    expect(await changedSymbols('a.ts', null, '\0', { exclude: ['*.ts'] })).toEqual(fileLevel('excluded'));
    expect(await changedSymbols('a.ts', null, '\0')).toEqual(fileLevel('new_file'));
    expect(await changedSymbols('a.ts', '\0', `\0${'x'.repeat(1024 * 1024)}`)).toEqual(fileLevel('too_large'));
  });

  it('an unverified grammar (manifest mismatch) is grammar_unverified', async () => {
    const manifest: GrammarManifest = structuredClone(MANIFEST);
    manifest.grammars.typescript.sha256 = '0'.repeat(64);
    const rt = new GrammarRuntime({ manifest, warn: () => {} });
    const edited = TS.replace('return user;', 'return user + 1;');
    expect(await changedSymbolsWith(rt, 'a.ts', TS, edited)).toEqual(fileLevel('grammar_unverified'));
    // The other languages of that runtime still map at symbol level.
    const go = 'package a\n\nfunc F() int {\n\treturn 1\n}\n';
    const d = await changedSymbolsWith(rt, 'a.go', go, go.replace('return 1', 'return 2'));
    expect(symbolsOf(d)).toEqual(['F']);
  });

  it('an uncontained error on either side is parse_error', async () => {
    const broken = TS.replace('export function logout(): void {}', 'export function logout(: void {}');
    expect(await changedSymbols('a.ts', TS, broken)).toEqual(fileLevel('parse_error'));
    expect(await changedSymbols('a.ts', broken, TS)).toEqual(fileLevel('parse_error'));
  });

  it('is exported on the symbols object too, with the mapper version', async () => {
    const d = await symbols.changedSymbols('a.ts', TS, TS.replace('return user;', 'return "x";'));
    expect(d).toEqual({ fileLevel: false, symbols: ['login'], signatureChanges: [], mapper: symbols.MAPPER_VERSION });
  });
});

describe('the keys an edit changes', () => {
  const CLASS = [
    'export class Session {',
    '  ttl = 60;',
    '',
    '  refresh(): void {',
    '    this.ttl = 0;',
    '  }',
    '',
    '  close(): void {}',
    '}',
    '',
  ].join('\n');

  it('a container claim covers its members: they are not listed besides it', async () => {
    const both = CLASS.replace('export class Session {', 'export class Session extends Base {').replace('this.ttl = 0;', 'this.ttl = 1;');
    expect(symbolsOf(await changedSymbols('a.ts', CLASS, both))).toEqual(['Session']);
  });

  it('renaming a class claims the old and the new container (two keys, not one per member)', async () => {
    const d = await changedSymbols('a.ts', CLASS, CLASS.replace('class Session', 'class Store'));
    expect(symbolsOf(d)).toEqual(['Session', 'Store']);
  });

  it('a field, the whitespace between members, and a comment attached to a member', async () => {
    expect(symbolsOf(await changedSymbols('a.ts', CLASS, CLASS.replace('ttl = 60;', 'ttl = 61;')))).toEqual(['Session.ttl']);
    // Whitespace between members belongs to no key: the edit only changed whitespace, so @toplevel.
    expect(symbolsOf(await changedSymbols('a.ts', CLASS, CLASS.replace('  ttl = 60;\n', '  ttl = 60;\n\n')))).toEqual(['@toplevel']);
    expect(symbolsOf(await changedSymbols('a.ts', CLASS, CLASS.replace('  close(): void {}', '  // Closes it.\n  close(): void {}')))).toEqual(['Session.close']);
  });

  it('whitespace inside a declaration is part of it', async () => {
    expect(symbolsOf(await changedSymbols('a.ts', TS, TS.replace('  return user;', '    return user;')))).toEqual(['login']);
  });

  it('a stray piece of a container moved across a member claims the container', async () => {
    const src = 'class S {\n  a() {}\n  [k]() {}\n  b() {}\n  c() {}\n}\n';
    const moved = 'class S {\n  a() {}\n  b() {}\n  [k]() {}\n  c() {}\n}\n';
    expect(symbolsOf(await changedSymbols('a.ts', src, moved))).toEqual(['S']);
  });

  it('a member moved together with a stray piece: the moved member, or the container', async () => {
    const src = 'class S {\n  a() {}\n  m() {}\n  [k]() {}\n  b() {}\n}\n';
    const moved = 'class S {\n  m() {}\n  [k]() {}\n  a() {}\n  b() {}\n}\n';
    expect(symbolsOf(await changedSymbols('a.ts', src, moved))).toEqual(['S.a']);
    // The other way round. The shell is the same («S.m»[k]), and the member keys alone ([m, a, b] → [a, m, b])
    // could be aligned by keeping a and b and claiming m, which would leave [k] moved across a unclaimed.
    expect(symbolsOf(await changedSymbols('a.ts', moved, src))).toEqual(['S.a']);
  });

  it('moves among same-key siblings and @toplevel pieces are caught', async () => {
    const src = 'function f(a: string): void;\nfunction f(a: any) {}\n\nconsole.log(1);\n\nfunction g() {}\n';
    const moved = 'function f(a: string): void;\nfunction f(a: any) {}\n\nfunction g() {}\n\nconsole.log(1);\n';
    const d = symbolsOf(await changedSymbols('a.ts', src, moved));
    expect(d.length).toBe(1);
    expect(['g', '@toplevel']).toContain(d[0]);
  });

  it('a top-level statement claims @toplevel, and inserting one between declarations does too', async () => {
    expect(symbolsOf(await changedSymbols('a.ts', TS, TS.replace('export function logout', 'console.log(1);\n\nexport function logout')))).toEqual(['@toplevel']);
  });

  it('a pre-existing contained error claims its declaration too (errorKeys of either side)', async () => {
    const broken = TS.replace('return user;', 'return user +;');
    const d = await changedSymbols('a.ts', broken, broken.replace('export function logout(): void {}', 'export function logout(): void { return; }'));
    expect(symbolsOf(d)).toEqual(['login', 'logout']);
  });

  it('lists keys in source order: before first, then the keys only after has', async () => {
    const src = 'function a() {}\n\nfunction b() {}\n\nfunction c() {}\n';
    const out = 'function z() {}\n\nfunction a() { 1; }\n\nfunction c() { 1; }\n';
    expect(symbolsOf(await changedSymbols('a.ts', src, out))).toEqual(['a', 'b', 'c', 'z']);
  });

  it('maxSymbols is the limit: more keys than it is too_many_symbols', async () => {
    const src = 'function a() {}\n\nfunction b() {}\n';
    const out = 'function a() { 1; }\n\nfunction b() { 1; }\n';
    expect(symbolsOf(await changedSymbols('a.ts', src, out, { maxSymbols: 2 }))).toEqual(['a', 'b']);
    expect(await changedSymbols('a.ts', src, out, { maxSymbols: 1 })).toEqual(fileLevel('too_many_symbols'));
  });
});

describe('signatureChanges', () => {
  it('a value-only constant change is not a signature change; a type change is', async () => {
    const src = 'export const LIMIT: number = 3;\nexport const NAME = "a";\n';
    let d = await changedSymbols('a.ts', src, src.replace('= 3', '= 4').replace('"a"', '"b"'));
    expect(symbolsOf(d)).toEqual(['LIMIT', 'NAME']);
    expect(d.fileLevel === false && d.signatureChanges).toEqual([]);
    d = await changedSymbols('a.ts', src, src.replace('LIMIT: number', 'LIMIT: bigint').replace('= 3', '= 3n'));
    expect(d.fileLevel === false && d.signatureChanges).toEqual([{ symbol: 'LIMIT', kind: 'signature', before: 'const LIMIT: number', after: 'const LIMIT: bigint' }]);
  });

  it('a signature that appears or disappears (null on one side) is not reported', async () => {
    const src = 'export const NAME = "a";\n';
    const d = await changedSymbols('a.ts', src, 'export const NAME: string = "a";\n');
    expect(d.fileLevel === false && d.signatureChanges).toEqual([]);
  });

  it('overloads are compared as one: their signatures, joined', async () => {
    const src = 'function f(a: string): string;\nfunction f(a: any): any {\n  return a;\n}\n';
    const d = await changedSymbols('a.ts', src, src.replace('f(a: string): string;', 'f(a: string): string;\nfunction f(a: number): number;'));
    expect(d.fileLevel === false && d.signatureChanges).toEqual([
      {
        symbol: 'f',
        kind: 'signature',
        before: 'function f(a: string): string\nfunction f(a: any): any',
        after: 'function f(a: string): string\nfunction f(a: number): number\nfunction f(a: any): any',
      },
    ]);
  });

  it('a removed key without a signature is not reported', async () => {
    const src = 'export const NAME = "a";\nexport function f(): void {}\n';
    const d = await changedSymbols('a.ts', src, 'export function f(): void {}\n');
    expect(symbolsOf(d)).toEqual(['NAME']);
    expect(d.fileLevel === false && d.signatureChanges).toEqual([]);
  });

  it('a rename needs exactly one new key of the same kind with the same body; otherwise it is a removal', async () => {
    const src = 'function a(x: number) {\n  return x + 1;\n}\n';
    // Renamed with a new parameter: still a rename (same kind, same body), with the new signature.
    let d = await changedSymbols('a.ts', src, 'function b(x: number, y = 2) {\n  return x + 1;\n}\n');
    expect(d.fileLevel === false && d.signatureChanges).toEqual([{ symbol: 'a', kind: 'renamed', before: 'function a(x: number)', after: 'function b(x: number, y = 2)', renamed_to: 'b' }]);
    // Body reformatted: whitespace doesn't count.
    d = await changedSymbols('a.ts', src, 'function b(x: number) {\n    return x + 1;\n}\n');
    expect(d.fileLevel === false && d.signatureChanges[0]?.kind).toBe('renamed');
    // Two candidates: a removal.
    d = await changedSymbols('a.ts', src, 'function b(x: number) {\n  return x + 1;\n}\nfunction c(x: number) {\n  return x + 1;\n}\n');
    expect(d.fileLevel === false && d.signatureChanges).toEqual([{ symbol: 'a', kind: 'removed', before: 'function a(x: number)', after: null }]);
    // A different body, or a different kind: a removal.
    d = await changedSymbols('a.ts', src, 'function b(x: number) {\n  return x + 2;\n}\n');
    expect(d.fileLevel === false && d.signatureChanges[0]?.kind).toBe('removed');
    // The same body text in a class instead of a function.
    const fn = 'function a() {\n  x = 1;\n}\n';
    d = await changedSymbols('a.ts', fn, 'function b() {\n  x = 1;\n}\n');
    expect(d.fileLevel === false && d.signatureChanges[0]?.kind).toBe('renamed');
    d = await changedSymbols('a.ts', fn, 'class b {\n  x = 1;\n}\n');
    expect(d.fileLevel === false && d.signatureChanges).toEqual([{ symbol: 'a', kind: 'removed', before: 'function a()', after: null }]);
  });

  it('renaming a class renames its members too', async () => {
    const src = 'export class Session {\n  refresh(force: boolean): void {\n    this.x = force;\n  }\n}\n';
    const d = await changedSymbols('a.ts', src, src.replace('class Session', 'class Store'));
    expect(d.fileLevel === false && d.signatureChanges).toEqual([
      { symbol: 'Session', kind: 'renamed', before: 'class Session', after: 'class Store', renamed_to: 'Store' },
      { symbol: 'Session.refresh', kind: 'renamed', before: 'refresh(force: boolean): void', after: 'refresh(force: boolean): void', renamed_to: 'Store.refresh' },
    ]);
  });

  it('@imports and @toplevel never appear, and every text stays within 500 characters', async () => {
    const params = Array.from({ length: 60 }, (_, i) => `p${i}: number`).join(', ');
    const src = `import { a } from './a';\nconsole.log(1);\nfunction f(${params}): void;\nfunction f(${params}, more: string): void;\nfunction f(...xs: any[]) {}\n`;
    // The second overload changes: the signatures are compared whole, though each text is cut to 500 characters.
    const d = await changedSymbols('a.ts', src, src.replace("'./a'", "'./b'").replace('log(1)', 'log(2)').replace(`f(${params}, more`, `f(q: boolean, ${params}, more`));
    if (d.fileLevel) throw new Error('file level');
    expect(d.symbols).toEqual(['@imports', '@toplevel', 'f']);
    expect(d.signatureChanges.map((c) => c.symbol)).toEqual(['f']);
    for (const c of d.signatureChanges) {
      expect(c.before.length).toBeLessThanOrEqual(500);
      expect((c.after ?? '').length).toBeLessThanOrEqual(500);
    }
  });
});
