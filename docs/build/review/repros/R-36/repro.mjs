#!/usr/bin/env node
// R-36 reproduction: an AI-resolved file loses the incoming side's mode change.
//
// conflictsOf() (packages/gitops/src/merge.ts) sets ConflictEntry.mode to the
// stage-2 (trunk) mode, else stage 3, else stage 1, instead of the mode
// `git merge-tree` merged into its tree. The AI resolver (packages/lander/src/
// resolver.ts) splices the resolved blob, and a reused approved one, with that
// mode. So when the incoming change edits AND chmods a file and trunk only
// edits it, the candidate (and trunk, after landing) silently reverts the
// agent's mode change: a change outside the conflict hunks, which design §2.6
// gates 3/7 and §0.3 #25 (only the conflict hunks change, spliceTree changes
// only the conflicted paths' contents) say can't happen.
//
// Part 1 (end to end): a bare remote (non-fast-forwards denied, an update hook
// that lets only the lander's committer move main), agent clones, an
// in-process hub on 127.0.0.1:0, and a real in-process lander (HubClient,
// GitPort, ChecksRunner, AiResolver with the repository's stub resolver,
// packages/lander/test/fixtures/stub-resolver.mjs, in `union` mode).
//   base:  run.sh 100644 "echo 1"
//   maya:  run.sh 100644 "echo 2"   (lands first, trunk)
//   sam:   run.sh 100755 "echo 3"   (edits and chmod +x)
// Variants: a control where git merges cleanly (different lines; merge-tree
// keeps sam's +x), the AI resolution with requireApproval off, and with
// requireApproval on (park, approve, land).
//
// Part 2 (the AiResolver alone, against a local repository): the fresh
// resolution path, the reuse-of-an-approved-resolution path (the candidate
// holds the resolved blob at merge-tree's mode, as a correct earlier attempt
// would have staged it; the stub declines, so only reuse can resolve it), and
// the mirror case (the agent removes the exec bit, trunk only edits).
//
// No network, no API key: the stub resolver only.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// Exit 1: the defect is present (some AI-resolved file ends up with another
// mode than the one merge-tree merged). Exit 0: every AI-resolved file keeps
// merge-tree's mode. Exit 2: the harness broke.

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
const { open, mergeTrees, spliceTree, approvalDigest } = await imp('gitops/dist/index.js');

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const approver = (name) => ({ lander: false, approver: name });
const STUB = path.join(FIXTURES, 'stub-resolver.mjs');

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
/** `mode oid` of a path in a tree-ish, or null. */
function entryOf(repo, rev, p) {
  const out = sh(repo, ['ls-tree', rev, '--', p]).trim();
  const m = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(out);
  return m ? { mode: m[1], oid: m[2] } : null;
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

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
}

class HarnessError extends Error {}

// ======================================================================= Part 1: end to end

async function world(name, o) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `r36-${name}-`)));
  const remote = path.join(dir, 'remote.git');
  const gate = path.join(dir, 'gate');
  const stubConfig = path.join(dir, 'stub-resolver.json');
  mkdirSync(gate);
  writeFileSync(stubConfig, JSON.stringify({ mode: 'union' }));

  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  const seed = path.join(dir, 'seed');
  sh(dir, ['init', '-q', '-b', 'main', seed]);
  writeFiles(seed, {
    'README.md': '# demo\n',
    'run.sh': o.seedRun,
    'check.mjs': readFileSync(path.join(FIXTURES, 'check.mjs'), 'utf8'),
    'agenthub.json': `${JSON.stringify({ project: P, land: { check: 'node check.mjs', checkEnv: { AGENTHUB_TEST_GATE: gate }, resolver: { enabled: true, requireApproval: !!o.requireApproval } } }, null, 2)}\n`,
  });
  sh(seed, ['add', '-A']);
  sh(seed, ['update-index', '--chmod=-x', 'run.sh']);
  sh(seed, ['commit', '-q', '-m', 'seed']);
  sh(seed, ['remote', 'add', 'origin', remote]);
  sh(seed, ['push', '-q', 'origin', 'main']);
  writeFileSync(path.join(remote, 'hooks', 'update'), HOOK);
  chmodSync(path.join(remote, 'hooks', 'update'), 0o755);

  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  const front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
  const logs = [];

  const workdir = path.join(dir, 'lander-main');
  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const PATH = process.env.PATH ?? '';
  const agent = landerId('lander/main');
  const client = new LanderHubClient({ url: front.url, project: P, agent, landerToken: null });
  const git = openGitPort({ mirror, remote: 'origin', env: { PATH } });
  const log = (l) => logs.push(l);
  const resolver = new AiResolver({
    git,
    hub: client,
    project: P,
    command: `${process.execPath} ${STUB} ${stubConfig}`,
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
    drivers: await detectDrivers({ PATH }),
    trunk: 'main',
    leaseTtlMs: 10_000,
    timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
    workdir,
    host: 'main',
  });

  const clone = (who) => {
    const c = path.join(dir, who);
    sh(dir, ['clone', '-q', remote, c], who);
    sh(c, ['config', 'core.fileMode', 'true'], who);
    return { who, id: `${who}/claude-1`, dir: c };
  };

  return {
    hub,
    logs,
    lander,
    remote,
    maya: clone('maya'),
    sam: clone('sam'),
    task(a, title) {
      const t = hub.createTask(P, a.id, { title });
      hub.takeTask(P, a.id, t.id);
      return t.id;
    },
    commit(a, files, msg, chmod) {
      writeFiles(a.dir, files);
      if (chmod) chmodSync(path.join(a.dir, 'run.sh'), chmod === '+x' ? 0o755 : 0o644);
      sh(a.dir, ['add', '-A'], a.who);
      if (chmod) sh(a.dir, ['update-index', `--chmod=${chmod}`, 'run.sh'], a.who);
      sh(a.dir, ['commit', '-q', '-m', msg], a.who);
      return sh(a.dir, ['rev-parse', 'HEAD'], a.who).trim();
    },
    land(a, o) {
      const H = sh(a.dir, ['rev-parse', 'HEAD'], a.who).trim();
      sh(a.dir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`], a.who);
      sh(a.dir, ['fetch', '-q', 'origin', 'main'], a.who);
      const files = sh(a.dir, ['diff', '--name-only', `origin/main...${H}`], a.who).split('\n').filter(Boolean);
      return hub.land(P, a.id, { queue: true, commit: H, files, task_id: o.task_id, summary: o.summary }).landing;
    },
    landing: (id) => hub.getLanding(P, id),
    trunk: () => sh(remote, ['rev-parse', 'main']).trim(),
    show: (rev, file) => sh(remote, ['show', `${rev}:${file}`]),
    resolverCalls: () => (existsSync(`${stubConfig}.calls`) ? readFileSync(`${stubConfig}.calls`, 'utf8').split('\n').filter(Boolean).length : 0),
    async close() {
      try {
        await lander.lease.release();
      } catch {}
      await front.close().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
      try {
        hub.store?.close?.();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function e2e(v) {
  const res = { name: v.name, what: v.what, part: 'end to end' };
  let w = null;
  try {
    w = await world(v.name, v);
    const ta = w.task(w.maya, 'maya change');
    w.commit(w.maya, { 'run.sh': v.mayaRun }, 'maya: change run.sh');
    const La = w.land(w.maya, { task_id: ta, summary: 'maya change' });
    await w.lander.run({ once: true });
    if (w.landing(La.id).status !== 'landed') throw new HarnessError(`maya's ${La.id} did not land: ${JSON.stringify(w.landing(La.id).failure)}`);
    const Ca = w.trunk();

    const tb = w.task(w.sam, 'sam change');
    const Hb = w.commit(w.sam, { 'run.sh': v.samRun }, 'sam: change run.sh and make it executable', '+x');
    if (entryOf(w.sam.dir, Hb, 'run.sh').mode !== '100755') throw new HarnessError("sam's commit does not hold run.sh as 100755");
    const Lb = w.land(w.sam, { task_id: tb, summary: 'sam change' });
    const base = sh(w.remote, ['merge-base', Ca, Hb]).trim();
    // What git itself merges: merge-tree's tree (the lander's req.tree for the resolver).
    const mt = spawnSync('git', ['merge-tree', '--write-tree', `--merge-base=${base}`, Ca, Hb], { cwd: w.remote, env: gitEnv(), encoding: 'utf8' });
    const mtTree = mt.stdout.split('\n')[0].trim();
    res.mergeTree = { conflicted: mt.status === 1, mode: entryOf(w.remote, mtTree, 'run.sh')?.mode ?? null };
    res.stageModes = { base: entryOf(w.remote, base, 'run.sh').mode, trunk: entryOf(w.remote, Ca, 'run.sh').mode, incoming: entryOf(w.remote, Hb, 'run.sh').mode };

    await w.lander.run({ once: true });
    let l = w.landing(Lb.id);
    if (v.requireApproval) {
      if (l.status !== 'needs_approval' || !l.candidate) throw new HarnessError(`${Lb.id} did not park for approval: ${JSON.stringify({ status: l.status, failure: l.failure })}`);
      const req = l.approval.find((r) => r.kind === 'ai_resolution');
      if (!req) throw new HarnessError(`${Lb.id}: no ai_resolution requirement (${JSON.stringify(l.approval.map((r) => r.kind))})`);
      res.parkedCandidateMode = entryOf(w.remote, l.candidate, 'run.sh')?.mode ?? null;
      w.hub.approveLanding(P, Lb.id, { kind: 'ai_resolution', digest: req.digest }, approver('maya'));
      await w.lander.run({ once: true });
      l = w.landing(Lb.id);
    }
    if (l.status !== 'landed') throw new HarnessError(`${Lb.id} did not land: ${JSON.stringify({ status: l.status, failure: l.failure, warnings: l.report?.warnings })}`);
    res.resolvedBy = l.report?.resolved_by ?? null;
    if (res.resolvedBy !== v.expectResolvedBy) throw new HarnessError(`${Lb.id} landed with resolved_by ${res.resolvedBy}, expected ${v.expectResolvedBy}`);
    res.resolverCalls = w.resolverCalls();
    const landed = entryOf(w.remote, l.trunk_sha, 'run.sh');
    res.landed = { mode: landed.mode, content: w.show(l.trunk_sha, 'run.sh') };
    res.expectedMode = res.mergeTree.mode;
    res.defect = res.landed.mode !== res.expectedMode;
    res.log = w.logs.filter((x) => x.includes(Lb.id)).slice(-6);
  } catch (err) {
    res.harness = true;
    res.error = err instanceof HarnessError ? err.message : (err?.stack ?? String(err));
    res.log = w?.logs.slice(-15) ?? [];
  } finally {
    await w?.close().catch(() => undefined);
  }
  return res;
}

// ======================================================================= Part 2: the AiResolver alone

const RESOLVER_CFG = { enabled: true, model: 'claude-opus-5-5', maxFiles: 5, maxFileBytes: 200_000, exclude: [], requireApproval: true };
const NO_HUB = { landing: async () => null, tasks: async () => [], decisions: async () => [], getClaim: async () => null };
const LANDING = { id: 'L-2', agent: 'sam/claude-1', task_id: null, summary: 'sam change', hold_ids: [], commit: '0'.repeat(40) };

async function direct(v) {
  const res = { name: v.name, what: v.what, part: 'AiResolver' };
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `r36-d-${v.name}-`)));
  try {
    const repo = path.join(dir, 'repo');
    sh(dir, ['init', '-q', '-b', 'main', repo]);
    sh(repo, ['config', 'core.fileMode', 'true']);
    const commitRun = (text, mode, msg) => {
      writeFileSync(path.join(repo, 'run.sh'), text);
      chmodSync(path.join(repo, 'run.sh'), mode === '100755' ? 0o755 : 0o644);
      sh(repo, ['add', 'run.sh']);
      sh(repo, ['update-index', `--chmod=${mode === '100755' ? '+x' : '-x'}`, 'run.sh']);
      sh(repo, ['commit', '-q', '-m', msg]);
      return sh(repo, ['rev-parse', 'HEAD']).trim();
    };
    const B = commitRun('echo 1\n', v.modes.base, 'base');
    const T0 = commitRun('echo 2\n', v.modes.trunk, 'trunk');
    sh(repo, ['checkout', '-q', '-b', 'agent', B]);
    const H = commitRun('echo 3\n', v.modes.incoming, 'agent');

    const g = open(path.join(repo, '.git'), { isolated: true });
    const git = openGitPort({ mirror: g, remote: 'origin' });
    const merged = await mergeTrees(g, T0, H, { base: B, attrSource: T0, drivers: [] });
    if (merged.clean || merged.conflicts.length !== 1 || merged.conflicts[0].kind !== 'content') throw new HarnessError(`expected one content conflict, got ${JSON.stringify(merged.conflicts)}`);
    const c = merged.conflicts[0];
    res.mergeTree = { mode: entryOf(repo, merged.tree, 'run.sh').mode };
    res.conflictEntryMode = c.mode;

    const stubConfig = path.join(dir, 'stub.json');
    writeFileSync(stubConfig, JSON.stringify({ mode: v.reuse ? 'decline' : 'union' }));
    const resolver = new AiResolver({
      git,
      hub: NO_HUB,
      project: P,
      command: `${process.execPath} ${STUB} ${stubConfig}`,
      apiKey: null,
      maxPerHour: 20,
      scratchDir: path.join(dir, 'runs'),
      env: { PATH: process.env.PATH ?? '' },
      parseCheck: null,
    });

    let reuse = { candidate: null, candidateRef: null, approved: [] };
    if (v.reuse) {
      // An earlier attempt's candidate that a human approved: the resolved blob at merge-tree's mode, as a correct splice stages it.
      const resolvedText = 'echo 2\necho 3\n';
      const candTree = await spliceTree(g, merged.tree, [{ path: 'run.sh', mode: res.mergeTree.mode, content: resolvedText }]);
      const cand = sh(repo, ['commit-tree', candTree, '-p', T0, '-m', 'earlier candidate']).trim();
      const oid = entryOf(repo, cand, 'run.sh').oid;
      const digest = approvalDigest('ai_resolution', [{ path: 'run.sh', blobs: [c.stages[1], c.stages[2], c.stages[3], oid] }]);
      reuse = { candidate: cand, candidateRef: null, approved: [digest] };
      res.candidateMode = entryOf(repo, cand, 'run.sh').mode;
    }

    const out = await resolver.resolve({
      landing: LANDING,
      conflicts: merged.conflicts,
      tree: merged.tree,
      base: B,
      trunk: T0,
      head: H,
      config: RESOLVER_CFG,
      protectedRules: [],
      distinct: true,
      epoch: 'e1',
      reuse,
    });
    if (out.resolved.length !== 1) throw new HarnessError(`the resolver did not resolve run.sh: ${JSON.stringify({ unresolved: out.unresolved, warnings: out.warnings })}`);
    if (v.reuse && !out.warnings.some((x) => x.includes('reused the resolution approved earlier'))) throw new HarnessError(`the approved resolution was not reused: ${JSON.stringify(out.warnings)}`);
    const e = entryOf(repo, out.tree, 'run.sh');
    res.resolved = { mode: e.mode, content: sh(repo, ['cat-file', 'blob', e.oid]) };
    res.expectedMode = res.mergeTree.mode;
    res.defect = res.resolved.mode !== res.expectedMode;
  } catch (err) {
    res.harness = true;
    res.error = err instanceof HarnessError ? err.message : (err?.stack ?? String(err));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return res;
}

// ======================================================================= run

const e2eVariants = [
  {
    name: 'control-git-clean',
    what: 'control: maya and sam edit different lines of run.sh, sam chmods +x; git merges it cleanly (no AI)',
    seedRun: 'echo 1\n# one\n# two\n# three\n# four\necho end\n',
    mayaRun: 'echo 2\n# one\n# two\n# three\n# four\necho end\n',
    samRun: 'echo 1\n# one\n# two\n# three\n# four\necho END\n',
    expectResolvedBy: 'clean',
  },
  {
    name: 'ai',
    what: 'maya edits run.sh, sam edits the same line and chmods +x; the stub resolves it (requireApproval off)',
    seedRun: 'echo 1\n',
    mayaRun: 'echo 2\n',
    samRun: 'echo 3\n',
    expectResolvedBy: 'ai',
  },
  {
    name: 'ai-approved',
    what: 'the same with requireApproval on: parks for an ai_resolution approval, maya approves, it lands',
    seedRun: 'echo 1\n',
    mayaRun: 'echo 2\n',
    samRun: 'echo 3\n',
    requireApproval: true,
    expectResolvedBy: 'ai',
  },
];
const directVariants = [
  { name: 'fresh-plus-x', what: 'fresh resolution: base 100644, trunk 100644 (edit), incoming 100755 (edit + chmod +x)', modes: { base: '100644', trunk: '100644', incoming: '100755' } },
  { name: 'reuse-plus-x', what: 'reuse of an approved resolution (the stub declines; only reuse resolves it), same modes', modes: { base: '100644', trunk: '100644', incoming: '100755' }, reuse: true },
  { name: 'fresh-minus-x', what: 'mirror case: base 100755, trunk 100755 (edit), incoming 100644 (edit + chmod -x)', modes: { base: '100755', trunk: '100755', incoming: '100644' } },
];

console.log(`R-36 reproduction against ${ROOT}\n`);
const results = [];
for (const v of e2eVariants) {
  const r = await e2e(v);
  results.push(r);
  console.log(`== [end to end] ${r.name}: ${r.what}`);
  if (r.harness) {
    console.log(`  HARNESS ERROR: ${r.error}`);
    for (const l of r.log) console.log(`    lander: ${l.split('\n')[0].slice(0, 240)}`);
    console.log('');
    continue;
  }
  console.log(`  stage modes of run.sh: base ${r.stageModes.base}, trunk ${r.stageModes.trunk}, incoming ${r.stageModes.incoming}; git merge-tree: ${r.mergeTree.conflicted ? 'conflicted' : 'clean'}, merged mode ${r.mergeTree.mode}`);
  if (r.parkedCandidateMode) console.log(`  parked candidate's run.sh mode: ${r.parkedCandidateMode}`);
  console.log(`  landed (resolved_by=${r.resolvedBy}, resolver calls=${r.resolverCalls}): run.sh ${r.landed.mode} ${JSON.stringify(r.landed.content)}; expected mode ${r.expectedMode}${r.defect ? '  -> DEFECT: the agent\'s mode change was reverted' : '  ok'}`);
  for (const l of r.log) console.log(`    lander: ${l.split('\n')[0].slice(0, 240)}`);
  console.log('');
}
for (const v of directVariants) {
  const r = await direct(v);
  results.push(r);
  console.log(`== [AiResolver] ${r.name}: ${r.what}`);
  if (r.harness) {
    console.log(`  HARNESS ERROR: ${r.error}\n`);
    continue;
  }
  console.log(`  merge-tree's merged tree: run.sh ${r.mergeTree.mode}; ConflictEntry.mode (conflictsOf): ${r.conflictEntryMode}${r.candidateMode ? `; approved candidate's run.sh: ${r.candidateMode}` : ''}`);
  console.log(`  resolver's spliced tree: run.sh ${r.resolved.mode} ${JSON.stringify(r.resolved.content)}; expected mode ${r.expectedMode}${r.defect ? '  -> DEFECT' : '  ok'}`);
  console.log('');
}

const harness = results.filter((r) => r.harness);
const defects = results.filter((r) => r.defect);
const control = results.find((r) => r.name === 'control-git-clean');
if (control?.defect) console.log('note: the control (a clean git merge, no AI) lost the mode too, so the loss is not specific to the AI splice.');
if (defects.length > 0) {
  console.log(`DEFECT PRESENT in ${defects.length} of ${results.length} variants (${defects.map((r) => r.name).join(', ')}): an AI-resolved file is spliced with ConflictEntry.mode (trunk's stage-2 mode), not the mode merge-tree merged, so the incoming side's mode change is reverted outside any conflict hunk.`);
  process.exit(1);
}
if (harness.length > 0) {
  console.log(`HARNESS: ${harness.map((r) => r.name).join(', ')} did not set up as expected.`);
  process.exit(2);
}
console.log('no defect: every AI-resolved file keeps the mode merge-tree merged (the incoming side\'s mode change survives).');
process.exit(0);
