import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LANDER_LEASE_KEY } from '@agenthub/contract';
import type { Landing } from '@agenthub/hub/protocol';
import { FAULT_POINTS, type FaultPoint } from '../src/ports.js';
import { sh, testEnv } from './helpers.js';
import { P, Scenario, waitFor, type Clone } from './scenario.js';

// design §5.4: crash tests with real processes, a real hub and a real remote.
// For each fault point the lander runs as a child process that SIGKILLs
// itself there (AGENTHUB_LANDER_FAULTS, NODE_ENV=test); a second lander,
// started at once, stands by until the dead one's 1 s lease lapses, then runs
// startup recovery and finishes the landing as §2.2.7's table says. Each test
// asserts exactly one trunk commit for the landing, the hub's action when the
// lease ended (requeued lander_lost, or left in doubt), the landing's final
// state and retries, and no stray refs once a GC pass ran. Then: a stale
// lander (SIGSTOPped past its lease between its freshness check and its
// trunk push, then SIGCONTed): its writes under the old lease get not_lander
// and its push is up to date or refused; and hub-server restarts on the same
// database during checking and during pushing.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '..', 'bin', 'hub-lander.js');
const HUB_BIN = path.join(HERE, '..', '..', 'hub', 'bin', 'hub-server.js');
const TTL_MS = 1_000;
const T = 90_000;

interface Child {
  child: ChildProcess;
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Its stderr so far. */
  log(): string;
}

const children: ChildProcess[] = [];

function track(child: ChildProcess, out: 'stdout' | 'stderr'): Child {
  children.push(child);
  let text = '';
  child[out]!.on('data', (d: Buffer) => (text += d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, pid: child.pid!, exited, log: () => text };
}

/** `hub-lander run` as a child process, with a 1 s lease (and faults, when named). */
function lander(s: Scenario, o: { once?: boolean; faults?: string; hub?: string; ttlMs?: number; prefix?: string; env?: Record<string, string> } = {}): Child {
  const args = [BIN, 'run', ...(o.once ? ['--once'] : []), '--dir', s.workdir, '--hub', o.hub ?? s.front.url, '--project', P, '--id-prefix', o.prefix ?? 'lander/crash'];
  args.push('--lease-ttl-ms', String(o.ttlMs ?? TTL_MS), '--poll-trunk-ms', '100');
  const env = testEnv({ NODE_ENV: 'test', AGENTHUB_LANDER_FAULTS: o.faults, ...o.env });
  return track(spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] }), 'stderr');
}

/** Linux: the process's state letter (T = stopped), or null once it is gone. */
function procState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!;
  } catch {
    return null;
  }
}

/** Whether a live (not zombie) process of group `pgid` exists. */
function groupAlive(pgid: number): boolean {
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid && fields[0] !== 'Z') return true;
    } catch {
      // gone meanwhile
    }
  }
  return false;
}

/**
 * A git first on PATH that runs `act` (shell) once, the first time the
 * lander asks the remote for a land ref by name: that is pushCandidate's
 * ls-remote, after the lease freshness check and right before the trunk push.
 */
function gitShim(dir: string, name: string, act: string, pushLog?: string): string {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(dir, name);
  mkdirSync(bin, { recursive: true });
  const once = path.join(dir, `${name}.once`);
  writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh
${pushLog ? `case " $* " in *" push "*"refs/heads/"*) echo "$*" >> "${pushLog}" ;; esac
` : ''}case " $* " in
  *" ls-remote --refs "*) ;;
  *" ls-remote "*" refs/agenthub/land/"*) if mkdir "${once}" 2>/dev/null; then ${act}; fi ;;
esac
exec "${real}" "$@"
`,
  );
  chmodSync(path.join(bin, 'git'), 0o755);
  return `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
}

interface Exchange {
  /** When the request arrived (Date.now()). */
  at: number;
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  status: number;
  answer: Record<string, unknown> | null;
}

/** An HTTP proxy in front of the hub that records every request one lander sends, with the hub's answer. */
async function recordingProxy(target: string): Promise<{ url: string; log: Exchange[]; close(): void }> {
  const log: Exchange[] = [];
  const json = (text: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const at = Date.now();
      const text = Buffer.concat(chunks).toString();
      const headers: Record<string, string> = {};
      for (const k of ['x-hub-agent', 'x-hub-lander-token', 'authorization', 'content-type']) {
        const v = req.headers[k];
        if (typeof v === 'string') headers[k] = v;
      }
      fetch(`${target}${req.url}`, { method: req.method, headers, body: text === '' ? undefined : text }).then(
        async (r) => {
          const answer = await r.text();
          log.push({ at, method: req.method!, path: new URL(req.url!, target).pathname, body: json(text), status: r.status, answer: json(answer) });
          res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
          res.end(answer);
        },
        (err: unknown) => {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end(String(err));
        },
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** A write the hub fences by the lander lease (design §1.5): next, admit, advance, resolve, trunk reports, pause. */
function fencedWrite(e: Exchange): boolean {
  return e.method === 'POST' && /\/(?:lander\/(?:next|trunk|pause)|landings\/[^/]+\/(?:admit|advance|resolve))$/.test(e.path);
}

function leaseOf(e: Exchange): string | null {
  const lease = e.body?.lease as { lease_claim_id?: unknown } | undefined;
  return typeof lease?.lease_claim_id === 'string' ? lease.lease_claim_id : null;
}

/** The first-parent trunk commits since `from` that are landing `id` (by its trailers). */
function commitsOf(s: Scenario, from: string, id: string): string[] {
  return s.firstParents(from).filter((c) => s.trailers(c)['Agenthub-Landing'] === `${P}/${id}`);
}

/** The hub's reasons for `landing.updated` events of one landing, in order. */
function reasons(s: Scenario, id: string): string[] {
  return s.events.filter((e) => e.type === 'landing.updated' && e.data.landing_id === id).map((e) => String(e.data.reason));
}

let s: Scenario | null = null;
const closers: Array<() => void> = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      try {
        c.kill('SIGCONT');
        c.kill('SIGKILL');
      } catch {
        // gone
      }
    }
  }
  for (const close of closers.splice(0)) close();
  await s?.close();
  s = null;
});

/** What design §2.2.7's table says happens when the lander dies at each fault point. */
// after-admit: the admission round dies right after its admit answer, before anything picked the landing
// (the first lander runs --once there, so its attempt loop hasn't started).
const EXPECT: Record<FaultPoint, { hub: 'none' | 'lander_lost' | 'in_doubt' | 'landed'; attempt: number; lost: number; checkRuns: number }> = {
  'after-admit': { hub: 'none', attempt: 1, lost: 0, checkRuns: 1 },
  'after-next': { hub: 'lander_lost', attempt: 2, lost: 1, checkRuns: 1 },
  'during-merge': { hub: 'lander_lost', attempt: 2, lost: 1, checkRuns: 1 },
  'during-checks': { hub: 'lander_lost', attempt: 2, lost: 1, checkRuns: 2 },
  'after-checks': { hub: 'lander_lost', attempt: 2, lost: 1, checkRuns: 2 },
  'after-candidate-staged': { hub: 'lander_lost', attempt: 2, lost: 1, checkRuns: 2 },
  'after-pushing-ack': { hub: 'in_doubt', attempt: 1, lost: 0, checkRuns: 1 },
  'after-trunk-push': { hub: 'in_doubt', attempt: 1, lost: 0, checkRuns: 1 },
  'before-landed-ack': { hub: 'in_doubt', attempt: 1, lost: 0, checkRuns: 1 },
  'after-landed-ack': { hub: 'landed', attempt: 1, lost: 0, checkRuns: 1 },
};

describe.skipIf(process.platform !== 'linux')('crash tests (design §5.4)', () => {
  for (const point of FAULT_POINTS) {
    it(
      `${point}: the lander is SIGKILLed there, a standby takes over after the 1 s lease, and the landing lands exactly once`,
      async () => {
        const sc = (s = await Scenario.create());
        const want = EXPECT[point];
        const a = sc.clone('maya/claude-1');
        const task = sc.task(a, `Crash at ${point}`);
        const seedTip = sc.trunk();
        const H = a.commit(`a: survive ${point}`, { 'src/a.ts': `export const a = ${JSON.stringify(point)};\n` });
        // during-checks: the check blocks until released, so it is still running, orphaned, when its lander dies.
        if (point === 'during-checks') writeFileSync(path.join(sc.gate, 'block'), '');
        const L = sc.land(a, { task_id: task, summary: `survives ${point}` });

        // after-admit: `run --once` runs its admission round and only then asks for next, so the lander dies
        // with the landing admitted and not yet picked: its own row of the table, every time (CP2).
        const first = lander(sc, { faults: `${point}:${L.id}`, prefix: 'lander/first', once: point === 'after-admit' });
        const died = await first.exited;
        expect(died.signal, first.log()).toBe('SIGKILL');
        expect(first.log()).toContain(`fault ${point} (${L.id}): SIGKILL`);
        let orphan: number | null = null;
        if (point === 'during-checks') {
          const state = JSON.parse(readFileSync(path.join(sc.workdir, 'state.json'), 'utf8')) as { checks: Array<{ pgid: number; landing: string }> };
          orphan = state.checks.find((c) => c.landing === L.id)?.pgid ?? null;
          expect(orphan).not.toBeNull();
          expect(groupAlive(orphan!)).toBe(true);
          expect(existsSync(path.join(sc.workdir, 'runs', `${L.id}.1`)), 'the dead lander left its run directory').toBe(true);
        }
        const atDeath: Landing = sc.landing(L.id);
        if (point === 'after-admit') {
          expect(atDeath.status).toBe('queued');
          expect(reasons(sc, L.id)).not.toContain('picked');
        }
        const pushingCandidate = atDeath.phase === 'pushing' ? atDeath.candidate : null;
        if (point === 'after-trunk-push' || point === 'before-landed-ack') expect(sc.trunk()).toBe(pushingCandidate);

        // A second lander at once: it stands by on the dead one's lease (if that hasn't lapsed yet), then takes over.
        const second = lander(sc, { once: true, prefix: 'lander/second' });
        const ran = await second.exited;
        expect(ran.code, second.log()).toBe(0);
        if (orphan !== null) expect(groupAlive(orphan), 'startup recovery kills the orphaned check').toBe(false);
        expect(readdirSync(path.join(sc.workdir, 'runs')), 'startup recovery removes runs/*').toEqual([]);
        // It got the lease only once the dead lander's had lapsed (expired: nobody released it).
        const lease = sc.events.filter((e) => e.type.startsWith('claim.') && Array.isArray(e.data.files) && e.data.files.includes(LANDER_LEASE_KEY));
        const lapsed = lease.findIndex((e) => e.type !== 'claim.granted' && String(e.data.holder).startsWith('lander/first-'));
        expect(lease[lapsed]?.type).toBe('claim.expired');
        expect(lease.findIndex((e) => e.type === 'claim.granted' && String(e.data.holder).startsWith('lander/second-'))).toBeGreaterThan(lapsed);

        // What the hub did when the dead lander's lease ended (§2.2.7 "Hub action").
        const r = reasons(sc, L.id);
        if (want.hub === 'lander_lost') expect(r).toContain('requeued:lander_lost');
        else expect(r).not.toContain('requeued:lander_lost');
        if (want.hub === 'in_doubt') expect(r).toContain('in_doubt');
        else expect(r).not.toContain('in_doubt');

        const done = sc.landing(L.id);
        expect(done.status).toBe('landed');
        expect(done.attempt).toBe(want.attempt);
        expect(done.retries).toEqual({ trunk_moved: 0, lander_lost: want.lost, step_timeout: 0 });
        expect(done.in_doubt).toBe(false);
        expect(done.reconciled).toBe(false);
        if (pushingCandidate) expect(done.trunk_sha, 'the same candidate, pushed or found').toBe(pushingCandidate);
        expect(sc.checkRuns(L.id)).toHaveLength(want.checkRuns);

        // Exactly one trunk commit, and it is this landing's.
        expect(sc.firstParents(seedTip)).toEqual([done.trunk_sha]);
        expect(commitsOf(sc, seedTip, L.id)).toHaveLength(1);
        expect(sc.trailers(done.trunk_sha!)).toMatchObject({ 'Agenthub-Landing': `${P}/${L.id}`, 'Agenthub-Hub': sc.hub.epoch, 'Agenthub-Source': H, 'Agenthub-Attempt': String(want.attempt) });
        expect(sc.hub.listTasks(P).find((t) => t.id === task)?.status).toBe('done');
        expect(sc.hub.listClaims(P).filter((c) => c.landing_id === L.id)).toEqual([]);

        // A GC pass (at a lease grant) leaves no stray land or candidate refs.
        const gc = lander(sc, { once: true, prefix: 'lander/gc' });
        expect((await gc.exited).code, gc.log()).toBe(0);
        expect(sc.agenthubRefs()).toEqual([]);
        expect(sh(path.join(sc.workdir, 'mirror.git'), ['for-each-ref', '--format=%(refname)', 'refs/agenthub/cand/', 'refs/agenthub/land/']), 'nor in the mirror').toBe('');
        expect(sc.hub.landerStatus(P).lease).toBeNull();
      },
      T,
    );
  }

  for (const variant of ['up_to_date', 'refused'] as const) {
    it(
      `a stale lander, SIGSTOPped past its lease right before its trunk push, then SIGCONTed: its writes get not_lander, its push is ${variant === 'up_to_date' ? 'up to date' : 'refused'}, and trunk has one commit of the landing`,
      async () => {
        const sc = (s = await Scenario.create());
        const a = sc.clone('maya/claude-1');
        const seedTip = sc.trunk();
        a.commit('a: stale', { 'src/a.ts': 'export const a = "stale";\n' });
        const L = sc.land(a, { summary: 'stale lander' });
        // It stops itself in pushCandidate's ls-remote of the land ref: after the freshness check, right before the push.
        const pushLog = path.join(sc.t.dir, 'stale-pushes.log');
        const PATH = gitShim(sc.t.dir, 'stop-git', 'kill -STOP $PPID', pushLog);
        // Its hub traffic goes through a recording proxy, so the test sees what the hub answered its stale writes.
        const proxy = await recordingProxy(sc.front.url);
        closers.push(proxy.close);
        const stale = lander(sc, { prefix: 'lander/stale', env: { PATH }, hub: proxy.url });
        await waitFor(() => procState(stale.pid) === 'T', 'the stale lander to stop before its push');
        const pushing = sc.landing(L.id);
        expect(pushing.status).toBe('running');
        expect(pushing.phase).toBe('pushing');
        expect(pushing.lander).toMatch(/^lander\/stale-/);
        const staleLease = pushing.lease_claim_id!;
        const writeAhead = proxy.log.find((e) => e.path.endsWith(`/landings/${L.id}/advance`) && e.body?.phase === 'pushing');
        expect(writeAhead?.status, 'the stale lander entered pushing through the proxy').toBe(200);
        expect(leaseOf(writeAhead!)).toBe(staleLease);

        // Another lander: it stands by until the stopped one's lease lapses, then resolves L in doubt (the same C).
        const fresh = lander(sc, { once: true, prefix: 'lander/fresh' });
        expect((await fresh.exited).code, fresh.log()).toBe(0);
        expect(fresh.log()).toContain(`${L.id}: pushed its staged candidate`);
        const landed = sc.landing(L.id);
        expect(landed.status).toBe('landed');
        expect(landed.trunk_sha).toBe(pushing.candidate);
        let tip = landed.trunk_sha!;
        if (variant === 'refused') {
          // Trunk moves on before the stale lander wakes: its CAS on the old T0 must be refused.
          const b = sc.clone('sam/claude-1');
          b.commit('b: next', { 'src/b.ts': 'export const b = "next";\n' });
          const L2 = sc.land(b, { summary: 'next landing' });
          const again = lander(sc, { once: true, prefix: 'lander/fresh' });
          expect((await again.exited).code, again.log()).toBe(0);
          expect(sc.landing(L2.id).status).toBe('landed');
          tip = sc.trunk();
          expect(tip).not.toBe(landed.trunk_sha);
        }
        const updates = sc.trunkUpdateTries();
        const settled = sc.landing(L.id);
        expect(existsSync(pushLog)).toBe(false);

        const woke = Date.now();
        process.kill(stale.pid, 'SIGCONT');
        // It wakes in the middle of its attempt: it goes on to its CAS push, which must change nothing, and it learns
        // its lease is gone (its own heartbeat timer usually tells it first; a fenced write would get not_lander).
        await waitFor(() => existsSync(pushLog) && /lost the lander lease C-\d+/.test(stale.log()), 'the stale lander to push and to drop its lease').catch((err: Error) => {
          throw new Error(`${err.message}\n${stale.log()}`);
        });
        await waitFor(() => /lease lost in pushing/.test(stale.log()), 'the stale attempt to end');
        stale.child.kill('SIGTERM');
        expect((await stale.exited).code, stale.log()).toBe(0);
        expect(readFileSync(pushLog, 'utf8')).toContain(`--force-with-lease=refs/heads/main:${pushing.trunk_base}`);
        expect(stale.log()).not.toMatch(new RegExp(`${L.id} landed as`));

        // Its writes under the old lease get not_lander: whatever it sent itself after waking (its own heartbeat
        // timer usually tells it the lease is gone first, so it may send none), and a late copy of its write-ahead,
        // as a network that held it back would deliver it now.
        const late = proxy.log.filter((e) => e.at >= woke && fencedWrite(e) && leaseOf(e) === staleLease);
        for (const e of late) expect({ path: e.path, status: e.status, code: (e.answer?.error as { code?: string } | undefined)?.code }).toEqual({ path: e.path, status: 409, code: 'not_lander' });
        const replay = await fetch(`${sc.front.url}${writeAhead!.path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-hub-agent': pushing.lander! },
          body: JSON.stringify(writeAhead!.body),
        });
        expect(replay.status).toBe(409);
        expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('not_lander');

        // Its push went nowhere: no trunk update reached the remote, trunk is where it was, L is on it once, and
        // nothing of L changed at the hub.
        expect(sc.trunkUpdateTries()).toBe(updates);
        const after = sc.landing(L.id);
        expect({ ...after, position: null, eta_ms: null }).toEqual({ ...settled, position: null, eta_ms: null });
        expect(sc.trunk()).toBe(tip);
        expect(commitsOf(sc, seedTip, L.id)).toEqual([landed.trunk_sha]);
        expect(sc.landing(L.id)).toMatchObject({ status: 'landed', trunk_sha: landed.trunk_sha, attempt: 1 });
        expect(sc.landing(L.id).retries).toEqual({ trunk_moved: 0, lander_lost: 0, step_timeout: 0 });
        if (variant === 'up_to_date') expect(sc.firstParents(seedTip)).toEqual([landed.trunk_sha]);
      },
      T,
    );
  }

  for (const during of ['checking', 'pushing'] as const) {
    it(
      `hub-server restarts on the same database during ${during}: the landing lands once, in the same attempt`,
      async () => {
        const sc = (s = await Scenario.create());
        const db = path.join(sc.t.dir, 'hub.db');
        let hub = await hubServer(db);
        const a = sc.clone('maya/claude-1');
        const seedTip = sc.trunk();
        const H = a.commit(`a: restart during ${during}`, { 'src/a.ts': `export const a = "${during}";\n` });
        const L = await httpLand(hub.url, a, H);

        let PATH = process.env.PATH ?? '';
        const go = path.join(sc.t.dir, 'go');
        if (during === 'checking') writeFileSync(path.join(sc.gate, 'block'), '');
        else PATH = gitShim(sc.t.dir, 'wait-git', `touch "${path.join(sc.t.dir, 'waiting')}"; while [ ! -e "${go}" ]; do sleep 0.05; done`);
        // A 10 s lease: the restart takes about a second, and the lease (stored in the database) outlives it.
        const run = lander(sc, { hub: hub.url, ttlMs: 10_000, prefix: 'lander/restart', env: { PATH } });
        if (during === 'checking') await waitFor(() => existsSync(path.join(sc.gate, 'started')), 'the check to start', 30_000);
        else await waitFor(() => existsSync(path.join(sc.t.dir, 'waiting')), 'the lander to be about to push', 30_000);
        const before = await httpLanding(hub.url, L);
        expect(before.phase).toBe(during);

        hub.child.kill('SIGKILL');
        await hub.exited;
        hub = await hubServer(db, hub.port);
        if (during === 'checking') writeFileSync(path.join(sc.gate, 'release'), '');
        else writeFileSync(go, '');

        let done: Landing | null = null;
        for (const end = Date.now() + 40_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
          done = await httpLanding(hub.url, L).catch(() => null);
          if (done && done.status !== 'running' && done.status !== 'queued') break;
        }
        run.child.kill('SIGTERM');
        expect((await run.exited).code, run.log()).toBe(0);
        expect(done?.status, run.log()).toBe('landed');
        expect(done!.attempt).toBe(1);
        expect(done!.retries).toEqual({ trunk_moved: 0, lander_lost: 0, step_timeout: 0 });
        if (during === 'pushing') expect(done!.trunk_sha).toBe(before.candidate);
        expect(sc.firstParents(seedTip)).toEqual([done!.trunk_sha]);
        expect(sc.trailers(done!.trunk_sha!)).toMatchObject({ 'Agenthub-Landing': `${P}/${L}`, 'Agenthub-Source': H, 'Agenthub-Attempt': '1' });
        hub.child.kill('SIGTERM');
        await hub.exited;
      },
      T,
    );
  }
});

// ------------------------------------------------------------ a hub-server child

interface HubServer {
  url: string;
  port: number;
  child: ChildProcess;
  exited: Promise<unknown>;
}

async function hubServer(db: string, port = 0): Promise<HubServer> {
  const c = track(spawn(process.execPath, [HUB_BIN, '--port', String(port), '--db', db], { env: testEnv(), stdio: ['ignore', 'pipe', 'ignore'] }), 'stdout');
  await waitFor(() => /listening on http:\/\/\S+/.test(c.log()), 'hub-server to listen', 20_000);
  const url = /listening on (http:\/\/\S+)/.exec(c.log())![1]!;
  return { url, port: Number(new URL(url).port), child: c.child, exited: c.exited };
}

async function hubCall<T>(url: string, method: 'GET' | 'POST', route: string, agent: string, body?: unknown): Promise<T> {
  const res = await fetch(`${url}/v1/p/${encodeURIComponent(P)}${route}`, {
    method,
    headers: { 'x-hub-agent': agent, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${data.error?.message}`);
  return data;
}

/** As `land` does, over HTTP: push the land ref, then POST /land {queue: true}. */
async function httpLand(url: string, c: Clone, H: string): Promise<string> {
  sh(c.dir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
  sh(c.dir, ['fetch', '-q', 'origin', 'main']);
  const files = sh(c.dir, ['diff', '--name-only', `origin/main...${H}`]).split('\n').filter(Boolean);
  const r = await hubCall<{ landing: Landing }>(url, 'POST', '/land', c.agent, { queue: true, commit: H, files, summary: 'survives a hub restart' });
  return r.landing.id;
}

async function httpLanding(url: string, id: string): Promise<Landing> {
  return (await hubCall<{ landing: Landing }>(url, 'GET', `/landings/${id}`, 'human/test')).landing;
}
