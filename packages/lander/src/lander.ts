// The lander process (design §2.2.1, §2.2.3): one per project per machine.
// It claims the lease (or stands by), runs startup recovery and GC, then the
// admission loop and the attempt loop side by side while the lease's own
// timer heartbeats. Losing the lease (not_lander) stops the attempt (its
// check is killed, nothing is pushed) and goes back to claiming. SIGTERM stops
// taking work, sends a running landing back to the queue (lander_stopping),
// resolves one left in pushing first (bounded), and releases the lease.

import type { StructuralDriver } from '@agenthub/gitops';
import type { Landing, LanderControl } from '@agenthub/hub/protocol';
import { Admission } from './admission.js';
import { AttemptStale, DEFAULT_TIMINGS, HubUnavailable, hubWrite, LeaseLost, type LanderContext, type Timings } from './context.js';
import { collectGarbage } from './gc.js';
import { Lease } from './lease.js';
import { runAttempt, type AttemptOutcome } from './pipeline.js';
import { noFaults, systemClock, type ChecksPort, type Clock, type Faults, type GitPort, type HubPort, type ResolverPort } from './ports.js';
import { resolveInDoubt, startupRecovery } from './recovery.js';
import { syncTrunk, watchTrunk } from './trunk.js';

export interface LanderOptions {
  hub: HubPort;
  git: GitPort;
  checks: ChecksPort;
  resolver?: ResolverPort | null;
  clock?: Clock;
  faults?: Faults;
  log?: (line: string) => void;
  /** This process's agent id (landerId()). */
  agent: string;
  project: string;
  committer: { name: string; email: string };
  drivers?: StructuralDriver[];
  /** The trunk branch to start from (the mirror's HEAD); trunk's own land.trunk wins. */
  trunk: string;
  leaseTtlMs: number;
  heartbeatMs?: number;
  timings?: Partial<Timings>;
  /** The workdir (runs/, logs/); null in the simulation. */
  workdir: string | null;
  /** For the lease claim's intent (`lander on <host>`). */
  host?: string;
  /** Default 1 h. */
  gcIntervalMs?: number;
}

/** What one pass of the attempt loop did. */
export type StepResult = AttemptOutcome | { kind: 'idle' };

/** Consecutive lander errors before landing is paused (design §4.5: the workdir is unusable). */
const MAX_LANDER_ERRORS = 3;

export class Lander {
  readonly lease: Lease;
  readonly ctx: LanderContext;
  readonly admission: Admission;
  private readonly stopController = new AbortController();
  private readonly gcIntervalMs: number;
  private readonly workdir: string | null;
  private lastGc = Number.NEGATIVE_INFINITY;
  private control: LanderControl | null = null;
  private landerErrors = 0;
  private since: number | undefined;
  /**
   * The id of a landing this lease left in pushing with its outcome unknown
   * (resolved first at shutdown). Only the id: the copy next handed out
   * predates the attempt (no candidate, no trunk_base yet), so shutdown reads
   * the landing as the hub has it now.
   */
  private inDoubt: string | null = null;
  /** GC and admission rounds take turns on the mirror's land refs (see serially). */
  private mirrorTurn: Promise<unknown> = Promise.resolve();
  private recovered = false;

  constructor(o: LanderOptions) {
    const clock = o.clock ?? systemClock;
    const log = o.log ?? ((line: string) => process.stderr.write(`hub-lander: ${line}\n`));
    this.lease = new Lease({ hub: o.hub, clock, agent: o.agent, ttlMs: o.leaseTtlMs, heartbeatMs: o.heartbeatMs, intent: `lander on ${o.host ?? o.agent.slice('lander/'.length)}`, log });
    this.ctx = {
      hub: o.hub,
      git: o.git,
      checks: o.checks,
      resolver: o.resolver ?? null,
      clock,
      faults: o.faults ?? noFaults,
      log,
      lease: this.lease,
      agent: o.agent,
      project: o.project,
      committer: o.committer,
      drivers: o.drivers ?? [],
      trunk: { branch: o.trunk },
      timings: { ...DEFAULT_TIMINGS, ...(o.timings ?? {}) },
      stopping: this.stopController.signal,
    };
    this.admission = new Admission(this.ctx);
    this.gcIntervalMs = o.gcIntervalMs ?? 60 * 60_000;
    this.workdir = o.workdir;
  }

  get stopping(): boolean {
    return this.stopController.signal.aborted;
  }

  /** SIGTERM: stop taking work; the loops wind down (see run). */
  stop(): void {
    if (!this.stopping) this.ctx.log('stopping: no new work; the running landing goes back to the queue');
    this.stopController.abort();
  }

  /**
   * Runs the lander until stop(). With `once`, admits what is submitted,
   * processes at most one landing (one attempt, or one in-doubt resolution)
   * and returns. Either way the lease is released at the end.
   */
  async run(o: { once?: boolean } = {}): Promise<StepResult | null> {
    let last: StepResult | null = null;
    try {
      while (!this.stopping) {
        if (!(await this.ensureLease())) break;
        if (o.once) {
          await this.admitRound();
          last = await this.step();
          break;
        }
        const tenure = this.lease.signal;
        await Promise.all([this.admissionLoop(tenure), this.attemptLoop(tenure)]);
      }
    } finally {
      await this.shutdown();
    }
    return last;
  }

  /** Holds the lease (claiming, or standing by, as needed); runs startup recovery and GC once it is granted. */
  async ensureLease(): Promise<boolean> {
    if (this.lease.held) return true;
    this.recovered = false;
    if (!(await this.lease.acquire(this.stopController.signal))) return false;
    if (!this.recovered) {
      this.recovered = true;
      await startupRecovery(this.ctx, this.workdir).catch((err: unknown) => this.ctx.log(`startup recovery: ${String(err)}`));
      await this.gc();
      await syncTrunk(this.ctx).catch((err: unknown) => {
        if (!(err instanceof LeaseLost)) this.ctx.log(`startup trunk report: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return this.lease.held;
  }

  /** One admission round (errors are logged; a lost lease ends it). It never overlaps a GC pass. */
  async admitRound(): Promise<number> {
    try {
      return await this.serially(() => this.admission.admitAll(this.stopController.signal));
    } catch (err) {
      if (!(err instanceof LeaseLost)) this.ctx.log(`admission: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /**
   * Runs `fn` once the previous GC pass or admission round is over. GC drops
   * the mirror's land refs of landings that weren't live when it read them;
   * a landing submitted after that read would otherwise lose the ref between
   * admission's fetch and its tip check, and fail with a false not_pushed.
   */
  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mirrorTurn.then(fn, fn);
    this.mirrorTurn = run.catch(() => undefined);
    return run;
  }

  /** One pass of the attempt loop: next, then the attempt, or the in-doubt resolution it asks for. */
  async step(): Promise<StepResult> {
    const { ctx } = this;
    let next;
    try {
      next = await hubWrite(ctx, 'next', () => ctx.hub.next({ lease: ctx.lease.auth() }));
    } catch (err) {
      if (err instanceof LeaseLost) return { kind: 'lost' };
      if (err instanceof HubUnavailable) return { kind: 'hub_unavailable' };
      if (err instanceof AttemptStale) return { kind: 'stale' };
      ctx.log(`next: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: 'hub_unavailable' };
    }
    this.control = next.control;
    this.since = next.seq;
    const landing = next.landing;
    if (!landing) return { kind: 'idle' };
    const out = next.resolve ? await resolveInDoubt(ctx, landing, next.control) : await runAttempt(ctx, landing, next.control);
    this.inDoubt = out.kind === 'in_doubt' ? landing.id : null;
    if (out.kind === 'failed' && out.code === 'lander_error') {
      if (++this.landerErrors >= MAX_LANDER_ERRORS) {
        this.landerErrors = 0;
        const detail = `lander workdir unusable: ${MAX_LANDER_ERRORS} attempts in a row failed with a lander error; look at the lander's log`;
        await hubWrite(ctx, 'pause', () => ctx.hub.pause({ lease: ctx.lease.auth(), reason: 'config_invalid', detail })).catch(() => undefined);
      }
    } else this.landerErrors = 0;
    return out;
  }

  private async attemptLoop(tenure: AbortSignal): Promise<void> {
    const { ctx } = this;
    while (!tenure.aborted && !this.stopping) {
      if (ctx.clock.now() - this.lastGc >= this.gcIntervalMs) await this.gc();
      const out = await this.step();
      if (tenure.aborted || this.stopping) break;
      switch (out.kind) {
        case 'idle':
        case 'paused':
          await this.idle(tenure);
          break;
        case 'remote_unavailable':
          ctx.log(`the remote can't be reached: taking work again in ${ctx.timings.remoteBackoffMs} ms`);
          await ctx.clock.sleep(ctx.timings.remoteBackoffMs, AbortSignal.any([tenure, this.stopController.signal]));
          break;
        case 'hub_unavailable':
        case 'in_doubt':
          await ctx.clock.sleep(Math.min(ctx.timings.remoteBackoffMs, ctx.timings.pollTrunkMs), AbortSignal.any([tenure, this.stopController.signal]));
          break;
        default:
          break;
      }
    }
  }

  /** Nothing to do: watch trunk (a push outside the queue, a rewrite), then wait for landing events. */
  private async idle(tenure: AbortSignal): Promise<void> {
    const { ctx } = this;
    const signal = AbortSignal.any([tenure, this.stopController.signal]);
    if (this.control && this.control.paused?.reason !== 'trunk_rewritten') {
      try {
        await watchTrunk(ctx, this.control);
      } catch (err) {
        if (!(err instanceof LeaseLost)) ctx.log(`trunk watch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (signal.aborted) return;
    try {
      const ev = await ctx.hub.events({ since: this.since, types: ['landing.created', 'landing.updated', 'lander.resumed'], waitMs: ctx.timings.pollTrunkMs, signal });
      this.since = ev.next_since;
    } catch {
      await ctx.clock.sleep(ctx.timings.pollTrunkMs, signal);
    }
  }

  private async admissionLoop(tenure: AbortSignal): Promise<void> {
    const { ctx } = this;
    const signal = AbortSignal.any([tenure, this.stopController.signal]);
    let since: number | undefined;
    while (!signal.aborted) {
      try {
        since ??= (await ctx.hub.events({ waitMs: 0 })).next_since;
      } catch {
        // admit anyway; the poll below catches up
      }
      await this.admitRound();
      if (signal.aborted) break;
      try {
        const ev = await ctx.hub.events({ since, types: ['landing.created'], waitMs: ctx.timings.pollTrunkMs, signal });
        since = ev.next_since;
      } catch {
        await ctx.clock.sleep(ctx.timings.pollTrunkMs, signal);
      }
    }
  }

  /** One GC pass (at each lease grant and hourly); it never overlaps an admission round. */
  async gc(): Promise<void> {
    this.lastGc = this.ctx.clock.now();
    try {
      await this.serially(() => collectGarbage(this.ctx, { workdir: this.workdir }));
    } catch (err) {
      this.ctx.log(`gc: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The end of run(): a landing left in pushing is resolved first (bounded), then the lease is released. */
  private async shutdown(): Promise<void> {
    const { ctx } = this;
    const id = this.inDoubt;
    this.inDoubt = null;
    if (id && this.lease.held) {
      ctx.log(`resolving ${id} (in pushing) before stopping`);
      const timer = new Promise<'timeout'>((r) => {
        const t = setTimeout(() => r('timeout'), ctx.timings.stopResolveMs);
        t.unref?.();
      });
      const r = await Promise.race([this.resolveBeforeStopping(id), timer]);
      if (r === 'timeout') ctx.log(`${id} is still in pushing; the next lander resolves it`);
    }
    await this.lease.release();
  }

  /**
   * design §2.2.3 / §2.2.7 for the landing this process left in pushing: the
   * landing and the control as the hub has them now (the candidate and
   * trunk_base the hub recorded at pushing, a pause since), then the in-doubt
   * rule: on trunk → landed, trunk still at trunk_base with the candidate
   * staged → the same push, requeue only once that candidate can't land.
   */
  private async resolveBeforeStopping(id: string): Promise<AttemptOutcome | null> {
    const { ctx } = this;
    let landing: Landing;
    let control: LanderControl;
    try {
      [landing, { control }] = await Promise.all([ctx.hub.landing(id), ctx.hub.lander()]);
    } catch (err) {
      ctx.log(`${id}: can't read it from the hub (${err instanceof Error ? err.message : String(err)}); the next lander resolves it`);
      return null;
    }
    if (landing.status !== 'running' || landing.phase !== 'pushing') {
      ctx.log(`${id} is ${landing.status}${landing.phase ? ` (${landing.phase})` : ''} now: nothing to resolve`);
      return null;
    }
    return resolveInDoubt(ctx, landing, control);
  }
}
