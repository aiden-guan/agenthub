import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open } from '@agenthub/gitops';
import { ChecksRunner, checkEnvironment, parseFailedTests } from '../src/checks.js';
import { commandHash } from '../src/report.js';
import { EPOCH, Repo, bareMirror, sh, tmp, trailers, type Tmp } from './helpers.js';

// design §2.2.8 and the §5.1 lander row: env scrub, process-group kill on
// timeout, checks_modified_tree, the log tail cap, redaction, worktree
// removal, the failed_tests parsers.

const KEY = 'sk-ant-api03-Zx9yW8vU7tS6rQ5pO4nM3lK2jI1hG0fE';
const NPM = 'npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const LANDER_TOKEN = 'lander-token-value-7f3a91';

/** A zombie (dead, waiting for a slow init to reap it, as in some containers) counts as dead. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return process.platform !== 'linux';
  }
}

async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe('ChecksRunner (design §2.2.8)', () => {
  let t: Tmp;
  let repo: Repo;
  let mirror: string;
  let work: string;
  let C: string;
  let T0: string;
  let landerEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    t = tmp('lander-checks-');
    repo = Repo.init(path.join(t.dir, 'repo'));
    T0 = repo.commit(`trunk tip\n\n${trailers({ landing: 'acme/web/L-6', hub: EPOCH, source: 'a'.repeat(40) })}\nAgenthub-Checked: ${commandHash('node check.mjs')}`, {
      'tracked.txt': 'one\n',
      'src/app.ts': 'export const x = 1;\n',
    });
    C = repo.commit('candidate', { 'src/app.ts': 'export const x = 2;\n' });
    mirror = bareMirror(repo, path.join(t.dir, 'mirror.git'));
    work = path.join(t.dir, 'work');
    mkdirSync(work);
    landerEnv = {
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      HOME: '/home/lander',
      ANTHROPIC_API_KEY: KEY,
      HUB_TOKEN: 'hub-bearer-token',
      HUB_LANDER_TOKEN: LANDER_TOKEN,
      HUB_URL: 'http://127.0.0.1:7077',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      GIT_DIR: '/somewhere/else/.git',
      GIT_ASKPASS: '/usr/bin/askpass',
      GITHUB_TOKEN: 'ghs_notpassed',
      GH_TOKEN: 'gh-notpassed',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      DEPLOY_KEY: 'deploy-key',
      MY_SECRET: 'shh',
      NPM_TOKEN: NPM,
      UNLISTED: 'not-on-the-allowlist',
    };
  });
  afterAll(() => t.cleanup());

  const runner = (o: Partial<ConstructorParameters<typeof ChecksRunner>[0]> = {}) =>
    new ChecksRunner({
      workdir: work,
      mirror: open(mirror, { isolated: true, bare: true }),
      env: landerEnv,
      passEnv: ['NPM_TOKEN', 'HUB_TOKEN', 'SSH_AUTH_SOCK', 'DEPLOY_KEY'],
      secrets: [LANDER_TOKEN, KEY],
      killGraceMs: 300,
      ...o,
    });

  let attempt = 0;
  const request = (command: string, o: Partial<Parameters<ChecksRunner['run']>[0]> = {}) => ({
    landingId: 'L-7',
    attempt: ++attempt,
    candidate: C,
    trunk: T0,
    epoch: EPOCH,
    command,
    timeoutMs: 20_000,
    checkEnv: {},
    allowDirtyTree: false,
    remote: 'origin',
    candidateRef: 'refs/agenthub/cand/1b4e28ba/L-7/' + C.slice(0, 12),
    ...o,
  });

  it('runs the check in a fresh worktree of the candidate with an allowlisted env and a scratch HOME', async () => {
    const r = runner();
    const req = request(
      [
        'env | cut -d= -f1 | sort | sed "s/^/NAME /"',
        'echo "HOME=$HOME"',
        'echo "TMPDIR=$TMPDIR"',
        'echo "CI=$CI TZ=$TZ TERM=$TERM FOO=$FOO"',
        'echo "LANDING=$AGENTHUB_LANDING TRUNK=$AGENTHUB_TRUNK"',
        'echo "NPM=$NPM_TOKEN"',
        'echo "PWD=$(pwd)"',
        'cat src/app.ts',
      ].join('\n'),
      { checkEnv: { FOO: 'bar', CI: 'true', HUB_URL: 'http://evil', GIT_DIR: '/x', ANTHROPIC_BASE_URL: 'http://evil', SOME_TOKEN: 'from-config' } },
    );
    const res = await r.run(req);
    expect(res.status).toBe('passed');
    expect(res.report.exit_code).toBe(0);
    const out = res.report.log_tail;
    const names = out.split('\n').filter((l) => l.startsWith('NAME ')).map((l) => l.slice(5));
    for (const gone of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'HUB_TOKEN', 'HUB_LANDER_TOKEN', 'HUB_URL', 'SSH_AUTH_SOCK', 'GIT_DIR', 'GIT_ASKPASS', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'MY_SECRET', 'SOME_TOKEN', 'UNLISTED']) {
      expect(names, gone).not.toContain(gone);
    }
    for (const kept of ['PATH', 'LANG', 'HOME', 'TMPDIR', 'TZ', 'TERM', 'CI', 'FOO', 'NPM_TOKEN', 'DEPLOY_KEY', 'AGENTHUB_LANDING', 'AGENTHUB_TRUNK', 'npm_config_cache']) {
      expect(names, kept).toContain(kept);
    }
    const runDir = path.join(work, 'runs', `L-7.${req.attempt}`);
    expect(out).toContain(`HOME=${path.join(runDir, 'home')}`);
    expect(out).toContain(`TMPDIR=${path.join(runDir, 'tmp')}`);
    expect(out).toContain('CI=true TZ=UTC TERM=dumb FOO=bar');
    expect(out).toContain(`LANDING=L-7 TRUNK=${T0}`);
    expect(out).toContain(`PWD=${path.join(runDir, 'wt')}`);
    expect(out).toContain('export const x = 2;');
    // passEnv values reach the check, but never the report.
    expect(out).toContain('NPM=[REDACTED]');
    expect(out).not.toContain(NPM);
    expect(res.report.command_hash).toBe(commandHash(req.command));
  });

  it('builds the env from the allowlist only (unit)', () => {
    const env = checkEnvironment({
      base: landerEnv,
      passEnv: ['NPM_TOKEN', 'HUB_TOKEN', 'GIT_SSH_COMMAND', 'GITHUB_TOKEN'],
      checkEnv: { CI: '1', HUB_X: 'no', LOCAL: 'yes' },
      runDir: '/w/runs/L-1.1',
      npmCache: '/w/npm-cache',
      landingId: 'L-1',
      trunk: T0,
    });
    expect(env).toEqual({
      PATH: process.env.PATH,
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      TERM: 'dumb',
      CI: '1',
      npm_config_cache: '/w/npm-cache',
      LOCAL: 'yes',
      NPM_TOKEN: NPM,
      HOME: '/w/runs/L-1.1/home',
      TMPDIR: '/w/runs/L-1.1/tmp',
      AGENTHUB_LANDING: 'L-1',
      AGENTHUB_TRUNK: T0,
    });
  });

  it('kills the whole process group on timeout, grandchildren included', async () => {
    const pidFile = path.join(t.dir, 'grandchild.pid');
    const r = runner();
    const started = Date.now();
    const res = await r.run(request(`sh -c 'sleep 999 & echo $! > ${pidFile}; wait'`, { timeoutMs: 600 }));
    expect(res.status).toBe('timed_out');
    expect(res.report.timed_out).toBe(true);
    expect(res.report.exit_code).toBeNull();
    expect(Date.now() - started).toBeLessThan(8000);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it('escalates to SIGKILL when the check ignores SIGTERM', async () => {
    const pidFile = path.join(t.dir, 'stubborn.pid');
    const res = await runner().run(request(`trap '' TERM; sleep 999 & echo $! > ${pidFile}; wait; wait`, { timeoutMs: 400 }));
    expect(res.status).toBe('timed_out');
    expect(res.report.signal).toBe('SIGKILL');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it('kills what a passing check leaves running in the background', async () => {
    const pidFile = path.join(t.dir, 'leftover.pid');
    const started = Date.now();
    const res = await runner().run(request(`sleep 999 > /dev/null 2>&1 & echo $! > ${pidFile}; sleep 999 & echo done`, {}));
    expect(res.status).toBe('passed');
    expect(Date.now() - started).toBeLessThan(8000);
    expect(await until(() => !alive(Number(readFileSync(pidFile, 'utf8'))))).toBe(true);
  });

  it('fails a check that modifies tracked files (checks_modified_tree), unless allowDirtyTree', async () => {
    const dirty = await runner().run(request('echo changed >> tracked.txt'));
    expect(dirty.status).toBe('modified_tree');
    expect(dirty.report.exit_code).toBe(0);
    const allowed = await runner().run(request('echo changed >> tracked.txt', { allowDirtyTree: true }));
    expect(allowed.status).toBe('passed');
    const untracked = await runner().run(request('mkdir -p out && echo x > out/build.txt'));
    expect(untracked.status).toBe('passed');
  });

  it('reports a failing check with its exit code, failed tests, passes_on_trunk and the reproduce line', async () => {
    const req = request(
      [
        "printf ' \\033[31mFAIL\\033[39m  test/auth.test.ts > login > trims whitespace\\n'",
        "printf '   \\342\\234\\223 login > keeps sessions 2ms\\n'",
        "printf '   \\303\\227 login > trims whitespace 3ms\\n'",
        "printf ' FAIL  test/auth.test.ts > refresh > keeps expiry\\n'",
        'exit 3',
      ].join('\n'),
    );
    const res = await runner().run(req);
    expect(res.status).toBe('failed');
    expect(res.report.exit_code).toBe(3);
    expect(res.report.failed_tests).toEqual(['test/auth.test.ts > login > trims whitespace', 'test/auth.test.ts > refresh > keeps expiry']);
    // ANSI stripped.
    expect(res.report.log_tail).toContain(' FAIL  test/auth.test.ts > login > trims whitespace');
    expect(res.report.log_tail).not.toContain('\u001b');
    // T0 carries this hub's trailer, but another command's hash: unknown.
    expect(res.report.passes_on_trunk).toBeNull();
    expect(res.report.reproduce).toBe(
      `git fetch origin ${req.candidateRef} && git worktree add /tmp/agenthub-L-7 ${C} && (cd /tmp/agenthub-L-7 && ${req.command})`,
    );
    expect(res.logFile && readFileSync(res.logFile, 'utf8')).toContain('refresh > keeps expiry');
  });

  it('passes_on_trunk is true when T0 landed through this hub under the same check command', async () => {
    const res = await runner().run(request('node check.mjs'));
    expect(res.report.command_hash).toBe(commandHash('node check.mjs'));
    expect(res.status).toBe('failed'); // there is no check.mjs in the candidate
    expect(res.report.passes_on_trunk).toBe(true);
    const otherHub = await runner().run(request('node check.mjs', { epoch: 'ffffffff-2fa1-11d2-883f-0016d3cca427' }));
    expect(otherHub.report.passes_on_trunk).toBeNull();
  });

  it('caps the log tail at 200 lines and 16 KiB, and the log file at its cap', async () => {
    const lines = await runner().run(request('seq 1 1000'));
    const tail = lines.report.log_tail.split('\n').filter(Boolean);
    expect(tail.length).toBe(200);
    expect(tail[0]).toBe('801');
    expect(tail[199]).toBe('1000');
    expect(readFileSync(lines.logFile!, 'utf8').split('\n').filter(Boolean).length).toBe(1000);

    // 200 lines of 501 bytes: about 98 KiB of output.
    const wide = await runner({ logCapBytes: 64 * 1024 }).run(request(`i=0; while [ $i -lt 200 ]; do printf '%0500d\\n' $i; i=$((i+1)); done`));
    expect(Buffer.byteLength(wide.report.log_tail)).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength(wide.report.log_tail)).toBeGreaterThan(15 * 1024);
    expect(wide.report.log_tail.trimEnd().endsWith('199')).toBe(true);
    const file = readFileSync(wide.logFile!, 'utf8');
    expect(Buffer.byteLength(file)).toBeLessThanOrEqual(64 * 1024 + 200);
    expect(file).toContain('log truncated');
  });

  it('redacts exact secret values and token shapes from the tail and the log file', async () => {
    const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', '-----END OPENSSH PRIVATE KEY-----'];
    const leaks = [
      `echo "lander token: ${LANDER_TOKEN}"`,
      `echo "key ${KEY} in a line"`,
      'echo "anthropic sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
      'echo "classic ghp_0123456789abcdefghijABCDEFGHIJ012345"',
      'echo "fine-grained github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789"',
      'echo "slack xoxb-1234567890-0987654321-AbCdEfGhIjKl"',
      'echo "aws AKIAIOSFODNN7EXAMPLE"',
      `printf '%s\\n' ${pem.map((l) => `'${l}'`).join(' ')}`,
      'echo "after the key"',
    ].join('\n');
    const res = await runner().run(request(leaks));
    for (const text of [res.report.log_tail, readFileSync(res.logFile!, 'utf8')]) {
      expect(text).not.toContain(LANDER_TOKEN);
      expect(text).not.toContain(KEY);
      expect(text).not.toMatch(/sk-ant-api03-A/);
      expect(text).not.toContain('ghp_0123456789');
      expect(text).not.toContain('github_pat_11ABC');
      expect(text).not.toContain('xoxb-1234567890');
      expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ');
      expect(text).toContain('lander token: [REDACTED]');
      expect(text).toContain('[REDACTED PRIVATE KEY]');
      expect(text).toContain('after the key');
    }
  });

  it('removes the worktree, HOME and TMPDIR after the run, and leaves no worktree registered', async () => {
    const req = request('touch $HOME/.npmrc $TMPDIR/scratch; exit 1');
    const res = await runner().run(req);
    expect(res.status).toBe('failed');
    const runDir = path.join(work, 'runs', `L-7.${req.attempt}`);
    expect(existsSync(path.join(runDir, 'wt'))).toBe(false);
    expect(existsSync(path.join(runDir, 'home'))).toBe(false);
    expect(existsSync(path.join(runDir, 'tmp'))).toBe(false);
    const list = sh(mirror, ['worktree', 'list', '--porcelain']);
    expect(list).not.toContain(runDir);
  });

  it('aborts when the trunk watch sees trunk move, killing the check', async () => {
    const pidFile = path.join(t.dir, 'watched.pid');
    let calls = 0;
    const res = await runner().run(
      request(`sleep 999 & echo $! > ${pidFile}; wait`, { trunkWatch: { intervalMs: 50, moved: async () => ++calls >= 3 } }),
    );
    expect(res.status).toBe('trunk_moved');
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(await until(() => !alive(Number(readFileSync(pidFile, 'utf8'))))).toBe(true);
    // A failing watch (the remote is unreachable) doesn't abort the run.
    const flaky = await runner().run(request('sleep 0.3', { trunkWatch: { intervalMs: 20, moved: async () => Promise.reject(new Error('offline')) } }));
    expect(flaky.status).toBe('passed');
  });

  it('aborts on its signal (not_lander, landing_stale, shutdown)', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const res = await runner().run(request('sleep 999', { signal: ctl.signal }));
    expect(res.status).toBe('aborted');
  });

  it('wraps the check with checkWrapper, substituting {wt}', async () => {
    const res = await runner({ checkWrapper: 'env WRAPPED_IN={wt} sh -c' }).run(request('echo "wrapped=$WRAPPED_IN"; echo "pwd=$(pwd)"'));
    expect(res.status).toBe('passed');
    const wt = res.report.log_tail.match(/pwd=(.*)/)![1];
    expect(res.report.log_tail).toContain(`wrapped=${wt}`);
  });

  it('records the process group in state.json while the check runs, and clears it after', async () => {
    const state = path.join(work, 'state.json');
    const r = runner();
    const run = r.run(request('sleep 0.5'));
    expect(await until(() => existsSync(state) && JSON.parse(readFileSync(state, 'utf8')).checks.length === 1)).toBe(true);
    const entry = JSON.parse(readFileSync(state, 'utf8')).checks[0];
    expect(entry).toMatchObject({ landing: 'L-7' });
    expect(alive(entry.pgid)).toBe(true);
    await run;
    expect(JSON.parse(readFileSync(state, 'utf8')).checks).toEqual([]);
  });

  it.runIf(process.platform === 'linux')('kills orphaned check process groups at startup, and only those', async () => {
    const orphanDir = path.join(work, 'runs', 'L-9.1', 'wt');
    mkdirSync(orphanDir, { recursive: true });
    const orphan = spawn('sleep', ['999'], { cwd: orphanDir, detached: true, stdio: 'ignore' });
    const bystander = spawn('sleep', ['999'], { cwd: t.dir, detached: true, stdio: 'ignore' });
    orphan.unref();
    bystander.unref();
    try {
      writeFileSync(
        path.join(work, 'state.json'),
        JSON.stringify({
          checks: [
            { pgid: orphan.pid, landing: 'L-9', attempt: 1, dir: path.join(work, 'runs', 'L-9.1'), at: Date.now() },
            { pgid: bystander.pid, landing: 'L-8', attempt: 1, dir: path.join(work, 'runs', 'L-8.1'), at: Date.now() },
          ],
        }),
      );
      const killed = await runner().killOrphans();
      expect(killed).toEqual([orphan.pid]);
      expect(await until(() => !alive(orphan.pid!))).toBe(true);
      expect(alive(bystander.pid!)).toBe(true);
      expect(JSON.parse(readFileSync(path.join(work, 'state.json'), 'utf8')).checks).toEqual([]);
    } finally {
      try {
        process.kill(-bystander.pid!, 'SIGKILL');
      } catch {}
      try {
        process.kill(-orphan.pid!, 'SIGKILL');
      } catch {}
    }
  });
});

describe('failed_tests parsers (design §2.2.8)', () => {
  const parse = (text: string) => parseFailedTests(text.split('\n'));

  it('vitest: FAIL and × lines, de-duplicated against the full names', () => {
    expect(
      parse(
        [
          ' ✓ test/session.test.ts (3 tests) 4ms',
          ' ❯ test/auth.test.ts (3 tests | 2 failed) 9ms',
          '   × login > trims whitespace 3ms',
          '   × refresh > keeps expiry 1ms',
          '   ✓ logout > clears 0ms',
          ' FAIL  test/auth.test.ts > login > trims whitespace',
          'AssertionError: expected 1 to be 2',
          ' FAIL  test/auth.test.ts > refresh > keeps expiry',
          ' FAIL  test/broken.test.ts [ test/broken.test.ts ]',
          ' Test Files  1 failed | 1 passed (2)',
        ].join('\n'),
      ),
    ).toEqual(['test/auth.test.ts > login > trims whitespace', 'test/auth.test.ts > refresh > keeps expiry', 'test/broken.test.ts']);
  });

  it('jest: FAIL file lines and ✕ tests', () => {
    expect(parse(['FAIL src/auth.test.js (5.123 s)', '  login', '    ✓ works (3 ms)', '    ✕ trims whitespace (5 ms)', 'PASS src/x.test.js'].join('\n'))).toEqual([
      'src/auth.test.js',
      'trims whitespace',
    ]);
  });

  it('node:test: TAP not ok (TODO excluded) and the spec reporter', () => {
    expect(parse(['TAP version 13', '# Subtest: login', 'not ok 1 - login', '  ---', 'ok 2 - logout', 'not ok 3 - later # TODO not yet', '    not ok 1 - nested case'].join('\n'))).toEqual([
      'login',
      'nested case',
    ]);
    expect(parse(['✔ logout (0.5ms)', '✖ login trims (1.2ms)', '✖ failing tests:', '', 'test at test/a.test.mjs:3:1', '✖ login trims (1.2ms)'].join('\n'))).toEqual(['login trims']);
  });

  it('mocha: numbered failures, first title per number', () => {
    expect(
      parse(['  login', '    ✔ works', '    1) trims whitespace', '    2) keeps expiry', '', '  1 passing (5ms)', '  2 failing', '', '  1) login', '       trims whitespace:', '  2) login', '       keeps expiry:'].join('\n')),
    ).toEqual(['trims whitespace', 'keeps expiry']);
  });

  it('pytest, go and cargo', () => {
    expect(parse('FAILED tests/test_auth.py::test_login[case-1] - AssertionError: assert 1 == 2\nFAILED tests/test_auth.py::TestS::test_x\n')).toEqual([
      'tests/test_auth.py::test_login[case-1]',
      'tests/test_auth.py::TestS::test_x',
    ]);
    expect(parse('=== RUN   TestLogin\n--- FAIL: TestLogin (0.00s)\n    --- FAIL: TestLogin/trims (0.00s)\nFAIL\tgithub.com/acme/web/auth\t0.012s\nFAIL\n')).toEqual(['TestLogin', 'TestLogin/trims']);
    expect(parse('running 2 tests\ntest auth::tests::login ... FAILED\ntest auth::tests::logout ... ok\n')).toEqual(['auth::tests::login']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 80 }, (_, i) => `--- FAIL: Test${i} (0.00s)`).join('\n');
    expect(parse(many)).toHaveLength(50);
  });
});
