// S4: references (design §2.5): referencesIn, identifierIndex, freeKeys and
// importsText. References count identifier tokens only (never comments or
// strings), each attributed to the innermost item it occurs in; a
// declaration's own name is not a use of it.
import { describe, expect, it } from 'vitest';
import { freeKeys, identifierIndex, importsText, referencesIn, symbols } from '../src/index.js';
import { referencesInWith } from '../src/references.js';
import { GrammarRuntime, MANIFEST, type GrammarManifest } from '../src/runtime.js';

const lines = (...xs: string[]): string => `${xs.join('\n')}\n`;

const ROUTES_TS = lines(
  "import { login, type Session } from './auth';",
  '',
  '// login is mentioned in a comment',
  "const banner = 'login';",
  '',
  'export function handleLogin(req: Request): Session {',
  '  const s = login(req.user); /* login(again) */',
  '  return `${login.name} and login` ? s : s;',
  '}',
  '',
  'export class Router {',
  '  route = login;',
  '',
  '  handle(): void {',
  '    this.login();',
  '  }',
  '',
  '  login(): void {}',
  '}',
  '',
  'app.use(handleLogin);',
);

const entries = (m: Map<string, string[]> | null): Array<[string, string[]]> | null => (m === null ? null : [...m]);

describe('referencesIn', () => {
  it('counts identifiers only, never comments or strings, each attributed to the innermost item', async () => {
    const refs = await referencesIn('src/routes.ts', ROUTES_TS, ['login']);
    // In order of first use: the import, handleLogin (a call, and a template substitution: code, not text),
    // and two members of Router. Router.login's own name is a declaration, not a use.
    expect(entries(refs)).toEqual([['login', ['@imports', 'handleLogin', 'Router.route', 'Router.handle']]]);
  });

  it('type names, top-level statements, and several names at once (only the names used are present)', async () => {
    const refs = await referencesIn('src/routes.ts', ROUTES_TS, ['Session', 'handleLogin', 'banner', 'nothing', 'Router']);
    expect(entries(refs)).toEqual([
      ['Session', ['@imports', 'handleLogin']],
      ['handleLogin', ['@toplevel']],
    ]);
  });

  it('is empty for a name that is only declared, mentioned in comments or strings, or absent', async () => {
    const refs = await referencesIn('src/routes.ts', ROUTES_TS, ['banner', 'again', 'mentioned', 'missing']);
    expect(refs?.size).toBe(0);
    expect(await referencesIn('src/routes.ts', ROUTES_TS, [])).toEqual(new Map());
  });

  it('a recursive call is a use of the declaration by itself', async () => {
    const src = 'export function walk(n: number): number {\n  return n === 0 ? 0 : walk(n - 1);\n}\n';
    expect(entries(await referencesIn('a.ts', src, ['walk']))).toEqual([['walk', ['walk']]]);
  });

  it('JSX tags and attributes are identifiers too', async () => {
    const src = lines("import { Login } from './login';", '', 'export function App() {', '  return <Login onLogin={handle} />;', '}', '', 'function handle() {}');
    expect(entries(await referencesIn('src/App.tsx', src, ['Login', 'handle', 'onLogin']))).toEqual([
      ['Login', ['@imports', 'App']],
      ['handle', ['App']],
      ['onLogin', ['App']],
    ]);
  });

  it('shorthand properties count', async () => {
    const src = lines("import { login } from './auth';", 'export const api = { login };', 'export function f({ login: l }) { return l; }');
    expect(entries(await referencesIn('a.js', src, ['login']))).toEqual([['login', ['@imports', 'api', 'f']]]);
  });

  it('Python: attribute names count, members are attributed to the method', async () => {
    const src = lines(
      'import auth',
      'from auth import login',
      '',
      '',
      'class Router:',
      '    """Calls login() for every request."""',
      '',
      '    default = login',
      '',
      '    def handle(self, req):',
      '        # login here is a comment',
      '        return auth.login(req.user, "login")',
      '',
      '    def login(self):',
      '        pass',
      '',
      '',
      'def main():',
      '    return f"{login(1)} login"',
    );
    expect(entries(await referencesIn('pkg/routes.py', src, ['login', 'auth']))).toEqual([
      ['login', ['@imports', 'Router.default', 'Router.handle', 'main']],
      ['auth', ['@imports', 'Router.handle']],
    ]);
  });

  it('Go: selector fields and receivers count (a package qualifier in a type does not)', async () => {
    const src = lines(
      'package routes',
      '',
      'import "example.com/app/auth"',
      '',
      '// Router calls auth.Login.',
      'type Router struct {',
      '\tsession *auth.Session',
      '}',
      '',
      'func (r *Router) Handle(user string) error {',
      '\t_, err := auth.Login(user, "auth.Login")',
      '\treturn err',
      '}',
      '',
      'func Login() {}',
    );
    expect(entries(await referencesIn('routes/routes.go', src, ['Login', 'Session', 'Router', 'auth']))).toEqual([
      ['Login', ['Router.Handle']],
      ['Session', ['Router']],
      ['Router', ['Router.Handle']],
      ['auth', ['Router.Handle']],
    ]);
  });

  it('Rust: paths, fields and macro arguments count, impl members are attributed to the member', async () => {
    const src = lines(
      'use crate::auth::login;',
      '',
      'pub struct Router {',
      '    login: fn(&str),',
      '}',
      '',
      'impl Router {',
      '    pub fn handle(&self, user: &str) {',
      '        // login(user) in a comment',
      '        crate::auth::login(user);',
      '        println!("{}", login(user));',
      '        (self.login)("login");',
      '    }',
      '}',
    );
    expect(entries(await referencesIn('src/routes.rs', src, ['login']))).toEqual([['login', ['@imports', 'Router', 'Router.handle']]]);
  });

  it('Java: method invocations and types count, nested members are attributed to the member', async () => {
    const src = lines(
      'package routes;',
      '',
      'import auth.Auth;',
      '',
      'public class Router {',
      '    private Auth auth;',
      '',
      '    /** Calls Auth.login. */',
      '    void handle(String user) {',
      '        auth.login(user, "login");',
      '    }',
      '',
      '    static class Inner {',
      '        void run() { Auth.login(null, null); }',
      '    }',
      '}',
    );
    expect(entries(await referencesIn('src/routes/Router.java', src, ['login', 'Auth']))).toEqual([
      ['login', ['Router.handle', 'Router.Inner.run']],
      ['Auth', ['@imports', 'Router.auth', 'Router.Inner.run']],
    ]);
  });

  it('is null for an unsupported language, an unverified grammar, a binary or a too large file', async () => {
    expect(await referencesIn('README.md', 'login', ['login'])).toBeNull();
    expect(await referencesIn('a.ts', 'login();\0', ['login'])).toBeNull();
    expect(await referencesIn('a.ts', `login();\n// ${'x'.repeat(1024 * 1024)}\n`, ['login'])).toBeNull();
    const manifest: GrammarManifest = structuredClone(MANIFEST);
    manifest.grammars.typescript.sha256 = '0'.repeat(64);
    const rt = new GrammarRuntime({ manifest, warn: () => {} });
    expect(await referencesInWith(rt, 'a.ts', 'login();\n', ['login'])).toBeNull();
    expect(entries(await referencesInWith(rt, 'a.go', 'package a\n\nfunc F() { login() }\n', ['login']))).toEqual([['login', ['F']]]);
  });

  it('still answers in a file with a parse error (names are advisory)', async () => {
    const src = 'export function a() {\n  login(\n}\n\nexport function b() { login(); }\n';
    const refs = await referencesIn('a.ts', src, ['login']);
    expect(refs?.get('login')).toContain('b');
  });

  it('is on the symbols object too', async () => {
    expect(entries(await symbols.referencesIn('src/routes.ts', ROUTES_TS, ['Router']))).toEqual([]);
  });
});

describe('identifierIndex', () => {
  it('maps every identifier used to the keys it occurs in, in order of first use', async () => {
    const src = lines(
      "import { a } from './a';",
      '',
      'export function f(x: number): number {',
      '  return a(x) + g();',
      '}',
      '',
      '// f is great',
      'const s = "g";',
      '',
      'function g() {',
      '  return f(1);',
      '}',
      '',
      'export class C extends Base {',
      '  m(): void {',
      '    this.n(s);',
      '  }',
      '',
      '  n(v: unknown): void {}',
      '}',
    );
    const index = await identifierIndex('src/f.ts', src);
    expect(index).toEqual({
      a: ['@imports', 'f'],
      x: ['f'],
      g: ['f'],
      f: ['g'],
      Base: ['C'],
      n: ['C.m'],
      s: ['C.m'],
      v: ['C.n'],
    });
    expect(Object.keys(index!)).toEqual(['a', 'x', 'g', 'f', 'Base', 'n', 's', 'v']);
  });

  it('is plain JSON-safe data, with no inherited names (constructor, __proto__, toString are ordinary identifiers)', async () => {
    const src = lines('export function f(o) {', '  o.constructor(o.__proto__);', '}', '', 'export function g(o) {', '  return o.toString;', '}');
    const index = await identifierIndex('a.js', src);
    expect(index).not.toBeNull();
    expect(Object.getPrototypeOf(index)).toBeNull();
    expect(Object.hasOwn(index!, 'hasOwnProperty')).toBe(false);
    expect(index!['constructor']).toEqual(['f']);
    expect(index!['__proto__']).toEqual(['f']);
    expect(index!['toString']).toEqual(['g']);
    expect(Object.entries(JSON.parse(JSON.stringify(index)) as object)).toEqual([
      ['o', ['f', 'g']],
      ['constructor', ['f']],
      ['__proto__', ['f']],
      ['toString', ['g']],
    ]);
  });

  it('agrees with referencesIn for every name it lists', async () => {
    const index = (await identifierIndex('src/routes.ts', ROUTES_TS))!;
    const names = Object.keys(index);
    // Declared names that nothing uses (banner, route, handle) are not there.
    expect(names).not.toContain('banner');
    expect(names).not.toContain('route');
    expect(names).toEqual(expect.arrayContaining(['login', 'Session', 'Request', 'req', 'user', 's', 'name', 'app', 'use', 'handleLogin']));
    const refs = (await referencesIn('src/routes.ts', ROUTES_TS, names))!;
    expect(Object.fromEntries(refs)).toEqual({ ...index });
  });

  it('works in every language', async () => {
    const cases: Array<[string, string, Record<string, string[]>]> = [
      ['a.py', 'import os\n\ndef f(p):\n    return os.path.join(p)\n', { os: ['@imports', 'f'], p: ['f'], path: ['f'], join: ['f'] }],
      ['a.go', 'package a\n\nimport "os"\n\nfunc F(p string) { os.Exit(len(p)) }\n', { p: ['F'], string: ['F'], os: ['F'], Exit: ['F'], len: ['F'] }],
      ['a.rs', 'use std::fs;\n\nfn f(p: &str) -> usize { fs::read(p).len() }\n', { std: ['@imports'], fs: ['@imports', 'f'], p: ['f'], read: ['f'], len: ['f'] }],
      ['A.java', 'import java.util.List;\n\nclass A {\n  int f(List<String> xs) { return xs.size(); }\n}\n', { java: ['@imports'], util: ['@imports'], List: ['@imports', 'A.f'], String: ['A.f'], xs: ['A.f'], size: ['A.f'] }],
    ];
    for (const [file, src, expected] of cases) expect({ file, index: await identifierIndex(file, src) }).toEqual({ file, index: expected });
  });

  it('is null where the file cannot be mapped', async () => {
    expect(await identifierIndex('a.txt', 'x')).toBeNull();
    expect(await identifierIndex('a.ts', '\0')).toBeNull();
  });
});

describe('freeKeys', () => {
  const AUTH = lines(
    "import { db } from './db';",
    '',
    'export function login(user: string): string;',
    'export function login(user: any) { return db.find(user); }',
    '',
    'export function logout(): void {}',
    '',
    'export function refreshToken(): void {}',
    '',
    'export class Session {',
    '  refresh(): void {}',
    '',
    '  close(): void {}',
    '}',
    '',
    "console.log('ready');",
  );
  const ALL = ['@imports', 'login', 'logout', 'refreshToken', 'Session', '@toplevel'];

  it('lists every top-level key once, in source order, when nothing is held', async () => {
    expect(await freeKeys('src/auth.ts', AUTH, [])).toEqual(ALL);
  });

  it('leaves out each key a held entry overlaps (the design §3.12 deny message)', async () => {
    expect(await freeKeys('src/auth.ts', AUTH, [{ symbol: 'login' }])).toEqual(['@imports', 'logout', 'refreshToken', 'Session', '@toplevel']);
    expect(await freeKeys('src/auth.ts', AUTH, [{ symbol: 'login' }, { symbol: '@toplevel' }, { symbol: 'logout' }])).toEqual(['@imports', 'refreshToken', 'Session']);
  });

  it('a held member overlaps its container; a held container overlaps only itself at top level', async () => {
    expect(await freeKeys('src/auth.ts', AUTH, [{ symbol: 'Session.refresh' }])).toEqual(['@imports', 'login', 'logout', 'refreshToken', '@toplevel']);
    expect(await freeKeys('src/auth.ts', AUTH, [{ symbol: 'Session' }])).toEqual(['@imports', 'login', 'logout', 'refreshToken', '@toplevel']);
    // A prefix of a name is not a container of it.
    expect(await freeKeys('src/auth.ts', AUTH, [{ symbol: 'log' }])).toEqual(ALL);
  });

  it('@imports never overlaps @imports, so it stays free', async () => {
    expect(await freeKeys('src/auth.ts', AUTH, [{ symbol: '@imports' }])).toEqual(ALL);
  });

  it('a whole-file entry overlaps everything', async () => {
    expect(await freeKeys('src/auth.ts', AUTH, [{}])).toEqual([]);
    expect(await freeKeys('src/auth.ts', AUTH, [{ symbol: 'login' }, { symbol: undefined }])).toEqual([]);
  });

  it('works in every language', async () => {
    expect(await freeKeys('a.py', 'import os\n\n\ndef f():\n    pass\n\n\nclass C:\n    def m(self):\n        pass\n', [{ symbol: 'C.m' }])).toEqual(['@imports', 'f']);
    expect(await freeKeys('a.go', 'package a\n\nfunc F() {}\n\nfunc (s *S) M() {}\n\ntype S struct{}\n', [{ symbol: 'S' }])).toEqual(['@imports', 'F']);
    expect(await freeKeys('a.rs', 'struct S;\n\nimpl S {\n    fn m(&self) {}\n}\n\nfn f() {}\n', [{ symbol: 'f' }])).toEqual(['S']);
    expect(await freeKeys('A.java', 'package a;\n\nclass A {}\n\nclass B {}\n', [{ symbol: 'A' }])).toEqual(['@imports', 'B']);
  });

  it('is null where the file cannot be mapped at symbol level (unsupported, binary, an uncontained parse error)', async () => {
    expect(await freeKeys('a.md', '# x', [])).toBeNull();
    expect(await freeKeys('a.ts', 'function f() {}\0', [])).toBeNull();
    expect(await freeKeys('a.ts', 'export function f( {\n', [])).toBeNull();
    // A contained error leaves the outline usable.
    expect(await freeKeys('a.ts', 'export function f() { return +; }\nexport function g() {}\n', [])).toEqual(['f', 'g']);
  });
});

describe('importsText', () => {
  it('TS/JS: import statements, re-exports, require() and import() calls, anywhere in the file, one per line, comments removed and whitespace collapsed', async () => {
    const src = lines(
      "import { login } from './auth'; // the auth module",
      "import type { Config } from '../config/index';",
      "export { db } from './db';",
      "export * from './shared/types';",
      '',
      'export function lazy() {',
      "  return import('./lazy/loader');",
      '}',
      '',
      "const legacy = require('./legacy');",
      "const notAnImport = requireAll('./nope');",
      '',
      'export const x = { /* ./commented */ };',
    );
    expect(await importsText('src/a.ts', src)).toBe(
      [
        "import { login } from './auth';",
        "import type { Config } from '../config/index';",
        "export { db } from './db';",
        "export * from './shared/types';",
        "import('./lazy/loader')",
        "require('./legacy')",
      ].join('\n'),
    );
  });

  it('Python: imports at any depth, the future import included', async () => {
    const src = lines('from __future__ import annotations', 'import os.path  # paths', 'from .auth import login', '', '', 'def f():', '    from ..store import Store', '    return Store', '', 'x = "import nope"');
    expect(await importsText('pkg/a.py', src)).toBe(['from __future__ import annotations', 'import os.path', 'from .auth import login', 'from ..store import Store'].join('\n'));
  });

  it('Go: the import declarations, not the package clause', async () => {
    const src = lines('package routes', '', 'import (', '\t"fmt"', '\t// the auth package', '\tauthz "example.com/app/auth"', ')', '', 'import "os"', '', 'func F() { fmt.Println(authz.X, os.Args) }');
    expect(await importsText('routes/a.go', src)).toBe(['import ( "fmt" authz "example.com/app/auth" )', 'import "os"'].join('\n'));
  });

  it('Rust: use declarations at any depth, extern crates and module declarations', async () => {
    const src = lines('extern crate serde;', 'use crate::auth::{login, Session};', 'mod store;', '', 'mod inner {', '    use super::db;', '}', '', 'fn f() {', '    use std::fmt::Write;', '}');
    expect(await importsText('src/lib.rs', src)).toBe(['extern crate serde;', 'use crate::auth::{login, Session};', 'mod store;', 'use super::db;', 'use std::fmt::Write;'].join('\n'));
  });

  it('Java: the import declarations', async () => {
    const src = lines('package routes;', '', 'import auth.Auth;', 'import static auth.Tokens.refresh;', '', 'class Router {}');
    expect(await importsText('src/routes/Router.java', src)).toBe(['import auth.Auth;', 'import static auth.Tokens.refresh;'].join('\n'));
  });

  it("is '' with no imports, and null for an unsupported file", async () => {
    expect(await importsText('a.ts', 'export const x = 1;\n')).toBe('');
    expect(await importsText('a.css', '@import "x.css";')).toBeNull();
  });
});
