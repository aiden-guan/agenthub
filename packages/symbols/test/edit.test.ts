// S3: applyEdit mirrors the Edit tool (design §1.10 "How edits map to keys"): the
// pre-edit hook simulates the exact post-edit text with it, so it must fail
// where the tool fails and produce byte for byte what the tool writes.
import { describe, expect, it } from 'vitest';
import { applyEdit, applyEdits } from '../src/index.js';

describe('applyEdit', () => {
  it('replaces the one occurrence of old_string', () => {
    expect(applyEdit('let a = 1;\nlet b = 2;\n', { old_string: 'b = 2', new_string: 'b = 3' })).toBe('let a = 1;\nlet b = 3;\n');
  });

  it('is null when old_string is not found (the tool call fails)', () => {
    expect(applyEdit('let a = 1;\n', { old_string: 'let c', new_string: 'let d' })).toBeNull();
    expect(applyEdit('', { old_string: 'x', new_string: 'y' })).toBeNull();
  });

  it('is null when old_string is ambiguous without replace_all', () => {
    expect(applyEdit('f();\nf();\n', { old_string: 'f();', new_string: 'g();' })).toBeNull();
    expect(applyEdit('f();\nf();\n', { old_string: 'f();', new_string: 'g();', replace_all: false })).toBeNull();
  });

  it('counts occurrences as the tool does: left to right, without overlaps', () => {
    // 'aaa' holds 'aa' once without overlapping (the tool splits on old_string): one occurrence, the first.
    expect(applyEdit('aaa', { old_string: 'aa', new_string: 'X' })).toBe('Xa');
    expect(applyEdit('aaaa', { old_string: 'aa', new_string: 'X' })).toBeNull();
  });

  it('replaces every occurrence with replace_all, first to last, without overlaps', () => {
    expect(applyEdit('f();\nf();\nff();\n', { old_string: 'f(', new_string: 'g(', replace_all: true })).toBe('g();\ng();\nfg();\n');
    expect(applyEdit('aaaa', { old_string: 'aa', new_string: 'b', replace_all: true })).toBe('bb');
    expect(applyEdit('aaa', { old_string: 'aa', new_string: 'b', replace_all: true })).toBe('ba');
    expect(applyEdit('only once', { old_string: 'once', new_string: 'twice', replace_all: true })).toBe('only twice');
    expect(applyEdit('nothing', { old_string: 'x', new_string: 'y', replace_all: true })).toBeNull();
  });

  it('inserts new_string literally: no $-patterns', () => {
    expect(applyEdit('a b c', { old_string: 'b', new_string: "$& $1 $$ $' $`" })).toBe("a $& $1 $$ $' $` c");
    expect(applyEdit('b b', { old_string: 'b', new_string: '$&$&', replace_all: true })).toBe('$&$& $&$&');
  });

  it('is null when old_string equals new_string (the tool refuses a no-op)', () => {
    expect(applyEdit('a b c', { old_string: 'b', new_string: 'b' })).toBeNull();
  });

  it('an empty old_string only fills an empty (or blank) file', () => {
    expect(applyEdit('', { old_string: '', new_string: 'export const a = 1;\n' })).toBe('export const a = 1;\n');
    expect(applyEdit('\n', { old_string: '', new_string: 'x' })).toBe('x\n');
    expect(applyEdit('const a = 1;\n', { old_string: '', new_string: 'x' })).toBeNull();
  });

  it('deleting text that ends a line also deletes its newline, as the tool does', () => {
    expect(applyEdit('a();\nb();\nc();\n', { old_string: 'b();', new_string: '' })).toBe('a();\nc();\n');
    // With a newline already in old_string, or none after the text, nothing more goes.
    expect(applyEdit('a();\nb();\nc();\n', { old_string: 'b();\n', new_string: '' })).toBe('a();\nc();\n');
    expect(applyEdit('a();\nb();', { old_string: 'b();', new_string: '' })).toBe('a();\n');
    // replace_all deletes only the occurrences followed by a newline, when there is one.
    expect(applyEdit('x();\ny(); x();', { old_string: 'x();', new_string: '', replace_all: true })).toBe('y(); x();');
  });

  it('works on UTF-16 text (non-ASCII before and inside old_string)', () => {
    expect(applyEdit('// café ✓ 😀\nconst π = 3;\n', { old_string: 'π = 3', new_string: 'π = 3.14' })).toBe('// café ✓ 😀\nconst π = 3.14;\n');
  });
});

describe('applyEdits (MultiEdit)', () => {
  it('applies the edits in order, each to the result of the one before', () => {
    const before = 'function a() {}\nfunction b() {}\n';
    expect(
      applyEdits(before, [
        { old_string: 'function a()', new_string: 'function c()' },
        { old_string: 'function c() {}', new_string: 'function c() { return 1; }' },
      ]),
    ).toBe('function c() { return 1; }\nfunction b() {}\n');
  });

  it('order matters: an edit can only match what the edits before it left', () => {
    const before = 'x = 1\n';
    expect(applyEdits(before, [{ old_string: 'x = 1', new_string: 'x = 2' }, { old_string: 'x = 2', new_string: 'x = 3' }])).toBe('x = 3\n');
    expect(applyEdits(before, [{ old_string: 'x = 2', new_string: 'x = 3' }, { old_string: 'x = 1', new_string: 'x = 2' }])).toBeNull();
  });

  it('an edit made ambiguous by an earlier one fails the whole MultiEdit', () => {
    expect(applyEdits('f();\ng();\n', [{ old_string: 'g();', new_string: 'f();' }, { old_string: 'f();', new_string: 'h();' }])).toBeNull();
  });

  it('with no edits, returns the text unchanged', () => {
    expect(applyEdits('a', [])).toBe('a');
  });
});
