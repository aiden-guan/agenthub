import { LANDER_LEASE_KEY } from '@agenthub/contract';
import { Hub, HubError, SqliteStore, type HubAuth, type HubEvent, type Landing, type LandingReport } from '../src/index.js';
import type { HubInternals } from '../src/common.js';
import { failureEffects, landedEffects } from '../src/landings.js';

// Shared by the Phase 2 hub tests (fake clock, in-memory store).

export const P = 'demo';
export const A = 'maya/claude-1';
export const B = 'sam/claude-1';
export const C = 'lee/codex-1';
export const LANDER = 'lander/build1-4821-9f3c';
export const STANDBY = 'lander/build2-5100-04ad';
export const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** A full lowercase sha made of one repeated hex digit. */
export const sha = (c: string) => c.repeat(40);

/** What the server passes for a request with a valid lander token. */
export const LANDER_AUTH: HubAuth = { lander: true, approver: null };
/** What the server passes for a request with a valid approver token of `name`. */
export const approverAuth = (name: string): HubAuth => ({ lander: false, approver: name });

/** `agent` claims the lander lease (queued when another lander holds it), as hub-lander does at start. */
export function takeLease(hub: Hub, agent = LANDER, ttl_ms = 60_000) {
  const r = hub.claim(P, agent, { files: [LANDER_LEASE_KEY], queue: true, ttl_ms, intent: `lander on ${agent.split('/')[1]}` }, LANDER_AUTH);
  return { status: r.status, claim: r.claim!, lease: { lease_claim_id: r.claim!.id, epoch: hub.epoch } };
}

/** A lander-written report; `passed` adds a check that passed. */
export function report(message = 'L-1 landed.', extra: Partial<LandingReport> = {}): LandingReport {
  return { message, resolved_by: 'clean', files_via: [], conflicts: [], check: null, resolver: null, next_steps: [], warnings: [], foreign_commits: [], timings: null, ...extra };
}

export function passedReport(message = 'The checks passed.'): LandingReport {
  return report(message, {
    check: { command_hash: 'fc21ee81dccb', exit_code: 0, signal: null, timed_out: false, duration_ms: 4 * MIN, log_tail: 'ok', failed_tests: [], passes_on_trunk: true, reproduce: 'npm test' },
  });
}

export function setup(opts: { leaseTtlMs?: number } = {}) {
  const clock = { t: T0 };
  const store = new SqliteStore(':memory:');
  const hub = new Hub({ store, now: () => clock.t, leaseTtlMs: opts.leaseTtlMs ?? 60_000, heartbeatIntervalMs: 15_000 });
  const events: HubEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const advance = (ms: number) => {
    clock.t += ms;
  };
  return { hub, store, clock, events, advance };
}

export function errorOf(fn: () => unknown): HubError {
  try {
    fn();
  } catch (err) {
    if (err instanceof HubError) return err;
    throw err;
  }
  throw new Error('expected a HubError');
}

/**
 * Runs `fn` inside one hub write with the hub's internals: what the lander
 * protocol (H3) does when a landing lands or comes back. Tests reach the
 * private write path on purpose.
 */
export function inWrite<T>(hub: Hub, fn: (ix: HubInternals, now: number) => T): T {
  const h = hub as unknown as { write: (project: string, fn: (now: number) => T, opts?: { durable?: boolean }) => T; ix: HubInternals };
  return h.write(P, (now) => fn(h.ix, now), { durable: true });
}

/** The landing comes back (failed): its holds turn back into leases and its task is in progress again. */
export function failLanding(hub: Hub, id: string) {
  return inWrite(hub, (ix, now) => {
    const landing = ix.store.getLanding(P, id)!;
    ix.store.updateLanding(P, id, { status: 'failed', failure: { code: 'checks_failed', summary: 'checks failed' }, ended_at: now, updated_at: now });
    return failureEffects(ix, P, { ...landing, status: 'failed' }, now);
  });
}

/** The landing lands: its holds are released, waiters promoted, its task done. */
export function landLanding(hub: Hub, id: string) {
  return inWrite(hub, (ix, now) => {
    const landing = ix.store.getLanding(P, id)!;
    ix.store.updateLanding(P, id, { status: 'landed', trunk_sha: sha('f'), ended_at: now, updated_at: now });
    return landedEffects(ix, P, { ...landing, status: 'landed' }, now, LANDER);
  });
}

/** Puts a landing in a running phase directly through the store, as a lander's next and advance would. */
export function setRunning(hub: Hub, id: string, phase: Landing['phase'], startedAt: number) {
  hub.store.updateLanding(P, id, { status: 'running', phase, phase_at: startedAt, attempt: 1, lander: LANDER, started_at: startedAt, updated_at: startedAt });
}
