// R-21 reproduction: a sync whose CAS (step 9) refuses because HEAD moved while
// the sync was being prepared must end 'skipped: changed_meanwhile' (design
// §2.3.5 step 9), touching nothing and leaving edits allowed. needs_human is
// for an interrupted sync only (step 0, §4.5 "Adapter crash during sync").
//
// Setup: a local bare remote with a land section, an agent clone on its own
// branch with one unlanded commit, trunk moved ahead, the real hub in-process
// on port 0, and a loopback forwarder in front of it that makes a commit in
// the agent checkout (a human's terminal commit, or a subagent's Bash
// `git commit`) the first time the sync asks the hub for /status (step 5).
//
// Exit 0: the design's behaviour. Exit 1: the defect (needs_human, edits
// blocked, hub_sync cannot clear it). Exit 2: the harness itself failed.
//
// Run: AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
// No network, no API key, no resolver involved.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const dist = (pkg, file) => path.join(ROOT, 'packages', pkg, 'dist', file);
const CLI = path.join(ROOT, 'packages', 'adapter', 'bin', 'hub.js');

// In-process git (the sync engine) must not read the developer's git config.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
for (const k of Object.keys(process.env)) if (k.startsWith('HUB_') || (k.startsWith('GIT_') && !(k in GIT_ENV))) delete process.env[k];
Object.assign(process.env, GIT_ENV, { HUB_CONFIG: '/nonexistent/agenthub/config.json' });

const { Hub, SqliteStore, startServer } = await import(dist('hub', 'index.js'));
const { syncWorkspace, syncPaths } = await import(dist('adapter', 'sync.js'));
const { HubClient } = await import(dist('adapter', 'client.js'));
const { syncToolText } = await import(dist('adapter', 'format.js'));

const PROJECT = 'demo';
const AGENT = 'maya/claude-1';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rev = (cwd, r = 'HEAD') => git(cwd, 'rev-parse', r).trim();
function commit(dir, files, msg) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return rev(dir);
}

const tmpBase = process.env.REPRO_TMP || tmpdir();
const work = mkdtempSync(path.join(tmpBase, 'agenthub-r21-'));

/** A bare remote with a land section, an agent clone `a` on branch agent-a with one unlanded commit, and trunk one commit ahead. */
function makeRepo(name) {
  const dir = path.join(work, name);
  mkdirSync(dir);
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seed);
  commit(seed, { 'agenthub.json': `${JSON.stringify({ project: PROJECT, land: { check: 'true' } }, null, 2)}\n`, 'README.md': 'hi\n' }, 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const a = path.join(dir, 'a');
  git(dir, 'clone', '-q', remote, a);
  git(a, 'checkout', '-q', '-b', 'agent-a');
  const mine = commit(a, { 'mine.txt': 'my unlanded work\n' }, 'mine');
  const trunk = commit(seed, { 'trunk.txt': 'trunk moved\n' }, 'trunk');
  git(seed, 'push', '-q', 'origin', 'main');
  return { dir, remote, seed, a, mine, trunk };
}

/** Forwards to the real hub; `onStatus` runs (once) when the sync's GET /status arrives, before it is answered. */
async function forwarder(target, onStatus) {
  let fired = false;
  const t = new URL(target);
  const server = http.createServer((req, res) => {
    if (!fired && req.method === 'GET' && /\/status$/.test(req.url ?? '')) {
      fired = true;
      onStatus();
    }
    const headers = { ...req.headers, host: t.host };
    const up = http.request({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    fired: () => fired,
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

const cfgFor = (url, root) => ({ url, agent: AGENT, project: PROJECT, token: null, failClosed: false, timeoutMs: 5000, root, configFiles: [], projectSource: 'env', warnings: [] });
const sync = (url, root, extra = {}) => syncWorkspace(root, cfgFor(url, root), new HubClient(cfgFor(url, root)), { reason: 'explicit', ...extra });

function cli(args, cwd, url, input = '') {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HUB_URL: url, HUB_PROJECT: PROJECT, HUB_AGENT: AGENT };
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const preEditInput = (cwd, file, tool) =>
  JSON.stringify({
    session_id: 'sess-r21',
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'hi', new_string: 'hello', replace_all: false },
    tool_use_id: tool,
  });
const decisionOf = (out) => {
  if (!out.stdout.trim()) return { decision: 'allow', reason: null };
  const h = JSON.parse(out.stdout).hookSpecificOutput ?? {};
  return { decision: h.permissionDecision ?? 'allow', reason: h.permissionDecisionReason ?? null };
};

const hub = await startServer({ hub: new Hub({ store: new SqliteStore(':memory:') }), port: 0 });
const closers = [() => hub.close()];
let exitCode = 2;
try {
  // ---- control: the same setup with no commit meanwhile syncs (the replay is fine).
  const c = makeRepo('control');
  const control = await sync(hub.url, c.a);
  console.log(`control sync (nothing moves HEAD): kind=${control.kind}${control.kind === 'synced' ? ` replayed=${control.replayed}` : ''}`);
  if (control.kind !== 'synced') throw new Error(`harness: the control sync should have synced, got ${JSON.stringify(control)}`);

  // ---- the scenario: HEAD moves while the sync waits on the hub's /status (step 5).
  const r = makeRepo('scenario');
  let meanwhile = null;
  const fwd = await forwarder(hub.url, () => {
    meanwhile = commit(r.a, { 'later.txt': 'committed in a terminal while the sync ran\n' }, 'meanwhile');
  });
  closers.unshift(() => fwd.close());

  const first = await sync(fwd.url, r.a);
  if (!fwd.fired() || !meanwhile) throw new Error('harness: the sync never asked the hub for /status');
  const head = rev(r.a);
  const p = syncPaths(r.a);
  const record = existsSync(p.record) ? JSON.parse(readFileSync(p.record, 'utf8')) : null;
  console.log(`\nfirst sync: ${JSON.stringify(first)}`);
  console.log(`  tool text: ${syncToolText(first)}`);
  console.log(`  HEAD after: ${head.slice(0, 7)} (the meanwhile commit ${meanwhile.slice(0, 7)}; untouched: ${head === meanwhile})`);
  console.log(`  untracked/tracked worktree clean: ${git(r.a, 'status', '--porcelain').trim() === ''}`);
  console.log(`  sync.json left behind: ${JSON.stringify(record)}`);

  // The real pre-edit hook (what Claude Code runs before every Edit/Write).
  const gate1 = decisionOf(await cli(['hook', 'pre-edit'], r.a, hub.url, preEditInput(r.a, path.join(r.a, 'README.md'), 'toolu_r21_1')));
  console.log(`\npre-edit after the first sync: ${gate1.decision}${gate1.reason ? ` (${gate1.reason})` : ''}`);

  // What the agent is told to do: call hub_sync (here: `hub sync`, the same engine).
  const second = await cli(['sync'], r.a, hub.url);
  const secondText = `${second.stdout}${second.stderr}`.trim();
  console.log(`\nsecond sync (\`hub sync\`, as hub_sync): exit=${second.code}\n  ${secondText}`);
  const gate2 = decisionOf(await cli(['hook', 'pre-edit'], r.a, hub.url, preEditInput(r.a, path.join(r.a, 'README.md'), 'toolu_r21_2')));
  console.log(`pre-edit after the second sync: ${gate2.decision}${gate2.reason ? ` (${gate2.reason})` : ''}`);

  const problems = [];
  if (first.kind !== 'skipped' || first.reason !== 'changed_meanwhile') problems.push(`first sync returned ${first.kind}${first.reason ? `/${first.reason}` : ''}, design §2.3.5 step 9 says 'skipped: changed_meanwhile'`);
  if (record) problems.push(`sync.json left behind (pid ${record.pid}) for a sync that was refused, not interrupted`);
  if (gate1.decision === 'deny') problems.push('pre-edit denies every edit after a refused CAS');
  if (/hub sync --recover|interrupted/i.test(secondText)) problems.push('a second hub_sync cannot clear it: needs_human again');
  if (gate2.decision === 'deny') problems.push('edits still denied after hub_sync');
  if (head !== meanwhile) problems.push('the worktree was rewritten (HEAD is not the meanwhile commit)');

  if (problems.length) {
    console.log(`\nDEFECT R-21 PRESENT:\n - ${problems.join('\n - ')}`);
    exitCode = 1;
  } else {
    console.log('\nOK: the refused CAS ended changed_meanwhile and edits stay allowed.');
    exitCode = 0;
  }
} catch (err) {
  console.error(err);
  exitCode = 2;
} finally {
  for (const close of closers) await close().catch(() => {});
  if (!process.env.REPRO_KEEP) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
process.exit(exitCode);
