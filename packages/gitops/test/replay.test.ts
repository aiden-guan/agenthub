// The agent-side helpers sync builds on (design §2.3.5): replay in the object
// database, forecastConflicts and stashCreate, all of which must leave the
// worktree, the index and every ref exactly as they were.
import { utimesSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forecastConflicts, replay, stashCreate } from '../src/index.js';
import type { Git } from '../src/types.js';
import { refs, Repo, sh, snapshot, tmp, type Tmp } from './helpers.js';

let t: Tmp;
let r: Repo;
let g: Git;
beforeEach(() => {
  t = tmp();
  r = Repo.init(path.join(t.dir, 'w'));
  // The adapter opens agent worktrees without isolation; the test env still has no global config.
  g = r.open(false);
});
afterEach(() => t.cleanup());

/** Everything sync must not touch: files (with .git/index), HEAD and refs. */
function state(): { files: Record<string, string>; refs: string } {
  return { files: snapshot(r.dir, (rel) => rel.startsWith('.git/objects') || rel === '.git/logs' || rel.startsWith('.git/logs/')), refs: refs(r.dir) };
}

/** Age every file (and the index) so git's racy-timestamp handling never rewrites the index during a test. */
function settle(): void {
  const past = new Date(Date.now() - 3600_000);
  for (const rel of Object.keys(snapshot(r.dir, (p) => p.startsWith('.git')))) utimesSync(path.join(r.dir, rel), past, past);
  // Exit 1 just lists files with local changes ("needs update"), which some tests have on purpose.
  sh(r.dir, ['update-index', '-q', '--really-refresh', '--unmerged'], {}, undefined, [0, 1]);
}

describe('replay', () => {
  it('replays linear commits onto trunk with their authors, dates and messages, changing nothing else', async () => {
    const base = r.commit('base', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    r.checkout('-b', 'agent');
    const c1 = r.commit('agent one\n\nwith a body', { 'b.txt': 'b\nb2\n' });
    const c2 = r.commit('agent two', { 'n.txt': 'n\n' });
    r.checkout('main');
    const T = r.commit('trunk', { 'a.txt': 'A\n' });
    r.checkout('agent');
    settle();
    const before = state();

    const out = await replay(g, [c1, c2], T);
    expect(out.kind).toBe('ok');
    const tip = (out as { kind: 'ok'; tip: string }).tip;
    expect(r.git('rev-list', '--first-parent', `${T}..${tip}`).split('\n')).toHaveLength(2);
    expect(r.git('rev-parse', `${tip}~2`)).toBe(T);
    expect(r.git('show', `${tip}:a.txt`)).toBe('A');
    expect(r.git('show', `${tip}:b.txt`)).toBe('b\nb2');
    expect(r.git('show', `${tip}:n.txt`)).toBe('n');
    for (const [orig, copy] of [[c1, `${tip}~1`], [c2, tip]] as const) {
      expect(r.git('log', '-1', '--format=%an <%ae> %ad%n%B', '--date=raw', copy)).toBe(r.git('log', '-1', '--format=%an <%ae> %ad%n%B', '--date=raw', orig));
    }
    expect(state()).toEqual(before);
    expect(base).not.toBe(T);
  });

  it('returns ok with the trunk tip for nothing to replay', async () => {
    const T = r.commit('base', { 'a.txt': 'a\n' });
    expect(await replay(g, [], T)).toEqual({ kind: 'ok', tip: T });
  });

  it('reports a conflict and leaves refs, index and files byte-identical', async () => {
    r.commit('base', { 'a.txt': 'one\ntwo\n' });
    r.checkout('-b', 'agent');
    const c1 = r.commit('agent edits a', { 'a.txt': 'one\nAGENT\n' });
    const c2 = r.commit('agent adds b', { 'b.txt': 'b\n' });
    r.checkout('main');
    const T = r.commit('trunk edits a', { 'a.txt': 'one\nTRUNK\n' });
    r.checkout('agent');
    // An uncommitted edit too: replay must not care, and must not touch it.
    r.write('b.txt', 'local edit\n');
    settle();
    const before = state();
    expect(await replay(g, [c1, c2], T)).toEqual({ kind: 'conflict', commit: c1, files: ['a.txt'] });
    expect(state()).toEqual(before);
  });

  it('refuses merges in the branch before writing anything', async () => {
    r.commit('base', { 'a.txt': 'a\n' });
    r.checkout('-b', 'agent');
    const c1 = r.commit('agent', { 'b.txt': 'b\n' });
    r.checkout('-b', 'side', 'main');
    r.commit('side', { 's.txt': 's\n' });
    r.checkout('agent');
    r.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const m = r.head();
    const T = r.rev('main');
    settle();
    const before = state();
    expect(await replay(g, [c1, m], T)).toEqual({ kind: 'merges', commit: m });
    expect(state()).toEqual(before);
  });
});

describe('forecastConflicts', () => {
  it('lists the paths that would conflict, touching nothing', async () => {
    const base = r.commit('base', { 'a.txt': 'one\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    r.checkout('-b', 'agent');
    r.commit('agent', { 'c.txt': 'C-agent\n' });
    r.checkout('main');
    const T = r.commit('trunk', { 'a.txt': 'TRUNK\n', 'c.txt': 'C-trunk\n' });
    r.checkout('agent');
    r.write('a.txt', 'DIRTY\n');
    settle();
    const before = state();
    const w = await stashCreate(g);
    expect(w).not.toBeNull();
    expect(await forecastConflicts(g, T, w!, base)).toEqual(['a.txt', 'c.txt']);
    expect(await forecastConflicts(g, T, r.head())).toEqual(['c.txt']);
    expect(await forecastConflicts(g, T, base)).toEqual([]);
    expect(state()).toEqual(before);
  });
});

describe('stashCreate', () => {
  it('returns null for a clean worktree', async () => {
    r.commit('base', { 'a.txt': 'a\n' });
    r.write('untracked.txt', 'u\n');
    expect(await stashCreate(g)).toBeNull();
  });

  it('records the dirty worktree in a commit without writing refs or touching the index and files', async () => {
    r.commit('base', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    r.write('a.txt', 'a modified\n');
    r.write('b.txt', 'b staged\n');
    r.git('add', 'b.txt');
    r.write('u.txt', 'untracked\n');
    // The index is racy here (just written): a plain `git stash create` can refresh and rewrite it.
    const before = state();
    const w = await stashCreate(g);
    expect(w).toMatch(/^[0-9a-f]{40}$/);
    expect(state()).toEqual(before);
    expect(sh(r.dir, ['show', `${w}:a.txt`])).toBe('a modified\n');
    expect(sh(r.dir, ['show', `${w}:b.txt`])).toBe('b staged\n');
    expect(() => sh(r.dir, ['rev-parse', '--verify', '--quiet', 'refs/stash'])).toThrow();
  });
});
