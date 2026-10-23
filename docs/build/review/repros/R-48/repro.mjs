// R-48 reproduction: hub approve's digest-mismatch refusal and `hub lander resume`'s
// terminal checks have no test.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// 1. probes.mjs runs against $AGENTHUB_ROOT's built packages: the behaviour is there
//    today (approve refuses a digest mismatch; resume refuses without a TTY, without
//    a typed `resume`, and sends --accept-trunk).
// 2. Mutation check (the defect): a scratch copy of $AGENTHUB_ROOT (tracked tree is
//    never touched) gets approve.ts mutated the way the finding's scenarios describe,
//    the adapter is rebuilt with the repo's own tsc, and the repo's own test suite for
//    packages/adapter is run against it (R48_E2E=1 adds the end-to-end suite, which
//    also drives `hub approve`). The probes are run against each mutant too, to show
//    the mutant really removes the safety check.
//      M1  approve.ts:150  drop the stale-digest filter (approve what the hub says, whatever was shown)
//      M2  approve.ts:277  drop the isTTY check of `hub lander resume`
//      M3  approve.ts:288  drop the typed `resume` confirmation
//      M4  approve.ts:290  drop --accept-trunk from the resume request
//
// Exit 1: at least one mutant survives the repo's suite (the defect: no test covers it).
// Exit 0: every mutant is killed by some test of the repo.
// Exit 2: inconclusive (a mutation pattern no longer matches, the copy doesn't build,
//         or the approve tests were skipped in this environment).
// No network, no API key: an in-process hub on port 0, local bare remotes.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const E2E = process.env.R48_E2E === '1';
const log = (...a) => console.log(...a);

function probes(root) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'probes.mjs'), root], { encoding: 'utf8', timeout: 180_000 });
  const line = r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  let parsed = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = { probes: [{ name: 'probes did not report', ok: false, detail: { stdout: r.stdout, stderr: r.stderr } }] };
  }
  return { code: r.status, probes: parsed.probes };
}

// ---- 1. The behaviour, against the checkout's own build.
log(`R-48 against ${ROOT}`);
const base = probes(ROOT);
for (const p of base.probes) log(`  [${p.ok ? 'ok ' : 'BAD'}] ${p.name}${p.ok ? '' : `\n        ${JSON.stringify(p.detail)}`}`);
const behaviourOk = base.code === 0;
if (!behaviourOk) log('The safety behaviour itself is missing in this build (worse than R-48 claims).');

// ---- 2. A scratch copy with its own node_modules shim (workspace links point into the copy).
const work = mkdtempSync(path.join(tmpdir(), 'r48-mutant-'));
const COPY = path.join(work, 'agenthub');
mkdirSync(COPY);
for (const entry of ['package.json', 'tsconfig.base.json', 'vitest.config.ts', 'vitest.e2e.config.ts', 'packages', 'scripts']) {
  const from = path.join(ROOT, entry);
  if (existsSync(from)) cpSync(from, path.join(COPY, entry), { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
}
mkdirSync(path.join(COPY, 'node_modules'));
for (const name of readdirSync(path.join(ROOT, 'node_modules'))) {
  if (name === '@agenthub') continue;
  symlinkSync(path.join(ROOT, 'node_modules', name), path.join(COPY, 'node_modules', name));
}
mkdirSync(path.join(COPY, 'node_modules', '@agenthub'));
for (const pkg of readdirSync(path.join(COPY, 'packages'))) symlinkSync(path.join('..', '..', 'packages', pkg), path.join(COPY, 'node_modules', '@agenthub', pkg));

const SRC = path.join(COPY, 'packages', 'adapter', 'src', 'approve.ts');
const PRISTINE = readFileSync(SRC, 'utf8');

/** Each mutation: a regex on approve.ts and its replacement; landerCommand's are applied inside that function only. */
const MUTANTS = {
  M1: { what: 'approve.ts:150 stale-digest filter dropped', fn: 'decideCommand', re: /const stale = [^;]+;/, to: 'const stale = shown.filter(() => false);' },
  M2: { what: 'approve.ts:277 `hub lander resume` isTTY check dropped', fn: 'landerCommand', re: /if \(!args\.term\.isTTY\)/, to: 'if (false && !args.term.isTTY)' },
  M3: { what: 'approve.ts:288 typed `resume` confirmation dropped', fn: 'landerCommand', re: /if \(typed !== 'resume'\)/, to: "if (false && typed !== 'resume')" },
  M4: { what: 'approve.ts:290 --accept-trunk dropped from the resume request', fn: 'landerCommand', re: /args\.acceptTrunk \? \{ accept_trunk: args\.acceptTrunk \} : \{\}/, to: '{}' },
};

function mutate(ids) {
  let text = PRISTINE;
  for (const id of ids) {
    const m = MUTANTS[id];
    const start = text.indexOf(`export async function ${m.fn}(`);
    if (start < 0) return { error: `${id}: function ${m.fn} not found` };
    const next = text.indexOf('\nexport ', start + 1);
    const end = next < 0 ? text.length : next;
    const body = text.slice(start, end);
    if (!m.re.test(body)) return { error: `${id}: pattern ${m.re} no longer matches in ${m.fn}` };
    text = text.slice(0, start) + body.replace(m.re, m.to) + text.slice(end);
  }
  writeFileSync(SRC, text);
  const tsc = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'packages/adapter/tsconfig.json'], { cwd: COPY, encoding: 'utf8' });
  if (tsc.status !== 0) return { error: `tsc failed on ${ids.join('+')}: ${tsc.stdout}${tsc.stderr}` };
  return { ok: true };
}

/** The repo's own suite on the copy: per test, "file > name" → status. */
function suite(label) {
  const out = path.join(work, `vitest-${label}.json`);
  const runs = [['run', 'packages/adapter', '--reporter=json', `--outputFile=${out}`]];
  if (E2E) runs.push(['run', '--config', 'vitest.e2e.config.ts', '--reporter=json', `--outputFile=${out}.e2e`]);
  const result = new Map();
  for (const args of runs) {
    spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), ...args], {
      cwd: COPY,
      encoding: 'utf8',
      timeout: 1_500_000,
      env: { ...process.env, ...(E2E ? { AGENTHUB_E2E_PHASE: '3' } : {}) },
      maxBuffer: 1 << 28,
    });
    const file = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
    if (!existsSync(file)) {
      result.set(`<vitest ${args.join(' ')}>`, 'no-report');
      continue;
    }
    const json = JSON.parse(readFileSync(file, 'utf8'));
    for (const f of json.testResults) {
      const rel = path.relative(COPY, f.name);
      if (f.assertionResults.length === 0) result.set(`${rel} > <file>`, f.status);
      for (const t of f.assertionResults) result.set(`${rel} > ${t.fullName}`, t.status);
    }
  }
  return result;
}
const failing = (r) => [...r].filter(([, s]) => s === 'failed' || s === 'no-report').map(([k]) => k);

let exit = behaviourOk ? 0 : 1;
try {
  // Combined mutant first: a test that would notice any one of them fails here too
  // (M1 is in decideCommand; M2..M4 are independent steps of landerCommand).
  const ids = Object.keys(MUTANTS);
  const built = mutate(ids);
  if (built.error) {
    log(`INCONCLUSIVE: ${built.error}`);
    process.exitCode = 2;
    throw null;
  }
  const kill = probes(COPY);
  log(`\nMutant ${ids.join('+')} (${ids.map((i) => MUTANTS[i].what).join('; ')}):`);
  for (const p of kill.probes) log(`  probe ${p.ok ? 'still holds' : 'KILLS it  '}: ${p.name}`);
  log(`Running the repo's own suite (packages/adapter${E2E ? ' + e2e, AGENTHUB_E2E_PHASE=3' : ''}) against the mutant...`);
  const res = suite('combined');
  const ran = [...res].filter(([k]) => /hub approve/.test(k));
  const approveRan = ran.some(([k, s]) => /approves through a terminal/.test(k) && (s === 'passed' || s === 'failed'));
  log(`  ${res.size} tests; ${failing(res).length} failed; ${[...res].filter(([, s]) => s === 'skipped' || s === 'pending').length} skipped`);
  for (const [k, s] of ran) log(`    ${s.padEnd(7)} ${k}`);
  if (!approveRan) {
    log("INCONCLUSIVE: the repo's hub approve tests did not run here (python3 pty missing?).");
    process.exitCode = 2;
    throw null;
  }

  let survivors = [];
  if (failing(res).length === 0) {
    survivors = ids;
  } else {
    // Some test failed: compare with the unmutated copy, then attribute per mutant.
    if (mutate([]).error) throw new Error('could not rebuild the pristine copy');
    const pristineFails = new Set(failing(suite('pristine')));
    for (const id of ids) {
      if (mutate([id]).error) throw new Error(`could not build ${id}`);
      const killed = failing(suite(id)).filter((k) => !pristineFails.has(k));
      log(`  ${id}: ${killed.length ? `killed by ${killed.join(', ')}` : 'survives'}`);
      if (!killed.length) survivors.push(id);
    }
  }
  log('');
  if (survivors.length) {
    for (const id of survivors) log(`SURVIVES: ${id} ${MUTANTS[id].what}: no test of the repo fails.`);
    log('R-48 REPRODUCED: the safety checks above have no test.');
    exit = 1;
  } else {
    log('R-48 not reproduced: every mutant is killed by a test of the repo.');
  }
  process.exitCode = exit;
} catch (err) {
  if (err !== null) {
    log(`INCONCLUSIVE: ${err?.stack ?? err}`);
    process.exitCode = 2;
  }
} finally {
  if (process.env.R48_KEEP !== '1') rmSync(work, { recursive: true, force: true });
  else log(`kept ${work}`);
}
