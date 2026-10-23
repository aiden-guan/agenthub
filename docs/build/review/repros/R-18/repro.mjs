#!/usr/bin/env node
// R-18 reproduction: a landing whose only change is a submodule (gitlink) bump
// that conflicts with a bump already on trunk must fail as {conflict} naming
// the submodule path (design §2.2.6 step 4, §4.5). On phase23 the lander's
// merge-tree parser throws on git's free-form submodule advice block, so the
// landing fails as {lander_error} ("not caused by your change"), on every
// re-land; three of those in a row also pause the whole queue.
//
// No network, no API key: local bare remote, in-process hub on port 0, the real
// lander (HubClient over HTTP, real GitPort, real ChecksRunner), no resolver.
//
// Exit 0: no defect (every attempt fails {conflict} naming vendor/lib).
// Exit 1: defect present. Exit 2: the harness itself broke.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const imp = (p) => import(pathToFileURL(path.join(ROOT, 'packages', p)).href);

const { parseMergeTree } = await imp('gitops/dist/index.js');
const { Hub, SqliteStore, startServer } = await imp('hub/dist/index.js');
const { initWorkdir } = await imp('lander/dist/init.js');
const { openGitPort } = await imp('lander/dist/git-port.js');
const { HubClient } = await imp('lander/dist/hub-client.js');
const { Lander } = await imp('lander/dist/lander.js');
const { ChecksRunner } = await imp('lander/dist/checks.js');
const { landerId } = await imp('lander/dist/config.js');

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE = Date.UTC(2026, 0, 1) / 1000;
let tick = 0;

function env(extra = {}) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_')) e[k] = v;
  const t = `${BASE + 60 * ++tick} +0000`;
  return { ...e, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', GIT_AUTHOR_NAME: 'Agent Human', GIT_AUTHOR_EMAIL: 'agent@example.com', GIT_COMMITTER_NAME: 'Agent Human', GIT_COMMITTER_EMAIL: 'agent@example.com', GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t, ...extra };
}
function sh(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, env: env(), encoding: 'utf8', input: input ?? '' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}
function rawGit(cwd, args) {
  return spawnSync('git', args, { cwd, env: env(), encoding: 'utf8' });
}

const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'repro-R-18-')));
const remote = path.join(dir, 'remote.git');
const workdir = path.join(dir, 'lander');
const logs = [];
let front = null;
let hub = null;
let lander = null;
let exitCode = 2;

try {
  // ---- the submodule's own repository (never pushed to the project remote: the mirror never has its commits)
  const lib = path.join(dir, 'lib');
  mkdirSync(lib);
  sh(lib, ['init', '-q', '-b', 'main']);
  const libCommit = (msg) => (sh(lib, ['commit', '-q', '--allow-empty', '-m', msg]), sh(lib, ['rev-parse', 'HEAD']));
  const X1 = libCommit('lib v1');
  const X2 = libCommit('lib v2');
  const X3 = libCommit('lib v3');

  // ---- the project remote, seeded with agenthub.json and vendor/lib at X1
  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  const seed = path.join(dir, 'seed');
  mkdirSync(seed);
  sh(seed, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  writeFileSync(path.join(seed, 'check.mjs'), "console.log('ok');\n");
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: P, land: { check: 'node check.mjs', resolver: { enabled: false } } }, null, 2)}\n`);
  writeFileSync(path.join(seed, '.gitmodules'), '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ../lib\n');
  sh(seed, ['add', 'README.md', 'check.mjs', 'agenthub.json', '.gitmodules']);
  sh(seed, ['update-index', '--add', '--cacheinfo', `160000,${X1},vendor/lib`]);
  sh(seed, ['commit', '-q', '-m', 'seed']);
  sh(seed, ['remote', 'add', 'origin', remote]);
  sh(seed, ['push', '-q', 'origin', 'main']);
  const T1 = sh(remote, ['rev-parse', 'main']);

  // ---- hub (in-process, HTTP on port 0) and the real lander
  hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const log = (line) => logs.push(line);
  lander = new Lander({
    hub: new HubClient({ url: front.url, project: P, agent: landerId('lander/repro'), landerToken: null }),
    git: openGitPort({ mirror, remote: 'origin', env: { PATH: process.env.PATH } }),
    checks: new ChecksRunner({ workdir, mirror, env: { ...process.env }, killGraceMs: 2_000 }),
    resolver: null,
    log,
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

  // ---- two agents clone the same base
  const clone = (name) => {
    const d = path.join(dir, `clone-${name}`);
    sh(dir, ['clone', '-q', remote, d]);
    return d;
  };
  const bump = (d, sha, msg) => {
    sh(d, ['update-index', '--cacheinfo', `160000,${sha},vendor/lib`]);
    sh(d, ['commit', '-q', '-m', msg]);
    return sh(d, ['rev-parse', 'HEAD']);
  };
  const land = (d, agent, H) => {
    sh(d, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
    sh(d, ['fetch', '-q', 'origin', 'main']);
    const files = sh(d, ['diff', '--name-only', `origin/main...${H}`]).split('\n').filter(Boolean);
    return hub.land(P, agent, { queue: true, commit: H, files, summary: 'bump vendor/lib' }).landing;
  };
  const A = clone('a');
  const B = clone('b');
  const HA = bump(A, X2, 'bump vendor/lib to v2');
  const HB = bump(B, X3, 'bump vendor/lib to v3');

  // ---- agent A lands its bump (vendor/lib -> X2)
  const LA = land(A, 'maya/claude-1', HA);
  await lander.run({ once: true });
  const la = hub.getLanding(P, LA.id);
  console.log(`[setup] ${LA.id} (A: vendor/lib -> ${X2.slice(0, 8)}): status=${la.status} trunk=${la.trunk_sha?.slice(0, 12)}`);
  if (la.status !== 'landed') throw new Error(`setup: A's landing did not land: ${JSON.stringify(la.failure)} ${logs.join('\n')}`);
  const T2 = sh(remote, ['rev-parse', 'main']);
  if (sh(remote, ['rev-parse', `${T2}:vendor/lib`]) !== X2) throw new Error('setup: trunk does not have vendor/lib at X2');

  // ---- what git itself prints for this merge (trunk T2 vs B's HB, base T1), and what parseMergeTree does with it
  sh(B, ['push', '-q', 'origin', `${HB}:refs/agenthub/land/${HB}`]);
  const raw = rawGit(remote, ['merge-tree', '--write-tree', '-z', '--messages', `--merge-base=${T1}`, T2, HB]);
  const advice = raw.stdout.indexOf('Recursive merging with submodules');
  console.log(`[git ${sh(dir, ['version'])}] merge-tree exit ${raw.status}; free-form block after the NUL-structured messages: ${advice >= 0 ? JSON.stringify(raw.stdout.slice(advice, advice + 140)) : 'none'}`);
  let parseErr = null;
  try {
    parseMergeTree(raw.stdout);
  } catch (e) {
    parseErr = e.message.split('\n')[0];
  }
  console.log(`[gitops] parseMergeTree: ${parseErr ? `THROWS ${parseErr}` : 'parsed'}`);

  // ---- agent B lands its divergent bump (vendor/lib -> X3), then re-lands twice as the send-back tells it to
  const results = [];
  for (let i = 1; i <= 3; i++) {
    const L = land(B, 'ravi/claude-2', HB);
    logs.length = 0;
    await lander.run({ once: true });
    const l = hub.getLanding(P, L.id);
    const files = (l.report?.conflicts ?? []).map((c) => c.file);
    const errLine = logs.find((x) => x.includes('lander error')) ?? null;
    results.push({ id: L.id, status: l.status, code: l.failure?.code ?? null, conflicts: files, message: l.report?.message ?? null, errLine });
    console.log(`[B attempt ${i}] ${L.id}: status=${l.status} code=${l.failure?.code ?? '-'} conflicts=${JSON.stringify(files)}`);
    console.log(`    report.message: ${l.report?.message ?? '-'}`);
    console.log(`    next_steps: ${JSON.stringify(l.report?.next_steps ?? [])}`);
    if (errLine) console.log(`    lander log: ${errLine.split('\n')[0].slice(0, 220)}`);
  }
  const control = hub.landerStatus(P).control;
  console.log(`[queue] after 3 attempts: paused=${JSON.stringify(control.paused ?? null)}`);
  console.log(`[trunk] main still at ${sh(remote, ['rev-parse', 'main']).slice(0, 12)} (A's landing ${T2.slice(0, 12)})`);

  const correct = results.every((r) => r.status === 'failed' && r.code === 'conflict' && r.conflicts.includes('vendor/lib'));
  const landerErrors = results.filter((r) => r.code === 'lander_error').length;
  if (correct && !control.paused) {
    console.log('\nPASS: every attempt failed {conflict} naming vendor/lib; the queue is not paused.');
    exitCode = 0;
  } else {
    console.log(`\nDEFECT R-18: a divergent submodule bump fails as ${results.map((r) => r.code).join(', ')} (expected conflict naming vendor/lib on every attempt)` + (landerErrors ? `; ${landerErrors}/3 attempts were lander_error ("not caused by your change")` : '') + (control.paused ? `; the whole landing queue is now paused (${control.paused.reason})` : '') + '.');
    exitCode = 1;
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
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
