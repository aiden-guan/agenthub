import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunningServer } from '@agenthub/hub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stagedPaths } from '../src/git.js';
import { guardScript, init, splitCommand } from '../src/init.js';
import { A, B, CLI_COMMAND, PROJECT, client, failingHub, git, hubCli, makeRepo, run, startHub, testEnv, type SampleRepo } from './helpers.js';

let srv: RunningServer;
let repo: SampleRepo;

beforeAll(async () => {
  srv = await startHub();
  repo = makeRepo();
});
afterAll(async () => {
  await srv.close();
  repo.cleanup();
});

describe('hub init', () => {
  it('writes the Claude Code hooks, MCP entry, identity file and pre-commit guard', () => {
    // An existing settings file and pre-commit hook must be preserved.
    mkdirSync(path.join(repo.main, '.claude'), { recursive: true });
    writeFileSync(
      path.join(repo.main, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] }] } }),
    );
    const hooksDir = git(repo.main, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks').trim();
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "lint ok" >&2\n');
    chmodSync(path.join(hooksDir, 'pre-commit'), 0o755);

    const report = init({ cwd: repo.main, project: PROJECT });
    expect(report.join('\n')).toMatch(/updated \.claude\/settings\.json/);

    const settings = JSON.parse(readFileSync(path.join(repo.main, '.claude', 'settings.json'), 'utf8'));
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] },
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'hub hook pre-edit', timeout: 30, onFailure: 'block' }] },
    ]);
    expect(settings.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'hub hook digest', timeout: 30 }] }]);
    expect(settings.enabledMcpjsonServers).toEqual(['hub']);
    expect(JSON.parse(readFileSync(path.join(repo.main, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { hub: { command: 'hub', args: ['mcp'] } } });

    const hook = readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8');
    expect(hook).toContain('# agenthub-guard');
    expect(hook).toContain('hub guard');
    expect(readFileSync(path.join(hooksDir, 'pre-commit.pre-agenthub'), 'utf8')).toContain('lint ok');

    expect(JSON.parse(readFileSync(path.join(repo.main, 'agenthub.json'), 'utf8'))).toEqual({ project: PROJECT });
    expect(existsSync(path.join(repo.main, '.hub.json'))).toBe(false); // no identity given
    const status = git(repo.main, 'status', '--porcelain');
    expect(status).toContain('agenthub.json');
  });

  it('is idempotent', () => {
    expect(init({ cwd: repo.main, project: PROJECT })).toEqual([
      'already set up; nothing to change',
      'note: no agent identity yet; run `hub init --agent <human>/<agent>` in each worktree (or set HUB_AGENT)',
    ]);
  });

  it('records a per-worktree identity, kept out of git', () => {
    const report = init({ cwd: repo.wtA, agent: A, project: PROJECT, url: srv.url, command: CLI_COMMAND, hooks: false, mcp: false });
    expect(report).toContain('wrote .hub.json (agent maya/claude-1)');
    expect(report.join('\n')).toMatch(/wrote agenthub\.json \(project demo, hub http:\/\/127\.0\.0\.1:\d+\)/);
    init({ cwd: repo.wtB, agent: B, project: PROJECT, url: srv.url, command: CLI_COMMAND, hooks: false, mcp: false });
    expect(JSON.parse(readFileSync(path.join(repo.wtB, '.hub.json'), 'utf8'))).toEqual({ agent: B });
    expect(JSON.parse(readFileSync(path.join(repo.wtB, 'agenthub.json'), 'utf8'))).toEqual({ project: PROJECT, url: srv.url });
    expect(git(repo.wtB, 'status', '--porcelain')).not.toContain('.hub.json');
    expect(existsSync(path.join(repo.wtA, '.claude', 'settings.json'))).toBe(false); // hooks: false
    expect(() => init({ cwd: repo.wtA, agent: 'not an id' })).toThrow(/invalid/);
  });

  it('adds onFailure "block" to a pre-edit hook entry written before it existed, but keeps an explicit choice', () => {
    const settingsPath = path.join(repo.main, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const entry = () => settings.hooks.PreToolUse[1].hooks[0];
    delete entry().onFailure;
    writeFileSync(settingsPath, JSON.stringify(settings));
    expect(init({ cwd: repo.main, project: PROJECT, guard: false }).join('\n')).toMatch(/updated \.claude\/settings\.json/);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[1].hooks).toEqual([
      { type: 'command', command: 'hub hook pre-edit', timeout: 30, onFailure: 'block' },
    ]);

    entry().onFailure = 'continue';
    writeFileSync(settingsPath, JSON.stringify(settings));
    init({ cwd: repo.main, project: PROJECT, guard: false });
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[1].hooks[0].onFailure).toBe('continue');
  });

  it('splits quoted commands for .mcp.json', () => {
    expect(splitCommand(`"/usr/local/bin/node" "/a b/cli.js"`)).toEqual(['/usr/local/bin/node', '/a b/cli.js']);
    expect(splitCommand('hub')).toEqual(['hub']);
  });
});

describe('hub guard (git pre-commit)', () => {
  const commit = (cwd: string, file: string, text: string) => {
    writeFileSync(path.join(cwd, file), text);
    git(cwd, 'add', file);
    return run('git', ['commit', '-m', `change ${file}`], { cwd, env: testEnv() });
  };

  it('rejects a commit that touches a file another agent holds exclusively', async () => {
    await client(srv.url, A).claim({ files: ['src/auth.ts'], intent: 'Migrate login to OAuth2' });
    const res = await commit(repo.wtB, 'src/auth.ts', 'export const login = () => "b";\n');
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('hub guard: commit blocked');
    expect(res.stderr).toMatch(/src\/auth\.ts — claimed by maya\/claude-1 \(C-\d+\) to "Migrate login to OAuth2" \(expires in 2 min\)/);
    expect(git(repo.wtB, 'log', '--oneline')).not.toContain('change src/auth.ts');
    git(repo.wtB, 'restore', '--staged', 'src/auth.ts');
    git(repo.wtB, 'checkout', '--', 'src/auth.ts');
  });

  it('lets the commit through for free files, and chains the previous pre-commit hook', async () => {
    const res = await commit(repo.wtB, 'src/users.ts', 'export const users = ["maya", "sam", "lee"];\n');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('lint ok'); // the pre-existing hook still ran
  });

  it("lets the holder commit its own claimed file", async () => {
    const res = await commit(repo.wtA, 'src/auth.ts', 'export const login = () => "a";\n');
    expect(res.code).toBe(0);
  });

  it('does not block on shared claims', async () => {
    await client(srv.url, A).claim({ files: ['README.md'], mode: 'shared', intent: 'changelog line' });
    const res = await commit(repo.wtB, 'README.md', '# sample\n\nmore\n');
    expect(res.code).toBe(0);
  });

  it('can be switched off with HUB_GUARD=off', async () => {
    writeFileSync(path.join(repo.wtB, 'src/auth.ts'), 'export const login = () => "forced";\n');
    git(repo.wtB, 'add', 'src/auth.ts');
    const res = await run('git', ['commit', '-m', 'forced'], { cwd: repo.wtB, env: testEnv({ HUB_GUARD: 'off' }) });
    expect(res.code).toBe(0);
  });
});

describe('hub guard: only an unreachable hub may let a commit through unchecked', () => {
  let hub: RunningServer;
  let r: SampleRepo;
  const env = (extra: Record<string, string | undefined> = {}) => testEnv({ HUB_URL: hub.url, HUB_PROJECT: PROJECT, HUB_AGENT: B, ...extra });
  const stage = (file: string, text: string) => {
    writeFileSync(path.join(r.wtB, file), text);
    git(r.wtB, 'add', file);
  };
  const unstage = () => {
    git(r.wtB, 'reset', '-q');
    git(r.wtB, 'checkout', '--', '.');
  };

  beforeAll(async () => {
    hub = await startHub();
    r = makeRepo();
    init({ cwd: r.main, project: PROJECT, command: CLI_COMMAND, hooks: false, mcp: false }); // installs the guard
    await client(hub.url, A).claim({ files: ['src/auth.ts'], intent: 'Migrate login to OAuth2' });
  });
  afterAll(async () => {
    await hub.close();
    r.cleanup();
  });

  it('checks every staged file of a very large commit (git output over 1 MiB, request bodies over the hub limit)', async () => {
    const vendor = path.join(r.wtB, 'vendor', 'v'.repeat(120));
    mkdirSync(vendor, { recursive: true });
    for (let i = 0; i < 6500; i++) writeFileSync(path.join(vendor, `${'w'.repeat(40)}-${String(i).padStart(5, '0')}.txt`), '');
    writeFileSync(path.join(r.wtB, 'src', 'auth.ts'), 'export const login = () => "b";\n');
    git(r.wtB, 'add', '-A');
    try {
      const staged = stagedPaths(r.wtB);
      expect(staged).toHaveLength(6501);
      expect(staged).toContain('src/auth.ts');

      const res = await run('git', ['commit', '-q', '-m', 'vendor everything'], { cwd: r.wtB, env: env({ HUB_FAIL_CLOSED: '1' }) });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toMatch(/commit blocked[\s\S]*src\/auth\.ts — claimed by maya\/claude-1/);
    } finally {
      unstage();
      rmSync(path.join(r.wtB, 'vendor'), { recursive: true, force: true });
    }
  });

  it('blocks the commit when git cannot list the staged files, instead of treating it as an empty commit', async () => {
    const index = git(r.wtB, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim();
    const saved = readFileSync(index);
    writeFileSync(index, 'not an index');
    try {
      expect(() => stagedPaths(r.wtB)).toThrow(/git diff --cached failed/);
      const res = await hubCli(['guard'], { cwd: r.wtB, env: env() });
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/^hub guard: could not list the staged files \(git diff --cached failed: .+\); commit blocked/);
    } finally {
      writeFileSync(index, saved);
    }
  });

  it('blocks on a 4xx refusal (such as a staged path the hub rejects) and fails open, with a warning, only on a 5xx', async () => {
    const refusing = await failingHub(400, 'invalid_path', 'path "notes\\u0007.txt" has control characters');
    const broken = await failingHub(503, 'unavailable', 'shutting down');
    stage('src/users.ts', 'export const users = [];\n');
    try {
      const refused = await hubCli(['guard'], { cwd: r.wtB, env: env({ HUB_URL: refusing.url }) });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/^hub guard: hub at http:\/\/127\.0\.0\.1:\d+ refused the request \(HTTP 400 invalid_path: path "notes\\u0007\.txt" has control characters\); commit blocked/);

      const open = await hubCli(['guard'], { cwd: r.wtB, env: env({ HUB_URL: broken.url }) });
      expect(open).toMatchObject({ code: 0, stderr: expect.stringMatching(/HTTP 503 unavailable: shutting down\); claims not checked/) });
      const closed = await hubCli(['guard'], { cwd: r.wtB, env: env({ HUB_URL: broken.url, HUB_FAIL_CLOSED: '1' }) });
      expect(closed).toMatchObject({ code: 1, stderr: expect.stringMatching(/HTTP 503.*commit blocked \(HUB_FAIL_CLOSED\)/) });
    } finally {
      unstage();
      await refusing.close();
      await broken.close();
    }
  });

  it('blocks the commit when the hub rejects the credentials (401)', async () => {
    const secured = await startHub({ token: 's3cret' });
    await client(secured.url, A, 's3cret').claim({ files: ['src/auth.ts'], intent: 'Migrate login to OAuth2' });
    stage('src/auth.ts', 'export const login = () => "b";\n');
    try {
      const commit = (token?: string) => run('git', ['commit', '-q', '-m', 'auth'], { cwd: r.wtB, env: env({ HUB_URL: secured.url, HUB_TOKEN: token }) });
      const without = await commit();
      expect(without.code).not.toBe(0);
      expect(without.stderr).toMatch(/rejected this agent's credentials \(HTTP 401 unauthorized: missing or wrong bearer token\); set HUB_TOKEN.*commit blocked/);
      const withToken = await commit('s3cret');
      expect(withToken.code).not.toBe(0);
      expect(withToken.stderr).toMatch(/src\/auth\.ts — claimed by maya\/claude-1/);
      expect(git(r.wtB, 'log', '--oneline')).not.toContain('auth');
    } finally {
      unstage();
      await secured.close();
    }
  });

  it('honours fail-closed from the environment and the config files when the hub CLI cannot be started at all', async () => {
    const missing = makeRepo();
    try {
      const hooksDir = git(missing.main, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks').trim();
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(path.join(hooksDir, 'pre-commit'), guardScript('agenthub-cli-missing-for-test'));
      chmodSync(path.join(hooksDir, 'pre-commit'), 0o755);
      let n = 0;
      const commit = (extra: Record<string, string> = {}) => {
        writeFileSync(path.join(missing.wtB, 'src', 'users.ts'), `export const n = ${n++};\n`);
        git(missing.wtB, 'add', 'src/users.ts');
        return run('git', ['commit', '-q', '-m', `change ${n}`], { cwd: missing.wtB, env: testEnv(extra) });
      };
      const skipped = /could not run 'agenthub-cli-missing-for-test' \(not on PATH, or node is missing\); claim guard skipped/;
      const blocked = /could not run 'agenthub-cli-missing-for-test' \(not on PATH, or node is missing\); commit blocked \(fail-closed\)/;

      expect(await commit()).toMatchObject({ code: 0, stderr: expect.stringMatching(skipped) });
      expect(await commit({ HUB_FAIL_CLOSED: '1' })).toMatchObject({ code: 1, stderr: expect.stringMatching(blocked) });
      expect(await commit({ HUB_FAIL_CLOSED: 'maybe' })).toMatchObject({ code: 1 }); // the CLI would reject it as a config error
      expect(await commit({ HUB_GUARD: 'off', HUB_FAIL_CLOSED: '1' })).toMatchObject({ code: 0 });

      writeFileSync(path.join(missing.wtB, '.hub.json'), JSON.stringify({ agent: B, failClosed: true }, null, 2));
      expect(await commit()).toMatchObject({ code: 1, stderr: expect.stringMatching(blocked) });
      expect(await commit({ HUB_FAIL_CLOSED: '0' })).toMatchObject({ code: 0, stderr: expect.stringMatching(skipped) });

      writeFileSync(path.join(missing.wtB, 'agenthub.json'), JSON.stringify({ project: PROJECT, failClosed: true }));
      writeFileSync(path.join(missing.wtB, '.hub.json'), JSON.stringify({ agent: B, failClosed: false }));
      expect(await commit()).toMatchObject({ code: 0, stderr: expect.stringMatching(skipped) }); // the local file wins
    } finally {
      missing.cleanup();
    }
  });
});
