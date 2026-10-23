// R-11 reproduction: `externalPushes: pause` is bypassed by a hand-pushed
// trunk commit that carries agenthub trailers (Landing + Hub + Source), and
// the hub reconciles a queued landing to `landed` from a forged commit.
//
// Every case builds its own world from the BUILT packages under
// ${AGENTHUB_ROOT}/packages/*/dist (default /home/user/agenthub):
//   - a local bare remote (receive.denyNonFastForwards, NO host rule: no update
//     hook, as design §4.1 #1 "without the host rule, it is detected");
//   - trunk's agenthub.json with land.externalPushes "pause" and a check
//     command (node check.mjs: logs each run, fails on a marker);
//   - a real Hub (SqliteStore :memory:) served by its own startServer on
//     127.0.0.1:0;
//   - a real Lander (HubClient over HTTP, openGitPort, ChecksRunner), driven
//     with run({once: true}). No resolver (none is needed), no network, no
//     API key.
//
// Cases:
//   A control  a plain hand-pushed commit                     -> expect pause (harness sanity)
//   B forged   same push, message ends with trailers naming acme/web/L-99,
//              the hub's epoch (from GET /events, as any agent can) and any sha
//   C copy     `git commit -C <landed squash commit>` with other content, pushed
//   D own      an agent pushes an unchecked commit straight to main whose
//              trailers name its own QUEUED landing (Source = its commit)
//
// Correct behaviour (design §2.2.5 P1, §4.1 #1, §2.2.7 "only a recorded
// candidate can reach trunk"): in B, C and D the commit never went through the
// queue, so it is foreign and `externalPushes: pause` stops landing; in D the
// queued landing must not become `landed`.
//
// Exit 1 when the defect is present, 0 when not, 2 when the control (A) fails
// (the harness itself is broken).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (pkg, file) => pathToFileURL(path.join(ROOT, 'packages', pkg, 'dist', file)).href;

// Never let a real key or a developer's hub settings leak into the run.
for (const k of Object.keys(process.env)) if (k.startsWith('ANTHROPIC_') || k.startsWith('HUB_')) delete process.env[k];

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
const MARKER = 'FAIL' + '!';

const CHECK_MJS = `import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const gate = process.env.AGENTHUB_TEST_GATE;
if (gate) appendFileSync(gate + '/runs.log', (process.env.AGENTHUB_LANDING ?? '?') + ' ' + process.cwd() + '\\n');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\\0').filter(Boolean);
const bad = files.filter((f) => { try { return readFileSync(f, 'utf8').includes('FAIL' + '!'); } catch { return false; } });
if (bad.length) { for (const f of bad) console.log(' FAIL  ' + f + ' > checks > has no failure marker'); process.exit(1); }
console.log('checked ' + files.length + ' files: ok');
`;

let tick = 0;
function gitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  const t = `${BASE_TIME + 60 * ++tick} +0000`;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Some Human',
    GIT_AUTHOR_EMAIL: 'human@example.com',
    GIT_COMMITTER_NAME: 'Some Human',
    GIT_COMMITTER_EMAIL: 'human@example.com',
    GIT_AUTHOR_DATE: t,
    GIT_COMMITTER_DATE: t,
    ...extra,
  };
}
function git(cwd, args, extra) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}
function writeFiles(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
}

class World {
  static async create(name) {
    const w = new World();
    w.name = name;
    w.dir = realpathSync(mkdtempSync(path.join(here, `run-${name}-`)));
    w.remote = path.join(w.dir, 'remote.git');
    w.gate = path.join(w.dir, 'gate');
    w.workdir = path.join(w.dir, 'lander');
    w.seed = path.join(w.dir, 'seed');
    w.clones = 0;
    w.events = [];
    w.logs = [];
    mkdirSync(w.gate);
    git(w.dir, ['init', '-q', '--bare', '-b', 'main', w.remote]);
    git(w.remote, ['config', 'receive.denyNonFastForwards', 'true']);
    mkdirSync(w.seed);
    git(w.seed, ['init', '-q', '-b', 'main']);
    const agenthubJson = `${JSON.stringify({ project: P, land: { check: 'node check.mjs', checkEnv: { AGENTHUB_TEST_GATE: w.gate }, externalPushes: 'pause' } }, null, 2)}\n`;
    writeFiles(w.seed, { 'README.md': '# demo\n', 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 1;\n', 'check.mjs': CHECK_MJS, 'agenthub.json': agenthubJson });
    git(w.seed, ['add', '-A']);
    git(w.seed, ['commit', '-q', '-m', 'seed']);
    git(w.seed, ['remote', 'add', 'origin', w.remote]);
    git(w.seed, ['push', '-q', 'origin', 'main']);

    w.hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
    w.hub.subscribe((e) => w.events.push(e));
    w.front = await startServer({ hub: w.hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
    await initWorkdir({ dir: w.workdir, remote: w.remote });
    const mirror = path.join(w.workdir, 'mirror.git');
    const agent = landerId('lander/test');
    const PATH = process.env.PATH ?? '';
    w.lander = new Lander({
      hub: new HubClient({ url: w.front.url, project: P, agent, landerToken: null }),
      git: openGitPort({ mirror, remote: 'origin', env: { PATH } }),
      checks: new ChecksRunner({ workdir: w.workdir, mirror, env: { ...process.env, PATH }, killGraceMs: 2_000 }),
      resolver: null,
      log: (line) => w.logs.push(line),
      agent,
      project: P,
      committer: LANDER,
      drivers: await detectDrivers({ PATH }),
      trunk: 'main',
      leaseTtlMs: 10_000,
      timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
      workdir: w.workdir,
      host: 'test',
    });
    return w;
  }

  /** run --once: startup trunk scan, one admission round, at most one landing. */
  async once() {
    await this.lander.run({ once: true });
  }

  /** Admission only: the landing becomes queued (with its holds); nothing is attempted. */
  async admit() {
    await this.lander.ensureLease();
    try {
      await this.lander.admitRound();
    } finally {
      await this.lander.lease.release();
    }
  }

  clone(agent) {
    const dir = path.join(this.dir, `clone-${++this.clones}`);
    git(this.dir, ['clone', '-q', this.remote, dir]);
    return { dir, agent };
  }

  commit(c, message, files) {
    writeFiles(c.dir, files);
    git(c.dir, ['add', '-A']);
    git(c.dir, ['commit', '-q', '-m', message]);
    return git(c.dir, ['rev-parse', 'HEAD']);
  }

  /** As the adapter's `land`: push the land ref, then POST /land {queue: true}. */
  land(c, extra = {}) {
    const H = git(c.dir, ['rev-parse', 'HEAD']);
    git(c.dir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
    git(c.dir, ['fetch', '-q', 'origin', 'main']);
    const files = git(c.dir, ['diff', '--name-only', `origin/main...${H}`]).split('\n').filter(Boolean);
    return this.hub.land(P, c.agent, { ...extra, queue: true, commit: H, files }).landing;
  }

  /** A human's push straight to trunk (no host rule here), from the seed clone. `commitArgs` replaces `-m message`. */
  foreignPush(files, commitArgs) {
    git(this.seed, ['fetch', '-q', 'origin', 'main']);
    git(this.seed, ['reset', '-q', '--hard', 'origin/main']);
    writeFiles(this.seed, files);
    git(this.seed, ['add', '-A']);
    git(this.seed, ['commit', '-q', ...commitArgs]);
    const sha = git(this.seed, ['rev-parse', 'HEAD']);
    git(this.seed, ['push', '-q', 'origin', 'main']);
    return sha;
  }

  /** The hub's epoch as any agent reads it: GET /events returns it. */
  async epochAsAgent(agent) {
    const r = await fetch(`${this.front.url}/v1/p/${encodeURIComponent(P)}/events?wait_ms=0`, { headers: { 'x-hub-agent': agent } });
    const body = await r.json();
    if (!body.epoch) throw new Error(`GET /events gave no epoch: ${JSON.stringify(body)}`);
    return body.epoch;
  }

  trunk() {
    return git(this.remote, ['rev-parse', 'refs/heads/main']);
  }
  parent(sha) {
    return git(this.remote, ['rev-parse', `${sha}^1`]);
  }
  paused() {
    return this.hub.store.getLanderControl(P).paused?.reason ?? null;
  }
  landing(id) {
    return this.hub.getLanding(P, id);
  }
  moved(to) {
    return this.events.filter((e) => e.type === 'trunk.moved' && e.data.to === to).map((e) => e.data);
  }
  checkRuns(id) {
    const f = path.join(this.gate, 'runs.log');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith(`${id} `)) : [];
  }

  async close() {
    await this.front.close();
    await new Promise((r) => setTimeout(r, 50));
    this.hub.store.close?.();
    if (!process.env.KEEP) rmSync(this.dir, { recursive: true, force: true });
  }
}

const results = {};
const say = (s) => console.log(s);

async function withWorld(name, fn) {
  const w = await World.create(name);
  try {
    return await fn(w);
  } finally {
    await w.close();
  }
}

// ---------- A. control: a plain hand-pushed commit pauses landing.
results.A = await withWorld('A', async (w) => {
  await w.once(); // the hub learns where trunk is
  const F = w.foreignPush({ 'docs/hotfix.md': 'pushed by hand, never checked\n' }, ['-m', 'hotfix pushed by hand']);
  const a = w.clone('maya/claude-1');
  w.commit(a, 'a', { 'src/a.ts': 'export const a = 2;\n' });
  const L = w.land(a, { summary: 'a' });
  await w.once();
  return { F, moved: w.moved(F), paused: w.paused(), next: w.landing(L.id).status };
});
say(`A control (plain hand push): trunk.moved=${JSON.stringify(results.A.moved.map((m) => ({ foreign: m.foreign, landing_id: m.landing_id })))} paused=${results.A.paused} next landing=${results.A.next}`);
const controlOk = results.A.paused === 'external_push' && results.A.next !== 'landed';
if (!controlOk) {
  say('\nINCONCLUSIVE: the control case did not pause; the harness is not exercising externalPushes: pause');
  process.exit(2);
}

// ---------- B. the same push, with trailers naming no landing of this hub.
results.B = await withWorld('B', async (w) => {
  await w.once();
  const epoch = await w.epochAsAgent('sam/claude-1');
  const msg = `hotfix pushed by hand\n\nAgenthub-Landing: ${P}/L-99\nAgenthub-Hub: ${epoch}\nAgenthub-Source: ${'a'.repeat(40)}\n`;
  const F = w.foreignPush({ 'docs/hotfix.md': 'pushed by hand, never checked\n' }, ['-m', msg]);
  const a = w.clone('maya/claude-1');
  w.commit(a, 'a', { 'src/a.ts': 'export const a = 2;\n' });
  const L = w.land(a, { summary: 'a' });
  await w.once();
  const l = w.landing(L.id);
  return { F, moved: w.moved(F), paused: w.paused(), next: l.status, nextOnTopOfF: l.trunk_sha ? w.parent(l.trunk_sha) === F : false };
});
{
  const r = results.B;
  const hubForeign = r.moved.some((m) => m.foreign === true);
  r.defect = r.paused !== 'external_push';
  say(
    `B forged trailers (L-99, epoch, any sha): hub trunk.moved foreign=${hubForeign} paused=${r.paused} next landing=${r.next}${r.nextOnTopOfF ? ' (landed directly on top of the unchecked commit)' : ''} -> ${r.defect ? 'DEFECT' : 'ok'}`,
  );
}

// ---------- C. `git commit -C <landed squash commit>` with other content.
results.C = await withWorld('C', async (w) => {
  const a = w.clone('maya/claude-1');
  w.commit(a, 'a', { 'src/a.ts': 'export const a = 2;\n' });
  const L1 = w.land(a, { summary: 'a' });
  await w.once();
  const C1 = w.landing(L1.id).trunk_sha;
  if (!C1) throw new Error(`C: L1 did not land: ${JSON.stringify(w.landing(L1.id))}\n${w.logs.join('\n')}`);
  // A human reuses the landed commit's message (git commit -C), with unchecked content, and pushes it.
  const F = w.foreignPush({ 'docs/hotfix.md': 'unchecked\n', 'src/bad.ts': '// unchecked\n' }, ['-C', C1]);
  const msgF = git(w.remote, ['log', '-1', '--format=%B', F]);
  // The next landing fails its checks: its brief must not claim the checks pass on trunk.
  const b = w.clone('sam/claude-1');
  w.commit(b, 'b', { 'src/b.ts': `export const b = 2; // ${MARKER}\n` });
  const L2 = w.land(b, { summary: 'b, which fails its checks' });
  await w.once();
  const l2 = w.landing(L2.id);
  const pausedAfterL2 = w.paused();
  // And a good landing after it lands on top of the unchecked commit.
  const c = w.clone('lee/claude-1');
  w.commit(c, 'c', { 'src/c.ts': 'export const c = 1;\n' });
  const L3 = w.land(c, { summary: 'c' });
  await w.once();
  const l3 = w.landing(L3.id);
  return {
    F,
    copiedTrailers: /Agenthub-Checked:/.test(msgF) && /Agenthub-Hub:/.test(msgF),
    moved: w.moved(F),
    pausedAfterL2,
    paused: w.paused(),
    L2: { status: l2.status, ran: w.checkRuns(L2.id).length, passes_on_trunk: l2.report?.check?.passes_on_trunk ?? null },
    L3: { status: l3.status, onTopOfF: l3.trunk_sha ? git(w.remote, ['merge-base', '--is-ancestor', F, l3.trunk_sha]) === '' : false },
  };
});
{
  const r = results.C;
  r.defect = r.paused !== 'external_push' || !r.moved.some((m) => m.foreign === true);
  say(
    `C commit -C <landed> + other content: trunk.moved events for it=${JSON.stringify(r.moved)} paused=${r.paused}; failing L2: ${r.L2.status} (check ran ${r.L2.ran}x, passes_on_trunk=${r.L2.passes_on_trunk}); next good landing=${r.L3.status}${r.L3.onTopOfF ? ' (on top of the unchecked commit)' : ''} -> ${r.defect ? 'DEFECT' : 'ok'}`,
  );
}

// ---------- D. an agent pushes an unchecked commit straight to main with its own queued landing's identity.
results.D = await withWorld('D', async (w) => {
  await w.once();
  const a = w.clone('maya/claude-1');
  const task = w.hub.createTask(P, a.agent, { title: 'change a' });
  w.hub.takeTask(P, a.agent, task.id);
  const H = w.commit(a, 'a', { 'src/a.ts': 'export const a = 2;\n' });
  const L = w.land(a, { summary: 'a', task_id: task.id });
  await w.admit();
  const queued = w.landing(L.id);
  const holdsBefore = w.hub.listClaims(P, { include_ended: true }).filter((c) => c.landing_id === L.id);
  const epoch = await w.epochAsAgent(a.agent);
  // HUB_GUARD=off, no host rule: the agent pushes its change plus content that fails the checks, straight to main.
  writeFiles(a.dir, { 'src/unchecked.ts': `// ${MARKER} never checked\n` });
  git(a.dir, ['add', '-A']);
  git(a.dir, ['fetch', '-q', 'origin', 'main']);
  git(a.dir, ['reset', '-q', '--soft', 'origin/main']);
  git(a.dir, ['commit', '-q', '-m', `change a\n\nAgenthub-Landing: ${P}/${L.id}\nAgenthub-Hub: ${epoch}\nAgenthub-Source: ${H}\n`]);
  const F = git(a.dir, ['rev-parse', 'HEAD']);
  git(a.dir, ['push', '-q', 'origin', `${F}:refs/heads/main`]);
  await w.once();
  const l = w.landing(L.id);
  const holdsAfter = w.hub.listClaims(P, { include_ended: true }).filter((c) => c.landing_id === L.id);
  return {
    L: L.id,
    statusBefore: queued.status,
    phaseBefore: queued.phase,
    candidateBefore: queued.candidate ?? null,
    F,
    after: { status: l.status, reconciled: l.reconciled, trunk_sha_is_F: l.trunk_sha === F, checkRuns: w.checkRuns(L.id).length },
    task: w.hub.listTasks(P).find((t) => t.id === task.id)?.status,
    holds: { before: holdsBefore.map((c) => c.status), after: holdsAfter.map((c) => c.status) },
    moved: w.moved(F),
    paused: w.paused(),
    trunkHasMarker: git(w.remote, ['show', `${F}:src/unchecked.ts`]).includes(MARKER),
  };
});
{
  const r = results.D;
  r.defect = r.after.status === 'landed' || r.paused !== 'external_push';
  say(
    `D agent forges its own queued ${r.L} (was ${r.statusBefore}, candidate ${r.candidateBefore}): after the scan ${r.L} is ${r.after.status} (reconciled=${r.after.reconciled}, trunk_sha=unchecked commit: ${r.after.trunk_sha_is_F}, check runs=${r.after.checkRuns}); task ${r.task}; holds ${JSON.stringify(r.holds.before)} -> ${JSON.stringify(r.holds.after)}; trunk.moved=${JSON.stringify(r.moved.map((m) => ({ foreign: m.foreign, landing_id: m.landing_id })))}; paused=${r.paused}; trunk carries the failure marker: ${r.trunkHasMarker} -> ${r.defect ? 'DEFECT' : 'ok'}`,
  );
}

const defects = ['B', 'C', 'D'].filter((k) => results[k].defect);
if (defects.length) {
  say(`\nDEFECT PRESENT (R-11): externalPushes: pause did not stop landing for hand-pushed commits carrying agenthub trailers (cases ${defects.join(', ')}); the control case paused.`);
  process.exit(1);
}
say('\nno defect: every hand-pushed commit paused landing, and no queued landing was reconciled from a forged commit');
process.exit(0);
