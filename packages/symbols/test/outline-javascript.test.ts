// S1: JavaScript outlines (the TS/TSX/JS table on the JavaScript grammar).
import { describe, expect, it } from 'vitest';
import { outline } from '../src/index.js';
import { expectWellFormed, find, fixture, keys, view } from './helpers.js';

const SAMPLE = fixture('outline/sample.js');

describe('the JavaScript fixture', () => {
  it('has the expected keys, kinds, spans and signatures', async () => {
    const o = await outline(SAMPLE, 'javascript');
    expect(o.language).toBe('javascript');
    expect(o.errors).toBe('none');
    expect(view(SAMPLE, o.items)).toEqual([
      { key: '@toplevel', kind: 'toplevel', lines: '1', head: "'use strict';", tail: "'use strict';", signature: null },
      { key: 'fs', kind: 'variable', lines: '3', head: "const fs = require('fs');", tail: "const fs = require('fs');", signature: null },
      { key: '@imports', kind: 'imports', lines: '4-5', head: "import path from 'node:path';", tail: "export { join } from 'node:path';", signature: null },
      { key: 'read', kind: 'function', lines: '7-12', head: '/**', tail: '}', signature: 'function read(file)' },
      { key: 'ids', kind: 'function', lines: '14-17', head: 'function* ids() {', tail: '}', signature: 'function* ids()' },
      {
        key: 'Cache',
        kind: 'class',
        lines: '19-37',
        head: 'export class Cache extends Map {',
        tail: '}',
        signature: 'class Cache extends Map',
        members: [
          { key: 'Cache.instances', kind: 'field', lines: '20', head: 'static instances = 0;', tail: 'static instances = 0;', signature: null },
          { key: 'Cache.limit', kind: 'field', lines: '22', head: 'limit;', tail: 'limit;', signature: null },
          { key: 'Cache.constructor', kind: 'constructor', lines: '24-27', head: 'constructor(limit) {', tail: '  }', signature: 'constructor(limit)' },
          { key: 'Cache.get', kind: 'method', lines: '29-32', head: 'get(key) {', tail: '  }', signature: 'get(key)' },
        ],
      },
      { key: 'a', kind: 'variable', lines: '39', head: 'export const a = 1, ', tail: 'export const a = 1, ', signature: null },
      { key: 'b', kind: 'variable', lines: '39', head: 'b = (x) => x * 2;', tail: 'b = (x) => x * 2;', signature: 'const b = (x) =>' },
      { key: '@toplevel', kind: 'toplevel', lines: '40-41', head: 'let [first, second] = [1, 2];', tail: 'module.exports = { read, ids };', signature: null },
      { key: 'default', kind: 'variable', lines: '43-45', head: 'export default {', tail: '};', signature: null },
    ]);
    expect(find(o.items, 'Cache').text).toBe('export class Cache extends Map { «Cache.instances»#hits = 0; «Cache.get»static {\n    Cache.instances = 1;\n  } }');
    expectWellFormed(SAMPLE, o);
  });

  it('attaches decorators that the JavaScript grammar nests in the member', async () => {
    const src = 'class A {\n  // note\n  @dec m() {}\n  @a @b static n() {}\n}\n';
    const o = await outline(src, 'javascript');
    expect(keys(o.items)).toEqual(['A', 'A.m', 'A.n']);
    expect(src.slice(find(o.items, 'A.m').start, find(o.items, 'A.m').end)).toBe('// note\n  @dec m() {}');
    expect(find(o.items, 'A.n').signature).toBe('static n()');
  });

  it('measures offsets in UTF-16 code units', async () => {
    const src = '/* ünïcödé 😀😀 */\n\nfunction f() {}\n';
    const f = find((await outline(src, 'javascript')).items, 'f');
    expect(f.start).toBe(src.indexOf('function f'));
    expect(f.startLine).toBe(3);
  });
});
