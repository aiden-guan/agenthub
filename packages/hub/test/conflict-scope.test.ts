import { describe, expect, it } from 'vitest';
import { Hub, SqliteStore } from '../src/index.js';

// Step 0: ClaimConflict.scope is the holder's entries that overlap the request,
// whichever check() path answers (the guard's, or hub_wait's with a mode, which
// works file by file and merges each claim's conflicts).
const P = 'demo';
const A = 'maya/claude-1';
const B = 'sam/claude-1';

function setup() {
  const clock = { t: Date.UTC(2026, 9, 20, 9, 0, 0) };
  return new Hub({ store: new SqliteStore(':memory:'), now: () => clock.t, leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
}

describe('conflict scope', () => {
  it('names every overlapping entry of a claim, with or without a mode', () => {
    const hub = setup();
    hub.claim(P, A, { files: ['src/a.ts', 'src/b.ts', 'src/c.ts'], intent: 'refactor' });
    const want = [
      expect.objectContaining({
        claim_id: 'C-1',
        holder: A,
        files: ['src/a.ts', 'src/b.ts'],
        scope: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }],
        landing_id: null,
      }),
    ];
    expect(hub.check(P, B, ['src/a.ts', 'src/b.ts']).conflicts).toEqual(want);
    for (const mode of ['exclusive', 'shared', 'auto'] as const) {
      expect(hub.check(P, B, ['src/a.ts', 'src/b.ts'], mode).conflicts).toEqual(want);
    }
    // Asked in the other order, the entries still follow the holder's scope.
    expect(hub.check(P, B, ['src/b.ts', 'src/a.ts'], 'auto').conflicts[0].scope).toEqual([{ file: 'src/a.ts' }, { file: 'src/b.ts' }]);
  });
});
