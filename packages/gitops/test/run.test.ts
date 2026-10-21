// The isolated runner (design §2.2.2): no global or system config, no hooks,
// no prompts, lock errors retried, feature probes.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { features, GitError, open } from '../src/index.js';
import { gitShim, IDENT_ENV, Repo, tmp, type Tmp } from './helpers.js';

let t: Tmp;
let repo: Repo;
beforeEach(() => {
  t = tmp();
  repo = Repo.init(path.join(t.dir, 'w'));
  repo.commit('first', { 'a.txt': 'a\n' });
});
afterEach(() => t.cleanup());

/** The environment git hands a shell alias: what any child of git (a hook, a driver) would see. */
async function childEnv(isolated: boolean, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const g = open(repo.dir, { isolated, env: extra }).with({ 'alias.envdump': '!env' });
  const out = (await g.run(['envdump'])).stdout;
  return Object.fromEntries(out.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

describe('open (isolated)', () => {
  it('reads no global or system config, runs no hooks and never prompts', async () => {
    const evil = path.join(t.dir, 'evil.gitconfig');
    writeFileSync(evil, '[user]\n\tname = Evil\n[merge "pwn"]\n\tdriver = touch pwned\n');
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, dir: process.env.GIT_DIR };
    process.env.GIT_CONFIG_GLOBAL = evil;
    process.env.GIT_DIR = path.join(t.dir, 'nowhere');
    try {
      const env = await childEnv(true);
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.HUB_GUARD).toBe('off');
      expect(env.GIT_DIR).toBeUndefined();

      const g = open(repo.dir, { isolated: true });
      const name = await g.run(['config', 'user.name'], { ok: [0, 1] });
      expect(name.stdout.trim()).toBe('');
      expect((await g.run(['config', 'core.hooksPath'])).stdout.trim()).toBe('/dev/null');
      expect((await g.run(['config', 'gc.auto'])).stdout.trim()).toBe('0');
      expect((await g.run(['config', 'merge.conflictStyle'])).stdout.trim()).toBe('diff3');

      // The developer's own git still sees the planted config: isolation is what hides it.
      const plain = open(repo.dir, { isolated: false, env: { GIT_DIR: path.join(repo.dir, '.git') } });
      expect((await plain.run(['config', 'user.name'])).stdout.trim()).toBe('Evil');
    } finally {
      for (const [k, v] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_DIR', saved.dir]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('keeps isolation when a caller passes env or config that would undo it', async () => {
    const env = await childEnv(true, { GIT_CONFIG_GLOBAL: path.join(t.dir, 'evil.gitconfig'), GIT_TERMINAL_PROMPT: '1' });
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    const g = repo.open().with({ 'core.hooksPath': path.join(t.dir, 'hooks') });
    expect((await g.run(['config', 'core.hooksPath'])).stdout.trim()).toBe('/dev/null');
    expect(() => repo.open().with({ 'bad key': 'x' })).toThrow(/config/);
    expect(() => repo.open().with({ 'alias.x': 'a\nb' })).toThrow(/config/);
  });

  it('keeps credentials in URLs out of error messages', async () => {
    // An unknown transport fails at once, without any network.
    const err = await repo.open().run(['ls-remote', 'nope://maya:s3cret-token@example.invalid/repo.git'], { timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).message).not.toContain('s3cret-token');
    expect((err as GitError).message).toContain('nope://***@example.invalid/repo.git');
  });

  it('runs no client hooks', async () => {
    const hook = path.join(repo.dir, '.git', 'hooks', 'pre-commit');
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\necho hooked >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const g = repo.open();
    writeFileSync(path.join(repo.dir, 'b.txt'), 'b\n');
    await g.run(['add', 'b.txt']);
    const r = await g.run(['commit', '-q', '-m', 'second']);
    expect(r.stderr).not.toContain('hooked');
    expect(repo.git('log', '-1', '--format=%s')).toBe('second');
  });

  it('adds the caller env last, and with() adds -c for every call without changing the original', async () => {
    expect((await childEnv(true, { PROBE: 'yes' })).PROBE).toBe('yes');
    const g = repo.open();
    const g2 = g.with({ 'agenthub.probe': 'one' });
    expect((await g2.run(['config', 'agenthub.probe'])).stdout.trim()).toBe('one');
    expect((await g.run(['config', 'agenthub.probe'], { ok: [0, 1] })).code).toBe(1);
    expect(g2.dir).toBe(g.dir);
    expect(g2.bare).toBe(false);
  });

  it('treats only the ok exit codes as success and rejects the rest with a GitError', async () => {
    const g = repo.open();
    const r = await g.run(['merge-base', '--is-ancestor', 'HEAD', 'HEAD'], { ok: [0, 1] });
    expect(r.code).toBe(0);
    const err = await g.run(['rev-parse', '--verify', 'no-such-ref']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).code).toBe(128);
    expect((err as GitError).message).toContain('rev-parse');
  });

  it('kills a command that outlives its timeout', async () => {
    const g = repo.open().with({ 'alias.slow': '!sleep 5' });
    const started = Date.now();
    const err = await g.run(['slow'], { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('retries a ref-lock error and succeeds once the lock is gone', async () => {
    const g = repo.open();
    const lock = path.join(repo.dir, '.git', 'refs', 'heads', 'x.lock');
    writeFileSync(lock, '');
    setTimeout(() => rmSync(lock, { force: true }), 60);
    await g.run(['update-ref', 'refs/heads/x', 'HEAD']);
    expect(repo.rev('refs/heads/x')).toBe(repo.head());
  });

  it('gives up on a lock that stays', async () => {
    const g = repo.open();
    writeFileSync(path.join(repo.dir, '.git', 'refs', 'heads', 'y.lock'), '');
    const err = await g.run(['update-ref', 'refs/heads/y', 'HEAD']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).stderr).toMatch(/Unable to create .*y\.lock/);
  });

  it('adds --no-write-fetch-head to an isolated fetch', async () => {
    const shim = gitShim(t.dir);
    const remote = Repo.init(path.join(t.dir, 'remote'));
    remote.commit('r', { 'r.txt': 'r\n' });
    const g = open(repo.dir, { isolated: true, env: { ...IDENT_ENV, PATH: shim.path } });
    await g.run(['fetch', '-q', remote.dir, '+refs/heads/main:refs/remotes/r/main']);
    const fetch = shim.calls().find((c) => c.includes('fetch'))!;
    expect(fetch.slice(fetch.indexOf('fetch'))).toEqual(['fetch', '--no-write-fetch-head', '-q', remote.dir, '+refs/heads/main:refs/remotes/r/main']);
    expect(repo.rev('refs/remotes/r/main')).toBe(remote.head());
  });

  it('opens a bare mirror with --git-dir', async () => {
    const mirror = path.join(t.dir, 'mirror.git');
    repo.git('clone', '-q', '--bare', repo.dir, mirror);
    const g = open(mirror, { isolated: true });
    expect(g.bare).toBe(true);
    expect((await g.run(['rev-parse', '--is-bare-repository'])).stdout.trim()).toBe('true');
    expect((await g.run(['rev-parse', 'main'])).stdout.trim()).toBe(repo.head());
  });
});

describe('features', () => {
  it('finds merge-tree --merge-base and --attr-source on this git', async () => {
    expect(await features(repo.open())).toEqual({ mergeTreeBase: true, attrSource: true });
  });

  it('reports a missing --attr-source (probed, not version-parsed)', async () => {
    // The shim refuses the global option the way a git older than 2.42 does ("unknown option", exit 129).
    const shim = gitShim(t.dir, { block: '--attr-source', code: 129 });
    const g = open(repo.dir, { isolated: true, env: { PATH: shim.path } });
    expect(await features(g)).toEqual({ mergeTreeBase: true, attrSource: false });
    expect(shim.calls().some((c) => c.some((a) => a.startsWith('--attr-source=')))).toBe(true);
  });

  it('reports false for both on a git without merge-tree --merge-base', async () => {
    const shim = gitShim(t.dir, { block: '--merge-base', code: 129 });
    const g = open(repo.dir, { isolated: true, env: { PATH: shim.path } });
    expect(await features(g)).toEqual({ mergeTreeBase: false, attrSource: false });
  });

  it('writes no refs and leaves the index alone', async () => {
    const before = repo.git('for-each-ref');
    await features(repo.open());
    expect(repo.git('for-each-ref')).toBe(before);
    expect(repo.git('status', '--porcelain')).toBe('');
  });
});
