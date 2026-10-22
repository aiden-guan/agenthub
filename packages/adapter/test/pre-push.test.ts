import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/init.js';
import { A, CLI_COMMAND, git, hubCli, run, testEnv } from './helpers.js';
import { PROJECT, TEAM_CONFIG, commit, landRefs, makeLandingRepo, startLandingHub, type LandingHub, type LandingRepo } from './landing-hub.js';

// Step A2 (design §2.3.6): `hub guard --pre-push`, installed by `hub init` as
// git's pre-push hook and chained like the other guard scripts. A speed bump:
// trunk and candidate refs are the lander's; the real enforcement is the host
// rule.

let hub: LandingHub;
let repo: LandingRepo;

beforeEach(async () => {
  hub = await startLandingHub();
  repo = makeLandingRepo();
});
afterEach(async () => {
  await hub.close();
  repo.cleanup();
});

const ZERO = '0'.repeat(40);
const envFor = (extra: Record<string, string | undefined> = {}) => testEnv({ HUB_URL: hub.url, HUB_PROJECT: PROJECT, HUB_AGENT: A, ...extra });
/** `hub guard --pre-push` as git runs it: the remote's name and URL as arguments, one line per ref on stdin. */
const prePush = (wt: string, lines: string[], extra: Record<string, string | undefined> = {}) =>
  hubCli(['guard', '--pre-push', 'origin', repo.remote], { cwd: wt, env: envFor(extra), input: lines.map((l) => `${l}\n`).join('') });

describe('hub guard --pre-push', () => {
  it("refuses updates of trunk and of candidate refs, deletions included, and lets land refs and other branches through", async () => {
    const head = commit(repo.a, { 'src/users.ts': 'export const users = [];\n' });
    const trunk = git(repo.a, 'rev-parse', 'origin/main').trim();

    const toMain = await prePush(repo.a, [`refs/heads/agent-a ${head} refs/heads/main ${trunk}`]);
    expect(toMain.code).toBe(1);
    expect(toMain.stderr).toBe(
      'hub guard: push blocked: main is updated only by the landing queue. Call land (MCP) or `hub land`. Emergency bypass: HUB_GUARD=off.\n' +
        '  refs/heads/main\n',
    );
    const deleting = await prePush(repo.a, [`(delete) ${ZERO} refs/heads/main ${trunk}`]);
    expect(deleting.code).toBe(1);
    // git writes the source as typed: an expression with spaces (HEAD^{/fix the bug}, main@{1 minute ago}) shifts the fields.
    for (const source of ['HEAD^{/fix the bug}', 'main@{1 minute ago}', 'HEAD^{/a  b\tc}']) {
      const spaced = await prePush(repo.a, [`${source} ${head} refs/heads/main ${trunk}`]);
      expect(spaced.code, source).toBe(1);
      expect(spaced.stderr).toContain('  refs/heads/main\n');
    }
    expect((await prePush(repo.a, [`HEAD^{/fix the bug} ${head} refs/heads/agent-a ${ZERO}`])).code).toBe(0);

    const cand = await prePush(repo.a, [`${head} ${head} refs/agenthub/cand/1b4e28ba/L-7/${head.slice(0, 12)} ${ZERO}`]);
    expect(cand.code).toBe(1);
    expect(cand.stderr).toBe(
      'hub guard: push blocked: candidate refs (refs/agenthub/cand/…) are written only by the lander. Emergency bypass: HUB_GUARD=off.\n' +
        `  refs/agenthub/cand/1b4e28ba/L-7/${head.slice(0, 12)}\n`,
    );

    // A mixed push is refused as a whole, naming only what it refuses.
    const mixed = await prePush(repo.a, [`${head} ${head} refs/agenthub/land/${head} ${ZERO}`, `refs/heads/agent-a ${head} refs/heads/main ${trunk}`]);
    expect(mixed.code).toBe(1);
    expect(mixed.stderr).not.toContain('refs/agenthub/land/');

    expect(await prePush(repo.a, [`${head} ${head} refs/agenthub/land/${head} ${ZERO}`])).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await prePush(repo.a, [`refs/heads/agent-a ${head} refs/heads/agent-a ${ZERO}`])).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await prePush(repo.a, [`refs/heads/agent-a ${head} refs/heads/main-backup ${ZERO}`])).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await prePush(repo.a, [])).toEqual({ code: 0, stdout: '', stderr: '' });

    // The emergency bypass.
    expect(await prePush(repo.a, [`refs/heads/agent-a ${head} refs/heads/main ${trunk}`], { HUB_GUARD: 'off' })).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it("uses trunk's land.trunk and land.refPrefix", async () => {
    const custom = makeLandingRepo({ ...TEAM_CONFIG, land: { ...TEAM_CONFIG.land, trunk: 'trunk', refPrefix: 'refs/heads/agenthub/' } });
    try {
      const head = git(custom.a, 'rev-parse', 'HEAD').trim();
      const guard = (lines: string[]) => hubCli(['guard', '--pre-push', 'origin', custom.remote], { cwd: custom.a, env: envFor(), input: lines.map((l) => `${l}\n`).join('') });
      expect((await guard([`refs/heads/x ${head} refs/heads/trunk ${ZERO}`])).code).toBe(1);
      expect((await guard([`refs/heads/x ${head} refs/heads/main ${ZERO}`])).code).toBe(0);
      expect((await guard([`${head} ${head} refs/heads/agenthub/cand/1b4e28ba/L-1/${head.slice(0, 12)} ${ZERO}`])).code).toBe(1);
      expect((await guard([`${head} ${head} refs/heads/agenthub/land/${head} ${ZERO}`])).code).toBe(0);
    } finally {
      custom.cleanup();
    }
  });

  it('leaves pushes alone in a project without a landing queue (no land section)', async () => {
    const plain = makeLandingRepo({ project: PROJECT });
    try {
      const head = git(plain.a, 'rev-parse', 'HEAD').trim();
      const r = await hubCli(['guard', '--pre-push', 'origin', plain.remote], { cwd: plain.a, env: envFor(), input: `refs/heads/agent-a ${head} refs/heads/main ${ZERO}\n` });
      expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    } finally {
      plain.cleanup();
    }
  });
});

describe('hub init installs the pre-push guard', () => {
  const hooksDir = (wt: string) => git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks').trim();

  it('blocks a real git push to trunk, lets the land ref through, and HUB_GUARD=off bypasses it', async () => {
    const report = init({ cwd: repo.a, agent: A, project: PROJECT, url: hub.url, command: CLI_COMMAND, hooks: false, mcp: false, env: {} });
    expect(report).toContain(`installed pre-push guard at ${path.join(hooksDir(repo.a), 'pre-push')}`);
    expect(readFileSync(path.join(hooksDir(repo.a), 'pre-push'), 'utf8')).toContain('guard --pre-push');
    git(repo.a, 'checkout', '-q', '--', 'agenthub.json'); // hub init added the url to the team file
    const head = commit(repo.a, { 'src/users.ts': 'export const users = [];\n' }, 'add some users');
    const trunk = git(repo.remote, 'rev-parse', 'main').trim();

    const toMain = await run('git', ['push', 'origin', 'HEAD:main'], { cwd: repo.a, env: envFor() });
    expect(toMain.code).not.toBe(0);
    expect(toMain.stderr).toContain('hub guard: push blocked: main is updated only by the landing queue.');
    expect(git(repo.remote, 'rev-parse', 'main').trim()).toBe(trunk);
    const spaced = await run('git', ['push', 'origin', 'HEAD^{/add some}:refs/heads/main'], { cwd: repo.a, env: envFor() });
    expect(spaced.code).not.toBe(0);
    expect(spaced.stderr).toContain('hub guard: push blocked: main is updated only by the landing queue.');
    expect(git(repo.remote, 'rev-parse', 'main').trim()).toBe(trunk);

    const land = await run('git', ['push', 'origin', `${head}:refs/agenthub/land/${head}`], { cwd: repo.a, env: envFor() });
    expect(land.code, land.stderr).toBe(0);
    expect(landRefs(repo.remote)).toEqual({ [`refs/agenthub/land/${head}`]: head });

    const bypass = await run('git', ['push', 'origin', 'HEAD:main'], { cwd: repo.a, env: envFor({ HUB_GUARD: 'off' }) });
    expect(bypass.code, bypass.stderr).toBe(0);
    expect(git(repo.remote, 'rev-parse', 'main').trim()).toBe(head);
  });

  it("chains an existing pre-push hook: it runs after the guard with the same arguments and the same ref lines on stdin", async () => {
    const log = path.join(repo.dir, 'chained.log');
    const hook = path.join(hooksDir(repo.a), 'pre-push');
    writeFileSync(hook, `#!/bin/sh\necho "args: $1 $2" >> "${log}"\nwhile read -r line; do echo "line: $line" >> "${log}"; done\necho "my pre-push ran" >&2\n`);
    chmodSync(hook, 0o755);

    const report = init({ cwd: repo.a, agent: A, project: PROJECT, url: hub.url, command: CLI_COMMAND, hooks: false, mcp: false, env: {} });
    expect(report).toContain('kept your existing pre-push hook as pre-push.pre-agenthub (runs after the guard)');
    expect(init({ cwd: repo.a, agent: A, project: PROJECT, url: hub.url, command: CLI_COMMAND, hooks: false, mcp: false, env: {} })).toContain('already set up; nothing to change');
    git(repo.a, 'checkout', '-q', '--', 'agenthub.json');
    const head = commit(repo.a, { 'src/users.ts': 'export const users = [];\n' });

    const land = await run('git', ['push', 'origin', `${head}:refs/agenthub/land/${head}`], { cwd: repo.a, env: envFor() });
    expect(land.code, land.stderr).toBe(0);
    expect(land.stderr).toContain('my pre-push ran');
    expect(readFileSync(log, 'utf8')).toBe(`args: origin ${repo.remote}\nline: ${head} ${head} refs/agenthub/land/${head} ${ZERO}\n`);

    // Refused by the guard: the chained hook doesn't run.
    writeFileSync(log, '');
    const toMain = await run('git', ['push', 'origin', 'HEAD:main'], { cwd: repo.a, env: envFor() });
    expect(toMain.code).not.toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('');
    expect(existsSync(`${hook}.pre-agenthub`)).toBe(true);
  });
});
