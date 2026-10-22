// What the lander's loops share (design §2.2.1): the ports, the lease, the
// process's identity, and the few timings tests shorten. Everything here is
// written against the ports, so the same loops run against a real hub and
// git, and in the simulation (§5.2).

import type { StructuralDriver } from '@agenthub/gitops';
import type { LanderAuth } from '@agenthub/hub/protocol';
import { HubCallError, type ChecksPort, type Clock, type Faults, type GitPort, type HubPort, type ResolverPort } from './ports.js';

/** The lease as the loops see it (lease.ts). */
export interface LeaseView {
  /** The lease every lander write carries; throws LeaseLost when it isn't held. */
  auth(): LanderAuth;
  /** The hub database's epoch the lease was granted under. */
  readonly epoch: string;
  /** Heartbeats now: true when the lease is still held and its last acknowledgement is fresh (self-fencing, §1.5). */
  renew(): Promise<boolean>;
  /** The last acknowledgement is younger than ttl/3, by wall-clock and monotonic time. */
  fresh(): boolean;
  /** Aborted once the lease is lost (not_lander, an expired lease, a release). */
  readonly signal: AbortSignal;
  /** Marks the lease lost (a not_lander answer): every attempt under it stops. */
  lost(why: string): void;
}

export interface Timings {
  /** The trunk watch while idle or checking, and the admission poll (design default 15 s). */
  pollTrunkMs: number;
  /** After remote_unavailable, before taking work again (§4.5: 30 s). */
  remoteBackoffMs: number;
  /** Retries of a trunk push whose outcome is unknown (P10: 1, 2, 4, 8, 16 s). */
  pushRetryMs: number[];
  /** Retries of a hub write that got no answer (it is idempotent: the hub detects replays). */
  hubRetryMs: number[];
  /** How long a stopping lander spends resolving a landing in pushing (§2.2.3: 60 s). */
  stopResolveMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  pollTrunkMs: 15_000,
  remoteBackoffMs: 30_000,
  pushRetryMs: [1_000, 2_000, 4_000, 8_000, 16_000],
  hubRetryMs: [500, 1_000, 2_000, 4_000],
  stopResolveMs: 60_000,
};

export interface LanderContext {
  hub: HubPort;
  git: GitPort;
  checks: ChecksPort;
  /** null: the AI stage of the merge ladder is skipped (L5 provides it). */
  resolver: ResolverPort | null;
  clock: Clock;
  faults: Faults;
  log: (line: string) => void;
  lease: LeaseView;
  /** This process's agent id, lander/<host>-<pid>-<4 hex>. */
  agent: string;
  project: string;
  committer: { name: string; email: string };
  /** Structural drivers for stage 2, used when trunk's land.structural is auto. */
  drivers: StructuralDriver[];
  /** The trunk branch (refs/heads/<trunk>); trunk's own land.trunk can move it (trunk.ts). */
  trunk: { branch: string };
  timings: Timings;
  /** Aborted when the lander is stopping (SIGTERM). */
  stopping: AbortSignal;
}

/** The lease was lost (not_lander): drop the attempt, push nothing, claim again. */
export class LeaseLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseLost';
  }
}

/** The hub says the attempt is over (landing_stale: cancelled, superseded, requeued): stop, push nothing. */
export class AttemptStale extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptStale';
  }
}

/** The hub didn't answer a write, retries included: its outcome is unknown. */
export class HubUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubUnavailable';
  }
}

/** The lander is stopping (SIGTERM) and the attempt may stop here. */
export class Stopping extends Error {
  constructor() {
    super('the lander is stopping');
    this.name = 'Stopping';
  }
}

/**
 * A fenced hub write. not_lander marks the lease lost (LeaseLost);
 * landing_stale ends the attempt (AttemptStale); no answer is retried, since
 * every lander write is idempotent (the hub answers a repeat with replayed:
 * true), and becomes HubUnavailable when the retries run out. Every other
 * refusal is thrown as the HubCallError.
 */
export async function hubWrite<T>(ctx: LanderContext, what: string, fn: () => Promise<T>): Promise<T> {
  const waits = ctx.timings.hubRetryMs;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HubCallError) {
        if (err.code === 'not_lander') {
          ctx.lease.lost(`${what}: ${err.message}`);
          throw new LeaseLost(err.message);
        }
        if (err.code === 'landing_stale') throw new AttemptStale(err.message);
        if (err.unavailable && i < waits.length && !ctx.lease.signal.aborted) {
          await ctx.clock.sleep(waits[i]!, ctx.lease.signal);
          continue;
        }
        if (err.unavailable) throw new HubUnavailable(`${what}: ${err.message}`);
      }
      throw err;
    }
  }
}

/** A best-effort side effect (a message, a ref deletion): a failure is logged, never thrown. */
export async function bestEffort(ctx: LanderContext, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ctx.log(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
