import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import { faultsFromEnv, parseFaults } from '../src/faults.js';
import { FAULT_POINTS } from '../src/ports.js';

// Fault injection (design §5 "Fault injection"): AGENTHUB_LANDER_FAULTS, only
// with NODE_ENV=test.

describe('faults', () => {
  it('parses points, with an optional landing', () => {
    expect(parseFaults('after-pushing-ack:L-7, during-checks')).toEqual([
      { point: 'after-pushing-ack', landing: 'L-7' },
      { point: 'during-checks', landing: null },
    ]);
    for (const p of FAULT_POINTS) expect(parseFaults(p)).toEqual([{ point: p, landing: null }]);
    expect(() => parseFaults('after-push')).toThrow(ConfigError);
    expect(() => parseFaults('after-next:7')).toThrow(ConfigError);
    expect(() => parseFaults('after-next:L-1:x')).toThrow(ConfigError);
  });

  it('acts only at a matching point and landing, and only with NODE_ENV=test', async () => {
    const hits: string[] = [];
    const act = (p: string, id: string | undefined) => void hits.push(`${p}:${id}`);
    const f = faultsFromEnv({ NODE_ENV: 'test', AGENTHUB_LANDER_FAULTS: 'after-checks:L-2' }, act);
    await f.at('after-checks', 'L-1');
    await f.at('after-next', 'L-2');
    await f.at('after-checks', 'L-2');
    expect(hits).toEqual(['after-checks:L-2']);
    const off = faultsFromEnv({ NODE_ENV: 'production', AGENTHUB_LANDER_FAULTS: 'after-checks' }, act);
    await off.at('after-checks', 'L-9');
    expect(hits).toEqual(['after-checks:L-2']);
    // Not even parsed outside tests.
    expect(() => faultsFromEnv({ AGENTHUB_LANDER_FAULTS: 'nonsense' })).not.toThrow();
  });
});
