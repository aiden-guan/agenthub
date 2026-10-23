#!/usr/bin/env node
// R-46 behaviour checks, run against the BUILT packages of ${AGENTHUB_ROOT}
// (default /home/user/agenthub): the tests the lander suite is missing.
//
//   A  I4 / §4.1 #7, #9: a change that rewrites agenthub.json (check "true",
//      protected [], resolver off) and adds a FAIL! file and a migration.
//      Trunk's check command at T0 must run and fail it (checks_failed), and
//      admission must protect agenthub.json and migrations/002.sql (T0's rules,
//      agenthub.json always).
//   B  I4 / §4.1 #9: the union attack through the pipeline. The change adds
//      `.gitattributes: src/a.ts merge=union` and conflicts on src/a.ts with a
//      landed change. Attributes come from T0 (--attr-source=T0), so this is a
//      conflict, never a silent union merge.
//   C  §4.1 #8: a change that deletes a test file and shrinks another one is
//      flagged on the landing (admission warnings, kept on the landed report).
//   D  I4: resolver settings come from T0. Trunk has the resolver off; the
//      change turns it on in its own agenthub.json; a stub resolver is
//      configured. The stub must never be called and the landing fails with
//      conflict.
//
// Prints one line per check and a final JSON summary line
// (`R46-SUMMARY {...}`). Exits 0 when every check passes, 1 when one fails.
// `node behavior.mjs A C` runs only those checks. No network, no API key:
// a local bare remote, the hub in process on 127.0.0.1:0, the stub resolver.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const { AiResolver } = await import(dist('lander', 'resolver.js'));
const { commandHash } = await import(dist('lander', 'report.js'));

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const CHECK = 'node check.mjs';

// The integration suite's check command (packages/lander/test/fixtures/check.mjs), inlined:
// logs "<landing> <cwd>" to $AGENTHUB_TEST_GATE/runs.log and fails on a tracked file holding the marker.
const CHECK_MJS = `import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const MARKER = 'FAIL' + '!';
const gate = process.env.AGENTHUB_TEST_GATE;
if (gate) appendFileSync(gate + '/runs.log', (process.env.AGENTHUB_LANDING ?? '?') + ' ' + process.cwd() + '\\n');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\\0').filter(Boolean);
const bad = files.filter((f) => { try { return readFileSync(f, 'utf8').includes(MARKER); } catch { return false; } });
if (bad.length > 0) { for (const f of bad) console.log(' FAIL  ' + f + ' > checks > has no failure marker'); process.exit(1); }
console.log('checked ' + files.length + ' files: ok');
`;

// The suite's own stub resolver (design §5 "The stub resolver"): no network, no key; it logs each call to <config>.calls.
const STUB_RESOLVER = path.join(ROOT, 'packages', 'lander', 'test', 'fixtures', 'stub-resolver.mjs');

const HOOK = `#!/bin/sh
ref="$1"; new="$3"
case "$ref" in
  refs/heads/main)
    case "$new" in 0000000000000000000000000000000000000000) exit 1;; esac
    who=$(git log -1 --format='%cn <%ce>' "$new")
    if [ "$who" != "${LANDER.name} <${LANDER.email}>" ]; then echo "only the lander may update main (committer: $who)" >&2; exit 1; fi;;
esac
exit 0
`;

function testEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_')) env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Maya Agent',
    GIT_AUTHOR_EMAIL: 'maya@example.com',
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
  read(f) {
    return readFileSync(path.join(this.dir, f), 'utf8');
  }
  commit(message, files) {
    for (const [f, c] of Object.entries(files)) {
      const p = path.join(this.dir, f);
      if (c === null) rmSync(p, { force: true });
      else {
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, c);
      }
    }
    sh(this.dir, ['add', '-A']);
    sh(this.dir, ['commit', '-q', '-m', message], this.env());
    return this.head();
  }
  head() {
    return sh(this.dir, ['rev-parse', 'HEAD']).trim();
  }
}

class World {
  clones = 0;
  logs = [];
  static async create(o = {}) {
    const w = new World(o);
    await w.setup();
    return w;
  }
  constructor(o) {
    this.o = o;
    this.dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'r46-')));
    this.remote = path.join(this.dir, 'remote.git');
    this.gate = path.join(this.dir, 'gate');
    this.workdir = path.join(this.dir, 'lander');
    this.stubConfig = path.join(this.dir, 'stub.json');
    mkdirSync(this.gate);
    this.hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
    this.seed = new Clone(path.join(this.dir, 'seed'), 'human/seed', { name: 'Seed Human', email: 'seed@example.com' });
  }
  agenthubJson(land = {}) {
    return `${JSON.stringify({ project: P, land: { check: CHECK, protected: ['migrations/**'], checkEnv: { AGENTHUB_TEST_GATE: this.gate }, resolver: { enabled: true }, ...this.o.land, ...land } }, null, 2)}\n`;
  }
  async setup() {
    sh(this.dir, ['init', '-q', '--bare', '-b', 'main', this.remote]);
    sh(this.remote, ['config', 'receive.denyNonFastForwards', 'true']);
    mkdirSync(this.seed.dir);
    sh(this.seed.dir, ['init', '-q', '-b', 'main']);
    this.seed.commit('seed', {
      'README.md': '# demo\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      'migrations/001.sql': 'create table users (id int);\n',
      ...this.o.seed,
      'check.mjs': CHECK_MJS,
      'agenthub.json': this.agenthubJson(),
    });
    sh(this.seed.dir, ['remote', 'add', 'origin', this.remote]);
    sh(this.seed.dir, ['push', '-q', 'origin', 'main']);
    writeFileSync(path.join(this.remote, 'hooks', 'update'), HOOK);
    chmodSync(path.join(this.remote, 'hooks', 'update'), 0o755);
    writeFileSync(this.stubConfig, JSON.stringify({ mode: 'union' }));
    this.front = await startServer({ hub: this.hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
    await initWorkdir({ dir: this.workdir, remote: this.remote });
    const mirror = path.join(this.workdir, 'mirror.git');
    const PATH = process.env.PATH ?? '';
    const hub = new HubClient({ url: this.front.url, project: P, agent: landerId('lander/test'), landerToken: null });
    const git = openGitPort({ mirror, remote: 'origin', env: { PATH } });
    const log = (l) => this.logs.push(l);
    const resolver = this.o.stubResolver
      ? new AiResolver({ git, hub, project: P, command: `${process.execPath} ${STUB_RESOLVER} ${this.stubConfig}`, apiKey: null, maxPerHour: 20, scratchDir: path.join(this.workdir, 'runs'), env: { PATH }, log })
      : null;
    this.lander = new Lander({
      hub,
      git,
      checks: new ChecksRunner({ workdir: this.workdir, mirror, env: { ...process.env, PATH }, killGraceMs: 2_000 }),
      resolver,
      log,
      agent: landerId('lander/test'),
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
    const human = agent.split('/')[0];
    const c = new Clone(path.join(this.dir, `clone-${++this.clones}-${human}`), agent, { name: `${human} agent`, email: `${human}@example.com` });
    sh(this.dir, ['clone', '-q', this.remote, c.dir]);
    return c;
  }
  land(c, o = {}) {
    const H = c.head();
    sh(c.dir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
    sh(c.dir, ['fetch', '-q', 'origin', 'main']);
    const files = sh(c.dir, ['diff', '--name-only', `origin/main...${H}`]).split('\n').filter(Boolean);
    return this.hub.land(P, c.agent, { ...o, queue: true, commit: H, files }).landing;
  }
  landing(id) {
    return this.hub.getLanding(P, id);
  }
  checkRuns(id) {
    const f = path.join(this.gate, 'runs.log');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith(`${id} `)) : [];
  }
  stubCalls() {
    const f = `${this.stubConfig}.calls`;
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
  }
  show(rev, f) {
    try {
      return sh(this.remote, ['show', `${rev}:${f}`]);
    } catch {
      return null;
    }
  }
  trunk() {
    return sh(this.remote, ['rev-parse', 'refs/heads/main']).trim();
  }
  async once() {
    await this.lander.run({ once: true });
  }
  async admit() {
    await this.lander.ensureLease();
    try {
      return await this.lander.admitRound();
    } finally {
      await this.lander.lease.release();
    }
  }
  async close() {
    await this.front.close();
    await new Promise((r) => setTimeout(r, 50));
    this.hub.store.close?.();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const brief = (l) => ({ status: l.status, failure: l.failure?.code ?? null, protected: l.protected, warnings: l.report?.warnings ?? [] });

const CHECKS = {
  async A() {
    const w = await World.create();
    try {
      const a = w.clone('maya/claude-1');
      const relaxed = JSON.parse(a.read('agenthub.json'));
      relaxed.land.check = 'true';
      relaxed.land.protected = [];
      relaxed.land.resolver = { enabled: false };
      a.commit('a: relax the config', { 'agenthub.json': `${JSON.stringify(relaxed, null, 2)}\n`, 'src/bad.ts': `// ${'FAIL'}!\nexport const bad = 1;\n`, 'migrations/002.sql': 'drop table users;\n' });
      const trunkBefore = w.trunk();
      const L = w.land(a, { summary: 'relax the config' });
      await w.admit();
      const admitted = w.landing(L.id);
      await w.once();
      const done = w.landing(L.id);
      const runs = w.checkRuns(L.id).length;
      const problems = [];
      if (!admitted.protected.includes('agenthub.json')) problems.push(`admission did not protect agenthub.json (protected=${JSON.stringify(admitted.protected)})`);
      if (!admitted.protected.includes('migrations/002.sql')) problems.push(`admission did not apply T0's protected rule migrations/** (protected=${JSON.stringify(admitted.protected)})`);
      if (done.status !== 'failed' || done.failure?.code !== 'checks_failed') problems.push(`expected failed/checks_failed (T0's check fails on FAIL!), got ${done.status}/${done.failure?.code ?? '-'}`);
      if (runs !== 1) problems.push(`T0's check command (node check.mjs) ran ${runs} times for ${L.id}, expected 1`);
      if (done.report?.check && done.report.check.command_hash !== commandHash(CHECK)) problems.push(`the check report's command_hash is not that of T0's "${CHECK}"`);
      if (w.trunk() !== trunkBefore) problems.push('trunk moved');
      return { problems, observed: { admitted: brief(admitted), done: brief(done), checkRuns: runs, trunkMoved: w.trunk() !== trunkBefore } };
    } finally {
      await w.close();
    }
  },

  async B() {
    const w = await World.create({ land: { resolver: { enabled: false } } });
    try {
      const a = w.clone('maya/claude-1');
      const b = w.clone('sam/claude-1'); // based on the seed, before a lands
      a.commit('a: a = 2', { 'src/a.ts': 'export const a = 2;\n' });
      const La = w.land(a, { summary: 'a = 2' });
      await w.once();
      const landedA = w.landing(La.id);
      b.commit('b: a = 3, union attributes', { '.gitattributes': 'src/a.ts merge=union\n', 'src/a.ts': 'export const a = 3;\n' });
      const trunkBefore = w.trunk();
      const Lb = w.land(b, { summary: 'a = 3' });
      await w.once();
      const done = w.landing(Lb.id);
      const problems = [];
      if (landedA.status !== 'landed') problems.push(`setup: the first change did not land (${landedA.status})`);
      if (done.status !== 'failed' || done.failure?.code !== 'conflict') problems.push(`expected failed/conflict (attributes from T0, no union), got ${done.status}/${done.failure?.code ?? '-'}`);
      if (w.trunk() !== trunkBefore) problems.push('trunk moved');
      return { problems, observed: { first: landedA.status, done: brief(done), checkRuns: w.checkRuns(Lb.id).length, trunkMoved: w.trunk() !== trunkBefore } };
    } finally {
      await w.close();
    }
  },

  async C() {
    const w = await World.create({ seed: { 'src/a.test.ts': 'it(1);\nit(2);\nit(3);\n', 'tests/test_x.py': 'def test_a(): pass\n' } });
    try {
      const a = w.clone('maya/claude-1');
      a.commit('a: fewer tests', { 'src/a.test.ts': 'it(1);\n', 'tests/test_x.py': null });
      const L = w.land(a, { summary: 'fewer tests' });
      await w.admit();
      const admitted = w.landing(L.id);
      await w.once();
      const done = w.landing(L.id);
      const problems = [];
      for (const [when, l] of [['admitted', admitted], ['landed', done]]) {
        const text = (l.report?.warnings ?? []).join('\n');
        if (!/deletes test files: .*tests\/test_x\.py/.test(text)) problems.push(`${when}: no "deletes test files" warning for tests/test_x.py`);
        if (!/removes more lines than it adds in test files: .*src\/a\.test\.ts/.test(text)) problems.push(`${when}: no "removes more lines" warning for src/a.test.ts`);
      }
      if (done.status !== 'landed') problems.push(`setup: expected it to land, got ${done.status}/${done.failure?.code ?? '-'}`);
      return { problems, observed: { admitted: brief(admitted), done: brief(done) } };
    } finally {
      await w.close();
    }
  },

  async D() {
    const w = await World.create({ land: { resolver: { enabled: false } }, stubResolver: true });
    try {
      const a = w.clone('maya/claude-1');
      const b = w.clone('sam/claude-1');
      a.commit('a: a = 2', { 'src/a.ts': 'export const a = 2;\n' });
      const La = w.land(a, { summary: 'a = 2' });
      await w.once();
      const landedA = w.landing(La.id);
      const on = JSON.parse(b.read('agenthub.json'));
      on.land.resolver = { enabled: true };
      b.commit('b: a = 3, resolver on', { 'agenthub.json': `${JSON.stringify(on, null, 2)}\n`, 'src/a.ts': 'export const a = 3;\n' });
      const trunkBefore = w.trunk();
      const Lb = w.land(b, { summary: 'a = 3' });
      await w.once();
      const done = w.landing(Lb.id);
      const calls = w.stubCalls();
      const problems = [];
      if (landedA.status !== 'landed') problems.push(`setup: the first change did not land (${landedA.status})`);
      if (calls.length !== 0) problems.push(`the resolver ran (${calls.length} call(s): ${calls.join(', ')}) although T0 has it off`);
      if (done.status !== 'failed' || done.failure?.code !== 'conflict') problems.push(`expected failed/conflict (resolver off at T0), got ${done.status}/${done.failure?.code ?? '-'}`);
      if (w.trunk() !== trunkBefore) problems.push('trunk moved');
      return { problems, observed: { first: landedA.status, done: brief(done), resolverCalls: calls.length, trunkMoved: w.trunk() !== trunkBefore } };
    } finally {
      await w.close();
    }
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHECKS);
const summary = {};
for (const name of wanted) {
  let r;
  try {
    r = await CHECKS[name]();
  } catch (err) {
    r = { problems: [`threw: ${err?.stack ?? err}`], observed: null };
  }
  summary[name] = { pass: r.problems.length === 0, problems: r.problems, observed: r.observed };
  console.log(`${r.problems.length === 0 ? 'PASS' : 'FAIL'} ${name}${r.problems.length ? `: ${r.problems.join('; ')}` : ''}`);
  console.log(`     observed: ${JSON.stringify(r.observed)}`);
}
console.log(`R46-SUMMARY ${JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.pass])))}`);
process.exit(Object.values(summary).every((v) => v.pass) ? 0 : 1);
