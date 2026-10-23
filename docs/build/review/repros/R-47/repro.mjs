// R-47 reproduction: sync's step-9 compare-and-swap (HEAD still the old tip, tracked files still clean) before
// `git reset --keep` is never exercised by the test suite.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// AGENTHUB_ROOT is only read (its built dist, its sources, its node_modules); nothing in it is written. Everything
// else lives in a temp dir that is removed at the end (R47_KEEP=1 keeps it). No network, no API key.
//
// Part 1 (behaviour, the built code): scenario.mjs runs syncWorkspace from ${AGENTHUB_ROOT}/packages/adapter/dist
//   with a git shim first on PATH that, right after sync's own `update-ref -m "agenthub sync: backup before moving
//   the branch"`, either commits N in the worktree (head) or edits a tracked file (tracked). Then the same against a
//   copy of the dist with the two CAS conditions replaced by `false`, to show what the check prevents.
// Part 2 (the finding proper): a copy of the tree with each CAS condition removed from src/sync.ts (and the adapter
//   rebuilt) runs the adapter test suite and the e2e suite, the only suites that reach sync.ts. A mutant every test
//   passes on is a branch no test exercises. A positive control (the untracked-files check removed) must be killed.
//
// Exit codes:
//   0  no defect: both CAS mutants are killed by the suite, and the built code handles both scenarios as §2.3.5 says
//   1  R-47 present: the suite stays green with a CAS condition removed (the branch is never exercised)
//   3  the suite covers both branches, but the HEAD-moved outcome is not §2.3.5 step 9's 'skipped: changed_meanwhile'
//   4  the built code loses the mid-sync commit N or the mid-sync edit (a safety defect worse than R-47)
//   2  inconclusive (the CAS could not be located, the harness control failed, or a failure also happens unmutated)

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT ?? '/home/user/agenthub');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FULL = process.env.R47_FULL === '1'; // run the whole default suite for each mutant, not just packages/adapter/test
const NO_E2E = process.env.R47_NO_E2E === '1';
const WORK = mkdtempSync(path.join(tmpdir(), 'r47-work-'));
const log = (...a) => console.log(...a);

const SRC = path.join(ROOT, 'packages/adapter/src/sync.ts');
const DIST = path.join(ROOT, 'packages/adapter/dist/sync.js');
for (const f of [SRC, DIST, path.join(ROOT, 'packages/hub/dist/index.js'), path.join(ROOT, 'node_modules/vitest/vitest.mjs')]) {
  if (!existsSync(f)) finish(2, `missing ${f} (build ${ROOT} first: npm ci && npm run build)`);
}

// ---------------------------------------------------------------------------------------------------------------
// Mutations of step 9, located between sync's backup update-ref and its `reset --keep`, in the .ts and in the .js.

const MUTANTS = {
  head: { re: /fullHead\(root\)\s*!==\s*head\b/, by: 'false', what: 'HEAD CAS removed (fullHead(root) !== head → false)' },
  tracked: { re: /\(await trackedChanges\(g\)\)\.length/, by: '0', what: 'tracked-files CAS removed ((await trackedChanges(g)).length → 0)' },
  control: { re: /if \(blocking\.length\)/, by: 'if (false)', what: 'positive control: untracked/ignored-in-the-way check removed' },
};

function mutate(text, names) {
  const start = text.indexOf('agenthub sync: backup before moving the branch');
  const end = start < 0 ? -1 : text.indexOf("'--keep'", start);
  if (start < 0 || end < 0) return null;
  let region = text.slice(start, end);
  for (const n of names) {
    const { re, by } = MUTANTS[n];
    if (!re.test(region)) return null;
    region = region.replace(re, by);
  }
  return text.slice(0, start) + region + text.slice(end);
}

const srcText = readFileSync(SRC, 'utf8');
const distText = readFileSync(DIST, 'utf8');
for (const n of Object.keys(MUTANTS)) {
  if (!mutate(srcText, [n]) || !mutate(distText, [n])) finish(2, `could not locate step 9's ${n} check in ${SRC} / ${DIST}`);
}

const cleanEnv = () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(HUB_|GIT_|ANTHROPIC_|AGENTHUB_SYNC_FAULT)/.test(k) && k !== 'CLAUDE_PROJECT_DIR') env[k] = v;
  env.AGENTHUB_ROOT = ROOT;
  return env;
};
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: cleanEnv(), ...o });

// ---------------------------------------------------------------------------------------------------------------
// Part 1: the scenario against the built code, and against a mutant copy of the dist.

function scenario(distDir, mode) {
  const r = run(process.execPath, [path.join(HERE, 'scenario.mjs'), distDir, mode], { timeout: 120_000 });
  const line = r.stdout.trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    return { error: `scenario exited ${r.status}: ${r.stderr || r.stdout}` };
  }
}

const mdist = path.join(WORK, 'mutant-dist');
mkdirSync(path.join(mdist, 'packages/adapter'), { recursive: true });
cpSync(path.join(ROOT, 'packages/adapter/dist'), path.join(mdist, 'packages/adapter/dist'), { recursive: true });
cpSync(path.join(ROOT, 'packages/adapter/package.json'), path.join(mdist, 'packages/adapter/package.json'));
symlinkSync(path.join(ROOT, 'node_modules'), path.join(mdist, 'node_modules'));
writeFileSync(path.join(mdist, 'packages/adapter/dist/sync.js'), mutate(distText, ['head', 'tracked']));

const brief = (s) =>
  s.error
    ? { error: s.error }
    : {
        shimFired: s.shimFired,
        result: s.result?.kind === 'skipped' ? `skipped: ${s.result.reason} (${s.result.detail})` : s.result?.kind,
        headIs: s.headIs,
        nOnBranch: s.nOnBranch,
        meanwhileFileInWorktree: s.meanwhileFile,
        authEditKept: s.authEditKept,
        status: s.status,
        backupRefHoldsN: s.backupHoldsN,
        recordLeft: s.recordLeft,
        preEditWouldDeny: s.preEditWouldDeny,
        nextSync: s.nextSync,
      };

log('== Part 1: a commit (head) / a tracked edit (tracked) lands between sync step 8 (backup ref) and step 9 (CAS)');
const real = { head: scenario(path.join(ROOT, 'packages/adapter/dist'), 'head'), tracked: scenario(path.join(ROOT, 'packages/adapter/dist'), 'tracked') };
const mut = { head: scenario(path.join(mdist, 'packages/adapter/dist'), 'head'), tracked: scenario(path.join(mdist, 'packages/adapter/dist'), 'tracked') };
log('built code, head:      ', JSON.stringify(brief(real.head)));
log('built code, tracked:   ', JSON.stringify(brief(real.tracked)));
log('CAS removed, head:     ', JSON.stringify(brief(mut.head)));
log('CAS removed, tracked:  ', JSON.stringify(brief(mut.tracked)));
for (const s of [real.head, real.tracked]) if (s.error || !s.shimFired) finish(2, `scenario did not run as intended: ${s.error ?? 'the shim never fired'}`);

const safeHead = real.head.headIs === 'N' && real.head.nOnBranch && real.head.meanwhileFile;
const safeTracked = real.tracked.headIs === 'orig' && real.tracked.authEditKept;
const designHead =
  safeHead && real.head.result?.kind === 'skipped' && real.head.result.reason === 'changed_meanwhile' && !real.head.recordLeft && !real.head.preEditWouldDeny && real.head.backupRefs.length === 0;
const designTracked =
  safeTracked && real.tracked.result?.kind === 'skipped' && real.tracked.result.reason === 'changed_meanwhile' && !real.tracked.recordLeft && real.tracked.backupRefs.length === 0;
log(`built code keeps N on the branch: ${safeHead}; keeps the edit and HEAD: ${safeTracked}`);
log(`built code matches §2.3.5 step 9 ('skipped: changed_meanwhile', nothing left behind): head ${designHead}, tracked ${designTracked}`);
if (mut.head.result?.kind === 'synced' && mut.head.nOnBranch === false) {
  log(`without the HEAD CAS: reset --keep moved agent-b from N to the target; N is off the branch, docs/meanwhile.md gone: ${!mut.head.meanwhileFile}; the backup ref holds the old head, not N: ${mut.head.backupHoldsN === false}`);
}
if (mut.tracked.result?.kind === 'synced') log(`without the tracked CAS: the branch moved with an uncommitted tracked edit in the worktree (status: ${mut.tracked.status})`);

// ---------------------------------------------------------------------------------------------------------------
// Part 2: mutation testing of the suite on a copy of the tree.

const tree = path.join(WORK, 'tree');
log(`\n== Part 2: does any test notice the CAS gone? (copy of ${ROOT} in ${tree})`);
cpSync(ROOT, tree, {
  recursive: true,
  filter: (src) => {
    const segs = path.relative(ROOT, src).split(path.sep);
    return !segs.includes('node_modules') && segs[0] !== '.git';
  },
});
mkdirSync(path.join(tree, 'node_modules'));
for (const e of readdirSync(path.join(ROOT, 'node_modules'))) {
  if (['.vite', '.vite-temp', '.vitest-cache', '.package-lock.json'].includes(e)) continue;
  if (e === '@agenthub') {
    mkdirSync(path.join(tree, 'node_modules/@agenthub'));
    for (const p of readdirSync(path.join(ROOT, 'node_modules/@agenthub'))) symlinkSync(path.join(tree, 'packages', p), path.join(tree, 'node_modules/@agenthub', p));
  } else symlinkSync(path.join(ROOT, 'node_modules', e), path.join(tree, 'node_modules', e));
}
const treeSrc = path.join(tree, 'packages/adapter/src/sync.ts');

function build(text) {
  writeFileSync(treeSrc, text);
  const r = run(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(tree, 'packages/adapter')], { cwd: tree, timeout: 300_000 });
  if (r.status !== 0) finish(2, `tsc failed in the copy: ${r.stdout}${r.stderr}`);
}

/** vitest in the copy; the failing tests ("file > name"), or null when the run itself broke. */
function vitest(label, args) {
  const outFile = path.join(WORK, `vitest-${label}.json`);
  const t0 = Date.now();
  const r = run(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', ...args, '--reporter=json', `--outputFile=${outFile}`], { cwd: tree, timeout: 1_800_000 });
  if (!existsSync(outFile)) {
    log(`  ${label}: vitest produced no report (exit ${r.status}): ${(r.stderr || r.stdout).slice(-2000)}`);
    return null;
  }
  const j = JSON.parse(readFileSync(outFile, 'utf8'));
  const failed = [];
  for (const f of j.testResults ?? []) {
    const rel = path.relative(tree, f.name);
    const bad = (f.assertionResults ?? []).filter((a) => a.status === 'failed');
    for (const a of bad) failed.push(`${rel} > ${a.fullName}`);
    if (f.status === 'failed' && bad.length === 0) failed.push(`${rel} > (file failed to run: ${String(f.message ?? '').split('\n')[0]})`);
  }
  log(`  ${label}: ${j.numPassedTests} passed, ${j.numFailedTests} failed, ${j.numPendingTests ?? 0} skipped, of ${j.numTotalTests} in ${j.numTotalTestSuites ?? '?'} suites (${Math.round((Date.now() - t0) / 1000)} s)`);
  for (const f of failed.slice(0, 20)) log(`    FAIL ${f}`);
  if (!j.numTotalTests) return null;
  return failed;
}

const suites = [
  { label: 'unit', args: FULL ? [] : ['packages/adapter/test'] },
  ...(NO_E2E ? [] : [{ label: 'e2e', args: ['--config', 'vitest.e2e.config.ts'] }]),
];

// The control first, on sync.test.ts alone: a mutant the suite must kill, or the harness can't tell.
build(mutate(srcText, ['control']));
log(`mutant control: ${MUTANTS.control.what}`);
const control = vitest('control', ['packages/adapter/test/sync.test.ts']);
if (!control || control.length === 0) finish(2, 'the positive control survived (or the run broke): the harness cannot detect a killed mutant');

const verdict = {};
for (const name of ['head', 'tracked']) {
  build(mutate(srcText, [name]));
  log(`mutant ${name}: ${MUTANTS[name].what}`);
  const failed = [];
  for (const s of suites) {
    const f = vitest(`${name}-${s.label}`, s.args);
    if (f === null) finish(2, `the ${s.label} run for mutant ${name} broke`);
    failed.push(...f);
  }
  verdict[name] = { failed };
}

// A mutant failure counts only if the same file passes unmutated.
const suspect = [...new Set(Object.values(verdict).flatMap((v) => v.failed.map((f) => f.split(' > ')[0])))];
if (suspect.length) {
  build(srcText);
  const baseUnit = suspect.filter((f) => !f.startsWith('packages/e2e/'));
  const baseE2e = suspect.filter((f) => f.startsWith('packages/e2e/'));
  const baseFailed = [
    ...(baseUnit.length ? (vitest('baseline-unit', baseUnit) ?? ['<broke>']) : []),
    ...(baseE2e.length ? (vitest('baseline-e2e', ['--config', 'vitest.e2e.config.ts', ...baseE2e]) ?? ['<broke>']) : []),
  ];
  for (const v of Object.values(verdict)) v.failed = v.failed.filter((f) => !baseFailed.includes(f));
  if (baseFailed.length && Object.values(verdict).every((v) => v.failed.length === 0)) finish(2, `failures also happen unmutated: ${baseFailed.join('; ')}`);
}
for (const [name, v] of Object.entries(verdict)) log(`mutant ${name}: ${v.failed.length ? `KILLED by ${v.failed.length} test(s)` : 'SURVIVED: every test passes with this check removed'}`);

const survived = Object.entries(verdict).filter(([, v]) => v.failed.length === 0).map(([n]) => n);
if (!safeHead || !safeTracked) finish(4, 'the built code lets the branch move over a mid-sync commit or edit');
if (survived.length) finish(1, `R-47 present: no test exercises step 9's ${survived.join(' and ')} check`);
if (!designHead || !designTracked) finish(3, `the CAS branches are tested, but the built code's outcome deviates from §2.3.5 step 9 (head: ${brief(real.head).result}, record left: ${real.head.recordLeft})`);
finish(0, 'no defect: both CAS checks are exercised and behave as §2.3.5 specifies');

function finish(code, msg) {
  console.log(`\nRESULT (exit ${code}): ${msg}`);
  if (process.env.R47_KEEP === '1') console.log(`kept ${WORK}`);
  else rmSync(WORK, { recursive: true, force: true });
  process.exit(code);
}
