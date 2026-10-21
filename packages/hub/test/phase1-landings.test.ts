import { describe, expect, it } from 'vitest';
import { Hub, SqliteStore } from '../src/index.js';

// Step 0: status() lists each recorded landing as Phase 1 did, the whole
// landings row with commit_sha as `commit` (so the undeclared `seq` too, keys
// in the same order), and adds the Phase 2 and 3 fields after it.
const P = 'demo';
const A = 'maya/claude-1';
const PHASE1_KEYS = ['project', 'id', 'agent', 'task_id', 'branch', 'summary', 'status', 'created_at', 'seq', 'commit'];

function setup() {
  const clock = { t: Date.UTC(2026, 9, 20, 9, 0, 0) };
  const hub = new Hub({ store: new SqliteStore(':memory:'), now: () => clock.t, leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  return { hub, clock };
}

describe('Phase 1 landings in status', () => {
  it('keep every Phase 1 key and value, seq included, ahead of the neutral Phase 2 fields', () => {
    const { hub, clock } = setup();
    hub.createTask(P, A, { title: 'one' });
    hub.takeTask(P, A, 'T-1');
    const first = hub.land(P, A, { task_id: 'T-1', branch: 'agent-a', commit: 'abc123' }).landing;
    clock.t += 1_000;
    const second = hub.land(P, A, { summary: 'docs only' }).landing;
    // land() answers with the landing it built, which never had a seq.
    expect(first).not.toHaveProperty('seq');

    const landings = JSON.parse(JSON.stringify(hub.status(P, A).landings)) as Array<Record<string, unknown>>;
    expect(landings.map((l) => Object.keys(l).slice(0, PHASE1_KEYS.length))).toEqual([PHASE1_KEYS, PHASE1_KEYS]);
    expect(landings.map((l) => Object.fromEntries(PHASE1_KEYS.map((k) => [k, l[k]])))).toEqual([
      { project: P, id: 'L-2', agent: A, task_id: null, branch: null, summary: 'docs only', status: 'recorded', created_at: second.created_at, seq: 2, commit: null },
      { project: P, id: 'L-1', agent: A, task_id: 'T-1', branch: 'agent-a', summary: first.summary, status: 'recorded', created_at: first.created_at, seq: 1, commit: 'abc123' },
    ]);
    // The rest is the same superset land() returns.
    expect(landings[1]).toEqual({ ...first, seq: 1 });
    expect(landings[0]).toEqual({ ...second, seq: 2 });
  });
});
