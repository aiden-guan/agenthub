import { describe } from 'vitest';
import { sweepShard, useSimTimers } from './sim/sweep.js';

// design §5.2: shard 3 of the simulation's seed sweep (see simulation.test.ts).

useSimTimers();

describe.skipIf(Boolean(process.env.SIM_SEED))('deterministic protocol simulation (design §5.2)', () => {
  sweepShard(3);
});
