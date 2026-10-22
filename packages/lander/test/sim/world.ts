// The deterministic protocol simulation's world (design §5.2): the real
// Lander (lease, admission, pipeline.ts, recovery.ts, GC) against the real Hub
// in-process (SqliteStore(':memory:') on a simulated clock), a fake GitPort
// (an in-memory remote with fast-forward-only CAS), a fake ChecksPort and a
// stub resolver, all under one seeded scheduler.
//
// Every port call, sleep and long-poll is a step the scheduler picks from the
// runnable ones at random (seeded), so each seed is one interleaving of the
// landers, agents and a human. Faults are injected under the same seed:
// lander crashes at every Faults point and between any two awaits (also right
// after a request took effect), dropped requests and responses, unknown push
// outcomes before and after the effect, refused trunk pushes, lease expiry
// beyond the self-fencing margin (a lander frozen past its lease, at any
// moment or right after its write-ahead, mostly with its clocks stopped so
// only the hub's fencing can stop it), foreign pushes, trunk rewinds followed
// by resume --accept-trunk, cancels, supersedes and re-lands, a second lander
// machine, and (rarely) a recreated hub database.
//
// After every step that changed anything it checks the invariants; after the
// faults stop, every landing must reach a terminal state with the hub and
// trunk agreeing. A mutation removes one protection, to show the invariants
// catch the class of bug each protection exists for.

import { createHash } from 'node:crypto';
import { landRef } from '@agenthub/contract';
import { Hub, HubError, SqliteStore, type HubAuth, type HubEvent } from '@agenthub/hub';
import type { EventsResult, Landing, LandingStatus } from '@agenthub/hub/protocol';
import { Lander } from '../../src/lander.js';
import { HubCallError, type ChecksPort, type Clock, type EventsQuery, type Faults, type GitPort, type HubPort, type ResolveRequest, type ResolveResult, type ResolverPort } from '../../src/ports.js';
import { FAIL_MARKER, FakeChecks } from '../fakes/checks-port.js';
import { FakeRemote, fakeGitPort, ObjectDb, Place, type Tree } from '../fakes/git-port.js';

export const P = 'acme/web';
const LANDER_ID = { name: 'agenthub lander', email: 'lander@localhost' };
const T_START = 1_800_000_000_000;
const LEASE_TTL_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const POLL_MS = 15_000;
const APPROVER: HubAuth = { lander: false, approver: 'boss' };
const LIVE: LandingStatus[] = ['submitted', 'queued', 'needs_approval', 'running'];

/** One protection removed (design §5.2 "Mutation guards"). */
export type Mutation =
  /** A plain fast-forward push instead of the CAS on T0 (rewinds injected). */
  | 'plain_push'
  /** No write-ahead: the trunk push happens before `pushing` is recorded. */
  | 'push_before_pushing'
  /** A lease that ends requeues its landing even in `pushing` (T9 instead of T10). */
  | 'requeue_pushing_on_lease_loss'
  /** Cancel allowed in `pushing`. */
  | 'cancel_in_pushing'
  /** Trailers matched on the landing id alone (a recreated database injected). */
  | 'id_only_trailers';

export const MUTATIONS: readonly Mutation[] = ['plain_push', 'push_before_pushing', 'requeue_pushing_on_lease_loss', 'cancel_in_pushing', 'id_only_trailers'];

export interface SimOptions {
  seed: number;
  mutation?: Mutation | null;
  /** Fires the fake timers (the lease heartbeat timers) by `ms`: vi.advanceTimersByTime. */
  advanceTimers(ms: number): void;
  /** Return every step and log line in `tail`, not just the last ones (for replaying one seed). */
  fullTrace?: boolean;
}

export interface SimOutcome {
  seed: number;
  mutation: Mutation | null;
  /** The first invariant that failed, or null. */
  violation: string | null;
  steps: number;
  simMs: number;
  landings: number;
  landed: number;
  /** sha256 of every step taken (two runs of one seed must agree). */
  digest: string;
  /** The last steps and log lines, for a failing seed. */
  tail: string[];
  stats: Record<string, number>;
}

/** mulberry32: small, fast, seedable. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed ^ 0x9e3779b9) >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return p > 0 && this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  hex(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }
}

/** One simulated process: a lander, an agent, the human, or the world's own clockwork. */
export class Proc {
  dead = false;
  frozenSince: number | null = null;
  frozenUntil = 0;
  /** Whether its clocks stop while it is frozen (a suspended VM), or keep going (SIGSTOP: it sees the jump when it wakes). */
  clockStops = true;
  /** How far this process's clocks are behind true time (time it spent frozen with its clocks stopped). */
  lag = 0;
  readonly clock: Clock;
  onKill: (() => void) | null = null;
  constructor(
    readonly w: World,
    readonly name: string,
    readonly kind: 'lander' | 'agent' | 'human' | 'world',
  ) {
    this.clock = { now: () => this.now(), monotonic: () => this.now(), sleep: (ms, signal) => w.sleep(this, ms, signal) };
  }
  now(): number {
    return (this.frozenSince !== null && this.clockStops ? this.frozenSince : this.w.time) - this.lag;
  }
}

interface Op {
  proc: Proc;
  label: string;
  /** Runnable from this true time on (once its proc isn't frozen) ... */
  at: number;
  /** ... when ready() holds, or in any case from `deadline`. */
  deadline: number;
  ready(): boolean;
  run(): void;
}

interface Settle<T> {
  resolve(v: T): void;
  reject(e: unknown): void;
}

/** Fault rates of one seed: some seeds are calm, some are storms. */
interface Profile {
  agents: number;
  items: number;
  dropRequest: number;
  dropResponse: number;
  crashAfterEffect: number;
  faultPoint: number;
  unknownPush: number;
  rejectTrunk: number;
  unreachable: number;
  eventMeanMs: number;
  events: { kill: number; freeze: number; foreign: number; rewind: number; recreate: number };
  /** The chance an agent cancels a live landing of its own when it looks at it ... */
  cancel: number;
  /** ... when the landing is in pushing (the hub refuses it: too late) ... */
  cancelPushing: number;
  /** ... and when it came back after its lander was lost (retries.lander_lost > 0). */
  cancelLost: number;
  supersede: number;
  stack: number;
  failRate: number;
  protectedRate: number;
  resolver: boolean;
  externalPushes: 'warn' | 'pause';
  machines: number;
  faultPhaseMs: number;
  /** The chance that a lander stalls right after its write-ahead (entering pushing), before its trunk push. */
  freezeAtPushing: number;
}

/** Paths through the lander that the faults must reach, by its log lines (the 2,000-seed run asserts each one happened). */
export const COVERAGE: ReadonlyArray<[string, RegExp]> = [
  ['in_doubt_pushed', /: pushed its staged candidate /],
  ['in_doubt_on_trunk', / is on trunk as \w+: resolved as landed/],
  ['in_doubt_requeued', /without it: back to the queue|staged candidate .* is gone: back to the queue/],
  ['push_retry', /: outcome unknown \(.*\); retrying in /],
  ['push_unknown', /trunk push's outcome is unknown/],
  ['push_stale', /before the push: back to the queue/],
  ['push_rejected', /the remote refused the trunk update/],
  ['trunk_rewritten', /trunk was rewritten/],
  ['trunk_moved_in_checks', /trunk moved while its checks ran/],
  ['already_on_trunk', / is already on trunk as /],
  ['lease_lost_in_attempt', /lease lost; dropping attempt/],
  ['attempt_stale', /attempt \d+ is over at the hub/],
  ['standby', /standing by: /],
  ['parked', /parked for approval/],
  ['approved_fast_path', /approved, on an unchanged trunk/],
  ['self_fenced', /last acknowledgement is stale: not entering pushing|outcome is unknown \(no fresh lease\)/],
];

function hubUnavailable(what: string): HubCallError {
  return new HubCallError('unavailable', null, `hub unreachable (${what}: dropped)`);
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** A lander machine: its mirror outlives the lander processes that run on it. */
interface Machine {
  name: string;
  mirror: Place;
  proc: LanderProc | null;
  gen: number;
}

export class World {
  readonly rng: Rng;
  readonly mutation: Mutation | null;
  readonly profile: Profile;
  time = T_START;
  phase: 'faults' | 'liveness' = 'faults';
  readonly db = new ObjectDb();
  readonly remote: FakeRemote;
  hub!: Hub;
  readonly oldHubs: Hub[] = [];
  private ops: Op[] = [];
  readonly procs: Proc[] = [];
  readonly machines: Machine[] = [];
  readonly agents: Agent[] = [];
  private readonly world: Proc;
  /** `${parent}:${tree}` of candidates that passed their checks. */
  readonly passed = new Set<string>();
  /** `${epoch}|${landing}|${candidate}` → when the hub first recorded that candidate in pushing. */
  readonly recordedPushing = new Map<string, number>();
  /** Every rewind: its target and when. */
  readonly rewinds: Array<{ target: string; at: number }> = [];
  /** Commits a rewind took off trunk. */
  readonly rewound = new Set<string>();
  /** The commit trunk was last rewound to, for the human's resume --accept-trunk. */
  lastRewind: string | null = null;
  /** Agent commits: their own marker path (the change is on trunk iff the marker is in trunk's tree). */
  readonly markers = new Map<string, string>();
  /** Terminal-unlanded landings found on trunk in the documented exception: they must be reconciled by the end. */
  readonly mustReconcile = new Set<string>();
  violation: string | null = null;
  private dirty = true;
  steps = 0;
  private eventVersion = 0;
  private readonly trace = createHash('sha256');
  private readonly tailLines: string[] = [];
  readonly stats: Record<string, number> = {};
  private recreations = 0;
  /** A lander stalled in pushing when the database was recreated, woken by the new database's landing of the same id. */
  wakeOnReuse: { proc: Proc; id: string; epoch: string; commit: string | null } | null = null;
  /** The commit of the landing a lander stalled with when the database was recreated (for the id_only_trailers guard). */
  stalledCommit: string | null = null;

  constructor(readonly o: SimOptions) {
    this.rng = new Rng(o.seed * 7919 + (o.mutation ? MUTATIONS.indexOf(o.mutation) + 1 : 0) * 104729);
    this.mutation = o.mutation ?? null;
    this.profile = this.makeProfile();
    this.remote = new FakeRemote(this.db, 'main');
    this.remote.plainPush = this.mutation === 'plain_push';
    this.world = new Proc(this, 'world', 'world');
    this.procs.push(this.world);
    this.newHub();
    this.seedTrunk();
    this.remote.hooks = {
      reachable: (who) => !this.faulty(who) || !this.rng.chance(this.profile.unreachable),
      trunkPush: (who) => this.pushFate(who, true),
      refPush: (who) => this.pushFate(who, false),
      onTrunkUpdate: (e) => this.onTrunkUpdate(e),
    };
  }

  // ------------------------------------------------------------ setup

  private makeProfile(): Profile {
    const r = this.rng;
    const storm = r.chance(0.35);
    const p: Profile = {
      agents: r.chance(0.3) ? 3 : 2,
      items: r.pick([1, 2, 2, 3]),
      dropRequest: r.pick([0, 0.01, 0.03]),
      dropResponse: r.pick([0, 0.01, 0.03]),
      crashAfterEffect: r.pick([0, 0.002, 0.006]),
      faultPoint: r.pick([0, 0.01, 0.04]),
      unknownPush: r.pick([0, 0.05, 0.15]),
      rejectTrunk: r.pick([0, 0, 0.04]),
      unreachable: r.pick([0, 0.01, 0.03]),
      eventMeanMs: storm ? 25_000 : r.pick([60_000, 150_000]),
      events: { kill: 3, freeze: 3, foreign: 2, rewind: 1, recreate: r.chance(0.1) ? 0.4 : 0 },
      cancel: 0,
      cancelPushing: 0,
      cancelLost: 0,
      supersede: r.pick([0.01, 0.04]),
      stack: 0.2,
      failRate: r.pick([0.1, 0.25]),
      protectedRate: r.pick([0, 0.15, 0.3]),
      resolver: r.chance(0.5),
      externalPushes: r.chance(0.2) ? 'pause' : 'warn',
      machines: r.chance(0.8) ? 2 : 1,
      faultPhaseMs: 40 * 60_000,
      freezeAtPushing: r.pick([0, 0.05, 0.2]),
    };
    p.cancel = p.cancelPushing = p.cancelLost = r.pick([0.01, 0.03]);
    // Each mutation guard runs where its protection matters most.
    switch (this.mutation) {
      case 'plain_push':
        p.events = { kill: 1, freeze: 1, foreign: 2, rewind: 8, recreate: 0 };
        p.eventMeanMs = 8_000;
        break;
      case 'push_before_pushing':
        p.cancel = 0.5;
        p.supersede = 0.1;
        break;
      case 'cancel_in_pushing':
        // Agents cancel what is in pushing, while its lander stalls before the push.
        p.cancel = p.cancelLost = 0.01;
        p.cancelPushing = 0.9;
        p.freezeAtPushing = 0.7;
        break;
      case 'requeue_pushing_on_lease_loss':
        // Agents cancel what came back from a lost lander, while that lander (stalled past its lease) still means to push.
        p.cancel = p.cancelPushing = 0.01;
        p.cancelLost = 0.9;
        p.events = { kill: 2, freeze: 2, foreign: 0, rewind: 0, recreate: 0 };
        p.freezeAtPushing = 0.7;
        break;
      case 'id_only_trailers':
        // The database is recreated from the pushing hook (onHubEvent), at the moment that matters.
        p.events = { kill: 1, freeze: 2, foreign: 0, rewind: 0, recreate: 0 };
        p.agents = 3;
        p.machines = 2;
        p.supersede = 0;
        break;
      default:
        break;
    }
    return p;
  }

  private agenthubJson(): string {
    return `${JSON.stringify({ project: P, land: { check: 'sim-check', protected: ['migrations/**'], resolver: { enabled: this.profile.resolver }, externalPushes: this.profile.externalPushes } }, null, 2)}\n`;
  }

  private seedTrunk(): void {
    const files: Record<string, string> = { 'agenthub.json': this.agenthubJson(), 'README.md': '# sim\n', 'migrations/0.sql': 'seed', 'migrations/1.sql': 'seed' };
    for (let i = 0; i < 3; i++) files[`s/${i}.txt`] = 'seed';
    const root = this.db.commit({
      tree: this.db.tree(files),
      parent: null,
      message: 'seed',
      author: { name: 'Seed', email: 'seed@example.com', date: `${Math.floor(this.time / 1000)} +0000` },
      committer: { name: 'Seed', email: 'seed@example.com' },
      time: this.time,
    });
    this.remote.setTrunk(root);
  }

  private newHub(): void {
    const store = new SqliteStore(':memory:');
    // A fixed epoch per seed and database, so commit shas (which carry it in their trailers) are the same on every run.
    const epoch = [this.rng.hex(8), this.rng.hex(4), `4${this.rng.hex(3)}`, `8${this.rng.hex(3)}`, this.rng.hex(12)].join('-');
    (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db.prepare("UPDATE meta SET value = ? WHERE key = 'epoch'").run(epoch);
    (store as unknown as { epochId: string }).epochId = epoch;
    const hub = new Hub({ store, now: () => this.time, leaseTtlMs: LEASE_TTL_MS, heartbeatIntervalMs: HEARTBEAT_MS });
    if (hub.epoch !== epoch) throw new Error('sim: could not fix the hub epoch');
    hub.subscribe((e) => this.onHubEvent(hub, e));
    if (this.hub) this.oldHubs.push(this.hub);
    this.hub = hub;
    this.dirty = true;
  }

  // ------------------------------------------------------------ the scheduler

  newProc(name: string, kind: Proc['kind']): Proc {
    const p = new Proc(this, name, kind);
    this.procs.push(p);
    return p;
  }

  /** A port call: its effect happens when the scheduler runs the step. */
  call<T>(proc: Proc, label: string, run: (s: Settle<T>) => void): Promise<T> {
    if (proc.dead) return new Promise<T>(() => {});
    return new Promise<T>((resolve, reject) => {
      this.ops.push({ proc, label, at: this.time, deadline: this.time, ready: () => true, run: () => run({ resolve, reject }) });
    });
  }

  sleep(proc: Proc, ms: number, signal?: AbortSignal): Promise<void> {
    if (proc.dead) return new Promise<void>(() => {});
    return new Promise<void>((resolve) => {
      this.ops.push({ proc, label: 'sleep', at: this.time, deadline: this.time + Math.max(0, ms), ready: () => signal?.aborted === true, run: () => resolve() });
    });
  }

  private wait(proc: Proc, ms: number): Promise<void> {
    return this.sleep(proc, ms);
  }

  kill(p: Proc, why: string): void {
    if (p.dead) return;
    p.dead = true;
    this.ops = this.ops.filter((op) => op.proc !== p);
    this.note(`KILL ${p.name}: ${why}`);
    this.count('kills');
    p.onKill?.();
  }

  /**
   * Freezes `p` for `ms`: it takes no step meanwhile. Its clocks stop too
   * (the lease looks as fresh when it wakes as when it froze: only the hub's
   * fencing stops it), unless `clockStops` is false (it sees the time jump
   * when it wakes, and its own self-fencing can act first).
   */
  freeze(p: Proc, ms: number, clockStops = true): void {
    if (p.dead || p.frozenSince !== null) return;
    p.frozenSince = this.time;
    p.frozenUntil = this.time + ms;
    p.clockStops = clockStops;
    this.note(`FREEZE ${p.name} for ${ms} ms${clockStops ? '' : ' (its clocks keep going)'}`);
    this.count('freezes');
  }

  /** One scheduler step: false when nothing at all is left to run. */
  private async step(): Promise<boolean> {
    // Unfreeze due processes first (their clocks resume).
    for (const p of this.procs) {
      if (p.frozenSince !== null && p.frozenUntil <= this.time) {
        if (p.clockStops) p.lag += p.frozenUntil - p.frozenSince;
        p.frozenSince = null;
      }
    }
    const runnable: Op[] = [];
    let next = Number.POSITIVE_INFINITY;
    for (const op of this.ops) {
      const from = Math.max(op.at, op.proc.frozenSince !== null ? op.proc.frozenUntil : 0);
      if (from <= this.time && (this.time >= op.deadline || op.ready())) runnable.push(op);
      else next = Math.min(next, Math.max(from, op.deadline));
    }
    if (runnable.length === 0) {
      if (!Number.isFinite(next)) return false;
      this.advanceTo(next);
      return true;
    }
    const op = this.rng.pick(runnable);
    this.ops.splice(this.ops.indexOf(op), 1);
    this.steps++;
    if (process.env.SIM_COUNT_OPS) this.count(`op.${op.proc.kind}.${op.label}`);
    const line = `${this.time - T_START} ${op.proc.name} ${op.label}`;
    this.trace.update(line);
    this.trace.update('\n');
    this.pushTail(line);
    op.run();
    // Let every continuation run until it waits on its next step.
    await new Promise<void>((r) => setImmediate(r));
    if (op.label !== 'sleep') this.advanceTo(this.time + this.rng.int(1, 15));
    if (this.dirty) {
      this.dirty = false;
      this.checkState();
    }
    return true;
  }

  private advanceTo(t: number): void {
    if (t <= this.time) return;
    const delta = t - this.time;
    this.time = t;
    this.o.advanceTimers(delta);
  }

  private async runUntil(done: () => boolean, maxSteps: number, maxTime: number): Promise<boolean> {
    let n = 0;
    while (!this.violation) {
      if (done()) return true;
      if (n++ > maxSteps || this.time > maxTime) return false;
      if (!(await this.step())) return done();
    }
    return false;
  }

  // ------------------------------------------------------------ faults

  /** Whether `who` (a process name) is subject to faults now: landers, during the fault phase. */
  private faulty(who: string): boolean {
    return this.phase === 'faults' && who.startsWith('lander/');
  }

  private pushFate(who: string, trunk: boolean): 'ok' | 'unknown_before' | 'unknown_after' | 'rejected' {
    if (!this.faulty(who)) return 'ok';
    const r = this.rng.next();
    const u = this.profile.unknownPush;
    if (r < u / 2) return 'unknown_before';
    if (r < u) return 'unknown_after';
    if (trunk && r < u + this.profile.rejectTrunk) return 'rejected';
    return 'ok';
  }

  /** What happens to one hub request from `proc`. */
  private hubFate(proc: Proc): 'ok' | 'drop_request' | 'drop_response' | 'crash_after' {
    if (proc.kind !== 'lander' || this.phase !== 'faults') return 'ok';
    const r = this.rng.next();
    const { dropRequest: a, dropResponse: b, crashAfterEffect: c } = this.profile;
    if (r < a) return 'drop_request';
    if (r < a + b) return 'drop_response';
    if (r < a + b + c) return 'crash_after';
    return 'ok';
  }

  /** The Faults port of a lander process: a fault point kills it (SIGKILL), sometimes. */
  faultsFor(proc: Proc): Faults {
    return {
      at: (point, landingId) => {
        if (this.phase !== 'faults' || !this.rng.chance(this.profile.faultPoint)) return;
        this.kill(proc, `fault point ${point}${landingId ? ` (${landingId})` : ''}`);
        return new Promise<void>(() => {});
      },
    };
  }

  /** The world's own events during the fault phase: kills, freezes, foreign pushes, rewinds, a recreated database. */
  private async faultLoop(): Promise<void> {
    const w = this.world;
    while (this.phase === 'faults') {
      await this.wait(w, Math.round(-Math.log(1 - this.rng.next()) * this.profile.eventMeanMs) + 1);
      if (this.phase !== 'faults') break;
      await this.call<void>(w, 'world.event', (s) => {
        this.worldEvent();
        s.resolve();
      });
    }
  }

  private worldEvent(): void {
    const e = this.profile.events;
    const total = e.kill + e.freeze + e.foreign + e.rewind + e.recreate;
    let r = this.rng.next() * total;
    // The lander stalled for a recreated database is left alone: what it does when it wakes is the point.
    const alive = this.machines.map((m) => m.proc).filter((p): p is LanderProc => p !== null && !p.proc.dead && p.proc !== this.wakeOnReuse?.proc);
    if ((r -= e.kill) < 0) {
      if (alive.length > 0) this.kill(this.rng.pick(alive).proc, 'killed');
    } else if ((r -= e.freeze) < 0) {
      if (alive.length > 0) {
        const p = this.rng.pick(alive).proc;
        this.freeze(p, this.rng.chance(0.7) ? this.rng.int(LEASE_TTL_MS + 1_000, 4 * LEASE_TTL_MS) : this.rng.int(2_000, 30_000), !this.rng.chance(0.3));
      }
    } else if ((r -= e.foreign) < 0) {
      this.foreignPush();
    } else if ((r -= e.rewind) < 0) {
      this.rewind();
    } else {
      this.recreate();
    }
  }

  /** The hub comes back on a new database (a new epoch): the queue is gone; landers and agents start over against it. */
  private recreate(): void {
    if (this.recreations >= 2) return;
    this.recreations++;
    this.note('RECREATE the hub database');
    this.count('recreations');
    this.newHub();
  }

  private foreignPush(): void {
    const tip = this.remote.tip()!;
    const files: Record<string, string> = { ...this.db.entries(this.db.get(tip).tree) };
    const n = this.count('foreign');
    if (this.rng.chance(0.5)) files[`s/${this.rng.int(0, 2)}.txt`] = `foreign#${n}`;
    else files[`f/${n}.txt`] = `foreign#${n}`;
    const sha = this.db.commit({
      tree: this.db.tree(files),
      parent: tip,
      message: `pushed outside the queue ${n}`,
      author: { name: 'Human', email: 'human@example.com', date: `${Math.floor(this.time / 1000)} +0000` },
      committer: { name: 'Human', email: 'human@example.com' },
      time: this.time,
    });
    this.remote.setTrunk(sha);
    this.note(`FOREIGN push ${sha.slice(0, 8)}`);
    this.dirty = true;
  }

  private rewind(): void {
    const chain = this.db.chain(this.remote.tip()!);
    const k = Math.min(chain.length - 1, this.rng.int(1, 2));
    if (k < 1) return;
    const target = chain[k]!;
    for (const c of chain.slice(0, k)) this.rewound.add(c);
    this.rewinds.push({ target, at: this.time });
    this.lastRewind = target;
    this.remote.setTrunk(target);
    this.count('rewinds');
    this.note(`REWIND trunk to ${target.slice(0, 8)}`);
    this.dirty = true;
  }

  // ------------------------------------------------------------ the hub as ports

  /** A hub call by `proc` as one step; lander requests may be dropped (before or after they take effect). */
  hubCall<T>(proc: Proc, label: string, fn: (hub: Hub) => T): Promise<T> {
    return this.call<T>(proc, `hub.${label}`, (s) => {
      const fate = this.hubFate(proc);
      if (fate === 'drop_request') return s.reject(hubUnavailable(label));
      let value: T;
      try {
        value = clone(fn(this.hub));
      } catch (err) {
        if (!(err instanceof HubError)) {
          this.fail(`the hub threw on ${label} from ${proc.name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          return s.reject(err);
        }
        return s.reject(fate === 'drop_response' ? hubUnavailable(label) : new HubCallError(err.code, err.status, err.message, err.details));
      } finally {
        this.afterHubCall();
      }
      if (fate === 'drop_response') return s.reject(hubUnavailable(label));
      if (fate === 'crash_after') return this.kill(proc, `crashed right after ${label} took effect`);
      s.resolve(value);
    });
  }

  /** GET /events long-poll: answers once a matching event exists, the wait is over, or the signal aborts. */
  private longPoll(proc: Proc, agent: string, q: EventsQuery): Promise<EventsResult> {
    if (proc.dead) return new Promise<EventsResult>(() => {});
    const hubAtCall = this.hub;
    const since = q.since ?? hubAtCall.latestSeq(P);
    const types = q.types;
    let checked = -1;
    let has = false;
    const ready = () => {
      if (q.signal?.aborted) return true;
      if (checked !== this.eventVersion) {
        checked = this.eventVersion;
        has = this.hub.readEvents(P, agent, since, { types, limit: 1 }).events.length > 0;
      }
      return has;
    };
    return new Promise<EventsResult>((resolve, reject) => {
      this.ops.push({
        proc,
        label: 'hub.events',
        at: this.time,
        deadline: this.time + Math.max(0, q.waitMs ?? 0),
        ready,
        run: () => {
          if (q.signal?.aborted) return reject(new HubCallError('aborted', null, 'GET /events was aborted'));
          if (this.hubFate(proc) === 'drop_request') return reject(hubUnavailable('events'));
          const r = this.hub.readEvents(P, agent, since, { types });
          resolve(clone({ events: r.events, seq: this.hub.latestSeq(P), next_since: r.next_since, epoch: this.hub.epoch }));
        },
      });
    });
  }

  /** The HubPort of a lander process (in-process, JSON on the way in and out, like the wire). */
  hubPort(proc: Proc, agent: string): HubPort {
    const auth: HubAuth = { lander: true, approver: null };
    const c = <T>(label: string, fn: (hub: Hub) => T) => this.hubCall(proc, label, fn);
    return {
      claim: (req) => c('claim', (h) => h.claim(P, agent, clone(req), auth)),
      getClaim: (id) => c('getClaim', (h) => h.getClaim(P, id)),
      heartbeat: (req = {}) => c('heartbeat', (h) => h.heartbeat(P, agent, clone(req))),
      release: (req) => c('release', (h) => h.release(P, agent, clone(req))),
      next: (req) => c('next', (h) => h.nextLanding(P, agent, clone(req), auth)),
      admit: (id, req) => c('admit', (h) => h.admitLanding(P, agent, id, clone(req), auth)),
      advance: (id, req) => c('advance', (h) => h.advanceLanding(P, agent, id, clone(req), auth)),
      resolve: (id, req) => c('resolve', (h) => h.resolveLanding(P, agent, id, clone(req), auth)),
      reportTrunk: (req) => c('reportTrunk', (h) => h.reportTrunk(P, agent, clone(req), auth)),
      pause: (req) => c('pause', (h) => h.pauseLander(P, agent, clone(req), auth)),
      lander: () => c('lander', (h) => h.landerStatus(P)),
      landings: (f = {}) => c('landings', (h) => h.listLandings(P, { statuses: f.status, agent: f.agent, task_id: f.task, limit: f.limit })),
      landing: (id) => c('landing', (h) => h.getLanding(P, id)),
      tasks: () => c('tasks', (h) => h.listTasks(P)),
      decisions: (limit = 20) => c('decisions', (h) => h.listDecisions(P, limit)),
      post: (to, body) => c('post', (h) => h.post(P, agent, { to, body })),
      events: (q = {}) => this.longPoll(proc, agent, q),
      status: () => c('status', (h) => h.status(P, agent)),
    };
  }

  /** Every method of `impl` as a scheduled step of `proc`. */
  scheduled<T extends object>(proc: Proc, prefix: string, impl: T): T {
    const out: Record<string, unknown> = {};
    const names = new Set<string>(Object.keys(impl));
    for (let p = Object.getPrototypeOf(impl); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor') names.add(k);
    for (const k of names) {
      const fn = (impl as Record<string, unknown>)[k];
      if (typeof fn !== 'function') continue;
      out[k] = (...args: unknown[]) =>
        this.call(proc, `${prefix}.${k}`, (s) => {
          const crash = (k === 'pushTrunk' || k === 'pushRef') && this.faulty(proc.name) && this.rng.chance(this.profile.crashAfterEffect);
          (fn as (...a: unknown[]) => Promise<unknown>).apply(impl, args).then(
            (v) => (crash ? this.kill(proc, `crashed right after ${k}`) : s.resolve(v)),
            (e) => s.reject(e),
          );
        });
    }
    return out as T;
  }

  // ------------------------------------------------------------ observation

  private onHubEvent(hub: Hub, e: HubEvent): void {
    this.eventVersion++;
    this.dirty = true;
    if (e.type !== 'landing.updated') return;
    const id = e.data.landing_id as string;
    // The stalled lander of a recreated database wakes when the new database's landing of the same id (another
    // change) is checking: its stale push then lands inside that attempt's trailer search window (from first_base).
    const w = this.wakeOnReuse;
    if (w && hub === this.hub && hub.epoch !== w.epoch && id === w.id && e.data.phase === 'checking' && hub.store.getLanding(P, id)?.commit !== w.commit) {
      this.wakeOnReuse = null;
      if (w.proc.frozenSince !== null) {
        w.proc.frozenUntil = this.time;
        this.note(`WAKE ${w.proc.name}: ${id} of the new database is checking`);
      }
    }
    if (e.data.phase !== 'pushing') return;
    const l = hub.store.getLanding(P, id);
    if (l?.candidate) {
      const key = `${hub.epoch}|${id}|${l.candidate}`;
      if (!this.recordedPushing.has(key)) this.recordedPushing.set(key, this.time);
    }
    if (hub !== this.hub || this.phase !== 'faults' || !l?.lander) return;
    const stalled = this.procs.find((x) => x.name === l.lander && !x.dead);
    if (!stalled) return;
    // The database is recreated right after a landing entered pushing, while its lander stalls (it pushes once it
    // wakes, its clocks having stopped): the new database's landing of the same id must not take that commit for its own.
    // The mutation guard recreates it under the first landing, so the new database's L-1 (another change, with
    // trunk still where the stalled push expects it) is the one whose trailer search the stale push lands in.
    const recreate = this.mutation === 'id_only_trailers' ? (id === 'L-1' ? 1 : 0) : 0.01;
    if (this.recreations < 2 && this.wakeOnReuse === null && this.rng.chance(recreate)) {
      this.freeze(stalled, this.rng.int(3 * 60_000, 6 * 60_000));
      this.wakeOnReuse = { proc: stalled, id, epoch: hub.epoch, commit: l.commit };
      this.stalledCommit = l.commit;
      this.note(`STALL ${stalled.name} with ${id} in pushing; the database is recreated`);
      void this.call<void>(this.world, 'world.recreate', (s) => {
        this.recreate();
        s.resolve();
      });
      return;
    }
    // The lander stalls right after its write-ahead, before its push: briefly (an agent may cancel meanwhile), or
    // past its lease (in doubt: another lander resolves it while this one, its clocks stopped, still means to push).
    if (this.rng.chance(this.profile.freezeAtPushing)) {
      const long = this.mutation === 'requeue_pushing_on_lease_loss' || this.rng.chance(0.5);
      this.freeze(stalled, long ? this.rng.int(LEASE_TTL_MS + 1_000, 4 * LEASE_TTL_MS) : this.rng.int(1_000, 30_000), !this.rng.chance(0.3));
    }
  }

  private afterHubCall(): void {
    if (this.mutation !== 'requeue_pushing_on_lease_loss') return;
    // The mutation: the lease's end requeues a landing even in pushing (T9 where T10 belongs).
    const store = this.hub.store;
    for (const l of store.listLandings(P, { statuses: ['running'], order: 'queue' })) {
      if (l.phase !== 'pushing' || !l.in_doubt) continue;
      store.updateLanding(P, l.id, {
        status: 'queued',
        phase: null,
        lander: null,
        lease_claim_id: null,
        deadline_at: null,
        in_doubt: false,
        retries: { ...l.retries, lander_lost: l.retries.lander_lost + 1 },
        updated_at: this.time,
      });
      this.dirty = true;
    }
  }

  private onTrunkUpdate(e: { who: string; prev: string | null; next: string; expected: string }): void {
    this.dirty = true;
    this.count('trunk_pushes');
    const c = this.db.get(e.next);
    // I1: a lander moves trunk only by a fast-forward from the tip it expected, to a candidate whose (parent, tree) passed the checks.
    if (e.prev !== c.parent) this.fail(`I1: ${e.who} moved trunk from ${e.prev?.slice(0, 8)} to ${e.next.slice(0, 8)}, whose parent is ${c.parent?.slice(0, 8)} (not a fast-forward from the expected tip)`);
    if (!this.passed.has(`${c.parent}:${c.tree}`)) this.fail(`I1: ${e.who} pushed ${e.next.slice(0, 8)}, whose (parent, tree) never passed the checks`);
    this.note(`TRUNK ${e.prev?.slice(0, 8)} → ${e.next.slice(0, 8)} by ${e.who} (${c.trailers.landing ?? 'no landing'})`);
  }

  fail(msg: string): void {
    if (!this.violation) {
      this.violation = msg;
      this.note(`VIOLATION ${msg}`);
    }
  }

  note(line: string): void {
    this.pushTail(`${this.time - T_START} ${line}`);
  }

  private pushTail(line: string): void {
    this.tailLines.push(line);
    if (!this.o.fullTrace && this.tailLines.length > 400) this.tailLines.splice(0, this.tailLines.length - 300);
  }

  count(name: string): number {
    return (this.stats[name] = (this.stats[name] ?? 0) + 1);
  }

  /** The commit on trunk whose trailers say it is `l` of the hub with `epoch`, if any. */
  private identityOnTrunk(epoch: string, l: Landing, chain: readonly string[]): string | null {
    const key = `${P}/${l.id}`;
    for (const c of chain) {
      const t = this.db.get(c).trailers;
      if (t.landing === key && t.hub === epoch && t.source === l.commit) return c;
    }
    return null;
  }

  /** The documented exception (§2.2.7): a recorded candidate pushed by a stale lander after trunk was rewound to its exact base. */
  private excepted(epoch: string, id: string, c: string): boolean {
    const t = this.recordedPushing.get(`${epoch}|${id}|${c}`);
    const parent = this.db.get(c).parent;
    return t !== undefined && this.rewinds.some((r) => r.target === parent && r.at >= t);
  }

  /** The invariants of design §5.2, after every step that changed something. */
  private checkState(): void {
    if (this.violation) return;
    const tip = this.remote.tip()!;
    const chain = this.db.chain(tip);
    const onTrunk = new Set(chain);
    // I3: no landing's change is on trunk twice.
    const seen = new Set<string>();
    for (const c of chain) {
      const t = this.db.get(c).trailers;
      if (!t.landing || !t.hub || !t.source) continue;
      const key = `${t.hub}|${t.landing}|${t.source}`;
      if (seen.has(key)) return this.fail(`I3: ${t.landing} (hub ${t.hub.slice(0, 8)}) is on trunk twice`);
      seen.add(key);
    }
    for (const hub of [this.hub, ...this.oldHubs]) {
      const current = hub === this.hub;
      const all = hub.store.listLandings(P, { order: 'queue' });
      if (current && all.filter((l) => l.status === 'running').length > 1) return this.fail('more than one running landing');
      for (const l of all) {
        if (l.status === 'landed') {
          if (!l.trunk_sha) return this.fail(`${l.id} is landed without a trunk_sha`);
          if (!onTrunk.has(l.trunk_sha) && !this.rewound.has(l.trunk_sha)) return this.fail(`${l.id} is landed as ${l.trunk_sha.slice(0, 8)}, which is not on trunk`);
          const marker = l.commit ? this.markers.get(l.commit) : undefined;
          if (marker && this.db.commits.has(l.trunk_sha) && this.db.entries(this.db.get(l.trunk_sha).tree)[marker] === undefined) {
            return this.fail(`${l.id} is landed as ${l.trunk_sha.slice(0, 8)}, which doesn't have its change (${marker})`);
          }
        } else if (l.status === 'failed' || l.status === 'cancelled' || l.status === 'superseded') {
          const c = this.identityOnTrunk(hub.epoch, l, chain);
          if (c) {
            if (!this.excepted(hub.epoch, l.id, c)) return this.fail(`${l.id} is ${l.status} but on trunk as ${c.slice(0, 8)}`);
            if (current) this.mustReconcile.add(`${hub.epoch}|${l.id}`);
          }
        }
      }
      if (!current) continue;
      // Holds are live exactly while their landing is.
      const byId = new Map(all.map((l) => [l.id, l]));
      const holds = hub.store.listClaims(P, { statuses: ['active'] }).filter((c) => c.landing_id !== null);
      for (const h of holds) {
        const l = byId.get(h.landing_id!);
        if (!l || !LIVE.includes(l.status)) return this.fail(`hold ${h.id} of ${h.landing_id} is active, but the landing is ${l?.status ?? 'gone'}`);
      }
      for (const l of all) {
        if (LIVE.includes(l.status) && l.files.length > 0 && !holds.some((h) => h.landing_id === l.id)) return this.fail(`${l.id} is ${l.status} with files but holds nothing`);
      }
    }
  }

  /** After the faults stop: is everything settled, with the hub and trunk agreeing? */
  private settled(): boolean {
    const store = this.hub.store;
    if (store.listLandings(P, { statuses: LIVE, order: 'queue', limit: 1 }).length > 0) return false;
    return store.getLanderControl(P).trunk?.sha === this.remote.tip();
  }

  /** The end state: what liveness requires besides `settled`. */
  private finalChecks(): void {
    const hub = this.hub;
    const chain = this.db.chain(this.remote.tip()!);
    for (const c of chain) {
      const t = this.db.get(c).trailers;
      if (t.hub !== hub.epoch || !t.landing?.startsWith(`${P}/`)) continue;
      const l = hub.store.getLanding(P, t.landing.slice(P.length + 1));
      if (l && l.commit === t.source && l.status !== 'landed') return this.fail(`liveness: ${l.id} is on trunk as ${c.slice(0, 8)} but ${l.status} at the hub`);
    }
    for (const key of this.mustReconcile) {
      const [epoch, id] = key.split('|');
      if (epoch !== hub.epoch) continue;
      const l = hub.store.getLanding(P, id!);
      if (!l || l.status !== 'landed' || !l.reconciled) return this.fail(`liveness: ${id} got onto trunk after it ended and was never reconciled`);
    }
  }

  // ------------------------------------------------------------ the run

  async run(): Promise<SimOutcome> {
    for (let i = 0; i < this.profile.machines; i++) this.machines.push({ name: String.fromCharCode(65 + i), mirror: new Place(this.db), proc: null, gen: 0 });
    for (const m of this.machines) this.startLander(m);
    const names = ['maya', 'sam', 'ana'];
    for (let i = 0; i < this.profile.agents; i++) this.agents.push(new Agent(this, names[i]!));
    for (const a of this.agents) void a.run().catch((err) => this.fail(`agent ${a.agent} threw: ${String(err)}`));
    void new Human(this).run().catch((err) => this.fail(`the human threw: ${String(err)}`));
    void this.sweeper();
    void this.faultLoop();

    const faultsEnd = this.time + this.profile.faultPhaseMs;
    await this.runUntil(() => this.agents.every((a) => a.idle()) || this.time >= faultsEnd, 40_000, faultsEnd);
    this.phase = 'liveness';
    this.note('FAULTS STOP');
    // Frozen processes wake, dead landers come back: the system must now finish on its own.
    const ok = await this.runUntil(() => this.agents.every((a) => a.finished) && this.settled(), 60_000, this.time + 8 * 60 * 60_000);
    if (!this.violation) {
      if (!ok) {
        const live = this.hub.store.listLandings(P, { statuses: LIVE, order: 'queue' }).map((l) => `${l.id} ${l.status}${l.phase ? `/${l.phase}` : ''}${l.in_doubt ? ' in doubt' : ''}`);
        const control = this.hub.store.getLanderControl(P);
        this.fail(`liveness: not settled after the faults stopped (live: ${live.join(', ') || 'none'}; hub trunk ${control.trunk?.sha.slice(0, 8) ?? 'none'} vs ${this.remote.tip()!.slice(0, 8)}; paused ${control.paused?.reason ?? 'no'})`);
      } else this.finalChecks();
    }
    this.shutdown();
    const all = this.hub.store.listLandings(P, { order: 'queue' });
    for (const l of all) this.count(`end.${l.status}${l.failure ? `.${l.failure.code}` : ''}`);
    return {
      seed: this.o.seed,
      mutation: this.mutation,
      violation: this.violation,
      steps: this.steps,
      simMs: this.time - T_START,
      landings: all.length,
      landed: all.filter((l) => l.status === 'landed').length,
      digest: this.trace.digest('hex'),
      tail: this.o.fullTrace ? this.tailLines : this.tailLines.slice(-150),
      stats: { ...this.stats },
    };
  }

  /** Ends every process (their lease timers are fake timers; they must not outlive the seed). */
  private shutdown(): void {
    for (const m of this.machines) m.proc?.lander.lease.abandon();
    for (const p of this.procs) p.dead = true;
    this.ops = [];
  }

  private async sweeper(): Promise<void> {
    for (;;) {
      await this.wait(this.world, 15_000);
      await this.hubCall(this.world, 'sweep', (h) => h.sweep());
    }
  }

  startLander(m: Machine): void {
    m.gen++;
    m.proc = new LanderProc(this, m);
  }

  /** A lander that died comes back on its machine after a while (systemd Restart=always). */
  restartLater(m: Machine): void {
    void (async () => {
      await this.wait(this.world, this.rng.int(2_000, 60_000));
      await this.call<void>(this.world, 'world.restart', (s) => {
        this.startLander(m);
        s.resolve();
      });
    })();
  }

  logFor(proc: Proc): (line: string) => void {
    return (line) => {
      this.note(`${proc.name}: ${line}`);
      for (const [name, re] of COVERAGE) if (re.test(line)) this.count(`cov.${name}`);
      // An exception the lander didn't expect is a bug (in the lander, or in these fakes), never a fault the world injected.
      const expected = /hub unreachable|unable to access the remote|was aborted/.test(line);
      if (!expected && /^(?:L-\d+: lander error|L-\d+: resolving it failed|startup recovery: |startup trunk report: |gc: (?!delet)|admission: |next: |trunk watch: )/.test(line)) {
        this.fail(`${proc.name} logged an unexpected error: ${line.slice(0, 2000)}`);
      }
    };
  }
}

// ------------------------------------------------------------ a lander process

export class LanderProc {
  readonly proc: Proc;
  readonly lander: Lander;

  constructor(
    readonly w: World,
    readonly m: Machine,
  ) {
    const id = `lander/sim${m.name}-${m.gen}-${w.rng.hex(4)}`;
    const proc = (this.proc = w.newProc(id, 'lander'));
    const raw = fakeGitPort({ remote: w.remote, mirror: m.mirror, who: id, now: () => proc.now(), idOnlyTrailers: () => w.mutation === 'id_only_trailers' });
    const git = w.scheduled(proc, 'git', raw) as GitPort;
    const checks: ChecksPort = new FakeChecks({ db: w.db, clock: proc.clock, duration: () => w.rng.int(2_000, 25_000), passed: w.passed, onRun: () => w.count('check_runs') });
    const base = w.hubPort(proc, id);
    const hub: HubPort =
      w.mutation === 'push_before_pushing'
        ? {
            ...base,
            // The mutation: the trunk push happens before the hub records `pushing`.
            advance: async (landingId, req) => {
              if (req.to === 'running' && req.phase === 'pushing') {
                await git.pushTrunk({ trunk: 'main', candidate: req.candidate, expected: req.trunk_base }).catch(() => undefined);
              }
              return base.advance(landingId, req);
            },
          }
        : base;
    const resolver: ResolverPort | null = w.profile.resolver ? w.scheduled(proc, 'resolver', new StubResolver(w, git)) : null;
    this.lander = new Lander({
      hub,
      git,
      checks,
      resolver,
      clock: proc.clock,
      faults: w.faultsFor(proc),
      log: w.logFor(proc),
      agent: id,
      project: P,
      committer: LANDER_ID,
      drivers: [],
      trunk: 'main',
      leaseTtlMs: LEASE_TTL_MS,
      heartbeatMs: HEARTBEAT_MS,
      timings: { pollTrunkMs: POLL_MS, remoteBackoffMs: 30_000, pushRetryMs: [1_000, 2_000, 4_000, 8_000, 16_000], hubRetryMs: [500, 1_000, 2_000, 4_000], stopResolveMs: 60_000 },
      workdir: null,
      host: `sim${m.name}`,
      gcIntervalMs: 60 * 60_000,
    });
    proc.onKill = () => {
      this.lander.lease.abandon();
      if (m.proc === this) w.restartLater(m);
    };
    void this.lander.run().then(
      () => {
        if (!proc.dead) w.fail(`${id}: Lander.run() returned without being stopped`);
      },
      (err: unknown) => w.fail(`${id}: Lander.run() threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`),
    );
  }
}

/** The stub resolver (design §5 "The stub resolver", union mode): each content conflict outside migrations/ becomes trunk's side & incoming's, sometimes it declines. */
class StubResolver implements ResolverPort {
  constructor(
    private readonly w: World,
    private readonly git: GitPort,
  ) {}

  async resolve(req: ResolveRequest): Promise<ResolveResult> {
    const { w } = this;
    w.count('resolver_calls');
    const blobs: Array<{ path: string; mode: string; content: string }> = [];
    const unresolved: ResolveResult['unresolved'] = [];
    for (const c of req.conflicts) {
      const eligible = c.kind === 'content' && !c.path.startsWith('migrations/') && c.stages[2] !== undefined && c.stages[3] !== undefined;
      if (eligible && w.rng.chance(0.8)) {
        blobs.push({ path: c.path, mode: c.mode ?? '100644', content: `${w.db.blobs.get(c.stages[2]!)}&${w.db.blobs.get(c.stages[3]!)}` });
      } else unresolved.push({ path: c.path, eligible, explanation: eligible ? 'declined' : 'not eligible' });
    }
    const tree = blobs.length > 0 ? await this.git.spliceTree(req.tree, blobs) : req.tree;
    const resolved = blobs.map((b) => b.path);
    return {
      tree,
      resolved,
      unresolved,
      report: { model: 'stub', outcome: resolved.length > 0 ? 'resolved' : 'cannot_resolve', files: resolved, novel_lines: 0, input_tokens: 0, output_tokens: 0, explanations: {} },
      requirement: null,
      warnings: [],
      trunkSide: [],
      suggestions: {},
    };
  }
}

// ------------------------------------------------------------ an agent

interface Live {
  id: string;
  epoch: string;
  commit: string;
  task: string | null;
}

class Agent {
  readonly agent: string;
  readonly proc: Proc;
  private n = 0;
  private items: number;
  private live: Live[] = [];
  private pending: { commit: string; task: string | null; tries: number } | null = null;
  private last: string | null = null;
  finished = false;

  constructor(
    private readonly w: World,
    readonly name: string,
  ) {
    this.agent = `${name}/claude-1`;
    this.proc = w.newProc(this.agent, 'agent');
    this.items = w.profile.items;
  }

  /** Nothing left to start or follow (the fault phase may end). */
  idle(): boolean {
    return this.items === 0 && this.pending === null && this.live.length === 0;
  }

  async run(): Promise<void> {
    const { w } = this;
    for (;;) {
      await w.sleep(this.proc, w.rng.int(2_000, 12_000));
      // Once the faults stop, the agents stop too: what they landed must finish on its own.
      if (w.phase === 'liveness') {
        this.finished = true;
        return;
      }
      await this.act();
    }
  }

  private hub<T>(label: string, fn: (hub: Hub) => T): Promise<T> {
    return this.w.hubCall(this.proc, `agent.${label}`, fn);
  }

  private async act(): Promise<void> {
    const { w } = this;
    const epoch = w.hub.epoch;
    // The queue of a database that is gone: land again, or start over.
    for (const l of this.live.filter((x) => x.epoch !== epoch)) {
      this.live = this.live.filter((x) => x !== l);
      // The id_only_trailers guard: everyone lands again at once, except the change whose lander stalled (its author
      // waits on it), so the new database's L-1 is another change.
      const again = w.mutation === 'id_only_trailers' ? (l.commit === w.stalledCommit ? 0 : 1) : 0.5;
      if (!this.pending && w.rng.chance(again)) this.pending = { commit: l.commit, task: null, tries: 0 };
    }
    if (this.pending) return this.tryLand();
    for (const l of [...this.live]) {
      // What landing_status would say (read from the store: the agent's reads are not what is under test).
      const L = w.hub.store.getLanding(P, l.id);
      if (!L || L.commit !== l.commit) {
        this.live = this.live.filter((x) => x !== l);
        continue;
      }
      if (L.status === 'landed' || L.status === 'cancelled' || L.status === 'superseded') {
        this.live = this.live.filter((x) => x !== l);
      } else if (L.status === 'failed') {
        this.live = this.live.filter((x) => x !== l);
        if (w.phase === 'faults') this.react(L, l);
      } else if (w.phase === 'faults') {
        const r = w.rng.next();
        const cancel = L.status === 'running' && L.phase === 'pushing' ? w.profile.cancelPushing : L.retries.lander_lost > 0 ? w.profile.cancelLost : w.profile.cancel;
        if (r < cancel) await this.cancel(l);
        else if (r < cancel + w.profile.supersede && !this.pending) this.pending = { commit: this.work(l.commit), task: l.task, tries: 0 };
      }
      if (this.pending) return this.tryLand();
    }
    if (w.phase !== 'faults' || this.items === 0 || this.live.length >= 2) return;
    if (this.live.length === 1 && !w.rng.chance(w.profile.stack)) return;
    this.items--;
    const base = this.live.length === 1 ? this.live[0]!.commit : this.last && w.rng.chance(w.profile.stack) ? this.last : w.remote.tip()!;
    const commit = this.work(base);
    let task: string | null = null;
    if (w.rng.chance(0.6)) {
      task = await this.hub('task', (h) => {
        const t = h.createTask(P, this.agent, { title: `work ${this.n}` });
        h.takeTask(P, this.agent, t.id);
        return t.id;
      }).catch(() => null);
    }
    this.pending = { commit, task, tries: 0 };
    return this.tryLand();
  }

  /** A failed landing: fix a failing check and land again (a retry), or land the same commit again, or give up on it. */
  private react(L: Landing, l: Live): void {
    const { w } = this;
    const code = L.failure?.code;
    const tree = w.db.entries(w.db.get(l.commit).tree);
    if ((code === 'checks_failed' || code === 'resolver_failed') && tree[`fail/${this.name}.txt`] !== undefined) {
      this.pending = { commit: this.work(l.commit, true), task: l.task, tries: 0 };
    } else if (code && ['lander_lost', 'trunk_busy', 'lander_stuck', 'lander_error', 'not_pushed', 'claim_conflict'].includes(code) && w.rng.chance(0.5)) {
      this.pending = { commit: l.commit, task: l.task, tries: 0 };
    }
  }

  /** A new commit on `base`: its own marker, maybe a shared file, a protected file or a failing check; `fix` removes the failure. */
  private work(base: string, fix = false): string {
    const { w } = this;
    const n = ++this.n;
    const files: Record<string, string> = { ...w.db.entries(w.db.get(base).tree) };
    const marker = `m/${this.name}/${n}.txt`;
    files[marker] = `${this.agent}#${n}`;
    if (fix) delete files[`fail/${this.name}.txt`];
    else {
      if (w.rng.chance(0.5)) files[`s/${w.rng.int(0, 2)}.txt`] = `${this.agent}#${n}`;
      if (w.rng.chance(w.profile.protectedRate)) files[`migrations/${w.rng.int(0, 1)}.sql`] = `${this.agent}#${n}`;
      if (w.rng.chance(w.profile.failRate)) files[`fail/${this.name}.txt`] = FAIL_MARKER;
    }
    const sha = w.db.commit({
      tree: w.db.tree(files as Tree),
      parent: base,
      message: `${this.agent}: work ${n}`,
      author: { name: this.name, email: `${this.name}@example.com`, date: `${Math.floor(w.time / 1000)} +0000` },
      committer: { name: this.name, email: `${this.name}@example.com` },
      time: w.time,
    });
    w.markers.set(sha, marker);
    this.last = sha;
    return sha;
  }

  private async cancel(l: Live): Promise<void> {
    const { w } = this;
    await this.hub('cancel', (h) => {
      if (w.mutation === 'cancel_in_pushing') {
        const row = h.store.getLanding(P, l.id);
        // The mutation: cancel is allowed in pushing.
        if (row?.status === 'running' && row.phase === 'pushing') h.store.updateLanding(P, l.id, { phase: 'checking', updated_at: w.time });
      }
      return h.cancelLanding(P, this.agent, l.id);
    }).catch(() => undefined);
  }

  /** As `land` does: push the land ref (never forced), then POST /land {queue: true}. */
  private async tryLand(): Promise<void> {
    const { w } = this;
    const p = this.pending!;
    await w.call<void>(this.proc, 'agent.push', (s) => {
      w.remote.receive(p.commit);
      if (!w.remote.refs.has(landRef('refs/agenthub/', p.commit))) w.remote.refs.set(landRef('refs/agenthub/', p.commit), p.commit);
      s.resolve();
    });
    const tip = w.remote.tip()!;
    const mb = w.db.mergeBase(tip, p.commit) ?? tip;
    const a = w.db.entries(w.db.get(mb).tree);
    const b = w.db.entries(w.db.get(p.commit).tree);
    const files = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort();
    try {
      const r = await this.hub('land', (h) => ({ ...h.land(P, this.agent, { queue: true, commit: p.commit, task_id: p.task ?? undefined, branch: 'work', summary: `work by ${this.agent}`, files }), epoch: h.epoch }));
      this.pending = null;
      if (!this.live.some((x) => x.id === r.landing.id && x.epoch === r.epoch)) this.live.push({ id: r.landing.id, epoch: r.epoch, commit: p.commit, task: p.task });
      this.live = this.live.filter((x) => !r.superseded.includes(x.id) || x.epoch !== r.epoch);
      w.count('lands');
    } catch (err) {
      const code = err instanceof HubCallError ? err.code : 'error';
      if (code === 'claim_conflict' || code === 'too_late' || code === 'task_landing') {
        if (++p.tries > 6) this.pending = null;
      } else if (code === 'not_found' || code === 'task_closed' || code === 'forbidden' || code === 'task_blocked') {
        p.task = null;
        if (++p.tries > 6) this.pending = null;
      } else this.pending = null;
    }
  }
}

// ------------------------------------------------------------ the human

class Human {
  readonly proc: Proc;
  constructor(private readonly w: World) {
    this.proc = w.newProc('boss/human', 'human');
  }

  private hub<T>(label: string, fn: (hub: Hub) => T): Promise<T> {
    return this.w.hubCall(this.proc, `human.${label}`, fn);
  }

  async run(): Promise<void> {
    const { w } = this;
    for (;;) {
      await w.sleep(this.proc, w.rng.int(5_000, 30_000));
      // What `hub landings` shows the human (read from the store; only the human's writes go through the hub).
      const control = w.hub.store.getLanderControl(P);
      if (control.paused) {
        const accept = control.paused.reason === 'trunk_rewritten' ? (w.lastRewind ?? w.remote.tip()!) : undefined;
        await this.hub('resume', (h) => h.resumeLander(P, accept ? { accept_trunk: accept } : {}, APPROVER)).then(
          () => {
            if (accept) w.lastRewind = null;
          },
          () => undefined,
        );
      }
      const waiting = w.hub.store.listLandings(P, { statuses: LIVE, order: 'queue' });
      for (const l of waiting) {
        for (const r of l.approval) {
          if (w.phase === 'faults' && w.rng.chance(0.03)) {
            await this.hub('reject', (h) => h.rejectLanding(P, l.id, { reason: 'not like this' }, APPROVER)).catch(() => undefined);
            break;
          }
          if (w.rng.chance(0.8)) await this.hub('approve', (h) => h.approveLanding(P, l.id, { kind: r.kind, digest: r.digest, note: 'ok' }, APPROVER)).catch(() => undefined);
        }
      }
    }
  }
}

/** Runs one seed. */
export function simulate(o: SimOptions): Promise<SimOutcome> {
  return new World(o).run();
}
