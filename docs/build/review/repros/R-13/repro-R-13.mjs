#!/usr/bin/env node
// R-13 reproduction: `hub approve` / `hub reject` of a stacked landing (one
// with waits_for) recompute the approval digest from the hub's base_sha, the
// admission-time landed base (the old merge base). The lander digests the
// requirement from a different base: for `protected`, the waited-for landing's
// commit (admission's approvalBase, and P3's S* once that landing has landed);
// for `ai_resolution`, merge-tree's stage 1, which is blob(S*:p). Whenever the
// waited-for landing changed the same path, the digests never match, so the
// human can neither approve nor reject the landing.
//
// Everything is local: a bare remote (non-fast-forwards denied, an update hook
// that lets only the lander's committer move main), agent and approver clones,
// an in-process hub served over HTTP on 127.0.0.1:0 with one approver token,
// a real lander (HubClient, GitPort, ChecksRunner, AiResolver driven by the e2e
// stub resolver command) run in-process, and the real `hub approve` /
// `hub reject` code (adapter decideCommand) with a scripted TTY terminal.
// No network, no API key, no real AI resolver.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro-R-13.mjs
//
// Exit 1: the defect is present (a stacked landing's pending approval can be
// neither approved nor rejected by `hub approve` / `hub reject`). Exit 0: it is
// not. Exit 2: the harness itself broke (a control did not behave as designed).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, 'packages', rel)).href);

// The adapter's `hub approve` runs a non-isolated git: keep it off the operator's config.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') || k.startsWith('HUB_') || k.startsWith('ANTHROPIC_')) delete process.env[k];
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' });

const { Hub, SqliteStore, startServer } = await imp('hub/dist/index.js');
const { approvalDigest } = await imp('gitops/dist/index.js');
const { Lander } = await imp('lander/dist/lander.js');
const { ChecksRunner } = await imp('lander/dist/checks.js');
const { landerId } = await imp('lander/dist/config.js');
const { detectDrivers } = await imp('lander/dist/drivers.js');
const { openGitPort } = await imp('lander/dist/git-port.js');
const { HubClient: LanderHubClient } = await imp('lander/dist/hub-client.js');
const { initWorkdir } = await imp('lander/dist/init.js');
const { AiResolver } = await imp('lander/dist/resolver.js');
const { decideCommand } = await imp('adapter/dist/approve.js');
const { HubClient: AdapterHubClient } = await imp('adapter/dist/client.js');

const STUB_RESOLVER = path.join(ROOT, 'packages', 'e2e', 'fixtures', 'stub-resolver.mjs');
const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const SAM_TOKEN = 'sam-approver-token-for-r13';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

let tick = 0;
function gitEnv(who) {
  const t = `${BASE_TIME + 60 * ++tick} +0000`;
  const [name, email] = who ?? ['Maya Agent', 'maya@example.com'];
  return { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
}
function sh(cwd, args, who) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(who), encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}
function blobOf(repo, rev, p) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}:${p}`], { cwd: repo, env: gitEnv(), encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const HOOK = `#!/bin/sh
ref="$1"; new="$3"
case "$ref" in
  refs/heads/main)
    case "$new" in 0000000000000000000000000000000000000000) echo "trunk can't be deleted" >&2; exit 1;; esac
    who=$(git log -1 --format='%cn <%ce>' "$new")
    if [ "$who" != "${LANDER.name} <${LANDER.email}>" ]; then echo "only the lander may update main (committer: $who)" >&2; exit 1; fi;;
esac
exit 0
`;

/** A scripted terminal: a TTY that records what the command writes and types the landing id when asked. */
function scriptedTerminal(answer) {
  const t = { isTTY: true, out: '', write: (s) => void (t.out += s), ask: async (prompt) => ((t.out += prompt), answer) };
  return t;
}

const NOTES = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'line 10'];
const notes = (edits) => `${NOTES.map((l, i) => edits[i + 1] ?? l).join('\n')}\n`;

/**
 * One world: the remote seeded with agenthub.json (`land` from `landCfg`), an
 * in-process hub, a real lander (with the stub resolver), maya's and bob's
 * clones, and sam's checkout for `hub approve`.
 */
async function world(name, landCfg) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `r13-${name}-`)));
  const remote = path.join(dir, 'remote.git');
  const workdir = path.join(dir, 'lander');
  const landerLogs = [];
  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  const seed = path.join(dir, 'seed');
  sh(dir, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: P, land: { check: 'node check.mjs', ...landCfg } }, null, 2)}\n`);
  writeFileSync(path.join(seed, 'check.mjs'), "console.log('checks ok');\n");
  mkdirSync(path.join(seed, 'migrations'));
  writeFileSync(path.join(seed, 'migrations', '001.sql'), 'create table users (id int);\n');
  mkdirSync(path.join(seed, 'docs'));
  writeFileSync(path.join(seed, 'docs', 'notes.txt'), notes({}));
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-q', '-m', 'seed']);
  sh(seed, ['remote', 'add', 'origin', remote]);
  sh(seed, ['push', '-q', 'origin', 'main']);
  writeFileSync(path.join(remote, 'hooks', 'update'), HOOK);
  chmodSync(path.join(remote, 'hooks', 'update'), 0o755);

  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  const front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100, approvers: { sam: `sha256:${sha256(SAM_TOKEN)}` } });

  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const agent = landerId('lander/r13');
  const PATH = process.env.PATH ?? '';
  const landerHub = new LanderHubClient({ url: front.url, project: P, agent, landerToken: null });
  const gitPort = openGitPort({ mirror, remote: 'origin', env: { PATH } });
  const stubCfg = path.join(dir, 'stub-resolver.json');
  writeFileSync(stubCfg, JSON.stringify({ mode: 'union' }));
  const resolver = new AiResolver({
    git: gitPort,
    hub: landerHub,
    project: P,
    command: [process.execPath, STUB_RESOLVER, stubCfg].map(shellQuote).join(' '),
    apiKey: null,
    maxPerHour: 100,
    scratchDir: path.join(dir, 'runs'),
    env: { PATH },
    parseCheck: null,
    log: (l) => landerLogs.push(l),
  });
  mkdirSync(path.join(dir, 'runs'), { recursive: true });
  const lander = new Lander({
    hub: landerHub,
    git: gitPort,
    checks: new ChecksRunner({ workdir, mirror, env: { ...process.env }, killGraceMs: 2_000 }),
    resolver,
    log: (l) => landerLogs.push(l),
    agent,
    project: P,
    committer: LANDER,
    drivers: await detectDrivers({ PATH }),
    trunk: 'main',
    leaseTtlMs: 10_000,
    timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
    workdir,
    host: 'r13',
  });
  const admit = async () => {
    await lander.ensureLease();
    try {
      return await lander.admitRound();
    } finally {
      await lander.lease.release();
    }
  };
  const once = () => lander.run({ once: true });

  const clone = (who) => {
    const d = path.join(dir, who);
    sh(dir, ['clone', '-q', remote, d]);
    return d;
  };
  const sam = clone('sam');
  const authors = { maya: ['Maya Agent', 'maya@example.com'], bob: ['Bob Agent', 'bob@example.com'] };
  /** Commit `files` in `repo` as `who`; returns the new HEAD. */
  const commit = (repo, who, msg, files) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
      writeFileSync(path.join(repo, p), text);
    }
    sh(repo, ['add', '-A'], authors[who]);
    sh(repo, ['commit', '-q', '-m', msg], authors[who]);
    return sh(repo, ['rev-parse', 'HEAD']).trim();
  };
  /** Push HEAD of `repo` to its land ref and queue a landing for a fresh task of `agentId`. */
  const land = (repo, agentId, title, files, taskId = null) => {
    const H = sh(repo, ['rev-parse', 'HEAD']).trim();
    sh(repo, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
    if (taskId === null) {
      taskId = hub.createTask(P, agentId, { title }).id;
      hub.takeTask(P, agentId, taskId);
    }
    return hub.land(P, agentId, { queue: true, commit: H, files, task_id: taskId, summary: title }).landing;
  };
  const decide = async (decision, id) => {
    const cfg = { url: front.url, agent: null, project: P, token: null, failClosed: false, timeoutMs: 10_000, root: sam, configFiles: [], projectSource: 'file', warnings: [] };
    const client = new AdapterHubClient({ url: front.url, project: P, agent: null, token: null, timeoutMs: 10_000 });
    const term = scriptedTerminal(id);
    const r = await decideCommand(cfg, client, id, {
      decision,
      note: decision === 'approve' ? 'reviewed' : undefined,
      reason: decision === 'reject' ? 'not this migration' : undefined,
      env: { ...process.env, HUB_APPROVER: 'sam', HUB_APPROVER_TOKEN: SAM_TOKEN },
      term,
    });
    return { exitCode: r.exitCode, stderr: r.stderr.trim(), stdout: r.stdout.trim(), shown: term.out };
  };
  const get = (id) => hub.getLanding(P, id);
  const trunk = () => sh(remote, ['rev-parse', 'main']).trim();
  const close = async () => {
    await front.close().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    try {
      hub.store?.close?.();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, remote, hub, admit, once, clone, commit, land, decide, get, trunk, close, landerLogs };
}

const mismatch = (r) => r.exitCode !== 0 && /doesn't match what the hub asks you to/.test(r.stderr);
const short = (d) => (d ? d.slice(0, 12) : '(none)');
const reqLine = (l) => l.approval.map((r) => `${r.kind} ${short(r.digest)} [${r.paths.join(', ')}]`).join('; ') || '(nothing pending)';
const decisionLine = (r) => `exit ${r.exitCode}${r.stderr ? `: ${r.stderr}` : r.stdout ? `: ${r.stdout.split('\n')[0]}` : ''}`;
/** The added/removed lines of the first diff `hub approve` printed. */
const shownChanges = (out) =>
  out
    .split('\n')
    .filter((l) => /^[+-][^+-]/.test(l))
    .join(' | ');

// ------------------------------------------------------------------ case A: protected
async function caseProtected() {
  const res = { steps: [] };
  const log = (s) => res.steps.push(s);
  const w = await world('protected', { protected: ['migrations/**'] });
  try {
    const PATH_ = 'migrations/001.sql';
    const maya = w.clone('maya');
    const trunk0 = w.trunk();
    const V0 = 'create table users (id int);\n';
    const H1 = w.commit(maya, 'maya', 'one', { [PATH_]: `${V0}create table one (id int);\n` });
    const L1 = w.land(maya, 'maya/claude-1', 'first migration', [PATH_]);
    await w.admit();
    const l1 = w.get(L1.id);
    res.l1 = { id: L1.id, status: l1.status, digest: l1.approval[0]?.digest ?? null };
    log(`${L1.id} (T: first migration, H1 ${short(H1)}): ${l1.status}; pending: ${reqLine(l1)}`);

    const H2 = w.commit(maya, 'maya', 'two', { [PATH_]: `${V0}create table one (id int);\ncreate table two (id int);\n` });
    const L2 = w.land(maya, 'maya/claude-1', 'second migration', [PATH_]);
    await w.admit();
    const l2 = w.get(L2.id);
    const hubDigest = l2.approval.find((r) => r.kind === 'protected')?.digest ?? null;
    const fromWaited = approvalDigest('protected', [{ path: PATH_, blobs: [blobOf(maya, H1, PATH_), blobOf(maya, H2, PATH_)] }]);
    const fromBaseSha = l2.base_sha ? approvalDigest('protected', [{ path: PATH_, blobs: [blobOf(maya, l2.base_sha, PATH_), blobOf(maya, H2, PATH_)] }]) : null;
    res.l2 = { id: L2.id, status: l2.status, waits_for: l2.waits_for, base_sha: l2.base_sha, trunk0, hubDigest, fromWaited, fromBaseSha };
    log(
      `${L2.id} (on top, H2 ${short(H2)}): ${l2.status}, waits_for ${l2.waits_for}, base_sha ${short(l2.base_sha)} (trunk0 ${short(trunk0)}, H1 ${short(H1)}); pending: ${reqLine(l2)}`,
    );
    log(`  the hub's digest ${short(hubDigest)}; over (path, blob(H1), blob(H2)): ${short(fromWaited)}; over (path, blob(base_sha), blob(H2)): ${short(fromBaseSha)}`);

    // sam tries to approve the stacked landing while it is queued.
    const a1 = await w.decide('approve', L2.id);
    res.approveQueued = a1;
    log(`hub approve ${L2.id} (queued): ${decisionLine(a1)}`);
    log(`  the human was shown: ${shownChanges(a1.shown)}`);

    // control: sam approves L-1 (not stacked) with the same command.
    const c = await w.decide('approve', L1.id);
    res.controlApprove = c;
    log(`control: hub approve ${L1.id}: ${decisionLine(c)}`);

    await w.once();
    const l1b = w.get(L1.id);
    res.l1.final = l1b.status;
    log(`lander attempt: ${L1.id} ${l1b.status}${l1b.trunk_sha ? ` as ${short(l1b.trunk_sha)}` : ''}`);
    await w.once();
    const l2b = w.get(L2.id);
    res.l2.afterRun = { status: l2b.status, base_sha: l2b.base_sha, digest: l2b.approval.find((r) => r.kind === 'protected')?.digest ?? null };
    log(`lander attempt: ${L2.id} ${l2b.status}; base_sha ${short(l2b.base_sha)}; pending: ${reqLine(l2b)}`);

    if (l2b.status === 'needs_approval') {
      const a2 = await w.decide('approve', L2.id);
      res.approveParked = a2;
      log(`hub approve ${L2.id} (needs_approval): ${decisionLine(a2)}`);
      if (a2.exitCode !== 0) {
        const r2 = await w.decide('reject', L2.id);
        res.rejectParked = r2;
        log(`hub reject ${L2.id} --reason ... (needs_approval): ${decisionLine(r2)}`);
        // Informational (severity): the way out is for the agent to cancel and land the same commit again,
        // now that L-1 is on trunk (no waits_for, base_sha = S* = H1).
        w.hub.cancelLanding(P, 'maya/claude-1', L2.id, {});
        const L3 = w.land(maya, 'maya/claude-1', 'second migration', [PATH_], l2b.task_id);
        await w.admit();
        const l3 = w.get(L3.id);
        const a3 = await w.decide('approve', L3.id);
        res.workaround = { id: L3.id, base_sha: l3.base_sha, waits_for: l3.waits_for, approve: a3 };
        log(`workaround: maya cancels ${L2.id} and lands H2 again as ${L3.id}: ${l3.status}, waits_for ${l3.waits_for}, base_sha ${short(l3.base_sha)}; hub approve ${L3.id}: ${decisionLine(a3)}`);
      } else {
        await w.once();
        log(`after the approval: ${L2.id} ${w.get(L2.id).status}`);
      }
    }
    res.l2.final = w.get(L2.id).status;
  } catch (err) {
    res.error = err?.stack ?? String(err);
    res.landerLogs = w.landerLogs.slice(-25);
  } finally {
    await w.close();
  }
  return res;
}

// ------------------------------------------------------------------ case B: ai_resolution
// bob lands a change to line 6 of docs/notes.txt. maya, from the old trunk,
// lands L-a (line 1) and, stacked on it, L-b (line 6): L-a merges cleanly, L-b
// conflicts with bob's line 6 at its attempt (base S* = L-a's commit), the stub
// resolver resolves it, and requireApproval parks it for an ai_resolution
// approval. `stacked: false` is the control: maya lands only the line-6 change.
async function caseAi(stacked) {
  const res = { steps: [] };
  const log = (s) => res.steps.push(s);
  const w = await world(stacked ? 'ai-stacked' : 'ai-control', { protected: ['migrations/**'], resolver: { enabled: true, requireApproval: true } });
  const NP = 'docs/notes.txt';
  try {
    const maya = w.clone('maya');
    const bob = w.clone('bob');
    const trunk0 = w.trunk();
    w.commit(bob, 'bob', 'bob: line 6', { [NP]: notes({ 6: 'line 6 by bob' }) });
    const LB = w.land(bob, 'bob/claude-1', 'bob notes', [NP]);
    await w.admit();
    await w.once();
    log(`${LB.id} (bob, line 6): ${w.get(LB.id).status}`);

    let La = null;
    let H1 = null;
    if (stacked) {
      H1 = w.commit(maya, 'maya', 'maya: line 1', { [NP]: notes({ 1: 'line 1 by maya' }) });
      La = w.land(maya, 'maya/claude-1', 'maya line 1', [NP]);
    }
    const H2 = w.commit(maya, 'maya', 'maya: line 6', { [NP]: notes({ ...(stacked ? { 1: 'line 1 by maya' } : {}), 6: 'line 6 by maya' }) });
    const Lb = w.land(maya, 'maya/claude-1', 'maya line 6', [NP]);
    await w.admit();
    const lb0 = w.get(Lb.id);
    log(`${Lb.id} (maya, line 6${stacked ? `, on top of ${La.id}` : ''}): ${lb0.status}, waits_for ${lb0.waits_for}, base_sha ${short(lb0.base_sha)} (trunk0 ${short(trunk0)}${H1 ? `, H1 ${short(H1)}` : ''})`);
    if (stacked) {
      await w.once();
      log(`lander attempt: ${La.id} ${w.get(La.id).status}`);
    }
    await w.once();
    const lb = w.get(Lb.id);
    const req = lb.approval.find((r) => r.kind === 'ai_resolution') ?? null;
    res.lb = { id: Lb.id, status: lb.status, base_sha: lb.base_sha, waits_for: lb0.waits_for, hubDigest: req?.digest ?? null };
    log(`lander attempt: ${Lb.id} ${lb.status}${lb.failure ? ` (${lb.failure.code})` : ''}; pending: ${reqLine(lb)}`);
    if (req) {
      const T0 = req.trunk_base ?? lb.trunk_base;
      const C = req.candidate ?? lb.candidate;
      sh(w.remote, ['rev-parse', '--verify', `${C}^{commit}`]);
      const stage = (rev) => blobOf(w.remote, rev, NP);
      const fromS = stacked ? approvalDigest('ai_resolution', [{ path: NP, blobs: [stage(H1), stage(T0), stage(H2), stage(C)] }]) : null;
      const fromBaseSha = approvalDigest('ai_resolution', [{ path: NP, blobs: [stage(lb.base_sha), stage(T0), stage(H2), stage(C)] }]);
      res.lb.fromS = fromS;
      res.lb.fromBaseSha = fromBaseSha;
      log(`  the hub's digest ${short(req.digest)}; with stage 1 = blob(H1): ${short(fromS)}; with stage 1 = blob(base_sha): ${short(fromBaseSha)}`);
      const a = await w.decide('approve', Lb.id);
      res.approve = a;
      log(`hub approve ${Lb.id}: ${decisionLine(a)}`);
      if (a.exitCode !== 0) {
        const r = await w.decide('reject', Lb.id);
        res.reject = r;
        log(`hub reject ${Lb.id} --reason ...: ${decisionLine(r)}`);
      } else {
        await w.once();
        log(`after the approval: ${Lb.id} ${w.get(Lb.id).status}`);
      }
    }
    res.lb.final = w.get(Lb.id).status;
  } catch (err) {
    res.error = err?.stack ?? String(err);
    res.landerLogs = w.landerLogs.slice(-25);
  } finally {
    await w.close();
  }
  return res;
}

console.log(`R-13 reproduction against ${ROOT}\n`);
const show = (title, r) => {
  console.log(`== ${title}`);
  for (const s of r.steps) console.log(`  ${s}`);
  if (r.error) console.log(`  HARNESS ERROR: ${r.error}\n  lander log tail:\n    ${(r.landerLogs ?? []).join('\n    ')}`);
  console.log('');
};
const A = await caseProtected();
show('A: protected path changed by both stacked landings', A);
const Bc = await caseAi(false);
show('B0 (control): ai_resolution approval of a landing that is not stacked', Bc);
const B = await caseAi(true);
show('B: ai_resolution approval of a stacked landing whose waited-for landing changed the file', B);

// Controls: the non-stacked approvals go through, and the stacked landing really is stacked and pending.
const controlA = !A.error && A.controlApprove?.exitCode === 0 && A.l1?.final === 'landed' && A.l2?.waits_for === A.l1?.id && !!A.l2?.hubDigest;
const controlB = !Bc.error && Bc.lb?.hubDigest && Bc.approve?.exitCode === 0 && Bc.lb.final === 'landed';
console.log(`control A (hub approve of the non-stacked L-1 succeeds, L-1 lands, L-2 waits for it with a protected approval pending): ${controlA ? 'yes' : 'NO'}`);
console.log(`control B0 (hub approve of a non-stacked ai_resolution succeeds and it lands): ${controlB ? 'yes' : 'NO'}`);

// The defect: `hub approve` (and `hub reject`) of the stacked landing are refused on a digest mismatch.
const defectA = !A.error && (mismatch(A.approveQueued ?? { exitCode: 0, stderr: '' }) || (A.approveParked && mismatch(A.approveParked) && A.rejectParked && mismatch(A.rejectParked)));
const stuckA = !A.error && A.l2?.afterRun?.status === 'needs_approval' && A.approveParked && mismatch(A.approveParked) && A.rejectParked && mismatch(A.rejectParked);
const defectB = !B.error && B.lb?.hubDigest && B.approve && mismatch(B.approve);
const stuckB = defectB && B.reject && mismatch(B.reject);
console.log(
  `A: hub approve of the queued stacked landing refused on a digest mismatch: ${!!(A.approveQueued && mismatch(A.approveQueued))}; ` +
    `hub digest = digest over (blob(H1), blob(H2)): ${A.l2?.hubDigest === A.l2?.fromWaited}; CLI digest = digest over (blob(base_sha), blob(H2)): ${!!A.approveQueued?.stderr.includes(short(A.l2?.fromBaseSha))}; ` +
    `parked in needs_approval with neither approve nor reject possible: ${!!stuckA}`,
);
console.log(
  `B: hub approve of the stacked ai_resolution refused on a digest mismatch: ${!!defectB}; hub digest uses stage 1 = blob(H1): ${B.lb?.hubDigest === B.lb?.fromS}; ` +
    `CLI digest uses blob(base_sha): ${!!B.approve?.stderr.includes(short(B.lb?.fromBaseSha))}; reject refused too: ${!!stuckB}`,
);

if (!controlA || !controlB || A.error || B.error || Bc.error) {
  console.log('\nHARNESS: a control or a run did not behave as expected; see above.');
  if (!defectA && !defectB) process.exit(2);
}
if (defectA || defectB) {
  console.log('\nDEFECT PRESENT: a stacked landing\'s pending approval can be neither approved nor rejected with hub approve / hub reject (the CLI digests from base_sha, the lander from the waited-for commit).');
  process.exit(1);
}
console.log('\nno defect: hub approve and hub reject act on stacked landings as on any other.');
process.exit(0);
