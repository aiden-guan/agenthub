// The additive helpers behind the lander's fix-it reports (design §2.2.6
// step 4) and the AI resolver's input (§2.6): mergeFile over three blobs, and
// the first-parent history of one path with its trailers.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeFile, pathHistory } from '../src/index.js';
import { Repo, sh, snapshot, tmp, type Tmp } from './helpers.js';

const EPOCH = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

describe('mergeFile', () => {
  let t: Tmp;
  let repo: Repo;
  beforeEach(() => {
    t = tmp();
    repo = Repo.init(path.join(t.dir, 'r'));
    repo.commit('root', { 'a.txt': 'a\n' });
  });
  afterEach(() => t.cleanup());

  const blob = (s: string) => sh(repo.dir, ['hash-object', '-w', '--stdin'], {}, s).trim();

  it('merges three blobs with diff3 markers labelled trunk, base and yours, and counts the conflicts', async () => {
    const g = repo.open();
    const blobs = { base: blob('1\n2\n3\n4\n5\n6\n7\n8\n9\n'), trunk: blob('1\nT\n3\n4\n5\n6\n7\nT\n9\n'), yours: blob('1\nY\n3\n4\n5\n6\n7\nY\n9\n') };
    const before = snapshot(repo.dir);
    const r = await mergeFile(g, blobs);
    expect(r.conflicts).toBe(2);
    expect(r.markerSize).toBe(7);
    expect(r.text).toBe(
      '1\n<<<<<<< trunk\nT\n||||||| base\n2\n=======\nY\n>>>>>>> yours\n3\n4\n5\n6\n7\n<<<<<<< trunk\nT\n||||||| base\n8\n=======\nY\n>>>>>>> yours\n9\n',
    );
    // Nothing is written to the repository.
    expect(snapshot(repo.dir)).toEqual(before);
    const clean = await mergeFile(g, { base: blob('x\n'), trunk: blob('x\n'), yours: blob('x\ny\n') });
    expect(clean).toEqual({ text: 'x\ny\n', conflicts: 0, markerSize: 7 });
  });

  it('treats an absent side as empty (add/add), and lengthens the markers past marker-like lines', async () => {
    const g = repo.open();
    const addAdd = await mergeFile(g, { base: null, trunk: blob('t\n'), yours: blob('y\n') });
    expect(addAdd.conflicts).toBe(1);
    expect(addAdd.text).toBe('<<<<<<< trunk\nt\n||||||| base\n=======\ny\n>>>>>>> yours\n');
    const marked = await mergeFile(g, { base: blob('a\n========\nb\n'), trunk: blob('a\n========\nt\n'), yours: blob('a\n========\ny\n') });
    expect(marked.markerSize).toBe(9);
    expect(marked.text).toContain(`\n${'='.repeat(9)}\n`);
    expect(marked.text).toContain(`${'<'.repeat(9)} trunk\n`);
  });

  it('refuses what is not a full object id', async () => {
    await expect(mergeFile(repo.open(), { base: 'HEAD:a.txt', trunk: null, yours: null })).rejects.toThrow(/full object id/);
  });
});

describe('pathHistory', () => {
  let t: Tmp;
  beforeEach(() => {
    t = tmp();
  });
  afterEach(() => t.cleanup());

  it('lists the first-parent commits that changed a path, newest first, with subjects and trailers', async () => {
    const repo = Repo.init(path.join(t.dir, 'r'));
    const base = repo.commit('base', { 'src/a.ts': '0\n', 'b.txt': '0\n' });
    const one = repo.commit(`Rate-limit login\n\nAgenthub-Landing: acme/web/L-5\nAgenthub-Hub: ${EPOCH}\nAgenthub-Source: ${'d'.repeat(40)}\nAgenthub-Agent: sam/claude-1`, { 'src/a.ts': '1\n' });
    repo.commit('other file', { 'b.txt': '1\n' });
    // A side branch merged with --no-ff: only its merge commit is first-parent.
    repo.git('checkout', '-q', '-b', 'side');
    const sideCommit = repo.commit('side change', { 'src/a.ts': '2\n' });
    repo.git('checkout', '-q', 'main');
    repo.git('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
    const merge = repo.head();
    const three = repo.commit('hotfix', { 'src/a.ts': '3\n' });

    const all = await pathHistory(repo.open(), base, three, 'src/a.ts', 10);
    expect(all.map((c) => c.sha)).toEqual([three, merge, one]);
    expect(all.map((c) => c.subject)).toEqual(['hotfix', 'merge side', 'Rate-limit login']);
    expect(all.map((c) => c.sha)).not.toContain(sideCommit);
    expect(all[2]).toMatchObject({ landing: 'acme/web/L-5', hub: EPOCH, source: 'd'.repeat(40), agent: 'sam/claude-1', task: null });
    expect(all[0]).toMatchObject({ landing: null, hub: null, source: null });

    expect((await pathHistory(repo.open(), base, three, 'src/a.ts', 2)).map((c) => c.sha)).toEqual([three, merge]);
    expect((await pathHistory(repo.open(), one, three, 'src/a.ts', 10)).map((c) => c.sha)).toEqual([three, merge]);
    expect((await pathHistory(repo.open(), null, three, 'b.txt', 10)).map((c) => c.subject)).toEqual(['other file', 'base']);
    // A literal path: glob characters match nothing else.
    expect(await pathHistory(repo.open(), null, three, 'src/*.ts', 10)).toEqual([]);
    await expect(pathHistory(repo.open(), null, three, '../x', 10)).rejects.toThrow(/bad path/);
  });
});
