#!/usr/bin/env node
// R-33 reproduction: a trunk report over the hub's 1 MB body limit fails every
// attempt as lander_error and then pauses landing ("lander workdir unusable").
//
// scanTrunk (packages/lander/src/trunk.ts) sends every first-parent commit
// since the hub's trunk (up to 500), each with up to 200 changed paths, in one
// POST /lander/trunk. Nothing keeps that body under the hub's MAX_BODY_BYTES
// (1_000_000, packages/hub/src/server.ts). The hub answers 413 too_large;
// hubWrite rethrows it (not unavailable, not not_lander), and the attempt's
// generic catch in Attempt.run (pipeline.ts) fails the running landing with
// lander_error ("not caused by your change"). Three in a row and Lander.step
// pauses the project (config_invalid, "lander workdir unusable"). Resuming
// without --accept-trunk only repeats it, since the hub's trunk never moves.
//
// The trigger: while the lander is down, a human pushes a vendored tree
// import straight to main, outside the queue: COMMITS first-parent commits
// that each add FILES files (defaults 90 x 220, paths of about 80 bytes, i.e.
// about 1.5 MB of report). A control world does the same with a small import
// (20 x 220, about 0.35 MB) and must land, so the harness itself is shown to
// work and the failure is caused by the report's size alone.
//
// Everything is local: a bare remote, agent clones, an in-process hub served
// over HTTP on 127.0.0.1:0, and a real lander (HubClient, GitPort,
// ChecksRunner, resolver: null) running its own run() loop in-process. No AI
// resolver, no network, no API key.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//   (optional: R33_COMMITS=90 R33_FILES=220 to size the big import)
//
// Exit 1: the defect is present. Exit 0: it is not. Exit 2: the harness broke.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, 'packages', rel)).href);

const BIG_COMMITS = Number(process.env.R33_COMMITS || 90);
const BIG_FILES = Number(process.env.R33_FILES || 220);

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
const TERMINAL = new Set(['landed', 'failed', 'superseded', 'cancelled']);
const approver = (name) => ({ lander: false, approver: name });

class HarnessError extends Error {}

let tick = 0;
function gitEnv(who = 'maya') {
  const t = `${BASE_TIME + 60 * ++tick} +0000`;
  const name = `${who} agent`;
  const email = `${who}@example.com`;
  return { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
}
function sh(cwd, args, who, input) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(who), encoding: 'utf8', maxBuffer: 256 << 20, input });
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
const mb = (n) => `${(n / 1_000_000).toFixed(2)} MB`;

async function waitFor(what, pred, ms, dump) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(100);
  }
  throw new HarnessError(`timed out waiting for ${what}\n${dump ? dump() : ''}`);
}

/**
 * A world: remote seeded with trunk A (land.check, externalPushes: warn by
 * default), a hub on 127.0.0.1:0, a lander holding the lease (its startup
 * report made the hub's trunk A), and maya's, sam's, lee's and kim's clones.
 */
async function world(name) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `r33-${name}-`)));
  const remote = path.join(dir, 'remote.git');
  const workdir = path.join(dir, 'lander');
  const landerLogs = [];
  const reports = [];
  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = path.join(dir, 'seed');
  sh(dir, ['init', '-q', '-b', 'main', seed]);
  writeFiles(seed, {
    'agenthub.json': `${JSON.stringify({ project: P, land: { check: 'node check.mjs' } }, null, 2)}\n`,
    'check.mjs': "console.log('checks ok');\n",
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
    'src/c.ts': 'export const c = 1;\n',
    'src/d.ts': 'export const d = 1;\n',
  });
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-q', '-m', 'seed']);
  sh(seed, ['remote', 'add', 'origin', remote]);
  sh(seed, ['push', '-q', 'origin', 'main']);

  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  const front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });

  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const agent = landerId('lander/r33');
  const PATH = process.env.PATH ?? '';
  const client = new LanderHubClient({ url: front.url, project: P, agent, landerToken: null });
  // Record every trunk report: its body size, how many commits, and what the hub answered.
  const reportTrunk = client.reportTrunk.bind(client);
  client.reportTrunk = async (req) => {
    const bytes = Buffer.byteLength(JSON.stringify(req));
    const rec = { from: req.from, to: req.to, commits: req.commits.length, files: req.commits.reduce((n, c) => n + c.files.length, 0), bytes, outcome: 'ok' };
    reports.push(rec);
    try {
      return await reportTrunk(req);
    } catch (err) {
      rec.outcome = `${err?.code ?? 'error'}${err?.status ? ` (HTTP ${err.status})` : ''}: ${err?.message ?? err}`;
      throw err;
    }
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
    timings: { pollTrunkMs: 200, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
    workdir,
    host: 'r33',
  });
  if (!(await lander.ensureLease())) throw new HarnessError('the lander did not get the lease');

  const clone = (who) => {
    const c = path.join(dir, who);
    sh(dir, ['clone', '-q', remote, c], who);
    return c;
  };
  const agents = {};
  for (const who of ['maya', 'sam', 'lee', 'kim']) agents[who] = { id: `${who}/claude-1`, dir: clone(who) };
  const A = sh(remote, ['rev-parse', 'main']).trim();

  let running = null;
  return {
    dir,
    hub,
    lander,
    landerLogs,
    reports,
    agents,
    A,
    /**
     * maya imports a vendored tree straight to main, outside the queue, in one
     * push: `commits` first-parent commits, each adding `files` new files.
     */
    vendorImport(commits, files) {
      const d = agents.maya.dir;
      const parent = sh(d, ['rev-parse', 'HEAD'], 'maya').trim();
      const lines = ['blob', 'mark :1', 'data 26', '// generated, do not edit', ''];
      for (let i = 0; i < commits; i++) {
        const msg = `vendor: import acme design system, part ${i + 1}/${commits}\n`;
        lines.push('commit refs/heads/main', `mark :${i + 2}`, `committer maya agent <maya@example.com> ${BASE_TIME + 60 * ++tick} +0000`, `data ${Buffer.byteLength(msg)}`, msg.slice(0, -1));
        lines.push(`from ${i === 0 ? parent : `:${i + 1}`}`);
        const pkg = `widget-${String(i).padStart(4, '0')}`;
        for (let j = 0; j < files; j++) {
          const n = String(j).padStart(3, '0');
          lines.push(`M 100644 :1 vendor/acme-design-system/packages/components/src/${pkg}/generated/Part${n}.generated.tsx`);
        }
        lines.push('');
      }
      sh(d, ['fast-import', '--quiet', '--force'], 'maya', `${lines.join('\n')}\n`);
      sh(d, ['reset', '-q', '--hard', 'main'], 'maya');
      sh(d, ['push', '-q', 'origin', 'main:refs/heads/main'], 'maya');
      return sh(remote, ['rev-parse', 'main']).trim();
    },
    commit(who, files, msg) {
      sh(agents[who].dir, ['fetch', '-q', 'origin'], who);
      writeFiles(agents[who].dir, files);
      sh(agents[who].dir, ['add', '-A'], who);
      sh(agents[who].dir, ['commit', '-q', '-m', msg], who);
      return sh(agents[who].dir, ['rev-parse', 'HEAD'], who).trim();
    },
    resetTo(who, sha) {
      sh(agents[who].dir, ['reset', '-q', '--hard', sha], who);
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

function describe(w, ids) {
  for (const id of ids) {
    const l = w.landing(id);
    const warn = (l.failure?.warnings ?? l.report?.warnings ?? []).slice(0, 1).join(' | ');
    console.log(`    ${id} (${l.agent}): ${l.status}${l.failure ? ` ${l.failure.code}` : ''}${warn ? ` -- ${warn.slice(0, 120)}` : ''}`);
  }
}
function showReports(w, from = 0) {
  const rs = w.reports.slice(from);
  const shown = rs.slice(0, 6);
  for (const r of shown) console.log(`    POST /lander/trunk: ${r.commits} commits, ${r.files} paths, body ${mb(r.bytes)} -> ${r.outcome.slice(0, 110)}`);
  if (rs.length > shown.length) {
    const refused = rs.slice(shown.length).filter((r) => r.outcome !== 'ok').length;
    console.log(`    ... and ${rs.length - shown.length} more trunk reports (${refused} refused)`);
  }
}

/**
 * The scenario in one world: hub trunk A; while the lander's loop is not
 * running, maya pushes an import of `commits` x `files`; sam, lee and kim each
 * land a one-line change; the lander runs. Returns the world (open) and ids.
 */
async function scenario(name, commits, files) {
  const w = await world(name);
  if (w.control().trunk?.sha !== w.A) throw new HarnessError(`the startup report did not set the hub's trunk to A: ${JSON.stringify(w.control().trunk)}`);
  const B = w.vendorImport(commits, files);
  const ids = [];
  const changes = { sam: 'src/a.ts', lee: 'src/b.ts', kim: 'src/c.ts' };
  for (const [who, file] of Object.entries(changes)) {
    w.commit(who, { [file]: `export const ${path.basename(file, '.ts')} = 2; // ${who}\n` }, `${who}: bump ${file}`);
    ids.push(w.land(who, { files: [file], title: `${who} bumps ${file}` }).id);
  }
  await w.lander.admitRound();
  for (const id of ids) if (w.landing(id).status !== 'queued') throw new HarnessError(`${id} not queued after admission: ${w.landing(id).status}`);
  const reportsBefore = w.reports.length;
  w.start();
  await waitFor('the three landings to end', () => ids.every((id) => TERMINAL.has(w.landing(id).status)), 60_000, () => w.landerLogs.join('\n'));
  return { w, B, ids, reportsBefore };
}

console.log(`R-33 reproduction against ${ROOT}\n`);
const fail = [];

// ---------------------------------------------------------------- control
// A small import (about 0.35 MB of report): the same landings must land.
{
  const { w, B, ids, reportsBefore } = await scenario('control', 20, 220).catch((err) => {
    console.error(`HARNESS (control): ${err.stack ?? err}`);
    process.exit(2);
  });
  try {
    console.log(`== control: maya pushes a 20-commit x 220-file import (A=${short(w.A)} -> ${short(B)}) outside the queue; 3 landings`);
    showReports(w, reportsBefore);
    describe(w, ids);
    const landed = ids.filter((id) => w.landing(id).status === 'landed').length;
    if (landed !== ids.length) throw new HarnessError(`control: only ${landed}/${ids.length} landed with a small import\n${w.landerLogs.join('\n')}`);
    console.log('    -> all landed: the harness lands changes after a push outside the queue\n');
  } catch (err) {
    console.error(`HARNESS (control): ${err.message}`);
    await w.close();
    process.exit(2);
  } finally {
    await w.close();
  }
}

// ---------------------------------------------------------------- the defect
{
  const { w, B, ids, reportsBefore } = await scenario('big', BIG_COMMITS, BIG_FILES).catch((err) => {
    console.error(`HARNESS (big import): ${err.stack ?? err}`);
    process.exit(2);
  });
  try {
    console.log(`== big import: maya pushes a ${BIG_COMMITS}-commit x ${BIG_FILES}-file vendored tree (A=${short(w.A)} -> ${short(B)}) outside the queue, while the lander is down; 3 landings`);
    showReports(w, reportsBefore);
    describe(w, ids);
    const c = w.control();
    console.log(`    hub control: trunk ${c.trunk?.sha === w.A ? 'A (never moved)' : short(c.trunk?.sha)}, paused: ${c.paused ? `${c.paused.reason} (${c.paused.detail})` : 'no'}`);
    for (const l of w.landerLogs.filter((x) => /lander error in attempt|workdir unusable|trunk watch|startup trunk report/.test(x)).slice(0, 4)) console.log(`    lander log: ${l.split('\n')[0].slice(0, 160)}`);

    const refused = w.reports.slice(reportsBefore).filter((r) => r.outcome !== 'ok');
    const laErr = ids.filter((id) => w.landing(id).status === 'failed' && w.landing(id).failure?.code === 'lander_error');
    if (refused.length > 0) fail.push(`${refused.length} trunk report(s) of ${mb(Math.max(...refused.map((r) => r.bytes)))} were refused by the hub: ${refused[0].outcome.slice(0, 100)}`);
    if (laErr.length > 0) fail.push(`${laErr.length}/${ids.length} landings (${laErr.join(', ')}) failed with lander_error ("not caused by your change") because P1's trunk report was refused`);
    if (c.paused?.reason === 'config_invalid' && /workdir unusable/.test(c.paused.detail ?? '')) fail.push(`landing is paused for the whole project: ${c.paused.reason} "${c.paused.detail}"`);

    // An approver resumes without --accept-trunk, and sam lands again: the same failure.
    if (c.paused) {
      w.hub.resumeLander(P, {}, approver('sam'));
      const before = w.reports.length;
      w.resetTo('sam', w.A);
      w.commit('sam', { 'src/d.ts': 'export const d = 2; // sam again\n' }, 'sam: bump src/d.ts');
      const again = w.land('sam', { files: ['src/d.ts'], title: 'sam bumps d' }).id;
      await waitFor(`${again} to end after the resume`, () => TERMINAL.has(w.landing(again).status), 60_000, () => w.landerLogs.join('\n'));
      console.log('  an approver resumes (no --accept-trunk), and sam lands another change:');
      showReports(w, before);
      describe(w, [again]);
      const l = w.landing(again);
      if (l.status === 'failed' && l.failure?.code === 'lander_error') fail.push(`after hub lander resume, the next landing (${again}) failed with lander_error again: resuming only repeats it`);
    }
    if (fail.length === 0 && !ids.every((id) => w.landing(id).status === 'landed')) {
      throw new HarnessError(`no refused report and no lander_error, but not every landing landed:\n${ids.map((id) => `${id}: ${w.landing(id).status} ${w.landing(id).failure?.code ?? ''}`).join('\n')}\n${w.landerLogs.join('\n')}`);
    }
  } catch (err) {
    if (err instanceof HarnessError) {
      console.error(`HARNESS (big import): ${err.message}`);
      await w.close();
      process.exit(2);
    }
    throw err;
  } finally {
    await w.close();
  }
}

if (fail.length > 0) {
  console.log('\nDEFECT PRESENT:');
  for (const f of fail) console.log(` - ${f}`);
  process.exit(1);
}
console.log('\nno defect: a large push outside the queue is reported and the landings land.');
process.exit(0);
