// R-20: a `git reset --keep` that fails (or is killed) part-way leaves the worktree half-synced,
// and the sync engine reports "nothing was changed", drops its record and backup ref, and the
// hooks tell the agent nothing.
//
// Usage: AGENTHUB_ROOT=/path/to/agenthub node repro.mjs     (default /home/user/agenthub)
// Exit 0: the defect is absent. Exit 1: the defect is present. Exit 2: the harness broke.
//
// Everything is local: a bare remote, clones, the real hub server on port 0 (in-process), the built
// adapter (packages/adapter/dist and its bin). No network, no API key, no resolver involved.
//
// The partial failure is made deterministic with a smudge filter, as git LFS uses one:
//   .gitattributes `*.bin filter=lfs`, filter.lfs.smudge=false, filter.lfs.required=true
// i.e. "LFS can't download the object". Trunk changes README.md and adds a.txt and z.bin; git's
// checkout writes entries in index order (README.md, a.txt, then z.bin), so README.md and a.txt
// are written before z.bin's filter fails, and the reset then exits non-zero without touching the
// index or HEAD.

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const dist = (pkg, file) => pathToFileURL(path.join(ROOT, 'packages', pkg, 'dist', file)).href;
const HUB_BIN = path.join(ROOT, 'packages', 'adapter', 'bin', 'hub.js');
const PROJECT = 'demo';
const AGENT = 'maya/claude-1';

// Isolate every git this process and its children run from the developer's config.
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

const { syncWorkspace, syncPaths } = await import(dist('adapter', 'sync.js'));
const { HubClient } = await import(dist('adapter', 'client.js'));

const cfgFor = (root, url) => ({ url, agent: AGENT, project: PROJECT, token: null, failClosed: false, timeoutMs: 5000, root, configFiles: [], projectSource: 'env', warnings: [] });
const syncIn = (root, url, extra = {}) => syncWorkspace(root, cfgFor(root, url), new HubClient(cfgFor(root, url)), { reason: 'explicit', ...extra });

// ---- child mode: run one sync in a process that the smudge filter will SIGKILL mid-reset (scenario D).
if (process.argv[2] === '--child-sync') {
  const [, , , root, url] = process.argv;
  process.env.R20_SYNC_PID = String(process.pid); // for the smudge filter that kills this process mid-reset
  await syncIn(root, url);
  process.exit(0); // not reached when the filter kills us
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (dir, files) => {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
};

const RUNS = path.join(HERE, 'runs');
mkdirSync(RUNS, { recursive: true });
const WORK = mkdtempSync(path.join(RUNS, 'r20-'));

const TRUNK_README = 'README changed on trunk by another agent\n';

/** A bare remote seeded with a project (land section on, `*.bin filter=lfs`), then a trunk commit the agent's clones lack. */
function makeRemote() {
  const remote = path.join(WORK, 'remote.git');
  git(WORK, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(WORK, 'seed');
  git(WORK, 'init', '-q', '-b', 'main', seed);
  write(seed, {
    'agenthub.json': `${JSON.stringify({ project: PROJECT, land: { check: 'node check.mjs' } }, null, 2)}\n`,
    'check.mjs': 'process.exit(0);\n',
    'README.md': 'hello\n',
    '.gitattributes': '*.bin filter=lfs\n',
  });
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const base = git(seed, 'rev-parse', 'HEAD').trim();
  return { remote, seed, base };
}

/** Trunk moves: another agent's landing changes README.md and adds a.txt and z.bin (an LFS-tracked file). */
function moveTrunk(r) {
  write(r.seed, { 'README.md': TRUNK_README, 'a.txt': 'added on trunk\n', 'z.bin': 'version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 4\n' });
  git(r.seed, 'add', '-A');
  git(r.seed, 'commit', '-q', '-m', 'L-1: another agent landed README.md, a.txt, z.bin');
  git(r.seed, 'push', '-q', 'origin', 'main');
  return git(r.seed, 'rev-parse', 'HEAD').trim();
}

/** The agent's clone on its own branch at the old trunk, with an LFS filter that can't download (smudge fails, required). */
function agentClone(r, name, smudge = 'false') {
  const wt = path.join(WORK, name);
  git(WORK, 'clone', '-q', '--no-checkout', r.remote, wt);
  // The clone is made before the filter is configured, at the old trunk, so its checkout succeeds.
  git(wt, 'checkout', '-q', '-b', 'agent-a', r.base);
  git(wt, 'config', 'filter.lfs.smudge', smudge);
  git(wt, 'config', 'filter.lfs.clean', 'cat');
  git(wt, 'config', 'filter.lfs.required', 'true');
  return wt;
}

/** Run a node child asynchronously, so the in-process hub keeps answering while it runs. */
function runNode(args, o) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeout ?? 60_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
    child.stdin.end(o.input ?? '');
  });
}

const head = (wt) => git(wt, 'rev-parse', 'HEAD').trim();
const status = (wt) => git(wt, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean);
const backupRefs = (wt) => git(wt, 'for-each-ref', '--format=%(refname)', 'refs/agenthub/backup/').split('\n').filter(Boolean);
const readme = (wt) => readFileSync(path.join(wt, 'README.md'), 'utf8');
const halfSynced = (wt, before) => head(wt) === before && readme(wt) === TRUNK_README && existsSync(path.join(wt, 'a.txt'));

const defects = [];
const notes = [];
const check = (cond, msg) => {
  if (cond) defects.push(msg);
};
const note = (s) => {
  notes.push(s);
  console.log(s);
};

let server;
let exitCode = 2;
try {
  const { Hub, SqliteStore, startServer } = await import(dist('hub', 'index.js'));
  const hub = new Hub({ store: new SqliteStore(':memory:') });
  server = await startServer({ hub, port: 0, sweepIntervalMs: 100, landerToken: 'lander-secret-for-r20' });
  const url = server.url;
  const { syncToolText, syncPromptText, syncDigestLine } = await import(dist('adapter', 'format.js'));

  const r = makeRemote();
  // Clones first (at the old trunk), then trunk moves.
  const wtA = agentClone(r, 'wt-a'); // hub_sync / hub sync
  const wtB = agentClone(r, 'wt-b'); // the settle hook at UserPromptSubmit, then the next prompt, then land
  const wtC = agentClone(r, 'wt-c'); // the digest hook at SessionStart
  const wtD = agentClone(r, 'wt-d', path.join(WORK, 'kill-mid-reset.sh')); // the sync process is killed mid-reset
  const tip = moveTrunk(r);
  note(`trunk ${r.base.slice(0, 8)} -> ${tip.slice(0, 8)}: README.md changed, a.txt and z.bin added`);

  // ------------------------------------------------------------------ A: hub_sync / `hub sync`
  {
    const before = head(wtA);
    const res = await syncIn(wtA, url);
    const p = syncPaths(wtA);
    note(`\n[A] syncWorkspace -> ${JSON.stringify(res)}`);
    note(`[A] HEAD moved: ${head(wtA) !== before}; git status: ${JSON.stringify(status(wtA))}; README.md is trunk's: ${readme(wtA) === TRUNK_README}`);
    note(`[A] backup refs: ${JSON.stringify(backupRefs(wtA))}; sync.json exists: ${existsSync(p.record)}`);
    note(`[A] hub_sync text: ${syncToolText(res)}`);
    note(`[A] settle text: ${JSON.stringify(syncPromptText(res))}; digest line: ${JSON.stringify(syncDigestLine(res))}`);
    const half = halfSynced(wtA, before);
    if (!half) note('[A] the worktree was not half-synced (git refused before writing, or the reset succeeded)');
    check(half && res.kind === 'skipped' && /Nothing was changed/i.test(syncToolText(res)),
      'A1: the worktree holds trunk\'s README.md and a.txt while HEAD is unmoved, yet sync answers skipped/changed_meanwhile "Nothing was changed"');
    check(half && backupRefs(wtA).length === 0 && !existsSync(p.record),
      'A2: with the worktree half-synced, sync cleared sync.json and deleted the backup ref (I6: the old tip is kept in a backup ref; §4.5: no state in between)');
    check(half && syncPromptText(res) === null && syncDigestLine(res) === null,
      'A3: settle and digest have nothing to say for this outcome (syncPromptText and syncDigestLine are null) though files changed under the agent');
  }

  // ------------------------------------------------------------------ B: the settle hook at UserPromptSubmit (the real `hub hook settle`)
  {
    const env = { ...process.env, HUB_URL: url, HUB_PROJECT: PROJECT, HUB_AGENT: AGENT };
    const prompt = (session) => JSON.stringify({ session_id: session, transcript_path: '/tmp/transcript.jsonl', cwd: wtB, permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: 'carry on' });
    const settle = (session) => runNode([HUB_BIN, 'hook', 'settle'], { cwd: wtB, env, input: prompt(session), timeout: 30_000 });
    const before = head(wtB);
    const s1 = await settle('sess-r20');
    note(`\n[B] hub hook settle (UserPromptSubmit) exit ${s1.status}; stdout ${JSON.stringify(s1.stdout)}; stderr ${JSON.stringify(s1.stderr)}`);
    note(`[B] HEAD moved: ${head(wtB) !== before}; git status: ${JSON.stringify(status(wtB))}; backup refs: ${JSON.stringify(backupRefs(wtB))}`);
    const half = halfSynced(wtB, before);
    // B2 and B3 count only when the agent was never told (B1): a fix that says so at the prompt may leave the files.
    const silent = half && s1.status === 0 && s1.stdout.trim() === '';
    check(silent,
      'B1: settle printed nothing at the prompt although sync wrote trunk\'s README.md and a.txt into the worktree (§2.3.5: "the agent must know its files changed")');

    // The next prompt: trunk's change now reads as the agent's own uncommitted work.
    const s2 = await settle('sess-r20');
    let ctx = '';
    try {
      ctx = JSON.parse(s2.stdout).hookSpecificOutput.additionalContext;
    } catch {
      ctx = s2.stdout;
    }
    note(`[B] next prompt, settle says: ${JSON.stringify(ctx)}`);
    check(silent && /uncommitted changes \([^)]*README\.md/.test(ctx),
      'B2: at the next prompt the agent is told README.md (trunk\'s content, which it never wrote) is its own uncommitted change');

    // land: the preflight tells it to commit everything.
    const { landWork } = await import(dist('adapter', 'land.js'));
    const cfg = cfgFor(wtB, url);
    const out = await landWork({ cfg, client: new HubClient(cfg), feed: null }, {});
    note(`[B] land says: ${JSON.stringify(out.text)}`);
    check(silent && /README\.md/.test(out.text) && /git add -A && git commit/.test(out.text),
      'B3: land tells the agent to `git add -A && git commit`, which commits trunk\'s README.md and a.txt as the agent\'s own change');
  }

  // ------------------------------------------------------------------ C: the digest hook at SessionStart
  {
    const env = { ...process.env, HUB_URL: url, HUB_PROJECT: PROJECT, HUB_AGENT: AGENT };
    const input = JSON.stringify({ session_id: 'sess-r20-c', transcript_path: '/tmp/transcript.jsonl', cwd: wtC, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' });
    const before = head(wtC);
    const d = await runNode([HUB_BIN, 'hook', 'digest'], { cwd: wtC, env, input, timeout: 30_000 });
    let ctx = '';
    try {
      ctx = JSON.parse(d.stdout).hookSpecificOutput.additionalContext ?? '';
    } catch {
      ctx = d.stdout;
    }
    note(`\n[C] hub hook digest (SessionStart) exit ${d.status}; additionalContext ${JSON.stringify(ctx)}`);
    note(`[C] HEAD moved: ${head(wtC) !== before}; git status: ${JSON.stringify(status(wtC))}`);
    const half = halfSynced(wtC, before);
    check(half && !/Trunk:|README\.md|a\.txt/.test(ctx),
      'C1: the SessionStart digest has no Trunk: line and names no changed file although the worktree now holds trunk\'s README.md and a.txt');
  }

  // ------------------------------------------------------------------ D: the sync process is killed mid-reset, then recovery
  {
    // A smudge "filter" that SIGKILLs the sync's node process and the git running the reset, as a kill of
    // the hook's process group (or the OOM killer, or a crash) would mid-checkout. README.md and a.txt
    // are written before z.bin reaches the filter.
    const killer = path.join(WORK, 'kill-mid-reset.sh');
    writeFileSync(killer, '#!/bin/sh\nkill -9 "$R20_SYNC_PID" 2>/dev/null\nkill -9 "$PPID" 2>/dev/null\nsleep 5\nexit 1\n');
    chmodSync(killer, 0o755);
    const before = head(wtD);
    const childScript = fileURLToPath(import.meta.url);
    const child = await runNode([childScript, '--child-sync', wtD, url], { cwd: WORK, env: { ...process.env, AGENTHUB_ROOT: ROOT }, timeout: 60_000 });
    const p = syncPaths(wtD);
    const recordAfterKill = existsSync(p.record) ? JSON.parse(readFileSync(p.record, 'utf8')) : null;
    note(`\n[D] child sync ended by signal ${child.signal} (status ${child.status}); stderr ${JSON.stringify((child.stderr || '').slice(0, 300))}`);
    note(`[D] after the kill: HEAD moved: ${head(wtD) !== before}; git status: ${JSON.stringify(status(wtD))}; sync.json: ${JSON.stringify(recordAfterKill)}; backup refs: ${JSON.stringify(backupRefs(wtD))}; index.lock left: ${existsSync(path.join(wtD, '.git', 'index.lock'))}`);
    const half = halfSynced(wtD, before) && child.signal === 'SIGKILL' && recordAfterKill && recordAfterKill.orig_head === before;
    if (!half) note('[D] the kill did not leave a half-synced worktree with a record; scenario D is inconclusive');
    // git leaves its index.lock when killed; git itself tells the user to remove it, as a human would.
    rmSync(path.join(wtD, '.git', 'index.lock'), { force: true });
    // LFS works again; the next safe point recovers.
    git(wtD, 'config', 'filter.lfs.smudge', 'cat');
    let res;
    try {
      res = await syncIn(wtD, url);
    } catch (err) {
      res = { threw: String(err?.message ?? err) };
    }
    note(`[D] next sync -> ${JSON.stringify(res)}`);
    if (res && !res.threw) note(`[D] hub_sync text: ${syncToolText(res)}`);
    note(`[D] sync.json after recovery: ${existsSync(p.record)}`);
    check(half && res?.recovered === 'unapplied' && !existsSync(p.record),
      'D1: recovery read HEAD == orig_head as "unapplied" ("An interrupted sync had changed nothing") and cleared the record, though the killed reset had written trunk\'s README.md and a.txt (§4.5: "There is no state in between")');
  }

  console.log('\n==== R-20 verdict ====');
  if (defects.length) {
    for (const d of defects) console.log(`DEFECT ${d}`);
    exitCode = 1;
  } else {
    console.log('No defect: a part-way reset was detected and reported (or never left the worktree half-synced).');
    exitCode = 0;
  }
} catch (err) {
  console.error('harness error:', err);
  exitCode = 2;
} finally {
  if (server) await server.close();
  if (!process.env.KEEP) rmSync(WORK, { recursive: true, force: true });
  else console.log(`kept ${WORK}`);
}
process.exit(exitCode);
