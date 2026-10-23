#!/usr/bin/env node
// R-29 reproduction: the idle trunk watch scans from the control `next`
// returned before the attempt, not from the trunk the attempt's own P1 scan
// just reported.
//
// Lander.step() keeps next.control (control.trunk = A). The attempt's P1 scan
// reports A..B and the hub moves control.trunk to B, but the saved copy still
// says A. When the attempt returns `paused` (here: external_push), the attempt
// loop calls idle(), and watchTrunk(ctx, this.control) sees ls-remote B != A,
// fetches and runs scanTrunk(from A) again. The hub (reportTrunk never
// compares req.from with control.trunk) accepts it and:
//   case 1: emits trunk.moved {foreign: true} for B a second time;
//   case 2: if trunk was rewritten to B' (descends from A, not from B) between
//           the attempt's scan and the idle watch, the stale `descends(A, B')`
//           passes, the hub takes B' as a plain move (control.trunk = B'), and
//           trunk_rewritten is never raised (design §3.8 / I2).
// A control case shows the same idle watch does raise trunk_rewritten when the
// rewrite comes after the loop has a fresh control (so the harness can see a
// correct outcome).
//
// Everything is local: a bare remote, agent clones, an in-process hub served
// over HTTP on 127.0.0.1:0, and a real lander (HubClient, GitPort,
// ChecksRunner) running its own run() loop in-process. No AI resolver
// (resolver: null), no network, no API key.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// Exit 1: the defect is present. Exit 0: it is not. Exit 2: the harness broke.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, 'packages', rel)).href);

for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') || k.startsWith('HUB_') || k.startsWith('ANTHROPIC_')) delete process.env[k];
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' });

const { Hub, SqliteStore, startServer } = await imp('hub/dist/index.js');
const { Lander } = await imp('lander/dist/lander.js');
const { ChecksRunner } = await imp('lander/dist/checks.js');
const { landerId } = await imp('lander/dist/config.js');
const { detectDrivers } = await imp('lander/dist/drivers.js');
const { openGitPort } = await imp('lander/dist/git-port.js');
const { HubClient: LanderHubClient } = await imp('lander/dist/hub-client.js');
const { initWorkdir } = await imp('lander/dist/init.js');

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const SETTLE_MS = 2_000;

class HarnessError extends Error {}

let tick = 0;
function gitEnv(who = 'maya') {
  const t = `${BASE_TIME + 60 * ++tick} +0000`;
  const name = `${who} agent`;
  const email = `${who}@example.com`;
  return { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
}
function sh(cwd, args, who) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(who), encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}
function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => (s ? s.slice(0, 12) : String(s));

/**
 * A world: remote seeded with trunk A (land.externalPushes: pause), a hub on
 * 127.0.0.1:0, a lander holding the lease (its startup report made the hub's
 * trunk A), and maya's and sam's clones. `onPause` runs right after a pause
 * request the lander sends returns (to place a push between the attempt's
 * scan and the idle watch).
 */
async function world(name, o = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `r29-${name}-`)));
  const remote = path.join(dir, 'remote.git');
  const workdir = path.join(dir, 'lander');
  const landerLogs = [];
  const reports = [];
  const events = [];
  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = path.join(dir, 'seed');
  sh(dir, ['init', '-q', '-b', 'main', seed]);
  writeFiles(seed, {
    'agenthub.json': `${JSON.stringify({ project: P, land: { check: 'node check.mjs', externalPushes: 'pause' } }, null, 2)}\n`,
    'check.mjs': "console.log('checks ok');\n",
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
  });
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-q', '-m', 'seed']);
  sh(seed, ['remote', 'add', 'origin', remote]);
  sh(seed, ['push', '-q', 'origin', 'main']);

  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  hub.subscribe((e) => {
    if (e.project === P) events.push(e);
  });
  const front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });

  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const agent = landerId('lander/r29');
  const PATH = process.env.PATH ?? '';
  const client = new LanderHubClient({ url: front.url, project: P, agent, landerToken: null });
  // Record every trunk report: the `from` the lander sent and the hub's trunk at that moment.
  const reportTrunk = client.reportTrunk.bind(client);
  client.reportTrunk = async (req) => {
    const hubTrunk = hub.landerStatus(P).control.trunk?.sha ?? null;
    const r = await reportTrunk(req);
    reports.push({ from: req.from, to: req.to, rewritten: req.rewritten, commits: req.commits.map((c) => c.sha), hubTrunkBefore: hubTrunk, hubTrunkAfter: r.control.trunk?.sha ?? null });
    return r;
  };
  const pause = client.pause.bind(client);
  client.pause = async (req) => {
    const r = await pause(req);
    if (o.onPause) await o.onPause(req);
    return r;
  };
  const lander = new Lander({
    hub: client,
    git: openGitPort({ mirror, remote: 'origin', env: { PATH } }),
    checks: new ChecksRunner({ workdir, mirror, env: { ...process.env }, killGraceMs: 2_000 }),
    resolver: null,
    log: (l) => landerLogs.push(l),
    agent,
    project: P,
    committer: LANDER,
    drivers: await detectDrivers({ PATH }),
    trunk: 'main',
    leaseTtlMs: 10_000,
    timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
    workdir,
    host: 'r29',
  });
  if (!(await lander.ensureLease())) throw new HarnessError('the lander did not get the lease');

  const clone = (who) => {
    const c = path.join(dir, who);
    sh(dir, ['clone', '-q', remote, c], who);
    return c;
  };
  const agents = { maya: { id: 'maya/claude-1', dir: clone('maya') }, sam: { id: 'sam/claude-1', dir: clone('sam') } };
  const A = sh(remote, ['rev-parse', 'main']).trim();

  let running = null;
  return {
    dir,
    hub,
    lander,
    landerLogs,
    reports,
    events,
    agents,
    A,
    commit(who, files, msg) {
      writeFiles(agents[who].dir, files);
      sh(agents[who].dir, ['add', '-A'], who);
      sh(agents[who].dir, ['commit', '-q', '-m', msg], who);
      return sh(agents[who].dir, ['rev-parse', 'HEAD'], who).trim();
    },
    /** A push straight to main, outside the queue. */
    pushMain(who, { force = false } = {}) {
      sh(agents[who].dir, ['push', '-q', ...(force ? ['-f'] : []), 'origin', 'HEAD:refs/heads/main'], who);
      return sh(remote, ['rev-parse', 'main']).trim();
    },
    /** maya rewrites trunk: a new commit on A (so it descends from A but not from what is on trunk now), force-pushed. */
    rewriteFromA(tag) {
      const d = agents.maya.dir;
      sh(d, ['reset', '-q', '--hard', A], 'maya');
      writeFiles(d, { 'docs/rewrite.md': `rewritten ${tag}\n` });
      sh(d, ['add', '-A'], 'maya');
      sh(d, ['commit', '-q', '-m', `maya: rewrite ${tag}`], 'maya');
      sh(d, ['push', '-q', '-f', 'origin', 'HEAD:refs/heads/main'], 'maya');
      return sh(remote, ['rev-parse', 'main']).trim();
    },
    /** What `hub_land` does: push the land ref, then POST /land. */
    land(who, o2) {
      const t = hub.createTask(P, agents[who].id, { title: o2.title });
      hub.takeTask(P, agents[who].id, t.id);
      const H = sh(agents[who].dir, ['rev-parse', 'HEAD'], who).trim();
      sh(agents[who].dir, ['push', '-q', '-f', 'origin', `${H}:refs/agenthub/land/${H}`], who);
      return hub.land(P, agents[who].id, { queue: true, commit: H, files: o2.files, task_id: t.id, summary: o2.title }).landing;
    },
    control: () => hub.landerStatus(P).control,
    landing: (id) => hub.getLanding(P, id),
    trunk: () => sh(remote, ['rev-parse', 'main']).trim(),
    foreignMoves: (sha) => events.filter((e) => e.type === 'trunk.moved' && e.data.to === sha && e.data.foreign === true),
    start() {
      running = lander.run();
    },
    async close() {
      lander.stop();
      try {
        await running;
      } catch {}
      try {
        await lander.lease.release();
      } catch {}
      await front.close().catch(() => undefined);
      await sleep(50);
      try {
        hub.store?.close?.();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function showReports(w) {
  for (const r of w.reports) {
    const names = (s) => (s === w.A ? 'A' : s === w.B ? 'B' : s === w.B2 ? "B'" : s === w.B3 ? "B''" : short(s));
    console.log(
      `    reportTrunk from ${names(r.from)} to ${names(r.to)}${r.rewritten ? ' REWRITTEN' : ''}, commits [${r.commits.map(names).join(', ')}]` +
        `  (hub trunk before: ${names(r.hubTrunkBefore)}, after: ${names(r.hubTrunkAfter)})`,
    );
  }
}

console.log(`R-29 reproduction against ${ROOT}\n`);
let defect = false;
const fail = [];

// ---------------------------------------------------------------- case 1
// externalPushes: pause; hub trunk A; maya pushes B outside the queue; sam's
// landing L is next. P1 reports A..B (foreign), pauses external_push, requeues,
// the attempt returns paused, and idle()'s trunk watch runs with the stale A.
// Then (control) a rewrite after the loop has settled: the watch, with a fresh
// control (trunk B), must raise trunk_rewritten.
{
  const w = await world('dup');
  try {
    if (w.control().trunk?.sha !== w.A) throw new HarnessError(`the startup report did not set the hub's trunk to A: ${JSON.stringify(w.control().trunk)}`);
    w.commit('maya', { 'docs/notes.md': 'maya was here\n' }, 'maya: notes, straight to main');
    w.B = w.pushMain('maya');
    w.commit('sam', { 'src/b.ts': 'export const b = 2;\n' }, 'sam: b = 2');
    const L = w.land('sam', { files: ['src/b.ts'], title: 'sam bumps b' });
    await w.lander.admitRound();
    if (w.landing(L.id).status !== 'queued') throw new HarnessError(`L not queued after admission: ${w.landing(L.id).status}`);
    const reportsBefore = w.reports.length;
    w.start();
    await sleep(SETTLE_MS);
    const c = w.control();
    const moves = w.foreignMoves(w.B);
    console.log('== case 1: a push outside the queue (B), then an attempt that pauses external_push');
    console.log(`    A=${short(w.A)} B=${short(w.B)}; L=${L.id} now ${w.landing(L.id).status}; hub control: trunk ${c.trunk?.sha === w.B ? 'B' : short(c.trunk?.sha)}, paused ${c.paused?.reason ?? 'no'}`);
    showReports({ ...w, reports: w.reports.slice(reportsBefore) });
    console.log(`    trunk.moved {foreign: true} events for B: ${moves.length} (seq ${moves.map((e) => e.seq).join(', ')})`);
    if (c.paused?.reason !== 'external_push') throw new HarnessError(`expected the external_push pause, got ${JSON.stringify(c.paused)}\n${w.landerLogs.join('\n')}`);
    if (moves.length === 0) throw new HarnessError('no foreign trunk.moved event at all for B');
    if (moves.length > 1) {
      defect = true;
      fail.push(`case 1: the hub emitted trunk.moved {foreign: true} for the same commit B ${moves.length} times (every agent gets "main was pushed outside the queue" again)`);
    }
    const staleFrom = w.reports.slice(reportsBefore).filter((r) => r.from !== r.hubTrunkBefore);
    if (staleFrom.length) console.log(`    ${staleFrom.length} trunk report(s) carried a from that is not the hub's trunk, and the hub accepted them`);

    // control: a rewrite after the loop settled (its control is fresh: trunk B)
    w.B3 = w.rewriteFromA('late');
    await sleep(SETTLE_MS);
    const c2 = w.control();
    console.log(`  control: trunk rewritten to B''=${short(w.B3)} (on A, not on B) once the loop had settled`);
    console.log(`    hub control: trunk ${c2.trunk?.sha === w.B ? 'B' : c2.trunk?.sha === w.B3 ? "B''" : short(c2.trunk?.sha)}, paused ${c2.paused?.reason ?? 'no'}`);
    if (c2.paused?.reason !== 'trunk_rewritten' || c2.trunk?.sha !== w.B) {
      throw new HarnessError(`control: a rewrite seen with a fresh control did not raise trunk_rewritten: ${JSON.stringify(c2)}\n${w.landerLogs.join('\n')}`);
    }
    console.log('    -> trunk_rewritten raised, hub trunk stays B (the watch is right when its control is fresh)\n');
  } catch (err) {
    if (err instanceof HarnessError) {
      console.error(`HARNESS (case 1): ${err.message}`);
      await w.close();
      process.exit(2);
    }
    throw err;
  } finally {
    await w.close();
  }
}

// ---------------------------------------------------------------- case 2
// The same, but trunk is rewritten to B' (a commit on A, not on B) right after
// the attempt's pause request returns, i.e. between the attempt's P1 scan
// (which made the hub's trunk B) and the idle watch.
{
  let w;
  let rewrote = false;
  w = await world('rewrite', {
    onPause: async (req) => {
      if (req.reason === 'external_push' && !rewrote) {
        rewrote = true;
        w.B2 = w.rewriteFromA('in-window');
      }
    },
  });
  try {
    w.commit('maya', { 'docs/notes.md': 'maya was here\n' }, 'maya: notes, straight to main');
    w.B = w.pushMain('maya');
    w.commit('sam', { 'src/b.ts': 'export const b = 2;\n' }, 'sam: b = 2');
    const L = w.land('sam', { files: ['src/b.ts'], title: 'sam bumps b' });
    await w.lander.admitRound();
    if (w.landing(L.id).status !== 'queued') throw new HarnessError(`L not queued after admission: ${w.landing(L.id).status}`);
    const reportsBefore = w.reports.length;
    w.start();
    await sleep(SETTLE_MS);
    if (!rewrote) throw new HarnessError(`the attempt never paused external_push\n${w.landerLogs.join('\n')}`);
    const c = w.control();
    const isB2 = w.trunk() === w.B2;
    console.log("== case 2: trunk rewritten to B' between the attempt's scan and the idle watch");
    console.log(`    A=${short(w.A)} B=${short(w.B)} B'=${short(w.B2)} (B' descends from A, not from B; remote main is B': ${isB2})`);
    showReports({ ...w, reports: w.reports.slice(reportsBefore) });
    const trunkName = c.trunk?.sha === w.B ? 'B' : c.trunk?.sha === w.B2 ? "B'" : short(c.trunk?.sha);
    console.log(`    hub control: trunk ${trunkName}, paused ${c.paused?.reason ?? 'no'}`);
    const rewriteEvents = w.events.filter((e) => e.type === 'lander.paused' && e.data.reason === 'trunk_rewritten');
    console.log(`    lander.paused {trunk_rewritten} events: ${rewriteEvents.length}; trunk.moved {foreign} for B': ${w.foreignMoves(w.B2).length}`);
    const relevant = w.landerLogs.filter((l) => /rewritten|trunk watch|outside/.test(l));
    for (const l of relevant) console.log(`    lander log: ${l}`);
    if (c.paused?.reason !== 'trunk_rewritten' || c.trunk?.sha !== w.B) {
      defect = true;
      fail.push(`case 2: trunk was rewritten (B -> B', B' not a descendant of B), but the idle watch scanned from the stale A: the hub took B' as a plain move (trunk ${trunkName}) and trunk_rewritten was never raised (paused: ${c.paused?.reason ?? 'no'})`);
    }
  } catch (err) {
    if (err instanceof HarnessError) {
      console.error(`HARNESS (case 2): ${err.message}`);
      await w.close();
      process.exit(2);
    }
    throw err;
  } finally {
    await w.close();
  }
}

if (defect) {
  console.log('\nDEFECT PRESENT:');
  for (const f of fail) console.log(` - ${f}`);
  process.exit(1);
}
console.log('\nno defect: the idle watch scans from the trunk the hub has after the attempt.');
process.exit(0);
