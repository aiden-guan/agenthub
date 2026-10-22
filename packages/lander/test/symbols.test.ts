import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAPPER_VERSION } from '@agenthub/symbols';
import { openGitPort } from '../src/git-port.js';
import type { GitPort } from '../src/ports.js';
import {
  ADMISSION_MAX_SYMBOLS,
  admissionScope,
  hunkSymbols,
  landedSymbolChanges,
  MAX_SCOPE_ENTRIES,
  symbolsParseCheck,
} from '../src/symbols.js';
import { Repo, tmp, type Tmp } from './helpers.js';

// Phase 3 in the lander (design §2.2.4 step 4, §2.5 "Producers", §2.2.6
// step 4, §2.6 gate 6): the admission scope through changedSymbols (40 keys
// per file, mapper = MAPPER_VERSION), the landed signature changes (T0 vs C),
// the declarations each conflict hunk lies in, and the resolver's parse gate.

const AUTH = [
  "import { hash } from './hash';",
  '',
  '/** Logs in. */',
  'export function login(user: string): string {',
  '  return hash(user);',
  '}',
  '',
  'export function logout(): string {',
  "  return 'bye';",
  '}',
  '',
  'export class Session {',
  '  ttl = 5;',
  '  refresh(): number {',
  '    return 1;',
  '  }',
  '}',
  '',
].join('\n');

const ON = { enabled: true, exclude: [] as string[] };

/** A TypeScript file with `n` functions f0..f(n-1), each returning `v`. */
function many(n: number, v: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => `export function f${i}(): number {\n  return ${v(i)};\n}\n`).join('\n');
}

let t: Tmp;
let repo: Repo;
let git: GitPort;
let B: string;
let H: string;

beforeAll(() => {
  t = tmp('lander-symbols-');
  repo = Repo.init(path.join(t.dir, 'repo'));
  B = repo.commit('base', {
    'src/auth.ts': AUTH,
    'src/forty.ts': many(41, () => '0'),
    'src/wide.ts': many(41, () => '0'),
    'src/broken.ts': 'export const ok = 1;\n',
    'src/gen.generated.ts': 'export function gen(): number {\n  return 1;\n}\n',
    'src/gone.ts': 'export const gone = 1;\n',
    'README.md': '# readme\n',
  });
  H = repo.commit('change', {
    'src/auth.ts': AUTH.replace('  return hash(user);', '  return hash(user.trim());').replace('    return 1;', '    return 2;'),
    // 40 changed keys: still symbol-level; 41: the whole file.
    'src/forty.ts': many(41, (i) => (i < 40 ? '1' : '0')),
    'src/wide.ts': many(41, () => '1'),
    'src/broken.ts': 'export const ok = {\n',
    'src/gen.generated.ts': 'export function gen(): number {\n  return 2;\n}\n',
    'src/gone.ts': null,
    'src/new.ts': 'export const fresh = 1;\n',
    'README.md': '# read me\n',
  });
  git = openGitPort({ mirror: repo.dir, remote: 'origin' });
});
afterAll(() => t.cleanup());

const FILES = ['README.md', 'src/auth.ts', 'src/broken.ts', 'src/forty.ts', 'src/gen.generated.ts', 'src/gone.ts', 'src/new.ts', 'src/wide.ts'];

describe('the admission scope (design §2.2.4 step 4)', () => {
  it('maps each changed file through changedSymbols with 40 keys per file; a file-level result names the whole file', async () => {
    expect(ADMISSION_MAX_SYMBOLS).toBe(40);
    expect(await git.diffNames(B, H)).toEqual(FILES);
    const r = await admissionScope(git, { files: FILES, base: B, head: H, config: ON });
    expect(r.mapper).toBe(MAPPER_VERSION);
    expect(r.scope).toEqual([
      // Unsupported language.
      { file: 'README.md' },
      // A body change in login and in a method: their keys only.
      { file: 'src/auth.ts', symbol: 'login' },
      { file: 'src/auth.ts', symbol: 'Session.refresh' },
      // An uncontained parse error (an unclosed brace): parse_error.
      { file: 'src/broken.ts' },
      // Exactly 40 keys: symbol-level.
      ...Array.from({ length: 40 }, (_, i) => ({ file: 'src/forty.ts', symbol: `f${i}` })),
      { file: 'src/gen.generated.ts', symbol: 'gen' },
      // Deleted and new files.
      { file: 'src/gone.ts' },
      { file: 'src/new.ts' },
      // 41 keys: too_many_symbols.
      { file: 'src/wide.ts' },
    ]);
  });

  it("follows trunk's symbols section: exclude maps a path whole-file, and enabled: false leaves the scope file-level (no mapper)", async () => {
    const excluded = await admissionScope(git, { files: ['src/auth.ts', 'src/gen.generated.ts'], base: B, head: H, config: { enabled: true, exclude: ['**/*.generated.ts'] } });
    expect(excluded).toEqual({
      scope: [
        { file: 'src/auth.ts', symbol: 'login' },
        { file: 'src/auth.ts', symbol: 'Session.refresh' },
        { file: 'src/gen.generated.ts' },
      ],
      mapper: MAPPER_VERSION,
    });
    expect(await admissionScope(git, { files: FILES, base: B, head: H, config: { enabled: false, exclude: [] } })).toEqual({ scope: null, mapper: null });
  });

  it('is null when no entry names a symbol (the landing is file-level only), and never fails on a mapping error', async () => {
    expect(await admissionScope(git, { files: ['README.md', 'src/new.ts'], base: B, head: H, config: ON })).toEqual({ scope: null, mapper: MAPPER_VERSION });
    const lines: string[] = [];
    const failing: Pick<GitPort, 'showBlob'> = {
      showBlob: async (rev, p) => {
        if (p === 'src/auth.ts') throw new Error('object store unreadable');
        return git.showBlob(rev, p);
      },
    };
    const r = await admissionScope(failing, { files: ['src/auth.ts', 'src/gen.generated.ts'], base: B, head: H, config: ON, log: (l) => lines.push(l) });
    expect(r.scope).toEqual([{ file: 'src/auth.ts' }, { file: 'src/gen.generated.ts', symbol: 'gen' }]);
    expect(lines.join('\n')).toMatch(/src\/auth\.ts.*object store unreadable.*whole file/);
  });

  it('keeps the request within the hub’s limit on scope entries: the files with the most keys go whole-file first', async () => {
    expect(MAX_SCOPE_ENTRIES).toBe(20_000);
    const r = await admissionScope(git, { files: ['src/auth.ts', 'src/forty.ts'], base: B, head: H, config: ON, maxEntries: 10 });
    expect(r.scope).toEqual([
      { file: 'src/auth.ts', symbol: 'login' },
      { file: 'src/auth.ts', symbol: 'Session.refresh' },
      { file: 'src/forty.ts' },
    ]);
  });
});

describe('the landed signature changes (design §2.5 "Producers": T0 vs C)', () => {
  let T0: string;
  let C: string;
  let world: Repo;
  let wgit: GitPort;

  beforeAll(() => {
    world = Repo.init(path.join(t.dir, 'landed'));
    T0 = world.commit('trunk', { 'src/auth.ts': AUTH, 'src/util.py': 'def helper(x):\n    return x\n', 'README.md': '# r\n' });
    C = world.commit('landed', {
      'src/auth.ts': AUTH.replace('login(user: string): string', 'login(user: string, opts: LoginOpts): Promise<Session>')
        .replace('export function logout(): string', 'export function signOut(): string')
        .replace('  refresh(): number {\n    return 1;\n  }\n', ''),
      'src/util.py': 'def helper(x, y=0):\n    return x\n',
      'README.md': '# readme\n',
    });
    wgit = openGitPort({ mirror: world.dir, remote: 'origin' });
  });

  it('records each signature change, rename and removal of the landed commit against its parent, with the task', async () => {
    const changes = await landedSymbolChanges(wgit, { commit: C, taskId: 'T-3', config: ON });
    expect(changes).toEqual([
      {
        file: 'src/auth.ts',
        symbol: 'login',
        kind: 'signature',
        before: 'function login(user: string): string',
        after: 'function login(user: string, opts: LoginOpts): Promise<Session>',
        task_id: 'T-3',
      },
      { file: 'src/auth.ts', symbol: 'logout', kind: 'renamed', before: 'function logout(): string', after: 'function signOut(): string', renamed_to: 'signOut', task_id: 'T-3' },
      { file: 'src/auth.ts', symbol: 'Session.refresh', kind: 'removed', before: 'refresh(): number', after: null, task_id: 'T-3' },
      { file: 'src/util.py', symbol: 'helper', kind: 'signature', before: 'def helper(x)', after: 'def helper(x, y=0)', task_id: 'T-3' },
    ]);
  });

  it('leaves the task out without one, finds nothing for a commit without a parent, and nothing with symbols disabled', async () => {
    const changes = await landedSymbolChanges(wgit, { commit: C, taskId: null, config: ON });
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) expect(c).not.toHaveProperty('task_id');
    expect(await landedSymbolChanges(wgit, { commit: T0, taskId: 'T-3', config: ON })).toEqual([]);
    expect(await landedSymbolChanges(wgit, { commit: C, taskId: 'T-3', config: { enabled: false, exclude: [] } })).toEqual([]);
    expect((await landedSymbolChanges(wgit, { commit: C, taskId: null, config: { enabled: true, exclude: ['**/*.py'] } })).map((c) => c.file)).toEqual(['src/auth.ts', 'src/auth.ts', 'src/auth.ts']);
  });
});

describe('the declarations each conflict hunk lies in (design §2.2.6 step 4)', () => {
  /** A diff3-marked text: `before`, then a region (trunk / base / yours), then `after`. */
  const region = (trunk: string, base: string, yours: string) => `<<<<<<< trunk\n${trunk}||||||| base\n${base}=======\n${yours}>>>>>>> yours\n`;

  it('names the innermost declarations around each hunk, by start line, on any of the three sides', async () => {
    const merged = [
      "import { hash } from './hash';\n\n",
      'export function login(user: string): string {\n',
      region('  return hash(user.trim());\n', '  return hash(user);\n', '  return hash(user.toLowerCase());\n'),
      '}\n\nexport class Session {\n  ttl = 5;\n  refresh(): number {\n',
      region('    return 2;\n', '    return 1;\n', '    return 3;\n'),
      '  }\n}\n\n',
      // trunk renamed the function, yours changed its body.
      region('export function signOut(): string {\n', 'export function logout(): string {\n', 'export function logout(): string {\n'),
      "  return 'bye';\n}\n",
    ].join('');
    const out = await hunkSymbols('src/auth.ts', merged, 7);
    expect(out).toEqual(
      new Map([
        [4, ['login']],
        [16, ['Session.refresh']],
        [26, ['signOut', 'logout']],
      ]),
    );
  });

  it('a hunk that one side emptied names the declarations it lies inside; the gap between declarations names nothing', async () => {
    const merged = [
      'export function a(): number {\n',
      region('', '  const x = 1;\n', '  const x = 2;\n'),
      '  return 1;\n}\n\n',
      region('', '', 'export function b(): number {\n  return 2;\n}\n\n'),
      'export function c(): number {\n  return 3;\n}\n',
    ].join('');
    const out = await hunkSymbols('src/m.ts', merged, 7);
    expect(out.get(2)).toEqual(['a']);
    expect(out.get(11)).toEqual(['b']);
  });

  it('gives nothing for an unsupported language, or for a side that does not parse', async () => {
    expect(await hunkSymbols('notes.txt', region('a\n', 'b\n', 'c\n'), 7)).toEqual(new Map());
    // Every view is one unclosed brace: an uncontained error on each side.
    expect(await hunkSymbols('src/x.ts', `export const x = {\n${region('  a: 1,\n', '  a: 0,\n', '  a: 2,\n')}`, 7)).toEqual(new Map([[2, []]]));
  });
});

describe('the parse gate (design §2.6 gate 6)', () => {
  const ours = 'export const a = 2;\n';
  const theirs = 'export const a = 3;\n';

  it('refuses a result with an uncontained parse error when both sides parse', async () => {
    const why = await symbolsParseCheck({ path: 'src/a.ts', ours, theirs, result: 'export const a = {\n' });
    expect(why).toMatch(/doesn't parse/);
    expect(await symbolsParseCheck({ path: 'src/a.ts', ours, theirs, result: 'export const a = 2;\nexport const b = 3;\n' })).toBeNull();
  });

  it('allows a contained error (inside one function body), and does not apply when a side already fails to parse or the language is unknown', async () => {
    const fn = (body: string) => `export function f(): number {\n${body}\n}\n\nexport function g(): number {\n  return 1;\n}\n`;
    expect(await symbolsParseCheck({ path: 'src/f.ts', ours: fn('  return 1;'), theirs: fn('  return 2;'), result: fn('  return 1 +;') })).toBeNull();
    expect(await symbolsParseCheck({ path: 'src/a.ts', ours: 'export const a = {\n', theirs, result: 'export const a = {\n' })).toBeNull();
    expect(await symbolsParseCheck({ path: 'notes.txt', ours: 'a\n', theirs: 'b\n', result: '{{{\n' })).toBeNull();
  });
});
