#!/usr/bin/env node
// R-17 reproduction: cancelling (T14) or superseding (T15, §3.9) a landing
// while its check (or the AI resolver) runs does not stop the attempt. The
// lander keeps running the dead landing's check/resolver to the end, and the
// single attempt loop takes no other landing meanwhile, although the hub has
// freed the running slot.
//
// Design: §1.4 T14 "A running lander's next fenced call gets 409 landing_stale,
// and it kills its check and stops"; §3.9 variants "L-8's lander gets
// landing_stale at its next call, kills the check, and never pushes".
// Code: packages/lander/src/pipeline.ts — the attempt's abort signal is
// AbortSignal.any([lease.signal, stopping]) (line 144); ChecksRunner.run and
// AiResolver.resolve get only that signal (lines 291-305, 378-393), and the
// lander makes no hub call about the landing until the step ends.
//
// Everything is local: an in-process Hub (SQLite :memory:) served over HTTP on
// 127.0.0.1:0 by @agenthub/hub's startServer; a local bare remote with an
// update hook (trunk only by the lander's committer; every ref update logged);
// the real Lander from lander/dist (HubClient, GitPort, ChecksRunner, and for
// scenario C an AiResolver whose --resolver-command is a gated stub that
// declines). No network, no API key, no real resolver.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// Env: AGENTHUB_ROOT (default /home/user/agenthub), R17_WINDOW_MS (default
// 10000: how long after the cancel/supersede a fixed lander gets to kill the
// dead landing's process and land the next one), R17_ONLY=A|B|C.
//
// Exit 1: the defect is present (in some scenario, the dead landing's check or
// resolver was still running at the end of the window, or the next landing had
// not landed). Exit 0: it is not. Exit 2: the harness broke.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, 'packages', rel)).href);
for (const k of Object.keys(process.env)) if (k.startsWith('HUB_') || k.startsWith('ANTHROPIC_') || k.startsWith('GIT_')) delete process.env[k];

const { Hub, SqliteStore, startServer } = await imp('hub/dist/index.js');
const { ChecksRunner } = await imp('lander/dist/checks.js');
const { landerId } = await imp('lander/dist/config.js');
const { detectDrivers } = await imp('lander/dist/drivers.js');
const { openGitPort } = await imp('lander/dist/git-port.js');
const { HubClient } = await imp('lander/dist/hub-client.js');
const { initWorkdir } = await imp('lander/dist/init.js');
const { Lander } = await imp('lander/dist/lander.js');
const { AiResolver } = await imp('lander/dist/resolver.js');

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const WINDOW_MS = Number(process.env.R17_WINDOW_MS || 10_000);
const ONLY = process.env.R17_ONLY || '';

class HarnessError extends Error {}

function gitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_')) env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Seed Human',
    GIT_AUTHOR_EMAIL: 'seed@example.com',
    GIT_AUTHOR_DATE: `${BASE_TIME} +0000`,
    GIT_COMMITTER_NAME: LANDER.name,
    GIT_COMMITTER_EMAIL: LANDER.email,
    GIT_COMMITTER_DATE: `${BASE_TIME} +0000`,
  });
  return { ...env, ...extra };
}

function sh(cwd, args, extra = {}) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(extra), encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new HarnessError(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(25);
  }
  if (!cond()) throw new HarnessError(`timed out waiting for ${what}`);
}

// The check: logs each run; when <gate>/block exists it takes it, says `started`,
// and holds until <gate>/release exists, writing a heartbeat while it lives.
const CHECK = `import { appendFileSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
const gate = process.env.AGENTHUB_TEST_GATE;
const landing = process.env.AGENTHUB_LANDING ?? '?';
if (gate) {
  appendFileSync(gate + '/runs.log', landing + ' ' + process.pid + '\\n');
  if (existsSync(gate + '/block')) {
    rmSync(gate + '/block', { force: true });
    writeFileSync(gate + '/started', landing);
    while (!existsSync(gate + '/release')) {
      writeFileSync(gate + '/alive-' + landing + '.tmp', String(Date.now()));
      renameSync(gate + '/alive-' + landing + '.tmp', gate + '/alive-' + landing);
      await new Promise((r) => setTimeout(r, 50));
    }
    appendFileSync(gate + '/finished.log', landing + '\\n');
  }
}
console.log('ok');
`;

// The resolver command (scenario C): holds until <gate>/resolver-release, with a heartbeat, then declines.
const GATED_RESOLVER = `import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
const gate = process.argv[2];
const input = JSON.parse(readFileSync(0, 'utf8'));
writeFileSync(gate + '/resolver-started', String(input.incoming && input.incoming.landing_id));
while (!existsSync(gate + '/resolver-release')) {
  writeFileSync(gate + '/resolver-alive.tmp', String(Date.now()));
  renameSync(gate + '/resolver-alive.tmp', gate + '/resolver-alive');
  await new Promise((r) => setTimeout(r, 50));
}
appendFileSync(gate + '/resolver-finished.log', 'done\\n');
process.stdout.write(JSON.stringify({ status: 'cannot_resolve', explanation: 'gated stub: declined', usage: { model: input.model, input_tokens: 0, output_tokens: 0 } }) + '\\n');
`;

const HOOK = `#!/bin/sh
ref="$1"; old="$2"; new="$3"
echo "$ref $old $new" >> "$GIT_DIR/ref-updates.log"
case "$ref" in
  refs/heads/main)
    case "$new" in 0000000000000000000000000000000000000000) echo "trunk can't be deleted" >&2; exit 1;; esac
    who=$(git log -1 --format='%cn <%ce>' "$new")
    if [ "$who" != "${LANDER.name} <${LANDER.email}>" ]; then echo "only the lander may update main (committer: $who)" >&2; exit 1; fi;;
esac
exit 0
`;

class Clone {
  tick = 0;
  constructor(dir, agent) {
    this.dir = dir;
    this.agent = agent;
    const human = agent.split('/')[0];
    this.author = { name: `${human} agent`, email: `${human}@example.com` };
  }
  env() {
    const t = `${BASE_TIME + 3600 + 60 * ++this.tick} +0000`;
    return { GIT_AUTHOR_NAME: this.author.name, GIT_AUTHOR_EMAIL: this.author.email, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
  }
  commit(message, files) {
    for (const [f, c] of Object.entries(files)) {
      const p = path.join(this.dir, f);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, c);
    }
    sh(this.dir, ['add', '-A']);
    sh(this.dir, ['commit', '-q', '-m', message], this.env());
    return sh(this.dir, ['rev-parse', 'HEAD']).trim();
  }
}

class World {
  logs = [];
  clones = 0;
  bg = null;

  static async create(o = {}) {
    const w = new World();
    await w.setup(o);
    return w;
  }

  async setup(o) {
    const base = process.env.R17_TMP || tmpdir();
    mkdirSync(base, { recursive: true });
    this.dir = realpathSync(mkdtempSync(path.join(base, 'r17-')));
    this.remote = path.join(this.dir, 'remote.git');
    this.gate = path.join(this.dir, 'gate');
    this.workdir = path.join(this.dir, 'lander');
    mkdirSync(this.gate);
    sh(this.dir, ['init', '-q', '--bare', '-b', 'main', this.remote]);
    sh(this.remote, ['config', 'receive.denyNonFastForwards', 'true']);
    const seed = path.join(this.dir, 'seed');
    mkdirSync(seed);
    sh(seed, ['init', '-q', '-b', 'main']);
    const files = {
      'README.md': '# demo\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      'src/x.ts': 'export const x = 1;\n',
      'check.mjs': CHECK,
      'agenthub.json': `${JSON.stringify({ project: P, land: { check: 'node check.mjs', checkEnv: { AGENTHUB_TEST_GATE: this.gate }, resolver: { enabled: true } } }, null, 2)}\n`,
    };
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(seed, f)), { recursive: true });
      writeFileSync(path.join(seed, f), c);
    }
    sh(seed, ['add', '-A']);
    sh(seed, ['commit', '-q', '-m', 'seed']);
    sh(seed, ['remote', 'add', 'origin', this.remote]);
    sh(seed, ['push', '-q', 'origin', 'main']);
    writeFileSync(path.join(this.remote, 'hooks', 'update'), HOOK);
    chmodSync(path.join(this.remote, 'hooks', 'update'), 0o755);

    this.hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
    this.front = await startServer({ hub: this.hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
    await initWorkdir({ dir: this.workdir, remote: this.remote, log: () => undefined });

    const mirror = path.join(this.workdir, 'mirror.git');
    const PATH = process.env.PATH ?? '';
    const agent = landerId('lander/r17');
    const hub = new HubClient({ url: this.front.url, project: P, agent, landerToken: null });
    const git = openGitPort({ mirror, remote: 'origin', env: { PATH } });
    const log = (line) => this.logs.push(`${new Date().toISOString().slice(11, 23)} ${line}`);
    let resolver = null;
    if (o.resolver) {
      const script = path.join(this.dir, 'gated-resolver.mjs');
      writeFileSync(script, GATED_RESOLVER);
      resolver = new AiResolver({
        git,
        hub,
        project: P,
        command: `'${process.execPath}' '${script}' '${this.gate}'`,
        apiKey: null,
        maxPerHour: 20,
        scratchDir: path.join(this.workdir, 'runs'),
        env: { PATH },
        log,
      });
    }
    this.lander = new Lander({
      hub,
      git,
      checks: new ChecksRunner({ workdir: this.workdir, mirror, env: { ...process.env, PATH }, killGraceMs: 2_000 }),
      resolver,
      log,
      agent,
      project: P,
      committer: LANDER,
      drivers: await detectDrivers({ PATH }),
      trunk: 'main',
      leaseTtlMs: 10_000,
      timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
      workdir: this.workdir,
      host: 'test',
    });
  }

  clone(agent) {
    const c = new Clone(path.join(this.dir, `clone-${++this.clones}-${agent.split('/')[0]}`), agent);
    sh(this.dir, ['clone', '-q', this.remote, c.dir]);
    return c;
  }

  task(c, title) {
    const t = this.hub.createTask(P, c.agent, { title });
    this.hub.takeTask(P, c.agent, t.id);
    return t.id;
  }

  /** As `land` does: push the land ref, then land {queue: true}. */
  land(c, o) {
    const H = sh(c.dir, ['rev-parse', 'HEAD']).trim();
    sh(c.dir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
    sh(c.dir, ['fetch', '-q', 'origin', 'main']);
    const files = sh(c.dir, ['diff', '--name-only', `origin/main...${H}`]).split('\n').filter(Boolean);
    return this.hub.land(P, c.agent, { ...o, queue: true, commit: H, files }).landing;
  }

  landing(id) {
    return this.hub.getLanding(P, id);
  }

  /** A heartbeat file (replaced atomically every 50 ms) younger than 1 s means the gated process still lives. */
  alive(file) {
    const f = path.join(this.gate, file);
    try {
      const t = Number(readFileSync(f, 'utf8'));
      return Number.isFinite(t) && t > 0 && Date.now() - t < 1_000;
    } catch {
      return false;
    }
  }

  read(file) {
    const f = path.join(this.gate, file);
    return existsSync(f) ? readFileSync(f, 'utf8') : '';
  }

  /** Remote ref updates (from the update hook) of candidate refs for `landingId`. */
  candidateRefUpdates(landingId) {
    const f = path.join(this.remote, 'ref-updates.log');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.includes(`/cand/`) && l.includes(`/${landingId}/`))
      .map((l) => {
        const [ref, , nw] = l.split(' ');
        return `${/^0+$/.test(nw) ? 'deleted' : 'created'} ${ref}`;
      });
  }

  trunkFile(file) {
    try {
      return sh(this.remote, ['show', `main:${file}`]);
    } catch {
      return null;
    }
  }

  background() {
    this.bg = this.lander.run();
  }

  release() {
    writeFileSync(path.join(this.gate, 'release'), '');
    writeFileSync(path.join(this.gate, 'resolver-release'), '');
  }

  async close() {
    this.release();
    if (this.bg) {
      this.lander.stop();
      await Promise.race([this.bg.catch(() => undefined), sleep(15_000)]);
    }
    await this.front.close();
    await sleep(50);
    this.hub.store.close?.();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * After the dead landing's attempt was ended at the hub (t0): for WINDOW_MS,
 * watch whether its gated process dies and whether `nextId` lands.
 */
async function observe(w, { deadId, heartbeat, nextId }) {
  const t0 = Date.now();
  let killedAfter = null;
  let staleSince = null;
  let nextLandedAfter = null;
  const statuses = new Set();
  while (Date.now() - t0 < WINDOW_MS) {
    // Dead = no heartbeat for 3 polls in a row.
    if (w.alive(heartbeat)) staleSince = null;
    else staleSince ??= { at: Date.now() - t0, polls: 0 };
    if (staleSince && ++staleSince.polls >= 3 && killedAfter === null) killedAfter = staleSince.at;
    const st = w.landing(nextId);
    statuses.add(`${st.status}${st.phase ? `/${st.phase}` : ''}`);
    if (nextLandedAfter === null && st.status === 'landed') nextLandedAfter = Date.now() - t0;
    if (killedAfter !== null && nextLandedAfter !== null) break;
    await sleep(50);
  }
  const nxt = w.landing(nextId);
  return {
    dead: deadId,
    deadStatus: w.landing(deadId).status,
    deadProcessKilledAfterMs: killedAfter,
    deadProcessAliveAtWindowEnd: killedAfter === null,
    next: nextId,
    nextStatusesSeen: [...statuses],
    nextStatusAtWindowEnd: `${nxt.status}${nxt.phase ? `/${nxt.phase}` : ''}`,
    nextLandedAfterMs: nextLandedAfter,
  };
}

/** After the gate opens: the next landing must land (the control), and the dead one must never reach trunk. */
async function settle(w, nextId, what) {
  const t = Date.now();
  w.release();
  try {
    await waitFor(() => w.landing(nextId).status === 'landed', `${nextId} to land after the gate opened (${what})`, 60_000);
  } catch (e) {
    throw new HarnessError(`${e.message}; ${nextId} is ${JSON.stringify(w.landing(nextId).status)}; lander log tail:\n  ${w.logs.slice(-15).join('\n  ')}`);
  }
  return Date.now() - t;
}

function logSince(w, n) {
  return w.logs.slice(n).map((l) => `    ${l}`);
}

// ---------------------------------------------------------------- A: cancel during the check (T14)
async function scenarioA() {
  const w = await World.create();
  try {
    const a = w.clone('maya/claude-1');
    const b = w.clone('sam/claude-1');
    const ta = w.task(a, 'a=2');
    a.commit('a', { 'src/a.ts': 'export const a = 2;\n' });
    writeFileSync(path.join(w.gate, 'block'), '');
    const L1 = w.land(a, { task_id: ta, summary: 'a' });
    w.background();
    await waitFor(() => w.read('started') === L1.id && w.alive(`alive-${L1.id}`), `${L1.id}'s check to start`);
    const logMark = w.logs.length;
    const cancelled = w.hub.cancelLanding(P, a.agent, L1.id).landing;
    if (cancelled.status !== 'cancelled') throw new HarnessError(`cancel left ${L1.id} ${cancelled.status}`);
    const tb = w.task(b, 'b=2');
    b.commit('b', { 'src/b.ts': 'export const b = 2;\n' });
    const L2 = w.land(b, { task_id: tb, summary: 'b' });
    const obs = await observe(w, { deadId: L1.id, heartbeat: `alive-${L1.id}`, nextId: L2.id });
    const logDuringWindow = logSince(w, logMark);
    const settleMs = await settle(w, L2.id, 'A');
    await sleep(300);
    return {
      name: `A: ${L1.id} cancelled by its author while its check runs; ${L2.id} (another agent, another file) queued behind it`,
      ...obs,
      deadCheckRanToCompletion: w.read('finished.log').includes(L1.id),
      nextLandedMsAfterGateOpened: settleMs,
      candidateRefsForDead: w.candidateRefUpdates(L1.id),
      deadChangeOnTrunk: w.trunkFile('src/a.ts') === 'export const a = 2;\n',
      logDuringWindow,
      logAfterRelease: logSince(w, logMark + logDuringWindow.length),
    };
  } finally {
    await w.close();
  }
}

// ---------------------------------------------------------------- B: superseded by the author's fixed re-land (T15, §3.9)
async function scenarioB() {
  const w = await World.create();
  try {
    const a = w.clone('maya/claude-1');
    const ta = w.task(a, 'a');
    a.commit('a=2', { 'src/a.ts': 'export const a = 2;\n' });
    writeFileSync(path.join(w.gate, 'block'), '');
    const L1 = w.land(a, { task_id: ta, summary: 'a=2' });
    w.background();
    await waitFor(() => w.read('started') === L1.id && w.alive(`alive-${L1.id}`), `${L1.id}'s check to start`);
    const logMark = w.logs.length;
    a.commit('fix: a=3', { 'src/a.ts': 'export const a = 3;\n' });
    const L2 = w.land(a, { task_id: ta, summary: 'a=3 (fixed)' });
    const dead = w.landing(L1.id);
    if (dead.status !== 'superseded' || L2.supersedes !== L1.id) throw new HarnessError(`${L2.id} did not supersede ${L1.id} (${dead.status}, supersedes ${L2.supersedes})`);
    const obs = await observe(w, { deadId: L1.id, heartbeat: `alive-${L1.id}`, nextId: L2.id });
    const logDuringWindow = logSince(w, logMark);
    const settleMs = await settle(w, L2.id, 'B');
    await sleep(300);
    return {
      name: `B: ${L1.id} superseded by its author's fixed re-land ${L2.id} while its check runs (§3.9)`,
      ...obs,
      deadCheckRanToCompletion: w.read('finished.log').includes(L1.id),
      nextLandedMsAfterGateOpened: settleMs,
      candidateRefsForDead: w.candidateRefUpdates(L1.id),
      trunkHasFix: w.trunkFile('src/a.ts') === 'export const a = 3;\n',
      logDuringWindow,
      logAfterRelease: logSince(w, logMark + logDuringWindow.length),
    };
  } finally {
    await w.close();
  }
}

// ---------------------------------------------------------------- C: cancel while the AI resolver runs (stub resolver)
async function scenarioC() {
  const w = await World.create({ resolver: true });
  try {
    const s = w.clone('sam/claude-1');
    const m = w.clone('maya/claude-1');
    const l = w.clone('lee/claude-1');
    const ts = w.task(s, 'x=3');
    s.commit('x=3', { 'src/x.ts': 'export const x = 3;\n' });
    const Ls = w.land(s, { task_id: ts, summary: 'x=3' });
    w.background();
    await waitFor(() => w.landing(Ls.id).status === 'landed', `${Ls.id} to land (setup)`);
    const tm = w.task(m, 'x=2');
    m.commit('x=2', { 'src/x.ts': 'export const x = 2;\n' });
    const Lm = w.land(m, { task_id: tm, summary: 'x=2' });
    await waitFor(() => w.read('resolver-started') === Lm.id && w.alive('resolver-alive'), `the resolver to start on ${Lm.id}`);
    const phase = w.landing(Lm.id).phase;
    const logMark = w.logs.length;
    const cancelled = w.hub.cancelLanding(P, m.agent, Lm.id).landing;
    if (cancelled.status !== 'cancelled') throw new HarnessError(`cancel left ${Lm.id} ${cancelled.status}`);
    const tl = w.task(l, 'b=2');
    l.commit('b=2', { 'src/b.ts': 'export const b = 2;\n' });
    const Ll = w.land(l, { task_id: tl, summary: 'b=2' });
    const obs = await observe(w, { deadId: Lm.id, heartbeat: 'resolver-alive', nextId: Ll.id });
    const logDuringWindow = logSince(w, logMark);
    const settleMs = await settle(w, Ll.id, 'C');
    await sleep(300);
    return {
      name: `C: ${Lm.id} cancelled by its author while the (stub) AI resolver runs on it (phase ${phase} at the cancel); ${Ll.id} queued behind it`,
      ...obs,
      deadResolverRanToCompletion: w.read('resolver-finished.log').includes('done'),
      nextLandedMsAfterGateOpened: settleMs,
      logDuringWindow,
      logAfterRelease: logSince(w, logMark + logDuringWindow.length),
    };
  } finally {
    await w.close();
  }
}

let defect = false;
try {
  const scenarios = { A: scenarioA, B: scenarioB, C: scenarioC };
  for (const [k, fn] of Object.entries(scenarios)) {
    if (ONLY && !ONLY.includes(k)) continue;
    const r = await fn();
    const bad = r.deadProcessAliveAtWindowEnd || r.nextLandedAfterMs === null;
    defect ||= bad;
    const { name, logDuringWindow, logAfterRelease, ...rest } = r;
    console.log(`\n=== ${name}`);
    for (const [key, v] of Object.entries(rest)) console.log(`  ${key}: ${JSON.stringify(v)}`);
    console.log(`  lander log during the ${WINDOW_MS} ms window after the cancel/supersede:${logDuringWindow.length ? '' : ' (nothing)'}`);
    for (const line of logDuringWindow) console.log(line);
    console.log('  lander log after the gate opened:');
    for (const line of logAfterRelease) console.log(line);
    console.log(
      bad
        ? `  -> DEFECT: ${r.deadProcessAliveAtWindowEnd ? `${r.dead}'s ${'deadResolverRanToCompletion' in r ? 'resolver' : 'check'} was still running ${WINDOW_MS} ms after ${r.dead} became ${r.deadStatus}` : ''}${r.deadProcessAliveAtWindowEnd && r.nextLandedAfterMs === null ? '; ' : ''}${r.nextLandedAfterMs === null ? `${r.next} had not landed (${r.nextStatusAtWindowEnd}); it landed ${r.nextLandedMsAfterGateOpened} ms after the dead landing's process was let finish` : ''}`
        : `  -> ok: ${r.dead}'s process stopped after ${r.deadProcessKilledAfterMs} ms and ${r.next} landed after ${r.nextLandedAfterMs} ms`,
    );
  }
} catch (err) {
  console.error(`HARNESS ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(2);
}
console.log(defect ? '\nR-17 REPRODUCED: a cancelled/superseded landing keeps the lander (and the queue) busy until its check/resolver ends.' : '\nR-17 not reproduced.');
process.exit(defect ? 1 : 0);
