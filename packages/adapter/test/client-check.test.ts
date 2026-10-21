import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '@agenthub/hub';
import { A, B, client, startHub } from './helpers.js';

// Step 0: a check too big for one request goes in batches, and a claim met in
// more than one batch comes back once, with the files and the scope entries of
// every batch.
describe('HubClient.check across batches', () => {
  let hub: RunningServer;
  beforeAll(async () => {
    hub = await startHub();
    await client(hub.url, A).claim({ files: ['src/a.ts', 'src/b.ts'], intent: 'refactor' });
  });
  afterAll(async () => {
    await hub.close();
  });

  it('merges one claim met in several batches, scope included', async () => {
    // About 300 KB of names between the two claimed files: more than one batch.
    const filler = Array.from({ length: 2000 }, (_, i) => `vendor/${'w'.repeat(140)}-${String(i).padStart(5, '0')}.txt`);
    const files = ['src/a.ts', ...filler, 'src/b.ts'];
    for (const mode of [undefined, 'auto'] as const) {
      const r = await client(hub.url, B).check(files, mode);
      expect(r.conflicts).toEqual([
        expect.objectContaining({
          claim_id: 'C-1',
          holder: A,
          files: ['src/a.ts', 'src/b.ts'],
          scope: [{ file: 'src/a.ts' }, { file: 'src/b.ts' }],
        }),
      ]);
    }
  });
});
