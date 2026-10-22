#!/usr/bin/env node
// The sample project's check command (design §5 "The check command"). The
// lander runs it as `node check.mjs` in a fresh worktree of each candidate.
// Deterministic:
// - it fails when a tracked file contains the failure marker, printing
//   vitest-shaped failure lines (the lander's failed-test parser reads them);
// - it prints $ENV_PROBE, for checking what the lander passes to checks;
// - with $AGENTHUB_E2E_RUNS set (trunk's checkEnv), it appends the landing id
//   to that file: the check-run counter.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const MARKER = 'FAIL' + '!';
if (process.env.ENV_PROBE) console.log(`env probe: ${process.env.ENV_PROBE}`);
if (process.env.AGENTHUB_E2E_RUNS) appendFileSync(process.env.AGENTHUB_E2E_RUNS, `${process.env.AGENTHUB_LANDING ?? '?'}\n`);

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const bad = files.filter((f) => {
  try {
    return readFileSync(f, 'utf8').includes(MARKER);
  } catch {
    return false;
  }
});
if (bad.length > 0) {
  for (const f of bad) console.log(` FAIL  ${f} > checks > has no failure marker`);
  console.log(`\n Test Files  ${bad.length} failed | ${files.length - bad.length} passed (${files.length})`);
  process.exit(1);
}
console.log(` Test Files  ${files.length} passed (${files.length})`);
