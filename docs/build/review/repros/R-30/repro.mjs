#!/usr/bin/env node
// R-30 reproduction: the lander's GC deletes the remote land ref of a landing
// that is being submitted at that moment (the adapter has pushed
// <P>land/<H> but its POST /land hasn't reached the hub yet), when H's
// committer date is more than 24 h old. Admission (serialized after GC) then
// fails the landing with not_pushed: a spurious send-back.
//
// Real pieces, all local: a bare remote, an in-process hub served over HTTP
// on 127.0.0.1:0 (startServer), and a real Lander (HubClient, GitPort over the
// lander's bare mirror, ChecksRunner) from ${AGENTHUB_ROOT}/packages/*/dist.
// No network, no API key, no resolver needed (the AI resolver is off).
//
// The agent's `land` is emulated exactly as the adapter does it
// (packages/adapter/src/land.ts steps 6 and 7): plain push of
// refs/agenthub/land/<H>, then POST /land {queue: true}. Design §3.9 step 1
// specifies the same order.
//
// Cases:
//   A (control): H committed just now. GC between push and POST keeps the ref
//     (orphan, but young); admission queues it.
//   B: H committed two days ago. A GC pass that runs between the push and the
//     POST sees no landing for the ref and deletes it; admission -> not_pushed.
//   C: the finding's interleaving inside one GC pass: GC's hub listing returns
//     before the POST, its ls-remote after the push (ls-remote is held until
//     the push is done, as a slower network round trip would be); the admission
//     round the POST triggers runs serially after GC -> not_pushed.
//
// Exit 1 when B or C shows the defect, 0 when neither does, 2 on a harness error.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { Hub, SqliteStore, startServer } = await imp('packages/hub/dist/index.js');
const { Lander } = await imp('packages/lander/dist/lander.js');
const { openGitPort } = await imp('packages/lander/dist/git-port.js');
const { HubClient } = await imp('packages/lander/dist/hub-client.js');
const { ChecksRunner } = await imp('packages/lander/dist/checks.js');
const { initWorkdir } = await imp('packages/lander/dist/init.js');
const { landerId } = await imp('packages/lander/dist/config.js');

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const DAY_S = 24 * 3600;
const nowS = () => Math.floor(Date.now() / 1000);

function gitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_')) env[k] = v;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', ...extra };
}
function sh(cwd, args, extra = {}) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}
const ident = (name, email, atS) => ({
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: email,
  GIT_COMMITTER_NAME: name,
  GIT_COMMITTER_EMAIL: email,
  GIT_AUTHOR_DATE: `${atS} +0000`,
  GIT_COMMITTER_DATE: `${atS} +0000`,
});

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'r30-')));
const remote = path.join(tmp, 'remote.git');
const workdir = path.join(tmp, 'lander');
const logs = [];
let front = null;
let hub = null;
let lander = null;

// Port wrappers for case C only: hold GC's ls-remote, and hear when GC's landings snapshot (no status filter) has returned.
let holdLsRemote = null; // { entered(): void, go: Promise<void> }
let snapshotTaken = null; // () => void
const wrap = (target, methods) =>
  new Proxy(target, {
    get(t, p) {
      if (Object.prototype.hasOwnProperty.call(methods, p)) return methods[p];
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });

async function main() {
  // The remote, seeded with trunk's agenthub.json.
  sh(tmp, ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = path.join(tmp, 'seed');
  mkdirSync(seed);
  sh(seed, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: P, land: { check: 'true' } }, null, 2)}\n`);
  for (const f of ['a', 'b', 'c']) {
    mkdirSync(path.join(seed, 'src'), { recursive: true });
    writeFileSync(path.join(seed, 'src', `${f}.ts`), `export const ${f} = 1;\n`);
  }
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-q', '-m', 'seed'], ident('Seed Human', 'seed@example.com', nowS() - 10 * DAY_S));
  sh(seed, ['push', '-q', remote, 'main']);

  // The hub, over HTTP on loopback, port 0.
  hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });

  // The lander: real HubClient, GitPort on its bare mirror, ChecksRunner.
  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const agent = landerId('lander/test');
  const client = new HubClient({ url: front.url, project: P, agent, landerToken: null });
  const plainGit = openGitPort({ mirror, remote: 'origin', env: { PATH: process.env.PATH ?? '' } });
  const hubPort = wrap(client, {
    async landings(filter) {
      const out = await client.landings(filter);
      if (snapshotTaken && !filter?.status && !filter?.agent) {
        const f = snapshotTaken;
        snapshotTaken = null;
        f();
      }
      return out;
    },
  });
  const gitPort = wrap(plainGit, {
    async listRemoteRefs(patterns) {
      if (holdLsRemote) {
        const h = holdLsRemote;
        holdLsRemote = null;
        h.entered();
        await h.go;
      }
      return plainGit.listRemoteRefs(patterns);
    },
  });
  lander = new Lander({
    hub: hubPort,
    git: gitPort,
    checks: new ChecksRunner({ workdir, mirror, env: { ...process.env }, killGraceMs: 2_000 }),
    resolver: null,
    log: (line) => logs.push(line),
    agent,
    project: P,
    committer: LANDER,
    drivers: [],
    trunk: 'main',
    leaseTtlMs: 10_000,
    timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
    workdir,
    host: 'test',
  });
  if (!(await lander.ensureLease())) throw new Error('the lander did not get the lease');

  let clones = 0;
  const makeCommit = (who, file, ageS) => {
    const dir = path.join(tmp, `clone-${++clones}-${who}`);
    sh(tmp, ['clone', '-q', remote, dir]);
    writeFileSync(path.join(dir, file), `export const v = ${clones * 100};\n`);
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', `${who}: change ${file}`], ident(`${who} agent`, `${who}@example.com`, nowS() - ageS));
    return { dir, agent: `${who}/claude-1`, H: sh(dir, ['rev-parse', 'HEAD']), file };
  };
  // Agent step 6: plain push of the land ref, never forced.
  const pushLandRef = (c) => sh(c.dir, ['push', '-q', 'origin', `${c.H}:refs/agenthub/land/${c.H}`]);
  // Agent step 7: POST /land {queue: true}.
  const postLand = (c) => hub.land(P, c.agent, { queue: true, commit: c.H, files: [c.file], summary: `change ${c.file}` }).landing;
  const remoteHas = (H) => sh(remote, ['for-each-ref', '--format=%(refname)', `refs/agenthub/land/${H}`]) !== '';
  const outcome = (id) => {
    const l = hub.getLanding(P, id);
    return { id, status: l.status, failure: l.failure?.code ?? null };
  };

  const results = {};

  // A (control): a fresh commit, GC between the push and the POST.
  {
    const c = makeCommit('maya', 'src/a.ts', 60);
    pushLandRef(c);
    await lander.gc();
    const refAfterGc = remoteHas(c.H);
    const L = postLand(c);
    await lander.admitRound();
    results.A = { committedHoursAgo: 0, refAfterGc, ...outcome(L.id) };
  }

  // B: the same, with a commit committed two days ago.
  {
    const c = makeCommit('sam', 'src/b.ts', 2 * DAY_S);
    pushLandRef(c);
    await lander.gc();
    const refAfterGc = remoteHas(c.H);
    const L = postLand(c);
    await lander.admitRound();
    results.B = { committedHoursAgo: 48, refAfterGc, ...outcome(L.id) };
  }

  // C: the finding's interleaving inside one GC pass.
  {
    const c = makeCommit('lee', 'src/c.ts', 2 * DAY_S);
    let entered;
    let go;
    let taken;
    const lsEntered = new Promise((r) => (entered = r));
    const snapshot = new Promise((r) => (taken = r));
    holdLsRemote = { entered, go: new Promise((r) => (go = r)) };
    snapshotTaken = taken;
    const gc = lander.gc();
    await Promise.all([snapshot, lsEntered]); // GC's landings listing has returned (no landing of H); its ls-remote hasn't run yet
    pushLandRef(c); // the adapter's push completes
    go(); // GC's ls-remote now sees the land ref
    const L = postLand(c); // POST /land arrives while GC is still working through the refs
    const admit = lander.admitRound(); // the admission loop wakes on landing.created; it runs after GC (serially)
    await Promise.all([gc, admit]);
    results.C = { committedHoursAgo: 48, refAfterGc: remoteHas(c.H), ...outcome(L.id) };
  }

  await lander.lease.release();
  return results;
}

let code = 2;
try {
  const r = await main();
  console.log(JSON.stringify(r, null, 2));
  console.log('lander log (gc / admission lines):');
  for (const l of logs) if (/^gc:|admission|admitted|failed admission/.test(l)) console.log(`  ${l}`);
  if (r.A.status !== 'queued') {
    console.log('HARNESS: the control case (fresh commit) was not queued; this reproduction tells nothing');
    code = 2;
  } else {
    const bad = ['B', 'C'].filter((k) => r[k].status === 'failed' && r[k].failure === 'not_pushed');
    if (bad.length > 0) {
      console.log(`DEFECT PRESENT (R-30): case ${bad.join(' and ')}: GC deleted the remote land ref of a landing being submitted (commit over 24 h old), and admission failed it with not_pushed`);
      code = 1;
    } else {
      console.log('defect absent: GC kept the land ref of the landing being submitted, and admission queued it');
      code = 0;
    }
  }
} catch (err) {
  console.error('HARNESS ERROR:', err);
  code = 2;
} finally {
  try {
    await front?.close();
    await new Promise((r) => setTimeout(r, 50));
    hub?.store?.close?.();
  } catch {
    // best effort
  }
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
