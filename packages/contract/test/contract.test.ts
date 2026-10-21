// The §6.3.2 test vectors of the Phases 2 and 3 design, plus the §1.10 overlap
// truth table (design §5.1 "contract"). Frozen at Step 0 with the contract.
import { describe, expect, it } from 'vitest';
import {
  candidateRef,
  claimCovers,
  entriesOverlap,
  entryCovers,
  globToRegExp,
  overlappingEntries,
  parseTeamSections,
  protectedMatches,
  type ScopeLike,
} from '../src/index.js';

const f = (file: string, symbol?: string): ScopeLike => (symbol === undefined ? { file } : { file, symbol });

describe('entriesOverlap', () => {
  it.each([
    ['a whole file and a symbol in it', f('a.ts'), f('a.ts', 'login'), true],
    ['two different top-level symbols', f('a.ts', 'login'), f('a.ts', 'logout'), false],
    ['a container and its member', f('a.ts', 'S'), f('a.ts', 'S.m'), true],
    ['two members of one container', f('a.ts', 'S.m'), f('a.ts', 'S.n'), false],
    ['a name and a longer name it prefixes without a dot', f('a.ts', 'S'), f('a.ts', 'Sx'), false],
    ['@imports and @imports', f('a.ts', '@imports'), f('a.ts', '@imports'), false],
    ['@imports and the whole file', f('a.ts', '@imports'), f('a.ts'), true],
    ['@toplevel and @toplevel', f('a.ts', '@toplevel'), f('a.ts', '@toplevel'), true],
    ['the same symbol in two files', f('a.ts', 'x'), f('b.ts', 'x'), false],
  ])('%s', (_name, a, b, expected) => {
    expect(entriesOverlap(a, b)).toBe(expected);
    expect(entriesOverlap(b, a)).toBe(expected);
  });

  it('follows the §1.10 truth table', () => {
    const keys: Array<string | undefined> = [undefined, '@imports', '@toplevel', 'A', 'A.m', 'B'];
    const name = (k: string | undefined) => k ?? 'file';
    // Rows file, @imports, @toplevel, A, A.m; columns file, @imports, @toplevel, A, A.m, B.
    const table: Record<string, boolean[]> = {
      file: [true, true, true, true, true, true],
      '@imports': [true, false, false, false, false, false],
      '@toplevel': [true, false, true, false, false, false],
      A: [true, false, false, true, true, false],
      'A.m': [true, false, false, true, true, false],
    };
    for (const row of keys.slice(0, 5)) {
      const got = keys.map((col) => entriesOverlap(f('a.ts', row), f('a.ts', col)));
      expect({ row: name(row), got }).toEqual({ row: name(row), got: table[name(row)] });
    }
  });
});

describe('mapper gating', () => {
  const login = f('a.ts', 'login');
  const logout = f('a.ts', 'logout');

  it('compares symbols between claims made with the same mapper', () => {
    expect(overlappingEntries({ scope: [login], mapper: 'm1' }, { scope: [logout], mapper: 'm1' })).toEqual([]);
  });

  it('compares whole files between different mappers, or without one', () => {
    expect(overlappingEntries({ scope: [login], mapper: 'm1' }, { scope: [logout], mapper: 'm2' })).toEqual([logout]);
    expect(overlappingEntries({ scope: [login], mapper: null }, { scope: [logout], mapper: null })).toEqual([logout]);
  });
});

describe('coverage', () => {
  it('a container covers its members, not the other way round', () => {
    expect(entryCovers(f('a.ts', 'S'), f('a.ts', 'S.m'))).toBe(true);
    expect(entryCovers(f('a.ts', 'S.m'), f('a.ts', 'S'))).toBe(false);
  });

  it('a whole-file claim covers a symbol whatever the mappers', () => {
    expect(claimCovers({ scope: [f('a.ts')], mapper: null }, f('a.ts', 'x'), 'm1')).toBe(true);
  });

  it('a symbol claim made with another mapper covers nothing', () => {
    expect(claimCovers({ scope: [f('a.ts', 'x')], mapper: 'm2' }, f('a.ts', 'x'), 'm1')).toBe(false);
  });
});

describe('globs', () => {
  it.each([
    ['*.md', 'README.md', true],
    ['*.md', 'docs/a.md', false],
    ['docs/**', 'docs/a/b.md', true],
    ['**/.env*', '.env', true],
    ['**/.env*', 'app/.env.local', true],
    ['migrations/**', 'migrations', false],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
  ])('%s vs %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe('parseTeamSections', () => {
  it('strict: an unknown key throws, naming it', () => {
    expect(() => parseTeamSections({ land: { check: 'x', protectd: [] } }, { strict: true })).toThrow(
      'agenthub.json: "land.protectd" is not a known setting',
    );
  });

  it('lenient: problems are reported and bad values default', () => {
    const { sections, problems } = parseTeamSections({ land: { check: 'npm test', protectd: [], checkTimeoutMin: 'x' } }, { strict: false });
    expect(problems).toHaveLength(2);
    expect(sections.land?.checkTimeoutMin).toBe(20);
  });

  it('lenient: no check means no queue', () => {
    expect(parseTeamSections({ land: {} }, { strict: false }).sections.land).toBeNull();
  });
});

describe('protectedMatches', () => {
  it('lists the paths each triggered rule covers, the always-protected rule first', () => {
    const { sections } = parseTeamSections(
      { land: { check: 'npm test', protected: ['migrations/**', { paths: ['.github/**'], approvers: ['maya'], distinct: false }] } },
      { strict: true },
    );
    const matches = protectedMatches(['agenthub.json', 'migrations/1.sql', 'src/a.ts', '.github/w.yml'], sections.land!.protected);
    expect(matches.map((m) => m.paths)).toEqual([['agenthub.json'], ['migrations/1.sql'], ['.github/w.yml']]);
  });
});

describe('ref names', () => {
  it('candidateRef', () => {
    expect(candidateRef('refs/agenthub/', '1b4e28ba-2fa1-11d2-883f-0016d3cca427', 'L-7', '0123456789abcdef')).toBe('refs/agenthub/cand/1b4e28ba/L-7/0123456789ab');
  });
});
