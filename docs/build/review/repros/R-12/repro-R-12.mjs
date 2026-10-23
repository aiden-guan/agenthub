#!/usr/bin/env node
// R-12 reproduction: a protected path whose tree entry has no readable blob
// under its NFC name (a name git stores in NFD, or a gitlink) gets the
// content-free approval digest (path, null, null). A human's approval of one
// version then matches every later version: the hub carries it across a
// supersede chain and lets the new, never-shown content through to trunk.
//
// Everything is local: a bare remote (non-fast-forwards denied, an update hook
// that lets only the lander's committer move main), agent and approver clones,
// an in-process hub served over HTTP on 127.0.0.1:0 with one approver token,
// a real lander (HubClient, GitPort, ChecksRunner) run in-process, and the
// real `hub approve` code (adapter decideCommand) with a scripted terminal.
// No network, no API key, no AI resolver.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro-R-12.mjs
//
// Exit 1: the defect is present (unreviewed protected content reached trunk on
// a carried approval). Exit 0: it is not. Exit 2: the harness itself broke
// (the NFC control case did not behave as the design requires).

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
const { decideCommand } = await imp('adapter/dist/approve.js');
const { HubClient: AdapterHubClient } = await imp('adapter/dist/client.js');

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const SAM_TOKEN = 'sam-approver-token-for-r12';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

let tick = 0;
function gitEnv(extra = {}) {
  const t = `${BASE_TIME + 60 * ++tick} +0000`;
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Maya Agent',
    GIT_AUTHOR_EMAIL: 'maya@example.com',
    GIT_COMMITTER_NAME: 'Maya Agent',
    GIT_COMMITTER_EMAIL: 'maya@example.com',
    GIT_AUTHOR_DATE: t,
    GIT_COMMITTER_DATE: t,
    ...extra,
  };
}
function sh(cwd, args, extra = {}, input) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(extra), encoding: 'utf8', input });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}
function tryGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
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

/** A scripted terminal: records everything `hub approve` writes, types the landing id when asked. */
function scriptedTerminal(answer) {
  const t = { isTTY: true, out: '', write: (s) => void (t.out += s), ask: async (prompt) => ((t.out += prompt), answer) };
  return t;
}

/**
 * One world, one protected path. `writeV(clone, n)` makes version n (1 or 2)
 * of the protected path in the agent's clone and commits it.
 */
async function runCase(name, o) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `r12-${name}-`)));
  const remote = path.join(dir, 'remote.git');
  const workdir = path.join(dir, 'lander');
  const res = { name, steps: [] };
  const log = (s) => res.steps.push(s);
  const landerLogs = [];
  let front = null;
  let hub = null;
  try {
    // ---- the remote, seeded with agenthub.json (migrations/** protected) and a trivial check
    sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
    sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
    const seed = path.join(dir, 'seed');
    sh(dir, ['init', '-q', '-b', 'main', seed]);
    writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: P, land: { check: 'node check.mjs', protected: ['migrations/**'] } }, null, 2)}\n`);
    writeFileSync(path.join(seed, 'check.mjs'), "console.log('checks ok');\n");
    mkdirSync(path.join(seed, 'migrations'));
    writeFileSync(path.join(seed, 'migrations', '001.sql'), 'create table users (id int);\n');
    writeFileSync(path.join(seed, 'README.md'), '# demo\n');
    sh(seed, ['add', '-A']);
    sh(seed, ['commit', '-q', '-m', 'seed']);
    sh(seed, ['remote', 'add', 'origin', remote]);
    sh(seed, ['push', '-q', 'origin', 'main']);
    writeFileSync(path.join(remote, 'hooks', 'update'), HOOK);
    chmodSync(path.join(remote, 'hooks', 'update'), 0o755);

    // ---- the hub: in-process, over HTTP on loopback, one approver (sam) by token digest
    hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
    front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100, approvers: { sam: `sha256:${sha256(SAM_TOKEN)}` } });

    // ---- the lander
    await initWorkdir({ dir: workdir, remote });
    const mirror = path.join(workdir, 'mirror.git');
    const agent = landerId('lander/r12');
    const PATH = process.env.PATH ?? '';
    const lander = new Lander({
      hub: new LanderHubClient({ url: front.url, project: P, agent, landerToken: null }),
      git: openGitPort({ mirror, remote: 'origin', env: { PATH } }),
      checks: new ChecksRunner({ workdir, mirror, env: { ...process.env }, killGraceMs: 2_000 }),
      resolver: null,
      log: (l) => landerLogs.push(l),
      agent,
      project: P,
      committer: LANDER,
      drivers: await detectDrivers({ PATH }),
      trunk: 'main',
      leaseTtlMs: 10_000,
      timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
      workdir,
      host: 'r12',
    });
    const admit = async () => {
      await lander.ensureLease();
      try {
        return await lander.admitRound();
      } finally {
        await lander.lease.release();
      }
    };

    // ---- maya's agent, and sam's checkout for `hub approve`
    const maya = path.join(dir, 'maya');
    sh(dir, ['clone', '-q', remote, maya]);
    const sam = path.join(dir, 'sam');
    sh(dir, ['clone', '-q', remote, sam]);
    const MAYA = 'maya/claude-1';
    const task = hub.createTask(P, MAYA, { title: `${name} migration` });
    hub.takeTask(P, MAYA, task.id);
    const trunk0 = sh(remote, ['rev-parse', 'main']).trim();

    const land = (summary) => {
      const H = sh(maya, ['rev-parse', 'HEAD']).trim();
      sh(maya, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
      return hub.land(P, MAYA, { queue: true, commit: H, files: [o.nfcPath], task_id: task.id, summary }).landing;
    };
    const samApprove = async (id) => {
      const cfg = { url: front.url, agent: null, project: P, token: null, failClosed: false, timeoutMs: 10_000, root: sam, configFiles: [], projectSource: 'file', warnings: [] };
      const client = new AdapterHubClient({ url: front.url, project: P, agent: null, token: null, timeoutMs: 10_000 });
      const term = scriptedTerminal(id);
      const r = await decideCommand(cfg, client, id, { decision: 'approve', note: 'reviewed', env: { ...process.env, HUB_APPROVER: 'sam', HUB_APPROVER_TOKEN: SAM_TOKEN }, term });
      return { ...r, shown: term.out };
    };

    // ---- v1: maya lands L-1, admission asks for a protected approval, sam approves it with `hub approve`
    const H1 = o.writeV(maya, 1);
    res.storedName = o.storedName(maya, H1);
    const L1 = land('v1');
    await admit();
    const l1 = hub.getLanding(P, L1.id);
    const req1 = l1.approval.find((r) => r.kind === 'protected') ?? null;
    res.l1 = { id: L1.id, status: l1.status, pending: l1.approval.length, digest: req1?.digest ?? null, paths: req1?.paths ?? [] };
    res.contentDigest1 = o.contentDigest(maya, trunk0, H1);
    res.nullDigest = approvalDigest('protected', [{ path: o.nfcPath, blobs: [null, null] }]);
    log(`L-1 ${l1.status}, ${l1.approval.length} pending; protected digest ${req1?.digest?.slice(0, 12) ?? '(none)'}; a content-bound digest would be ${res.contentDigest1.slice(0, 12)}; (path,null,null) is ${res.nullDigest.slice(0, 12)}`);
    if (req1) {
      const a = await samApprove(L1.id);
      res.approve1 = { exitCode: a.exitCode, stderr: a.stderr.trim(), shownDiff: diffSection(a.shown) };
      log(`hub approve ${L1.id} as sam: exit ${a.exitCode}${a.stderr ? ` (${a.stderr.trim()})` : ''}; the human was shown: ${JSON.stringify(res.approve1.shownDiff)}`);
    }

    // ---- v2: different content in the same protected path; L-2 for the same task supersedes L-1
    const H2 = o.writeV(maya, 2);
    const L2 = land('v2');
    await admit();
    const l2 = hub.getLanding(P, L2.id);
    const req2 = l2.approval.find((r) => r.kind === 'protected') ?? null;
    const l1after = hub.getLanding(P, L1.id);
    res.l2 = {
      id: L2.id,
      supersedes: l2.supersedes,
      l1Status: l1after.status,
      statusAfterAdmit: l2.status,
      pending: l2.approval.length,
      digest: req2?.digest ?? null,
      approvals: l2.approvals.map((a) => ({ by: a.by, kind: a.kind, digest: a.digest, carried_from: a.carried_from })),
    };
    res.contentDigest2 = o.contentDigest(maya, trunk0, H2);
    log(`L-2 supersedes ${l2.supersedes} (L-1 now ${l1after.status}); after admission: ${l2.status}, ${l2.approval.length} pending; approvals ${JSON.stringify(res.l2.approvals.map((a) => `${a.by}:${a.digest.slice(0, 12)}${a.carried_from ? ` carried from ${a.carried_from}` : ''}`))}`);

    // ---- the lander processes L-2
    await lander.run({ once: true });
    const done = hub.getLanding(P, L2.id);
    res.l2.final = done.status;
    res.l2.failure = done.failure?.code ?? null;
    res.trunkMoved = sh(remote, ['rev-parse', 'main']).trim() !== trunk0;
    res.trunkHasV2 = o.trunkHasV(remote, 2);
    res.directApprovalsOnL2 = done.approvals.filter((a) => a.carried_from === null).length;
    log(`L-2 after the lander's attempt: ${done.status}${res.l2.failure ? ` (${res.l2.failure})` : ''}; trunk moved: ${res.trunkMoved}; trunk holds v2: ${res.trunkHasV2}; approvals given on L-2 itself: ${res.directApprovalsOnL2}`);
  } catch (err) {
    res.error = err?.stack ?? String(err);
    res.landerLogs = landerLogs.slice(-20);
  } finally {
    if (front) await front.close().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    try {
      hub?.store?.close?.();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
  return res;
}

/** The diff body `hub approve` printed for the first requirement. */
function diffSection(out) {
  const m = /=== protected approval of [^\n]*\n([\s\S]*?)\n\n/.exec(out);
  return m ? m[1] : out.slice(0, 400);
}

// ---------------------------------------------------------------- the cases

const NFC_PATH = 'migrations/café.sql';
const NFD_PATH = 'migrations/café.sql';
const CONTENT = { 1: 'create table cafe (id int);\n', 2: 'drop table users;\n' };

/** A regular file, stored under `stored` (bytes as written), named NFC_PATH by the lander and the hub. */
function fileCase(stored) {
  return {
    nfcPath: NFC_PATH,
    writeV(clone, n) {
      mkdirSync(path.join(clone, 'migrations'), { recursive: true });
      writeFileSync(path.join(clone, stored), CONTENT[n]);
      sh(clone, ['add', '-A']);
      sh(clone, ['commit', '-q', '-m', `v${n}`]);
      return sh(clone, ['rev-parse', 'HEAD']).trim();
    },
    storedName(clone, H) {
      const names = sh(clone, ['ls-tree', '-r', '-z', '--name-only', H, 'migrations/']).split('\0').filter((p) => p.startsWith('migrations/caf'));
      return names.map((p) => ({ name: p, form: p === p.normalize('NFC') ? 'NFC' : 'NFD', hex: Buffer.from(p).toString('hex') }));
    },
    contentDigest(clone, base, H) {
      const oid = sh(clone, ['rev-parse', `${H}:${stored}`]).trim();
      const was = tryGit(clone, ['rev-parse', '--verify', '--quiet', `${base}:${stored}`])?.trim() || null;
      return approvalDigest('protected', [{ path: NFC_PATH, blobs: [was, oid] }]);
    },
    trunkHasV(remote, n) {
      return tryGit(remote, ['cat-file', 'blob', `main:${stored}`]) === CONTENT[n];
    },
  };
}

/** A gitlink at migrations/vendor (mode 160000), pointing at commit A (v1) then commit B (v2). */
function gitlinkCase() {
  const p = 'migrations/vendor';
  const target = { 1: '1111111111111111111111111111111111111111', 2: '2222222222222222222222222222222222222222' };
  return {
    nfcPath: p,
    writeV(clone, n) {
      sh(clone, ['update-index', '--add', '--cacheinfo', `160000,${target[n]},${p}`]);
      sh(clone, ['commit', '-q', '-m', `gitlink v${n}`]);
      return sh(clone, ['rev-parse', 'HEAD']).trim();
    },
    storedName(clone, H) {
      return sh(clone, ['ls-tree', H, p]).trim();
    },
    contentDigest(_clone, _base, H) {
      // What the entry is: mode 160000 and the commit it points at.
      return approvalDigest('protected', [{ path: p, blobs: [null, sh(_clone, ['rev-parse', `${H}:${p}`]).trim()] }]);
    },
    trunkHasV(remote, n) {
      return (tryGit(remote, ['ls-tree', 'main', p]) ?? '').includes(target[n]);
    },
  };
}

const cases = [
  ['nfc-control', fileCase(NFC_PATH)],
  ['nfd', fileCase(NFD_PATH)],
  ['gitlink', gitlinkCase()],
];

console.log(`R-12 reproduction against ${ROOT}\n`);
const results = {};
for (const [name, c] of cases) {
  const r = await runCase(name, c);
  results[name] = r;
  console.log(`== ${name}`);
  if (r.storedName) console.log(`  tree entry: ${JSON.stringify(r.storedName)}`);
  for (const s of r.steps) console.log(`  ${s}`);
  if (r.error) console.log(`  HARNESS ERROR: ${r.error}\n  lander log tail:\n    ${(r.landerLogs ?? []).join('\n    ')}`);
  console.log('');
}

/** Unreviewed protected content reached trunk: v2 is on trunk and no human approved anything on L-2 itself. */
const unreviewed = (r) => !r.error && r.trunkHasV2 && r.directApprovalsOnL2 === 0;
const digestIgnoresContent = (r) => !r.error && r.l1?.digest && r.l2?.digest !== undefined && r.l1.digest === (r.l2.digest ?? r.l2.approvals.find((a) => a.carried_from)?.digest) && r.contentDigest1 !== r.contentDigest2;

const ctl = results['nfc-control'];
const ctlOk = !ctl.error && ctl.l1?.pending === 1 && ctl.l1.digest === ctl.contentDigest1 && ctl.l2?.pending === 1 && ctl.l2.digest !== ctl.l1.digest && !ctl.trunkHasV2 && ctl.approve1?.exitCode === 0 && /drop|create table/.test(ctl.approve1.shownDiff);
console.log(`control (NFC name): approval bound to content, v2 needs a new approval, v2 not on trunk: ${ctlOk ? 'yes' : 'NO'}`);

let defect = false;
for (const name of ['nfd', 'gitlink']) {
  const r = results[name];
  if (r.error) continue;
  const nullDigest = r.l1?.digest === r.nullDigest;
  const same = digestIgnoresContent(r);
  const bad = unreviewed(r);
  defect ||= bad;
  console.log(
    `${name}: L-1 digest is the content-free (path,null,null) digest: ${nullDigest}; L-1 and L-2 digests equal despite different content: ${same}; ` +
      `${r.l2?.pending === 0 ? `L-2 admitted with nothing pending (approval carried from ${r.l2.approvals.find((a) => a.carried_from)?.carried_from ?? '-'})` : `L-2 pending ${r.l2?.pending}`}; ` +
      `L-2 ${r.l2?.final}, v2 on trunk without any approval of L-2: ${bad}` +
      (name === 'nfd' && r.approve1 ? `; hub approve showed the human ${JSON.stringify(r.approve1.shownDiff)}` : ''),
  );
}

if (!ctlOk || Object.values(results).some((r) => r.error)) {
  console.log('\nHARNESS: the control case or a run did not behave as expected; see above.');
  if (!defect) process.exit(2);
}
if (defect) {
  console.log('\nDEFECT PRESENT: protected content no human was shown reached trunk on an approval carried over by a content-free digest.');
  process.exit(1);
}
console.log('\nno defect: every protected change that reached trunk was approved over its own content.');
process.exit(0);
