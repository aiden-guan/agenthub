// Repro for R-34: a foreign trunk commit whose message carries a malformed
// Agenthub-* trailer (a value the hub's POST /lander/trunk validator refuses:
// Agenthub-Source over 64 chars, Agenthub-Hub over 100, Agenthub-Landing over
// 300, or any of them with a forbidden character such as U+202E) makes P1's
// trunk report fail with 400 every time. scanTrunk() (lander/src/trunk.ts)
// copies t.landing / t.hub / t.source from trunkTrailers() into the report
// unchanged; parseTrunkReport() (hub/src/landing-requests.ts) throws on the
// whole report; runAttempt's catch-all turns that into failed {lander_error};
// the report always starts from control.trunk (which never advances), so the
// same commit is resent on every attempt. After 3 lander_errors in a row the
// lander pauses landing with config_invalid "lander workdir unusable".
//
// Design: §2.2.5 P1 (report foreign commits, the hub emits trunk.moved
// {foreign: true}), §4.1 #1 (foreign pushes are detected, not fatal), §4.5
// (only worktree failures pause with config_invalid).
//
// Everything is local: a bare remote, an in-process hub (startServer on port
// 0, loopback, SQLite :memory:), a real lander (HubClient, GitPort,
// ChecksRunner) run with run({once: true}). No resolver is used, no network,
// no API key.
//
// Run:
//   AGENTHUB_ROOT=/home/user/agenthub node \
//     /tmp/claude-0/-home-user-agenthub/8b8b52f8-98ca-5efe-ba8a-d267c5f2c650/scratchpad/work-p23/review/repro-R-34/repro.mjs
//
// Exit 0: no defect (every unrelated landing after the foreign push lands, and
// landing is not paused). Exit 1: defect present. Exit 2: the control run (a
// foreign push with no trailer-like line) didn't land either, so the rig is
// broken and the result says nothing.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.AGENTHUB_ROOT ?? '/home/user/agenthub';
const dist = (pkg, file) => path.join(ROOT, 'packages', pkg, 'dist', file);

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
    GIT_AUTHOR_NAME: 'Seed Human',
    GIT_AUTHOR_EMAIL: 'seed@example.com',
    GIT_COMMITTER_NAME: LANDER.name,
    GIT_COMMITTER_EMAIL: LANDER.email,
    GIT_AUTHOR_DATE: `${BASE_TIME} +0000`,
    GIT_COMMITTER_DATE: `${BASE_TIME} +0000`,
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function sh(cwd, args, extra = {}, input) {
  const r = spawnSync('git', args, { cwd, env: testEnv(extra), encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

// The integration tests' check command (packages/lander/test/fixtures/check.mjs, simplified): passes unless a file holds FAIL!.
const CHECK_MJS = `import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\\0').filter(Boolean);
const bad = files.filter((f) => { try { return readFileSync(f, 'utf8').includes('FAIL' + '!'); } catch { return false; } });
if (bad.length) { console.log('failed: ' + bad.join(' ')); process.exit(1); }
console.log('checked ' + files.length + ' files: ok');
`;

class Clone {
  tick = 0;
  constructor(dir, agent, author) {
    this.dir = dir;
    this.agent = agent;
    this.author = author;
  }
  env() {
    const t = `${BASE_TIME + 3600 + 60 * ++this.tick} +0000`;
    return { GIT_AUTHOR_NAME: this.author.name, GIT_AUTHOR_EMAIL: this.author.email, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
  }
  commit(message, files) {
    for (const [file, content] of Object.entries(files)) {
      const p = path.join(this.dir, file);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    sh(this.dir, ['add', '-A']);
    sh(this.dir, ['commit', '-q', '-F', '-'], this.env(), message);
    return this.head();
  }
  head() {
    return sh(this.dir, ['rev-parse', 'HEAD']).trim();
  }
}

async function makeWorld(label) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), `repro-R34-${label.split(':')[0].replace(/[^A-Za-z0-9]/g, '')}-`)));
  const remote = path.join(dir, 'remote.git');
  const workdir = path.join(dir, 'lander');
  const logs = [];
  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  const seed = new Clone(path.join(dir, 'seed'), 'human/seed', { name: 'Seed Human', email: 'seed@example.com' });
  mkdirSync(seed.dir);
  sh(seed.dir, ['init', '-q', '-b', 'main']);
  seed.commit('seed', {
    'README.md': '# demo\n',
    'src/a.ts': 'export const a = 1;\n',
    'check.mjs': CHECK_MJS,
    'agenthub.json': `${JSON.stringify({ project: P, land: { check: 'node check.mjs' } }, null, 2)}\n`,
  });
  sh(seed.dir, ['remote', 'add', 'origin', remote]);
  sh(seed.dir, ['push', '-q', 'origin', 'main']);

  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  const events = [];
  hub.subscribe((e) => events.push(e));
  const front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const lander = new Lander({
    hub: new HubClient({ url: front.url, project: P, agent: landerId('lander/test'), landerToken: null }),
    git: openGitPort({ mirror, remote: 'origin', env: { PATH: process.env.PATH ?? '' } }),
    checks: new ChecksRunner({ workdir, mirror, env: { ...process.env }, killGraceMs: 2_000 }),
    resolver: null,
    log: (line) => {
      logs.push(line);
      if (VERBOSE) console.log(`    [lander] ${line}`);
    },
    agent: landerId('lander/test'),
    project: P,
    committer: LANDER,
    drivers: await detectDrivers({ PATH: process.env.PATH ?? '' }),
    trunk: 'main',
    leaseTtlMs: 10_000,
    timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
    workdir,
    host: 'test',
  });

  let clones = 0;
  const world = {
    hub,
    logs,
    events,
    lander,
    clone(agent) {
      const human = agent.split('/')[0];
      const c = new Clone(path.join(dir, `clone-${++clones}-${human}`), agent, { name: `${human} agent`, email: `${human}@example.com` });
      sh(dir, ['clone', '-q', remote, c.dir]);
      return c;
    },
    land(c) {
      const H = c.head();
      sh(c.dir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
      sh(c.dir, ['fetch', '-q', 'origin', 'main']);
      const files = sh(c.dir, ['diff', '--name-only', `origin/main...${H}`]).split('\n').filter(Boolean);
      return hub.land(P, c.agent, { queue: true, commit: H, files }).landing;
    },
    foreignPush(files, message) {
      sh(seed.dir, ['fetch', '-q', 'origin', 'main']);
      sh(seed.dir, ['reset', '-q', '--hard', 'origin/main']);
      const sha = seed.commit(message, files);
      sh(seed.dir, ['push', '-q', 'origin', 'main']);
      return sha;
    },
    once: () => lander.run({ once: true }),
    landing: (id) => hub.getLanding(P, id),
    paused: () => hub.landerStatus(P).control.paused,
    async close() {
      await front.close();
      await new Promise((r) => setTimeout(r, 50));
      hub.store.close?.();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return world;
}

/**
 * One normal landing (so the hub knows a trunk tip), then a foreign push with
 * `message`, then `rounds` landings of unrelated files, each run with
 * run({once: true}); with `resume`, an approver resumes after the pause and one
 * more landing is tried.
 */
async function run(label, message, { rounds = 3, resume = false } = {}) {
  const w = await makeWorld(label);
  const out = { label, first: null, after: [], paused: null, afterResume: null, pausedAfterResume: null, afterAccept: null, foreignReported: false, trunkReportErrors: [] };
  try {
    const a = w.clone('maya/claude-1');
    a.commit('a', { 'src/a.ts': 'export const a = 2;\n' });
    const L1 = w.land(a);
    await w.once();
    out.first = w.landing(L1.id).status;

    const foreign = w.foreignPush({ 'README.md': '# demo 2\n' }, message);
    out.foreign = foreign;

    const attempt = async (i) => {
      const b = w.clone(`sam${i}/claude-1`);
      b.commit('b', { [`src/b${i}.ts`]: `export const b${i} = 2;\n` });
      const L = w.land(b);
      await w.once();
      const l = w.landing(L.id);
      return { id: l.id, status: l.status, code: l.failure?.code ?? null, warnings: l.report?.warnings ?? [] };
    };
    for (let i = 0; i < rounds; i++) out.after.push(await attempt(i));
    out.paused = w.paused();
    if (resume && out.paused) {
      w.hub.resumeLander(P, {}, { lander: false, approver: 'sam' });
      out.afterResume = await attempt(rounds);
      out.pausedAfterResume = w.paused();
      // Informational (not part of the verdict): the only way out is an approver accepting the foreign commit as trunk,
      // which also means it is never reported as foreign.
      w.hub.resumeLander(P, { accept_trunk: foreign }, { lander: false, approver: 'sam' });
      out.afterAccept = await attempt(rounds + 1);
    }
    out.foreignReported = w.events.some((e) => e.type === 'trunk.moved' && e.data?.foreign === true && (e.data?.to === foreign || JSON.stringify(e.data).includes(foreign)));
    out.trunkReportErrors = w.logs.filter((l) => /trunk report|commits\[\d+\]\./.test(l));
  } finally {
    await w.close();
  }
  return out;
}

function show(r) {
  console.log(`\n== ${r.label}`);
  console.log(`  first landing (before the foreign push): ${r.first}`);
  console.log(`  foreign commit: ${r.foreign?.slice(0, 12)}`);
  for (const a of r.after) console.log(`  ${a.id}: ${a.status}${a.code ? ` {${a.code}}` : ''}${a.warnings.length ? `  warnings: ${a.warnings.join(' | ')}` : ''}`);
  console.log(`  control.paused: ${r.paused ? `${r.paused.reason}: ${r.paused.detail}` : 'null'}`);
  if (r.afterResume) {
    const a = r.afterResume;
    console.log(`  after hub lander resume: ${a.id}: ${a.status}${a.code ? ` {${a.code}}` : ''}${a.warnings.length ? `  warnings: ${a.warnings.join(' | ')}` : ''}`);
    console.log(`  control.paused after resume + 1 attempt: ${r.pausedAfterResume ? `${r.pausedAfterResume.reason}: ${r.pausedAfterResume.detail}` : 'null'}`);
  }
  if (r.afterAccept) {
    const a = r.afterAccept;
    console.log(`  (info) after hub lander resume --accept-trunk <foreign sha>: ${a.id}: ${a.status}${a.code ? ` {${a.code}}` : ''}`);
  }
  console.log(`  hub emitted trunk.moved {foreign: true} for the foreign commit: ${r.foreignReported}`);
  for (const l of r.trunkReportErrors.slice(0, 3)) console.log(`  lander log: ${l}`);
}

const healthy = (r) => r.first === 'landed' && r.after.every((a) => a.status === 'landed') && r.paused === null && (!r.afterResume || r.afterResume.status === 'landed');

// Control: a plain foreign commit (no trailer-like line). Must land normally.
const control = await run('control: foreign push, plain message', 'hand fix\n\nno trailers here\n', { rounds: 1 });
show(control);
if (!healthy(control)) {
  console.error('\nINCONCLUSIVE: the control run did not land normally; the rig is broken.');
  process.exit(2);
}

// The finding's scenario: an over-long Agenthub-Source value (> 64 chars).
const longSource = await run(
  'A: foreign push with "Agenthub-Source: <118 chars of prose>"',
  `hand fix\n\nAgenthub-Source: ${'not a sha, see the incident notes in the wiki for details'.repeat(2)}\n`,
  { rounds: 3, resume: true },
);
show(longSource);

// A second shape: a short Agenthub-Hub value holding a bidi control (U+202E), which PATH_FORBIDDEN_RE refuses.
const bidiHub = await run('B: foreign push with "Agenthub-Hub: abc\\u202Edef"', 'hand fix\n\nAgenthub-Hub: abc\u202Edef\n', { rounds: 1 });
show(bidiHub);

const broken = [longSource, bidiHub].filter((r) => !healthy(r));
console.log('');
if (broken.length > 0) {
  console.error(
    `DEFECT PRESENT (R-34): after a foreign trunk commit with a malformed Agenthub-* trailer, unrelated landings fail instead of landing (${broken
      .map((r) => r.label.split(':')[0])
      .join(', ')}).`,
  );
  process.exit(1);
}
console.log('No defect: foreign commits with malformed trailers are reported and unrelated landings still land.');
process.exit(0);
