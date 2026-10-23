#!/usr/bin/env node
// R-19 reproduction: the workspace sync moves a submodule gitlink with
// `git reset --keep` (no --recurse-submodules) and leaves an initialized
// submodule checked out at the old commit. The 'synced' worktree then shows a
// tracked change (` M sub`) the agent never made; land's preflight refuses
// with "Commit first ... `git add -A && git commit`"; following that advice
// records the OLD submodule commit, and the lander lands it cleanly: a silent
// revert of the submodule bump another agent landed.
//
// Design: §2.3.5 (a synced worktree is at the target, "safe by construction"),
// §2.3.2 (land preflight refusal), §4.1 #18 (submodules).
//
// No network, no API key: a local bare remote, a local bare submodule repo, an
// in-process hub on port 0 (SqliteStore ':memory:'), the real lander (HTTP
// HubClient, real GitPort, real ChecksRunner, no resolver), and the built
// adapter's syncWorkspace / landWork, the engines behind the settle hook,
// hub_sync and the land tool.
//
// Exit 0: no defect. Exit 1: defect present. Exit 2: the harness itself broke.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs        (AGENTHUB_KEEP=1 keeps the temp dir)

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const imp = (p) => import(pathToFileURL(path.join(ROOT, 'packages', p)).href);

// A clean git environment for everything, including the adapter's own git calls (gitops.open isolated:false uses process.env).
for (const k of Object.keys(process.env)) if (/^(GIT_|HUB_|ANTHROPIC_|AGENTHUB_SYNC)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
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
const { HubClient } = await imp('adapter/dist/client.js');
const { syncPromptText } = await imp('adapter/dist/format.js');

const P = 'acme/web';
const MAYA = 'maya/claude-1';
const SAM = 'sam/claude-1';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };

function git(cwd, args, o = {}) {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', input: '' });
  if (r.error) throw r.error;
  if (r.status !== 0 && !o.ok) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return o.ok ? r : r.stdout.trim();
}
const short = (s) => (s ? s.slice(0, 10) : String(s));

const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'repro-R-19-')));
const remote = path.join(dir, 'remote.git');
const workdir = path.join(dir, 'lander');
const logs = [];
let front = null;
let hub = null;
let lander = null;
let exitCode = 2;

try {
  // ---- the submodule's repository: a bare lib.git whose main is X2 (its parent X1)
  const libw = path.join(dir, 'libw');
  const lib = path.join(dir, 'lib.git');
  git(dir, ['init', '-q', '-b', 'main', libw]);
  writeFileSync(path.join(libw, 'l.txt'), 'v1\n');
  git(libw, ['add', '-A']);
  git(libw, ['commit', '-q', '-m', 'lib v1']);
  const X1 = git(libw, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(libw, 'l.txt'), 'v2\n');
  git(libw, ['commit', '-qam', 'lib v2']);
  const X2 = git(libw, ['rev-parse', 'HEAD']);
  git(dir, ['clone', '-q', '--bare', libw, lib]);

  // ---- the project remote: agenthub.json with a land section, and submodule `sub` at X1
  git(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  git(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  const seed = path.join(dir, 'seed');
  git(dir, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  writeFileSync(path.join(seed, 'check.mjs'), "console.log('ok');\n");
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: P, land: { check: 'node check.mjs', resolver: { enabled: false } } }, null, 2)}\n`);
  writeFileSync(path.join(seed, '.gitmodules'), `[submodule "sub"]\n\tpath = sub\n\turl = ${lib}\n`);
  git(seed, ['add', 'README.md', 'check.mjs', 'agenthub.json', '.gitmodules']);
  git(seed, ['update-index', '--add', '--cacheinfo', `160000,${X1},sub`]);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-q', 'origin', 'main']);

  // ---- hub (in-process, HTTP on port 0) and the real lander
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
  const runLander = async () => {
    logs.length = 0;
    await lander.run({ once: true });
  };

  // ---- agent maya: on a branch, submodule initialized (sub at X1), one committed change of her own; worktree clean
  const A = path.join(dir, 'maya');
  git(dir, ['clone', '-q', remote, A]);
  git(A, ['checkout', '-q', '-b', 'maya-work']);
  git(A, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init']);
  writeFileSync(path.join(A, 'mine.txt'), 'maya\n');
  git(A, ['add', 'mine.txt']);
  git(A, ['commit', '-q', '-m', 'maya: add mine.txt']);
  if (git(A, ['status', '--porcelain=v1']) !== '') throw new Error('setup: maya worktree not clean');
  if (git(path.join(A, 'sub'), ['rev-parse', 'HEAD']) !== X1) throw new Error('setup: sub not at X1');
  const cfgA = { url: front.url, agent: MAYA, project: P, token: null, failClosed: false, timeoutMs: 10_000, root: A, configFiles: [], projectSource: 'file', warnings: [] };
  const clientA = new HubClient(cfgA);

  // ---- agent sam bumps sub to X2 and lands it through the queue
  const B = path.join(dir, 'sam');
  git(dir, ['clone', '-q', remote, B]);
  git(B, ['update-index', '--cacheinfo', `160000,${X2},sub`]);
  git(B, ['commit', '-q', '-m', 'sam: bump sub to v2']);
  const HB = git(B, ['rev-parse', 'HEAD']);
  git(B, ['push', '-q', 'origin', `${HB}:refs/agenthub/land/${HB}`]);
  const LB = hub.land(P, SAM, { queue: true, commit: HB, files: ['sub'], summary: 'bump sub to v2' }).landing;
  await runLander();
  const lb = hub.getLanding(P, LB.id);
  if (lb.status !== 'landed') throw new Error(`setup: sam's bump did not land: ${lb.status} ${JSON.stringify(lb.failure)}\n${logs.join('\n')}`);
  const T2 = git(remote, ['rev-parse', 'main']);
  if (git(remote, ['rev-parse', `${T2}:sub`]) !== X2) throw new Error('setup: trunk sub is not X2');
  console.log(`[setup] sub: X1=${short(X1)} X2=${short(X2)}; maya has sub initialized at X1 and a clean worktree`);
  console.log(`[setup] ${LB.id} (sam: bump sub to X2) landed; trunk main=${short(T2)} has sub=${short(X2)}`);

  // ---- 1. maya's next prompt: the settle hook's sync
  const s1 = await syncWorkspace(A, cfgA, clientA, { reason: 'prompt' });
  const st1 = git(A, ['status', '--porcelain=v1']);
  const subHead = git(path.join(A, 'sub'), ['rev-parse', 'HEAD']);
  const idxLink = git(A, ['rev-parse', ':sub']);
  console.log(`\n[1 sync at prompt] outcome=${s1.kind}${s1.kind === 'skipped' ? ` (${s1.reason}: ${s1.detail})` : ''} files=${JSON.stringify(s1.files ?? null)}`);
  console.log(`    what the agent is told: ${JSON.stringify(syncPromptText(s1))}`);
  console.log(`    git status after it: ${JSON.stringify(st1)}`);
  console.log(`    sub checked out at ${short(subHead)} (${subHead === X1 ? 'X1, old' : subHead === X2 ? 'X2, new' : '?'}); index gitlink ${short(idxLink)} (${idxLink === X1 ? 'X1' : idxLink === X2 ? 'X2' : '?'})`);
  const syncedDirty = s1.kind === 'synced' && st1 !== '';

  // ---- 2. trunk moves again (an unrelated landing): what the next sync says
  const B2 = path.join(dir, 'sam2');
  git(dir, ['clone', '-q', remote, B2]);
  writeFileSync(path.join(B2, 'other.txt'), 'other\n');
  git(B2, ['add', 'other.txt']);
  git(B2, ['commit', '-q', '-m', 'sam: other.txt']);
  const HB2 = git(B2, ['rev-parse', 'HEAD']);
  git(B2, ['push', '-q', 'origin', `${HB2}:refs/agenthub/land/${HB2}`]);
  const LB2 = hub.land(P, SAM, { queue: true, commit: HB2, files: ['other.txt'], summary: 'other' }).landing;
  await runLander();
  if (hub.getLanding(P, LB2.id).status !== 'landed') throw new Error(`setup: sam's second landing did not land\n${logs.join('\n')}`);
  const s2 = await syncWorkspace(A, cfgA, clientA, { reason: 'prompt' });
  console.log(`\n[2 next sync, after ${LB2.id} landed] outcome=${s2.kind} uncommitted=${JSON.stringify(s2.uncommitted ?? null)}`);
  console.log(`    what the agent is told: ${JSON.stringify(syncPromptText(s2))}`);

  // ---- 3. maya lands
  const deps = { cfg: cfgA, client: clientA, feed: null };
  const l1 = await landWork(deps, {});
  console.log(`\n[3 land] error=${l1.error}\n    ${l1.text.split('\n').join('\n    ')}`);
  const advisesAddAll = l1.error && /git add -A && git commit/.test(l1.text);

  // ---- 4. maya follows the advice literally
  let followed = false;
  if (advisesAddAll) {
    git(A, ['add', '-A']);
    git(A, ['commit', '-q', '-m', 'commit as land asked']);
    followed = true;
    const shown = git(A, ['show', '--format=', '--submodule=short', 'HEAD']);
    console.log(`\n[4 \`git add -A && git commit\` as advised] the commit records:\n    ${shown.split('\n').join('\n    ')}`);
  } else {
    console.log('\n[4] land did not advise `git add -A && git commit`; not committing');
  }

  // ---- 5. land again, and let the lander run
  let landed = null;
  const l2 = await landWork(deps, {});
  console.log(`\n[5 land again] error=${l2.error}: ${l2.text.split('\n')[0]}`);
  if (!l2.error && l2.landing) {
    await runLander();
    landed = hub.getLanding(P, l2.landing.id);
    console.log(`    lander: ${landed.id} status=${landed.status}${landed.failure ? ` failure=${JSON.stringify(landed.failure)}` : ''}`);
  }
  const T = git(remote, ['rev-parse', 'main']);
  const trunkSub = git(remote, ['rev-parse', `${T}:sub`]);
  const reverted = trunkSub === X1;
  console.log(`\n[trunk] main=${short(T)} sub=${short(trunkSub)} (${reverted ? 'X1: sam\'s bump to X2 is REVERTED' : trunkSub === X2 ? 'X2: bump intact' : '?'})`);
  if (reverted) {
    console.log(`    trunk log for sub:\n    ${git(remote, ['log', '--format=%h %an: %s', 'main', '--', 'sub']).split('\n').join('\n    ')}`);
  }

  const defects = [];
  if (syncedDirty) defects.push(`sync reported 'synced' but left the worktree dirty (${JSON.stringify(st1)}): the gitlink moved to X2 while the initialized submodule stayed at X1`);
  if (s2.kind === 'behind_dirty' && (s2.uncommitted ?? []).some((u) => /\bsub$/.test(u))) defects.push(`a later sync calls the stale submodule "your uncommitted changes" (behind_dirty)`);
  if (advisesAddAll && /\bsub\b/.test(l1.text)) defects.push(`land refused, listing sub as uncommitted, and told the agent to \`git add -A && git commit\``);
  if (reverted) defects.push(`following that advice landed sub=X1 on trunk (${landed?.id ?? 'landing'} ${landed?.status ?? ''}): a silent revert of ${LB.id}'s submodule bump`);
  if (defects.length && (syncedDirty || reverted)) {
    console.log(`\nDEFECT R-19:\n  - ${defects.join('\n  - ')}`);
    exitCode = 1;
  } else {
    console.log(`\nPASS: sync left no phantom submodule change (outcome ${s1.kind}, status ${JSON.stringify(st1)}), and trunk keeps sub=X2${followed ? '' : ''}.`);
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
