// R-47 scenario: something changes the worktree between sync's plan (step 7) and its apply (step 9).
//
// usage: node scenario.mjs <adapter-dist-dir> <head|tracked>
//
// A git shim first on PATH waits for sync's own `git update-ref -m "agenthub sync: backup before moving the branch"`
// (step 8, the write-ahead backup ref: after the plan, before the CAS) and then, once:
//   head:    commits N in the worktree (what the agent's Bash `git commit` does mid-sync)
//   tracked: edits a tracked file without committing (an IDE, a Bash sed)
// The sync engine is the built one from <adapter-dist-dir>/sync.js; the hub is an in-process real Hub on port 0
// from ${AGENTHUB_ROOT}/packages/hub/dist. No network, no API key. Prints one JSON line with what happened.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT ?? '/home/user/agenthub';
const [distDir, mode] = process.argv.slice(2);
if (!distDir || !['head', 'tracked'].includes(mode)) {
  console.error('usage: node scenario.mjs <adapter-dist-dir> <head|tracked>');
  process.exit(64);
}

const imp = (p) => import(pathToFileURL(p).href);
const { syncWorkspace, syncPaths, interruptedSync } = await imp(path.join(distDir, 'sync.js'));
const { HubClient } = await imp(path.join(distDir, 'client.js'));
const { Hub, SqliteStore, startServer } = await imp(path.join(ROOT, 'packages/hub/dist/index.js'));

// git must not read the developer's config, here and in the shim.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  HUB_CONFIG: '/nonexistent/agenthub/config.json',
});
for (const k of Object.keys(process.env)) if (k.startsWith('HUB_') && k !== 'HUB_CONFIG') delete process.env[k];

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const git = (cwd, ...args) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rev = (cwd, r = 'HEAD') => git(cwd, 'rev-parse', r).trim();

const dir = mkdtempSync(path.join(tmpdir(), 'r47-'));
const out = { mode, dist: distDir };
let server;
try {
  // A bare remote with a small project (land section on), and agent B's clone on branch agent-b.
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seed);
  mkdirSync(path.join(seed, 'src'), { recursive: true });
  writeFileSync(path.join(seed, 'src', 'auth.ts'), 'export function login(user: string) {\n  return `session-${user}`;\n}\n');
  writeFileSync(path.join(seed, 'src', 'users.ts'), 'export const users = ["maya", "sam"];\n');
  writeFileSync(path.join(seed, 'check.mjs'), 'process.exit(0);\n');
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: 'demo', land: { check: 'node check.mjs' } }, null, 2)}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const wt = path.join(dir, 'wt-b');
  git(dir, 'clone', '-q', remote, wt);
  git(wt, 'checkout', '-q', '-b', 'agent-b');
  const orig = rev(wt);

  // Trunk moves (someone else's change to src/users.ts): agent-b is behind and clean, so the plan is a fast-forward.
  writeFileSync(path.join(seed, 'src', 'users.ts'), 'export const users = [];\n');
  git(seed, 'commit', '-q', '-am', 'trunk moves');
  git(seed, 'push', '-q', 'origin', 'main');
  const tip = rev(seed);

  // The shim: the real git, plus (once) the mid-sync change right after sync's backup update-ref.
  const shimDir = path.join(dir, 'shim');
  mkdirSync(shimDir);
  const nFile = path.join(dir, 'N.sha');
  const once = path.join(dir, 'shim.fired');
  writeFileSync(
    path.join(shimDir, 'git'),
    `#!/bin/sh
"${REAL_GIT}" "$@"
code=$?
case "$*" in
  *"update-ref -m agenthub sync: backup before moving the branch"*)
    if [ ! -e "${once}" ]; then
      : > "${once}"
      if [ "${mode}" = head ]; then
        mkdir -p docs && printf 'committed while the sync was replaying\\n' > docs/meanwhile.md
        "${REAL_GIT}" add docs/meanwhile.md && "${REAL_GIT}" commit -q -m "N: committed mid-sync" >/dev/null 2>&1
        "${REAL_GIT}" rev-parse HEAD > "${nFile}"
      else
        printf '// edited mid-sync, not committed\\n' >> src/auth.ts
      fi
    fi
    ;;
esac
exit $code
`,
  );
  chmodSync(path.join(shimDir, 'git'), 0o755);

  const hub = new Hub({ store: new SqliteStore(':memory:') });
  server = await startServer({ hub, port: 0, sweepIntervalMs: 100, landerToken: 'lander-secret-for-tests' });
  const agent = 'sam/claude-1';
  const cfg = { url: server.url, agent, project: 'demo', token: null, failClosed: false, timeoutMs: 5000, root: wt, configFiles: [], projectSource: 'env', warnings: [] };
  const client = new HubClient({ ...cfg, root: '/' });

  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
  let r;
  try {
    r = await syncWorkspace(wt, cfg, client, { reason: 'explicit' });
  } finally {
    process.env.PATH = savedPath;
  }
  const p = syncPaths(wt);
  const backups = git(wt, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/agenthub/backup/').split('\n').filter(Boolean);
  const N = existsSync(nFile) ? readFileSync(nFile, 'utf8').trim() : null;
  const head = rev(wt);
  const isAnc = (a, b) => {
    try {
      git(wt, 'merge-base', '--is-ancestor', a, b);
      return true;
    } catch {
      return false;
    }
  };
  Object.assign(out, {
    shimFired: existsSync(once),
    orig,
    tip,
    N,
    result: r,
    head,
    headIs: head === N ? 'N' : head === orig ? 'orig' : head === tip ? 'tip (target)' : 'other',
    nOnBranch: N ? isAnc(N, head) : null,
    meanwhileFile: existsSync(path.join(wt, 'docs', 'meanwhile.md')),
    authEditKept: readFileSync(path.join(wt, 'src', 'auth.ts'), 'utf8').includes('edited mid-sync'),
    status: git(wt, 'status', '--porcelain', '--untracked-files=no').trim(),
    backupRefs: backups,
    backupHoldsN: N ? backups.some((l) => l.endsWith(` ${N}`)) : null,
    recordLeft: existsSync(p.record),
    preEditWouldDeny: interruptedSync(p) !== null,
  });
  // What the agent's next hub_sync says (no shim now).
  const again = await syncWorkspace(wt, cfg, client, { reason: 'explicit' });
  out.nextSync = { kind: again.kind, reason: again.reason ?? null, recovered: again.recovered ?? null };
} catch (err) {
  out.error = String(err?.stack ?? err);
} finally {
  if (server) await server.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
