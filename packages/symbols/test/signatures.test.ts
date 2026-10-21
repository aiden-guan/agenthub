// S4: signatures and signatureChanges (design §2.4 "Signatures" and step 6 of
// "changedSymbols"), the same edits in all seven languages: whitespace and
// comment changes keep a signature, a parameter or return-type change alters
// it, a value-only constant change is not a signature change, and a rename is
// detected (by kind and normalized body).
import { describe, expect, it } from 'vitest';
import { changedSymbols, outline } from '../src/index.js';
import type { LanguageId, SignatureChange, SymbolDiff } from '../src/types.js';
import { find } from './helpers.js';

type Pair = [old: string, replacement: string];

interface Case {
  lang: LanguageId;
  path: string;
  base: string;
  /** The function whose signature the edits change, and its normalized signature. */
  key: string;
  sig: string;
  /** Edits that only change whitespace or comments, inside the signature or around it. */
  layout: Pair[];
  /** A new parameter, and the signature after it. */
  param: Pair;
  paramSig: string;
  /** A new return type (null for JavaScript, which has none), and the signature after it. */
  ret: Pair | null;
  retSig: string | null;
  /** A constant with a type annotation (Rust, Go, Java, TS, Python) or without (JS), and a change of its value only. */
  constant: string;
  value: Pair;
  /** `helper` renamed to `twice`, and the two keys. */
  rename: Pair;
  from: string;
  to: string;
  fromSig: string;
  toSig: string;
}

const lines = (...xs: string[]): string => `${xs.join('\n')}\n`;

const TS = lines(
  "import { db } from './db';",
  '',
  'export function login(user: string, ttl: number): string {',
  '  return db.find(user) + ttl;',
  '}',
  '',
  'export const LIMIT: number = 3;',
  '',
  'export function helper(x: number): number {',
  '  return x * 2;',
  '}',
);

const tsCase = (lang: LanguageId, path: string, base: string): Case => ({
  lang,
  path,
  base,
  key: 'login',
  sig: 'function login(user: string, ttl: number): string',
  layout: [
    ['login(user: string, ttl: number): string {', 'login(\n  user: string /* who */,\n  ttl:   number // seconds\n):   string {'],
    ['export function login', '/** Logs in. */\nexport function login'],
    ['export function login(user: string', 'export   function  login( user :string'],
  ],
  param: ['ttl: number)', 'ttl: number, opts?: Options)'],
  paramSig: 'function login(user: string, ttl: number, opts?: Options): string',
  ret: ['): string {', '): Promise<string> {'],
  retSig: 'function login(user: string, ttl: number): Promise<string>',
  constant: 'LIMIT',
  value: ['LIMIT: number = 3', 'LIMIT: number = 4'],
  rename: ['function helper(', 'function twice('],
  from: 'helper',
  to: 'twice',
  fromSig: 'function helper(x: number): number',
  toSig: 'function twice(x: number): number',
});

const CASES: Case[] = [
  tsCase('typescript', 'src/auth.ts', TS),
  tsCase('tsx', 'src/auth.tsx', TS.replace('return db.find(user) + ttl;', 'return <b>{db.find(user) + ttl}</b>;')),
  {
    lang: 'javascript',
    path: 'src/auth.js',
    base: lines(
      "import { db } from './db';",
      '',
      'export function login(user, ttl = 60) {',
      '  return db.find(user) + ttl;',
      '}',
      '',
      'export const LIMIT = 3;',
      '',
      'export function helper(x) {',
      '  return x * 2;',
      '}',
    ),
    key: 'login',
    sig: 'function login(user, ttl = 60)',
    layout: [
      ['login(user, ttl = 60) {', 'login(\n  user, // who\n  ttl=60\n) {'],
      ['export function login', '// Logs in.\nexport function login'],
    ],
    param: ['ttl = 60)', 'ttl = 60, opts = {})'],
    paramSig: 'function login(user, ttl = 60, opts = {})',
    ret: null,
    retSig: null,
    constant: 'LIMIT',
    value: ['LIMIT = 3', 'LIMIT = 4'],
    rename: ['function helper(', 'function twice('],
    from: 'helper',
    to: 'twice',
    fromSig: 'function helper(x)',
    toSig: 'function twice(x)',
  },
  {
    lang: 'python',
    path: 'pkg/auth.py',
    base: lines(
      'from db import find',
      '',
      '',
      'def login(user: str, ttl: int) -> str:',
      '    return find(user) + str(ttl)',
      '',
      '',
      'LIMIT: int = 3',
      '',
      '',
      'def helper(x: int) -> int:',
      '    return x * 2',
    ),
    key: 'login',
    sig: 'def login(user: str, ttl: int) -> str',
    layout: [
      ['def login(user: str, ttl: int) -> str:', 'def login(\n    user: str,  # who\n    ttl:   int\n)  ->  str:'],
      ['def login', '# Logs in.\ndef login'],
    ],
    param: ['ttl: int)', 'ttl: int, opts: dict)'],
    paramSig: 'def login(user: str, ttl: int, opts: dict) -> str',
    ret: ['-> str:', '-> bytes:'],
    retSig: 'def login(user: str, ttl: int) -> bytes',
    constant: 'LIMIT',
    value: ['LIMIT: int = 3', 'LIMIT: int = 4'],
    rename: ['def helper(', 'def twice('],
    from: 'helper',
    to: 'twice',
    fromSig: 'def helper(x: int) -> int',
    toSig: 'def twice(x: int) -> int',
  },
  {
    lang: 'go',
    path: 'auth/auth.go',
    base: lines(
      'package auth',
      '',
      'import "db"',
      '',
      'func Login(user string, ttl int) string {',
      '\treturn db.Find(user) + string(ttl)',
      '}',
      '',
      'const Limit int = 3',
      '',
      'func helper(x int) int {',
      '\treturn x * 2',
      '}',
    ),
    key: 'Login',
    sig: 'func Login(user string, ttl int) string',
    layout: [
      ['func Login(user string, ttl int) string {', 'func Login(\n\tuser string, // who\n\tttl  int) /* out */ string {'],
      ['func Login', '// Login logs in.\nfunc Login'],
    ],
    param: ['ttl int)', 'ttl int, opts Options)'],
    paramSig: 'func Login(user string, ttl int, opts Options) string',
    ret: ['ttl int) string {', 'ttl int) (string, error) {'],
    retSig: 'func Login(user string, ttl int) (string, error)',
    constant: 'Limit',
    value: ['Limit int = 3', 'Limit int = 4'],
    rename: ['func helper(', 'func twice('],
    from: 'helper',
    to: 'twice',
    fromSig: 'func helper(x int) int',
    toSig: 'func twice(x int) int',
  },
  {
    lang: 'rust',
    path: 'src/auth.rs',
    base: lines(
      'use crate::db;',
      '',
      'pub fn login(user: &str, ttl: u32) -> String {',
      '    db::find(user) + &ttl.to_string()',
      '}',
      '',
      'pub const LIMIT: u32 = 3;',
      '',
      'fn helper(x: u32) -> u32 {',
      '    x * 2',
      '}',
    ),
    key: 'login',
    sig: 'pub fn login(user: &str, ttl: u32) -> String',
    layout: [
      ['pub fn login(user: &str, ttl: u32) -> String {', 'pub fn login(\n    user: & str, // who\n    ttl:  u32\n) /* out */ -> String {'],
      ['pub fn login', '/// Logs in.\n#[inline]\npub fn login'],
    ],
    param: ['ttl: u32)', 'ttl: u32, opts: &Options)'],
    paramSig: 'pub fn login(user: &str, ttl: u32, opts: &Options) -> String',
    ret: ['-> String {', '-> Result<String, Error> {'],
    retSig: 'pub fn login(user: &str, ttl: u32) -> Result<String, Error>',
    constant: 'LIMIT',
    value: ['LIMIT: u32 = 3', 'LIMIT: u32 = 4'],
    rename: ['fn helper(', 'fn twice('],
    from: 'helper',
    to: 'twice',
    fromSig: 'fn helper(x: u32) -> u32',
    toSig: 'fn twice(x: u32) -> u32',
  },
  {
    lang: 'java',
    path: 'src/auth/Auth.java',
    base: lines(
      'package auth;',
      '',
      'import db.Db;',
      '',
      'public class Auth {',
      '    public static final int LIMIT = 3;',
      '',
      '    public String login(String user, int ttl) {',
      '        return Db.find(user) + ttl;',
      '    }',
      '',
      '    int helper(int x) {',
      '        return x * 2;',
      '    }',
      '}',
    ),
    key: 'Auth.login',
    sig: 'public String login(String user, int ttl)',
    layout: [
      ['public String login(String user, int ttl) {', 'public   String login(\n        String user, // who\n        int    ttl /* seconds */) {'],
      ['    public String login', '    /** Logs in. */\n    @Override\n    public String login'],
    ],
    param: ['int ttl)', 'int ttl, Options opts)'],
    paramSig: 'public String login(String user, int ttl, Options opts)',
    ret: ['public String login', 'public Optional<String> login'],
    retSig: 'public Optional<String> login(String user, int ttl)',
    constant: 'Auth.LIMIT',
    value: ['LIMIT = 3', 'LIMIT = 4'],
    rename: ['int helper(', 'int twice('],
    from: 'Auth.helper',
    to: 'Auth.twice',
    fromSig: 'int helper(int x)',
    toSig: 'int twice(int x)',
  },
];

function edit(src: string, [old, replacement]: Pair): string {
  expect(src.split(old).length, `exactly one ${JSON.stringify(old)}`).toBe(2);
  return src.replace(old, replacement);
}

function changes(d: SymbolDiff): { symbols: string[]; signatureChanges: SignatureChange[] } {
  if (d.fileLevel) throw new Error(`expected a symbol-level diff, got file level (${d.reason})`);
  return d;
}

describe.each(CASES)('signatures in $lang', (c) => {
  it('the base has the expected signature', async () => {
    const o = await outline(c.base, c.lang);
    expect(o.errors).toBe('none');
    expect(find(o.items, c.key).signature).toBe(c.sig);
  });

  it('whitespace and comment changes keep the signature (the declaration is still claimed)', async () => {
    for (const pair of c.layout) {
      const after = edit(c.base, pair);
      const o = await outline(after, c.lang);
      expect(o.errors, pair[1]).toBe('none');
      expect(find(o.items, c.key).signature, pair[1]).toBe(c.sig);
      const d = changes(await changedSymbols(c.path, c.base, after));
      expect(d.symbols, pair[1]).toEqual([c.key]);
      expect(d.signatureChanges, pair[1]).toEqual([]);
    }
  });

  it('a new parameter alters it', async () => {
    const d = changes(await changedSymbols(c.path, c.base, edit(c.base, c.param)));
    expect(d.symbols).toEqual([c.key]);
    expect(d.signatureChanges).toEqual([{ symbol: c.key, kind: 'signature', before: c.sig, after: c.paramSig }]);
  });

  it.skipIf(c.ret === null)('a new return type alters it', async () => {
    const d = changes(await changedSymbols(c.path, c.base, edit(c.base, c.ret!)));
    expect(d.symbols).toEqual([c.key]);
    expect(d.signatureChanges).toEqual([{ symbol: c.key, kind: 'signature', before: c.sig, after: c.retSig }]);
  });

  it('a body change is not a signature change', async () => {
    const after = c.base.replace(/\* 2/, '* 3');
    const d = changes(await changedSymbols(c.path, c.base, after));
    expect(d.symbols).toEqual([c.from]);
    expect(d.signatureChanges).toEqual([]);
  });

  it("a change of a constant's value only is not a signature change", async () => {
    const d = changes(await changedSymbols(c.path, c.base, edit(c.base, c.value)));
    expect(d.symbols).toEqual([c.constant]);
    expect(d.signatureChanges).toEqual([]);
  });

  it('a rename is detected: same kind, same normalized body', async () => {
    const d = changes(await changedSymbols(c.path, c.base, edit(c.base, c.rename)));
    expect(d.symbols).toEqual([c.from, c.to]);
    expect(d.signatureChanges).toEqual([{ symbol: c.from, kind: 'renamed', before: c.fromSig, after: c.toSig, renamed_to: c.to }]);
  });

  it('a rename that also reformats the body is still a rename; one that changes it is a removal', async () => {
    const renamed = edit(c.base, c.rename);
    const reformatted = renamed.replace(/(\S) \* 2/, '$1  *  2');
    let d = changes(await changedSymbols(c.path, c.base, reformatted));
    expect(d.signatureChanges.map((s) => [s.symbol, s.kind, s.renamed_to])).toEqual([[c.from, 'renamed', c.to]]);
    d = changes(await changedSymbols(c.path, c.base, renamed.replace(/\* 2/, '* 3')));
    expect(d.signatureChanges).toEqual([{ symbol: c.from, kind: 'removed', before: c.fromSig, after: null }]);
  });

  it('a removed declaration is reported with its signature', async () => {
    const o = await outline(c.base, c.lang);
    const item = find(o.items, c.from);
    const after = c.base.slice(0, item.start) + c.base.slice(item.end);
    const d = changes(await changedSymbols(c.path, c.base, after));
    expect(d.symbols).toEqual([c.from]);
    expect(d.signatureChanges).toEqual([{ symbol: c.from, kind: 'removed', before: c.fromSig, after: null }]);
  });
});

describe('signatureChanges and the keys that changed', () => {
  it('a signature change is reported even where the claim is the enclosing container', async () => {
    const src = 'export class Session {\n  refresh(force: boolean): void {\n    this.x = force;\n  }\n}\n';
    const after = src.replace('class Session {', 'class Session extends Base {').replace('refresh(force: boolean)', 'refresh(force: boolean, at: Date)');
    const d = changes(await changedSymbols('a.ts', src, after));
    expect(d.symbols).toEqual(['Session']);
    expect(d.signatureChanges).toEqual([
      { symbol: 'Session', kind: 'signature', before: 'class Session', after: 'class Session extends Base' },
      { symbol: 'Session.refresh', kind: 'signature', before: 'refresh(force: boolean): void', after: 'refresh(force: boolean, at: Date): void' },
    ]);
  });

  it('a declaration moved within the file keeps its signature (claimed, not reported)', async () => {
    const after = TS.replace(
      "export function helper(x: number): number {\n  return x * 2;\n}\n",
      '',
    ).replace("import { db } from './db';\n", "import { db } from './db';\n\nexport function helper(x: number): number {\n  return x * 2;\n}\n");
    const d = changes(await changedSymbols('src/auth.ts', TS, after));
    expect(d.symbols).toContain('helper');
    expect(d.signatureChanges).toEqual([]);
  });

  it('the same edit gives the same signature changes whichever side was seen before (no state leaks between calls)', async () => {
    const after = edit(TS, ['ttl: number)', 'ttl: bigint)']);
    const expected = [{ symbol: 'login', kind: 'signature', before: 'function login(user: string, ttl: number): string', after: 'function login(user: string, ttl: bigint): string' }];
    const fresh = TS.replace('3;', '3; ');
    const freshAfter = after.replace('3;', '3; ');
    // Neither side seen before, then before seen, then after seen, then both: one result.
    expect(changes(await changedSymbols('a.ts', fresh, freshAfter)).signatureChanges).toEqual(expected);
    expect(changes(await changedSymbols('a.ts', fresh, freshAfter.replace('{\n  return x', '{\n  return  x'))).signatureChanges).toEqual(expected);
    expect(changes(await changedSymbols('a.ts', fresh.replace('{\n  return x', '{\n  return  x'), freshAfter)).signatureChanges).toEqual(expected);
    expect(changes(await changedSymbols('a.ts', fresh, freshAfter)).signatureChanges).toEqual(expected);
    // And the reverse direction.
    expect(changes(await changedSymbols('a.ts', freshAfter, fresh)).signatureChanges).toEqual([{ ...expected[0]!, before: expected[0]!.after, after: expected[0]!.before }]);
  });
});
