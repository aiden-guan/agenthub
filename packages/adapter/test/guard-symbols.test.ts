// A3 (design §2.3.6, the guard row; §4.2 #5): the pre-commit guard maps each
// staged modification to the declarations it changes (HEAD blob → index blob)
// and asks the hub with that scope, so a real `git commit` is blocked only
// when it touches code another agent holds. Added, deleted and renamed files,
// and merges, stay file-level.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RunningServer } from '@agenthub/hub';
import { MAPPER_VERSION } from '@agenthub/symbols';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { init } from '../src/init.js';
import { stagedScope } from '../src/symbol-scope.js';
import { A, B, CLI_COMMAND, PROJECT, client, git, run, startHub, testEnv } from './helpers.js';

const AUTH = [
  "import { hash } from './hash.js';",
  '',
  'export function login(user: string): string {',
  '  return `session-${user}`;',
  '}',
  '',
  'export function logout(session: string): boolean {',
  "  return session.startsWith('session-');",
  '}',
  '',
  'export function refresh(session: string): string {',
  '  return session + hash(session);',
  '}',
  '',
].join('\n');
const C = 'lee/claude-1';
const SYMBOLS = { enabled: true, exclude: [], maxSymbolsPerEdit: 12 };

let srv: RunningServer;
let dir: string;
let main: string;
let wtA: string;

beforeAll(async () => {
  srv = await startHub();
  dir = mkdtempSync(path.join(tmpdir(), 'agenthub-guard-sym-'));
  main = path.join(dir, 'sample');
  mkdirSync(path.join(main, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', main);
  writeFileSync(path.join(main, 'src', 'auth.ts'), AUTH);
  writeFileSync(path.join(main, 'src', 'hash.ts'), 'export function hash(s: string): string {\n  return String(s.length);\n}\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'initial');
  wtA = path.join(dir, 'wt-a');
  git(main, 'worktree', 'add', '-q', wtA, '-b', 'agent-a');
  init({ cwd: wtA, agent: A, project: PROJECT, url: srv.url, command: CLI_COMMAND, hooks: false, mcp: false, env: {} });
});
afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
  for (const agent of [A, B, C]) await client(srv.url, agent).release({ all: true });
});

const edit = (from: string, to: string) => {
  const text = AUTH.replace(from, to);
  expect(text).not.toBe(AUTH);
  return text;
};
const LOGIN = edit('`session-${user}`', '`session-${user.trim()}`');
const LOGOUT = edit("startsWith('session-')", "startsWith('sess-')");

/** Stage `files` in maya's worktree and run a real `git commit` there, with the guard installed by hub init. */
async function commitA(files: Record<string, string | null>, message: string) {
  for (const [p, content] of Object.entries(files)) {
    if (content === null) git(wtA, 'rm', '-q', '--', p);
    else {
      writeFileSync(path.join(wtA, p), content);
      git(wtA, 'add', '--', p);
    }
  }
  return run('git', ['commit', '-q', '-m', message], { cwd: wtA, env: testEnv() });
}

function undoStaged(): void {
  git(wtA, 'reset', '-q');
  git(wtA, 'checkout', '--', '.');
  git(wtA, 'clean', '-qfd', '--', 'src');
}

const claimSymbol = (agent: string, symbol: string, intent: string, mapper = MAPPER_VERSION) =>
  client(srv.url, agent).claim({ scope: [{ file: 'src/auth.ts', symbol }], mapper, intent });

describe('hub guard with symbol claims', () => {
  it("lets a commit through when it changes a function nobody else holds, and blocks one that changes another agent's", async () => {
    const held = await claimSymbol(B, 'logout', 'logout checks the length');
    expect(held.status).toBe('granted');

    const free = await commitA({ 'src/auth.ts': LOGIN }, 'login trims');
    expect(free.code, free.stderr).toBe(0);

    const blocked = await commitA({ 'src/auth.ts': edit("startsWith('session-')", "startsWith('sess-')").replace('`session-${user}`', '`session-${user.trim()}`') }, 'logout prefix');
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain('hub guard: commit blocked. These staged changes touch code exclusively claimed by other agents:\n');
    expect(blocked.stderr).toMatch(new RegExp(`\\n  src/auth\\.ts#logout — claimed by sam/claude-1 \\(${held.claim!.id}\\) to "logout checks the length" \\(expires in 2 min\\)\\n`));
    expect(blocked.stderr).not.toContain('#login');
    expect(git(wtA, 'log', '--format=%s')).not.toContain('logout prefix');
    undoStaged();
  });

  it('checks a deleted or added file as the whole file', async () => {
    await claimSymbol(B, 'logout', 'logout checks the length');
    const deleted = await commitA({ 'src/auth.ts': null }, 'drop auth');
    expect(deleted.code).not.toBe(0);
    expect(deleted.stderr).toMatch(/\n  src\/auth\.ts#logout — claimed by sam\/claude-1 /);
    undoStaged();

    await client(srv.url, B).claim({ scope: [{ file: 'src/session.ts', symbol: 'Session' }], mapper: MAPPER_VERSION, intent: 'session class' });
    const added = await commitA({ 'src/session.ts': 'export class Other {}\n' }, 'add session');
    expect(added.code).not.toBe(0);
    expect(added.stderr).toMatch(/\n  src\/session\.ts#Session — claimed by sam\/claude-1 /);
    undoStaged();
  });

  it("counts a claim made under another mapper version as its whole file, and says why", async () => {
    await claimSymbol(C, 'refresh', 'refresh rotates', 'sym0;other;00000000');
    const res = await commitA({ 'src/auth.ts': LOGOUT }, 'logout prefix');
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/\n  src\/auth\.ts#refresh — claimed by lee\/claude-1 \(C-\d+\) to "refresh rotates" \(expires in 2 min\); made by another version of agenthub, so it counts as the whole file\n/);
    undoStaged();
  });

  it('checks a merge commit file by file, as in Phase 1', async () => {
    await claimSymbol(B, 'logout', 'logout checks the length');
    const head = git(wtA, 'rev-parse', 'HEAD').trim();
    git(wtA, 'checkout', '-q', '-b', 'side');
    writeFileSync(path.join(wtA, 'src', 'auth.ts'), git(wtA, 'show', 'HEAD:src/auth.ts').replace('hash(session)', 'hash(session.trim())'));
    expect((await run('git', ['commit', '-qam', 'side: refresh trims'], { cwd: wtA, env: testEnv() })).code).toBe(0);
    git(wtA, 'checkout', '-q', 'agent-a');
    writeFileSync(path.join(wtA, 'src', 'hash.ts'), 'export function hash(s: string): string {\n  return String(s.length * 2);\n}\n');
    expect((await run('git', ['commit', '-qam', 'hash doubles'], { cwd: wtA, env: testEnv() })).code).toBe(0);
    writeFileSync(path.join(wtA, 'src', 'auth.ts'), git(wtA, 'show', 'HEAD:src/auth.ts').replace("'./hash.js'", "'./hash.js' // local"));
    expect((await run('git', ['commit', '-qam', 'imports note'], { cwd: wtA, env: testEnv() })).code).toBe(0);

    // The merge combines both sides' changes to src/auth.ts: a change of its own, checked as the whole file.
    const merged = await run('git', ['merge', '--no-ff', '--no-edit', 'side'], { cwd: wtA, env: testEnv() });
    expect(merged.code).not.toBe(0);
    expect(merged.stderr).toMatch(/This merge changes files exclusively claimed by other agents:\n  src\/auth\.ts#logout — claimed by sam\/claude-1 /);
    await run('git', ['merge', '--abort'], { cwd: wtA, env: testEnv() });
    git(wtA, 'reset', '-q', '--hard', head); // the test's own scratch repository
    git(wtA, 'branch', '-q', '-D', 'side');
  });
});

describe('stagedScope', () => {
  it('maps up to maxFiles modified files within the budget, and the rest as whole files', async () => {
    // HEAD has maya's login change (the first test committed it): this changes logout.
    writeFileSync(path.join(wtA, 'src', 'auth.ts'), LOGIN.replace("startsWith('session-')", "startsWith('sess-')"));
    writeFileSync(path.join(wtA, 'src', 'hash.ts'), 'export function hash(s: string): string {\n  return String(s.length + 1);\n}\n');
    git(wtA, 'add', '-A', 'src');
    try {
      expect(await stagedScope(wtA, { merging: [], symbols: SYMBOLS })).toEqual({
        files: ['src/auth.ts', 'src/hash.ts'],
        scope: [
          { file: 'src/auth.ts', symbol: 'logout' },
          { file: 'src/hash.ts', symbol: 'hash' },
        ],
        mapper: MAPPER_VERSION,
      });
      expect((await stagedScope(wtA, { merging: [], symbols: SYMBOLS, maxFiles: 1 })).scope).toEqual([{ file: 'src/auth.ts', symbol: 'logout' }, { file: 'src/hash.ts' }]);
      expect((await stagedScope(wtA, { merging: [], symbols: SYMBOLS, budgetMs: 0 })).scope).toEqual([{ file: 'src/auth.ts' }, { file: 'src/hash.ts' }]);
      expect(await stagedScope(wtA, { merging: [], symbols: { ...SYMBOLS, enabled: false } })).toEqual({ files: ['src/auth.ts', 'src/hash.ts'], scope: [{ file: 'src/auth.ts' }, { file: 'src/hash.ts' }], mapper: null });
      expect((await stagedScope(wtA, { merging: [], symbols: { ...SYMBOLS, exclude: ['src/hash.ts'] } })).scope).toEqual([{ file: 'src/auth.ts', symbol: 'logout' }, { file: 'src/hash.ts' }]);
    } finally {
      undoStaged();
    }
  });
});
