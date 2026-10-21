// S1: TypeScript outlines (design §1.10 keys, §2.4 the TS/TSX/JS table and signatures).
import { describe, expect, it } from 'vitest';
import { outline } from '../src/index.js';
import { expectWellFormed, find, fixture, keys, view } from './helpers.js';

const SAMPLE = fixture('outline/sample.ts');

describe('the TypeScript fixture', () => {
  it('has the expected keys, kinds, spans and signatures', async () => {
    const o = await outline(SAMPLE, 'typescript');
    expect(o.language).toBe('typescript');
    expect(o.errors).toBe('none');
    expect(o.errorKeys).toEqual([]);
    expect(view(SAMPLE, o.items)).toEqual([
      { key: '@toplevel', kind: 'toplevel', lines: '1', head: '// Sample TypeScript module for the outline tests (and the mapping property test).', tail: '// Sample TypeScript module for the outline tests (and the mapping property test).', signature: null },
      { key: '@imports', kind: 'imports', lines: '3-6', head: "import { readFileSync } from 'node:fs';", tail: "export { helper as aid } from './helper';", signature: null },
      { key: 'login', kind: 'function', lines: '8-12', head: '// Grüße, naïve café ✓ 😀: non-ASCII text before a declaration', tail: '}', signature: 'function login(user: string, password: string): Promise<Session>' },
      { key: '@toplevel', kind: 'toplevel', lines: '14-17', head: '// A detached note about the module.', tail: 'const { host, port } = loadConfig();', signature: null },
      { key: 'MAX_RETRIES', kind: 'variable', lines: '19', head: 'export const MAX_RETRIES = 3, ', tail: 'export const MAX_RETRIES = 3, ', signature: null },
      { key: 'BACKOFF_MS', kind: 'variable', lines: '19', head: 'BACKOFF_MS: number = 250;', tail: 'BACKOFF_MS: number = 250;', signature: 'const BACKOFF_MS: number' },
      { key: 'current', kind: 'variable', lines: '20', head: 'export let current: Session | null = null;', tail: 'export let current: Session | null = null;', signature: 'let current: Session | null' },
      { key: 'handler', kind: 'variable', lines: '22-24', head: 'export const handler = async (req: Request): Promise<Response> => {', tail: '};', signature: 'const handler = async (req: Request): Promise<Response> =>' },
      { key: 'over', kind: 'function', lines: '26', head: 'function over(a: string): string;', tail: 'function over(a: string): string;', signature: 'function over(a: string): string' },
      { key: 'over', kind: 'function', lines: '27', head: 'function over(a: number): number;', tail: 'function over(a: number): number;', signature: 'function over(a: number): number' },
      { key: 'over', kind: 'function', lines: '28-30', head: 'function over(a: any): any {', tail: '}', signature: 'function over(a: any): any' },
      { key: 'Credentials', kind: 'interface', lines: '32-35', head: 'export interface Credentials {', tail: '}', signature: 'interface Credentials { user: string; password: string; }' },
      { key: 'Token', kind: 'type', lines: '37', head: 'export type Token = string & { readonly brand: unique symbol };', tail: 'export type Token = string & { readonly brand: unique symbol };', signature: 'type Token = string & { readonly brand: unique symbol }' },
      { key: 'Role', kind: 'enum', lines: '39-42', head: 'export enum Role {', tail: '}', signature: 'enum Role { Admin, User, }' },
      {
        key: 'Session',
        kind: 'class',
        lines: '44-72',
        head: '@sealed',
        tail: '}',
        signature: 'class Session<T = unknown> extends Base implements Disposable',
        members: [
          { key: 'Session.ttl', kind: 'field', lines: '46-47', head: '// How long a session lives.', tail: '  static ttl: number = 3600;', signature: 'static ttl: number' },
          { key: 'Session.token', kind: 'field', lines: '48', head: "private token = '';", tail: "private token = '';", signature: null },
          { key: 'Session.constructor', kind: 'constructor', lines: '51-53', head: 'constructor(private readonly store: Store<T>) {', tail: '  }', signature: 'constructor(private readonly store: Store<T>)' },
          { key: 'Session.refresh', kind: 'method', lines: '55-58', head: '@logged', tail: '  }', signature: 'refresh(force?: boolean): void' },
          { key: 'Session.user', kind: 'method', lines: '60-62', head: 'get user(): string {', tail: '  }', signature: 'get user(): string' },
          { key: 'Session.user', kind: 'method', lines: '63-65', head: 'set user(value: string) {', tail: '  }', signature: 'set user(value: string)' },
          { key: 'Session.close', kind: 'method', lines: '67', head: 'close(): void;', tail: 'close(): void;', signature: 'close(): void' },
          { key: 'Session.close', kind: 'method', lines: '68', head: 'close(code: number): void;', tail: 'close(code: number): void;', signature: 'close(code: number): void' },
          { key: 'Session.close', kind: 'method', lines: '69', head: 'close(code?: number): void {}', tail: 'close(code?: number): void {}', signature: 'close(code?: number): void' },
        ],
      },
      {
        key: 'Repo',
        kind: 'class',
        lines: '74-76',
        head: 'export abstract class Repo {',
        tail: '}',
        signature: 'abstract class Repo',
        members: [
          { key: 'Repo.find', kind: 'method', lines: '75', head: 'abstract find(id: string): Promise<unknown>; // by primary key', tail: 'abstract find(id: string): Promise<unknown>; // by primary key', signature: 'abstract find(id: string): Promise<unknown>' },
        ],
      },
      {
        key: 'Auth',
        kind: 'namespace',
        lines: '78-83',
        head: 'export namespace Auth {',
        tail: '}',
        signature: 'namespace Auth',
        members: [
          { key: 'Auth.realm', kind: 'variable', lines: '79', head: "export const realm = 'main';", tail: "export const realm = 'main';", signature: null },
          { key: 'Auth.check', kind: 'function', lines: '80-82', head: 'export function check(token: Token): boolean {', tail: '  }', signature: 'function check(token: Token): boolean' },
        ],
      },
      { key: '@toplevel', kind: 'toplevel', lines: '85-87', head: "declare module 'express' {", tail: '}', signature: null },
      { key: 'authenticate', kind: 'function', lines: '89', head: 'declare function authenticate(user: string, password: string): Promise<Session>;', tail: 'declare function authenticate(user: string, password: string): Promise<Session>;', signature: 'function authenticate(user: string, password: string): Promise<Session>' },
      {
        key: 'default',
        kind: 'class',
        lines: '91-93',
        head: 'export default class {',
        tail: '}',
        signature: 'class',
        members: [{ key: 'default.run', kind: 'method', lines: '92', head: 'run(): void {}', tail: 'run(): void {}', signature: 'run(): void' }],
      },
    ]);
    expectWellFormed(SAMPLE, o);
  });

  it('measures offsets in UTF-16 code units, as JS string indices', async () => {
    const o = await outline(SAMPLE, 'typescript');
    const login = find(o.items, 'login');
    expect(login.start).toBe(SAMPLE.indexOf('// Grüße'));
    expect(login.end).toBe(SAMPLE.indexOf('// A detached') - 2);
    expect(SAMPLE.slice(login.start, login.end)).toMatch(/^\/\/ Grüße, naïve café ✓ 😀: non-ASCII.*\n\/\*\* Logs a user in\. \*\/\nexport function login[^]*\n}$/);
    // Every later item stays exact although the emoji is two code units (and four UTF-8 bytes).
    const after = find(o.items, 'MAX_RETRIES');
    expect(after.start).toBe(SAMPLE.indexOf('export const MAX_RETRIES'));

    const small = "const s = '😀é😀';\nfunction f() {}\n";
    const f = find((await outline(small, 'typescript')).items, 'f');
    expect([f.start, f.end]).toEqual([small.indexOf('function f'), small.indexOf('function f') + 'function f() {}'.length]);
  });

  it("gives a container's shell its own text with every member's span cut out", async () => {
    const o = await outline(SAMPLE, 'typescript');
    expect(find(o.items, 'Session').text).toBe(
      '@sealed\nexport class Session<T = unknown> extends Base implements Disposable { «Session.token»#secret = 1; «Session.close»[Symbol.dispose](): void {} }',
    );
    expect(find(o.items, 'Auth').text).toBe('export namespace Auth { }');
    expect(find(o.items, 'Repo').text).toBe('export abstract class Repo { }');
    // A member's text is its own span.
    expect(find(o.items, 'Session.refresh').text).toBe('@logged\n  refresh(force?: boolean): void {\n    this.token = rotate(this.token, force);\n  }');
    // A later declarator of a shared statement carries the statement's header.
    expect(find(o.items, 'MAX_RETRIES').text).toBe('export const MAX_RETRIES = 3, ');
    expect(find(o.items, 'BACKOFF_MS').text).toBe('export const BACKOFF_MS: number = 250;');
    // Pseudo items are their exact spans.
    expect(o.items[1]!.text).toBe(SAMPLE.slice(SAMPLE.indexOf('import {'), SAMPLE.indexOf("'./helper';") + "'./helper';".length));
  });

  it('keeps a shell unchanged when members are added, removed or edited, and only then', async () => {
    const shell = async (src: string): Promise<string> => find((await outline(src, 'typescript')).items, 'S').text;
    const empty = await shell('class S {\n}\n');
    expect(await shell('class S {\n  a() {}\n}\n')).toBe(empty);
    expect(await shell('class S {\n  a() {}\n\n  b(x: number) { return x; }\n}\n')).toBe(empty);
    expect(await shell('class S {\n\n\n  a() { return 1; }\n}\n')).toBe(empty);
    expect(await shell('class S extends T {\n}\n')).not.toBe(empty);
    // Stray content between members is anchored to the member before it, so moving it across one shows.
    const before = await shell('class S {\n  a() {}\n  [k]() {}\n  b() {}\n}\n');
    expect(before).toBe('class S { «S.a»[k]() {} }');
    expect(await shell('class S {\n  a() {}\n  b() {}\n  [k]() {}\n}\n')).not.toBe(before);
    expect(await shell('class S {\n  [k]() {}\n  a() {}\n  b() {}\n}\n')).toBe('class S { «^»[k]() {} }');
  });

  it('keys declarations, members and pseudo items as design §1.10 says', async () => {
    const src = [
      'export default function () {}',
      'export default foo;',
      'export default { a: 1 };',
      'namespace A.B { export class C { m() {} } }',
      "declare module 'x' { export function f(): void; }",
      'declare global { interface Window { y: number } }',
      'declare const dc: number, dd: string;',
      'export declare function edf(): void;',
      'export { a, b };',
      "export type { T } from './t';",
      "import fs = require('fs');",
      'module M {}',
      'class K { "quoted"() {} 42() {} #p() {} constructor() {} static constructor2() {} }',
    ].join('\n');
    const o = await outline(src, 'typescript');
    expect(keys(o.items)).toEqual([
      'default',
      'default',
      'default',
      'A.B',
      'A.B.C',
      'A.B.C.m',
      '@toplevel',
      'dc',
      'dd',
      'edf',
      '@toplevel',
      '@imports',
      'M',
      'K',
      'K.constructor',
      'K.constructor2',
    ]);
    expect(o.items.map((i) => i.kind)).toEqual(['function', 'variable', 'variable', 'namespace', 'toplevel', 'variable', 'variable', 'function', 'toplevel', 'imports', 'namespace', 'class']);
    expect(find(o.items, 'K').text).toBe('class K { «^»"quoted"() {} «^»42() {} «^»#p() {} }');
    expect(find(o.items, 'A.B.C.m').signature).toBe('m()');
    expect(find(o.items, 'dd').signature).toBe('const dd: string');
    expectWellFormed(src, o);
  });

  it('sends destructuring to @toplevel and keys every plain declarator', async () => {
    const src = 'const { a, b } = o;\nlet [c] = d, e = 1;\nvar f = 1, g = 2;\nexport const h = 1;\n';
    const o = await outline(src, 'typescript');
    expect(view(src, o.items).map((v) => [v.key, v.head])).toEqual([
      ['@toplevel', 'const { a, b } = o;'],
      ['f', 'var f = 1, '],
      ['g', 'g = 2;'],
      ['h', 'export const h = 1;'],
    ]);
    expect(o.items[0]!.endLine).toBe(2);
  });

  it('attaches leading comments only without a blank line, trailing comments on the same line, and decorators always', async () => {
    const src = [
      '// detached',
      '',
      '// one',
      '// two',
      'function a() {} // trailing a',
      '/* before b */ function b() {}',
      'class C {',
      '  /** doc */',
      '  @dec()',
      '',
      '  @other',
      '  m() {}',
      '  // stray at the end',
      '}',
      '// ends the file',
    ].join('\n');
    const o = await outline(src, 'typescript');
    expect(view(src, o.items).map((v) => [v.key, v.lines, v.head, v.tail])).toEqual([
      ['@toplevel', '1', '// detached', '// detached'],
      ['a', '3-5', '// one', 'function a() {} // trailing a'],
      ['b', '6', '/* before b */ function b() {}', '/* before b */ function b() {}'],
      ['C', '7-14', 'class C {', '}'],
      ['@toplevel', '15', '// ends the file', '// ends the file'],
    ]);
    const m = find(o.items, 'C.m');
    expect([m.startLine, m.endLine]).toEqual([8, 12]);
    expect(find(o.items, 'C').text).toBe('class C { «C.m»// stray at the end }');
  });

  it('builds signatures from tokens, so whitespace and comments never change them, and caps them at 500 characters', async () => {
    const sig = async (src: string, key: string): Promise<string | null> => find((await outline(src, 'typescript')).items, key).signature;
    const flat = 'export async function load<T extends object>(id: string, opts?: { retries: number }): Promise<T | null> { return null; }';
    const tall = [
      'export async   function load<',
      '  T extends object // the record type',
      '>(',
      '  id: string, /* the key */',
      '  opts?: {retries: number}',
      '):Promise<T|null>{',
      '  return null;',
      '}',
    ].join('\n');
    expect(await sig(flat, 'load')).toBe('async function load<T extends object>(id: string, opts?: { retries: number }): Promise<T | null>');
    expect(await sig(tall, 'load')).toBe(await sig(flat, 'load'));
    // A real change (here, a parameter type) does change it.
    expect(await sig(flat.replace('id: string', 'id: number'), 'load')).not.toBe(await sig(flat, 'load'));
    // String literals keep their inner spacing, and a word before one keeps its space; the cap is 500 characters.
    expect(await sig("function f(a = 'x  y'): void {}", 'f')).toBe("function f(a = 'x  y'): void");
    expect(await sig('function isA(x: unknown): x is "a" { return true; }', 'isA')).toBe('function isA(x: unknown): x is "a"');
    const long = `interface Big { ${Array.from({ length: 200 }, (_, i) => `field${i}: string;`).join(' ')} }`;
    const big = (await sig(long, 'Big'))!;
    expect(big.length).toBe(500);
    expect(big.endsWith('…')).toBe(true);
  });

  it('merges adjacent imports and adjacent top-level statements, but not across a declaration', async () => {
    const src = "import a from 'a';\n\nimport b from 'b';\nfoo();\nbar();\nconst x = 1;\nimport c from 'c';\nbaz();\n";
    const o = await outline(src, 'typescript');
    expect(view(src, o.items).map((v) => [v.key, v.lines])).toEqual([
      ['@imports', '1-3'],
      ['@toplevel', '4-5'],
      ['x', '6'],
      ['@imports', '7'],
      ['@toplevel', '8'],
    ]);
  });
});
