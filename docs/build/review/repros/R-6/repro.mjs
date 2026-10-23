// R-6 reproduction: sync's HEAD compare-and-swap (step 9) runs before the slow `git status` and in-the-way checks,
// so a commit that lands on the branch while those run is reset away: `git reset --keep <target>` moves whatever the
// branch points at by then, the backup ref holds the older tip, and verify (HEAD == target) reports `synced`.
//
// Setup: a local bare remote with agenthub.json (land section on), an agent clone on branch agent-a, a real in-process
// hub (SqliteStore ':memory:', port 0), and the built adapter's syncWorkspace (the engine behind hub_sync, `hub sync`
// and the settle-hook sync). No network, no API key.
//
// The race is made deterministic with a PATH shim for git: the first `git status` the sync runs after its write-ahead
// (sync.json written, backup ref made, i.e. step 9's re-check) raises a flag and waits; this process then commits in
// the worktree with the real git binary, as a human in a terminal, a background Bash job or a subagent would while
// `git status` runs on a big worktree; then the shim lets the real `git status` run.
//
// Exit 1 when the defect is present: sync returns while the concurrent commit is reachable from no branch and no
// refs/agenthub ref (only the reflog has it). Exit 0 when the commit survives (on the branch, replayed, or in a backup
// ref). Any other non-zero exit is a harness error.
//
// Run: AGENTHUB_ROOT=/home/user/agenthub node repro.mjs   (AGENTHUB_ROOT defaults to /home/user/agenthub)

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const dist = (pkg, file) => pathToFileURL(path.join(ROOT, 'packages', pkg, 'dist', file)).href;

// Isolate git and the adapter from the developer's config.
for (const k of Object.keys(process.env)) if (k.startsWith('HUB_') || k.startsWith('GIT_')) delete process.env[k];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  HUB_CONFIG: '/nonexistent/agenthub/config.json',
});

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const git = (cwd, ...args) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};
function writeFiles(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
}
function commit(dir, files, msg) {
  writeFiles(dir, files);
  git(dir, 'add', '--', ...Object.keys(files));
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

const { Hub, SqliteStore, startServer } = await import(dist('hub', 'index.js'));
const { syncWorkspace } = await import(dist('adapter', 'sync.js'));
const { HubClient } = await import(dist('adapter', 'client.js'));

const TMP = process.env.R6_TMP || path.join(path.dirname(new URL(import.meta.url).pathname), 'runs');
mkdirSync(TMP, { recursive: true });
const WORK = realpathSync(mkdtempSync(path.join(TMP, 'r6-')));

// The git shim. It only ever delays a `status` in the agent's worktree once the sync's write-ahead exists.
const BIN = path.join(WORK, 'bin');
mkdirSync(BIN);
writeFileSync(
  path.join(BIN, 'git'),
  `#!/bin/sh
REAL='${REAL_GIT}'
if [ -n "$R6_PING" ]; then : > "$R6_PING"; fi
case " $* " in
  *" status "*)
    if [ -n "$R6_REPO" ] && [ "$(pwd -P)" = "$R6_REPO" ] && [ ! -e "$R6_FLAG" ] \\
       && { [ -e "$R6_REPO/.git/agenthub/sync.json" ] || [ -d "$R6_REPO/.git/refs/agenthub/backup" ]; }; then
      : > "$R6_FLAG"
      i=0; while [ ! -e "$R6_DONE" ] && [ $i -lt 400 ]; do sleep 0.025; i=$((i+1)); done
    fi;;
esac
exec "$REAL" "$@"
`,
);
chmodSync(path.join(BIN, 'git'), 0o755);
process.env.PATH = `${BIN}:${process.env.PATH}`;

// Self-test: the adapter's git calls (execFileSync('git') and gitops' spawn('git')) resolve to the shim.
{
  const ping = path.join(WORK, 'ping');
  execFileSync('git', ['--version'], { env: { ...process.env, R6_PING: ping }, stdio: 'ignore' });
  if (!existsSync(ping)) {
    console.error('harness error: the git shim is not on PATH');
    process.exit(3);
  }
}

const AGENT = 'maya/claude-1';
const PROJECT = 'demo';
const server = await startServer({ hub: new Hub({ store: new SqliteStore(':memory:') }), port: 0 });
const cfg = (root) => ({ url: server.url, agent: AGENT, project: PROJECT, token: null, failClosed: false, timeoutMs: 5000, root, configFiles: [], projectSource: 'env', warnings: [] });

function makeRepo(name) {
  const dir = path.join(WORK, name);
  mkdirSync(dir);
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seed);
  writeFiles(seed, { 'agenthub.json': `${JSON.stringify({ project: PROJECT, land: { check: 'true' } }, null, 2)}\n`, 'README.md': 'hi\n' });
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const a = path.join(dir, 'wt-a');
  git(dir, 'clone', '-q', remote, a);
  git(a, 'checkout', '-q', '-b', 'agent-a');
  return { dir, remote, seed, a };
}

/** Run one scenario; returns true when the concurrent commit was lost. */
async function scenario(name, { unlanded }) {
  console.log(`\n=== ${name} ===`);
  const r = makeRepo(name.replace(/\W+/g, '-'));
  if (unlanded) commit(r.a, { 'mine.txt': 'mine\n' }, 'mine: one unlanded commit');
  commit(r.seed, { 'trunk.txt': 'trunk\n' }, 'trunk moved');
  git(r.seed, 'push', '-q', 'origin', 'main');
  const orig = git(r.a, 'rev-parse', 'HEAD').trim();

  const flag = path.join(r.dir, 'flag');
  const done = path.join(r.dir, 'done');
  Object.assign(process.env, { R6_REPO: r.a, R6_FLAG: flag, R6_DONE: done });

  // The "other process": commits on the branch once the sync's step-9 status is running.
  let late = null;
  let headAtInjection = null;
  const watcher = setInterval(() => {
    if (late || !existsSync(flag)) return;
    headAtInjection = git(r.a, 'rev-parse', 'HEAD').trim();
    late = commit(r.a, { 'late.txt': 'late work, committed while sync ran\n' }, 'committed while sync ran');
    writeFileSync(done, '');
  }, 10);

  let res;
  try {
    res = await syncWorkspace(r.a, cfg(r.a), new HubClient(cfg(r.a)), { reason: 'explicit' });
  } finally {
    clearInterval(watcher);
    delete process.env.R6_REPO;
  }

  console.log('sync result:', JSON.stringify({ kind: res.kind, reason: res.reason, detail: res.detail, from: res.from, to: res.to, backup_ref: res.backup_ref }));
  if (!late) {
    console.log('the concurrent commit was never made: no `git status` ran after the write-ahead (the window this repro targets is gone)');
    return false;
  }
  const head = git(r.a, 'rev-parse', 'HEAD').trim();
  const containing = git(r.a, 'for-each-ref', '--format=%(refname)', '--contains', late, 'refs/heads/', 'refs/agenthub/').trim();
  const inReflog = (tryGit(r.a, 'reflog', 'show', '--format=%H', 'agent-a') ?? '').split('\n').includes(late);
  const backupSha = res.backup_ref ? tryGit(r.a, 'rev-parse', '--verify', '--quiet', res.backup_ref)?.trim() ?? null : null;
  const lateFile = existsSync(path.join(r.a, 'late.txt'));
  const status = git(r.a, 'status', '--porcelain', '--untracked-files=all').trim();
  console.log(`orig_head (sync's head):        ${orig}`);
  console.log(`HEAD when the commit was made:  ${headAtInjection}  (== orig_head: ${headAtInjection === orig})`);
  console.log(`concurrent commit:              ${late}`);
  console.log(`HEAD after sync:                ${head}`);
  console.log(`backup ref ${res.backup_ref ?? '(none)'} -> ${backupSha ?? '-'}`);
  console.log(`refs containing the commit:     ${containing || '(none: on no branch and in no refs/agenthub ref)'}`);
  console.log(`commit in agent-a's reflog:     ${inReflog}`);
  console.log(`late.txt still in the worktree: ${lateFile}`);
  console.log(`worktree status after sync:     ${status || '(clean)'}`);
  console.log(git(r.a, 'log', '--oneline', '--graph', '-5', 'HEAD'));
  const lost = !containing;
  console.log(lost ? `DEFECT: sync returned '${res.kind}' and the commit made during its CAS window is on no branch and in no backup ref` : 'ok: the concurrent commit survived');
  return lost;
}

let defect = false;
try {
  // The finding's scenario: trunk moved, the branch has one unlanded commit (replay path).
  defect = (await scenario('replay: one unlanded commit', { unlanded: true })) || defect;
  // The plain fast-forward path (branch has nothing unlanded) has the same window.
  defect = (await scenario('fast-forward: nothing unlanded', { unlanded: false })) || defect;
} finally {
  await server.close();
  if (!process.env.R6_KEEP) rmSync(WORK, { recursive: true, force: true });
  else console.log(`\nkept ${WORK}`);
}
console.log(defect ? '\nR-6 REPRODUCED: a commit made during sync step 9 is reset away while sync reports success' : '\nR-6 not present');
process.exit(defect ? 1 : 0);
