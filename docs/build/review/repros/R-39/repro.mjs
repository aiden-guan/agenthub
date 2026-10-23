#!/usr/bin/env node
// R-39: sync's fetch passes --no-write-fetch-head (git 2.29+), so on git
// 2.25-2.28 every sync is skipped/fetch_failed instead of the fast-forward
// fallback design §4.5 / R4 promise for "git too old".
//
// No network, no API key. Imports the built packages from
// ${AGENTHUB_ROOT}/packages/*/dist (default /home/user/agenthub).
//
// "git 2.25.1" is modelled the way packages/adapter/test/sync.test.ts models
// "git 2.39.2": a PATH shim in front of the real git that rejects exactly the
// options that git version lacks, as that git does (parse-options:
// "error: unknown option `<name>'" + usage, exit 129):
//   - fetch --no-write-fetch-head          (added in git 2.29)
//   - merge-tree --write-tree/--merge-base (2.38 / 2.40)
//   - `git version` prints 2.25.1
// Everything else is the real git.
//
// Exit 0: on "git 2.25" a clean worktree with nothing of its own fast-forwards
//         to the moved trunk (the §4.5 fallback), and the feed's background
//         fetch updates the remote-tracking trunk.
// Exit 1: the defect: sync is skipped with fetch_failed ("unknown option
//         `no-write-fetch-head'"), the hooks say nothing, the feed's fetch
//         fails and the stale-base heads-up sees a trunk that never moves.
// Exit 2: the rig itself is broken (control case with the real git failed).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const dist = (p) => pathToFileURL(path.join(ROOT, 'packages', p)).href;
const { Hub, SqliteStore, startServer } = await import(dist('hub/dist/index.js'));
const { syncWorkspace, fetchTrunk, staleFiles } = await import(dist('adapter/dist/sync.js'));
const { HubClient } = await import(dist('adapter/dist/client.js'));
const { syncPromptText, syncDigestLine, syncToolText } = await import(dist('adapter/dist/format.js'));
const gitops = await import(dist('gitops/dist/index.js'));
const HUB_BIN = path.join(ROOT, 'packages', 'adapter', 'bin', 'hub.js');

const PROJECT = 'demo';
const AGENT = 'sam/claude-1';

// In-process git must not read the developer's config; no inherited HUB_*/GIT_*.
for (const k of Object.keys(process.env)) if (k.startsWith('HUB_') || k.startsWith('GIT_') || k === 'CLAUDE_PROJECT_DIR') delete process.env[k];
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
const rev = (wt, r = 'HEAD') => git(wt, 'rev-parse', r).trim();
const log = (...a) => console.log(...a);

const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-r39-'));
let server = null;
let exitCode = 1;
try {
  // ---------------------------------------------------------------- the hub and the repositories
  const hub = new Hub({ store: new SqliteStore(':memory:') });
  server = await startServer({ hub, port: 0, sweepIntervalMs: 100, landerToken: 'lander-secret-for-tests' });

  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seed);
  mkdirSync(path.join(seed, 'src'));
  writeFileSync(path.join(seed, 'src', 'users.ts'), 'export const users = ["maya", "sam"];\n');
  writeFileSync(path.join(seed, 'check.mjs'), 'process.exit(0);\n');
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: PROJECT, land: { check: 'node check.mjs' } }, null, 2)}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const t0 = rev(seed);

  // Agent worktrees: clean branches with nothing of their own, at trunk.
  const clone = (name) => {
    const wt = path.join(dir, name);
    git(dir, 'clone', '-q', remote, wt);
    git(wt, 'checkout', '-q', '-b', `agent-${name}`);
    return wt;
  };
  const control = clone('control'); // synced with the real git
  const old = clone('old'); // synced with "git 2.25.1"
  const plain = clone('plain'); // a fetch without the flag, under "git 2.25.1"
  const feed = clone('feed'); // the feed's background fetch and the stale-base heads-up, under "git 2.25.1"

  // Trunk moves.
  writeFileSync(path.join(seed, 'src', 'users.ts'), 'export const users = ["maya", "sam", "lee"];\n');
  git(seed, 'commit', '-q', '-am', 'add lee');
  git(seed, 'push', '-q', 'origin', 'main');
  const t1 = rev(seed);
  log(`trunk moved ${t0.slice(0, 7)} -> ${t1.slice(0, 7)}`);

  const cfgFor = (root) => ({ url: server.url, agent: AGENT, project: PROJECT, token: null, failClosed: false, timeoutMs: 5000, root, configFiles: [], projectSource: 'env', warnings: [] });
  const sync = (root) => syncWorkspace(root, cfgFor(root), new HubClient(cfgFor('/')), { reason: 'explicit' });

  // ---------------------------------------------------------------- control: the real git (2.29+)
  const rc = await sync(control);
  log(`\n[control, ${git(dir, 'version').trim()}] syncWorkspace -> ${JSON.stringify({ kind: rc.kind, reason: rc.reason, detail: rc.detail })}`);
  if (rc.kind !== 'synced' || rev(control) !== t1) {
    log('RIG BROKEN: the control worktree did not fast-forward with the real git');
    exitCode = 2;
    throw new Error('rig');
  }

  // ---------------------------------------------------------------- "git 2.25.1"
  const shimDir = path.join(dir, 'git-2.25.1');
  mkdirSync(shimDir);
  writeFileSync(
    path.join(shimDir, 'git'),
    `#!/bin/sh
# git 2.25.1, as far as these options go; everything else is the real git.
for a in "$@"; do
  case "$a" in
    --no-write-fetch-head) echo "error: unknown option \\\`no-write-fetch-head'" >&2; echo "usage: git fetch [<options>] [<repository> [<refspec>...]]" >&2; exit 129;;
    --write-tree|--merge-base*) echo "usage: git merge-tree <base-tree> <branch1> <branch2>" >&2; exit 129;;
  esac
done
skip=0; sub=
for a in "$@"; do
  if [ $skip = 1 ]; then skip=0; continue; fi
  case "$a" in -c|-C) skip=1;; -*) ;; *) sub=$a; break;; esac
done
if [ "$sub" = version ] || [ "$1" = --version ]; then echo "git version 2.25.1"; exit 0; fi
exec "${REAL_GIT}" "$@"
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`;
  log(`\n[old] PATH git: ${execFileSync('git', ['version'], { encoding: 'utf8' }).trim()}`);

  // The fetch agenthub's Phase 1 `land` uses (no --no-write-fetch-head) works with this git.
  const plainFetch = spawnSync('git', ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { cwd: plain, encoding: 'utf8' });
  log(`[old] git fetch origin +refs/heads/main:refs/remotes/origin/main (no flag) -> exit ${plainFetch.status}; origin/main now ${rev(plain, 'refs/remotes/origin/main').slice(0, 7)}`);

  // 1. Sync (what settle, the digest and hub_sync run).
  const before = rev(old);
  const r = await sync(old);
  log(`[old] syncWorkspace -> ${JSON.stringify(r)}`);
  log(`[old]   hub_sync says:   ${JSON.stringify(syncToolText(r))}`);
  log(`[old]   settle says:     ${JSON.stringify(syncPromptText(r))}`);
  log(`[old]   digest says:     ${JSON.stringify(syncDigestLine(r))}`);
  log(`[old]   HEAD ${before.slice(0, 7)} -> ${rev(old).slice(0, 7)} (trunk is ${t1.slice(0, 7)})`);

  // The same through the real CLI and the real settle hook.
  const env = { ...process.env, HUB_URL: server.url, HUB_PROJECT: PROJECT, HUB_AGENT: AGENT };
  const cli = spawnSync(process.execPath, [HUB_BIN, 'sync'], { cwd: old, env, encoding: 'utf8' });
  log(`[old] \`hub sync\` -> exit ${cli.status}; stdout ${JSON.stringify(cli.stdout)}; stderr ${JSON.stringify(cli.stderr)}`);
  const hookInput = JSON.stringify({ session_id: 'sess-r39', transcript_path: '/tmp/transcript.jsonl', cwd: old, permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: 'carry on' });
  const settle = spawnSync(process.execPath, [HUB_BIN, 'hook', 'settle'], { cwd: old, env, input: hookInput, encoding: 'utf8' });
  log(`[old] \`hub hook settle\` (UserPromptSubmit) -> exit ${settle.status}; stdout ${JSON.stringify(settle.stdout)}`);
  log(`[old]   HEAD after CLI and settle: ${rev(old).slice(0, 7)}`);

  // 2. The feed's background fetch (feed.ts fetchTrunkSoon calls this fetchTrunk).
  const feedError = await fetchTrunk(gitops.open(feed, { isolated: false }), 'origin', 'main', 10_000);
  const tracking = rev(feed, 'refs/remotes/origin/main');
  log(`[old] feed's fetchTrunk -> ${JSON.stringify(feedError)}; origin/main in the worktree: ${tracking.slice(0, 7)}`);

  // 3. The stale-base heads-up compares against that remote-tracking trunk.
  const land = { remote: 'origin', trunk: 'main' };
  const staleOld = staleFiles(feed, ['src/users.ts'], land, 'sess-r39', PROJECT);
  const stalePlain = staleFiles(plain, ['src/users.ts'], land, 'sess-r39', PROJECT);
  log(`[old] stale-base heads-up for src/users.ts: ${JSON.stringify(staleOld)} (with a fetched trunk it would be ${JSON.stringify(stalePlain)})`);

  // ---------------------------------------------------------------- verdict
  const flagRejected = (s) => typeof s === 'string' && /unknown option .?no-write-fetch-head/.test(s);
  const syncDefect = r.kind === 'skipped' && r.reason === 'fetch_failed' && flagRejected(r.detail);
  const feedDefect = flagRejected(feedError);
  if (syncDefect || feedDefect) {
    log('\nDEFECT PRESENT (R-39):');
    if (syncDefect) log(`  - sync on git 2.25 is skipped/fetch_failed (${r.detail}) instead of fast-forwarding a clean worktree to ${t1.slice(0, 7)}; settle and the digest stay silent`);
    if (feedDefect) log(`  - the feed's background fetch fails (${feedError}); origin/main stays at ${tracking.slice(0, 7)}, so the stale-base heads-up never fires`);
    exitCode = 1;
  } else if (r.kind === 'synced' && rev(old) === t1 && tracking === t1) {
    log('\nOK: on git 2.25 sync fast-forwards and the background fetch updates the remote-tracking trunk');
    exitCode = 0;
  } else {
    log(`\nUNEXPECTED: sync -> ${JSON.stringify(r)}, feed fetch -> ${JSON.stringify(feedError)}, HEAD ${rev(old)}, origin/main ${tracking}`);
    exitCode = 1;
  }
} catch (err) {
  if (exitCode !== 2) {
    console.error(err);
    exitCode = 2;
  }
} finally {
  if (server) await server.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
