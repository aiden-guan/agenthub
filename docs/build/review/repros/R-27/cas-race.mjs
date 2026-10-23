#!/usr/bin/env node
// R-27 reproduction: a lost compare-and-swap race between two identical trunk
// pushes of the same candidate C onto the same T0 (design §2.2.7 step 3: "Two
// landers racing push identical content, and the second sees up_to_date").
//
// Setup (no network, no API key): a local bare remote, an in-process hub on
// 127.0.0.1:0 served by @agenthub/hub's startServer, and the real lander from
// ${AGENTHUB_ROOT}/packages/*/dist over its real HubClient, GitPort and
// ChecksRunner.
//
// The race: the remote's pre-receive hook holds the lander's trunk push after
// its ref advertisement (main == T0) until a second, identical push (the same
// `git push --atomic --porcelain --force-with-lease=refs/heads/main:T0 <remote>
// C:refs/heads/main :<land ref>` that pushTrunk runs, from a second lander's own
// bare repository) has moved main to C. The lander's receive-pack then fails
// its ref transaction ("cannot lock ref ... is at C but expected T0").
//
// Correct (design): the lost CAS is `stale` (or up_to_date): the lander fetches,
// finds C on trunk, and resolves the landing as landed; landing is not paused.
// Defect: classifyPush calls it `rejected`, and the lander pauses the whole
// project with push_rejected although trunk is exactly C.
//
// Exit 1: defect present. Exit 0: no defect. Exit 2: the harness could not stage the race.
//
// R27_MODE (optional):
//   same      (default) the racing push is pushTrunk's exact command, land-ref deletion included;
//   same-main the racing push updates only main (stderr then reads
//             "cannot lock ref 'refs/heads/main': is at C but expected T0");
//   foreign   the racing push is someone else's commit on T0 (trunk != C): the lost CAS
//             should be `stale` (back to the queue), not a project-wide pause.

import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const MODE = process.env.R27_MODE || 'same';
if (!['same', 'same-main', 'foreign'].includes(MODE)) throw new Error(`bad R27_MODE ${MODE}`);
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
const BASE = Date.UTC(2026, 0, 1) / 1000;
let tick = 0;

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_')) env[k] = v;
  const t = `${BASE + 60 * ++tick} +0000`;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Maya Agent',
    GIT_AUTHOR_EMAIL: 'maya@example.com',
    GIT_COMMITTER_NAME: 'Maya Agent',
    GIT_COMMITTER_EMAIL: 'maya@example.com',
    GIT_AUTHOR_DATE: t,
    GIT_COMMITTER_DATE: t,
  };
}
function sh(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}
const execFileP = promisify(execFile);
async function shAsync(cwd, args) {
  try {
    const r = await execFileP('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
async function waitFor(cond, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'r27-')));
const remote = path.join(dir, 'remote.git');
const seed = path.join(dir, 'seed');
const agent = path.join(dir, 'agent');
const second = path.join(dir, 'second-lander.git');
const workdir = path.join(dir, 'lander');
const logs = [];
let front = null;
let hub = null;
let exitCode = 2;

try {
  // ---------------- the remote, seeded with agenthub.json
  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  mkdirSync(seed);
  sh(seed, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  writeFileSync(path.join(seed, 'check.mjs'), 'process.exit(0);\n');
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: P, land: { check: 'node check.mjs' } }, null, 2)}\n`);
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-q', '-m', 'seed']);
  sh(seed, ['push', '-q', remote, 'main']);
  const T0 = sh(remote, ['rev-parse', 'refs/heads/main']);

  // The pre-receive hook: the first trunk update after `block-trunk` is armed
  // (the lander's) waits, after its ref advertisement, until the racing push is done.
  const blockFlag = path.join(dir, 'block-trunk');
  const started = path.join(dir, 'hook-started');
  const release = path.join(dir, 'hook-release');
  writeFileSync(
    path.join(remote, 'hooks', 'pre-receive'),
    `#!/bin/sh
input=$(cat)
case "$input" in
  *refs/heads/main*)
    if [ -e "${blockFlag}" ]; then
      rm -f "${blockFlag}"
      printf '%s\\n' "$input" > "${started}"
      while [ ! -e "${release}" ]; do sleep 0.05; done
    fi;;
esac
exit 0
`,
  );
  chmodSync(path.join(remote, 'hooks', 'pre-receive'), 0o755);

  // ---------------- hub (in-process, HTTP on loopback port 0) and the real lander
  hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const PATH = process.env.PATH ?? '';
  const makeLander = async () => {
    const id = landerId('lander/test');
    return new Lander({
      hub: new HubClient({ url: front.url, project: P, agent: id, landerToken: null }),
      git: openGitPort({ mirror, remote: 'origin', env: { PATH } }),
      checks: new ChecksRunner({ workdir, mirror, env: { ...process.env, PATH }, killGraceMs: 2_000 }),
      resolver: null,
      log: (line) => logs.push(line),
      agent: id,
      project: P,
      committer: LANDER,
      drivers: await detectDrivers({ PATH }),
      trunk: 'main',
      leaseTtlMs: 10_000,
      timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
      workdir,
      host: 'test',
    });
  };

  // ---------------- an agent's landing: land ref pushed, POST /land {queue: true}
  sh(dir, ['clone', '-q', remote, agent]);
  mkdirSync(path.join(agent, 'src'), { recursive: true });
  writeFileSync(path.join(agent, 'src', 'greet.ts'), 'export const greet = 1;\n');
  sh(agent, ['add', '-A']);
  sh(agent, ['commit', '-q', '-m', 'a: greet']);
  const H = sh(agent, ['rev-parse', 'HEAD']);
  sh(agent, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
  const L = hub.land(P, 'maya/claude-1', { queue: true, commit: H, files: ['src/greet.ts'], summary: 'greet' }).landing;

  // ---------------- the race
  writeFileSync(blockFlag, '');
  const lander = await makeLander();
  const run = lander.run({ once: true });
  await waitFor(() => existsSync(started), "the lander's trunk push to reach the remote's pre-receive hook");
  const held = hub.getLanding(P, L.id);
  const C = held.candidate;
  const candRef = held.candidate_ref;
  if (held.phase !== 'pushing' || !C || !candRef) throw new Error(`the held push isn't the lander's P10 push: ${held.status}/${held.phase}`);

  // The second lander's identical push (it fetched the staged candidate, as resolveInDoubt does).
  sh(dir, ['init', '-q', '--bare', second]);
  sh(second, ['fetch', '-q', remote, `+${candRef}:refs/cand`]);
  const landRefName = `refs/agenthub/land/${H}`;
  let other;
  if (MODE === 'foreign') {
    sh(second, ['fetch', '-q', remote, `+refs/heads/main:refs/heads/main`]);
    const tree = sh(second, ['rev-parse', `${T0}^{tree}`]);
    const X = spawnSync('git', ['commit-tree', tree, '-p', T0, '-m', 'pushed outside the queue'], { cwd: second, env: gitEnv(), encoding: 'utf8' }).stdout.trim();
    other = await shAsync(second, ['push', '--porcelain', remote, `${X}:refs/heads/main`]);
  } else {
    const spec = [`${C}:refs/heads/main`, ...(MODE === 'same' ? [`:${landRefName}`] : [])];
    other = await shAsync(second, ['push', '--atomic', '--porcelain', `--force-with-lease=refs/heads/main:${T0}`, remote, ...spec]);
  }
  const trunkAfterOther = sh(remote, ['rev-parse', 'refs/heads/main']);
  if (other.code !== 0 || trunkAfterOther === T0 || (MODE !== 'foreign' && trunkAfterOther !== C)) throw new Error(`the racing push did not move trunk: ${other.code} ${other.stdout} ${other.stderr}`);
  writeFileSync(release, '');
  const out = await run;

  const after = hub.getLanding(P, L.id);
  const control = hub.landerStatus(P).control;
  const trunk = sh(remote, ['rev-parse', 'refs/heads/main']);
  console.log(`T0 ${T0.slice(0, 12)}  C ${C.slice(0, 12)}  trunk ${trunk.slice(0, 12)}  (trunk == C: ${trunk === C})`);
  console.log(`racing identical push: exit ${other.code}, ${other.stdout.trim().split('\n').filter((l) => l.includes('\t')).join(' | ')}`);
  console.log(`lander run --once: ${JSON.stringify(out)}`);
  console.log(`landing ${L.id}: ${after.status}/${after.phase ?? '-'}`);
  console.log(`control.paused: ${control.paused ? `${control.paused.reason} | ${control.paused.detail}` : 'null'}`);
  for (const l of logs.filter((l) => /refused|paused|stale|landed/.test(l))) console.log(`  lander log: ${l}`);

  console.log(`mode ${MODE}`);
  const defect = (MODE === 'foreign' || trunk === C) && control.paused?.reason === 'push_rejected';

  // ---------------- what follows (severity): the next pass, and a second landing
  if (defect) {
    const b = path.join(dir, 'agent-b');
    sh(dir, ['clone', '-q', remote, b]);
    writeFileSync(path.join(b, 'README.md'), '# demo\nmore\n');
    sh(b, ['add', '-A']);
    sh(b, ['commit', '-q', '-m', 'b: readme']);
    const HB = sh(b, ['rev-parse', 'HEAD']);
    sh(b, ['push', '-q', 'origin', `${HB}:refs/agenthub/land/${HB}`]);
    const LB = hub.land(P, 'ana/claude-2', { queue: true, commit: HB, files: ['README.md'], summary: 'readme' }).landing;
    const l2 = await makeLander();
    const out2 = await l2.run({ once: true });
    const l3 = await makeLander();
    const out3 = await l3.run({ once: true });
    const c2 = hub.landerStatus(P).control;
    console.log('--- follow-up passes (no human resume) ---');
    console.log(`next run --once: ${JSON.stringify(out2)}; then ${JSON.stringify(out3)}`);
    console.log(`landing ${L.id}: ${hub.getLanding(P, L.id).status}; second landing ${LB.id}: ${hub.getLanding(P, LB.id).status}`);
    console.log(`control.paused: ${c2.paused ? c2.paused.reason : 'null'}`);
  }

  if (defect) {
    console.log(MODE === 'foreign'
      ? '\nDEFECT PRESENT (R-27): a CAS lost to a concurrent trunk update was classified `rejected`, not `stale`; the project is paused push_rejected.'
      : '\nDEFECT PRESENT (R-27): a lost CAS race whose winner pushed the same C was classified `rejected`; the project is paused push_rejected although trunk == C.');
    exitCode = 1;
  } else {
    console.log('\nno defect: the lost race did not pause landing with push_rejected.');
    exitCode = 0;
  }
} catch (err) {
  console.error(`harness error: ${err instanceof Error ? err.stack : String(err)}`);
  for (const l of logs.slice(-30)) console.error(`  lander log: ${l}`);
  exitCode = 2;
} finally {
  writeFileSync(path.join(dir, 'hook-release'), '');
  if (front) await front.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  try {
    hub?.store.close?.();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
