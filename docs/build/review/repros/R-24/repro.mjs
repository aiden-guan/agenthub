// Repro for R-24: an author can't edit a file its own live landing holds once
// another agent queues for that file.
//
// Design §1.6 (claim() coverage row): "a hold never covers its own holder's new
// request. That request gets its own lease-based claim, which survives when the
// landing releases the hold. A hold is not a conflict for its own holder."
// §3.9 (supersede variant): A lands again (a fix on top) while its landing is
// still queued or checking, so A must be able to edit the held files.
//
// hub.ts standing() treats other agents' queued claims on the asked files as
// blockers ("earlier waiters stand in the way"), exempting only waiters whose
// wait reaches *this agent's* node in the wait graph. A wait for a landing hold
// ends at the node `landing:<id>` (nodeOf), not at the holder, so a waiter that
// waits only for A's own hold is not exempted and blocks A, although it can't
// be granted before A's landing lets go anyway.
//
// What the script does (no network, no API key, no lander process):
//  1. A temp git repo with two worktrees (wt-a for A, wt-b for B) and src/x.ts.
//  2. An in-process Hub on a temp SQLite file, served by the real HTTP server
//     on 127.0.0.1:0.
//  3. A claims src/x.ts, commits a change in wt-a, and lands it in queue mode
//     (POST /land, queue: true): L-1, whose hold covers src/x.ts.
//  4. Control: with nobody waiting, A's real edit hook (`hub hook pre-edit`,
//     the built CLI, Edit of src/x.ts in wt-a) is allowed: A gets its own
//     lease. A then releases that lease (files release skips the hold), so the
//     only claim on src/x.ts is L-1's hold.
//  5. B queues for src/x.ts (POST /claims, queue: true): it waits only for
//     landing:L-1.
//  6. Defect check: A's edit hook on src/x.ts again, and the same claim over
//     HTTP (mode auto, queue false, as the hook sends it). Per §1.6 both must
//     be granted (A's own lease); on phase23 both are denied with B's queued
//     claim as the conflict. Finally A's queued request shows its position.
//
// Exit 1 exactly when A's claim/edit is refused because of the waiter on its
// own hold (the defect); 0 when it is granted; 2 when the setup itself does not
// behave as the scenario needs (e.g. the control edit was already denied).
//
// Run:
//   AGENTHUB_ROOT=/home/user/agenthub node \
//     /tmp/claude-0/-home-user-agenthub/8b8b52f8-98ca-5efe-ba8a-d267c5f2c650/scratchpad/work-p23/review/repro-R-24/repro.mjs

import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.AGENTHUB_ROOT ?? '/home/user/agenthub';
const { Hub, SqliteStore, startServer } = await import(path.join(ROOT, 'packages/hub/dist/index.js'));
const CLI = path.join(ROOT, 'packages/adapter/bin/hub.js');

const P = 'demo';
const A = 'maya/claude-1';
const B = 'sam/claude-1';
const FILE = 'src/x.ts';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'repro-R24-'));
let server;
const cleanup = async () => {
  try {
    await server?.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
};

// ----------------------------------------------------------------- environment
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('HUB_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PROJECT_DIR') env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Repro',
    GIT_AUTHOR_EMAIL: 'repro@example.com',
    GIT_COMMITTER_NAME: 'Repro',
    GIT_COMMITTER_EMAIL: 'repro@example.com',
    HUB_CONFIG: '/nonexistent/agenthub/config.json',
    ANTHROPIC_API_KEY: '',
  });
  return Object.assign(env, extra);
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: baseEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---------------------------------------------------------------- the repo
const main = path.join(tmp, 'sample');
mkdirSync(path.join(main, 'src'), { recursive: true });
git(tmp, 'init', '-q', '-b', 'main', main);
writeFileSync(path.join(main, FILE), 'export function login(user: string) {\n  return `session-${user}`;\n}\n');
writeFileSync(path.join(main, 'README.md'), '# sample\n');
git(main, 'add', '-A');
git(main, 'commit', '-q', '-m', 'initial');
const wtA = path.join(tmp, 'wt-a');
const wtB = path.join(tmp, 'wt-b');
git(main, 'worktree', 'add', '-q', wtA, '-b', 'agent-a');
git(main, 'worktree', 'add', '-q', wtB, '-b', 'agent-b');

// ---------------------------------------------------------------- the hub
const hub = new Hub({ store: new SqliteStore(path.join(tmp, 'hub.db')), leaseTtlMs: 600_000, heartbeatIntervalMs: 15_000 });
server = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 3_600_000 });
const url = `http://127.0.0.1:${server.port}`;

function call(method, route, agent, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: `/v1/p/${P}${route}`,
        agent: false,
        headers: { 'x-hub-agent': agent, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function ok(method, route, agent, body) {
  const r = await call(method, route, agent, body);
  if (r.status >= 300) throw new Error(`${method} ${route} as ${agent} -> ${r.status} ${r.text.slice(0, 400)}`);
  return r.json;
}

// The built CLI's PreToolUse / PostToolUse hooks, as Claude Code runs them.
function hubHook(name, agent, wt, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'hook', name], {
      cwd: wt,
      env: baseEnv({ HUB_URL: url, HUB_PROJECT: P, HUB_AGENT: agent, HUB_TIMEOUT_MS: '5000' }),
    });
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
let callNo = 0;
function toolInput(event, wt, extra = {}) {
  callNo++;
  return JSON.stringify({
    session_id: 'repro-session-a',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: wt,
    permission_mode: 'default',
    hook_event_name: event,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(wt, FILE), old_string: 'session-', new_string: 'sess-', replace_all: false },
    tool_use_id: `toolu_R24_${callNo}`,
    ...extra,
  });
}
async function editHook(agent, wt) {
  const pre = await hubHook('pre-edit', agent, wt, toolInput('PreToolUse', wt));
  let out = null;
  try {
    out = pre.stdout.trim() ? JSON.parse(pre.stdout) : null;
  } catch {}
  const decision = out?.hookSpecificOutput?.permissionDecision ?? 'allow';
  const reason = out?.hookSpecificOutput?.permissionDecisionReason ?? out?.systemMessage ?? '';
  return { decision, reason, raw: pre, toolUseId: `toolu_R24_${callNo}` };
}
async function postEdit(agent, wt, toolUseId) {
  const input = JSON.parse(toolInput('PostToolUse', wt));
  input.tool_use_id = toolUseId;
  input.tool_response = { filePath: path.join(wt, FILE), success: true };
  return hubHook('post-edit', agent, wt, JSON.stringify(input));
}

const claimsOnFile = async () => {
  const s = await ok('GET', `/claims?file=${encodeURIComponent(FILE)}`, A);
  return (s.claims ?? []).filter((c) => c.status === 'active' || c.status === 'queued');
};
const show = (cs) => cs.map((c) => `${c.id} ${c.holder} ${c.status} ${c.mode}${c.landing_id ? ` hold-of ${c.landing_id}` : ''} [${c.scope.map((e) => e.file + (e.symbol ? '#' + e.symbol : '')).join(', ')}]`);

let exitCode = 0;
try {
  // 3. A claims src/x.ts, commits, lands it in queue mode.
  const c1 = await ok('POST', '/claims', A, { files: [FILE], intent: 'rework login' });
  console.log(`A claims ${FILE}: ${c1.status} ${c1.claim.id}`);
  appendFileSync(path.join(wtA, FILE), '// A: first change\n');
  git(wtA, 'commit', '-q', '-am', 'A: first change');
  const H = git(wtA, 'rev-parse', 'HEAD');
  const land = await ok('POST', '/land', A, { queue: true, commit: H, branch: 'agent-a', files: [FILE], summary: 'rework login' });
  const L = land.landing.id;
  console.log(`A lands ${H.slice(0, 10)} in queue mode: ${L} (${land.landing.status}); holds: ${(land.held ?? []).map((h) => `${h.id} on ${h.scope.map((e) => e.file).join(',')}`).join('; ')}`);

  // 4. Control: nobody waits; A's edit hook on its own held file is allowed (own lease).
  const ctl = await editHook(A, wtA);
  console.log(`\n[control] nobody waiting: A's pre-edit hook on ${FILE}: ${ctl.decision}`);
  console.log('  claims on file now:', show(await claimsOnFile()));
  if (ctl.decision === 'deny') {
    console.log(`  deny reason: ${ctl.reason}`);
    console.log('\nUNEXPECTED: A is denied even with nobody waiting; the scenario precondition does not hold.');
    exitCode = 2;
  } else {
    await postEdit(A, wtA, ctl.toolUseId);
    // Back to the finding's starting state: the only claim on x.ts is L's hold. (A files release skips holds.)
    const rel = await ok('POST', '/claims/release', A, { files: [FILE] });
    console.log(`  A releases its lease on ${FILE}: released ${rel.released.map((c) => c.id).join(',') || '-'}`);
    const left = await claimsOnFile();
    console.log('  claims on file now:', show(left));
    if (!(left.length === 1 && left[0].landing_id === L && left[0].holder === A)) {
      console.log('\nUNEXPECTED: the only live claim on the file should be L\'s hold.');
      exitCode = 2;
    }
  }

  if (exitCode === 0) {
    // 5. B queues for x.ts: it can only wait for A's landing hold.
    const qb = await ok('POST', '/claims', B, { files: [FILE], queue: true, intent: 'B wants x.ts next' });
    console.log(`\nB queues for ${FILE}: ${qb.status} ${qb.claim?.id} position ${qb.position}; waits for: ${qb.conflicts.map((c) => `${c.claim_id} ${c.holder}${c.landing_id ? ` (landing ${c.landing_id})` : ''}`).join(', ')}`);
    if (qb.status !== 'queued' || !qb.conflicts.every((c) => c.landing_id === L)) {
      console.log('UNEXPECTED: B should be queued behind L\'s hold only.');
      exitCode = 2;
    } else {
      // 6. The defect: A's edit of its own held file.
      const hookRes = await editHook(A, wtA);
      console.log(`\n[check 1] A's pre-edit hook (Edit ${FILE}) after B queued: ${hookRes.decision}`);
      if (hookRes.decision === 'deny') console.log(`  deny reason: ${hookRes.reason.replace(/\n/g, '\n    ')}`);
      else await postEdit(A, wtA, hookRes.toolUseId);

      const ra = await ok('POST', '/claims', A, { files: [FILE], mode: 'auto', queue: false });
      console.log(`[check 2] A POST /claims {files:[${FILE}], mode:auto, queue:false}: ${ra.status}; conflicts: ${ra.conflicts.map((c) => `${c.claim_id} ${c.holder} (${c.landing_id ? `hold of ${c.landing_id}` : 'not a hold'})`).join(', ') || '-'}`);
      const rq = await ok('POST', '/claims', A, { files: [FILE], mode: 'auto', queue: true });
      console.log(`[info]    A with queue:true: ${rq.status}${rq.position !== undefined ? ` at position ${rq.position}` : ''}`);
      console.log('  claims on file now:', show(await claimsOnFile()));

      const refusedByOwnHoldWaiter =
        hookRes.decision === 'deny' || (ra.status === 'denied' && ra.conflicts.some((c) => c.holder === B && !c.landing_id));
      if (refusedByOwnHoldWaiter) {
        console.log(
          `\nDEFECT (R-24): A's new request on ${FILE} is refused because of ${B}'s queued claim, which waits only for A's own ` +
            `landing ${L}'s hold. §1.6: a hold is not a conflict for its holder and the holder's new request gets its own lease; ` +
            `the waiter can't be granted before ${L} lets go anyway. A can't commit a fix on top to supersede ${L} (§3.9) ` +
            `or keep working in ${FILE} without cancelling ${L}.`,
        );
        exitCode = 1;
      } else {
        console.log(`\nOK: A's request on ${FILE} is granted its own lease while ${B} waits for ${L}'s hold.`);
      }
    }
  }
} catch (err) {
  console.error(err);
  exitCode = 2;
} finally {
  await cleanup();
}
process.exit(exitCode);
