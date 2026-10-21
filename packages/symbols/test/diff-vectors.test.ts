// S3: the changedSymbols vector suite (design §5.1, §1.10 "How edits map to
// keys"), the same edits in all seven languages: body edit, signature edit,
// insert between, insert of a duplicate name, delete, rename (2 keys), move
// within the file, import edit, detached-comment edit, whitespace-only edit
// (@toplevel), contained parse error, uncontained error (file level), 13 keys
// (file level), new and deleted file; plus the member edits of a container.
// Every edit goes through applyEdit/applyEdits, as the pre-edit hook does.
import { describe, expect, it } from 'vitest';
import { applyEdits, changedSymbols, MAPPER_VERSION } from '../src/index.js';
import type { LanguageId, SignatureChange, SymbolDiff, TextEdit } from '../src/types.js';

type Pair = [old: string, replacement: string];

interface Lang {
  lang: LanguageId;
  path: string;
  base: string;
  /** Keys: the three functions (Java: methods of Auth), and what the vectors add. */
  a: string;
  b: string;
  c: string;
  helper: string;
  b2: string;
  /** The exact text of each function's declaration in `base`, and what separates them. */
  aDecl: string;
  bDecl: string;
  cDecl: string;
  sep: string;
  /** A new function (Java: method) named `name`, indented as a sibling of a, b and c. */
  fn(name: string): string;
  body: Pair;
  signature: Pair;
  aSig: { before: string; after: string };
  bSig: string;
  b2Sig: string;
  rename: Pair;
  imports: Pair;
  comment: Pair;
  containedError: Pair;
  uncontainedError: Pair;
  /** The container (`Session`), and its members. */
  container: string;
  memberBody: Pair;
  memberKey: string;
  header: Pair;
  headerSig: { before: string; after: string };
  /** The text of the member `refresh` (with its leading indentation) and of the last member, for the member move. */
  refreshDecl: string;
  lastMemberDecl: string;
  memberSep: string;
  refreshKey: string;
  /** A new member, inserted after the last member. */
  member(name: string): string;
  addedKey: string;
}

const lines = (...xs: string[]): string => `${xs.join('\n')}\n`;

const TS_BASE = lines(
  "import { readFile } from 'node:fs/promises';",
  "import type { Config } from './config';",
  '',
  '// Detached note about this module.',
  '',
  'export function a(x: number): number {',
  '  return x + 1;',
  '}',
  '',
  'function b(s: string): string {',
  '  return s.trim();',
  '}',
  '',
  'export function c(): void {',
  "  console.log('c');",
  '}',
  '',
  'export class Session {',
  '  ttl = 60;',
  '',
  '  refresh(force: boolean): void {',
  '    this.ttl = force ? 0 : this.ttl;',
  '  }',
  '',
  '  close(): void {}',
  '',
  '  open(): void {}',
  '}',
);

const ecma = (lang: LanguageId, path: string, base: string, typed: boolean): Lang => ({
  lang,
  path,
  base,
  a: 'a',
  b: 'b',
  c: 'c',
  helper: 'helper',
  b2: 'b2',
  aDecl: typed ? 'export function a(x: number): number {\n  return x + 1;\n}' : 'export function a(x) {\n  return x + 1;\n}',
  bDecl: typed ? 'function b(s: string): string {\n  return s.trim();\n}' : 'function b(s) {\n  return s.trim();\n}',
  cDecl: typed ? "export function c(): void {\n  console.log('c');\n}" : "export function c() {\n  console.log('c');\n}",
  sep: '\n\n',
  fn: (name) => (typed ? `function ${name}(): number {\n  return 1;\n}` : `function ${name}() {\n  return 1;\n}`),
  body: ['return x + 1;', 'return x + 2;'],
  signature: typed ? ['a(x: number): number', 'a(x: number, y = 0): number'] : ['function a(x)', 'function a(x, y = 0)'],
  aSig: typed
    ? { before: 'function a(x: number): number', after: 'function a(x: number, y = 0): number' }
    : { before: 'function a(x)', after: 'function a(x, y = 0)' },
  bSig: typed ? 'function b(s: string): string' : 'function b(s)',
  b2Sig: typed ? 'function b2(s: string): string' : 'function b2(s)',
  rename: ['function b(', 'function b2('],
  imports: typed ? ["from 'node:fs/promises'", "from 'node:fs'"] : ["from 'node:path'", "from 'path'"],
  comment: ['// Detached note about this module.', '// Detached note about the module.'],
  containedError: ['return x + 1;', 'return x + ;'],
  uncontainedError: typed ? ['export function c(): void {', 'export function c( {'] : ['export function c() {', 'export function c( {'],
  container: 'Session',
  memberBody: ['this.ttl = force ? 0 : this.ttl;', 'this.ttl = 0;'],
  memberKey: 'Session.refresh',
  header: ['export class Session {', 'export class Session extends Base {'],
  headerSig: { before: 'class Session', after: 'class Session extends Base' },
  refreshDecl: typed ? '  refresh(force: boolean): void {\n    this.ttl = force ? 0 : this.ttl;\n  }' : '  refresh(force) {\n    this.ttl = force ? 0 : this.ttl;\n  }',
  lastMemberDecl: typed ? '  open(): void {}' : '  open() {}',
  memberSep: '\n\n',
  refreshKey: 'Session.refresh',
  member: (name) => (typed ? `  ${name}(): void {}` : `  ${name}() {}`),
  addedKey: 'Session.reset',
});

const TSX_BASE = TS_BASE.replace("import type { Config } from './config';", "import React from 'react';").replace(
  "export function c(): void {\n  console.log('c');\n}",
  "export function c(): JSX.Element {\n  return <div className=\"c\">{'c'}</div>;\n}",
);

const JS_BASE = lines(
  "import { readFile } from 'node:fs/promises';",
  "import path from 'node:path';",
  '',
  '// Detached note about this module.',
  '',
  'export function a(x) {',
  '  return x + 1;',
  '}',
  '',
  'function b(s) {',
  '  return s.trim();',
  '}',
  '',
  'export function c() {',
  "  console.log('c');",
  '}',
  '',
  'export class Session {',
  '  ttl = 60;',
  '',
  '  refresh(force) {',
  '    this.ttl = force ? 0 : this.ttl;',
  '  }',
  '',
  '  close() {}',
  '',
  '  open() {}',
  '}',
);

const PY_BASE = lines(
  'import os',
  'from typing import Optional',
  '',
  '# Detached note about this module.',
  '',
  '',
  'def a(x: int) -> int:',
  '    return x + 1',
  '',
  '',
  'def b(s: str) -> str:',
  '    return s.strip()',
  '',
  '',
  'def c() -> None:',
  '    print("c")',
  '',
  '',
  'class Session:',
  '    ttl = 60',
  '',
  '    def refresh(self, force: bool) -> None:',
  '        self.ttl = 0 if force else self.ttl',
  '',
  '    def close(self) -> None:',
  '        pass',
  '',
  '    def open(self) -> None:',
  '        pass',
);

const GO_BASE = lines(
  'package auth',
  '',
  'import (',
  '\t"fmt"',
  '\t"strings"',
  ')',
  '',
  '// Detached note about this file.',
  '',
  'func A(x int) int {',
  '\treturn x + 1',
  '}',
  '',
  'func B(s string) string {',
  '\treturn strings.TrimSpace(s)',
  '}',
  '',
  'func C() {',
  '\tfmt.Println("c")',
  '}',
  '',
  'type Session struct {',
  '\tTTL int',
  '}',
  '',
  'func (s *Session) Refresh(force bool) {',
  '\tif force {',
  '\t\ts.TTL = 0',
  '\t}',
  '}',
  '',
  'func (s *Session) Close() {}',
  '',
  'func (s *Session) Open() {}',
);

const RS_BASE = lines(
  'use std::fmt;',
  'use std::collections::HashMap;',
  '',
  '// Detached note about this crate.',
  '',
  'pub fn a(x: i32) -> i32 {',
  '    x + 1',
  '}',
  '',
  'fn b(s: &str) -> String {',
  '    s.trim().to_string()',
  '}',
  '',
  'pub fn c() {',
  '    println!("c");',
  '}',
  '',
  'pub struct Session {',
  '    ttl: u64,',
  '}',
  '',
  'impl Session {',
  '    pub fn refresh(&mut self, force: bool) {',
  '        if force {',
  '            self.ttl = 0;',
  '        }',
  '    }',
  '',
  '    pub fn close(&self) {}',
  '',
  '    pub fn open(&self) {}',
  '}',
);

const JAVA_BASE = lines(
  'package com.example;',
  '',
  'import java.util.List;',
  '',
  '// Detached note about this file.',
  '',
  'public class Auth {',
  '    public int a(int x) {',
  '        return x + 1;',
  '    }',
  '',
  '    String b(String s) {',
  '        return s.trim();',
  '    }',
  '',
  '    void c() {',
  '        System.out.println("c");',
  '    }',
  '}',
  '',
  'class Session {',
  '    int ttl = 60;',
  '',
  '    void refresh(boolean force) {',
  '        ttl = force ? 0 : ttl;',
  '    }',
  '',
  '    void close() {}',
  '',
  '    void open() {}',
  '}',
);

const LANGS: Lang[] = [
  ecma('typescript', 'src/auth.ts', TS_BASE, true),
  {
    ...ecma('tsx', 'src/auth.tsx', TSX_BASE, true),
    cDecl: "export function c(): JSX.Element {\n  return <div className=\"c\">{'c'}</div>;\n}",
    uncontainedError: ['export function c(): JSX.Element {', 'export function c( {'],
  },
  ecma('javascript', 'src/auth.js', JS_BASE, false),
  {
    lang: 'python',
    path: 'auth/session.py',
    base: PY_BASE,
    a: 'a',
    b: 'b',
    c: 'c',
    helper: 'helper',
    b2: 'b2',
    aDecl: 'def a(x: int) -> int:\n    return x + 1',
    bDecl: 'def b(s: str) -> str:\n    return s.strip()',
    cDecl: 'def c() -> None:\n    print("c")',
    sep: '\n\n\n',
    fn: (name) => `def ${name}() -> int:\n    return 1`,
    body: ['return x + 1', 'return x + 2'],
    signature: ['def a(x: int) -> int:', 'def a(x: int, y: int = 0) -> int:'],
    aSig: { before: 'def a(x: int) -> int', after: 'def a(x: int, y: int = 0) -> int' },
    bSig: 'def b(s: str) -> str',
    b2Sig: 'def b2(s: str) -> str',
    rename: ['def b(', 'def b2('],
    imports: ['import os', 'import os.path'],
    comment: ['# Detached note about this module.', '# Detached note about the module.'],
    containedError: ['return x + 1', 'return x +'],
    uncontainedError: ['def c() -> None:', 'def c( -> None:'],
    container: 'Session',
    memberBody: ['self.ttl = 0 if force else self.ttl', 'self.ttl = 0'],
    memberKey: 'Session.refresh',
    header: ['class Session:', 'class Session(Base):'],
    headerSig: { before: 'class Session', after: 'class Session(Base)' },
    refreshDecl: '    def refresh(self, force: bool) -> None:\n        self.ttl = 0 if force else self.ttl',
    lastMemberDecl: '    def open(self) -> None:\n        pass',
    memberSep: '\n\n',
    refreshKey: 'Session.refresh',
    member: (name) => `    def ${name}(self) -> None:\n        pass`,
    addedKey: 'Session.reset',
  },
  {
    lang: 'go',
    path: 'auth/session.go',
    base: GO_BASE,
    a: 'A',
    b: 'B',
    c: 'C',
    helper: 'Helper',
    b2: 'B2',
    aDecl: 'func A(x int) int {\n\treturn x + 1\n}',
    bDecl: 'func B(s string) string {\n\treturn strings.TrimSpace(s)\n}',
    cDecl: 'func C() {\n\tfmt.Println("c")\n}',
    sep: '\n\n',
    fn: (name) => `func ${name}() int {\n\treturn 1\n}`,
    body: ['return x + 1', 'return x + 2'],
    signature: ['func A(x int) int', 'func A(x int, y int) int'],
    aSig: { before: 'func A(x int) int', after: 'func A(x int, y int) int' },
    bSig: 'func B(s string) string',
    b2Sig: 'func B2(s string) string',
    rename: ['func B(', 'func B2('],
    imports: ['\t"strings"\n', '\t"os"\n\t"strings"\n'],
    comment: ['// Detached note about this file.', '// Detached note about the file.'],
    containedError: ['return x + 1', 'return x +'],
    uncontainedError: ['func C() {', 'func C( {'],
    container: 'Session',
    memberBody: ['\t\ts.TTL = 0', '\t\ts.TTL = -1'],
    memberKey: 'Session.Refresh',
    header: ['\tTTL int\n', '\tTTL int\n\tID  string\n'],
    headerSig: { before: 'type Session struct { TTL int }', after: 'type Session struct { TTL int ID string }' },
    refreshDecl: 'func (s *Session) Refresh(force bool) {\n\tif force {\n\t\ts.TTL = 0\n\t}\n}',
    lastMemberDecl: 'func (s *Session) Open() {}',
    memberSep: '\n\n',
    refreshKey: 'Session.Refresh',
    member: (name) => `func (s *Session) ${name}() {}`,
    addedKey: 'Session.Reset',
  },
  {
    lang: 'rust',
    path: 'src/session.rs',
    base: RS_BASE,
    a: 'a',
    b: 'b',
    c: 'c',
    helper: 'helper',
    b2: 'b2',
    aDecl: 'pub fn a(x: i32) -> i32 {\n    x + 1\n}',
    bDecl: 'fn b(s: &str) -> String {\n    s.trim().to_string()\n}',
    cDecl: 'pub fn c() {\n    println!("c");\n}',
    sep: '\n\n',
    fn: (name) => `fn ${name}() -> i32 {\n    1\n}`,
    body: ['    x + 1\n', '    x + 2\n'],
    signature: ['pub fn a(x: i32) -> i32', 'pub fn a(x: i32, y: i32) -> i32'],
    aSig: { before: 'pub fn a(x: i32) -> i32', after: 'pub fn a(x: i32, y: i32) -> i32' },
    bSig: 'fn b(s: &str) -> String',
    b2Sig: 'fn b2(s: &str) -> String',
    rename: ['fn b(', 'fn b2('],
    imports: ['use std::fmt;', 'use std::fmt::Display;'],
    comment: ['// Detached note about this crate.', '// Detached note about the crate.'],
    containedError: ['    x + 1\n', '    let y = x + ;\n    y\n'],
    uncontainedError: ['pub fn c() {', 'pub fn c( {'],
    container: 'Session',
    memberBody: ['            self.ttl = 0;', '            self.ttl = 1;'],
    memberKey: 'Session.refresh',
    header: ['impl Session {', 'impl<T> Session<T> {'],
    // The struct and its impl share the key: their signatures are compared together.
    headerSig: { before: 'pub struct Session { ttl: u64, }\nimpl Session', after: 'pub struct Session { ttl: u64, }\nimpl<T> Session<T>' },
    refreshDecl: '    pub fn refresh(&mut self, force: bool) {\n        if force {\n            self.ttl = 0;\n        }\n    }',
    lastMemberDecl: '    pub fn open(&self) {}',
    memberSep: '\n\n',
    refreshKey: 'Session.refresh',
    member: (name) => `    pub fn ${name}(&self) {}`,
    addedKey: 'Session.reset',
  },
  {
    lang: 'java',
    path: 'src/main/java/com/example/Auth.java',
    base: JAVA_BASE,
    a: 'Auth.a',
    b: 'Auth.b',
    c: 'Auth.c',
    helper: 'Auth.helper',
    b2: 'Auth.b2',
    aDecl: '    public int a(int x) {\n        return x + 1;\n    }',
    bDecl: '    String b(String s) {\n        return s.trim();\n    }',
    cDecl: '    void c() {\n        System.out.println("c");\n    }',
    sep: '\n\n',
    fn: (name) => `    int ${name}() {\n        return 1;\n    }`,
    body: ['return x + 1;', 'return x + 2;'],
    signature: ['public int a(int x)', 'public int a(int x, int y)'],
    aSig: { before: 'public int a(int x)', after: 'public int a(int x, int y)' },
    bSig: 'String b(String s)',
    b2Sig: 'String b2(String s)',
    rename: ['String b(', 'String b2('],
    imports: ['import java.util.List;', 'import java.util.Map;'],
    comment: ['// Detached note about this file.', '// Detached note about the file.'],
    containedError: ['return x + 1;', 'return x + ;'],
    uncontainedError: ['class Session {', 'class Session( {'],
    container: 'Session',
    memberBody: ['ttl = force ? 0 : ttl;', 'ttl = 0;'],
    memberKey: 'Session.refresh',
    header: ['class Session {', 'class Session extends Base {'],
    headerSig: { before: 'class Session', after: 'class Session extends Base' },
    refreshDecl: '    void refresh(boolean force) {\n        ttl = force ? 0 : ttl;\n    }',
    lastMemberDecl: '    void open() {}',
    memberSep: '\n\n',
    refreshKey: 'Session.refresh',
    member: (name) => `    void ${name}() {}`,
    addedKey: 'Session.reset',
  },
];

const edit = ([old_string, new_string]: Pair): TextEdit => ({ old_string, new_string });

function after(l: Lang, edits: TextEdit[]): string {
  const out = applyEdits(l.base, edits);
  if (out === null) throw new Error(`a vector edit does not apply to the ${l.lang} base: ${JSON.stringify(edits)}`);
  return out;
}

async function diff(l: Lang, edits: TextEdit[], o?: { maxSymbols?: number }): Promise<SymbolDiff> {
  return changedSymbols(l.path, l.base, after(l, edits), o);
}

function symbolsOf(d: SymbolDiff): string[] {
  if (d.fileLevel) throw new Error(`expected a symbol-level diff, got file level (${d.reason})`);
  return [...d.symbols].sort();
}

function sigs(d: SymbolDiff): SignatureChange[] {
  if (d.fileLevel) throw new Error(`expected a symbol-level diff, got file level (${d.reason})`);
  return d.signatureChanges;
}

describe.each(LANGS)('changedSymbols vectors: $lang', (l) => {
  it('the base is clean, and an unchanged file changes nothing', async () => {
    const d = await changedSymbols(l.path, l.base, l.base);
    expect(d).toEqual({ fileLevel: false, symbols: [], signatureChanges: [], mapper: MAPPER_VERSION });
  });

  it('a body edit claims that function only, with no signature change', async () => {
    const d = await diff(l, [edit(l.body)]);
    expect(symbolsOf(d)).toEqual([l.a]);
    expect(sigs(d)).toEqual([]);
    expect(d.mapper).toBe(MAPPER_VERSION);
  });

  it('a signature edit claims that function and reports the signature change', async () => {
    const d = await diff(l, [edit(l.signature)]);
    expect(symbolsOf(d)).toEqual([l.a]);
    expect(sigs(d)).toEqual([{ symbol: l.a, kind: 'signature', before: l.aSig.before, after: l.aSig.after }]);
  });

  it('inserting a function between two others claims the new key only', async () => {
    const d = await diff(l, [{ old_string: l.aDecl + l.sep, new_string: l.aDecl + l.sep + l.fn(l.helper.split('.').pop()!) + l.sep }]);
    expect(symbolsOf(d)).toEqual([l.helper]);
    expect(sigs(d)).toEqual([]);
  });

  it('inserting a function whose name exists elsewhere in the file claims that key', async () => {
    const d = await diff(l, [{ old_string: l.aDecl + l.sep, new_string: l.aDecl + l.sep + l.fn(l.c.split('.').pop()!) + l.sep }]);
    expect(symbolsOf(d)).toEqual([l.c]);
  });

  it('deleting a function claims it and reports it removed', async () => {
    const d = await diff(l, [{ old_string: l.bDecl + l.sep, new_string: '' }]);
    expect(symbolsOf(d)).toEqual([l.b]);
    expect(sigs(d)).toEqual([{ symbol: l.b, kind: 'removed', before: l.bSig, after: null }]);
  });

  it('renaming a function claims both keys and reports the rename', async () => {
    const d = await diff(l, [edit(l.rename)]);
    expect(symbolsOf(d)).toEqual([l.b, l.b2].sort());
    expect(sigs(d)).toEqual([{ symbol: l.b, kind: 'renamed', before: l.bSig, after: l.b2Sig, renamed_to: l.b2 }]);
  });

  it('moving a function within the file claims that key (outside the LCS of the key sequences)', async () => {
    const d = await diff(l, [
      { old_string: l.aDecl + l.sep, new_string: '' },
      { old_string: l.cDecl, new_string: l.cDecl + l.sep + l.aDecl },
    ]);
    expect(symbolsOf(d)).toEqual([l.a]);
    expect(sigs(d)).toEqual([]);
  });

  it('an import edit claims @imports', async () => {
    expect(symbolsOf(await diff(l, [edit(l.imports)]))).toEqual(['@imports']);
  });

  it('editing a detached comment claims @toplevel', async () => {
    expect(symbolsOf(await diff(l, [edit(l.comment)]))).toEqual(['@toplevel']);
  });

  it('a whitespace-only edit between declarations claims @toplevel', async () => {
    expect(symbolsOf(await diff(l, [{ old_string: l.aDecl + l.sep, new_string: `${l.aDecl}${l.sep}\n` }]))).toEqual(['@toplevel']);
  });

  it('a syntax error contained in a function body claims that function', async () => {
    expect(symbolsOf(await diff(l, [edit(l.containedError)]))).toEqual([l.a]);
  });

  it('an uncontained syntax error makes the edit file level (parse_error)', async () => {
    expect(await diff(l, [edit(l.uncontainedError)])).toEqual({ fileLevel: true, reason: 'parse_error', mapper: MAPPER_VERSION });
  });

  it('13 keys are too many (file level), 12 are not', async () => {
    const names = Array.from({ length: 13 }, (_, i) => `n${i + 1}`);
    const insert = (k: number): TextEdit => ({ old_string: l.aDecl + l.sep, new_string: l.aDecl + l.sep + names.slice(0, k).map((n) => l.fn(n) + l.sep).join('') });
    expect(await diff(l, [insert(13)])).toEqual({ fileLevel: true, reason: 'too_many_symbols', mapper: MAPPER_VERSION });
    const twelve = await diff(l, [insert(12)]);
    expect(symbolsOf(twelve)).toHaveLength(12);
    // The limit is the caller's: the lander maps a landing diff with 40.
    expect(symbolsOf(await diff(l, [insert(13)], { maxSymbols: 40 }))).toHaveLength(13);
  });

  it('a new file and a deleted file are file level', async () => {
    expect(await changedSymbols(l.path, null, l.base)).toEqual({ fileLevel: true, reason: 'new_file', mapper: MAPPER_VERSION });
    expect(await changedSymbols(l.path, l.base, null)).toEqual({ fileLevel: true, reason: 'deleted_file', mapper: MAPPER_VERSION });
  });

  it('a member body edit claims that member only', async () => {
    const d = await diff(l, [edit(l.memberBody)]);
    expect(symbolsOf(d)).toEqual([l.memberKey]);
    expect(sigs(d)).toEqual([]);
  });

  it('a container header edit claims the container (which conflicts with all its members)', async () => {
    const d = await diff(l, [edit(l.header)]);
    expect(symbolsOf(d)).toEqual([l.container]);
    expect(sigs(d)).toEqual([{ symbol: l.container, kind: 'signature', ...l.headerSig }]);
  });

  it('adding a member claims the new member only', async () => {
    const d = await diff(l, [{ old_string: l.lastMemberDecl, new_string: `${l.lastMemberDecl}${l.memberSep}${l.member(l.addedKey.split('.').pop()!)}` }]);
    expect(symbolsOf(d)).toEqual([l.addedKey]);
  });

  it('moving a member within its container claims that member', async () => {
    const d = await diff(l, [
      { old_string: l.refreshDecl + l.memberSep, new_string: '' },
      { old_string: l.lastMemberDecl, new_string: l.lastMemberDecl + l.memberSep + l.refreshDecl },
    ]);
    expect(symbolsOf(d)).toEqual([l.refreshKey]);
  });
});
