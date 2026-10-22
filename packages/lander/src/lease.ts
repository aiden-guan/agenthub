// The lander lease (design §1.5, §2.2.3): an ordinary claim on
// LANDER_LEASE_KEY, held by this process's own agent id. Queued means
// standby: the claim is heartbeated to keep its place, and claim events are
// long-polled until it is granted. Once active, a timer heartbeats it (also
// while a check runs). Self-fencing: the pipeline never enters pushing or
// pushes trunk unless the last acknowledgement is younger than ttl/3 by both
// wall-clock and monotonic time. Safety doesn't depend on it: the hub fences
// every write by (lease claim id, epoch).

import { LANDER_LEASE_KEY } from '@agenthub/contract';
import type { Claim, LanderAuth } from '@agenthub/hub/protocol';
import { LeaseLost, type LeaseView } from './context.js';
import { HubCallError, type Clock, type HubPort } from './ports.js';

export interface LeaseOptions {
  hub: HubPort;
  clock: Clock;
  /** This process's agent id. */
  agent: string;
  ttlMs: number;
  /** Default: min(15 s, ttl / 4). */
  heartbeatMs?: number;
  /** The claim's intent, e.g. `lander on buildbox`. */
  intent: string;
  log: (line: string) => void;
  /** Backoff while the hub can't be reached (default 2 s). */
  retryMs?: number;
}

/** The hub refused the lease outright (no lander credentials, a bad token): a configuration problem. */
export class LeaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseRefused';
  }
}

export class Lease implements LeaseView {
  readonly ttlMs: number;
  readonly heartbeatMs: number;
  private claimId: string | null = null;
  private epochValue: string | null = null;
  private ack = { wall: Number.NEGATIVE_INFINITY, mono: Number.NEGATIVE_INFINITY };
  private controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private beating: Promise<boolean> | null = null;
  /** True while this process waits on the lease behind another lander. */
  standby = false;

  constructor(private readonly o: LeaseOptions) {
    this.ttlMs = o.ttlMs;
    this.heartbeatMs = o.heartbeatMs ?? Math.max(25, Math.min(15_000, Math.floor(o.ttlMs / 4)));
    // No tenure yet: nothing may run under it.
    this.controller.abort(new LeaseLost('no lease yet'));
  }

  get held(): boolean {
    return this.claimId !== null;
  }

  get claim(): string | null {
    return this.claimId;
  }

  get epoch(): string {
    if (this.epochValue === null) throw new LeaseLost('no lease yet');
    return this.epochValue;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  auth(): LanderAuth {
    if (this.claimId === null || this.epochValue === null) throw new LeaseLost('the lander lease is not held');
    return { lease_claim_id: this.claimId, epoch: this.epochValue };
  }

  fresh(): boolean {
    if (this.claimId === null) return false;
    const limit = this.ttlMs / 3;
    return this.o.clock.now() - this.ack.wall < limit && this.o.clock.monotonic() - this.ack.mono < limit;
  }

  /**
   * Claims the lease. As a standby, keeps the queued claim alive and waits
   * until it is granted. Resolves true once held, false if `signal` aborted
   * first. A hub that can't be reached is retried; a refusal (403) throws
   * LeaseRefused.
   */
  async acquire(signal?: AbortSignal): Promise<boolean> {
    const { hub, clock, log } = this.o;
    const retry = this.o.retryMs ?? 2_000;
    while (!signal?.aborted) {
      try {
        const head = await hub.events({ waitMs: 0 });
        this.epochValue = head.epoch;
        let since = head.next_since;
        const r = await hub.claim({
          files: [LANDER_LEASE_KEY],
          mode: 'exclusive',
          queue: true,
          ttl_ms: this.ttlMs,
          heartbeat_interval_ms: this.heartbeatMs,
          intent: this.o.intent,
        });
        if (r.status === 'granted' && r.claim) {
          this.become(r.claim);
          return true;
        }
        if (r.status !== 'queued' || !r.claim) {
          await clock.sleep(retry, signal);
          continue;
        }
        // Standby: keep the place, wait for the grant.
        const id = r.claim.id;
        if (!this.standby) log(`standing by: ${r.conflicts[0]?.holder ?? 'another lander'} holds the lease (position ${r.position ?? 1})`);
        this.standby = true;
        let lastBeat = clock.monotonic();
        for (;;) {
          if (signal?.aborted) return false;
          const c = await hub.getClaim(id);
          if (c.status === 'active') {
            if (c.holder !== this.o.agent) break;
            this.standby = false;
            this.become(c);
            return true;
          }
          if (c.status !== 'queued') break; // it lapsed or was released: claim again
          if (clock.monotonic() - lastBeat >= this.heartbeatMs) {
            await hub.heartbeat({ claim_ids: [id] });
            lastBeat = clock.monotonic();
          }
          const ev = await hub.events({ since, types: ['claim.granted', 'claim.expired', 'claim.released'], waitMs: this.heartbeatMs, signal });
          if (ev.epoch !== this.epochValue) break;
          since = ev.next_since;
        }
      } catch (err) {
        if (signal?.aborted) return false;
        if (err instanceof HubCallError && !err.unavailable && err.code !== 'aborted' && err.code !== 'not_found') {
          if (err.status === 403 || err.status === 401) throw new LeaseRefused(`the hub refused the lander lease: ${err.message}`);
          log(`claiming the lease failed: ${err.message}`);
        }
        await clock.sleep(retry, signal);
      }
    }
    return false;
  }

  private become(claim: Claim): void {
    this.claimId = claim.id;
    this.ack = { wall: this.o.clock.now(), mono: this.o.clock.monotonic() };
    this.controller = new AbortController();
    this.o.log(`holding the lander lease ${claim.id}`);
    this.startTimer();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (this.claimId === null) return this.stopTimer();
      if (!this.beating) void this.renew();
      // No acknowledgement within a whole ttl: the hub has (or will have) ended it.
      if (this.o.clock.monotonic() - this.ack.mono > this.ttlMs) this.lost('no heartbeat acknowledgement within the lease ttl');
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Heartbeats the lease now (one at a time): true when it is still held, and fresh. */
  renew(): Promise<boolean> {
    if (this.claimId === null) return Promise.resolve(false);
    this.beating ??= this.beat().finally(() => {
      this.beating = null;
    });
    return this.beating;
  }

  private async beat(): Promise<boolean> {
    const id = this.claimId;
    if (id === null) return false;
    try {
      const r = await this.o.hub.heartbeat({ claim_ids: [id] });
      if (this.claimId !== id) return false;
      const mine = r.claims.find((c) => c.id === id);
      if (!mine || mine.status !== 'active') {
        this.lost(`the hub no longer has lease ${id} as active`);
        return false;
      }
      this.ack = { wall: this.o.clock.now(), mono: this.o.clock.monotonic() };
      return this.fresh();
    } catch (err) {
      if (err instanceof HubCallError && !err.unavailable && err.code !== 'aborted') this.o.log(`heartbeat failed: ${err.message}`);
      return this.fresh();
    }
  }

  lost(why: string): void {
    if (this.claimId === null) return;
    this.o.log(`lost the lander lease ${this.claimId}: ${why}`);
    this.claimId = null;
    this.stopTimer();
    this.controller.abort(new LeaseLost(why));
  }

  /** Gives the lease up (shutdown): the next standby is promoted at once. */
  async release(): Promise<void> {
    const id = this.claimId;
    this.claimId = null;
    this.stopTimer();
    this.controller.abort(new LeaseLost('released'));
    if (id === null) return;
    try {
      await this.o.hub.release({ claim_id: id });
      this.o.log(`released the lander lease ${id}`);
    } catch (err) {
      this.o.log(`releasing the lease ${id} failed (it lapses after its ttl): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Stops the heartbeat without telling the hub (the lease lapses after its ttl). */
  abandon(): void {
    this.claimId = null;
    this.stopTimer();
    this.controller.abort(new LeaseLost('abandoned'));
  }
}
