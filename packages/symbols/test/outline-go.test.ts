// S2: Go outlines (design §1.10 keys, §2.4 the Go row and signatures).
import { describe, expect, it } from 'vitest';
import { outline } from '../src/index.js';
import { expectWellFormed, find, fixture, keys, view } from './helpers.js';

const SAMPLE = fixture('outline/sample.go');

describe('the Go fixture', () => {
  it('has the expected keys, kinds, spans and signatures', async () => {
    const o = await outline(SAMPLE, 'go');
    expect(o.language).toBe('go');
    expect(o.errors).toBe('none');
    expect(o.errorKeys).toEqual([]);
    expect(view(SAMPLE, o.items)).toEqual([
      { key: '@imports', kind: 'imports', lines: '1-9', head: '// Package auth is a sample Go file for the outline tests (and the mapping property test).', tail: ')', signature: null },
      { key: 'Login', kind: 'function', lines: '11-15', head: '// Grüße, naïve café ✓ 😀: non-ASCII text before a declaration', tail: '}', signature: 'func Login(user string, password string) (*Session, error)' },
      { key: '@toplevel', kind: 'toplevel', lines: '17', head: '// A detached note about the file.', tail: '// A detached note about the file.', signature: null },
      { key: 'Session', kind: 'struct', lines: '19-23', head: '// Session is a session.', tail: '}', signature: 'type Session struct { ID string `json:"id"` token string }' },
      { key: 'Store', kind: 'interface', lines: '25-29', head: 'type (', tail: '\t}', signature: 'type Store interface { Get(id string) (*Session, error) }' },
      { key: 'Cache', kind: 'type', lines: '30-31', head: 'Cache[K comparable, V any] map[K][]V', tail: ')', signature: 'type Cache[K comparable, V any] map[K][]V' },
      { key: 'ID', kind: 'type', lines: '33', head: 'type ID = string', tail: 'type ID = string', signature: 'type ID = string' },
      { key: 'MaxRetries', kind: 'variable', lines: '35', head: 'const MaxRetries = 3', tail: 'const MaxRetries = 3', signature: null },
      { key: 'Admin', kind: 'variable', lines: '37-39', head: 'const (', tail: '\tAdmin Role = iota // the first', signature: 'const Admin Role' },
      { key: 'User', kind: 'variable', lines: '40-41', head: 'User', tail: ')', signature: null },
      { key: 'current', kind: 'variable', lines: '43-44', head: 'var (', tail: '\tcurrent *Session', signature: 'var current *Session' },
      { key: 'handler', kind: 'variable', lines: '45-46', head: 'handler = func(w http.ResponseWriter, xs []string) error { return nil }', tail: ')', signature: 'var handler = func(w http.ResponseWriter, xs []string) error' },
      { key: '@toplevel', kind: 'toplevel', lines: '48', head: 'var a, b = 1, 2', tail: 'var a, b = 1, 2', signature: null },
      { key: 'Session.Refresh', kind: 'method', lines: '50-54', head: '// Refresh renews the session.', tail: '}', signature: 'func (s *Session) Refresh(force bool) error' },
      { key: 'Session.Close', kind: 'method', lines: '56', head: 'func (s Session) Close() {}', tail: 'func (s Session) Close() {}', signature: 'func (s Session) Close()' },
      { key: 'Cache.Put', kind: 'method', lines: '58', head: 'func (c *Cache[K, V]) Put(k K, v V) {}', tail: 'func (c *Cache[K, V]) Put(k K, v V) {}', signature: 'func (c *Cache[K, V]) Put(k K, v V)' },
      { key: 'init', kind: 'function', lines: '60', head: 'func init() {}', tail: 'func init() {}', signature: 'func init()' },
      { key: 'init', kind: 'function', lines: '62', head: 'func init() {}', tail: 'func init() {}', signature: 'func init()' },
    ]);
    expectWellFormed(SAMPLE, o);
  });

  it('keys the method Refresh on a pointer receiver as Session.Refresh, and spans it from its doc comment', async () => {
    const o = await outline(SAMPLE, 'go');
    const refresh = find(o.items, 'Session.Refresh');
    expect(refresh.start).toBe(SAMPLE.indexOf('// Refresh renews'));
    expect(refresh.end).toBe(SAMPLE.indexOf('\n\nfunc (s Session) Close'));
    expect(refresh.members).toEqual([]);
    // Login's span starts at the non-ASCII comment, in UTF-16 code units.
    expect(find(o.items, 'Login').start).toBe(SAMPLE.indexOf('// Grüße'));
    // A later spec of a group carries the group's header.
    expect(find(o.items, 'User').text).toBe('const ( User\n)');
    expect(find(o.items, 'Admin').text).toBe('const (\n\t// Admin is the admin role.\n\tAdmin Role = iota // the first');
  });
});

describe('Go declarations', () => {
  it('keys methods under their receiver type, with the pointer and type arguments stripped', async () => {
    const src = [
      'package p',
      'func (s *Session) A() {}',
      'func (s Session) B() {}',
      'func (Session) C() {}',
      'func (*Session) D() {}',
      'func (m *Map[K, V]) E() {}',
      'func (m Map[K, V]) F() {}',
      'func (p *pkg.Type) G() {}',
    ].join('\n');
    const o = await outline(src, 'go');
    expect(view(src, o.items).map((v) => [v.key, v.kind, v.lines])).toEqual([
      ['@imports', 'imports', '1'],
      ['Session.A', 'method', '2'],
      ['Session.B', 'method', '3'],
      ['Session.C', 'method', '4'],
      ['Session.D', 'method', '5'],
      ['Map.E', 'method', '6'],
      ['Map.F', 'method', '7'],
      // A receiver that is not a local type name can't be keyed: @toplevel.
      ['@toplevel', 'toplevel', '8'],
    ]);
    expect(find(o.items, 'Session.C').signature).toBe('func (Session) C()');
    expect(find(o.items, 'Session.D').signature).toBe('func (*Session) D()');
    expectWellFormed(src, o);
  });

  it('keys each type, const and var spec of a group, attaching each one its own leading comments', async () => {
    const src = [
      'package p',
      '',
      'const (',
      '\t// X doc',
      '\tX = iota // first',
      '\t// Y doc',
      '\tY',
      '',
      '\t// detached',
      '',
      '\tZ',
      ')',
      '',
      'var (',
      '\tc int',
      '\td string = "x"',
      ')',
      '',
      'type (',
      '\tA int',
      '\tB[T any] struct{ v T }',
      '\tC = A',
      ')',
    ].join('\n');
    const o = await outline(src, 'go');
    expect(view(src, o.items).map((v) => [v.key, v.kind, v.lines, v.head, v.tail, v.signature])).toEqual([
      ['@imports', 'imports', '1', 'package p', 'package p', null],
      ['X', 'variable', '3-5', 'const (', '\tX = iota // first', null],
      ['Y', 'variable', '6-9', '// Y doc', '\t// detached', null],
      ['Z', 'variable', '11-12', 'Z', ')', null],
      ['c', 'variable', '14-15', 'var (', '\tc int', 'var c int'],
      ['d', 'variable', '16-17', 'd string = "x"', ')', 'var d string'],
      ['A', 'type', '19-20', 'type (', '\tA int', 'type A int'],
      ['B', 'struct', '21', 'B[T any] struct{ v T }', 'B[T any] struct{ v T }', 'type B[T any] struct { v T }'],
      ['C', 'type', '22-23', 'C = A', ')', 'type C = A'],
    ]);
    expectWellFormed(src, o);
  });

  it('sends a spec that declares several names to @toplevel with its whole declaration', async () => {
    const src = 'package p\n\nvar a, b = 1, 2\n\nvar (\n\tc int\n\td, e string\n)\n\nconst f, g = 1, 2\n\nvar h int\n';
    const o = await outline(src, 'go');
    expect(view(src, o.items).map((v) => [v.key, v.lines])).toEqual([
      ['@imports', '1'],
      ['@toplevel', '3-10'],
      ['h', '12'],
    ]);
  });

  it('builds signatures from tokens: whitespace and comments never change them, while a parameter or result change does', async () => {
    const sig = async (src: string, key: string): Promise<string | null> => find((await outline(`package p\n${src}`, 'go')).items, key).signature;
    const flat = 'func (s *Session) Load(ids []string, opts map[string][]int, more ...string) (map[string]*Session, error) { return nil, nil }';
    const tall = [
      'func (s *Session) Load(',
      '\tids []string, // the keys',
      '\topts map[string][]int,',
      '\tmore ...string,',
      ') (map[string]*Session, /* the error */ error) {',
      '\treturn nil, nil',
      '}',
    ].join('\n');
    expect(await sig(flat, 'Session.Load')).toBe('func (s *Session) Load(ids []string, opts map[string][]int, more ...string) (map[string]*Session, error)');
    // A trailing comma is a token, so the tall form drops it to compare.
    expect(await sig(tall.replace('...string,', '...string'), 'Session.Load')).toBe(await sig(flat, 'Session.Load'));
    expect(await sig(flat.replace('ids []string', 'ids []int'), 'Session.Load')).not.toBe(await sig(flat, 'Session.Load'));
    expect(await sig(flat.replace(', error)', ')'), 'Session.Load')).not.toBe(await sig(flat, 'Session.Load'));
    expect(await sig('func Map[K comparable, V any](m map[K]V, f func(K) V) [4]chan<- V { return nil }', 'Map')).toBe(
      'func Map[K comparable, V any](m map[K]V, f func(K) V) [4]chan<- V',
    );
    // A type spec's signature is all of it; a var's stops before its value.
    expect(await sig('type I interface {\n\tM(x int) error // does M\n}', 'I')).toBe('type I interface { M(x int) error }');
    expect(await sig('var v = compute()', 'v')).toBeNull();
    expect(await sig('var w []byte = nil', 'w')).toBe('var w []byte');
  });
});

describe('Go parse errors', () => {
  it('an error inside a function body is contained in that function, and the next one is intact', async () => {
    const src = 'package p\n\nfunc a() int {\n\treturn 1 +\n}\n\nfunc b() int {\n\treturn 2\n}\n';
    const o = await outline(src, 'go');
    expect([o.errors, o.errorKeys]).toEqual(['contained', ['a']]);
    expect(keys(o.items)).toEqual(['@imports', 'a', 'b']);
    expectWellFormed(src, o);
  });

  it('an unclosed brace makes the function swallow the next one: contained in it, and the swallowed key disappears', async () => {
    const src = 'package p\n\nfunc a() int {\n\tif x {\n\treturn 1\n}\n\nfunc b() int {\n\treturn 2\n}\n';
    const o = await outline(src, 'go');
    expect([o.errors, o.errorKeys]).toEqual(['contained', ['a']]);
    expect(keys(o.items)).toEqual(['@imports', 'a']);
    expectWellFormed(src, o);
  });

  it('a broken header is uncontained; an error inside a struct type is contained in the type', async () => {
    const header = await outline('package p\n\nfunc a( int {\n\treturn 1\n}\n', 'go');
    expect(header.errors).toBe('uncontained');
    const struct = await outline('package p\n\ntype S struct {\n\tID string\n\t1\n}\n\nfunc b() {}\n', 'go');
    expect([struct.errors, struct.errorKeys]).toEqual(['contained', ['S']]);
  });
});
