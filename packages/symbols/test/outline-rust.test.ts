// S2: Rust outlines (design §1.10 keys, §2.4 the Rust row and signatures).
import { describe, expect, it } from 'vitest';
import { outline } from '../src/index.js';
import { expectWellFormed, find, fixture, keys, view } from './helpers.js';

const SAMPLE = fixture('outline/sample.rs');

describe('the Rust fixture', () => {
  it('has the expected keys, kinds, spans and signatures', async () => {
    const o = await outline(SAMPLE, 'rust');
    expect(o.language).toBe('rust');
    expect(o.errors).toBe('none');
    expect(o.errorKeys).toEqual([]);
    expect(view(SAMPLE, o.items)).toEqual([
      { key: '@toplevel', kind: 'toplevel', lines: '1', head: '//! Sample Rust crate for the outline tests (and the mapping property test).', tail: '//! Sample Rust crate for the outline tests (and the mapping property test).', signature: null },
      { key: '@imports', kind: 'imports', lines: '3-5', head: 'use std::fmt;', tail: 'extern crate serde;', signature: null },
      { key: 'login', kind: 'function', lines: '7-11', head: '// Grüße, naïve café ✓ 😀: non-ASCII text before a declaration', tail: '}', signature: 'pub fn login(user: &str, password: &str) -> Result<Session, Error>' },
      { key: '@toplevel', kind: 'toplevel', lines: '13-15', head: '// A detached note about the crate.', tail: 'mod external;', signature: null },
      { key: 'Session', kind: 'struct', lines: '17-22', head: '/// A session.', tail: '}', signature: 'pub struct Session<T> { id: String, store: T, }' },
      {
        key: 'Session',
        kind: 'impl',
        lines: '24-36',
        head: 'impl<T: Store + Send> Session<T> {',
        tail: '}',
        signature: 'impl<T: Store + Send> Session<T>',
        members: [
          { key: 'Session.TTL', kind: 'field', lines: '25-26', head: '/// How long a session lives.', tail: '    pub const TTL: u64 = 3600;', signature: 'pub const TTL: u64' },
          { key: 'Session.new', kind: 'method', lines: '28-30', head: 'pub fn new(store: T) -> Self {', tail: '    }', signature: 'pub fn new(store: T) -> Self' },
          { key: 'Session.refresh', kind: 'method', lines: '32-35', head: '#[inline]', tail: '    }', signature: 'pub fn refresh(&mut self, force: bool) -> Result<(), Error>' },
        ],
      },
      {
        key: 'Session',
        kind: 'impl',
        lines: '38-42',
        head: 'impl<T> fmt::Display for Session<T> {',
        tail: '}',
        signature: 'impl<T> fmt::Display for Session<T>',
        members: [{ key: 'Session.fmt', kind: 'method', lines: '39-41', head: "fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {", tail: '    }', signature: "fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result" }],
      },
      {
        key: 'Session',
        kind: 'impl',
        lines: '44-48',
        head: 'impl Refresh for Session<String> {',
        tail: '}',
        signature: 'impl Refresh for Session<String>',
        members: [{ key: 'Session.refresh', kind: 'method', lines: '45-47', head: 'fn refresh(&mut self, force: bool) -> Result<(), Error> {', tail: '    }', signature: 'fn refresh(&mut self, force: bool) -> Result<(), Error>' }],
      },
      {
        key: 'Store',
        kind: 'trait',
        lines: '50-57',
        head: 'pub trait Store {',
        tail: '}',
        signature: 'pub trait Store',
        members: [
          { key: 'Store.Key', kind: 'type', lines: '51', head: 'type Key;', tail: 'type Key;', signature: 'type Key' },
          { key: 'Store.LIMIT', kind: 'field', lines: '52', head: 'const LIMIT: usize;', tail: 'const LIMIT: usize;', signature: 'const LIMIT: usize' },
          { key: 'Store.get', kind: 'method', lines: '53', head: 'fn get(&self, id: &str) -> Option<Self::Key>;', tail: 'fn get(&self, id: &str) -> Option<Self::Key>;', signature: 'fn get(&self, id: &str) -> Option<Self::Key>' },
          { key: 'Store.rotate', kind: 'method', lines: '54-56', head: 'fn rotate(&mut self, force: bool) -> Result<(), Error> {', tail: '    }', signature: 'fn rotate(&mut self, force: bool) -> Result<(), Error>' },
        ],
      },
      { key: 'Role', kind: 'enum', lines: '59-62', head: 'pub enum Role {', tail: '}', signature: 'pub enum Role { Admin, User(u32), }' },
      { key: 'Res', kind: 'type', lines: '64', head: 'pub type Res<T> = std::result::Result<T, Error>;', tail: 'pub type Res<T> = std::result::Result<T, Error>;', signature: 'pub type Res<T> = std::result::Result<T, Error>' },
      { key: 'COUNT', kind: 'variable', lines: '66', head: 'static COUNT: AtomicUsize = AtomicUsize::new(0);', tail: 'static COUNT: AtomicUsize = AtomicUsize::new(0);', signature: 'static COUNT: AtomicUsize' },
      {
        key: 'auth',
        kind: 'namespace',
        lines: '68-74',
        head: 'pub mod auth {',
        tail: '}',
        signature: 'pub mod auth',
        members: [{ key: 'auth.check', kind: 'function', lines: '71-73', head: "pub fn check(token: &'static str) -> bool {", tail: '    }', signature: "pub fn check(token: &'static str) -> bool" }],
      },
      { key: 'log', kind: 'function', lines: '76-78', head: 'macro_rules! log {', tail: '}', signature: null },
      { key: '@toplevel', kind: 'toplevel', lines: '80', head: 'fn r#match() {}', tail: 'fn r#match() {}', signature: null },
    ]);
    expectWellFormed(SAMPLE, o);
  });

  it('keys members of an inherent impl and of a trait impl alike as Session.refresh', async () => {
    const o = await outline(SAMPLE, 'rust');
    const refreshes = o.items.filter((i) => i.key === 'Session').flatMap((i) => i.members.filter((m) => m.key === 'Session.refresh'));
    expect(refreshes.map((m) => SAMPLE.slice(m.start, m.end).split('\n')[0])).toEqual(['#[inline]', 'fn refresh(&mut self, force: bool) -> Result<(), Error> {']);
    expect(find(o.items, 'login').start).toBe(SAMPLE.indexOf('// Grüße'));
  });

  it("gives an impl, a trait and a module their shells, with every member's span cut out", async () => {
    const o = await outline(SAMPLE, 'rust');
    const impls = o.items.filter((i) => i.kind === 'impl');
    expect(impls.map((i) => i.text)).toEqual(['impl<T: Store + Send> Session<T> { }', 'impl<T> fmt::Display for Session<T> { }', 'impl Refresh for Session<String> { }']);
    expect(find(o.items, 'Store').text).toBe('pub trait Store { }');
    expect(find(o.items, 'auth').text).toBe('pub mod auth { «^»use super::*; }');
    // A struct is not a container: its text is its span.
    expect(o.items.find((i) => i.kind === 'struct')!.text).toBe(SAMPLE.slice(SAMPLE.indexOf('/// A session.'), SAMPLE.indexOf('\n\nimpl<T: Store')));
  });
});

describe('Rust declarations', () => {
  it('keys an impl by its type with type arguments and references stripped, and sends other types to @toplevel', async () => {
    const src = [
      'impl<T> Wrapper<T> { fn a(&self) {} }',
      "impl<'a> Trait for &'a Foo { fn b(&self) {} }",
      'impl Trait for &mut Bar { fn c(&self) {} }',
      'impl fmt::Debug for crate::Baz { fn d(&self) {} }',
      'impl Trait for (A, B) { fn e(&self) {} }',
      'impl Iterator for Counter { type Item = u32; fn next(&mut self) -> Option<u32> { None } }',
    ].join('\n');
    const o = await outline(src, 'rust');
    expect(keys(o.items)).toEqual(['Wrapper', 'Wrapper.a', 'Foo', 'Foo.b', 'Bar', 'Bar.c', '@toplevel', 'Counter', 'Counter.Item', 'Counter.next']);
    expect(find(o.items, 'Counter.Item').signature).toBe('type Item = u32');
    expectWellFormed(src, o);
  });

  it('attaches attributes and doc comments, across a blank line for attributes, and nests module members', async () => {
    const src = [
      '/// Docs.',
      '#[cfg(test)]',
      '',
      '#[allow(dead_code)]',
      'mod tests {',
      '    #![allow(unused)]',
      '    use super::*;',
      '',
      '    #[test]',
      '    fn works() {}',
      '',
      '    impl Session { fn probe(&self) {} }',
      '',
      '    mod deeper { pub struct Leaf; }',
      '}',
      '',
      '// detached',
      '',
      'pub(crate) fn f<T>(x: &mut [u8], g: fn(u8) -> u8) -> impl Iterator<Item = T> + Send where T: ?Sized + Clone {}',
    ].join('\n');
    const o = await outline(src, 'rust');
    expect(keys(o.items)).toEqual(['tests', 'tests.works', 'tests.Session', 'tests.Session.probe', 'tests.deeper', 'tests.deeper.Leaf', '@toplevel', 'f']);
    expect(view(src, o.items).map((v) => [v.key, v.lines, v.head])).toEqual([
      ['tests', '1-15', '/// Docs.'],
      ['@toplevel', '17', '// detached'],
      ['f', '19', 'pub(crate) fn f<T>(x: &mut [u8], g: fn(u8) -> u8) -> impl Iterator<Item = T> + Send where T: ?Sized + Clone {}'],
    ]);
    expect(find(o.items, 'tests.works').startLine).toBe(9);
    expect(find(o.items, 'tests').text).toBe('/// Docs.\n#[cfg(test)]\n\n#[allow(dead_code)]\nmod tests { «^»#![allow(unused)] «^»use super::*; }');
    expect(find(o.items, 'f').signature).toBe('pub(crate) fn f<T>(x: &mut [u8], g: fn(u8) -> u8) -> impl Iterator<Item = T> + Send where T: ?Sized + Clone');
    expectWellFormed(src, o);
  });

  it('keys every item kind of the table, and leaves bodiless modules, foreign blocks and raw identifiers to @toplevel', async () => {
    const src = [
      'const A: u8 = 1;',
      'static mut B: i32 = 0;',
      'union U { a: u32, b: f32 }',
      'type T = u8;',
      'macro_rules! m { () => {} }',
      'mod a;',
      'extern "C" { fn abs(x: i32) -> i32; }',
      'fn r#type() {}',
      'struct Unit;',
      'struct Pair(u8, u8);',
    ].join('\n');
    const o = await outline(src, 'rust');
    expect(view(src, o.items).map((v) => [v.key, v.kind, v.lines, v.signature])).toEqual([
      ['A', 'variable', '1', 'const A: u8'],
      ['B', 'variable', '2', 'static mut B: i32'],
      ['U', 'struct', '3', 'union U { a: u32, b: f32 }'],
      ['T', 'type', '4', 'type T = u8'],
      ['m', 'function', '5', null],
      ['@toplevel', 'toplevel', '6-8', null],
      ['Unit', 'struct', '9', 'struct Unit'],
      ['Pair', 'struct', '10', 'struct Pair(u8, u8)'],
    ]);
  });

  it('builds signatures from tokens: whitespace and comments never change them, while a parameter or return change does', async () => {
    const sig = async (src: string, key: string): Promise<string | null> => find((await outline(src, 'rust')).items, key).signature;
    const flat = "pub async fn load<'a, T: Store>(id: &'a str, opts: Option<&mut Opts>) -> Result<Vec<T>, Error> { todo!() }";
    const tall = ["pub async fn load<", "    'a,", '    T: Store // the backend', '>(', "    id: &'a str,", '    opts: Option<&mut Opts> /* optional */', ') -> Result<Vec<T>,Error> {', '    todo!()', '}'].join('\n');
    expect(await sig(flat, 'load')).toBe("pub async fn load<'a, T: Store>(id: &'a str, opts: Option<&mut Opts>) -> Result<Vec<T>, Error>");
    expect(await sig(tall, 'load')).toBe(await sig(flat, 'load'));
    expect(await sig(flat.replace("id: &'a str", 'id: String'), 'load')).not.toBe(await sig(flat, 'load'));
    expect(await sig(flat.replace('-> Result<Vec<T>, Error>', '-> Vec<T>'), 'load')).not.toBe(await sig(flat, 'load'));
    // Attributes are left out; a const keeps its type but not its value.
    expect(await sig('#[derive(Debug)]\nstruct S {\n    #[serde(skip)]\n    a: u8,\n}', 'S')).toBe('struct S { a: u8, }');
    expect(await sig('const N: usize = 3;', 'N')).toBe(await sig('const N: usize = 4;', 'N'));
  });
});

describe('Rust parse errors', () => {
  it('an error inside a function body is contained in that function, and the next one is intact', async () => {
    const src = 'fn a() -> i32 {\n    1 +\n}\n\nfn b() -> i32 {\n    2\n}\n';
    const o = await outline(src, 'rust');
    expect([o.errors, o.errorKeys]).toEqual(['contained', ['a']]);
    expect(keys(o.items)).toEqual(['a', 'b']);
    expectWellFormed(src, o);
  });

  it('an error in an impl member is contained in the member', async () => {
    const o = await outline('impl S {\n    fn a(&self) -> i32 {\n        1 +;\n    }\n    fn b(&self) {}\n}\n', 'rust');
    expect([o.errors, o.errorKeys]).toEqual(['contained', ['S.a']]);
  });

  it('an unclosed brace and a broken header are uncontained', async () => {
    for (const src of ['fn a() -> i32 {\n    if x {\n    1\n}\n\nfn b() -> i32 {\n    2\n}\n', 'fn a( -> i32 {\n    1\n}\n\nfn b() -> i32 {\n    2\n}\n']) {
      const o = await outline(src, 'rust');
      expect(o.errors, src).toBe('uncontained');
      expectWellFormed(src, o);
    }
  });
});
