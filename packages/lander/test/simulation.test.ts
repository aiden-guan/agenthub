import { describe, expect, it } from 'vitest';
import { runSeed, sweepShard, useSimTimers } from './sim/sweep.js';
import { MUTATIONS, type Mutation } from './sim/world.js';

// design §5.2: the deterministic protocol simulation. The real Lander
// (lease, admission, pipeline.ts, recovery.ts, GC) runs against the real Hub
// in-process on a simulated clock, a fake git remote with fast-forward-only
// CAS (test/fakes/git-port.ts), fake checks (test/fakes/checks-port.ts) and a
// stub resolver, all under one seeded scheduler that also injects the faults
// (sim/world.ts). The invariants are checked after every step; after the
// faults stop, every landing must reach a terminal state with the hub and
// trunk agreeing. Each mutation guard removes one protection and must make
// the invariants fail.
//
// This file holds the first shard of the seed sweep (sim/sweep.ts; the others
// are simulation-2..4.test.ts, so they run in parallel), the determinism
// check and the mutation guards. SIM_SEEDS raises the seed count (2,000 by
// default; 20,000 nightly), and SIM_SEED=<n> (with SIM_MUTATION=<name>)
// replays one seed with its whole trace.

/** A mutation guard looks at this many seeds at most before it gives up (each fails within the first few). */
const MUTATION_SEEDS = Number(process.env.SIM_MUTATION_SEEDS ?? 200);

useSimTimers();

describe('deterministic protocol simulation (design §5.2)', () => {
  if (process.env.SIM_SEED) {
    it('replays one seed', async () => {
      const r = await runSeed(Number(process.env.SIM_SEED), (process.env.SIM_MUTATION as Mutation | undefined) ?? null, true);
      console.log(r.tail.join('\n'));
      console.log(JSON.stringify({ ...r, tail: undefined }, null, 2));
    }, 600_000);
    return;
  }

  it('is deterministic: a seed replays step for step', async () => {
    const a = await runSeed(7);
    const b = await runSeed(7);
    expect(a.digest).toBe(b.digest);
    expect(a.steps).toBe(b.steps);
    expect(a.steps).toBeGreaterThan(100);
  }, 60_000);

  sweepShard(1);

  for (const mutation of MUTATIONS) {
    it(`mutation guard: ${mutation} makes the invariants fail`, async () => {
      for (let seed = 1; seed <= MUTATION_SEEDS; seed++) {
        const r = await runSeed(seed, mutation);
        if (r.violation) {
          console.log(`mutation ${mutation}: caught at seed ${seed}: ${r.violation}`);
          return;
        }
      }
      expect.fail(`no seed in 1..${MUTATION_SEEDS} caught the ${mutation} mutation`);
    }, 600_000);
  }
});
