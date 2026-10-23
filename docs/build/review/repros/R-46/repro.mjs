#!/usr/bin/env node
// R-46 reproduction: I4 (config from trunk at T0) and the §4.1 #8
// test-weakening warning have no test at the lander, so a regression in any
// of them ships with the suite green.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// What it does (nothing in AGENTHUB_ROOT is written; all work is in a copy):
//  0. behavior.mjs against AGENTHUB_ROOT's built packages: the four missing
//     tests (A config from T0 / agenthub.json always protected, B union attack
//     through the pipeline's attrSource, C test-weakening warning, D resolver
//     settings from T0) must pass: today's code is correct.
//  1. The lander suite (`vitest run packages/lander`) on a pristine copy: the
//     baseline (skip with SKIP_BASELINE=1).
//  2. For each mutant (one natural regression each, applied to a fresh copy's
//     packages/lander/src): rebuild the copy's lander dist, run behavior.mjs
//     against the copy (the mutant must be caught there, else it is
//     equivalent and doesn't count), then run the copy's lander suite.
//
// Exit 1 (the defect): some real mutant (caught by behavior.mjs) passes the
// whole existing lander suite. Exit 0: every real mutant is caught by the
// suite. BEHAVIOR_ONLY=1 checks only that each mutant is real (no suite runs). Exit 2: setup problem or today's code fails behavior.mjs (a
// different defect). MUTANTS=M1,M3 picks mutants; KEEP=1 keeps the copies.
// No network, no API key.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, 'work');
const BEHAVIOR = path.join(HERE, 'behavior.mjs');

const MUTANTS = [
  {
    id: 'M1',
    what: "checks runner takes land.check from agenthub.json in the candidate's worktree (the finding's scenario)",
    edits: [
      {
        file: 'packages/lander/src/checks.ts',
        find: '      const hash = commandHash(req.command);\n',
        replace:
          "      try {\n        const own = JSON.parse(readFileSync(path.join(wt, 'agenthub.json'), 'utf8'))?.land?.check;\n        if (typeof own === 'string' && own) req = { ...req, command: own };\n      } catch {}\n      const hash = commandHash(req.command);\n",
      },
    ],
  },
  {
    id: 'M2',
    what: "attempt (P1) reads the whole land config from the change's agenthub.json (H) instead of trunk's (T0)",
    edits: [
      { file: 'packages/lander/src/pipeline.ts', find: "import { descends, fetchTrunk, findOnTrunk, localCandidateRef, localLandRef, policyOf, scanTrunk, trunkLocalRef } from './trunk.js';", replace: "import { descends, fetchTrunk, findOnTrunk, localCandidateRef, localLandRef, policyOf, readTrunkConfig, scanTrunk, trunkLocalRef } from './trunk.js';" },
      { file: 'packages/lander/src/pipeline.ts', find: '    const land = this.land;\n', replace: '    let land = this.land;\n' },
      {
        file: 'packages/lander/src/pipeline.ts',
        find: "    if (tip !== H) return this.fail('not_pushed', { warnings: [`the land ref points at ${tip?.slice(0, 12) ?? 'nothing'}, not at the landed commit ${H.slice(0, 12)}`] });\n",
        replace:
          "    if (tip !== H) return this.fail('not_pushed', { warnings: [`the land ref points at ${tip?.slice(0, 12) ?? 'nothing'}, not at the landed commit ${H.slice(0, 12)}`] });\n    {\n      const own = await readTrunkConfig(ctx.git, H);\n      if (own.ok) {\n        land = own.land;\n        this.land = own.land;\n      }\n    }\n",
      },
    ],
  },
  {
    id: 'M3',
    what: "the merge ladder takes attributes from the change: mergeTrees(..., { attrSource: H })",
    edits: [{ file: 'packages/lander/src/pipeline.ts', find: 'attrSource: T0, drivers', replace: 'attrSource: H, drivers' }],
  },
  {
    id: 'M4',
    what: 'admission no longer emits the §4.1 #8 test-weakening warnings',
    edits: [{ file: 'packages/lander/src/admission.ts', find: '    if (tests.length === 0) return [];\n', replace: '    if (tests.length >= 0) return [];\n' }],
  },
  {
    id: 'M5',
    what: "attempt takes only the resolver settings (land.resolver) from the change's agenthub.json",
    edits: [
      { file: 'packages/lander/src/pipeline.ts', find: "import { descends, fetchTrunk, findOnTrunk, localCandidateRef, localLandRef, policyOf, scanTrunk, trunkLocalRef } from './trunk.js';", replace: "import { descends, fetchTrunk, findOnTrunk, localCandidateRef, localLandRef, policyOf, readTrunkConfig, scanTrunk, trunkLocalRef } from './trunk.js';" },
      { file: 'packages/lander/src/pipeline.ts', find: '    const land = this.land;\n', replace: '    let land = this.land;\n' },
      {
        file: 'packages/lander/src/pipeline.ts',
        find: "    if (tip !== H) return this.fail('not_pushed', { warnings: [`the land ref points at ${tip?.slice(0, 12) ?? 'nothing'}, not at the landed commit ${H.slice(0, 12)}`] });\n",
        replace:
          "    if (tip !== H) return this.fail('not_pushed', { warnings: [`the land ref points at ${tip?.slice(0, 12) ?? 'nothing'}, not at the landed commit ${H.slice(0, 12)}`] });\n    {\n      const own = await readTrunkConfig(ctx.git, H);\n      if (own.ok) {\n        land = { ...land, resolver: own.land.resolver };\n        this.land = land;\n      }\n    }\n",
      },
    ],
  },
  {
    id: 'M6',
    what: "admission reads the land config (protected rules, approvals) from the change's agenthub.json (H)",
    edits: [
      { file: 'packages/lander/src/admission.ts', find: "import { ADMIT_TRUNK_REF, descends, fetchTrunk, localLandRef } from './trunk.js';", replace: "import { ADMIT_TRUNK_REF, descends, fetchTrunk, localLandRef, readTrunkConfig } from './trunk.js';" },
      {
        file: 'packages/lander/src/admission.ts',
        find: "    if (tip !== H) return this.fail(landing, land, 'not_pushed', null, {}, `the land ref points at ${tip?.slice(0, 12) ?? 'nothing'}, not at your commit ${H.slice(0, 12)}`);\n",
        replace:
          "    if (tip !== H) return this.fail(landing, land, 'not_pushed', null, {}, `the land ref points at ${tip?.slice(0, 12) ?? 'nothing'}, not at your commit ${H.slice(0, 12)}`);\n    {\n      const own = await readTrunkConfig(ctx.git, H);\n      if (own.ok) land = own.land;\n    }\n",
      },
    ],
  },
];

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
  return { code: r.status ?? (r.signal ? 128 : -1), stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}
const log = (s) => process.stdout.write(`${s}\n`);

function copyRoot(dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // Working tree with dist and node_modules (whose @agenthub/* links are relative, so they point into the copy); no .git.
  const r = run('sh', ['-c', `tar -C "$1" --exclude=./.git --exclude=./node_modules/.vite --exclude=./node_modules/.vitest -cf - . | tar -C "$2" -xf -`, 'sh', ROOT, dest]);
  if (r.code !== 0) throw new Error(`copying ${ROOT}: ${r.stderr}`);
}

function behavior(root) {
  const r = run(process.execPath, [BEHAVIOR], { env: { ...process.env, AGENTHUB_ROOT: root }, timeout: 600_000 });
  const m = /R46-SUMMARY (\{.*\})/.exec(r.stdout);
  return { code: r.code, results: m ? JSON.parse(m[1]) : null, out: r.stdout + r.stderr };
}

function suite(root, tag) {
  const json = path.join(WORK, `suite-${tag}.json`);
  const out = path.join(WORK, `suite-${tag}.log`);
  rmSync(json, { force: true });
  const r = run(path.join(root, 'node_modules', '.bin', 'vitest'), ['run', 'packages/lander', '--reporter=default', '--reporter=json', `--outputFile.json=${json}`], { cwd: root, env: { ...process.env, CI: '1' }, timeout: 1_800_000 });
  writeFileSync(out, r.stdout + r.stderr);
  let failed = [];
  let counts = null;
  if (existsSync(json)) {
    const j = JSON.parse(readFileSync(json, 'utf8'));
    counts = { files: j.testResults?.length ?? 0, tests: j.numTotalTests, passed: j.numPassedTests, failed: j.numFailedTests, skipped: (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0) };
    for (const f of j.testResults ?? []) {
      for (const a of f.assertionResults ?? []) if (a.status === 'failed') failed.push(`${path.relative(root, f.name)} > ${a.fullName}`);
      if (f.status === 'failed' && (f.assertionResults ?? []).every((a) => a.status !== 'failed')) failed.push(`${path.relative(root, f.name)} (file failed: ${String(f.message ?? '').split('\n')[0]})`);
    }
  }
  return { code: r.code, failed, counts, log: out };
}

function applyMutant(copy, m) {
  for (const e of m.edits) {
    const f = path.join(copy, e.file);
    const s = readFileSync(f, 'utf8');
    const n = s.split(e.find).length - 1;
    if (n !== 1) return `${e.file}: the text to mutate occurs ${n} times (the code changed; this mutant no longer applies)`;
    writeFileSync(f, s.replace(e.find, () => e.replace));
  }
  return null;
}

mkdirSync(WORK, { recursive: true });
log(`AGENTHUB_ROOT=${ROOT}`);
for (const d of ['packages/lander/dist/lander.js', 'packages/hub/dist/index.js', 'node_modules/.bin/vitest', 'node_modules/.bin/tsc']) {
  if (!existsSync(path.join(ROOT, d))) {
    log(`setup: ${d} is missing in AGENTHUB_ROOT (npm ci && npm run build first)`);
    process.exit(2);
  }
}

// 0. Today's code behaves correctly (the tests R-46 asks for pass on it).
log('\n== 0. behavior.mjs against AGENTHUB_ROOT (the missing tests, on today\'s code)');
const base = behavior(ROOT);
log(base.out.trimEnd());
if (base.code !== 0 || !base.results) {
  log('today\'s code fails the behavior checks: that is a different defect than R-46 (missing tests); see above');
  process.exit(2);
}

// 1. Baseline suite on a pristine copy.
let baseline = null;
if (process.env.SKIP_BASELINE !== '1' && process.env.BEHAVIOR_ONLY !== '1') {
  log('\n== 1. lander suite on a pristine copy (baseline)');
  const copy = path.join(WORK, 'copy-baseline');
  copyRoot(copy);
  baseline = suite(copy, 'baseline');
  log(`baseline: exit ${baseline.code} ${JSON.stringify(baseline.counts)}${baseline.failed.length ? `\n  failing: ${baseline.failed.join('\n  failing: ')}` : ''}`);
  if (process.env.KEEP !== '1') rmSync(copy, { recursive: true, force: true });
}
const baselineFailed = new Set(baseline?.failed ?? []);

// 2. Mutants.
const pick = (process.env.MUTANTS ?? '').split(',').filter(Boolean);
const rows = [];
for (const m of MUTANTS.filter((x) => pick.length === 0 || pick.includes(x.id))) {
  log(`\n== 2. ${m.id}: ${m.what}`);
  const copy = path.join(WORK, `copy-${m.id}`);
  copyRoot(copy);
  const bad = applyMutant(copy, m);
  if (bad) {
    log(`  not applicable: ${bad}`);
    rows.push({ id: m.id, verdict: 'n/a', note: bad });
    continue;
  }
  const build = run(path.join(copy, 'node_modules', '.bin', 'tsc'), ['-p', 'packages/lander/tsconfig.json'], { cwd: copy });
  if (build.code !== 0) {
    log(`  the mutant doesn't build:\n${build.stdout}${build.stderr}`);
    rows.push({ id: m.id, verdict: 'n/a', note: 'does not build' });
    continue;
  }
  const b = behavior(copy);
  const caughtBy = b.results ? Object.entries(b.results).filter(([, ok]) => !ok).map(([k]) => k) : ['(behavior.mjs crashed)'];
  log(`  behavior.mjs on the mutant: ${caughtBy.length ? `caught by ${caughtBy.join(', ')}` : 'NOT caught (equivalent mutant?)'}`);
  for (const line of b.out.split('\n').filter((l) => l.startsWith('FAIL '))) log(`    ${line}`);
  if (process.env.BEHAVIOR_ONLY === '1') {
    rows.push({ id: m.id, verdict: caughtBy.length === 0 ? 'equivalent' : 'not run', caughtBy });
    if (process.env.KEEP !== '1') rmSync(copy, { recursive: true, force: true });
    continue;
  }
  const s = suite(copy, m.id);
  const newFailures = s.failed.filter((t) => !baselineFailed.has(t));
  const survived = s.code === 0 || (s.failed.length > 0 && newFailures.length === 0);
  log(`  existing lander suite on the mutant: exit ${s.code} ${JSON.stringify(s.counts)} -> ${survived ? 'SURVIVES (suite green)' : 'killed'}${newFailures.length ? `\n    failing: ${newFailures.join('\n    failing: ')}` : ''}`);
  rows.push({ id: m.id, verdict: caughtBy.length === 0 ? 'equivalent' : survived ? 'survives' : 'killed', caughtBy, suite: s.counts, newFailures });
  if (process.env.KEEP !== '1') rmSync(copy, { recursive: true, force: true });
}

log('\n== summary');
for (const r of rows) log(`  ${r.id}: ${r.verdict}${r.caughtBy?.length ? ` (behavior.mjs catches it via ${r.caughtBy.join(', ')})` : ''}${r.note ? ` (${r.note})` : ''}`);
const survivors = rows.filter((r) => r.verdict === 'survives');
if (process.env.BEHAVIOR_ONLY === '1') {
  log('BEHAVIOR_ONLY: mutants checked against behavior.mjs only; the lander suite was not run, so nothing is concluded about R-46.');
  process.exit(rows.some((r) => r.verdict === 'equivalent' || r.verdict === 'n/a') ? 2 : 0);
}
writeFileSync(path.join(WORK, 'summary.json'), JSON.stringify({ root: ROOT, baseline: baseline && { code: baseline.code, counts: baseline.counts, failed: baseline.failed }, rows }, null, 2));
if (survivors.length > 0) {
  log(`DEFECT PRESENT (R-46): ${survivors.map((r) => r.id).join(', ')} break I4 / §4.1 #8 at the lander (behavior.mjs shows it) and still pass every existing lander test.`);
  process.exit(1);
}
log('no surviving mutant: the lander suite catches every regression above.');
process.exit(0);
