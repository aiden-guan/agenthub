#!/usr/bin/env node
// R-10 reproduction: a .gitattributes below the repository root is not
// protected, so a landing can change trunk's merge attributes without a human,
// and every later merge then uses them (merge=union turns a real conflict
// into a "clean" merge that skips the resolver, the conflict report and the
// send-back).
//
// Everything is real and in process, from the built packages under
// $AGENTHUB_ROOT/packages/*/dist (default /home/user/agenthub): a local bare
// remote, the hub (Hub + SqliteStore ':memory:' served by startServer on
// 127.0.0.1:0), and the lander (Lander over HubClient, openGitPort,
// ChecksRunner, and the AiResolver driving the stub resolver in "decline"
// mode). No network, no API key.
//
// Steps:
//   0. control: rio lands a ROOT .gitattributes -> admission marks it
//      protected and asks for an approval (expected behaviour).
//   1. maya lands src/.gitattributes ('*.ts merge=union') -> DEFECT if it is
//      admitted with no protected paths, no approval, and lands.
//   2. sam and kai both change line 1 of src/a.ts (a = 2 vs a = 3) and of
//      lib/c.ts (c = 2 vs c = 3), from the same base.
//      sam lands first. kai's landing then conflicts on both files for real.
//      lib/c.ts (not covered by the nested attributes) -> reported conflict
//      (the resolver is asked and declines; landing fails with 'conflict').
//      To show the src/ side on its own, kai's src change and lib change are
//      separate landings (kai and kai2).
//      DEFECT if kai's src/a.ts landing lands with resolved_by 'clean', the
//      resolver never asked, and trunk's src/a.ts holds both sides' lines.
//
// Exit 1 when the defect is present, 0 when it is fixed (nested .gitattributes
// protected, or its attributes not taking effect without approval), 2 on a
// harness error.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const dist = (pkg, file) => pathToFileURL(path.join(ROOT, 'packages', pkg, 'dist', file)).href;
const KEEP = process.env.KEEP === '1';

const { Hub, SqliteStore, startServer } = await import(dist('hub', 'index.js'));
const { ChecksRunner } = await import(dist('lander', 'checks.js'));
const { landerId } = await import(dist('lander', 'config.js'));
const { detectDrivers } = await import(dist('lander', 'drivers.js'));
const { openGitPort } = await import(dist('lander', 'git-port.js'));
const { HubClient } = await import(dist('lander', 'hub-client.js'));
const { initWorkdir } = await import(dist('lander', 'init.js'));
const { Lander } = await import(dist('lander', 'lander.js'));
const { AiResolver } = await import(dist('lander', 'resolver.js'));
const { parseTeamSections, protectedMatches } = await import(dist('contract', 'index.js'));
const STUB_RESOLVER = path.join(ROOT, 'packages', 'lander', 'test', 'fixtures', 'stub-resolver.mjs');

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;

function gitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|HUB_|ANTHROPIC_|AGENTHUB_)/.test(k)) env[k] = v;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', GIT_COMMITTER_NAME: LANDER.name, GIT_COMMITTER_EMAIL: LANDER.email, ...extra };
}
function sh(cwd, args, extra = {}) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(extra), encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'repro-R-10-')));
let tick = 0;
class Clone {
  constructor(name, agent) {
    this.dir = path.join(dir, name);
    this.agent = agent;
    this.human = agent.split('/')[0];
  }
  env() {
    const t = `${BASE_TIME + 60 * ++tick} +0000`;
    return { GIT_AUTHOR_NAME: `${this.human} agent`, GIT_AUTHOR_EMAIL: `${this.human}@example.com`, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
  }
  commit(message, files) {
    for (const [f, content] of Object.entries(files)) {
      const p = path.join(this.dir, f);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    sh(this.dir, ['add', '-A']);
    sh(this.dir, ['commit', '-q', '-m', message], this.env());
    return sh(this.dir, ['rev-parse', 'HEAD']).trim();
  }
}

const remote = path.join(dir, 'remote.git');
const workdir = path.join(dir, 'lander');
const stubConfig = path.join(dir, 'stub-resolver.json');
writeFileSync(stubConfig, JSON.stringify({ mode: 'decline' }));
const resolverCalls = () => (existsSync(`${stubConfig}.calls`) ? readFileSync(`${stubConfig}.calls`, 'utf8').split('\n').filter(Boolean) : []);

const agenthubJson = `${JSON.stringify({ project: P, land: { check: 'node check.mjs', protected: [], resolver: { enabled: true } } }, null, 2)}\n`;
const CHECK_MJS = "console.log('checks ok');\n";

let front = null;
let hub = null;
const results = [];
const verdict = (ok, what) => {
  results.push({ ok, what });
  console.log(`${ok ? 'ok    ' : 'DEFECT'} ${what}`);
};

try {
  // ---------------------------------------------------------------- world
  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  const seed = new Clone('seed', 'human/seed');
  mkdirSync(seed.dir);
  sh(seed.dir, ['init', '-q', '-b', 'main']);
  seed.commit('seed', {
    'README.md': '# demo\n',
    'src/a.ts': 'export const a = 1;\n',
    'lib/c.ts': 'export const c = 1;\n',
    'check.mjs': CHECK_MJS,
    'agenthub.json': agenthubJson,
  });
  sh(seed.dir, ['remote', 'add', 'origin', remote]);
  sh(seed.dir, ['push', '-q', 'origin', 'main']);

  hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const PATH = process.env.PATH ?? '';
  const agent = landerId('lander/test');
  const client = new HubClient({ url: front.url, project: P, agent, landerToken: null });
  const git = openGitPort({ mirror, remote: 'origin', env: { PATH } });
  const logs = [];
  const log = (line) => logs.push(line);
  const resolver = new AiResolver({
    git,
    hub: client,
    project: P,
    command: `${process.execPath} ${STUB_RESOLVER} ${stubConfig}`,
    apiKey: null,
    maxPerHour: 20,
    scratchDir: path.join(workdir, 'runs'),
    env: { PATH },
    log,
  });
  const lander = new Lander({
    hub: client,
    git,
    checks: new ChecksRunner({ workdir, mirror, env: { ...process.env, PATH }, killGraceMs: 2_000 }),
    resolver,
    log,
    agent,
    project: P,
    committer: LANDER,
    drivers: await detectDrivers({ PATH: '/nonexistent' }), // no structural tool: plain git, then the AI stage
    trunk: 'main',
    leaseTtlMs: 10_000,
    timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
    workdir,
    host: 'test',
  });

  let clones = 0;
  const clone = (agentName) => {
    const c = new Clone(`clone-${++clones}-${agentName.split('/')[0]}`, agentName);
    sh(dir, ['clone', '-q', remote, c.dir]);
    return c;
  };
  const land = (c, summary, base) => {
    const H = sh(c.dir, ['rev-parse', 'HEAD']).trim();
    sh(c.dir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
    const files = sh(c.dir, ['diff', '--name-only', `${base}...${H}`]).split('\n').filter(Boolean);
    return hub.land(P, c.agent, { queue: true, commit: H, files, summary }).landing;
  };
  const admit = async () => {
    await lander.ensureLease();
    try {
      return await lander.admitRound();
    } finally {
      await lander.lease.release();
    }
  };
  const TERMINAL = new Set(['landed', 'failed', 'cancelled', 'rejected', 'needs_approval']);
  const runUntil = async (ids) => {
    for (let i = 0; i < 12; i++) {
      if (ids.every((id) => TERMINAL.has(hub.getLanding(P, id).status))) return;
      await lander.run({ once: true });
    }
  };
  const trunk = () => sh(remote, ['rev-parse', 'refs/heads/main']).trim();
  const show = (rev, f) => sh(remote, ['show', `${rev}:${f}`]);
  const trailers = (rev) => sh(remote, ['log', '-1', '--format=%(trailers:only,unfold)', rev]);

  // ---------------------------------------------------------------- the rules, as the lander parses them from T0
  const rules = parseTeamSections(JSON.parse(agenthubJson), { strict: true }).sections.land.protected;
  console.log('protected rules from agenthub.json:', JSON.stringify(rules.map((r) => r.paths)));
  console.log('protectedMatches(.gitattributes):     ', JSON.stringify(protectedMatches(['.gitattributes'], rules).map((m) => m.paths)));
  console.log('protectedMatches(src/.gitattributes): ', JSON.stringify(protectedMatches(['src/.gitattributes'], rules).map((m) => m.paths)));

  // ---------------------------------------------------------------- 0. control: root .gitattributes
  const T00 = trunk();
  const rio = clone('rio/claude-1');
  rio.commit('rio: root attributes', { '.gitattributes': '*.ts merge=union\n' });
  const L0 = land(rio, 'root merge attributes', T00);
  await admit();
  const l0 = hub.getLanding(P, L0.id);
  console.log(`\n[0] root .gitattributes landing ${L0.id}: status=${l0.status} protected=${JSON.stringify(l0.protected)} approvals asked=${l0.approval.length}`);
  verdict(l0.protected.includes('.gitattributes') && l0.approval.length === 1, 'control: a root .gitattributes needs a human approval');
  hub.cancelLanding(P, rio.agent, L0.id, {});

  // ---------------------------------------------------------------- 1. nested src/.gitattributes
  const maya = clone('maya/claude-1');
  maya.commit('maya: tidy src attributes', { 'src/.gitattributes': '*.ts merge=union\n' });
  const L1 = land(maya, 'src attributes', T00);
  await admit();
  const q1 = hub.getLanding(P, L1.id);
  console.log(`\n[1] src/.gitattributes landing ${L1.id} at admission: status=${q1.status} protected=${JSON.stringify(q1.protected)} approvals asked=${q1.approval.length}`);
  await runUntil([L1.id]);
  const l1 = hub.getLanding(P, L1.id);
  const T1 = trunk();
  console.log(`    final: status=${l1.status} resolved_by=${l1.report?.resolved_by ?? null} trunk=${T1.slice(0, 12)}`);
  console.log(`    trunk src/.gitattributes: ${JSON.stringify(l1.status === 'landed' ? show(T1, 'src/.gitattributes') : null)}`);
  const nestedUnprotected = q1.protected.length === 0 && q1.approval.length === 0 && l1.status === 'landed' && !/Agenthub-Approved/.test(trailers(T1));
  verdict(!nestedUnprotected, 'a nested src/.gitattributes (merge attributes for src/**) needs a human approval');

  // ---------------------------------------------------------------- 2. a real conflict, after the nested attributes are on trunk
  const sam = clone('sam/claude-1');
  const kai = clone('kai/claude-1');
  const kai2 = clone('kai2/claude-1');
  const B = trunk();
  sam.commit('sam: a = 2, c = 2', { 'src/a.ts': 'export const a = 2;\n', 'lib/c.ts': 'export const c = 2;\n' });
  kai.commit('kai: a = 3', { 'src/a.ts': 'export const a = 3;\n' });
  kai2.commit('kai2: c = 3', { 'lib/c.ts': 'export const c = 3;\n' });
  const L2 = land(sam, 'a = 2, c = 2', B);
  await runUntil([L2.id]);
  const l2 = hub.getLanding(P, L2.id);
  const T2 = trunk();
  console.log(`\n[2] sam ${L2.id}: status=${l2.status} resolved_by=${l2.report?.resolved_by ?? null}; trunk src/a.ts=${JSON.stringify(show(T2, 'src/a.ts'))} lib/c.ts=${JSON.stringify(show(T2, 'lib/c.ts'))}`);
  if (l2.status !== 'landed') throw new Error(`harness: sam's landing did not land (${l2.status})`);

  // control conflict, outside src/: lib/c.ts c = 2 (trunk) vs c = 3 (kai2)
  const callsBefore = resolverCalls().length;
  const L3c = land(kai2, 'c = 3', B);
  await runUntil([L3c.id]);
  const l3c = hub.getLanding(P, L3c.id);
  const callsLib = resolverCalls().slice(callsBefore);
  console.log(`    kai2 ${L3c.id} (lib/c.ts, no nested attributes): status=${l3c.status} failure=${l3c.failure?.code ?? l3c.report?.failure?.code ?? null} resolver asked for=${JSON.stringify(callsLib)} trunk lib/c.ts=${JSON.stringify(show(trunk(), 'lib/c.ts'))}`);
  verdict(l3c.status !== 'landed', 'control: lib/c.ts c = 2 vs c = 3 is a reported conflict (not landed)');

  // the same conflict, under src/ (covered by the unapproved src/.gitattributes)
  const callsBefore2 = resolverCalls().length;
  const T3pre = trunk();
  const L3 = land(kai, 'a = 3', B);
  await runUntil([L3.id]);
  const l3 = hub.getLanding(P, L3.id);
  const T3 = trunk();
  const callsSrc = resolverCalls().slice(callsBefore2);
  const merged = l3.status === 'landed' ? show(T3, 'src/a.ts') : null;
  console.log(`    kai ${L3.id} (src/a.ts, under src/.gitattributes): status=${l3.status} resolved_by=${l3.report?.resolved_by ?? null} resolver asked for=${JSON.stringify(callsSrc)}`);
  console.log(`    trunk src/a.ts after: ${JSON.stringify(merged)}`);
  if (l3.status === 'landed') console.log(`    trailers of ${T3.slice(0, 12)}:\n      ${trailers(T3).trim().split('\n').join('\n      ')}`);
  const unionLanded =
    l3.status === 'landed' &&
    l3.report?.resolved_by === 'clean' &&
    callsSrc.length === 0 &&
    T3 !== T3pre &&
    merged === 'export const a = 2;\nexport const a = 3;\n' &&
    /Agenthub-Resolved: clean/.test(trailers(T3));
  verdict(!unionLanded, "src/a.ts a = 2 vs a = 3 is not turned into a 'clean' union merge by unapproved attributes");
} catch (err) {
  console.error('harness error:', err?.stack ?? err);
  process.exitCode = 2;
} finally {
  if (front) await front.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  hub?.store?.close?.();
  if (KEEP) console.log(`kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

if (process.exitCode !== 2) {
  const defects = results.filter((r) => !r.ok);
  const controlsFailed = defects.filter((r) => r.what.startsWith('control:'));
  if (controlsFailed.length > 0) {
    console.error('\nharness: a control did not behave as expected; the reproduction is inconclusive');
    process.exitCode = 2;
  } else if (defects.length > 0) {
    console.log(`\nR-10 REPRODUCED: ${defects.length} defect(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nR-10 not present');
    process.exitCode = 0;
  }
}
