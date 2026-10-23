#!/usr/bin/env node
// R-22: hold planning is quadratic in a landing's size, so a large land,
// supersede or admission stalls every hub request (and holds the SQLite write
// lock) for seconds.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// Imports only the built packages under ${AGENTHUB_ROOT}/packages/*/dist and
// runs the real hub-server and `hub hook pre-edit` binaries from there. No
// network (loopback only), no API key.
//
// Part 1 (in-process Hub, in-memory SQLite) times three hold-planning paths at
// n and 4n entries and derives the growth exponent: ~1 for linear code, ~2 for
// quadratic. Machine speed cancels out.
//   a. supersede (§3.9): an agent re-lands a live landing of n files
//      (planHolds with own = the inherited hold, setHolds' rescope)
//   b. admission (T2): the lander admits a landing of n files
//      (own = the landing's own hold, setHolds' rescope)
//   c. first land with a scope of n symbol entries plus the n changed files
//      (landings.ts files-versus-scope filter)
//
// Part 2 (two real hub-server processes on one SQLite file, port 0) shows the
// consequence: while agent maya supersedes a landing of R22_HTTP_FILES files
// (default 12000; the hub accepts up to 20000):
//   - a GET /status on the same hub waits the whole time,
//   - agent ravi's real pre-edit hook, asking for a file that agent sam holds
//     exclusively, gets no answer within the adapter's default 4 s timeout
//     and FAILS OPEN (edit allowed without a claim) where, a moment before,
//     it was denied,
//   - a second hub-server process on the same database file answers an
//     unrelated claim with 500 (SQLITE_BUSY after busy_timeout 5 s).
//
// Exit status: 1 when the defect is present (some growth exponent > 1.5, or
// the supersede kept the hub from answering within the adapter's timeout),
// 0 when not, 2 when the setup itself broke.

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT ?? '/home/user/agenthub');
const HTTP_FILES = Number(process.env.R22_HTTP_FILES ?? 12_000);
const EXPONENT_LIMIT = 1.5;
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const { Hub, SqliteStore } = await imp('packages/hub/dist/index.js');
const { LANDER_LEASE_KEY } = await imp('packages/contract/dist/index.js');
const { DEFAULT_TIMEOUT_MS } = await imp('packages/adapter/dist/config.js');
const HUB_SERVER = path.join(ROOT, 'packages/hub/dist/cli.js');
const HUB_CLI = path.join(ROOT, 'packages/adapter/bin/hub.js');

const P = 'demo';
const MAYA = 'maya/claude-1'; // lands the big change
const SAM = 'sam/claude-1'; // holds docs/plan.md exclusively
const RAVI = 'ravi/claude-1'; // tries to edit docs/plan.md during the stall
const LEE = 'lee/claude-1'; // an unrelated request on the second hub process
const LANDER = 'lander/build1-4821-9f3c';
const LANDER_AUTH = { lander: true, approver: null };
const MAPPER = 'sym1;vtsw0.3.1;wts0.27.0;00000000';
const sha = (c) => c.repeat(40);
const paths = (n, dir = 'src') => Array.from({ length: n }, (_, i) => `${dir}/m${i}/f${i}.ts`);

const log = (...a) => console.log(...a);
const fmt = (ms) => `${Math.round(ms)} ms`;

// ---------------------------------------------------------------- part 1

function freshHub() {
  const t = Date.UTC(2026, 9, 20, 9);
  return new Hub({ store: new SqliteStore(':memory:'), now: () => t, leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
}
function timed(fn) {
  const t0 = performance.now();
  const r = fn();
  return [performance.now() - t0, r];
}
function startTask(hub) {
  const task = hub.createTask(P, MAYA, { title: 'codemod: rename Session to AuthSession' });
  hub.takeTask(P, MAYA, task.id);
  return task;
}

function supersedeMs(n) {
  const hub = freshHub();
  const task = startTask(hub);
  const files = paths(n);
  const first = hub.land(P, MAYA, { queue: true, task_id: task.id, commit: sha('1'), files });
  const [ms, second] = timed(() => hub.land(P, MAYA, { queue: true, task_id: task.id, commit: sha('2'), files }));
  if (!second.superseded?.includes(first.landing.id)) throw new Error(`setup: the re-land did not supersede ${first.landing.id}`);
  if (second.holds?.length !== undefined && second.holds.length === 0) throw new Error('setup: the re-land has no hold');
  return ms;
}

function admitMs(n) {
  const hub = freshHub();
  const lease = hub.claim(P, LANDER, { files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 60_000, intent: 'lander' }, LANDER_AUTH);
  if (lease.status !== 'granted') throw new Error('setup: no lander lease');
  const task = startTask(hub);
  const files = paths(n);
  const landed = hub.land(P, MAYA, { queue: true, task_id: task.id, commit: sha('1'), files });
  const [ms, ad] = timed(() =>
    hub.admitLanding(P, LANDER, landed.landing.id, { lease: { lease_claim_id: lease.claim.id, epoch: hub.epoch }, base_sha: sha('e'), files, required: [] }, LANDER_AUTH),
  );
  if (ad.landing.status !== 'queued') throw new Error(`setup: admission left ${ad.landing.id} ${ad.landing.status}`);
  return ms;
}

function scopedFirstLandMs(n) {
  const hub = freshHub();
  const task = startTask(hub);
  // n mapped files with one changed declaration each (scope), n other changed files (files).
  const files = paths(n, 'docs');
  const scope = paths(n, 'src').map((file) => ({ file, symbol: 'Session' }));
  const [ms, r] = timed(() => hub.land(P, MAYA, { queue: true, task_id: task.id, commit: sha('1'), files, scope, mapper: MAPPER }));
  if (r.landing.status !== 'submitted') throw new Error(`setup: first land is ${r.landing.status}`);
  return ms;
}

function exponent(name, fn, n) {
  fn(Math.max(100, n / 8)); // warm up the JIT
  const small = Math.min(fn(n), fn(n));
  const big = fn(4 * n);
  const e = Math.log(big / small) / Math.log(4);
  log(`  ${name}: n=${n} ${fmt(small)}, n=${4 * n} ${fmt(big)} -> x${(big / small).toFixed(1)} for 4x the entries, growth exponent ${e.toFixed(2)}`);
  return { name, n, small, big, e };
}

// ---------------------------------------------------------------- part 2 helpers

function startHubServer(db) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HUB_SERVER, '--port', '0', '--db', db, '--lease-ttl-ms', '120000'], {
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stderr = '';
    const onData = (d) => {
      if (out === null) return; // keep draining
      out += d;
      const m = /listening on (http:\/\/\S+)/.exec(out);
      if (m) {
        out = null;
        resolve({ child, url: m[1], stderr: () => stderr });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => (stderr += d));
    child.once('exit', (code) => reject(new Error(`hub-server exited ${code}: ${stderr}`)));
    child.once('error', reject);
  });
}

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('HUB_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PROJECT_DIR') env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    HUB_CONFIG: '/nonexistent/agenthub/config.json',
  });
  return Object.assign(env, extra);
}

async function call(url, method, route, agent, body, timeoutMs) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${url}/v1/p/${P}${route}`, {
      method,
      headers: { 'x-hub-agent': agent, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, ms: performance.now() - t0 };
  } catch (err) {
    return { status: null, error: err.name === 'TimeoutError' ? 'timeout' : `${err.message}${err.cause?.message ? ` (${err.cause.message})` : ''}`, ms: performance.now() - t0 };
  }
}

/** GET on a new TCP connection (no keep-alive reuse), so the time is the hub's alone. */
function freshGet(url, route, agent) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.get(`${url}/v1/p/${P}${route}`, { agent: false, headers: { 'x-hub-agent': agent } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - t0 }));
    });
    req.on('error', (err) => resolve({ status: null, error: err.message, ms: performance.now() - t0 }));
  });
}

function must(r, what) {
  if (r.status !== 200) throw new Error(`setup: ${what} answered ${r.status ?? r.error}: ${JSON.stringify(r.data)?.slice(0, 300)}`);
  return r.data;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' });
}

function makeRepo(dir) {
  const main = path.join(dir, 'sample');
  mkdirSync(path.join(main, 'docs'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', main);
  writeFileSync(path.join(main, 'docs', 'plan.md'), '# plan\n\nsession- handling\n');
  writeFileSync(path.join(main, 'README.md'), '# sample\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'initial');
  const wt = path.join(dir, 'wt-ravi');
  git(main, 'worktree', 'add', '-q', wt, '-b', 'ravi');
  return wt;
}

function preEditInput(cwd, file) {
  return JSON.stringify({
    session_id: 'r22-session',
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'session-', new_string: 'sess-', replace_all: false },
    tool_use_id: `toolu_r22_${Math.random().toString(16).slice(2)}`,
  });
}

function preEditHook(url, wt, file) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [HUB_CLI, 'hook', 'pre-edit'], { cwd: wt, env: cleanEnv({ HUB_URL: url, HUB_PROJECT: P, HUB_AGENT: RAVI }) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.once('error', reject);
    child.once('close', (code) => {
      let decision = 'allow (no output)';
      let reason = '';
      try {
        const out = stdout ? JSON.parse(stdout) : null;
        if (out?.hookSpecificOutput?.permissionDecision === 'deny') {
          decision = 'deny';
          reason = out.hookSpecificOutput.permissionDecisionReason;
        } else if (out?.systemMessage) {
          decision = 'allow with warning';
          reason = out.systemMessage;
        }
      } catch {}
      resolve({ code, decision, reason, stdout, stderr, ms: performance.now() - t0 });
    });
    child.stdin.end(preEditInput(wt, file));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- main

async function main() {
  log(`AGENTHUB_ROOT=${ROOT}`);
  log('Part 1: hold planning cost against landing size (in-process hub, in-memory SQLite)');
  const results = [
    exponent('a. supersede a live landing (T15)', supersedeMs, 2000),
    exponent('b. admit a landing (T2)', admitMs, 2000),
    exponent('c. first land, scope of n symbol entries + n other files', scopedFirstLandMs, 2500),
  ];
  const quadratic = results.filter((r) => r.e > EXPONENT_LIMIT);

  log('');
  log(`Part 2: a supersede of ${HTTP_FILES} files on a real hub-server, while other agents work`);
  const base = process.env.R22_TMP ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'run-'));
  const servers = [];
  let stalled = false;
  try {
    const db = path.join(dir, 'hub.db');
    const s1 = await startHubServer(db);
    servers.push(s1);
    const s2 = await startHubServer(db); // a second process on the same database file (README: supported)
    servers.push(s2);
    const wt = makeRepo(dir);
    const planFile = path.join(wt, 'docs', 'plan.md');

    // sam holds docs/plan.md exclusively.
    const held = must(await call(s1.url, 'POST', '/claims', SAM, { files: ['docs/plan.md'], intent: 'rewrite the plan' }), "sam's claim");
    if (held.status !== 'granted') throw new Error(`setup: sam's claim is ${held.status}`);

    // Control: with the hub idle, ravi's pre-edit hook on that file is denied.
    const control = await preEditHook(s1.url, wt, planFile);
    log(`  control (hub idle): ravi's pre-edit hook on docs/plan.md -> ${control.decision} in ${fmt(control.ms)}`);
    if (control.decision !== 'deny') throw new Error(`setup: the control edit was not denied: ${control.stdout} ${control.stderr}`);

    // maya's big landing: task, first land (cheap), then the supersede.
    const task = must(await call(s1.url, 'POST', '/tasks', MAYA, { title: 'codemod: rename Session to AuthSession' }), 'create task').task;
    must(await call(s1.url, 'POST', `/tasks/${task.id}/take`, MAYA, {}), 'take task');
    const files = paths(HTTP_FILES);
    const first = await call(s1.url, 'POST', '/land', MAYA, { queue: true, task_id: task.id, commit: sha('1'), files });
    must(first, 'first land');
    log(`  maya's first land of ${HTTP_FILES} files: ${first.data.landing.id} in ${fmt(first.ms)} (body ${Math.round(JSON.stringify({ files }).length / 1024)} KB)`);

    const supersede = call(s1.url, 'POST', '/land', MAYA, { queue: true, task_id: task.id, commit: sha('2'), files });
    await sleep(300);
    const [status, reused, hook, other] = await Promise.all([
      freshGet(s1.url, '/status', LEE),
      call(s1.url, 'GET', '/status', LEE), // on a pooled keep-alive connection
      preEditHook(s1.url, wt, planFile),
      call(s2.url, 'POST', '/claims', LEE, { files: ['notes/lee.md'], intent: 'notes' }),
    ]);
    const sup = await supersede;
    must(sup, 'supersede');
    log(`  maya's re-land (supersede of ${first.data.landing.id}): ${sup.status} in ${fmt(sup.ms)}, superseded ${JSON.stringify(sup.data.superseded)}`);
    log(`  GET /status on the same hub, sent 300 ms later on a new connection: ${status.status ?? status.error} after ${fmt(status.ms)}`);
    log(`  the same GET on a pooled keep-alive connection: ${reused.status ?? reused.error} after ${fmt(reused.ms)}`);
    log(`  ravi's pre-edit hook on docs/plan.md (held exclusively by sam): ${hook.decision} after ${fmt(hook.ms)}`);
    if (hook.reason) log(`    "${hook.reason.replace(/\s+/g, ' ').slice(0, 220)}"`);
    log(`  lee's claim on notes/lee.md via a second hub-server on the same db: ${other.status ?? other.error} after ${fmt(other.ms)}${other.data?.error ? ` ${JSON.stringify(other.data.error)}` : ''}`);
    const busy = /SQLITE_BUSY|database is locked/.test(s2.stderr());
    if (busy) log('    second hub-server log: SQLITE_BUSY (database is locked)');

    const failedOpen = hook.decision !== 'deny';
    stalled = status.ms > DEFAULT_TIMEOUT_MS || failedOpen;
    log('');
    log(`  the hub answered nothing for ${fmt(status.ms)} (> the adapter's ${DEFAULT_TIMEOUT_MS} ms timeout: ${status.ms > DEFAULT_TIMEOUT_MS}); edit enforcement failed open: ${failedOpen}`);
  } finally {
    for (const s of servers) s.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }

  log('');
  if (quadratic.length > 0 || stalled) {
    log(`DEFECT PRESENT: ${quadratic.map((r) => `${r.name.split('.')[0]} grows with exponent ${r.e.toFixed(2)}`).join('; ') || 'no super-linear growth measured'}${stalled ? `; one ${HTTP_FILES}-file supersede stalled the hub past the adapter timeout` : ''}`);
    process.exit(1);
  }
  log('not reproduced: hold planning grows linearly and the hub kept answering');
  process.exit(0);
}

main().catch((err) => {
  console.error(`repro setup failed: ${err.stack ?? err}`);
  process.exit(2);
});
