// The one function that moves trunk (design §2.2.5 P10, §4.1 #2–#5, §4.3):
// pushTrunk's asserts, exact argument list and outcomes on a real bare
// remote; pushRef's allowlist; lsRemote.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyPush, commitTree, lsRemote, open, pushRef, pushTrunk } from '../src/index.js';
import type { Git } from '../src/types.js';
import { AUTHOR, bareRemote, gitShim, IDENT_ENV, LANDER, refuseTrunkHook, Repo, sh, tmp, type Tmp } from './helpers.js';

let t: Tmp;
let remote: string;
let work: Repo;
let M1: string;
let T0: string;
let H: string;
let mirror: string;
let shim: ReturnType<typeof gitShim>;
let g: Git;
let C: string;

const landRef = (sha: string) => `refs/agenthub/land/${sha}`;
function remoteRev(ref: string): string {
  try {
    return sh(remote, ['rev-parse', '--verify', '--quiet', ref]).trim();
  } catch {
    return '';
  }
}
const pushCalls = () => shim.calls().filter((c) => c.includes('push') && c.includes('--porcelain'));

beforeEach(async () => {
  t = tmp();
  remote = bareRemote(path.join(t.dir, 'remote.git'));
  work = Repo.init(path.join(t.dir, 'work'));
  M1 = work.commit('first', { 'a.txt': 'a\n' });
  T0 = work.commit('second', { 'a.txt': 'a\nb\n' });
  work.git('push', '-q', remote, 'main');
  work.checkout('-b', 'agent');
  H = work.commit('agent work', { 'c.txt': 'c\n' });
  work.git('push', '-q', remote, `${H}:${landRef(H)}`);
  work.checkout('main');
  mirror = path.join(t.dir, 'mirror.git');
  sh(t.dir, ['clone', '-q', '--bare', remote, mirror]);
  sh(mirror, ['fetch', '-q', remote, `+${landRef(H)}:${landRef(H)}`]);
  shim = gitShim(t.dir);
  g = open(mirror, { isolated: true, env: { ...IDENT_ENV, PATH: shim.path } });
  // The candidate: H's tree on top of T0, as the lander builds it.
  C = await commitTree(g, sh(mirror, ['rev-parse', `${H}^{tree}`]).trim(), T0, 'land L-1 (L-1)\n\nAgenthub-Landing: acme/web/L-1\n', { ...AUTHOR, date: '1767225600 +0000' }, LANDER);
});
afterEach(() => t.cleanup());

describe('pushTrunk', () => {
  it('runs exactly the CAS push, moves trunk to C and deletes the land ref in the same push', async () => {
    const out = await pushTrunk(g, { remote, trunk: 'main', candidate: C, expected: T0, deleteRef: landRef(H) });
    expect(out).toEqual({ kind: 'ok' });
    const calls = pushCalls();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.slice(call.indexOf('push'))).toEqual(['push', '--atomic', '--porcelain', `--force-with-lease=refs/heads/main:${T0}`, remote, `${C}:refs/heads/main`, `:${landRef(H)}`]);
    // The isolation flags come first.
    expect(call.slice(0, call.indexOf('push'))).toEqual(expect.arrayContaining(['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0']));
    expect(remoteRev('refs/heads/main')).toBe(C);
    expect(remoteRev(landRef(H))).toBe('');
  });

  it('reports up_to_date when trunk is already the candidate', async () => {
    expect(await pushTrunk(g, { remote, trunk: 'main', candidate: C, expected: T0, deleteRef: landRef(H) })).toEqual({ kind: 'ok' });
    expect(await pushTrunk(g, { remote, trunk: 'main', candidate: C, expected: T0, deleteRef: landRef(H) })).toEqual({ kind: 'up_to_date' });
    expect(await pushTrunk(g, { remote, trunk: 'main', candidate: C, expected: T0 })).toEqual({ kind: 'up_to_date' });
    expect(remoteRev('refs/heads/main')).toBe(C);
  });

  it('is stale when trunk moved past T0', async () => {
    const other = Repo.init(path.join(t.dir, 'other'));
    other.git('fetch', '-q', remote, 'main');
    other.git('reset', '-q', '--hard', 'FETCH_HEAD');
    const F = other.commit('foreign', { 'f.txt': 'f\n' });
    other.git('push', '-q', remote, 'HEAD:refs/heads/main');
    const out = await pushTrunk(g, { remote, trunk: 'main', candidate: C, expected: T0, deleteRef: landRef(H) });
    expect(out.kind).toBe('stale');
    expect(remoteRev('refs/heads/main')).toBe(F);
    expect(remoteRev(landRef(H))).toBe(H);
  });

  it('is stale when trunk was rewound below T0, where a plain fast-forward push would re-add T0', async () => {
    sh(remote, ['update-ref', 'refs/heads/main', M1]);
    // C descends from M1, so an ordinary push would fast-forward and silently bring T0 back.
    expect(sh(t.dir, ['-C', mirror, 'merge-base', '--is-ancestor', M1, C]).trim()).toBe('');
    const out = await pushTrunk(g, { remote, trunk: 'main', candidate: C, expected: T0 });
    expect(out).toMatchObject({ kind: 'stale', detail: expect.stringContaining('stale info') });
    expect(remoteRev('refs/heads/main')).toBe(M1);
  });

  it('is rejected by a host rule (update hook), and the land ref stays because the push is atomic', async () => {
    refuseTrunkHook(remote);
    const out = await pushTrunk(g, { remote, trunk: 'main', candidate: C, expected: T0, deleteRef: landRef(H) });
    expect(out).toMatchObject({ kind: 'rejected', detail: expect.stringContaining('hook declined') });
    expect(remoteRev('refs/heads/main')).toBe(T0);
    expect(remoteRev(landRef(H))).toBe(H);
  });

  it('refuses, before any push, a candidate that is not a child of the expected tip', async () => {
    const tree = sh(mirror, ['rev-parse', `${H}^{tree}`]).trim();
    const grandchild = await commitTree(g, tree, M1, 'built on an old trunk\n', { ...AUTHOR, date: '1767225600 +0000' }, LANDER);
    await expect(pushTrunk(g, { remote, trunk: 'main', candidate: grandchild, expected: T0 })).rejects.toThrow(/first parent/);
    await expect(pushTrunk(g, { remote, trunk: 'main', candidate: T0, expected: T0 })).rejects.toThrow(/first parent/);
    const root = sh(mirror, ['commit-tree', tree, '-m', 'root'], IDENT_ENV).trim();
    await expect(pushTrunk(g, { remote, trunk: 'main', candidate: root, expected: T0 })).rejects.toThrow(/first parent/);
    await expect(pushTrunk(g, { remote, trunk: 'main', candidate: 'main', expected: T0 })).rejects.toThrow(/full sha/);
    await expect(pushTrunk(g, { remote: '--upload-pack=evil', trunk: 'main', candidate: C, expected: T0 })).rejects.toThrow(/remote/);
    await expect(pushTrunk(g, { remote, trunk: 'main:refs/heads/other', candidate: C, expected: T0 })).rejects.toThrow(/trunk/);
    expect(pushCalls()).toEqual([]);
    expect(remoteRev('refs/heads/main')).toBe(T0);
  });

  it('reports unknown when the remote is unreachable or the push times out', async () => {
    const gone = await pushTrunk(g, { remote: path.join(t.dir, 'no-such-remote.git'), trunk: 'main', candidate: C, expected: T0 });
    expect(gone.kind).toBe('unknown');
    const hang = gitShim(path.join(t.dir, 'hang'), { block: 'push', sleep: 5, code: 1 });
    const slow = open(mirror, { isolated: true, env: { ...IDENT_ENV, PATH: hang.path } });
    const started = Date.now();
    const out = await pushTrunk(slow, { remote, trunk: 'main', candidate: C, expected: T0, timeoutMs: 300 });
    expect(out).toMatchObject({ kind: 'unknown', detail: expect.stringContaining('timed out') });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(remoteRev('refs/heads/main')).toBe(T0);
  });
});

describe('pushRef', () => {
  const cand = (n: string) => `refs/agenthub/cand/1b4e28ba/L-1/${n}`;

  it('pushes a new ref plainly, never forced, and deletes one', async () => {
    expect(await pushRef(g, { remote, prefix: 'refs/agenthub/', sha: C, ref: cand(C.slice(0, 12)) })).toEqual({ kind: 'ok' });
    const call = pushCalls().at(-1)!;
    expect(call.slice(call.indexOf('push'))).toEqual(['push', '--porcelain', remote, `${C}:${cand(C.slice(0, 12))}`]);
    expect(remoteRev(cand(C.slice(0, 12)))).toBe(C);
    expect(await pushRef(g, { remote, prefix: 'refs/agenthub/', sha: C, ref: cand(C.slice(0, 12)) })).toEqual({ kind: 'up_to_date' });
    // Another sha onto the same name is refused, not forced.
    const out = await pushRef(g, { remote, prefix: 'refs/agenthub/', sha: T0, ref: cand(C.slice(0, 12)) });
    expect(out.kind).toBe('stale');
    expect(remoteRev(cand(C.slice(0, 12)))).toBe(C);
    expect(await pushRef(g, { remote, prefix: 'refs/agenthub/', sha: null, ref: cand(C.slice(0, 12)) })).toEqual({ kind: 'ok' });
    expect(remoteRev(cand(C.slice(0, 12)))).toBe('');
    expect(await pushRef(g, { remote, prefix: 'refs/agenthub/', sha: null, ref: landRef(H) })).toEqual({ kind: 'ok' });
    expect(remoteRev(landRef(H))).toBe('');
    for (const c of pushCalls()) expect(c.some((a) => a.startsWith('+') || a.startsWith('--force') || a === '-f')).toBe(false);
  });

  it('works under the refs/heads/agenthub/ fallback prefix', async () => {
    expect(await pushRef(g, { remote, prefix: 'refs/heads/agenthub/', sha: H, ref: `refs/heads/agenthub/land/${H}` })).toEqual({ kind: 'ok' });
    expect(remoteRev(`refs/heads/agenthub/land/${H}`)).toBe(H);
  });

  it('refuses any ref outside <prefix>land/ and <prefix>cand/', async () => {
    const bad = [
      'refs/heads/main',
      'refs/agenthub/other/x',
      'refs/agenthub/landx/y',
      'refs/agenthub/land/../../heads/main',
      'refs/agenthub/cand/a//b',
      'refs/agenthub/cand/x.lock',
      'refs/agenthub/land/a b',
      'refs/agenthub/land/',
      'refs/agenthub/cand/*',
    ];
    for (const ref of bad) await expect(pushRef(g, { remote, prefix: 'refs/agenthub/', sha: C, ref })).rejects.toThrow(/ref/);
    await expect(pushRef(g, { remote, prefix: 'refs/agenthub', sha: C, ref: 'refs/agenthub/land/x' })).rejects.toThrow(/prefix/);
    await expect(pushRef(g, { remote, prefix: 'heads/', sha: C, ref: 'heads/land/x' })).rejects.toThrow(/prefix/);
    await expect(pushRef(g, { remote, prefix: 'refs/agenthub/', sha: 'HEAD', ref: `refs/agenthub/land/${C}` })).rejects.toThrow(/full sha/);
    expect(pushCalls()).toEqual([]);
    expect(remoteRev('refs/heads/main')).toBe(T0);
  });
});

describe('lsRemote', () => {
  it('returns the sha of exactly that ref, or null', async () => {
    sh(remote, ['update-ref', 'refs/heads/x/main', M1]);
    expect(await lsRemote(g, remote, 'refs/heads/main')).toBe(T0);
    expect(await lsRemote(g, remote, landRef(H))).toBe(H);
    expect(await lsRemote(g, remote, 'refs/heads/nope')).toBeNull();
    expect(await lsRemote(g, remote, 'main')).toBeNull();
    await expect(lsRemote(g, path.join(t.dir, 'no-such-remote.git'), 'refs/heads/main')).rejects.toThrow();
  });
});

describe('classifyPush', () => {
  const trunk = 'refs/heads/main';
  const out = (lines: string[], code = 1, stderr = '') => ({ code, stdout: `To origin\n${lines.join('\n')}\nDone\n`, stderr });

  it('classifies an atomic failure by the ref that caused it', () => {
    expect(classifyPush(out([`!\tC:${trunk}\t[rejected] (atomic push failed)`, '!\t:refs/agenthub/land/x\t[remote rejected] (deny deletes)']), trunk)).toMatchObject({ kind: 'rejected', detail: expect.stringContaining('deny deletes') });
    expect(classifyPush(out([`!\tC:${trunk}\t[remote rejected] (atomic push failure)`, '!\t:refs/agenthub/land/x\t[rejected] (stale info)']), trunk)).toMatchObject({ kind: 'stale' });
  });

  it('reads ok, up to date, non-fast-forward, a remote failure and a missing status line', () => {
    expect(classifyPush(out([` \tC:${trunk}\tabc..def`], 0), trunk)).toEqual({ kind: 'ok' });
    expect(classifyPush(out([`*\tC:${trunk}\t[new branch]`], 0), trunk)).toEqual({ kind: 'ok' });
    expect(classifyPush(out([`=\tC:${trunk}\t[up to date]`], 0), trunk)).toEqual({ kind: 'up_to_date' });
    expect(classifyPush(out([`!\tC:${trunk}\t[rejected] (non-fast-forward)`]), trunk).kind).toBe('stale');
    expect(classifyPush(out([`!\tC:${trunk}\t[remote failure] (remote failed to report status)`]), trunk).kind).toBe('unknown');
    expect(classifyPush({ code: 128, stdout: '', stderr: 'fatal: unable to access https://u:pw@host/r.git: timeout\n' }, trunk)).toEqual({ kind: 'unknown', detail: expect.not.stringContaining('pw@') });
  });
});
