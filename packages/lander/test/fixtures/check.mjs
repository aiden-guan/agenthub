#!/usr/bin/env node
// The integration tests' check command (design §5 "The check command"),
// committed into the test repositories and run as `node check.mjs` in a fresh
// worktree of the candidate. Deterministic:
// - it appends "<landing> <cwd>" to $AGENTHUB_TEST_GATE/runs.log (the check-run counter);
// - if $AGENTHUB_TEST_GATE/block exists, it removes it, writes `started`, and
//   waits until `release` exists (a test moves trunk during the checks);
// - it fails when a tracked file contains the failure marker, printing
//   vitest-shaped failure lines.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const MARKER = 'FAIL' + '!';
const gate = process.env.AGENTHUB_TEST_GATE;
const landing = process.env.AGENTHUB_LANDING ?? '?';
if (gate) {
  appendFileSync(`${gate}/runs.log`, `${landing} ${process.cwd()}\n`);
  if (existsSync(`${gate}/block`)) {
    rmSync(`${gate}/block`, { force: true });
    writeFileSync(`${gate}/started`, landing);
    while (!existsSync(`${gate}/release`)) await new Promise((r) => setTimeout(r, 20));
  }
}
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
  console.log(`\n Test Files  ${bad.length} failed`);
  process.exit(1);
}
console.log(`checked ${files.length} files: ok`);
