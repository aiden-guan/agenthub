// S2: Python outlines (design §1.10 keys, §2.4 the Python row and signatures).
import { describe, expect, it } from 'vitest';
import { outline } from '../src/index.js';
import { expectWellFormed, find, fixture, keys, view } from './helpers.js';

const SAMPLE = fixture('outline/sample.py');

describe('the Python fixture', () => {
  it('has the expected keys, kinds, spans and signatures', async () => {
    const o = await outline(SAMPLE, 'python');
    expect(o.language).toBe('python');
    expect(o.errors).toBe('none');
    expect(o.errorKeys).toEqual([]);
    expect(view(SAMPLE, o.items)).toEqual([
      { key: '@toplevel', kind: 'toplevel', lines: '1', head: '"""Sample Python module for the outline tests (and the mapping property test)."""', tail: '"""Sample Python module for the outline tests (and the mapping property test)."""', signature: null },
      { key: '@imports', kind: 'imports', lines: '3-6', head: 'from __future__ import annotations', tail: 'from typing import Optional as Opt', signature: null },
      { key: 'login', kind: 'function', lines: '8-11', head: '# Grüße, naïve café ✓ 😀: non-ASCII text before a declaration', tail: '    return authenticate(user, password)', signature: 'def login(user: str, password: str = "") -> "Session"' },
      { key: '@toplevel', kind: 'toplevel', lines: '14-17', head: '# A detached note about the module.', tail: 'a, b = 1, 2', signature: null },
      { key: 'MAX_RETRIES', kind: 'variable', lines: '19', head: 'MAX_RETRIES = 3', tail: 'MAX_RETRIES = 3', signature: null },
      { key: 'TIMEOUT', kind: 'variable', lines: '20', head: 'TIMEOUT: float = 2.5', tail: 'TIMEOUT: float = 2.5', signature: 'TIMEOUT: float' },
      { key: 'handler', kind: 'variable', lines: '21', head: 'handler = lambda req, *args: req', tail: 'handler = lambda req, *args: req', signature: 'handler = lambda req, *args' },
      {
        key: 'Session',
        kind: 'class',
        lines: '23-50',
        head: '@dataclass',
        tail: '    # A note at the end of Session.',
        signature: 'class Session(Base, metaclass=Meta)',
        members: [
          { key: 'Session.ttl', kind: 'field', lines: '27-28', head: '# How long a session lives.', tail: '    ttl: int = 3600', signature: 'ttl: int' },
          { key: 'Session.token', kind: 'field', lines: '29', head: 'token = ""', tail: 'token = ""', signature: null },
          { key: 'Session.__init__', kind: 'constructor', lines: '31-32', head: 'def __init__(self, store) -> None:', tail: '        self.store = store', signature: 'def __init__(self, store) -> None' },
          { key: 'Session.user', kind: 'method', lines: '34-36', head: '@property', tail: '        return self.token', signature: 'def user(self) -> str' },
          { key: 'Session.user', kind: 'method', lines: '38-40', head: '@user.setter', tail: '        self.token = value', signature: 'def user(self, value: str) -> None' },
          { key: 'Session.refresh', kind: 'method', lines: '42-45', head: '@staticmethod', tail: '        pass', signature: 'async def refresh(force: bool = False, *, retries: int = 3) -> None' },
          {
            key: 'Session.Meta',
            kind: 'class',
            lines: '47-48',
            head: 'class Meta:',
            tail: '        ordering = ["id"]',
            signature: 'class Meta',
            members: [{ key: 'Session.Meta.ordering', kind: 'field', lines: '48', head: 'ordering = ["id"]', tail: 'ordering = ["id"]', signature: null }],
          },
        ],
      },
      { key: 'over', kind: 'function', lines: '53', head: 'def over(a): ...', tail: 'def over(a): ...', signature: 'def over(a)' },
      { key: 'over', kind: 'function', lines: '54', head: 'def over(a, b): ...', tail: 'def over(a, b): ...', signature: 'def over(a, b)' },
      { key: '@toplevel', kind: 'toplevel', lines: '56-57', head: 'if __name__ == "__main__":', tail: '    login("root")', signature: null },
    ]);
    expectWellFormed(SAMPLE, o);
  });

  it('measures offsets in UTF-16 code units', async () => {
    const o = await outline(SAMPLE, 'python');
    const login = find(o.items, 'login');
    expect(login.start).toBe(SAMPLE.indexOf('# Grüße'));
    expect(login.end).toBe(SAMPLE.indexOf('\n\n\n# A detached'));
    expect(find(o.items, 'MAX_RETRIES').start).toBe(SAMPLE.indexOf('MAX_RETRIES = 3'));
  });

  it("gives a class its shell: the header, its docstring and any other content, with every member's span cut out", async () => {
    const o = await outline(SAMPLE, 'python');
    expect(find(o.items, 'Session').text).toBe('@dataclass\nclass Session(Base, metaclass=Meta): «^»"""A session.""" «Session.Meta»# A note at the end of Session.');
    expect(find(o.items, 'Session.Meta').text).toBe('class Meta:');
    expect(find(o.items, 'Session.refresh').text).toBe('@staticmethod\n    @cache\n    async def refresh(force: bool = False, *, retries: int = 3) -> None:\n        pass');

    const shell = async (src: string): Promise<string> => find((await outline(src, 'python')).items, 'S').text;
    const empty = await shell('class S:\n    pass\n');
    expect(await shell('class S:\n    pass\n    def a(self):\n        return 1\n')).toBe(empty);
    expect(await shell('class S:\n    pass\n\n\n    def a(self):\n        return 2\n')).toBe(empty);
    expect(await shell('class S(T):\n    pass\n')).not.toBe(empty);
    expect(await shell('class S:\n    """Doc."""\n')).not.toBe(await shell('class S:\n    """Other doc."""\n'));
  });
});

describe('Python declarations', () => {
  it('unwraps decorated definitions, keeping the decorators in the span, at top level and in a class', async () => {
    const src = [
      '@app.route("/login")',
      '@auth.required',
      'def view():',
      '    pass',
      '',
      '@dataclass(frozen=True)',
      'class Point:',
      '    x: int',
      '    y: int = 0',
      '',
      '    @classmethod',
      '    def origin(cls) -> "Point":',
      '        return cls(0)',
      '',
      '    @staticmethod',
      '    @dataclass',
      '    class Inner:',
      '        @property',
      '        def depth(self): return 1',
    ].join('\n');
    const o = await outline(src, 'python');
    expect(keys(o.items)).toEqual(['view', 'Point', 'Point.x', 'Point.y', 'Point.origin', 'Point.Inner', 'Point.Inner.depth']);
    expect(view(src, o.items).map((v) => [v.key, v.kind, v.lines, v.head, v.signature])).toEqual([
      ['view', 'function', '1-4', '@app.route("/login")', 'def view()'],
      ['Point', 'class', '6-19', '@dataclass(frozen=True)', 'class Point'],
    ]);
    const origin = find(o.items, 'Point.origin');
    expect([origin.kind, origin.startLine, origin.endLine, origin.signature]).toEqual(['method', 11, 13, 'def origin(cls) -> "Point"']);
    expect(src.slice(origin.start, origin.end)).toMatch(/^@classmethod\n {4}def origin/);
    expect(find(o.items, 'Point.x').signature).toBe('x: int');
    expect(find(o.items, 'Point.y').signature).toBe('y: int');
    const inner = find(o.items, 'Point.Inner');
    expect([inner.kind, inner.startLine, inner.endLine]).toEqual(['class', 15, 19]);
    expect(find(o.items, 'Point.Inner.depth').startLine).toBe(18);
    expectWellFormed(src, o);
  });

  it('keys module assignments to a plain name and sends every other assignment to @toplevel', async () => {
    const src = [
      'X = 1',
      'Y: int',
      'Z: list[int] = []',
      'X = Y = 2',
      'obj.attr = 3',
      'table[0] = 4',
      'n += 1',
      'p, q = 5, 6',
      '__all__ = ["view"]',
      'f = lambda: 0',
      'X = 7',
    ].join('\n');
    const o = await outline(src, 'python');
    expect(view(src, o.items).map((v) => [v.key, v.kind, v.lines, v.signature])).toEqual([
      ['X', 'variable', '1', null],
      ['Y', 'variable', '2', 'Y: int'],
      ['Z', 'variable', '3', 'Z: list[int]'],
      ['@toplevel', 'toplevel', '4-8', null],
      ['__all__', 'variable', '9', null],
      ['f', 'variable', '10', 'f = lambda'],
      ['X', 'variable', '11', null],
    ]);
    expectWellFormed(src, o);
  });

  it('keys class members (methods, __init__ as a constructor, assignments) and keeps everything else in the shell', async () => {
    const src = [
      'class C(Base):',
      '    """Doc."""',
      '    import os',
      '    a = b = 1',
      '    if DEBUG:',
      '        level = 2',
      '    count: int = 0',
      '    def __init__(self):',
      '        self.count = 1',
      '    async def run(self, *args, **kwargs) -> None: ...',
      '    run = staticmethod(run)',
    ].join('\n');
    const o = await outline(src, 'python');
    expect(view(src, o.items)[0]!.members!.map((m) => [m.key, m.kind, m.lines, m.signature])).toEqual([
      ['C.count', 'field', '7', 'count: int'],
      ['C.__init__', 'constructor', '8-9', 'def __init__(self)'],
      ['C.run', 'method', '10', 'async def run(self, *args, **kwargs) -> None'],
      ['C.run', 'field', '11', null],
    ]);
    expect(find(o.items, 'C').text).toBe('class C(Base): «^»"""Doc.""" «^»import os «^»a = b = 1 «^»if DEBUG:\n        level = 2');
    expectWellFormed(src, o);
  });

  it('attaches leading comments only without a blank line, and comments the grammar puts inside a block stay there', async () => {
    const src = ['# detached', '', '# one', '# two', 'def a():', '    return 1', '    # still in a', '# leads b', 'def b(): pass  # trailing b', 'x = 1'].join('\n');
    const o = await outline(src, 'python');
    expect(view(src, o.items).map((v) => [v.key, v.lines, v.head, v.tail])).toEqual([
      ['@toplevel', '1', '# detached', '# detached'],
      ['a', '3-7', '# one', '    # still in a'],
      ['b', '8-9', '# leads b', 'def b(): pass  # trailing b'],
      ['x', '10', 'x = 1', 'x = 1'],
    ]);
  });

  it("attaches a comment right after a class header to the first member, but keeps one on the header's line in the header", async () => {
    const src = 'class C:  # the header\n    # about m\n    def m(self): pass\n\n    # about n\n    def n(self): pass\n';
    const o = await outline(src, 'python');
    expect(view(src, o.items)[0]!.members!.map((m) => [m.key, m.lines, m.head])).toEqual([
      ['C.m', '2-3', '# about m'],
      ['C.n', '5-6', '# about n'],
    ]);
    expect(find(o.items, 'C').text).toBe('class C:  # the header');
    // So adding a commented first method leaves the shell alone.
    const before = find((await outline('class C:\n    def a(self): pass\n', 'python')).items, 'C').text;
    const after = find((await outline('class C:\n    # new\n    def b(self): pass\n    def a(self): pass\n', 'python')).items, 'C').text;
    expect(after).toBe(before);
  });

  it('merges imports, including ones joined by a semicolon', async () => {
    const src = 'import os; import sys\nfrom . import util\n\nprint(1)\nimport json\n';
    const o = await outline(src, 'python');
    expect(view(src, o.items).map((v) => [v.key, v.lines])).toEqual([
      ['@imports', '1-2'],
      ['@toplevel', '4'],
      ['@imports', '5'],
    ]);
  });

  it('builds signatures from tokens: whitespace and comments never change them, while a parameter or return change does', async () => {
    const sig = async (src: string, key: string): Promise<string | null> => find((await outline(src, 'python')).items, key).signature;
    const flat = 'def load(key: str, opts: dict[str, int] | None = None, *rest, retries=3, **kw) -> Optional[T]:\n    return None\n';
    const tall = [
      'def load(',
      '    key: str,  # the key',
      '    opts: dict[str,int]|None=None,',
      '    *rest,',
      '    retries = 3,',
      '    **kw',
      ') -> Optional[ T ] :',
      '    return None',
      '',
    ].join('\n');
    expect(await sig(flat, 'load')).toBe('def load(key: str, opts: dict[str, int] | None = None, *rest, retries=3, **kw) -> Optional[T]');
    expect(await sig(tall, 'load')).toBe(await sig(flat, 'load'));
    expect(await sig(flat.replace('key: str', 'key: bytes'), 'load')).not.toBe(await sig(flat, 'load'));
    expect(await sig(flat.replace('-> Optional[T]', '-> T'), 'load')).not.toBe(await sig(flat, 'load'));
    // The body is not part of it.
    expect(await sig(flat.replace('return None', 'return 1'), 'load')).toBe(await sig(flat, 'load'));
    expect(await sig('class K(A, B, metaclass=M):\n    pass\n', 'K')).toBe('class K(A, B, metaclass=M)');
  });
});

describe('Python parse errors', () => {
  it('an error in the first statement of a body is contained in that function (tree-sitter puts it between the colon and the block)', async () => {
    const src = 'def a():\n    return 1 +\n\ndef b():\n    return 2\n';
    const o = await outline(src, 'python');
    expect(o.errors).toBe('contained');
    expect(o.errorKeys).toEqual(['a']);
    expect(keys(o.items)).toEqual(['a', 'b']);
    expectWellFormed(src, o);
  });

  it('an error later in a body, or in a method, is contained in the innermost declaration', async () => {
    const later = await outline('def a():\n    x = 1\n    return 1 +\n\ndef b():\n    return 2\n', 'python');
    expect([later.errors, later.errorKeys]).toEqual(['contained', ['a']]);
    const method = await outline('class C:\n    def m(self):\n        return 1 +\n    def n(self):\n        pass\n', 'python');
    expect([method.errors, method.errorKeys]).toEqual(['contained', ['C.m']]);
  });

  it('a broken header or a broken top-level statement is uncontained', async () => {
    for (const src of ['def a(:\n    return 1\n\ndef b():\n    return 2\n', 'X = (1 +\ndef b():\n    return 2\n', '@dec(\ndef b():\n    return 2\n']) {
      const o = await outline(src, 'python');
      expect(o.errors, src).toBe('uncontained');
      expectWellFormed(src, o);
    }
  });
});
