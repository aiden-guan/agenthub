import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunningServer } from '@agenthub/hub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init, splitCommand } from '../src/init.js';
import { A, B, CLI_COMMAND, PROJECT, client, git, makeRepo, run, startHub, testEnv, type SampleRepo } from './helpers.js';

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
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'hub hook pre-edit', timeout: 30 }] },
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
