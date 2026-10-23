#!/usr/bin/env node
// R-16 reproduction: an approved resume of a parked landing runs the merge
// ladder (P4: plain, structural, AI resolver) again before the P6 fast path,
// and the fast path takes the parked candidate C only when the freshly merged
// tree equals C's. With resolver.requireApproval off, a landing parked for a
// protected-path approval has no ai_resolution approval, so the resolver's
// reuse path finds nothing and the resolver is called again. If that second
// call declines, times out, is over the hourly cap, or answers differently,
// the checked and approved C is not pushed: the landing fails {conflict} or
// builds a new candidate and runs the checks again. Trunk has not moved.
// The same happens when the resume runs on a standby lander without the
// structural driver that resolved the conflict the first time.
//
// Design: §3.7 step 4 (the approved resume "skips the merge and the checks
// and goes straight to pushing"), §3.4 last paragraph and §2.6 (an approved
// resume on an unchanged trunk pushes the same, already-checked C), §2.2.5 P6
// fast path, §0.3 #24 (only the exact checked candidate of a parked landing
// is reused, on an unchanged T0).
//
// Everything is local: a bare remote (non-fast-forwards denied, an update
// hook that lets only the lander's committer move main), agent clones, an
// in-process hub served over HTTP on 127.0.0.1:0, and a real lander
// (HubClient, GitPort, ChecksRunner, AiResolver) run in-process. The AI
// resolver is the repository's stub resolver (packages/lander/test/fixtures/
// stub-resolver.mjs) run as --resolver-command; the structural driver is the
// repository's fake Mergiraf. No network, no API key.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// Exit 1: the defect is present (in some variant the approved resume on an
// unchanged trunk did not push the parked, checked C as it is, or called the
// resolver / ran the checks again). Exit 0: every variant pushed C with no
// second resolver call and no second check run. Exit 2: the harness broke
// (a landing did not park as the scenario needs).

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, 'packages', rel)).href);
const FIXTURES = path.join(ROOT, 'packages', 'lander', 'test', 'fixtures');

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
const { AiResolver } = await imp('lander/dist/resolver.js');

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const approver = (name) => ({ lander: false, approver: name });

let tick = 0;
function gitEnv(who) {
  const t = `${BASE_TIME + 60 * ++tick} +0000`;
  const id = who ? { name: `${who} agent`, email: `${who}@example.com` } : LANDER;
  return { ...process.env, GIT_AUTHOR_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_NAME: id.name, GIT_COMMITTER_EMAIL: id.email, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
}
function sh(cwd, args, who) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(who), encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const HOOK = `#!/bin/sh
ref="$1"; new="$3"
case "$ref" in
  refs/heads/main)
    case "$new" in 0000000000000000000000000000000000000000) echo "trunk can't be deleted" >&2; exit 1;; esac
    who=$(git log -1 --format='%cn <%ce>' "$new")
    if [ "$who" != "${LANDER.name} <${LANDER.email}>" ]; then echo "only the lander may update main (committer: $who)" >&2; exit 1; fi;;
esac
exit 0
`;

const SEED_FILES = {
  'README.md': '# demo\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 1;\n',
  'src/session.ts': 'export function open(): number {\n  return 1;\n}\n',
  'migrations/001.sql': 'create table users (id int);\n',
};

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
}

/**
 * A fresh world. Trunk's agenthub.json is the integration tests' seeded config:
 * check `node check.mjs`, migrations/** protected, the resolver on,
 * requireApproval off (its default).
 */
async function world(name) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `r16-${name}-`)));
  const remote = path.join(dir, 'remote.git');
  const gate = path.join(dir, 'gate');
  const binDir = path.join(dir, 'bin');
  const stubConfig = path.join(dir, 'stub-resolver.json');
  mkdirSync(gate);
  mkdirSync(binDir);
  const wrapper = path.join(binDir, 'mergiraf');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIXTURES, 'fake-mergiraf.mjs')}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  writeFileSync(stubConfig, JSON.stringify({ mode: 'union' }));

  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  const seed = path.join(dir, 'seed');
  sh(dir, ['init', '-q', '-b', 'main', seed]);
  writeFiles(seed, {
    ...SEED_FILES,
    'check.mjs': readFileSync(path.join(FIXTURES, 'check.mjs'), 'utf8'),
    'agenthub.json': `${JSON.stringify({ project: P, land: { check: 'node check.mjs', protected: ['migrations/**'], checkEnv: { AGENTHUB_TEST_GATE: gate }, resolver: { enabled: true } } }, null, 2)}\n`,
  });
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-q', '-m', 'seed']);
  sh(seed, ['remote', 'add', 'origin', remote]);
  sh(seed, ['push', '-q', 'origin', 'main']);
  writeFileSync(path.join(remote, 'hooks', 'update'), HOOK);
  chmodSync(path.join(remote, 'hooks', 'update'), 0o755);

  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  const front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
  const logs = [];
  const landers = [];

  /** A lander with its own workdir; `mergiraf` puts the fake Mergiraf on its PATH; `resolver` is the stub or none. */
  async function makeLander(o) {
    const workdir = path.join(dir, `lander-${o.name}`);
    await initWorkdir({ dir: workdir, remote });
    const mirror = path.join(workdir, 'mirror.git');
    const PATH = o.mergiraf ? `${binDir}${path.delimiter}${process.env.PATH ?? ''}` : (process.env.PATH ?? '');
    const agent = landerId(`lander/${o.name}`);
    const client = new LanderHubClient({ url: front.url, project: P, agent, landerToken: null });
    const git = openGitPort({ mirror, remote: 'origin', env: { PATH } });
    const log = (l) => logs.push(`[${o.name}] ${l}`);
    const resolver = o.resolver
      ? new AiResolver({
          git,
          hub: client,
          project: P,
          command: `${process.execPath} ${path.join(FIXTURES, 'stub-resolver.mjs')} ${stubConfig}`,
          apiKey: null,
          maxPerHour: o.maxPerHour ?? 20,
          ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
          scratchDir: path.join(workdir, 'runs'),
          env: { PATH },
          log,
        })
      : null;
    const lander = new Lander({
      hub: client,
      git,
      checks: new ChecksRunner({ workdir, mirror, env: { ...process.env, PATH }, killGraceMs: 2_000 }),
      resolver,
      log,
      agent,
      project: P,
      committer: LANDER,
      drivers: await detectDrivers({ PATH }),
      trunk: 'main',
      leaseTtlMs: 10_000,
      timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
      workdir,
      host: o.name,
    });
    landers.push(lander);
    return lander;
  }

  const clone = (who) => {
    const c = path.join(dir, who);
    sh(dir, ['clone', '-q', remote, c], who);
    return { who, id: `${who}/claude-1`, dir: c };
  };

  return {
    hub,
    logs,
    makeLander,
    maya: clone('maya'),
    sam: clone('sam'),
    task(a, title) {
      const t = hub.createTask(P, a.id, { title });
      hub.takeTask(P, a.id, t.id);
      return t.id;
    },
    commit(a, files, msg) {
      writeFiles(a.dir, files);
      sh(a.dir, ['add', '-A'], a.who);
      sh(a.dir, ['commit', '-q', '-m', msg], a.who);
      return sh(a.dir, ['rev-parse', 'HEAD'], a.who).trim();
    },
    /** What `hub_land` does: push the land ref, then POST /land {queue: true}. */
    land(a, o) {
      const H = sh(a.dir, ['rev-parse', 'HEAD'], a.who).trim();
      sh(a.dir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`], a.who);
      sh(a.dir, ['fetch', '-q', 'origin', 'main'], a.who);
      const files = sh(a.dir, ['diff', '--name-only', `origin/main...${H}`], a.who).split('\n').filter(Boolean);
      return hub.land(P, a.id, { queue: true, commit: H, files, task_id: o.task_id, summary: o.summary }).landing;
    },
    landing: (id) => hub.getLanding(P, id),
    trunk: () => sh(remote, ['rev-parse', 'main']).trim(),
    remoteRef: (ref) => sh(remote, ['for-each-ref', '--format=%(objectname)', ref]).trim() || null,
    show: (rev, file) => {
      try {
        return sh(remote, ['show', `${rev}:${file}`]);
      } catch {
        return null;
      }
    },
    setStub: (cfg) => writeFileSync(stubConfig, JSON.stringify(cfg)),
    resolverCalls: () => (existsSync(`${stubConfig}.calls`) ? readFileSync(`${stubConfig}.calls`, 'utf8').split('\n').filter(Boolean).length : 0),
    checkRuns: (id) => {
      const f = path.join(gate, 'runs.log');
      return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith(`${id} `)).length : 0;
    },
    async close() {
      for (const l of landers) {
        try {
          await l.lease.release();
        } catch {}
      }
      await front.close().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
      try {
        hub.store?.close?.();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

class HarnessError extends Error {}

/**
 * maya lands one change; sam's change conflicts with it in a source file and
 * adds migrations/002.sql (protected). The first lander resolves the conflict
 * (the stub resolver, or the fake Mergiraf), the checks pass, and sam's landing
 * parks in needs_approval with the checked candidate C staged. Then `beforeResume`
 * changes what the next merge would give, maya approves the protected
 * requirement, and the resume runs (on the same lander, or on a standby).
 */
async function runVariant(v) {
  const res = { name: v.name, what: v.what };
  let w = null;
  try {
    w = await world(v.name);
    const first = await w.makeLander(v.first);
    const ta = w.task(w.maya, 'maya change');
    w.commit(w.maya, v.mayaFiles, 'maya: change');
    const La = w.land(w.maya, { task_id: ta, summary: 'maya change' });
    await first.run({ once: true });
    if (w.landing(La.id).status !== 'landed') throw new HarnessError(`maya's ${La.id} did not land: ${JSON.stringify(w.landing(La.id).failure)}`);
    const Ca = w.trunk();

    const tb = w.task(w.sam, 'sam change plus a migration');
    w.commit(w.sam, { ...v.samFiles, 'migrations/002.sql': 'create table x (id int);\n' }, 'sam: change plus migration');
    const Lb = w.land(w.sam, { task_id: tb, summary: 'sam change plus a migration' });
    await first.run({ once: true });
    const parked = w.landing(Lb.id);
    res.parked = {
      status: parked.status,
      candidate_checked: parked.candidate_checked,
      candidate: parked.candidate,
      trunk_base: parked.trunk_base,
      pending: parked.approval.map((r) => r.kind),
      resolved_by: parked.report?.resolved_by ?? null,
      resolverCalls: w.resolverCalls(),
      checkRuns: w.checkRuns(Lb.id),
    };
    if (parked.status !== 'needs_approval' || !parked.candidate_checked || !parked.candidate) {
      throw new HarnessError(`${Lb.id} did not park with a checked candidate: ${JSON.stringify({ status: parked.status, failure: parked.failure, resolved_by: parked.report?.resolved_by })}`);
    }
    if (parked.report?.resolved_by !== v.expectResolvedBy) throw new HarnessError(`${Lb.id} parked with resolved_by ${parked.report?.resolved_by}, expected ${v.expectResolvedBy}`);
    const prot = parked.approval.find((r) => r.kind === 'protected');
    if (!prot || parked.approval.some((r) => r.kind === 'ai_resolution')) throw new HarnessError(`${Lb.id}: unexpected pending requirements ${JSON.stringify(parked.approval.map((r) => r.kind))}`);
    const C = parked.candidate;
    res.C = C;
    res.stagedAtPark = w.remoteRef(parked.candidate_ref) === C;

    v.beforeResume?.(w);
    w.hub.approveLanding(P, Lb.id, { kind: 'protected', digest: prot.digest }, approver('maya'));
    res.afterApproval = w.landing(Lb.id).status;
    const trunkBeforeResume = w.trunk();
    res.trunkUnchanged = trunkBeforeResume === Ca && parked.trunk_base === Ca;
    if (!res.trunkUnchanged) throw new HarnessError('trunk moved between park and resume');

    const resumer = v.resume ? await w.makeLander(v.resume) : first;
    await resumer.run({ once: true });
    const after = w.landing(Lb.id);
    res.after = {
      status: after.status,
      code: after.failure?.code ?? null,
      trunk_sha: after.trunk_sha,
      trunk: w.trunk(),
      resolved_by: after.report?.resolved_by ?? null,
      warnings: (after.report?.warnings ?? []).slice(0, 4),
      resolverCalls: w.resolverCalls(),
      checkRuns: w.checkRuns(Lb.id),
      parkedCandidateStillStaged: w.remoteRef(parked.candidate_ref) === C,
    };
    if (after.trunk_sha && after.trunk_sha !== C) res.after.landedFile = { [v.file]: w.show(after.trunk_sha, v.file), [`(in C) ${v.file}`]: w.show(C, v.file) };
    res.extraResolverCalls = res.after.resolverCalls - res.parked.resolverCalls;
    res.extraCheckRuns = res.after.checkRuns - res.parked.checkRuns;
    res.pushedC = after.status === 'landed' && after.trunk_sha === C && w.trunk() === C;
    res.defect = !res.pushedC || res.extraResolverCalls > 0 || res.extraCheckRuns > 0;
    res.landerLog = w.logs.filter((l) => l.includes(Lb.id)).slice(-8);
  } catch (err) {
    res.error = err instanceof HarnessError ? err.message : (err?.stack ?? String(err));
    res.harness = true;
    res.landerLog = w?.logs.slice(-20) ?? [];
  } finally {
    await w?.close().catch(() => undefined);
  }
  return res;
}

const AI = {
  mayaFiles: { 'src/a.ts': 'export const a = 2;\n' },
  samFiles: { 'src/a.ts': 'export const a = 3;\n' },
  file: 'src/a.ts',
  expectResolvedBy: 'ai',
};
const variants = [
  {
    ...AI,
    name: 'ai-same-answer',
    what: 'the stub answers the same way again (deterministic resolver)',
    first: { name: 'main', resolver: true },
  },
  {
    ...AI,
    name: 'ai-declines',
    what: 'the stub declines the second time (the model answers differently)',
    first: { name: 'main', resolver: true },
    beforeResume: (w) => w.setStub({ mode: 'decline' }),
  },
  {
    ...AI,
    name: 'ai-hourly-cap',
    what: "resolverMaxPerHour 1: the first resolution used the lander's hourly cap",
    first: { name: 'main', resolver: true, maxPerHour: 1 },
  },
  {
    ...AI,
    name: 'ai-times-out',
    what: 'the second resolver call times out (per-file timeout 4 s, the stub sleeps 60 s)',
    first: { name: 'main', resolver: true, timeoutMs: 4_000 },
    beforeResume: (w) => w.setStub({ mode: 'slow', delayMs: 60_000 }),
  },
  {
    ...AI,
    name: 'ai-different-answer',
    what: 'the stub answers with a different resolution the second time',
    first: { name: 'main', resolver: true },
    beforeResume: (w) => w.setStub({ mode: 'fixture', files: { 'src/a.ts': ['export const a = 3;\n'] } }),
  },
  {
    name: 'structural-standby',
    what: 'the fake Mergiraf resolved it; the resume runs on a standby lander without mergiraf and without a resolver',
    mayaFiles: { 'src/session.ts': `${SEED_FILES['src/session.ts']}\nexport function refresh(): number {\n  return 2;\n}\n` },
    samFiles: { 'src/session.ts': `${SEED_FILES['src/session.ts']}\nexport function revoke(): number {\n  return 3;\n}\n` },
    file: 'src/session.ts',
    expectResolvedBy: 'structural',
    first: { name: 'main', resolver: true, mergiraf: true },
    resume: { name: 'standby', resolver: false, mergiraf: false },
  },
];

console.log(`R-16 reproduction against ${ROOT}\n`);
const results = [];
for (const v of variants) {
  const r = await runVariant(v);
  results.push(r);
  console.log(`== ${r.name}: ${r.what}`);
  if (r.harness) {
    console.log(`  HARNESS ERROR: ${r.error}`);
    for (const l of r.landerLog) console.log(`    ${l.split('\n')[0].slice(0, 240)}`);
    console.log('');
    continue;
  }
  const p = r.parked;
  console.log(`  first attempt: ${p.status}, candidate_checked=${p.candidate_checked}, resolved_by=${p.resolved_by}, pending=[${p.pending.join(', ')}], C=${r.C.slice(0, 12)} staged=${r.stagedAtPark}, resolver calls=${p.resolverCalls}, check runs=${p.checkRuns}`);
  console.log(`  maya approves the protected requirement -> ${r.afterApproval}; trunk unchanged since parking: ${r.trunkUnchanged}`);
  const a = r.after;
  console.log(`  resume: ${a.status}${a.code ? ` {${a.code}}` : ''}, trunk_sha=${a.trunk_sha ? a.trunk_sha.slice(0, 12) : null}${a.trunk_sha && a.trunk_sha !== r.C ? ' (NOT C)' : ''}, resolved_by=${a.resolved_by}, resolver calls ${p.resolverCalls} -> ${a.resolverCalls}, check runs ${p.checkRuns} -> ${a.checkRuns}`);
  if (a.landedFile) console.log(`  landed content differs from the checked, parked C: ${JSON.stringify(a.landedFile)}`);
  if (a.warnings.length) console.log(`  report warnings: ${JSON.stringify(a.warnings)}`);
  console.log(`  pushed the parked, checked C as it is: ${r.pushedC ? 'yes' : 'NO'}${r.extraResolverCalls ? `; resolver called again (${r.extraResolverCalls} extra call)` : ''}${r.extraCheckRuns ? `; checks ran again (${r.extraCheckRuns} extra run)` : ''}${r.defect ? '  -> DEFECT' : ''}`);
  for (const l of r.landerLog) console.log(`    lander: ${l.split('\n')[0].slice(0, 240)}`);
  console.log('');
}

const harness = results.filter((r) => r.harness);
const defects = results.filter((r) => r.defect);
if (defects.length > 0) {
  console.log(`DEFECT PRESENT in ${defects.length} of ${results.length} variants (${defects.map((r) => r.name).join(', ')}): an approved resume on an unchanged trunk re-runs the merge ladder and the AI resolver instead of pushing the parked, checked candidate.`);
  const failed = defects.filter((r) => r.after.status === 'failed');
  if (failed.length) console.log(`  the checked and approved C was thrown away and the landing failed in: ${failed.map((r) => `${r.name} {${r.after.code}}`).join(', ')}`);
  process.exit(1);
}
if (harness.length > 0) {
  console.log(`HARNESS: ${harness.map((r) => r.name).join(', ')} did not set up as expected.`);
  process.exit(2);
}
console.log('no defect: every approved resume pushed the parked, checked C with no second resolver call and no second check run.');
process.exit(0);
