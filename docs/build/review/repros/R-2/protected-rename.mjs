#!/usr/bin/env node
// R-2 reproduction: an agent's change to an unprotected file lands, with no
// human approval, inside a protected file that trunk renamed it into
// (git merge-tree follows renames; the lander's protected/merged requirements
// only look at the agent's own diff, diffNames(base, H)).
//
// Uses the BUILT packages under ${AGENTHUB_ROOT}/packages/*/dist (default
// /home/user/agenthub). Real hub (in-process, served by startServer on
// 127.0.0.1:0), real bare remote, real lander (HubClient, GitPort,
// ChecksRunner) run with run({once:true}). No network, no API key, no AI
// resolver call (the merge is clean; the resolver is off).
//
// Exit 1: defect present (landed, approvals=[], protected file on trunk holds
// the agent's unapproved line). Exit 0: the lander asked for approval or did
// not land the change. Exit 2: the rig itself broke.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const dist = (pkg, file) => pathToFileURL(path.join(ROOT, 'packages', pkg, 'dist', file)).href;

const { Hub, SqliteStore, startServer } = await import(dist('hub', 'index.js'));
const { ChecksRunner } = await import(dist('lander', 'checks.js'));
const { landerId } = await import(dist('lander', 'config.js'));
const { detectDrivers } = await import(dist('lander', 'drivers.js'));
const { openGitPort } = await import(dist('lander', 'git-port.js'));
const { HubClient } = await import(dist('lander', 'hub-client.js'));
const { initWorkdir } = await import(dist('lander', 'init.js'));
const { Lander } = await import(dist('lander', 'lander.js'));

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const VERBOSE = process.env.VERBOSE === '1';

function testEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_')) env[k] = v;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Seed',
    GIT_AUTHOR_EMAIL: 'seed@example.com',
    GIT_AUTHOR_DATE: `${BASE_TIME} +0000`,
    GIT_COMMITTER_NAME: LANDER.name,
    GIT_COMMITTER_EMAIL: LANDER.email,
    GIT_COMMITTER_DATE: `${BASE_TIME} +0000`,
  });
  Object.assign(env, extra);
  return env;
}

function sh(cwd, args, extra = {}) {
  const r = spawnSync('git', args, { cwd, env: testEnv(extra), encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

let tick = 0;
function commit(dir, who, message, files) {
  for (const [file, content] of Object.entries(files)) {
    const p = path.join(dir, file);
    if (content === null) rmSync(p, { force: true });
    else {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }
  const t = `${BASE_TIME + 3600 + 60 * ++tick} +0000`;
  const env = { GIT_AUTHOR_NAME: `${who} agent`, GIT_AUTHOR_EMAIL: `${who}@example.com`, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t, GIT_COMMITTER_NAME: `${who} agent`, GIT_COMMITTER_EMAIL: `${who}@example.com` };
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', message], env);
  return sh(dir, ['rev-parse', 'HEAD']).trim();
}

// Only the lander's committer identity may move trunk (as in the lander's integration rig).
const HOOK = `#!/bin/sh
ref="$1"; new="$3"
case "$ref" in
  refs/heads/main)
    who=$(git log -1 --format='%cn <%ce>' "$new")
    if [ "$who" != "${LANDER.name} <${LANDER.email}>" ]; then echo "only the lander may update main (committer: $who)" >&2; exit 1; fi;;
esac
exit 0
`;

const CHECK = `import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\\0').filter(Boolean);
console.log('checked ' + files.length + ' files: ok');
`;

const LEGACY = Array.from({ length: 40 }, (_, i) => `-- line ${i + 1}`).join('\n') + '\n';
const EVIL = 'drop table users;';

const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'repro-R-2-')));
const remote = path.join(dir, 'remote.git');
const workdir = path.join(dir, 'lander');
const logs = [];
let front = null;
let hub = null;
let exitCode = 2;

try {
  // ---- the remote, seeded: migrations/** protected, db/legacy.sql unprotected
  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  const seed = path.join(dir, 'seed');
  mkdirSync(seed);
  sh(seed, ['init', '-q', '-b', 'main']);
  const agenthubJson = `${JSON.stringify({ project: P, land: { check: 'node check.mjs', protected: ['migrations/**'], resolver: { enabled: false } } }, null, 2)}\n`;
  commit(seed, 'seed', 'seed', {
    'README.md': '# demo\n',
    'migrations/001.sql': 'create table users (id int);\n',
    'db/legacy.sql': LEGACY,
    'check.mjs': CHECK,
    'agenthub.json': agenthubJson,
  });
  sh(seed, ['remote', 'add', 'origin', remote]);
  sh(seed, ['push', '-q', 'origin', 'main']);
  writeFileSync(path.join(remote, 'hooks', 'update'), HOOK);
  chmodSync(path.join(remote, 'hooks', 'update'), 0o755);

  // ---- the hub (in-process, real HTTP server on loopback, port 0) and the lander
  hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const env = { ...testEnv(), PATH: process.env.PATH ?? '' };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  const agent = landerId('lander/repro');
  const log = (line) => {
    logs.push(line);
    if (VERBOSE) console.error(`[lander] ${line}`);
  };
  const lander = new Lander({
    hub: new HubClient({ url: front.url, project: P, agent, landerToken: null }),
    git: openGitPort({ mirror, remote: 'origin', env: { PATH: process.env.PATH ?? '' } }),
    checks: new ChecksRunner({ workdir, mirror, env, killGraceMs: 2_000 }),
    resolver: null,
    log,
    agent,
    project: P,
    committer: LANDER,
    drivers: await detectDrivers({ PATH: process.env.PATH ?? '' }),
    trunk: 'main',
    leaseTtlMs: 10_000,
    timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
    workdir,
    host: 'repro',
  });
  const admit = async () => {
    await lander.ensureLease();
    try {
      return await lander.admitRound();
    } finally {
      await lander.lease.release();
    }
  };
  const show = (rev, file) => {
    const r = spawnSync('git', ['show', `${rev}:${file}`], { cwd: remote, env: testEnv(), encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
  };
  const trunk = () => sh(remote, ['rev-parse', 'refs/heads/main']).trim();

  // ---- two agent clones
  const clone = (name) => {
    const d = path.join(dir, `clone-${name}`);
    sh(dir, ['clone', '-q', remote, d]);
    return d;
  };
  const land = (d, agentId, summary) => {
    const H = sh(d, ['rev-parse', 'HEAD']).trim();
    sh(d, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
    sh(d, ['fetch', '-q', 'origin', 'main']);
    const files = sh(d, ['diff', '--name-only', `origin/main...${H}`]).split('\n').filter(Boolean);
    return hub.land(P, agentId, { queue: true, commit: H, files, summary }).landing;
  };
  const maya = clone('maya');
  const sam = clone('sam');

  // maya (agent maya/claude-1) edits db/legacy.sql, which is not protected.
  commit(maya, 'maya', 'edit legacy', { 'db/legacy.sql': LEGACY.replace('-- line 20\n', `-- line 20\n${EVIL}\n`) });
  // sam (agent sam/claude-1) moves db/legacy.sql into migrations/ (protected), unchanged.
  commit(sam, 'sam', 'move legacy into migrations', { 'db/legacy.sql': null, 'migrations/0002.sql': LEGACY });

  // ---- sam's rename: protected, asks for approval, a human (maya) approves it, it lands.
  const LB = land(sam, 'sam/claude-1', 'move legacy into migrations');
  await admit();
  const lbAdmitted = hub.getLanding(P, LB.id);
  if (lbAdmitted.approval.length !== 1) throw new Error(`rig: sam's rename should need one protected approval, has ${JSON.stringify(lbAdmitted.approval)}`);
  hub.approveLanding(P, LB.id, { kind: 'protected', digest: lbAdmitted.approval[0].digest, note: 'pure move, reviewed' }, { lander: false, approver: 'maya' });
  await lander.run({ once: true });
  const lbDone = hub.getLanding(P, LB.id);
  if (lbDone.status !== 'landed') throw new Error(`rig: sam's rename should land, is ${lbDone.status} ${lbDone.failure?.code ?? ''}`);
  const T0 = trunk();
  if (show(T0, 'migrations/0002.sql') !== LEGACY || show(T0, 'db/legacy.sql') !== null) throw new Error('rig: trunk should hold the renamed file only');
  console.log(`sam's rename ${LB.id}: landed as ${T0.slice(0, 12)} with approvals by ${lbDone.approvals.map((a) => a.by).join(', ')} (migrations/0002.sql == old db/legacy.sql)`);

  // ---- maya lands her edit of db/legacy.sql (based on the seed, before the rename).
  const LA = land(maya, 'maya/claude-1', 'edit legacy');
  await admit();
  const laAdmitted = hub.getLanding(P, LA.id);
  console.log(`maya's edit ${LA.id} admitted: status=${laAdmitted.status} files=${JSON.stringify(laAdmitted.files)} protected=${JSON.stringify(laAdmitted.protected)} approval(required)=${JSON.stringify(laAdmitted.approval)}`);
  const step = await lander.run({ once: true });
  const la = hub.getLanding(P, LA.id);
  const T1 = trunk();
  const migration = show(T1, 'migrations/0002.sql');
  const diffT0T1 = sh(remote, ['diff', '--name-status', T0, T1]).trim();
  console.log(`maya's edit ${LA.id} after the attempt: status=${la.status} phase=${la.phase ?? ''} failure=${la.failure?.code ?? '-'} approval(required)=${JSON.stringify(la.approval.map((r) => ({ kind: r.kind, paths: r.paths })))} approvals(granted)=${JSON.stringify(la.approvals)} step=${step?.kind ?? null}`);
  console.log(`trunk ${T0.slice(0, 12)} -> ${T1.slice(0, 12)}; git diff --name-status T0 T1: ${diffT0T1 || '(none)'}`);
  console.log(`trunk migrations/0002.sql contains "${EVIL}": ${migration?.includes(EVIL) ?? false}`);
  if (VERBOSE) console.log(sh(remote, ['diff', T0, T1]));

  const landedUnapproved = la.status === 'landed' && la.approvals.length === 0 && T1 !== T0 && (migration?.includes(EVIL) ?? false) && diffT0T1.includes('migrations/0002.sql');
  if (landedUnapproved) {
    console.log(`DEFECT PRESENT (R-2): ${LA.id} changed protected migrations/0002.sql on trunk with no human approval (no protected/merged requirement was ever computed)`);
    exitCode = 1;
  } else {
    const asked = [...la.approval].some((r) => r.paths.includes('migrations/0002.sql'));
    console.log(`defect absent: ${LA.id} is ${la.status}${asked ? ', with an approval requirement over migrations/0002.sql' : ''}`);
    exitCode = 0;
  }
} catch (err) {
  console.error(`rig error: ${err?.stack ?? err}`);
  if (!VERBOSE) for (const l of logs.slice(-40)) console.error(`[lander] ${l}`);
  exitCode = 2;
} finally {
  try {
    await front?.close();
    await new Promise((r) => setTimeout(r, 50));
    hub?.store?.close?.();
  } catch {}
  if (process.env.KEEP !== '1') rmSync(dir, { recursive: true, force: true });
  else console.error(`kept ${dir}`);
}
process.exit(exitCode);
