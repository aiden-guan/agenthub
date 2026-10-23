// Repro for R-23: every landing write, GET /status and GET /landings/stats does
// work linear in the project's whole landing history, whatever its LIMIT says.
//
//  * listLandings(order 'recent') is `... ORDER BY l.seq DESC LIMIT @limit` over
//    LANDING_SELECT. The landings table has no index that yields (project, seq)
//    order, so SQLite plans "USE TEMP B-TREE FOR ORDER BY": every matching row
//    (with its report JSON and the correlated approvals subquery) goes through
//    the sorter, and only then does LIMIT cut it to 100 (medianAttemptMs, run by
//    every queueView, i.e. every T1/admit/next/advance/...) or 5 (status()).
//  * landingStats() loads every landing the project ever had (no window in SQL)
//    and filters the `days` window in JS, parsing every stored report.
//
// What the script does (no network, no API key, no git, no lander process):
//  1. One SqliteStore on a temp file, one in-process Hub, the real HTTP server on
//     127.0.0.1:0. Two projects: `small` with SMALL past landings and `big` with
//     HISTORY past landings, all finished long before the stats window, each
//     with a REPORT_KB stored report (a check log tail, as the lander writes).
//  2. In each project it drives CYCLES real landings over HTTP: lander lease
//     claim, POST /land (queue mode), POST /landings/:id/admit, POST /lander/next,
//     POST /landings/:id/advance (running/checking), advance (failed), plus
//     GET /status and GET /landings/stats?days=7, timing each request.
//  3. It records every `FROM landings l` statement the hub executes (by wrapping
//     db.prepare) with its bound parameters and the rows it returned, then:
//     (a) for each LIMITed one, runs EXPLAIN QUERY PLAN with the same parameters
//         and counts the rows its WHERE matches: TEMP B-TREE FOR ORDER BY over a
//         row set that holds the whole history = the LIMIT does not bound the work;
//     (b) for GET /landings/stats, compares the rows materialized in JS with the
//         landings that ended inside the window.
//  4. It prints per-request latency for `small` vs `big` as the cost evidence.
//
// Exit 1 exactly when (a) or (b) shows O(history) work on these paths; 0 when
// every LIMITed read is served without sorting the history and stats reads only
// its window. Timing is printed, not judged (it depends on the machine).
//
// Run:
//   AGENTHUB_ROOT=/home/user/agenthub node \
//     /tmp/claude-0/-home-user-agenthub/8b8b52f8-98ca-5efe-ba8a-d267c5f2c650/scratchpad/work-p23/review/repro-R-23/repro.mjs
// Knobs (env): R23_HISTORY (default 20000), R23_SMALL (200), R23_REPORT_KB (4), R23_CYCLES (3).

import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.AGENTHUB_ROOT ?? '/home/user/agenthub';
const { Hub, SqliteStore, startServer } = await import(path.join(ROOT, 'packages/hub/dist/index.js'));
const { LANDER_LEASE_KEY } = await import(path.join(ROOT, 'packages/contract/dist/index.js'));

const HISTORY = Number(process.env.R23_HISTORY ?? 20000);
const SMALL = Number(process.env.R23_SMALL ?? 200);
const REPORT_KB = Number(process.env.R23_REPORT_KB ?? 4);
const CYCLES = Number(process.env.R23_CYCLES ?? 3);
const DAY = 86_400_000;

const tmp = mkdtempSync(path.join(os.tmpdir(), 'repro-R23-'));
const store = new SqliteStore(path.join(tmp, 'hub.db'));
const db = store.db;

// ---------------------------------------------------------------- recording
// Every statement over `FROM landings l` the hub executes: sql, params, rows, op.
let currentOp = null;
const executed = [];
const realPrepare = db.prepare.bind(db);
db.prepare = (sql) => {
  const stmt = realPrepare(sql);
  if (!/FROM landings l\b/.test(sql)) return stmt;
  for (const m of ['all', 'get']) {
    const real = stmt[m].bind(stmt);
    stmt[m] = (...args) => {
      const out = real(...args);
      if (currentOp) executed.push({ op: currentOp, sql, args, rows: m === 'all' ? out.length : out ? 1 : 0 });
      return out;
    };
  }
  return stmt;
};

const hub = new Hub({ store, leaseTtlMs: 600_000, heartbeatIntervalMs: 15_000 });
const server = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 3_600_000 });

// ------------------------------------------------------------ synthetic history
const sha = (c) => c.repeat(40);
const logTail = 'x'.repeat(Math.max(0, REPORT_KB * 1024 - 400));
function pastLanding(project, i, now) {
  const created = now - 60 * DAY - i * 60_000;
  return {
    id: `L-${store.nextCounter(project, 'landing')}`,
    project, agent: `dev${i % 7}/claude-1`, task_id: null, branch: `b${i}`, commit: sha('a'), summary: `change ${i}`,
    status: i % 3 === 0 ? 'failed' : 'landed', created_at: created, updated_at: created + 300_000,
    queue_seq: store.nextCounter(project, 'landing-queue'), position: null, eta_ms: null, phase: null, phase_at: null,
    attempt: 1, lander: 'lander/old-1-aaaa', lease_claim_id: null, in_doubt: false, deadline_at: null,
    base_sha: sha('b'), first_base: sha('b'), trunk_base: sha('b'), candidate: sha('c'), candidate_ref: null,
    candidate_checked: true, trunk_sha: i % 3 === 0 ? null : sha('d'), files: ['src/a.ts'], scope: null, mapper: null,
    protected: [], approval: [], approvals: [], hold_ids: [],
    report: {
      message: 'checked and landed', resolved_by: 'clean', files_via: [], conflicts: [],
      check: { command_hash: '0123456789ab', exit_code: i % 3 === 0 ? 1 : 0, signal: null, timed_out: false, duration_ms: 120_000, log_tail: logTail, failed_tests: [], passes_on_trunk: true, reproduce: 'npm test' },
      resolver: null, next_steps: [], warnings: [], foreign_commits: [], timings: null,
    },
    failure: i % 3 === 0 ? { code: 'checks_failed', summary: 'tests failed' } : null,
    retries: { trunk_moved: 0, lander_lost: 0, step_timeout: 0 }, retry_of: null, retry: 0, supersedes: null,
    superseded_by: null, waits_for: null, landed_with: null, reconciled: false,
    started_at: created + 60_000, ended_at: created + 180_000,
  };
}
function seed(project, n) {
  store.ensureProject(project, Date.now());
  const now = Date.now();
  db.transaction(() => {
    for (let i = 1; i <= n; i++) store.insertLanding(pastLanding(project, i, now));
  })();
}
let t0 = performance.now();
seed('small', SMALL);
seed('big', HISTORY);
console.log(`seeded: small=${SMALL}, big=${HISTORY} past landings, ~${REPORT_KB} KiB reports, all ended 60+ days ago (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

// ------------------------------------------------------------------- HTTP
function call(method, project, route, agent, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port: server.port, method, path: `/v1/p/${project}${route}`, agent: false,
        headers: { 'x-hub-agent': agent, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const json = text ? JSON.parse(text) : null;
          if (res.statusCode >= 300) reject(new Error(`${method} ${route} -> ${res.statusCode} ${text.slice(0, 300)}`));
          else resolve(json);
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const times = {}; // project -> op -> [ms]
async function timed(project, op, fn) {
  currentOp = `${project}:${op}`;
  const s = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - s;
    ((times[project] ??= {})[op] ??= []).push(ms);
    currentOp = null;
  }
}

const LANDER = 'lander/repro-1-r23a';
const AUTHOR = 'sam/claude-1';
async function drive(project) {
  const leaseClaim = await call('POST', project, '/claims', LANDER, { files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 600_000, intent: 'lander' });
  const lease = { lease_claim_id: leaseClaim.claim.id, epoch: hub.epoch };
  for (let k = 0; k < CYCLES; k++) {
    const land = await timed(project, 'POST /land (queue)', () =>
      call('POST', project, '/land', AUTHOR, { queue: true, commit: sha(String(k + 1)), branch: `feat-${k}`, files: [`src/f${k}.ts`], summary: `feature ${k}` }));
    const id = land.landing.id;
    await timed(project, 'POST /landings/:id/admit', () =>
      call('POST', project, `/landings/${id}/admit`, LANDER, { lease, base_sha: sha('e'), files: [`src/f${k}.ts`], required: [] }));
    const next = await timed(project, 'POST /lander/next', () => call('POST', project, '/lander/next', LANDER, { lease }));
    const picked = next.landing;
    if (!picked || picked.id !== id) throw new Error(`next did not pick ${id}: ${JSON.stringify(next).slice(0, 300)}`);
    await timed(project, 'POST /landings/:id/advance', () =>
      call('POST', project, `/landings/${id}/advance`, LANDER, { lease, attempt: picked.attempt, to: 'running', phase: 'checking', deadline_ms: 600_000 }));
    await timed(project, 'POST /landings/:id/advance', () =>
      call('POST', project, `/landings/${id}/advance`, LANDER, { lease, attempt: picked.attempt, to: 'failed', code: 'checks_failed', report: { message: 'repro: send back' } }));
    await timed(project, 'GET /status', () => call('GET', project, '/status', AUTHOR));
    await timed(project, 'GET /landings/stats?days=7', () => call('GET', project, '/landings/stats?days=7', AUTHOR));
  }
}

let failed = false;
try {
  await drive('small');
  await drive('big');
} finally {
  await server.close();
}

// ------------------------------------------------------------ (a) query plans
// For every LIMITed landing read run during the scenario: its plan with the same
// parameters, and how many rows its WHERE matches (what a TEMP B-TREE sorts).
// One entry per (statement, project, statuses, limit); the largest row set its WHERE matched.
const limited = new Map();
for (const e of executed) {
  const params = e.args[0];
  const limit = params && typeof params === 'object' ? params.limit : undefined;
  if (typeof limit !== 'number' || limit < 0) continue;
  const outer = e.sql.slice(e.sql.lastIndexOf('FROM landings l') + 'FROM landings l'.length);
  const where = outer.slice(0, outer.indexOf(' ORDER BY '));
  const countParams = { ...params };
  delete countParams.limit;
  const matching = realPrepare(`SELECT count(*) FROM landings l ${where}`).pluck().get(countParams);
  const key = `${e.sql}|${params.project}|${params.statuses}|${limit}`;
  const q = limited.get(key) ?? { ops: new Set(), sql: e.sql, where, order: outer.slice(outer.indexOf(' ORDER BY ') + 1).replace(/\s+/g, ' '), params, rows: 0, matching: -1 };
  q.ops.add(e.op.replace(/^\w+:/, ''));
  q.rows = Math.max(q.rows, e.rows);
  if (matching > q.matching) Object.assign(q, { matching, params });
  limited.set(key, q);
}
const sortsHistory = [];
console.log('\n(a) LIMITed `FROM landings l` reads the hub ran on these requests:');
for (const q of limited.values()) {
  const plan = realPrepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(q.params).map((r) => r.detail);
  const tempSort = plan.some((d) => /USE TEMP B-TREE FOR ORDER BY/.test(d));
  const project = q.params.project;
  const history = project === 'big' ? HISTORY : SMALL;
  const access = plan.find((d) => /^(SEARCH|SCAN) l\b/.test(d)) ?? '?';
  console.log(`  [${project}] ${q.where.trim()} ${q.order}  (limit=${q.params.limit}${q.params.statuses ? `, statuses=${q.params.statuses}` : ''})`);
  console.log(`      run by: ${[...q.ops].join(', ')}`);
  console.log(`      plan: ${access}${tempSort ? ' + USE TEMP B-TREE FOR ORDER BY' : ''}; WHERE matches ${q.matching} rows, LIMIT returns ${q.rows}${tempSort && q.matching > q.rows ? `: ${q.matching} rows (report + approvals subquery each) are sorted to return ${q.rows}` : ''}`);
  if (tempSort && project === 'big' && q.matching >= history / 2 && q.matching > 10 * q.params.limit) sortsHistory.push(q);
}

// ------------------------------------------------------------- (b) stats rows
const statsReads = executed.filter((e) => e.op === 'big:GET /landings/stats?days=7');
const perCall = statsReads.length / CYCLES;
const statsRows = statsReads.reduce((n, e) => n + e.rows, 0) / CYCLES;
const inWindow = realPrepare('SELECT count(*) FROM landings WHERE project = ? AND ended_at >= ?').pluck().get('big', Date.now() - 7 * DAY);
console.log(`\n(b) GET /landings/stats?days=7 on big: ${perCall} landing read(s) per call materialize ${statsRows} rows in JS (each report JSON-parsed); landings that ended in the window: ${inWindow}`);
const statsReadsHistory = statsRows >= HISTORY && statsRows > 10 * Math.max(1, inWindow);

// ------------------------------------------------------------------ timings
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
console.log(`\nlatency over HTTP, median of ${CYCLES} (small: ${SMALL} past landings, big: ${HISTORY}):`);
for (const op of Object.keys(times.small)) {
  const s = med(times.small[op]);
  const b = med(times.big[op]);
  console.log(`  ${op.padEnd(30)} small ${s.toFixed(1).padStart(7)} ms   big ${b.toFixed(1).padStart(8)} ms   x${(b / s).toFixed(1)}`);
}

rmSync(tmp, { recursive: true, force: true });

console.log('');
if (sortsHistory.length > 0) {
  failed = true;
  const ops = [...new Set(sortsHistory.flatMap((q) => [...q.ops]))];
  console.log(`DEFECT (a): ${sortsHistory.length} LIMITed read(s) sort the whole history (up to ${Math.max(...sortsHistory.map((q) => q.matching))} rows for LIMIT ${sortsHistory.map((q) => q.params.limit).join('/')}) on: ${ops.join('; ')}`);
}
if (statsReadsHistory) {
  failed = true;
  console.log(`DEFECT (b): GET /landings/stats?days=7 reads ${statsRows} landings to report on ${inWindow} in its window`);
}
if (!failed) console.log('OK: LIMITed landing reads do not sort the history, and stats reads only its window.');
process.exit(failed ? 1 : 0);
