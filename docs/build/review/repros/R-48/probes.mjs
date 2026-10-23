// R-48 probes: the checks a test of `hub approve`'s digest-mismatch refusal and of
// `hub lander resume` would make, run in-process against the BUILT packages of
// the checkout given as argv[2] (default $AGENTHUB_ROOT, default /home/user/agenthub).
//
// Prints one JSON line {probes: [{name, ok, detail}]} and exits 0 when every
// probe holds (the safety behaviour is there), 1 when one does not.
// No network: an in-process hub on 127.0.0.1 port 0, a local bare remote.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] || process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// Isolated git: no developer config.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') || k.startsWith('HUB_')) delete process.env[k];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  HUB_CONFIG: '/nonexistent/agenthub/config.json',
});

const { Hub, SqliteStore, startServer } = await imp('packages/hub/dist/index.js');
const { LANDER_LEASE_KEY } = await imp('packages/contract/dist/index.js');
const { gitops } = await imp('packages/gitops/dist/index.js');
const { decideCommand, landerCommand } = await imp('packages/adapter/dist/approve.js');
const { HubClient } = await imp('packages/adapter/dist/client.js');
const { landWork } = await imp('packages/adapter/dist/land.js');

const PROJECT = 'demo';
const B = 'sam/claude-1';
const LANDER = 'lander/testbox-4242-a1b2';
const LANDER_TOKEN = 'lander-secret-for-repro';
const MAYA_TOKEN = 'maya-approver-token';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const probes = [];
const record = (name, ok, detail) => probes.push({ name, ok: !!ok, detail });

/** A terminal a test controls: isTTY as given, the human's answer as given, everything written kept. */
function fakeTerm(isTTY, answer) {
  const t = { isTTY, out: '', asked: 0, write: (s) => void (t.out += s), ask: async (p) => (t.asked++, (t.out += p), answer) };
  return t;
}

const dir = mkdtempSync(path.join(tmpdir(), 'r48-'));
const hub = new Hub({ store: new SqliteStore(':memory:') });
const server = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100, landerToken: LANDER_TOKEN, approvers: { maya: `sha256:${sha256(MAYA_TOKEN)}` } });
const url = server.url;

async function lander(method, p, body) {
  const res = await fetch(`${url}/v1/p/${PROJECT}${p}`, {
    method,
    headers: { 'x-hub-agent': LANDER, 'x-hub-lander-token': LANDER_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`lander ${method} ${p}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

try {
  // A bare remote with a project that protects migrations/**, and two clones: sam's agent (b) and maya's checkout (a).
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seed);
  mkdirSync(path.join(seed, 'migrations'), { recursive: true });
  writeFileSync(path.join(seed, 'migrations', '0001_init.sql'), 'create table users (id int);\n');
  writeFileSync(path.join(seed, 'check.mjs'), 'process.exit(0);\n');
  writeFileSync(
    path.join(seed, 'agenthub.json'),
    `${JSON.stringify({ project: PROJECT, land: { check: 'node check.mjs', protected: [{ paths: ['migrations/**'], approvers: ['maya', 'sam'], distinct: true }] } }, null, 2)}\n`,
  );
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const a = path.join(dir, 'wt-a');
  const b = path.join(dir, 'wt-b');
  git(dir, 'clone', '-q', remote, a);
  git(dir, 'clone', '-q', remote, b);
  git(a, 'checkout', '-q', '-b', 'agent-a');
  git(b, 'checkout', '-q', '-b', 'agent-b');

  // The lander's lease.
  const claim = await lander('POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 600_000, intent: 'repro lander' });
  const { epoch } = await (await fetch(`${url}/v1/p/${PROJECT}/events?wait_ms=0`)).json();
  const lease = { lease_claim_id: claim.claim.id, epoch };

  // sam's agent lands a migration: what maya will be shown is this content.
  const P = 'migrations/0002_users.sql';
  mkdirSync(path.join(b, 'migrations'), { recursive: true });
  writeFileSync(path.join(b, P), 'alter table users add name text;\n');
  git(b, 'add', '--', P);
  git(b, 'commit', '-q', '-m', 'add name');
  const head = git(b, 'rev-parse', 'HEAD').trim();
  const cfgB = { url, agent: B, project: PROJECT, token: null, failClosed: false, timeoutMs: 5000, root: b, configFiles: [], projectSource: 'env', warnings: [] };
  const queued = await landWork({ cfg: cfgB, client: new HubClient(cfgB), feed: null }, {});
  if (!/^Queued L-1/.test(queued.text)) throw new Error(`setup: landWork said ${queued.text}`);
  const base = git(b, 'rev-parse', 'origin/main').trim();

  // The requirement the hub holds covers OTHER content than the land ref holds (what the human will see):
  // the digest of the base blob and a `drop table users;` blob, as when the land ref was overwritten after
  // admission (§4.1 #15) or a tokenless loopback hub's state was forged.
  const other = execFileSync('git', ['hash-object', '--stdin'], { cwd: b, input: 'drop table users;\n', encoding: 'utf8' }).trim();
  const g = gitops.open(b, { isolated: false });
  const shownDigest = gitops.approvalDigest('protected', [{ path: P, blobs: [await gitops.blobId(g, base, P), await gitops.blobId(g, head, P)] }]);
  const hubDigest = gitops.approvalDigest('protected', [{ path: P, blobs: [await gitops.blobId(g, base, P), other] }]);
  if (shownDigest === hubDigest) throw new Error('setup: the two digests are equal');
  await lander('POST', '/landings/L-1/admit', {
    lease,
    base_sha: base,
    files: [P],
    scope: null,
    mapper: null,
    protected: [P],
    required: [{ kind: 'protected', digest: hubDigest, paths: [P], rules: [{ paths: ['migrations/**'], approvers: ['maya', 'sam'], distinct: true }], candidate: null, candidate_ref: null, trunk_base: null }],
    waits_for: null,
    warnings: [],
  });

  // ---- (a) hub approve: a digest mismatch is refused, nothing is posted.
  const cfgA = { url, agent: 'maya/claude-1', project: PROJECT, token: null, failClosed: false, timeoutMs: 5000, root: a, configFiles: [], projectSource: 'env', warnings: [] };
  const creds = { HUB_APPROVER: 'maya', HUB_APPROVER_TOKEN: MAYA_TOKEN };
  {
    const term = fakeTerm(true, 'L-1');
    const res = await decideCommand(cfgA, new HubClient(cfgA), 'L-1', { decision: 'approve', env: creds, term });
    const l = hub.getLanding(PROJECT, 'L-1');
    record(
      'approve: content whose digest differs from the hub requirement is refused and nothing is posted',
      res.exitCode === 1 && /doesn't match what the hub asks you to approve/.test(res.stderr) && l.approval.length === 1 && l.approvals.length === 0,
      { exitCode: res.exitCode, stderr: res.stderr.trim(), stdout: res.stdout.trim(), pending: l.approval.length, approvals: l.approvals.map((x) => x.by), status: l.status },
    );
  }

  // ---- (b) hub lander resume after a trunk rewrite.
  await lander('POST', '/lander/pause', { lease, reason: 'trunk_rewritten', detail: 'repro: trunk was rewritten outside agenthub' });
  const accept = 'c'.repeat(40);
  const control = () => hub.landerStatus(PROJECT).control;
  {
    const term = fakeTerm(false, 'resume');
    const res = await landerCommand(new HubClient(cfgA), { sub: 'resume', acceptTrunk: accept, env: creds, term });
    const c = control();
    record(
      'lander resume: refused without a TTY even with approver credentials in the environment; still paused',
      res.exitCode === 1 && /needs an interactive terminal/.test(res.stderr) && c.paused?.reason === 'trunk_rewritten' && term.asked === 0,
      { exitCode: res.exitCode, stderr: res.stderr.trim(), stdout: res.stdout.trim(), paused: c.paused?.reason ?? null, asked: term.asked },
    );
  }
  {
    const term = fakeTerm(true, 'yes');
    const res = await landerCommand(new HubClient(cfgA), { sub: 'resume', acceptTrunk: accept, env: creds, term });
    const c = control();
    record(
      'lander resume: anything but a typed `resume` cancels; still paused',
      res.exitCode === 1 && /not resumed; nothing was sent/.test(res.stderr) && c.paused?.reason === 'trunk_rewritten',
      { exitCode: res.exitCode, stderr: res.stderr.trim(), stdout: res.stdout.trim(), paused: c.paused?.reason ?? null },
    );
  }
  {
    const term = fakeTerm(true, 'resume');
    const res = await landerCommand(new HubClient(cfgA), { sub: 'resume', acceptTrunk: accept, env: creds, term });
    const c = control();
    record(
      'lander resume --accept-trunk: a typed `resume` from a TTY resumes, with the accepted sha as the hub trunk',
      res.exitCode === 0 && /Resumed by maya/.test(res.stdout) && c.paused === null && c.trunk?.sha === accept,
      { exitCode: res.exitCode, stderr: res.stderr.trim(), stdout: res.stdout.trim().split('\n')[0], paused: c.paused?.reason ?? null, trunk: c.trunk?.sha ?? null },
    );
  }
} catch (err) {
  record('setup', false, { error: String(err?.stack ?? err) });
} finally {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ root: ROOT, probes }));
process.exit(probes.every((p) => p.ok) ? 0 : 1);
