import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { gitops } from '@agenthub/gitops';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HubClient } from '../src/client.js';
import type { HubConfig } from '../src/config.js';
import { Feed } from '../src/feed.js';
import { syncDigestLine, syncPromptText, syncToolText } from '../src/format.js';
import { landWork } from '../src/land.js';
import { createMcpServer } from '../src/mcp.js';
import { PendingClaims } from '../src/pending.js';
import { HOOK_SYNC_BUDGET_MS, syncPaths, syncWorkspace, writeMarker, type SyncResult } from '../src/sync.js';
import { A, B, downUrl, fakeHub, git, hubCli, postToolUseInput, preToolUseInput, sessionEventInput, sleep, testEnv } from './helpers.js';
import { PROJECT, TestLander, commit, makeLandingRepo, report, startLandingHub, TEAM_CONFIG, type LandingHub, type LandingRepo } from './landing-hub.js';

// Step A2 (design §2.3.5, §3.10): workspace sync against real repositories,
// a real bare remote and a real hub; the lander's side is played over HTTP
// (TestLander), and its squash commits are made here with the real trailers.

// In-process git (the sync engine, landWork) must not read the developer's git config.
const savedEnv = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  });
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

let hub: LandingHub;
let repo: LandingRepo;
let lander: TestLander;
/** A clone of the remote the lander's squash commits are made in. */
let landerWt: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  hub = await startLandingHub();
  repo = makeLandingRepo();
  lander = new TestLander(hub.url);
  await lander.takeLease();
  landerWt = path.join(repo.dir, 'lander');
  git(repo.dir, 'clone', '-q', repo.remote, landerWt);
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  await hub.close();
  repo.cleanup();
});

function cfgFor(agent: string, root: string, url = hub.url): HubConfig {
  return { url, agent, project: PROJECT, token: null, failClosed: false, timeoutMs: 5000, root, configFiles: [], projectSource: 'env', warnings: [] };
}
const clientFor = (agent: string, url = hub.url) => new HubClient(cfgFor(agent, '/', url));
const envFor = (agent: string, extra: Record<string, string | undefined> = {}) => testEnv({ HUB_URL: hub.url, HUB_PROJECT: PROJECT, HUB_AGENT: agent, ...extra });

function sync(agent: string, root: string, o: { url?: string; mode?: 'update' | 'merge'; budgetMs?: number; recover?: boolean } = {}): Promise<SyncResult> {
  return syncWorkspace(root, cfgFor(agent, root, o.url), clientFor(agent, o.url), { reason: 'explicit', mode: o.mode, budgetMs: o.budgetMs, recover: o.recover });
}

const rev = (wt: string, r = 'HEAD') => git(wt, 'rev-parse', r).trim();
const remoteMain = () => git(repo.remote, 'rev-parse', 'main').trim();
const backupRefs = (wt: string) =>
  Object.fromEntries(
    git(wt, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/agenthub/backup/')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ')),
  );

/** Every file of the worktree (but .git), HEAD, and the index file's bytes, hashed. */
function snapshot(wt: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (dir === wt && name === '.git') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(wt, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(wt);
  out['<HEAD>'] = rev(wt);
  out['<index>'] = createHash('sha256').update(readFileSync(path.join(wt, '.git', 'index'))).digest('hex');
  out['<refs>'] = git(wt, 'for-each-ref', '--format=%(refname) %(objectname)');
  return out;
}

/**
 * Agent `agent` commits `files` in `wt`, lands it (land ref + queue), and the
 * lander squash-merges it onto trunk as it does (merge onto the landed base,
 * the trailers), pushes trunk and reports the landing landed.
 */
async function landForReal(wt: string, agent: string, files: Record<string, string>, message = 'change'): Promise<{ id: string; head: string; trunk: string }> {
  const head = commit(wt, files, message);
  const out = await landWork({ cfg: cfgFor(agent, wt), client: clientFor(agent), feed: null }, {});
  expect(out.error, out.text).toBe(false);
  const id = out.landing!.id;
  const { trunk, base, t0 } = await squashOntoTrunk(head, id, agent);
  await lander.landIt(id, { base, trunkBase: t0, candidate: trunk, files: Object.keys(files) });
  return { id, head, trunk };
}

async function squashOntoTrunk(head: string, id: string, agent: string): Promise<{ trunk: string; base: string; t0: string }> {
  git(landerWt, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main', `+refs/agenthub/land/${head}:refs/agenthub/land/${head}`);
  const t0 = rev(landerWt, 'refs/remotes/origin/main');
  const base = (await gitops.landedBase(gitops.open(landerWt, { isolated: true }), t0, head)).base;
  const tree = git(landerWt, 'merge-tree', '--write-tree', `--merge-base=${base}`, t0, head).split('\n')[0].trim();
  const message = `${id}\n\nAgenthub-Landing: ${PROJECT}/${id}\nAgenthub-Hub: ${lander.lease!.epoch}\nAgenthub-Source: ${head}\nAgenthub-Agent: ${agent}\n`;
  const trunk = execFileSync('git', ['commit-tree', tree, '-p', t0, '-F', '-'], { cwd: landerWt, env: testEnv(), input: message, encoding: 'utf8' }).trim();
  git(landerWt, 'push', '-q', 'origin', `${trunk}:refs/heads/main`);
  return { trunk, base, t0 };
}

/** A commit pushed to trunk outside the queue (no trailers), from the lander's clone. */
function foreignPush(files: Record<string, string>): string {
  git(landerWt, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  git(landerWt, 'checkout', '-q', '-B', 'main', 'refs/remotes/origin/main');
  const c = commit(landerWt, files, 'pushed outside the queue');
  git(landerWt, 'push', '-q', 'origin', 'main');
  return c;
}

const AUTH_V1 = 'export function login(user: string) {\n  return `session-${user}`;\n}\n';
const AUTH_TRIM = 'export function login(user: string) {\n  return `session-${user.trim()}`;\n}\n';
const AUTH_SESS = 'export function login(user: string) {\n  return `sess-${user}`;\n}\n';

describe('sync: clean worktrees', () => {
  it("fast-forwards a clean worktree with nothing of its own to trunk, and resets a fully landed branch to trunk", async () => {
    const before = rev(repo.b);
    const a = await landForReal(repo.a, A, { 'src/users.ts': 'export const users = ["maya", "sam", "lee"];\n' });
    expect(remoteMain()).toBe(a.trunk);

    // B: nothing of its own on the branch → a fast-forward to trunk.
    const b = await sync(B, repo.b);
    expect(b).toEqual({
      kind: 'synced',
      trunk: 'main',
      remote: 'origin',
      tip: a.trunk,
      from: before,
      to: a.trunk,
      replayed: 0,
      landings: ['L-1'],
      commits: 1,
      files: ['src/users.ts'],
      backup_ref: expect.stringMatching(/^refs\/agenthub\/backup\/agent-b\/\d{13}$/),
      undo: expect.stringMatching(/^git reset --keep refs\/agenthub\/backup\/agent-b\/\d{13}$/),
    });
    expect(rev(repo.b)).toBe(a.trunk);
    expect(git(repo.b, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('agent-b');
    expect(backupRefs(repo.b)).toEqual({ [(b as { backup_ref: string }).backup_ref]: before });
    expect(syncToolText(b)).toBe(
      `Synced your workspace to main ${a.trunk.slice(0, 7)} (L-1 landed: src/users.ts changed). Re-read those files before editing them. Undo: ${(b as { undo: string }).undo}.`,
    );

    // A: its one commit landed as the squash commit on trunk → the branch is reset to trunk, nothing replayed.
    const aSync = await sync(A, repo.a);
    expect(aSync).toMatchObject({ kind: 'synced', from: a.head, to: a.trunk, replayed: 0, landings: ['L-1'] });
    expect(rev(repo.a)).toBe(a.trunk);
    expect(Object.values(backupRefs(repo.a))).toEqual([a.head]);
    // Nothing is left behind: no lock, no record.
    const p = syncPaths(repo.a)!;
    expect(existsSync(p.lock)).toBe(false);
    expect(existsSync(p.record)).toBe(false);
    expect(await sync(A, repo.a)).toEqual({ kind: 'up_to_date', trunk: 'main', remote: 'origin', tip: a.trunk });
  });

  it('replays unlanded commits onto trunk in the object database, keeping their message, author and date', async () => {
    git(repo.b, 'config', 'user.name', 'Sam');
    const y = commit(repo.b, { 'src/routes.ts': 'export const routes = ["/login"];\n' }, 'add routes');
    const yAuthor = git(repo.b, 'log', '-1', '--format=%an <%ae> %ad', y).trim();
    const a = await landForReal(repo.a, A, { 'src/users.ts': 'export const users = ["maya"];\n' });

    const r = await sync(B, repo.b);
    expect(r).toMatchObject({ kind: 'synced', from: y, tip: a.trunk, replayed: 1, landings: ['L-1'], files: ['src/users.ts'] });
    const head = rev(repo.b);
    expect(head).not.toBe(y);
    expect(rev(repo.b, 'HEAD^')).toBe(a.trunk);
    expect(git(repo.b, 'log', '-1', '--format=%s', head).trim()).toBe('add routes');
    expect(git(repo.b, 'log', '-1', '--format=%an <%ae> %ad', head).trim()).toBe(yAuthor);
    expect(readFileSync(path.join(repo.b, 'src', 'users.ts'), 'utf8')).toBe('export const users = ["maya"];\n');
    expect(readFileSync(path.join(repo.b, 'src', 'routes.ts'), 'utf8')).toBe('export const routes = ["/login"];\n');
    expect(git(repo.b, 'status', '--porcelain').trim()).toBe('');
    expect(syncPromptText(r)).toBe(
      `agenthub synced your workspace to main ${a.trunk.slice(0, 7)} (L-1 landed: src/users.ts changed); replayed your 1 unlanded commit on top. Re-read those files before editing them. Undo: ${(r as { undo: string }).undo}.`,
    );

    // After B's own commit lands, the next sync finds it on trunk and moves the branch to trunk.
    const out = await landWork({ cfg: cfgFor(B, repo.b), client: clientFor(B), feed: null }, {});
    expect(out.error, out.text).toBe(false);
    const { trunk, base, t0 } = await squashOntoTrunk(head, out.landing!.id, B);
    await lander.landIt(out.landing!.id, { base, trunkBase: t0, candidate: trunk, files: ['src/routes.ts'] });
    expect(await sync(B, repo.b)).toMatchObject({ kind: 'synced', from: head, to: trunk, replayed: 0, landings: ['L-2'] });
    expect(rev(repo.b)).toBe(trunk);
  });

  it('leaves HEAD, the index and every file byte-identical when a replay conflicts, and says how to go on', async () => {
    const y = commit(repo.b, { 'src/auth.ts': AUTH_TRIM }, 'trim user names');
    const a = await landForReal(repo.a, A, { 'src/auth.ts': AUTH_SESS });
    const before = snapshot(repo.b);

    const r = await sync(B, repo.b);
    expect(r).toEqual({ kind: 'conflict', trunk: 'main', remote: 'origin', tip: a.trunk, commit: y, files: ['src/auth.ts'], behind: 1, landings: ['L-1'] });
    // The fetch updated refs/remotes/origin/main, which is all it may change.
    expect({ ...snapshot(repo.b), '<refs>': '' }).toEqual({ ...before, '<refs>': '' });
    expect(rev(repo.b, 'refs/remotes/origin/main')).toBe(a.trunk);
    expect(backupRefs(repo.b)).toEqual({});
    expect(existsSync(syncPaths(repo.b)!.record)).toBe(false);
    expect(syncPromptText(r)).toBe(
      `agenthub: replaying your commit ${y.slice(0, 7)} onto main ${a.trunk.slice(0, 7)} conflicts in src/auth.ts; your workspace is unchanged. ` +
        'Land anyway (the lander\'s merge ladder may resolve it) or call hub_sync {"mode": "merge"} to resolve it now.',
    );
  });
});

describe('sync: a dirty worktree is never touched', () => {
  it('answers behind_dirty with the conflict forecast, and every file, the index and HEAD stay as they were', async () => {
    const a = await landForReal(repo.a, A, { 'src/auth.ts': AUTH_SESS, 'src/users.ts': 'export const users = [];\n' });
    // A change that would merge cleanly (and an untracked file, which doesn't count).
    writeFileSync(path.join(repo.b, 'migrations', '0001_init.sql'), 'create table users (id int, name text);\n');
    writeFileSync(path.join(repo.b, 'src', 'scratch.ts'), 'untracked\n');
    let before = snapshot(repo.b);
    const clean = await sync(B, repo.b);
    expect(clean).toEqual({ kind: 'behind_dirty', trunk: 'main', remote: 'origin', tip: a.trunk, behind: 1, landings: ['L-1'], conflicts: [], uncommitted: ['M migrations/0001_init.sql'] });
    expect({ ...snapshot(repo.b), '<refs>': '' }).toEqual({ ...before, '<refs>': '' });
    expect(git(repo.b, 'stash', 'list').trim()).toBe('');
    expect(syncPromptText(clean)).toBe(
      "agenthub: main moved (L-1). Your workspace wasn't updated because you have uncommitted changes (M migrations/0001_init.sql); merging them would not conflict. " +
        'It updates at a later prompt once you commit, or call hub_sync after committing.',
    );
    expect(syncDigestLine(clean)).toBe("Trunk: your worktree is 1 landing behind main and has uncommitted changes, so it wasn't touched; merging would not conflict.");

    // One that would conflict, staged and unstaged.
    writeFileSync(path.join(repo.b, 'src', 'auth.ts'), AUTH_TRIM);
    git(repo.b, 'add', 'src/auth.ts');
    writeFileSync(path.join(repo.b, 'src', 'users.ts'), 'export const users = ["x"];\n');
    before = snapshot(repo.b);
    const conflicting = await sync(B, repo.b);
    expect(conflicting).toMatchObject({ kind: 'behind_dirty', behind: 1, conflicts: ['src/auth.ts', 'src/users.ts'] });
    expect({ ...snapshot(repo.b), '<refs>': '' }).toEqual({ ...before, '<refs>': '' });
    expect(git(repo.b, 'stash', 'list').trim()).toBe('');
    expect(syncDigestLine(conflicting)).toBe(
      "Trunk: your worktree is 1 landing behind main and has uncommitted changes, so it wasn't touched; merging would conflict in src/auth.ts and src/users.ts.",
    );
  });

  it('is up to date when trunk has nothing new, uncommitted changes or not', async () => {
    writeFileSync(path.join(repo.b, 'check.mjs'), 'process.exit(1);\n');
    expect(await sync(B, repo.b)).toEqual({ kind: 'up_to_date', trunk: 'main', remote: 'origin', tip: remoteMain() });
  });
});

describe('sync: every reason it changes nothing', () => {
  it('no_queue: a project without a land section has no trunk to sync to', async () => {
    const plain = makeLandingRepo({ project: PROJECT });
    cleanups.push(() => plain.cleanup());
    expect(await sync(B, plain.b)).toEqual({ kind: 'skipped', reason: 'no_queue', detail: null, trunk: null });
  });

  it('sync_running: another sync holds the lock; a stale lock (its process gone) is taken over', async () => {
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    const p = syncPaths(repo.b)!;
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(await sync(B, repo.b)).toEqual({ kind: 'skipped', reason: 'sync_running', detail: null, trunk: 'main' });
    expect(readFileSync(p.lock, 'utf8')).toContain(String(process.pid)); // not ours to take
    // Its process is gone (a pid that can't run): stale.
    writeFileSync(p.lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect((await sync(B, repo.b)).kind).toBe('synced');
    expect(existsSync(p.lock)).toBe(false);
  });

  it('edit_in_flight: an edit marker younger than 30 minutes; an older one is stale and removed', async () => {
    const a = await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    const p = syncPaths(repo.b)!;
    const marker = writeMarker(p, { session: 's1', thread: 'main', tool: 'toolu_1' })!;
    const before = rev(repo.b);
    expect(await sync(B, repo.b)).toEqual({ kind: 'skipped', reason: 'edit_in_flight', detail: '1', trunk: 'main' });
    expect(rev(repo.b)).toBe(before);
    const old = (Date.now() - 31 * 60_000) / 1000;
    utimesSync(marker, old, old);
    expect(await sync(B, repo.b)).toMatchObject({ kind: 'synced', to: a.trunk });
    expect(existsSync(marker)).toBe(false);
  });

  it('fetch_failed: trunk could not be fetched', async () => {
    git(repo.b, 'remote', 'set-url', 'origin', path.join(repo.dir, 'nowhere.git'));
    const r = await sync(B, repo.b);
    expect(r).toMatchObject({ kind: 'skipped', reason: 'fetch_failed', trunk: 'main' });
    expect((r as { detail: string }).detail).toMatch(/nowhere\.git|does not appear to be a git repository/);
    expect(syncToolText(r)).toMatch(/^Fetching main failed \(.+\), so nothing was changed\.$/);
  });

  it('git_operation: a merge, rebase or cherry-pick in progress', async () => {
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    git(repo.b, 'checkout', '-q', '-b', 'side');
    commit(repo.b, { 'README.md': 'side\n' });
    git(repo.b, 'checkout', '-q', 'agent-b');
    commit(repo.b, { 'README.md': 'mine\n' });
    expect(() => git(repo.b, 'merge', '-q', 'side')).toThrow();
    expect(await sync(B, repo.b)).toEqual({ kind: 'skipped', reason: 'git_operation', detail: 'merge', trunk: 'main' });
    git(repo.b, 'merge', '--abort');
  });

  it('detached_head: no branch to move', async () => {
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    git(repo.b, 'checkout', '-q', '--detach');
    expect(await sync(B, repo.b)).toEqual({ kind: 'skipped', reason: 'detached_head', detail: null, trunk: 'main' });
  });

  it('landing_in_flight: an own landing in the queue whose commit HEAD contains', async () => {
    commit(repo.b, { 'src/routes.ts': 'export {};\n' });
    const out = await landWork({ cfg: cfgFor(B, repo.b), client: clientFor(B), feed: null }, {});
    expect(out.error, out.text).toBe(false);
    foreignPush({ 'docs/x.md': 'x\n' });
    const before = snapshot(repo.b);
    const r = await sync(B, repo.b);
    expect(r).toEqual({ kind: 'skipped', reason: 'landing_in_flight', detail: 'L-1', trunk: 'main' });
    expect({ ...snapshot(repo.b), '<refs>': '' }).toEqual({ ...before, '<refs>': '' });
    expect(syncToolText(r)).toBe(
      'Your landing L-1 has commits of this branch and is still in the queue; replaying them now would duplicate them under new shas. ' +
        'The workspace syncs once it lands or comes back (hub_wait {"landing_id": "L-1"}). Nothing was changed.',
    );
  });

  it('hub_unavailable: without the hub only a fast-forward goes ahead', async () => {
    const down = await downUrl();
    commit(repo.b, { 'src/routes.ts': 'export {};\n' });
    foreignPush({ 'docs/x.md': 'x\n' });
    const r = await sync(B, repo.b, { url: down });
    expect(r).toMatchObject({ kind: 'skipped', reason: 'hub_unavailable', trunk: 'main' });
    expect((r as { detail: string }).detail).toMatch(/unreachable/);
    // A's worktree has nothing of its own: the fast-forward needs no hub.
    expect(await sync(A, repo.a, { url: down })).toMatchObject({ kind: 'synced', replayed: 0, landings: [], commits: 1, files: ['docs/x.md'] });
  });

  it('lander_paused: replays wait while landing is paused (trunk rewritten); fast-forwards still go ahead', async () => {
    commit(repo.b, { 'src/routes.ts': 'export {};\n' });
    foreignPush({ 'docs/x.md': 'x\n' });
    await lander.call('POST', '/lander/pause', { lease: lander.lease, reason: 'trunk_rewritten', detail: 'trunk was rewound' });
    expect(await sync(B, repo.b)).toEqual({ kind: 'skipped', reason: 'lander_paused', detail: 'trunk_rewritten', trunk: 'main' });
    expect((await sync(A, repo.a)).kind).toBe('synced');
  });

  it('merges_in_branch: unlanded merge commits are not replayed; merge mode is the way', async () => {
    git(repo.b, 'checkout', '-q', '-b', 'side');
    commit(repo.b, { 'docs/side.md': 'side\n' });
    git(repo.b, 'checkout', '-q', 'agent-b');
    commit(repo.b, { 'docs/mine.md': 'mine\n' });
    git(repo.b, 'merge', '-q', '--no-edit', 'side');
    foreignPush({ 'docs/x.md': 'x\n' });
    const r = await sync(B, repo.b);
    expect(r).toMatchObject({ kind: 'skipped', reason: 'merges_in_branch', trunk: 'main' });
    expect(syncToolText(r)).toBe(
      'Your branch has unlanded merge commits, which sync does not replay; call hub_sync {"mode": "merge"} to merge main into your branch instead. Nothing was changed.',
    );
  });

  it('changed_meanwhile: an untracked file where the target has one is never overwritten, and it stays as it was', async () => {
    const a = await landForReal(repo.a, A, { 'src/new.ts': 'export const fromTrunk = 1;\n' });
    writeFileSync(path.join(repo.b, 'src', 'new.ts'), 'my untracked work\n');
    const before = snapshot(repo.b);
    const r = await sync(B, repo.b);
    expect(r).toEqual({ kind: 'skipped', reason: 'changed_meanwhile', detail: 'untracked or ignored files in the way: src/new.ts', paths: ['src/new.ts'], trunk: 'main' });
    expect({ ...snapshot(repo.b), '<refs>': '' }).toEqual({ ...before, '<refs>': '' });
    expect(readFileSync(path.join(repo.b, 'src', 'new.ts'), 'utf8')).toBe('my untracked work\n');
    expect(backupRefs(repo.b)).toEqual({}); // the backup of a move that didn't happen goes again
    expect(existsSync(syncPaths(repo.b)!.record)).toBe(false);
    expect(rev(repo.b, 'refs/remotes/origin/main')).toBe(a.trunk);
    expect(syncToolText(r)).toBe(
      "src/new.ts is untracked or ignored in your worktree, and main now has files there; sync never overwrites or removes such files, so nothing was changed. Move it aside (or delete it if you don't need it), then call hub_sync again.",
    );
    expect(syncPromptText(r)).toBe(
      "agenthub: your workspace wasn't synced to main: src/new.ts is untracked or ignored in your worktree, and main now has files there; sync never overwrites or removes such files. Move it aside (or delete it if you don't need it); it syncs at a later prompt, or call hub_sync.",
    );
  });

  it('timeout: a spent budget stops it before anything changes', async () => {
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    const before = rev(repo.b);
    expect(await sync(B, repo.b, { budgetMs: 0 })).toEqual({ kind: 'skipped', reason: 'timeout', detail: null, trunk: 'main' });
    expect(rev(repo.b)).toBe(before);
  });

  it('sync_running: a lock still being written (unreadable) counts as held until 120 s after it was written', async () => {
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    const p = syncPaths(repo.b)!;
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.lock, ''); // created (O_EXCL) by another sync that hasn't written its pid yet
    expect(await sync(B, repo.b)).toEqual({ kind: 'skipped', reason: 'sync_running', detail: null, trunk: 'main' });
    expect(readFileSync(p.lock, 'utf8')).toBe('');
    const old = (Date.now() - 121_000) / 1000;
    utimesSync(p.lock, old, old);
    expect((await sync(B, repo.b)).kind).toBe('synced');
    expect(readdirSync(p.dir).filter((n) => n.startsWith('sync.lock'))).toEqual([]);
  });

  it("sync_running: recovery waits for the lock, so a running sync's write-ahead record is never cleared under it", async () => {
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    const p = syncPaths(repo.b)!;
    mkdirSync(p.dir, { recursive: true });
    // A live sync holds the lock; the record on disk (a dead pid, HEAD its old tip) is one recovery would clear.
    writeFileSync(p.lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const record = { pid: 2 ** 22 + 12345, orig_head: rev(repo.b), target: rev(repo.b), branch: 'agent-b', backup_ref: 'refs/agenthub/backup/agent-b/1', at: Date.now() };
    writeFileSync(p.record, JSON.stringify(record));
    expect(await sync(B, repo.b)).toEqual({ kind: 'skipped', reason: 'sync_running', detail: null, trunk: 'main' });
    expect(JSON.parse(readFileSync(p.record, 'utf8'))).toEqual(record);
    rmSync(p.lock);
    expect(await sync(B, repo.b)).toMatchObject({ kind: 'synced', recovered: 'unapplied' });
    expect(existsSync(p.record)).toBe(false);
  });
});

describe('sync: untracked and ignored files are never overwritten or removed', () => {
  // git reset --keep (like checkout and merge) refuses to overwrite an untracked file, but treats an ignored one, and an
  // ignored directory where the target has a file, as expendable. Sync checks for both first and refuses (design §2.3.5, §4.3).
  const exclude = (wt: string, ...patterns: string[]) => writeFileSync(path.join(wt, '.git', 'info', 'exclude'), patterns.map((p) => `${p}\n`).join(''));

  it('an ignored file at a path trunk starts tracking stays as it was (changed_meanwhile)', async () => {
    exclude(repo.b, '.env');
    writeFileSync(path.join(repo.b, '.env'), 'MY_SECRET=hunter2\n');
    foreignPush({ '.env': 'DEFAULTS=1\n' });
    const before = snapshot(repo.b);
    const r = await sync(B, repo.b);
    expect(r).toEqual({ kind: 'skipped', reason: 'changed_meanwhile', detail: 'untracked or ignored files in the way: .env', paths: ['.env'], trunk: 'main' });
    expect({ ...snapshot(repo.b), '<refs>': '' }).toEqual({ ...before, '<refs>': '' });
    expect(readFileSync(path.join(repo.b, '.env'), 'utf8')).toBe('MY_SECRET=hunter2\n');
    expect(backupRefs(repo.b)).toEqual({});
    expect(existsSync(syncPaths(repo.b)!.record)).toBe(false);
  });

  it('a file a committed .gitignore ignored, which trunk now tracks, stays as it was', async () => {
    foreignPush({ '.gitignore': 'config/local.json\n' });
    expect((await sync(B, repo.b)).kind).toBe('synced');
    mkdirSync(path.join(repo.b, 'config'), { recursive: true });
    writeFileSync(path.join(repo.b, 'config', 'local.json'), '{"mine": true}\n');
    expect(git(repo.b, 'status', '--porcelain').trim()).toBe('');
    foreignPush({ '.gitignore': '\n', 'config/local.json': '{"team": true}\n' });
    const r = await sync(B, repo.b);
    expect(r).toMatchObject({ kind: 'skipped', reason: 'changed_meanwhile', paths: ['config/local.json'] });
    expect(readFileSync(path.join(repo.b, 'config', 'local.json'), 'utf8')).toBe('{"mine": true}\n');
    expect(readFileSync(path.join(repo.b, '.gitignore'), 'utf8')).toBe('config/local.json\n');
  });

  it('an ignored directory where trunk has a file, and an ignored file where trunk has a directory', async () => {
    exclude(repo.b, 'cache/', 'vendor');
    mkdirSync(path.join(repo.b, 'cache'));
    writeFileSync(path.join(repo.b, 'cache', 'one'), '1\n');
    writeFileSync(path.join(repo.b, 'cache', 'two'), '2\n');
    writeFileSync(path.join(repo.b, 'vendor'), 'my notes\n');
    foreignPush({ cache: 'a file now\n', 'vendor/lib.js': 'export {};\n' });
    const before = snapshot(repo.b);
    const r = await sync(B, repo.b);
    expect(r).toMatchObject({ kind: 'skipped', reason: 'changed_meanwhile', paths: ['cache/', 'vendor'] });
    expect({ ...snapshot(repo.b), '<refs>': '' }).toEqual({ ...before, '<refs>': '' });
    expect(syncToolText(r)).toMatch(/^cache\/ and vendor are untracked or ignored in your worktree, and main now has files there; .* Move them aside \(or delete them if you don't need them\), then call hub_sync again\.$/);
  });

  it('ignored files trunk has no file at stay, and a new file inside an ignored directory is no collision', async () => {
    exclude(repo.b, 'build/', '.env.local');
    mkdirSync(path.join(repo.b, 'build'));
    writeFileSync(path.join(repo.b, 'build', 'a.js'), 'built\n');
    writeFileSync(path.join(repo.b, '.env.local'), 'LOCAL=1\n');
    const f = foreignPush({ 'build/b.js': 'checked in\n', 'docs/x.md': 'x\n' });
    expect(await sync(B, repo.b)).toMatchObject({ kind: 'synced', to: f, files: ['build/b.js', 'docs/x.md'] });
    expect(readFileSync(path.join(repo.b, 'build', 'a.js'), 'utf8')).toBe('built\n');
    expect(readFileSync(path.join(repo.b, 'build', 'b.js'), 'utf8')).toBe('checked in\n');
    expect(readFileSync(path.join(repo.b, '.env.local'), 'utf8')).toBe('LOCAL=1\n');
  });

  it('a tracked file trunk replaces with a directory, and a tracked directory it replaces with a file, still sync', async () => {
    foreignPush({ 'lib/util.ts': 'export {};\n', notes: 'a file\n' });
    expect((await sync(B, repo.b)).kind).toBe('synced');
    git(landerWt, 'rm', '-q', '-r', 'lib', 'notes');
    git(landerWt, 'commit', '-q', '-m', 'swap');
    const f = commit(landerWt, { lib: 'now a file\n', 'notes/today.md': 'now a directory\n' }, 'swap');
    git(landerWt, 'push', '-q', 'origin', 'main');
    expect(await sync(B, repo.b)).toMatchObject({ kind: 'synced', to: f });
    expect(readFileSync(path.join(repo.b, 'lib'), 'utf8')).toBe('now a file\n');
  });

  it('merge mode refuses (merge_refused) rather than overwrite an ignored file, in a fast-forward and in a merge', async () => {
    exclude(repo.b, '.env', 'cache/');
    writeFileSync(path.join(repo.b, '.env'), 'MY_SECRET=hunter2\n');
    mkdirSync(path.join(repo.b, 'cache'));
    writeFileSync(path.join(repo.b, 'cache', 'one'), '1\n');
    foreignPush({ '.env': 'DEFAULTS=1\n', cache: 'a file now\n' });
    // A fast-forward (git merge --no-overwrite-ignore refuses this one itself) …
    const ff = await sync(B, repo.b, { mode: 'merge' });
    expect(ff).toEqual({ kind: 'skipped', reason: 'merge_refused', detail: 'untracked or ignored files in the way: .env, cache/', paths: ['.env', 'cache/'], trunk: 'main' });
    // … and a real merge (where git 2.43's ort merge overwrites ignored files whatever the flag says).
    const head = commit(repo.b, { 'src/routes.ts': 'export {};\n' });
    const before = snapshot(repo.b);
    const r = await sync(B, repo.b, { mode: 'merge' });
    expect(r).toMatchObject({ kind: 'skipped', reason: 'merge_refused', paths: ['.env', 'cache/'] });
    expect({ ...snapshot(repo.b), '<refs>': '' }).toEqual({ ...before, '<refs>': '' });
    expect(readFileSync(path.join(repo.b, '.env'), 'utf8')).toBe('MY_SECRET=hunter2\n');
    expect(rev(repo.b)).toBe(head);
    expect(git(repo.b, 'status', '--porcelain').trim()).toBe('');
    expect(syncToolText(r)).toBe(
      ".env and cache/ are untracked or ignored in your worktree, and main now has files there; sync never overwrites or removes such files, so nothing was changed. " +
        "Move them aside (or delete them if you don't need them), then call hub_sync {\"mode\": \"merge\"} again.",
    );
  });
});

describe('sync: git older than 2.40 (no merge-tree --merge-base) fast-forwards only, and says so', () => {
  /** A PATH directory whose git is the real one, except that it is "2.39.2": merge-tree has no --merge-base. */
  function oldGitPath(): string {
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const dir = path.join(repo.dir, 'old-git');
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 'git'),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in --merge-base*) echo "error: unknown option \\\`merge-base'" >&2; exit 129;; esac; done\n` +
        `if [ "$1" = version ] || [ "$1" = --version ]; then echo "git version 2.39.2"; exit 0; fi\nexec "${real}" "$@"\n`,
      { mode: 0o755 },
    );
    return `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
  }

  it('fast-forwards, refuses a replay with a notice once, and reports behind_dirty without a forecast', async () => {
    const PATH = oldGitPath();
    const y = commit(repo.b, { 'src/routes.ts': 'export {};\n' });
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    const before = snapshot(repo.b);

    const r = await hubCli(['sync'], { cwd: repo.b, env: envFor(B, { PATH }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      'Your git (2.39.2) is too old to replay your unlanded commits onto main (sync needs git 2.40 or newer for that), so it only fast-forwards. ' +
        'Nothing was changed. Update git, or call hub_sync {"mode": "merge"} to merge main into your branch.\n',
    );
    expect({ ...snapshot(repo.b), '<refs>': '' }).toEqual({ ...before, '<refs>': '' });
    expect(rev(repo.b)).toBe(y);

    const settle = () => hubCli(['hook', 'settle'], { cwd: repo.b, env: envFor(B, { PATH }), input: sessionEventInput(repo.b, 'UserPromptSubmit', 'sess-g') });
    expect(JSON.parse((await settle()).stdout).hookSpecificOutput.additionalContext).toBe(
      'agenthub: main moved, and your workspace wasn\'t updated: your git (2.39.2) is too old to replay your unlanded commits onto main (sync needs git 2.40 or newer for that), so it only fast-forwards. ' +
        'Update git, or call hub_sync {"mode": "merge"} to merge main into your branch.',
    );
    expect((await settle()).stdout).toBe(''); // said once

    writeFileSync(path.join(repo.b, 'src', 'auth.ts'), AUTH_TRIM);
    const dirty = await hubCli(['sync'], { cwd: repo.b, env: envFor(B, { PATH }) });
    expect(dirty.code).toBe(0);
    expect(dirty.stdout).toBe(
      "main moved (L-1). Your workspace wasn't updated because you have uncommitted changes (M src/auth.ts); " +
        'merging them may conflict (your git is too old to forecast it: that needs git 2.40 or newer). It updates at a later prompt once you commit, or call hub_sync after committing.\n',
    );

    // A worktree with nothing of its own fast-forwards as with any git.
    const ff = await hubCli(['sync'], { cwd: repo.a, env: envFor(A, { PATH }) });
    expect(ff.code, ff.stdout).toBe(0);
    expect(rev(repo.a)).toBe(remoteMain());
  });
});

describe('sync: merge mode', () => {
  it('merges trunk into the branch, stops at conflicts with markers left for the agent, and refuses a dirty tree', async () => {
    commit(repo.b, { 'src/auth.ts': AUTH_TRIM }, 'trim user names');
    const a = await landForReal(repo.a, A, { 'src/auth.ts': AUTH_SESS });
    writeFileSync(path.join(repo.b, 'check.mjs'), 'process.exit(1);\n');
    expect(await sync(B, repo.b, { mode: 'merge' })).toEqual({ kind: 'skipped', reason: 'dirty', detail: 'M check.mjs', trunk: 'main' });
    git(repo.b, 'checkout', '-q', '--', 'check.mjs');

    const r = await sync(B, repo.b, { mode: 'merge' });
    expect(r).toEqual({ kind: 'merge_conflict', trunk: 'main', remote: 'origin', tip: a.trunk, files: ['src/auth.ts'], behind: 1, landings: ['L-1'] });
    expect(readFileSync(path.join(repo.b, 'src', 'auth.ts'), 'utf8')).toMatch(/<<<<<<<[\s\S]*=======[\s\S]*>>>>>>>/);
    expect(syncToolText(r)).toBe(
      `Merging main ${a.trunk.slice(0, 7)} into your branch stopped at conflicts in src/auth.ts; they hold conflict markers now. ` +
        'Resolve them keeping both intents, `git add` them and `git commit`, then call land again. To back out instead: git merge --abort.',
    );
    git(repo.b, 'merge', '--abort');
  });

  it('makes a merge commit when trunk merges cleanly, and refuses (merge_refused) what git merge refuses', async () => {
    const before = commit(repo.b, { 'src/routes.ts': 'export {};\n' });
    const a = await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    writeFileSync(path.join(repo.b, 'src', 'users.ts.bak'), '');
    const r = await sync(B, repo.b, { mode: 'merge' });
    expect(r).toMatchObject({ kind: 'merged', from: before, files: ['src/users.ts'], landings: ['L-1'] });
    expect(git(repo.b, 'rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').slice(1)).toEqual([before, a.trunk]);

    const f = foreignPush({ 'docs/new.md': 'from trunk\n' });
    mkdirSync(path.join(repo.b, 'docs'), { recursive: true });
    writeFileSync(path.join(repo.b, 'docs', 'new.md'), 'untracked here\n');
    const refused = await sync(B, repo.b, { mode: 'merge' });
    expect(refused).toMatchObject({ kind: 'skipped', reason: 'merge_refused', trunk: 'main' });
    expect(readFileSync(path.join(repo.b, 'docs', 'new.md'), 'utf8')).toBe('untracked here\n');
    expect(rev(repo.b, 'refs/remotes/origin/main')).toBe(f);
  });
});

describe('sync: crash recovery (a real process killed between the write-ahead and reset --keep)', () => {
  const hubSync = (args: string[] = [], extra: Record<string, string | undefined> = {}) => hubCli(['sync', ...args], { cwd: repo.b, env: envFor(B, extra) });
  const crashEnv = (point: string) => ({ NODE_ENV: 'test', AGENTHUB_SYNC_FAULT: point });
  const preEdit = (session = 'sess-1', tool = 'toolu_1') =>
    hubCli(['hook', 'pre-edit'], { cwd: repo.b, env: envFor(B), input: preToolUseInput(repo.b, path.join(repo.b, 'src', 'users.ts'), 'Edit', { session, toolUseId: tool }) });

  it('keeps the record and the backup ref, blocks edits until hub_sync recovers, then syncs', async () => {
    const before = rev(repo.b);
    const a = await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });

    const crashed = await hubSync([], crashEnv('after-write-ahead'));
    expect(crashed.code).toBe(null); // SIGKILL
    const p = syncPaths(repo.b)!;
    const record = JSON.parse(readFileSync(p.record, 'utf8'));
    expect(record).toMatchObject({ orig_head: before, target: a.trunk, branch: 'agent-b', backup_ref: expect.stringMatching(/^refs\/agenthub\/backup\/agent-b\//) });
    expect(backupRefs(repo.b)).toEqual({ [record.backup_ref]: before });
    expect(rev(repo.b)).toBe(before);

    const denied = await preEdit();
    expect(JSON.parse(denied.stdout).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'A workspace sync in this checkout was interrupted; call hub_sync to finish recovering, then retry this edit.',
    });
    expect(readdirSync(p.inflight)).toEqual([]); // a denied edit leaves no marker

    const recovered = await hubSync();
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toMatch(/^An interrupted sync had changed nothing; its record is cleared\. Synced your workspace to main /);
    expect(rev(repo.b)).toBe(a.trunk);
    expect(existsSync(p.record)).toBe(false);
    expect((await preEdit('sess-1', 'toolu_2')).stdout).toBe('');
  });

  it('clears the record of a sync that died after reset --keep (HEAD is its target)', async () => {
    const a = await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    expect((await hubSync([], crashEnv('after-reset'))).code).toBe(null);
    expect(rev(repo.b)).toBe(a.trunk);
    expect(existsSync(syncPaths(repo.b)!.record)).toBe(true);
    const r = await sync(B, repo.b);
    expect(r).toEqual({ kind: 'up_to_date', trunk: 'main', remote: 'origin', tip: a.trunk, recovered: 'finished' });
  });

  it("touches nothing when HEAD moved since the crash (needs_human), until a human runs hub sync --recover", async () => {
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    expect((await hubSync([], crashEnv('after-write-ahead'))).code).toBe(null);
    const moved = commit(repo.b, { 'docs/after.md': 'committed after the crash\n' });
    const before = snapshot(repo.b);
    const r = await sync(B, repo.b);
    expect(r).toMatchObject({ kind: 'needs_human', head: moved, cleared: false });
    expect(snapshot(repo.b)).toEqual(before);
    expect(syncToolText(r)).toMatch(/^A workspace sync was interrupted, and HEAD has moved since .*Tell your human to run `hub sync --recover` here\.$/);
    expect(JSON.parse((await preEdit()).stdout).hookSpecificOutput.permissionDecision).toBe('deny');

    const cleared = await hubSync(['--recover']);
    expect(cleared.code).toBe(0);
    expect(cleared.stdout).toMatch(/^Cleared the record of an interrupted sync\. HEAD is at [0-9a-f]{7}; before the sync it was [0-9a-f]{7}, kept in refs\/agenthub\/backup\/agent-b\/\d+ \(to go back: git reset --keep refs\/agenthub\/backup\/agent-b\/\d+\)\. Edits are allowed again\./);
    expect(rev(repo.b)).toBe(moved);
    const allowed = await preEdit('sess-1', 'toolu_3');
    expect(allowed.stdout === '' ? undefined : JSON.parse(allowed.stdout).hookSpecificOutput.permissionDecision).toBeUndefined();
  });
});

describe('edit/sync mutual exclusion', () => {
  const preEdit = (tool: string, session = 'sess-x') =>
    hubCli(['hook', 'pre-edit'], { cwd: repo.b, env: envFor(B), input: preToolUseInput(repo.b, path.join(repo.b, 'src', 'users.ts'), 'Edit', { session, toolUseId: tool }) });
  const postEdit = (tool: string, session = 'sess-x') =>
    hubCli(['hook', 'post-edit'], { cwd: repo.b, env: envFor(B), input: postToolUseInput(repo.b, path.join(repo.b, 'src', 'users.ts'), 'Edit', { session, toolUseId: tool }) });

  it('edit first: an allowed edit keeps its marker until post-edit, and a sync meanwhile changes nothing', async () => {
    const a = await landForReal(repo.a, A, { 'src/auth.ts': AUTH_SESS });
    expect((await preEdit('toolu_e1')).stdout).toBe('');
    const p = syncPaths(repo.b)!;
    expect(readdirSync(p.inflight)).toEqual(['sess-x~toolu_e1']);
    expect(await sync(B, repo.b)).toMatchObject({ kind: 'skipped', reason: 'edit_in_flight' });
    expect((await postEdit('toolu_e1')).stdout).toBe('');
    expect(readdirSync(p.inflight)).toEqual([]);
    expect(await sync(B, repo.b)).toMatchObject({ kind: 'synced', to: a.trunk });
  });

  it('sync first: an edit while the lock is held waits up to 3 s, then denies with "retry"; one that frees in time goes ahead', async () => {
    const p = syncPaths(repo.b)!;
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    let started = Date.now();
    const denied = await preEdit('toolu_s1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    expect(JSON.parse(denied.stdout).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'The workspace is updating to the latest trunk; retry this edit.',
    });
    expect(readdirSync(p.inflight)).toEqual([]);

    // Released while the hook waits: it writes its marker again, checks once more, and goes ahead.
    started = Date.now();
    setTimeout(() => rmSync(p.lock, { force: true }), 1000);
    const allowed = await preEdit('toolu_s2');
    expect(allowed.stdout).toBe('');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(readdirSync(p.inflight)).toEqual(['sess-x~toolu_s2']);
  });

  it("settle clears the thread's markers of edits that never ran (rejected at the permission prompt), then syncs", async () => {
    const a = await landForReal(repo.a, A, { 'src/auth.ts': AUTH_SESS });
    expect((await preEdit('toolu_r1')).stdout).toBe('');
    // A subagent's edit of another session thread stays in flight.
    const sub = await hubCli(['hook', 'pre-edit'], {
      cwd: repo.b,
      env: envFor(B),
      input: preToolUseInput(repo.b, path.join(repo.b, 'README.md'), 'Edit', { session: 'sess-x', toolUseId: 'toolu_sub', agentId: 'agent-7' }),
    });
    expect(sub.stdout).toBe('');
    const p = syncPaths(repo.b)!;
    const settle = await hubCli(['hook', 'settle'], { cwd: repo.b, env: envFor(B), input: sessionEventInput(repo.b, 'UserPromptSubmit', 'sess-x') });
    expect(settle.stdout).toBe(''); // the subagent's edit is still in flight: no sync
    expect(readdirSync(p.inflight)).toEqual(['sess-x~toolu_sub']);
    await hubCli(['hook', 'settle'], { cwd: repo.b, env: envFor(B), input: sessionEventInput(repo.b, 'SubagentStop', 'sess-x', 'agent-7') });
    expect(readdirSync(p.inflight)).toEqual([]);
    const next = await hubCli(['hook', 'settle'], { cwd: repo.b, env: envFor(B), input: sessionEventInput(repo.b, 'UserPromptSubmit', 'sess-x') });
    expect(JSON.parse(next.stdout).hookSpecificOutput.additionalContext).toMatch(/^agenthub synced your workspace to main /);
    expect(rev(repo.b)).toBe(a.trunk);
  });
});

describe('the safe points: settle on UserPromptSubmit, the digest at SessionStart', () => {
  const settle = (event: 'UserPromptSubmit' | 'Stop' | 'SubagentStop', extra: Record<string, string | undefined> = {}) =>
    hubCli(['hook', 'settle'], { cwd: repo.b, env: envFor(B, extra), input: sessionEventInput(repo.b, event, 'sess-s') });

  it('prints additionalContext only when the sync changed something, conflicted, or found the worktree behind and dirty; never on Stop', async () => {
    expect(await settle('UserPromptSubmit')).toEqual({ code: 0, stdout: '', stderr: '' }); // up to date

    const a = await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    const before = rev(repo.b);
    expect(await settle('Stop')).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await settle('SubagentStop')).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(rev(repo.b)).toBe(before);

    const synced = await settle('UserPromptSubmit');
    const out = JSON.parse(synced.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toMatch(
      new RegExp(`^agenthub synced your workspace to main ${a.trunk.slice(0, 7)} \\(L-1 landed: src/users\\.ts changed\\)\\. Re-read those files before editing them\\. Undo: git reset --keep refs/agenthub/backup/agent-b/\\d+\\.$`),
    );
    expect(rev(repo.b)).toBe(a.trunk);
    expect((await settle('UserPromptSubmit')).stdout).toBe(''); // up to date again

    // Behind and dirty: said once for that state, not at every prompt.
    await landForReal(repo.a, A, { 'src/auth.ts': AUTH_SESS });
    writeFileSync(path.join(repo.b, 'src', 'auth.ts'), AUTH_TRIM);
    const dirty = JSON.parse((await settle('UserPromptSubmit')).stdout).hookSpecificOutput.additionalContext;
    expect(dirty).toBe(
      "agenthub: main moved (L-2). Your workspace wasn't updated because you have uncommitted changes (M src/auth.ts); merging them would conflict in src/auth.ts. " +
        'It updates at a later prompt once you commit, or call hub_sync after committing.',
    );
    expect((await settle('UserPromptSubmit')).stdout).toBe('');
  });

  it('does not sync when sync.auto is false on trunk', async () => {
    foreignPush({ 'agenthub.json': `${JSON.stringify({ ...TEAM_CONFIG, sync: { auto: false } }, null, 2)}\n` });
    git(repo.b, 'fetch', '-q', 'origin');
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    const before = rev(repo.b);
    expect((await settle('UserPromptSubmit')).stdout).toBe('');
    expect(rev(repo.b)).toBe(before);
  });

  it(`finishes well within 15 s when trunk can't be fetched (a remote that never answers)`, async () => {
    foreignPush({ 'docs/x.md': 'x\n' });
    git(repo.b, 'remote', 'set-url', 'origin', 'ssh://never.invalid/remote.git');
    const started = Date.now();
    const r = await settle('UserPromptSubmit', { GIT_SSH_COMMAND: 'sleep 60 #' });
    const took = Date.now() - started;
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(took).toBeLessThan(15_000);
    expect(took).toBeGreaterThanOrEqual(HOOK_SYNC_BUDGET_MS - 3000);
  }, 30_000);

  /** A hub that accepts connections and never answers. */
  async function silentHub(): Promise<string> {
    const h = await fakeHub((req) => req.resume());
    cleanups.push(() => h.close());
    return h.url;
  }

  it('settle stays within 15 s with pending claims to release and a hub that never answers, whatever HUB_TIMEOUT_MS says', async () => {
    const url = await silentHub();
    const f = foreignPush({ 'docs/x.md': 'x\n' });
    const store = PendingClaims.open(repo.b)!;
    for (const tool of ['toolu_p1', 'toolu_p2']) store.add({ session: 'sess-t', thread: 'main', tool, claim_id: `C-${tool}`, root: repo.b, url, project: PROJECT, created_at: 1 });
    const started = Date.now();
    const r = await hubCli(['hook', 'settle'], { cwd: repo.b, env: envFor(B, { HUB_URL: url, HUB_TIMEOUT_MS: '30000' }), input: sessionEventInput(repo.b, 'UserPromptSubmit', 'sess-t') });
    const took = Date.now() - started;
    expect(took).toBeLessThan(15_000);
    // Without the hub only a fast-forward may go ahead, and this is one.
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/^agenthub synced your workspace to main /);
    expect(rev(repo.b)).toBe(f);
    expect(store.list('sess-t')).toHaveLength(2); // kept for the next try
  }, 30_000);

  it('the digest stays within 15 s with a hub that never answers, whatever HUB_TIMEOUT_MS says', async () => {
    const url = await silentHub();
    const f = foreignPush({ 'docs/x.md': 'x\n' });
    const started = Date.now();
    const r = await hubCli(['hook', 'digest'], {
      cwd: repo.b,
      env: envFor(B, { HUB_URL: url, HUB_TIMEOUT_MS: '30000' }),
      input: JSON.stringify({ session_id: 'sess-d2', cwd: repo.b, hook_event_name: 'SessionStart', source: 'startup' }),
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(text).toMatch(/^agenthub: the team hub is unavailable \(/);
    // The sync went ahead (a fast-forward needs no hub), and the agent hears of it all the same.
    expect(text).toMatch(new RegExp(`\\nTrunk: your worktree was clean and is now at main ${f.slice(0, 7)} \\(1 commit\\)\\. Re-read docs/x\\.md before editing it\\. `));
    expect(rev(repo.b)).toBe(f);
  }, 30_000);

  it("settle clears the thread's edit markers in other checkouts too (an edit in another worktree rejected at the permission prompt)", async () => {
    const other = path.join(repo.dir, 'wt-b2');
    git(repo.b, 'worktree', 'add', '-q', other, '-b', 'agent-b2');
    const env = envFor(B, { CLAUDE_PROJECT_DIR: repo.b });
    const preEdit = (tool: string, agentId?: string) =>
      hubCli(['hook', 'pre-edit'], { cwd: repo.b, env, input: preToolUseInput(repo.b, path.join(other, 'src', 'users.ts'), 'Edit', { session: 'sess-o', toolUseId: tool, agentId }) });
    expect((await preEdit('toolu_o1')).stdout).toBe('');
    expect((await preEdit('toolu_o2', 'agent-9')).stdout).toBe('');
    const p = syncPaths(other)!;
    expect(readdirSync(p.inflight).sort()).toEqual(['sess-o~toolu_o1', 'sess-o~toolu_o2']);
    // No post-edit for either: the main thread's turn ends, then the subagent's, then the session.
    await hubCli(['hook', 'settle'], { cwd: repo.b, env, input: sessionEventInput(repo.b, 'UserPromptSubmit', 'sess-o') });
    expect(readdirSync(p.inflight)).toEqual(['sess-o~toolu_o2']);
    await hubCli(['hook', 'settle'], { cwd: repo.b, env, input: sessionEventInput(repo.b, 'SubagentStop', 'sess-o', 'agent-9') });
    expect(readdirSync(p.inflight)).toEqual([]);
    await hubCli(['hook', 'settle'], { cwd: repo.b, env, input: sessionEventInput(repo.b, 'SessionEnd', 'sess-o') });
    expect(readdirSync(syncPaths(repo.b)!.elsewhere)).toEqual([]);
  });

  it('the digest syncs first and says where the worktree is now', async () => {
    const a = await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    const r = await hubCli(['hook', 'digest'], {
      cwd: repo.b,
      env: envFor(B),
      input: JSON.stringify({ session_id: 'sess-d', cwd: repo.b, hook_event_name: 'SessionStart', source: 'startup' }),
    });
    const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(rev(repo.b)).toBe(a.trunk);
    expect(text).toMatch(
      new RegExp(`\\nTrunk: your worktree was clean and is now at main ${a.trunk.slice(0, 7)} \\(1 landing\\)\\. Re-read src/users\\.ts before editing it\\. Undo: git reset --keep refs/agenthub/backup/agent-b/\\d+\\.\\n`),
    );
  });
});

describe('the stale-base heads-up in pre-edit', () => {
  it("says once per file and trunk tip that trunk changed the file since the worktree's base", async () => {
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    git(repo.b, 'fetch', '-q', 'origin');
    writeFileSync(path.join(repo.b, 'README.md'), 'dirty, so no sync moved it\n');
    const preEdit = (file: string, tool: string) =>
      hubCli(['hook', 'pre-edit'], { cwd: repo.b, env: envFor(B), input: preToolUseInput(repo.b, path.join(repo.b, file), 'Edit', { session: 'sess-h', toolUseId: tool }) });

    const first = await preEdit('src/users.ts', 'toolu_h1');
    expect(JSON.parse(first.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          "agenthub: src/users.ts changed on main since your checkout (L-1 by maya/claude-1); you're editing the older version, and your edit will be merged with it at landing. If your worktree is clean, hub_sync first.",
      },
    });
    await clientFor(B).release({ all: true });
    expect((await preEdit('src/users.ts', 'toolu_h2')).stdout).toBe(''); // said for this tip already
    expect((await preEdit('src/auth.ts', 'toolu_h3')).stdout).toBe(''); // unchanged on trunk
    expect(JSON.parse(readFileSync(syncPaths(repo.b)!.mergebase, 'utf8'))).toMatchObject({ head: rev(repo.b), trunk: rev(repo.b, 'refs/remotes/origin/main') });
  });
});

describe('hub_sync (MCP) and hub sync', () => {
  async function connect(agent: string, root: string) {
    const cfg = cfgFor(agent, root);
    const c = new HubClient(cfg);
    const server = createMcpServer({ cfg, client: c, feed: null, cwd: root, env: testEnv({ HUB_URL: hub.url, HUB_PROJECT: PROJECT }) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: 'test', version: '0' });
    await mcp.connect(clientSide);
    cleanups.push(() => mcp.close());
    return async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
      return { text: res.content.map((x) => x.text).join('\n'), isError: !!res.isError };
    };
  }

  it('updates the workspace, or merges trunk into it, and says what happened', async () => {
    const call = await connect(B, repo.b);
    expect(await call('hub_sync')).toEqual({ isError: false, text: `Your workspace is up to date with main ${remoteMain().slice(0, 7)}.` });
    commit(repo.b, { 'src/auth.ts': AUTH_TRIM });
    const a = await landForReal(repo.a, A, { 'src/auth.ts': AUTH_SESS });
    const conflict = await call('hub_sync');
    expect(conflict.text).toMatch(/^Replaying your commit [0-9a-f]{7} onto main [0-9a-f]{7} conflicts in src\/auth\.ts; your workspace is unchanged\./);
    const merged = await call('hub_sync', { mode: 'merge' });
    expect(merged.text).toBe(
      `Merging main ${a.trunk.slice(0, 7)} into your branch stopped at conflicts in src/auth.ts; they hold conflict markers now. ` +
        'Resolve them keeping both intents, `git add` them and `git commit`, then call land again. To back out instead: git merge --abort.',
    );
  });

  it('hub sync --merge from the CLI', async () => {
    commit(repo.b, { 'src/routes.ts': 'export {};\n' });
    await landForReal(repo.a, A, { 'src/users.ts': 'export const users = [];\n' });
    const r = await hubCli(['sync', '--merge'], { cwd: repo.b, env: envFor(B) });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Merged main [0-9a-f]{7} into your branch \(L-1 landed\): src\/users\.ts changed\. Re-read those files before editing them, then land when ready\.\n$/);
  });
});

describe('feed notices', () => {
  function feedFor(agent: string, root: string): Feed {
    const feed = new Feed(clientFor(agent), { heartbeatMs: 1000, root });
    feed.start();
    cleanups.push(() => feed.stop());
    return feed;
  }
  async function noticesUntil(feed: Feed, pred: (n: string[]) => boolean, ms = 5000): Promise<string[]> {
    const got: string[] = [];
    const until = Date.now() + ms;
    while (Date.now() < until) {
      got.push(...feed.takeNotices());
      if (pred(got)) return got;
      await sleep(50);
    }
    return got;
  }

  it("tells the author its landing landed or came back, tells others when trunk moved under files they hold or modified, and fetches trunk", async () => {
    const fa = feedFor(A, repo.a);
    const fb = feedFor(B, repo.b);
    await sleep(300);
    // B waits for src/auth.ts, which A's landing holds; B has modified src/users.ts.
    const t = await clientFor(A).createTask({ title: 'Trim names' });
    await clientFor(A).takeTask(t.id);
    await clientFor(A).claim({ files: ['src/auth.ts', 'src/users.ts'], intent: 'trim', task_id: t.id });
    const head = commit(repo.a, { 'src/auth.ts': AUTH_SESS, 'src/users.ts': 'export const users = [];\n' });
    const out = await landWork({ cfg: cfgFor(A, repo.a), client: clientFor(A), feed: fa }, { task_id: t.id });
    expect(out.error, out.text).toBe(false);
    const queued = await clientFor(B).claim({ files: ['src/auth.ts'], intent: 'wait for it', queue: true });
    expect(queued.status).toBe('queued');
    fb.noteClaims([queued.claim!]);
    writeFileSync(path.join(repo.b, 'src', 'users.ts'), 'export const users = ["b"];\n');
    const { trunk, base, t0 } = await squashOntoTrunk(head, 'L-1', A);
    await lander.landIt('L-1', { base, trunkBase: t0, candidate: trunk, files: ['src/auth.ts', 'src/users.ts'] });

    const forA = await noticesUntil(fa, (n) => n.some((x) => x.startsWith('L-1')));
    expect(forA).toContain(
      `L-1 for ${t.id} landed on main as ${trunk.slice(0, 7)}; your holds are released. Your worktree updates to main at your next prompt (or call hub_sync now).`,
    );
    const forB = await noticesUntil(fb, (n) => n.some((x) => x.startsWith('trunk moved')));
    expect(forB).toContain('trunk moved: L-1 changed src/auth.ts, which you hold, and src/users.ts, which you have modified; call hub_sync when your worktree is clean.');
    expect(forB.filter((x) => x.startsWith('trunk moved'))).toHaveLength(1);
    // The background fetch: B's remote-tracking trunk follows without B doing anything.
    const until = Date.now() + 5000;
    while (Date.now() < until && rev(repo.b, 'refs/remotes/origin/main') !== trunk) await sleep(50);
    expect(rev(repo.b, 'refs/remotes/origin/main')).toBe(trunk);
  });

  it('tells the author of a send-back, a parked landing and a landing in doubt; tells approvers to relay an approval', async () => {
    const fa = feedFor(A, repo.a);
    const fb = feedFor(B, repo.b);
    await sleep(300);
    commit(repo.a, { 'migrations/0002.sql': 'alter table users add name text;\n' });
    const out = await landWork({ cfg: cfgFor(A, repo.a), client: clientFor(A), feed: fa }, {});
    expect(out.error, out.text).toBe(false);
    const requirement = {
      kind: 'protected',
      digest: 'd'.repeat(64),
      paths: ['migrations/0002.sql'],
      rules: [{ paths: ['migrations/**'], approvers: ['maya', 'sam'], distinct: true }],
      candidate: null,
      candidate_ref: null,
      trunk_base: null,
    };
    await lander.admit('L-1', { base_sha: rev(repo.a, 'HEAD^'), files: ['migrations/0002.sql'], protected: ['migrations/0002.sql'], required: [requirement] });
    const relay = await noticesUntil(fb, (n) => n.length > 0);
    expect(relay).toEqual([
      'L-1 by maya/claude-1 needs an approval of migrations/0002.sql, which your human sam may give: tell sam to run `hub approve L-1` in a terminal. You can\'t approve it.',
    ]);
    expect(fa.takeNotices()).toEqual([]); // asked of others at admission: the author was told when it landed

    const next = await lander.next();
    const attempt = next.landing.attempt;
    await lander.advance('L-1', { attempt, to: 'running', phase: 'merging', deadline_ms: 600_000, trunk_base: remoteMain() });
    const check = { command_hash: '0'.repeat(12), exit_code: 0, signal: null, timed_out: false, duration_ms: 1000, log_tail: '', failed_tests: [], passes_on_trunk: true, reproduce: '' };
    await lander.advance('L-1', { attempt, to: 'needs_approval', required: [requirement], report: report({ check }), candidate: rev(repo.a), candidate_ref: `refs/agenthub/cand/00000000/L-1/${rev(repo.a).slice(0, 12)}` });
    expect(await noticesUntil(fa, (n) => n.length > 0)).toEqual([
      'L-1 passed its checks and waits for an approval (migrations/0002.sql): tell your human to run `hub approve L-1` in a terminal (sam may approve; you can\'t).',
    ]);

    // A second landing, sent back.
    const fb2 = fb;
    commit(repo.b, { 'src/routes.ts': 'export {};\n' });
    const outB = await landWork({ cfg: cfgFor(B, repo.b), client: clientFor(B), feed: fb2 }, {});
    expect(outB.error, outB.text).toBe(false);
    await lander.failIt('L-2', { base: rev(repo.b, 'HEAD^'), trunkBase: remoteMain(), files: ['src/routes.ts'], code: 'checks_failed', report: { message: 'checks failed' } });
    expect(await noticesUntil(fb2, (n) => n.some((x) => x.startsWith('L-2')))).toContain(
      'L-2 came back (checks_failed): call landing_status {"landing_id": "L-2"} for exactly what to fix, then fix it, commit on top and land again (you keep your place).',
    );

    // A third, in pushing when the lander's lease ends: in doubt.
    const h3 = commit(repo.b, { 'src/routes.ts': 'export const r = 1;\n' });
    const out3 = await landWork({ cfg: cfgFor(B, repo.b), client: clientFor(B), feed: fb2 }, {});
    expect(out3.error, out3.text).toBe(false);
    await lander.admit('L-3', { base_sha: rev(repo.b, 'HEAD~2'), files: ['src/routes.ts'] });
    const n3 = await lander.next();
    expect(n3.landing.id).toBe('L-3');
    const t0 = remoteMain();
    await lander.advance('L-3', { attempt: n3.landing.attempt, to: 'running', phase: 'merging', deadline_ms: 600_000, trunk_base: t0 });
    await lander.advance('L-3', { attempt: n3.landing.attempt, to: 'running', phase: 'pushing', candidate: h3, candidate_ref: `refs/agenthub/cand/00000000/L-3/${h3.slice(0, 12)}`, trunk_base: t0, tree: h3, required: [] });
    await lander.call('POST', '/claims/release', { claim_id: lander.lease!.lease_claim_id });
    expect(await noticesUntil(fb2, (n) => n.some((x) => x.startsWith('L-3')))).toContain(
      'L-3 is waiting for a lander: the lander went offline while pushing it; any lander resolves it when it starts. hub_wait {"landing_id": "L-3"} tells you how it ends.',
    );
  });
});
