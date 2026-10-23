#!/usr/bin/env node
// R-49: `npm run test:e2e` (the §6.6 CP3 gate) silently drops the Phase 3
// end-to-end scenarios when an internal dist file is renamed.
//
// What it does:
//   1. copies the checkout at AGENTHUB_ROOT (default /home/user/agenthub) into a
//      temp dir: sources, tests, fixtures and configs, without .git or any dist,
//      with a node_modules that links the root's third-party packages and points
//      @agenthub/* at the copy's own packages (AGENTHUB_ROOT is never written);
//   2. applies a behaviour-neutral refactor in the copy (default: the lander's
//      src/symbols.ts renamed to src/symbol-scope.ts and its imports updated;
//      R49_REFACTOR=symbols,resolver,hub picks others: lander src/resolver.ts ->
//      src/ai-resolver.ts, hub src/symbol-changes.ts -> src/landed-symbols.ts);
//   3. runs exactly the gate command, `npm run test:e2e` (which runs
//      `npm run build` first), with AGENTHUB_E2E_PHASE unset, and a JSON reporter;
//   4. checks the renamed modules really are the same code (it imports the
//      built module from AGENTHUB_ROOT/packages/*/dist and the renamed one from
//      the copy and compares their exports);
//   5. reads which scenarios ran.
//
// Exit 1 (defect present): the gate exits 0 although §5.5 Phase 3 scenarios
// (1, 2 or 8) were skipped or replaced by the "1-2 without symbol claims"
// stand-in. Exit 0 (defect absent): the gate either ran every Phase 3 scenario
// or failed loudly. Exit 3: the setup itself could not be done (inconclusive).
// R49_CONTROL=1 runs the same thing with no refactor (sanity check: expect the
// Phase 3 scenarios to run). R49_KEEP=1 keeps the temp dir.
//
// No network, no API key: the e2e suite uses a local bare remote, an
// in-process/child hub on port 0 and the stub resolver.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT ?? '/home/user/agenthub');
const CONTROL = process.env.R49_CONTROL === '1';
const KEEP = process.env.R49_KEEP === '1';
const REFACTORS = {
  symbols: { pkg: 'lander', from: 'symbols', to: 'symbol-scope' },
  resolver: { pkg: 'lander', from: 'resolver', to: 'ai-resolver' },
  hub: { pkg: 'hub', from: 'symbol-changes', to: 'landed-symbols' },
};
const chosen = CONTROL ? [] : (process.env.R49_REFACTOR ?? 'symbols').split(',').map((s) => s.trim()).filter(Boolean);

function inconclusive(msg) {
  console.error(`INCONCLUSIVE: ${msg}`);
  process.exit(3);
}

for (const name of chosen) if (!REFACTORS[name]) inconclusive(`unknown refactor ${name} (known: ${Object.keys(REFACTORS).join(', ')})`);
if (!existsSync(path.join(ROOT, 'package.json'))) inconclusive(`${ROOT} is not a checkout`);
if (!existsSync(path.join(ROOT, 'node_modules'))) inconclusive(`${ROOT}/node_modules is missing (run npm ci there)`);
for (const name of chosen) {
  const r = REFACTORS[name];
  if (!existsSync(path.join(ROOT, 'packages', r.pkg, 'dist', `${r.from}.js`))) inconclusive(`${ROOT}/packages/${r.pkg}/dist/${r.from}.js is not built (run npm run build there)`);
  if (!existsSync(path.join(ROOT, 'packages', r.pkg, 'src', `${r.from}.ts`))) inconclusive(`${ROOT}/packages/${r.pkg}/src/${r.from}.ts does not exist: refactor ${name} cannot be applied`);
}

// --------------------------------------------------------------- 1. the copy
const W = mkdtempSync(path.join(tmpdir(), 'r49-'));
console.log(`work dir: ${W}`);
const skip = new Set(['.git', 'node_modules']);
cpSync(ROOT, W, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src);
    if (rel === '') return true;
    const parts = rel.split(path.sep);
    if (parts.length === 1 && skip.has(parts[0])) return false;
    // packages/<pkg>/dist and packages/<pkg>/node_modules: the build makes dist afresh.
    if (parts[0] === 'packages' && parts.length === 3 && (parts[2] === 'dist' || parts[2] === 'node_modules')) return false;
    return true;
  },
});
const nm = path.join(W, 'node_modules');
mkdirSync(nm);
const rootNm = path.join(ROOT, 'node_modules');
for (const entry of readdirSync(rootNm)) {
  if (entry === '@agenthub' || entry === '.bin' || entry.startsWith('.vite') || entry === '.vitest-cache' || entry === '.package-lock.json') continue;
  symlinkSync(realpathSync(path.join(rootNm, entry)), path.join(nm, entry));
}
mkdirSync(path.join(nm, '@agenthub'));
for (const pkg of readdirSync(path.join(W, 'packages'))) {
  const pj = path.join(W, 'packages', pkg, 'package.json');
  if (!existsSync(pj)) continue;
  const name = JSON.parse(readFileSync(pj, 'utf8')).name;
  if (name?.startsWith('@agenthub/')) symlinkSync(path.join('..', '..', 'packages', pkg), path.join(nm, name));
}
mkdirSync(path.join(nm, '.bin'));
for (const bin of readdirSync(path.join(rootNm, '.bin'))) {
  const target = realpathSync(path.join(rootNm, '.bin', bin));
  const rel = path.relative(ROOT, target);
  // Bins of our own packages point into the copy; third-party ones at the root's.
  symlinkSync(rel.startsWith(`packages${path.sep}`) ? path.join(W, rel) : target, path.join(nm, '.bin', bin));
}

// --------------------------------------------------------------- 2. the refactor
function walkTs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
for (const name of chosen) {
  const { pkg, from, to } = REFACTORS[name];
  const base = path.join(W, 'packages', pkg);
  renameSync(path.join(base, 'src', `${from}.ts`), path.join(base, 'src', `${to}.ts`));
  let touched = 0;
  for (const file of [...walkTs(path.join(base, 'src')), ...walkTs(path.join(base, 'test'))]) {
    const text = readFileSync(file, 'utf8');
    const next = text
      .replaceAll(`'./${from}.js'`, `'./${to}.js'`)
      .replaceAll(`"./${from}.js"`, `"./${to}.js"`)
      .replaceAll(`'../src/${from}.js'`, `'../src/${to}.js'`)
      .replaceAll(`"../src/${from}.js"`, `"../src/${to}.js"`);
    if (next !== text) {
      writeFileSync(file, next);
      touched++;
    }
  }
  console.log(`refactor ${name}: packages/${pkg}/src/${from}.ts -> src/${to}.ts (${touched} importing files updated)`);
}

// --------------------------------------------------------------- 3. the gate command
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('AGENTHUB_E2E_')) delete env[k];
delete env.AGENTHUB_ROOT;
env.npm_config_update_notifier = 'false';
env.npm_config_fund = 'false';
env.npm_config_audit = 'false';
env.npm_config_offline = 'true';
const reportFile = path.join(W, 'e2e-report.json');
const logFile = path.join(W, 'test-e2e.log');
const fd = openSync(logFile, 'w');
console.log(`running: npm run test:e2e  (in the copy, AGENTHUB_E2E_PHASE unset; log ${logFile})`);
const started = Date.now();
const res = spawnSync('npm', ['run', 'test:e2e', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`], {
  cwd: W,
  env,
  stdio: ['ignore', fd, fd],
  timeout: 30 * 60_000,
});
closeSync(fd);
const log = readFileSync(logFile, 'utf8');
console.log(`npm run test:e2e exited ${res.status}${res.signal ? ` (signal ${res.signal})` : ''} after ${Math.round((Date.now() - started) / 1000)} s`);

// --------------------------------------------------------------- 4. the refactor is behaviour-neutral
let sameCode = true;
for (const name of chosen) {
  const { pkg, from, to } = REFACTORS[name];
  const dist = path.join(W, 'packages', pkg, 'dist');
  const renamedThere = existsSync(path.join(dist, `${to}.js`));
  const oldThere = existsSync(path.join(dist, `${from}.js`));
  console.log(`copy's build: packages/${pkg}/dist/${to}.js ${renamedThere ? 'exists' : 'MISSING'}, dist/${from}.js ${oldThere ? 'exists' : 'absent'}`);
  if (!renamedThere) {
    if (res.status !== 0) {
      console.log(log.split('\n').slice(-60).join('\n'));
      inconclusive('the build of the refactored copy failed');
    }
    sameCode = false;
    continue;
  }
  try {
    const original = await import(pathToFileURL(path.join(ROOT, 'packages', pkg, 'dist', `${from}.js`)).href);
    const renamed = await import(pathToFileURL(path.join(dist, `${to}.js`)).href);
    const a = Object.keys(original).sort();
    const b = Object.keys(renamed).sort();
    const equal = JSON.stringify(a) === JSON.stringify(b);
    sameCode &&= equal;
    console.log(`exports of ${ROOT}/packages/${pkg}/dist/${from}.js vs the copy's dist/${to}.js: ${equal ? 'identical' : 'DIFFER'} [${a.join(', ')}]`);
  } catch (err) {
    console.log(`could not import for comparison: ${err.message}`);
  }
}
if (!sameCode) inconclusive('the refactored build is not the same code');

// --------------------------------------------------------------- 5. what ran
if (!existsSync(reportFile)) {
  console.log(log.split('\n').slice(-80).join('\n'));
  if (res.status === 0) inconclusive('no JSON report although the gate exited 0');
  console.log('RESULT: the gate failed loudly (no report): the defect (a silent pass) is absent.');
  process.exit(0);
}
const report = JSON.parse(readFileSync(reportFile, 'utf8'));
const tests = report.testResults.flatMap((f) => f.assertionResults.map((a) => ({ title: a.title, status: a.status })));
console.log('\nscenarios as the gate reported them:');
for (const t of tests) console.log(`  ${t.status.padEnd(8)} ${t.title.slice(0, 110)}`);
const phase3 = { '1': 'symbol parallelism', '2': 'impact', '8': 'conflict + AI' };
const dropped = [];
for (const [n, what] of Object.entries(phase3)) {
  const t = tests.find((x) => x.title.startsWith(`${n}. `));
  if (!t) dropped.push(`${n}. ${what}: not registered`);
  else if (t.status !== 'passed' && t.status !== 'failed') dropped.push(`${n}. ${what}: ${t.status}`);
}
const standIn = tests.find((x) => x.title.startsWith('1-2 without symbol claims'));
if (standIn) dropped.push(`"1-2 without symbol claims" (the Phase 2 stand-in, with agenthub.json symbols.enabled=false) ran: ${standIn.status}`);
console.log(`\nvitest summary: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ${report.numPendingTests} skipped, ${report.numTodoTests ?? 0} todo; success=${report.success}`);

const cfg = readFileSync(path.join(ROOT, 'vitest.e2e.config.ts'), 'utf8');
const pkgJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
console.log(`root package.json test:e2e = ${JSON.stringify(pkgJson.scripts?.['test:e2e'])} (sets AGENTHUB_E2E_PHASE: ${/AGENTHUB_E2E_PHASE/.test(pkgJson.scripts?.['test:e2e'] ?? '') ? 'yes' : 'no'})`);
console.log(`vitest.e2e.config.ts: passWithNoTests ${/passWithNoTests:\s*true/.test(cfg) ? 'true' : 'not true'}; sets AGENTHUB_E2E_PHASE: ${/AGENTHUB_E2E_PHASE/.test(cfg) ? 'yes' : 'no'}; stale "no tests until ... A5" comment: ${/no tests until/i.test(cfg) ? 'yes' : 'no'}`);

if (!KEEP) rmSync(W, { recursive: true, force: true });
else console.log(`kept ${W}`);

if (res.status !== 0) {
  console.log(`\nRESULT: the gate exited ${res.status}: it failed loudly, so the defect (a silent pass) is absent${dropped.length ? `, though it also dropped: ${dropped.join('; ')}` : ''}.`);
  process.exit(0);
}
if (dropped.length) {
  console.log(`\nDEFECT: \`npm run test:e2e\` exited 0 after a behaviour-neutral ${CONTROL ? '(no)' : chosen.join('+')} refactor, but the §5.5 Phase 3 scenarios did not run:`);
  for (const d of dropped) console.log(`  - ${d}`);
  process.exit(1);
}
console.log('\nRESULT: every Phase 3 scenario (1, 2, 8) ran and the gate passed: defect absent.');
process.exit(0);
