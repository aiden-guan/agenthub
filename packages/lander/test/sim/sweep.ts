// The seed sweep of the deterministic simulation (design §5.2), split into
// SHARDS test files (simulation.test.ts and simulation-<n>.test.ts) so Vitest
// runs them on separate cores: one seed takes about 150 ms, nearly all of it in
// the real Hub. Shard k runs a contiguous range of 1..SIM_SEEDS (2,000 by
// default; 20,000 nightly), so a failing seed replays alone with SIM_SEED=<n>.

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { COVERAGE, simulate, type Mutation, type SimOutcome } from './world.js';

export const SEEDS = Number(process.env.SIM_SEEDS ?? 2_000);
export const SHARDS = 4;

/**
 * Fault paths every shard of a full sweep must reach (by the lander's log
 * lines, sim/world.ts COVERAGE). The others in COVERAGE are rare by design:
 * a landing found already on trunk at P2 needs the documented exception, an
 * unknown push outcome survives five retries only seldom, and self-fencing
 * needs a hub that stops answering heartbeats for ttl/3.
 */
const MUST_REACH = [
  'in_doubt_pushed',
  'in_doubt_on_trunk',
  'in_doubt_requeued',
  'push_retry',
  'push_stale',
  'push_rejected',
  'trunk_rewritten',
  'trunk_moved_in_checks',
  'lease_lost_in_attempt',
  'attempt_stale',
  'standby',
  'parked',
  'approved_fast_path',
] as const;

/** The world's own faults and work that every shard of a full sweep must show. */
const MUST_HAPPEN = ['kills', 'freezes', 'rewinds', 'foreign', 'recreations', 'trunk_pushes', 'resolver_calls', 'check_runs'] as const;

/** The lease heartbeat timers run on the simulated clock (setImmediate stays real: the scheduler steps with it). */
export function useSimTimers(): void {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });
}

export async function runSeed(seed: number, mutation: Mutation | null = null, fullTrace = false): Promise<SimOutcome> {
  try {
    return await simulate({ seed, mutation, fullTrace, advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  } finally {
    vi.clearAllTimers();
  }
}

/** A failing seed: the violation, how to replay it, and the trace before it. */
export function explain(r: SimOutcome): string {
  return [`seed ${r.seed}${r.mutation ? ` (${r.mutation})` : ''}: ${r.violation}`, `replay: SIM_SEED=${r.seed}${r.mutation ? ` SIM_MUTATION=${r.mutation}` : ''}`, ...r.tail.slice(-60)].join('\n');
}

/** Seeds of shard `k` (1-based) of SHARDS. */
export function shardSeeds(k: number): { from: number; to: number } {
  return { from: Math.floor(((k - 1) * SEEDS) / SHARDS) + 1, to: Math.floor((k * SEEDS) / SHARDS) };
}

/** Defines shard `k` of the sweep: every invariant after every step, and liveness after the faults stop. */
export function sweepShard(k: number): void {
  const { from, to } = shardSeeds(k);
  it(`holds every invariant, and settles, on seeds ${from}..${to} of ${SEEDS}`, async () => {
    const totals: Record<string, number> = {};
    let landed = 0;
    let landings = 0;
    for (let seed = from; seed <= to; seed++) {
      const r = await runSeed(seed);
      if (r.violation) expect.fail(explain(r));
      landed += r.landed;
      landings += r.landings;
      for (const [key, v] of Object.entries(r.stats)) totals[key] = (totals[key] ?? 0) + v;
    }
    const n = to - from + 1;
    console.log(`simulation: seeds ${from}..${to}, ${landings} landings (${landed} landed), ${JSON.stringify(totals)}`);
    // Work really landed, and (on a full shard) the faults and the paths they exist for really happened.
    expect(landed).toBeGreaterThan(n);
    if (n >= 400) {
      for (const key of MUST_HAPPEN) expect(totals[key] ?? 0, key).toBeGreaterThan(0);
      for (const key of MUST_REACH) expect(totals[`cov.${key}`] ?? 0, `cov.${key}`).toBeGreaterThan(0);
    }
    expect(COVERAGE.map(([name]) => name)).toEqual(expect.arrayContaining([...MUST_REACH]));
    // A seed takes about 0.3 s with four shards running: 30 min covers the default sweep, and a second per seed the nightly 20,000 (CP3).
  }, Math.max(1_800_000, (to - from + 1) * 1_000));
}
