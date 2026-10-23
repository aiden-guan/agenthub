#!/usr/bin/env node
// R-38 reproduction: a multi-commit cherry-pick (or revert) whose stopped pick
// was resolved and committed with plain `git commit` is still in progress
// (`.git/sequencer/` holds the remaining picks, `git status` says "Cherry-pick
// currently in progress"), but CHERRY_PICK_HEAD / REVERT_HEAD is gone, and
// gitOperation() (packages/adapter/src/git.ts) checks only those markers. So:
//   - syncWorkspace (packages/adapter/src/sync.ts, step 4) does not skip with
//     'git_operation': it replays the branch onto trunk and `reset --keep`s it
//     under the half-done sequence. Afterwards `git cherry-pick --abort` no
//     longer rewinds ("You seem to have moved HEAD") and `--continue` carries
//     on picking onto the rewritten branch.
//   - landWork (packages/adapter/src/land.ts, preflight step 1) does not
//     refuse: it pushes and queues the half-picked HEAD, and the lander lands it.
//
// Design: §2.3.5 step 4 ("rebase/merge/cherry-pick/revert/am/bisect in progress
// → 'skipped: git_operation'"); §2.3.2 land preflight step 1 ("A git operation
// in progress ... → Finish or abort ... first").
//
// No network, no API key: a local bare remote, an in-process hub on
// 127.0.0.1:0 (SqliteStore ':memory:'), the real lander in-process (no
// resolver), and the built adapter's syncWorkspace / landWork / gitOperation.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs     (AGENTHUB_KEEP=1 keeps the temp dir)
//
// Exit 1: the defect is present (a sequencer-only cherry-pick/revert is not
// seen as a git operation by sync or land). Exit 0: it is. Exit 2: harness broke.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const imp = (p) => import(pathToFileURL(path.join(ROOT, 'packages', p)).href);

for (const k of Object.keys(process.env)) if (/^(GIT_|HUB_|ANTHROPIC_|AGENTHUB_SYNC)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  LC_ALL: 'C',
  HUB_CONFIG: '/nonexistent/agenthub/config.json',
  GIT_AUTHOR_NAME: 'Agent Human',
  GIT_AUTHOR_EMAIL: 'agent@example.com',
  GIT_COMMITTER_NAME: 'Agent Human',
  GIT_COMMITTER_EMAIL: 'agent@example.com',
});

const { Hub, SqliteStore, startServer } = await imp('hub/dist/index.js');
const { initWorkdir } = await imp('lander/dist/init.js');
const { openGitPort } = await imp('lander/dist/git-port.js');
const { HubClient: LanderHubClient } = await imp('lander/dist/hub-client.js');
const { Lander } = await imp('lander/dist/lander.js');
const { ChecksRunner } = await imp('lander/dist/checks.js');
const { landerId } = await imp('lander/dist/config.js');
const { syncWorkspace } = await imp('adapter/dist/sync.js');
const { landWork } = await imp('adapter/dist/land.js');
const { gitOperation } = await imp('adapter/dist/git.js');
const { HubClient } = await imp('adapter/dist/client.js');

const P = 'acme/web';
const MAYA = 'maya/claude-1';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };

function git(cwd, args, o = {}) {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', input: '' });
  if (r.error) throw r.error;
  if (r.status !== 0 && !o.ok) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return o.ok ? r : r.stdout.trim();
}
const short = (s) => (s ? s.slice(0, 10) : String(s));
const status3 = (repo) => git(repo, ['status']).split('\n').slice(0, 4).join(' | ');

const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'repro-R-38-')));
const remote = path.join(dir, 'remote.git');
const seed = path.join(dir, 'seed');
const workdir = path.join(dir, 'lander');
const logs = [];
let front = null;
let hub = null;
let lander = null;
let exitCode = 2;
let n = 0;

/** Push a commit straight to trunk from the seed clone (no update hook guards this remote). */
function trunkCommit(file, text) {
  git(seed, ['pull', '-q', '--ff-only', 'origin', 'main']);
  writeFileSync(path.join(seed, file), text);
  git(seed, ['add', file]);
  git(seed, ['commit', '-q', '-m', `trunk: ${file}`]);
  git(seed, ['push', '-q', 'origin', 'main']);
  return git(seed, ['rev-parse', 'HEAD']);
}

/**
 * A fresh agent clone on branch `maya-work` with one own commit (f.txt: mine),
 * and a `side` branch whose first commit conflicts on f.txt and whose next ones
 * are clean. `kind`:
 *   'pick-stopped'   git cherry-pick maya-work..side, stopped on the conflict (CHERRY_PICK_HEAD present)
 *   'pick-committed' the same, conflict resolved and committed with `git commit` (CHERRY_PICK_HEAD gone, sequencer left)
 *   'revert-committed' git revert of three commits, the conflicting one resolved and committed (REVERT_HEAD gone, sequencer left)
 */
function makeAgent(kind) {
  const A = path.join(dir, `maya-${++n}`);
  git(dir, ['clone', '-q', remote, A]);
  git(A, ['checkout', '-q', '-b', 'maya-work']);
  if (kind.startsWith('pick')) {
    git(A, ['checkout', '-q', '-b', 'side']);
    writeFileSync(path.join(A, 'f.txt'), 'side\n');
    git(A, ['commit', '-qam', 'side1: f.txt']);
    writeFileSync(path.join(A, 'g.txt'), 'side2\n');
    git(A, ['add', 'g.txt']);
    git(A, ['commit', '-q', '-m', 'side2: add g.txt']);
    writeFileSync(path.join(A, 'h.txt'), 'side3\n');
    git(A, ['add', 'h.txt']);
    git(A, ['commit', '-q', '-m', 'side3: add h.txt']);
    git(A, ['checkout', '-q', 'maya-work']);
    writeFileSync(path.join(A, 'f.txt'), 'mine\n');
    git(A, ['commit', '-qam', 'maya: f.txt']);
    const before = git(A, ['rev-parse', 'HEAD']);
    const cp = git(A, ['cherry-pick', 'maya-work..side'], { ok: true });
    if (cp.status === 0) throw new Error('setup: the cherry-pick did not stop on the conflict');
    if (kind === 'pick-committed') {
      writeFileSync(path.join(A, 'f.txt'), 'resolved\n');
      git(A, ['add', 'f.txt']);
      git(A, ['commit', '-q', '--no-edit']);
    }
    return { A, before };
  }
  // revert: r1 changes f.txt, r2 adds g.txt, r3 changes f.txt again, r4 adds h.txt; revert r2 r1 r4 (r1 conflicts with r3).
  writeFileSync(path.join(A, 'f.txt'), 'v1\n');
  git(A, ['commit', '-qam', 'r1: f.txt v1']);
  const r1 = git(A, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(A, 'g.txt'), 'g\n');
  git(A, ['add', 'g.txt']);
  git(A, ['commit', '-q', '-m', 'r2: add g.txt']);
  const r2 = git(A, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(A, 'f.txt'), 'v2\n');
  git(A, ['commit', '-qam', 'r3: f.txt v2']);
  writeFileSync(path.join(A, 'h.txt'), 'h\n');
  git(A, ['add', 'h.txt']);
  git(A, ['commit', '-q', '-m', 'r4: add h.txt']);
  const r4 = git(A, ['rev-parse', 'HEAD']);
  const before = r4;
  const rv = git(A, ['revert', '--no-edit', r2, r1, r4], { ok: true });
  if (rv.status === 0) throw new Error('setup: the revert sequence did not stop on the conflict');
  writeFileSync(path.join(A, 'f.txt'), 'resolved\n');
  git(A, ['add', 'f.txt']);
  git(A, ['commit', '-q', '--no-edit']);
  return { A, before };
}

/** What git itself says about the worktree's git dir. */
function gitState(A) {
  const g = path.join(A, '.git');
  return {
    cherryPickHead: existsSync(path.join(g, 'CHERRY_PICK_HEAD')),
    revertHead: existsSync(path.join(g, 'REVERT_HEAD')),
    sequencer: existsSync(path.join(g, 'sequencer')),
    todo: existsSync(path.join(g, 'sequencer', 'todo')) ? readFileSync(path.join(g, 'sequencer', 'todo'), 'utf8').trim().split('\n').length : 0,
    inProgress: /(Cherry-pick|Revert) currently in progress|You are currently (cherry-picking|reverting)/.test(git(A, ['status'])),
  };
}

const cfgFor = (A) => ({ url: front.url, agent: MAYA, project: P, token: null, failClosed: false, timeoutMs: 10_000, root: A, configFiles: [], projectSource: 'file', warnings: [] });
const outcomeText = (s) => `${s.kind}${s.kind === 'skipped' ? ` (${s.reason}: ${s.detail})` : ''}${s.kind === 'synced' ? ` from ${short(s.from)} to ${short(s.to)}, replayed ${s.replayed}` : ''}`;

try {
  // ---- the project: a bare remote whose trunk has agenthub.json with a land section
  git(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  git(dir, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  writeFileSync(path.join(seed, 'f.txt'), 'base\n');
  writeFileSync(path.join(seed, 'check.mjs'), "console.log('ok');\n");
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: P, land: { check: 'node check.mjs', resolver: { enabled: false } } }, null, 2)}\n`);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-q', 'origin', 'main']);

  // ---- hub (in-process HTTP on port 0) and the real lander
  hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
  await initWorkdir({ dir: workdir, remote });
  lander = new Lander({
    hub: new LanderHubClient({ url: front.url, project: P, agent: landerId('lander/repro'), landerToken: null }),
    git: openGitPort({ mirror: path.join(workdir, 'mirror.git'), remote: 'origin', env: { PATH: process.env.PATH } }),
    checks: new ChecksRunner({ workdir, mirror: path.join(workdir, 'mirror.git'), env: { ...process.env }, killGraceMs: 2_000 }),
    resolver: null,
    log: (line) => logs.push(line),
    agent: landerId('lander/repro'),
    project: P,
    committer: LANDER,
    drivers: [],
    trunk: 'main',
    leaseTtlMs: 10_000,
    timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
    workdir,
    host: 'repro',
  });

  const defects = [];

  // ---- 0. control: the sequence stopped on its conflict (CHERRY_PICK_HEAD present) is seen
  {
    const { A } = makeAgent('pick-stopped');
    trunkCommit('t0.txt', 't0\n');
    const st = gitState(A);
    const op = gitOperation(A);
    const s = await syncWorkspace(A, cfgFor(A), new HubClient(cfgFor(A)), { reason: 'explicit' });
    console.log(`[0 control: cherry-pick stopped on its conflict] CHERRY_PICK_HEAD=${st.cherryPickHead} sequencer=${st.sequencer} status-in-progress=${st.inProgress}`);
    const cfg = cfgFor(A);
    const l = await landWork({ cfg, client: new HubClient(cfg), feed: null }, { summary: 'control' });
    console.log(`    gitOperation=${JSON.stringify(op)}  sync=${outcomeText(s)}`);
    console.log(`    land: error=${l.error} ${JSON.stringify(l.text.split('\n')[0])}`);
    if (op !== 'cherry-pick' || s.kind !== 'skipped' || s.reason !== 'git_operation' || !l.error || !/in progress/.test(l.text)) {
      throw new Error('control: the CHERRY_PICK_HEAD case is not seen; the harness does not reach the check');
    }
  }

  // ---- 1a. baseline (no sync): what `git cherry-pick --abort` does in this state on its own
  let abortRewindsWithoutSync;
  {
    const { A } = makeAgent('pick-committed');
    const seqHead = readFileSync(path.join(A, '.git', 'sequencer', 'head'), 'utf8').trim();
    const ab = git(A, ['cherry-pick', '--abort'], { ok: true });
    abortRewindsWithoutSync = git(A, ['rev-parse', 'HEAD']) === seqHead;
    console.log(`\n[1a baseline, no sync: \`git cherry-pick --abort\` after the \`git commit\`] exit ${ab.status}, ${JSON.stringify(ab.stderr.trim())}; rewinds to the start: ${abortRewindsWithoutSync}`);
  }

  // ---- 1. sync under a resolved-and-committed multi-commit cherry-pick, then `git cherry-pick --abort`
  {
    const { A, before } = makeAgent('pick-committed');
    const T = trunkCommit('t1.txt', 't1\n');
    const st = gitState(A);
    const headBefore = git(A, ['rev-parse', 'HEAD']);
    const seqHead = readFileSync(path.join(A, '.git', 'sequencer', 'head'), 'utf8').trim();
    console.log(`\n[1 sync mid \`git cherry-pick maya-work..side\`, conflict resolved with \`git commit\`]`);
    console.log(`    CHERRY_PICK_HEAD=${st.cherryPickHead} sequencer=${st.sequencer} (todo lines: ${st.todo}) git status: ${status3(A)}`);
    const op = gitOperation(A);
    const s = await syncWorkspace(A, cfgFor(A), new HubClient(cfgFor(A)), { reason: 'explicit' });
    const headAfter = git(A, ['rev-parse', 'HEAD']);
    console.log(`    gitOperation=${JSON.stringify(op)}  sync=${outcomeText(s)}`);
    console.log(`    HEAD ${short(headBefore)} -> ${short(headAfter)}; trunk tip ${short(T)} is ${git(A, ['merge-base', '--is-ancestor', T, 'HEAD'], { ok: true }).status === 0 ? 'now in' : 'not in'} HEAD; sequencer still there: ${existsSync(path.join(A, '.git', 'sequencer'))}`);
    if (st.inProgress && st.sequencer && !(s.kind === 'skipped' && s.reason === 'git_operation')) {
      defects.push(`sync returned '${s.kind}' (expected 'skipped: git_operation') while git status says the cherry-pick is in progress; HEAD moved ${short(headBefore)} -> ${short(headAfter)}`);
    }
    const ab = git(A, ['cherry-pick', '--abort'], { ok: true });
    const headAbort = git(A, ['rev-parse', 'HEAD']);
    console.log(`    then \`git cherry-pick --abort\`: exit ${ab.status}, ${JSON.stringify(ab.stderr.trim())}; HEAD=${short(headAbort)} (the pick started at ${short(seqHead)}${seqHead === before ? '' : '?'})`);
    // Only a consequence of the sync if --abort would have rewound without it (git 2.43 already refuses after a manual `git commit`).
    if (s.kind === 'synced' && headAbort !== seqHead) {
      if (abortRewindsWithoutSync) defects.push(`after that sync, \`git cherry-pick --abort\` no longer rewinds to where the pick started (${short(seqHead)}); HEAD stays ${short(headAbort)}`);
      else console.log('    (note: --abort does not rewind here even without a sync, so this is not a consequence of the sync)');
    }
  }

  // ---- 2. the same, then `git cherry-pick --continue`
  {
    const { A } = makeAgent('pick-committed');
    trunkCommit('t2.txt', 't2\n');
    const st = gitState(A);
    const s = await syncWorkspace(A, cfgFor(A), new HubClient(cfgFor(A)), { reason: 'explicit' });
    console.log(`\n[2 the same sync, then \`git cherry-pick --continue\`] sequencer=${st.sequencer} CHERRY_PICK_HEAD=${st.cherryPickHead}  sync=${outcomeText(s)}`);
    const co = git(A, ['cherry-pick', '--continue'], { ok: true });
    console.log(`    --continue: exit ${co.status}; log:\n      ${git(A, ['log', '--format=%h %s', '-6']).split('\n').join('\n      ')}`);
    if (st.sequencer && s.kind === 'synced' && co.status === 0) console.log('    (observation: --continue resumed the remaining picks on top of the branch sync rewrote underneath the sequence)');
  }

  // ---- 3. revert sequence: REVERT_HEAD gone after `git commit`, sequencer left
  {
    const { A } = makeAgent('revert-committed');
    trunkCommit('t3.txt', 't3\n');
    const st = gitState(A);
    const headBefore = git(A, ['rev-parse', 'HEAD']);
    const op = gitOperation(A);
    const s = await syncWorkspace(A, cfgFor(A), new HubClient(cfgFor(A)), { reason: 'explicit' });
    console.log(`\n[3 sync mid \`git revert r2 r1 r4\`, conflict resolved with \`git commit\`]`);
    console.log(`    REVERT_HEAD=${st.revertHead} sequencer=${st.sequencer} (todo lines: ${st.todo}) git status: ${status3(A)}`);
    console.log(`    gitOperation=${JSON.stringify(op)}  sync=${outcomeText(s)}; HEAD ${short(headBefore)} -> ${short(git(A, ['rev-parse', 'HEAD']))}`);
    if (st.inProgress && st.sequencer && !(s.kind === 'skipped' && s.reason === 'git_operation')) defects.push(`sync returned '${s.kind}' (expected 'skipped: git_operation') mid revert sequence`);
  }

  // ---- 4. land mid sequence: preflight step 1 should refuse; instead the half-picked HEAD is queued and landed
  {
    const { A } = makeAgent('pick-committed');
    const st = gitState(A);
    const head = git(A, ['rev-parse', 'HEAD']);
    const cfg = cfgFor(A);
    const l = await landWork({ cfg, client: new HubClient(cfg), feed: null }, { summary: 'maya: f.txt + picks' });
    console.log(`\n[4 land mid \`git cherry-pick maya-work..side\` (sequencer=${st.sequencer}, CHERRY_PICK_HEAD=${st.cherryPickHead}, status-in-progress=${st.inProgress})]`);
    console.log(`    land: error=${l.error} ${JSON.stringify(l.text.split('\n')[0])}`);
    const refusedForOp = l.error && /in progress/.test(l.text);
    if (st.sequencer && st.inProgress && !refusedForOp) {
      let landedText = '';
      if (l.landing) {
        logs.length = 0;
        await lander.run({ once: true });
        const got = hub.getLanding(P, l.landing.id);
        const T = git(remote, ['rev-parse', 'main']);
        const files = git(remote, ['ls-tree', '--name-only', T]).split('\n');
        landedText = `; lander: ${got.id} ${got.status}; trunk has g.txt=${files.includes('g.txt')} h.txt=${files.includes('h.txt')} (side2/side3 still in the sequencer's todo)`;
        console.log(`    lander: ${got.id} status=${got.status}; trunk ${short(T)} files: ${files.join(', ')}`);
      }
      defects.push(`land queued HEAD ${short(head)} mid cherry-pick sequence instead of refusing with "Finish or abort the cherry-pick in progress first"${landedText}`);
    }
  }

  if (defects.length) {
    console.log(`\nDEFECT R-38:\n  - ${defects.join('\n  - ')}`);
    exitCode = 1;
  } else {
    console.log('\nPASS: a cherry-pick/revert sequence in progress (sequencer only) is a git operation for sync and land.');
    exitCode = 0;
  }
} catch (err) {
  console.error('harness error:', err?.stack ?? err);
  console.error(logs.join('\n'));
  exitCode = 2;
} finally {
  try {
    lander?.stop?.();
  } catch {}
  await front?.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  try {
    hub?.store?.close?.();
  } catch {}
  if (process.env.AGENTHUB_KEEP === '1') console.log(`(kept ${dir})`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
