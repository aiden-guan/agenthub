// S2: Java outlines (design §1.10 keys, §2.4 the Java row and signatures).
import { describe, expect, it } from 'vitest';
import { outline } from '../src/index.js';
import { expectWellFormed, find, fixture, keys, view } from './helpers.js';

const SAMPLE = fixture('outline/Sample.java');

describe('the Java fixture', () => {
  it('has the expected keys, kinds, spans and signatures', async () => {
    const o = await outline(SAMPLE, 'java');
    expect(o.language).toBe('java');
    expect(o.errors).toBe('none');
    expect(o.errorKeys).toEqual([]);
    expect(view(SAMPLE, o.items)).toEqual([
      { key: '@imports', kind: 'imports', lines: '1-5', head: '// Sample Java file for the outline tests (and the mapping property test).', tail: 'import static java.lang.Math.max;', signature: null },
      {
        key: 'Session',
        kind: 'class',
        lines: '7-45',
        head: '// Grüße, naïve café ✓ 😀: non-ASCII text before a declaration',
        tail: '}',
        signature: 'public class Session<T extends Comparable<T>> extends Base implements AutoCloseable',
        members: [
          { key: 'Session.TTL', kind: 'field', lines: '11-12', head: '// How long a session lives.', tail: '    private static final int TTL = 3600,', signature: 'private static final int TTL' },
          { key: 'Session.MAX_TTL', kind: 'field', lines: '12', head: 'MAX_TTL = 7200;', tail: 'MAX_TTL = 7200;', signature: 'private static final int MAX_TTL' },
          { key: 'Session.token', kind: 'field', lines: '13', head: 'String token;', tail: 'String token;', signature: 'String token' },
          { key: 'Session.constructor', kind: 'constructor', lines: '15-17', head: 'public Session(String token) {', tail: '    }', signature: 'public Session(String token)' },
          { key: 'Session.constructor', kind: 'constructor', lines: '19-21', head: 'public Session() {', tail: '    }', signature: 'public Session()' },
          { key: 'Session.refresh', kind: 'method', lines: '23-26', head: '@Override', tail: '    }', signature: 'public void refresh(boolean force) throws IOException' },
          { key: 'Session.refresh', kind: 'method', lines: '28-30', head: 'public void refresh() {', tail: '    }', signature: 'public void refresh()' },
          { key: 'Session.of', kind: 'method', lines: '32-34', head: 'public static <K> List<K> of(K... items) {', tail: '    }', signature: 'public static <K> List<K> of(K... items)' },
          {
            key: 'Session.Inner',
            kind: 'class',
            lines: '36-42',
            head: 'static class Inner {',
            tail: '    }',
            signature: 'static class Inner',
            members: [
              { key: 'Session.Inner.depth', kind: 'field', lines: '37', head: 'int depth;', tail: 'int depth;', signature: 'int depth' },
              { key: 'Session.Inner.walk', kind: 'method', lines: '39', head: 'void walk() {}', tail: 'void walk() {}', signature: 'void walk()' },
              { key: 'Session.Inner.Mode', kind: 'enum', lines: '41', head: 'enum Mode { FAST, SLOW }', tail: 'enum Mode { FAST, SLOW }', signature: 'enum Mode { FAST, SLOW }' },
            ],
          },
        ],
      },
      { key: '@toplevel', kind: 'toplevel', lines: '47', head: '// A detached note about the file.', tail: '// A detached note about the file.', signature: null },
      {
        key: 'Store',
        kind: 'interface',
        lines: '49-55',
        head: 'interface Store<K> {',
        tail: '}',
        signature: 'interface Store<K>',
        members: [
          { key: 'Store.LIMIT', kind: 'field', lines: '50', head: 'int LIMIT = 10;', tail: 'int LIMIT = 10;', signature: 'int LIMIT' },
          { key: 'Store.get', kind: 'method', lines: '52', head: 'Session get(K id);', tail: 'Session get(K id);', signature: 'Session get(K id)' },
          { key: 'Store.put', kind: 'method', lines: '54', head: 'default void put(K id, Session s) {}', tail: 'default void put(K id, Session s) {}', signature: 'default void put(K id, Session s)' },
        ],
      },
      {
        key: 'Role',
        kind: 'enum',
        lines: '57-66',
        head: 'enum Role {',
        tail: '}',
        signature: 'enum Role { ADMIN("a"), USER("u") }',
        members: [
          { key: 'Role.code', kind: 'field', lines: '61', head: 'private final String code;', tail: 'private final String code;', signature: 'private final String code' },
          { key: 'Role.constructor', kind: 'constructor', lines: '63-65', head: 'Role(String code) {', tail: '    }', signature: 'Role(String code)' },
        ],
      },
      {
        key: 'Point',
        kind: 'class',
        lines: '68-74',
        head: 'record Point(int x, int y) {',
        tail: '}',
        signature: 'record Point(int x, int y)',
        members: [
          { key: 'Point.constructor', kind: 'constructor', lines: '69-71', head: 'Point {', tail: '    }', signature: 'Point' },
          { key: 'Point.sum', kind: 'method', lines: '73', head: 'int sum() { return x + y; }', tail: 'int sum() { return x + y; }', signature: 'int sum()' },
        ],
      },
      {
        key: 'Marker',
        kind: 'interface',
        lines: '76-78',
        head: '@interface Marker {',
        tail: '}',
        signature: '@interface Marker',
        members: [{ key: 'Marker.value', kind: 'method', lines: '77', head: 'String value() default "";', tail: 'String value() default "";', signature: 'String value() default ""' }],
      },
    ]);
    expectWellFormed(SAMPLE, o);
  });

  it('keys nested classes as Outer.Inner and lets overloads share a key', async () => {
    const o = await outline(SAMPLE, 'java');
    const session = find(o.items, 'Session');
    expect(session.members.filter((m) => m.key === 'Session.refresh').map((m) => m.signature)).toEqual(['public void refresh(boolean force) throws IOException', 'public void refresh()']);
    expect(session.members.filter((m) => m.key === 'Session.constructor')).toHaveLength(2);
    expect(keys(find(o.items, 'Session.Inner').members)).toEqual(['Session.Inner.depth', 'Session.Inner.walk', 'Session.Inner.Mode']);
    expect(session.start).toBe(SAMPLE.indexOf('// Grüße'));
  });

  it("gives every type its shell, with each member's span cut out", async () => {
    const o = await outline(SAMPLE, 'java');
    expect(find(o.items, 'Session').text).toBe(
      '// Grüße, naïve café ✓ 😀: non-ASCII text before a declaration\n/** A session. */\n@Entity\npublic class Session<T extends Comparable<T>> extends Base implements AutoCloseable { «Session.Inner»{ init(); } }',
    );
    expect(find(o.items, 'Session.Inner').text).toBe('static class Inner { }');
    // An enum's constants are part of its shell; one without members is a plain item.
    expect(find(o.items, 'Role').text).toBe('enum Role {\n    ADMIN("a"),\n    USER("u"); }');
    expect(find(o.items, 'Session.Inner.Mode').text).toBe('enum Mode { FAST, SLOW }');
    // A later declarator carries its declaration's header.
    expect(find(o.items, 'Session.MAX_TTL').text).toBe('private static final int MAX_TTL = 7200;');
  });
});

describe('Java declarations', () => {
  it('keys the members of interfaces, enums, records and annotation types, and leaves initializers in the shell', async () => {
    const src = [
      'public interface Api {',
      '    String NAME = "api", VERSION = "1";',
      '    interface Nested { void n(); }',
      '    static Api create() { return null; }',
      '}',
      '',
      'enum Op {',
      '    PLUS { int apply(int a, int b) { return a + b; } };',
      '    abstract int apply(int a, int b);',
      '    static { load(); }',
      '}',
    ].join('\n');
    const o = await outline(src, 'java');
    expect(keys(o.items)).toEqual(['Api', 'Api.NAME', 'Api.VERSION', 'Api.Nested', 'Api.Nested.n', 'Api.create', 'Op', 'Op.apply']);
    expect(find(o.items, 'Api.VERSION').signature).toBe('String VERSION');
    expect(find(o.items, 'Op').text).toBe('enum Op {\n    PLUS { int apply(int a, int b) { return a + b; } }; «Op.apply»static { load(); } }');
    // An enum's signature is its header and constants, without the constants' bodies.
    expect(find(o.items, 'Op').signature).toBe('enum Op { PLUS }');
    expect(find(o.items, 'Op.apply').signature).toBe('abstract int apply(int a, int b)');
    expectWellFormed(src, o);
  });

  it('attaches Javadoc and annotations to members, and leaves detached comments in the shell', async () => {
    const src = [
      'class C {',
      '    /** Docs. */',
      '    @Inject',
      '    private Service service;',
      '',
      '    // detached',
      '',
      '    @Deprecated void old() {}; // trailing',
      '}',
    ].join('\n');
    const o = await outline(src, 'java');
    expect(view(src, o.items)[0]!.members!.map((m) => [m.key, m.lines, m.head, m.tail, m.signature])).toEqual([
      ['C.service', '2-4', '/** Docs. */', '    private Service service;', 'private Service service'],
      ['C.old', '8', '@Deprecated void old() {}; // trailing', '@Deprecated void old() {}; // trailing', 'void old()'],
    ]);
    expect(find(o.items, 'C').text).toBe('class C { «C.service»// detached }');
  });

  it('builds signatures from tokens: whitespace and comments never change them, while a parameter or return change does', async () => {
    const sig = async (src: string, key: string): Promise<string | null> => find((await outline(`class A {\n${src}\n}`, 'java')).items, key).signature;
    const flat = 'public <T extends B & C> Map<String, List<? extends T>> load(@NonNull String id, int[] sizes, T... rest) throws IOException, SQLException { return null; }';
    const tall = [
      'public <T extends B&C>',
      'Map<String,List<?extends T>> load( /* the key */ @NonNull String id,',
      '    int [] sizes, // the sizes',
      '    T ... rest)',
      '    throws IOException,SQLException {',
      '  return null;',
      '}',
    ].join('\n');
    expect(await sig(flat, 'A.load')).toBe('public <T extends B & C> Map<String, List<? extends T>> load(String id, int[] sizes, T... rest) throws IOException, SQLException');
    expect(await sig(tall, 'A.load')).toBe(await sig(flat, 'A.load'));
    expect(await sig(flat.replace('String id', 'long id'), 'A.load')).not.toBe(await sig(flat, 'A.load'));
    expect(await sig(flat.replace('Map<String, List<? extends T>>', 'void'), 'A.load')).not.toBe(await sig(flat, 'A.load'));
    expect(await sig('static final int N = 3;', 'A.N')).toBe(await sig('static final int N = 4;', 'A.N'));
  });
});

describe('Java parse errors', () => {
  it('an error inside a method body is contained in that method, and the next one is intact', async () => {
    const src = 'class A {\n  int a() {\n    return 1 +;\n  }\n\n  int b() {\n    return 2;\n  }\n}\n';
    const o = await outline(src, 'java');
    expect([o.errors, o.errorKeys]).toEqual(['contained', ['A.a']]);
    expect(keys(o.items)).toEqual(['A', 'A.a', 'A.b']);
    expectWellFormed(src, o);
  });

  it('a broken method header is contained in its class; a broken class header is uncontained', async () => {
    const method = await outline('class A {\n  int a( {\n    return 1;\n  }\n\n  int b() {\n    return 2;\n  }\n}\n', 'java');
    expect([method.errors, method.errorKeys]).toEqual(['contained', ['A']]);
    const header = await outline('class A extends {\n  int a() { return 1; }\n}\n', 'java');
    expect(header.errors).toBe('uncontained');
  });
});
