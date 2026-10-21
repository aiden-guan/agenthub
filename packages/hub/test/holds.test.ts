import { HOLD_EXPIRES } from '@agenthub/contract';
import { describe, expect, it } from 'vitest';
import { setHolds } from '../src/holds.js';
import { A, B, C, HOUR, MIN, P, errorOf, failLanding, inWrite, landLanding, setup, sha } from './landing-setup.js';

// H2 (design §1.6): hold claims. They never expire while their landing is
// live, never cover their holder's new requests, can't be released by their
// holder, wait for nobody in the wait graph, and block other agents' commits.

/** A lands `files` (claimed first) for a new task; returns the landing and its holds. */
function landFiles(hub: ReturnType<typeof setup>['hub'], files: string[], commit = sha('1')) {
  const task = hub.createTask(P, A, { title: 'Let login take an options object' });
  hub.takeTask(P, A, task.id);
  hub.claim(P, A, { files });
  return hub.land(P, A, { task_id: task.id, commit, queue: true, files });
}

describe('holds', () => {
  it('a hold survives a 1-day clock jump while leases around it expire', () => {
    const { hub, advance, store, clock } = setup();
    const r = landFiles(hub, ['held.ts']);
    const hold = r.held[0];
    const lease = hub.claim(P, A, { files: ['lease.ts'] }).claim!;
    advance(24 * HOUR);
    expect(hub.sweep()).toEqual([P]); // the lease
    expect(hub.getClaim(P, lease.id).status).toBe('expired');
    expect(hub.getClaim(P, hold.id)).toMatchObject({ status: 'active', expires_at: HOLD_EXPIRES, landing_id: 'L-1' });
    // Nothing is ever due for the hold.
    expect(store.projectsWithDueWork(clock.t + 365 * 24 * HOUR)).toEqual([]);
    const denied = hub.claim(P, B, { files: ['held.ts'] });
    expect(denied.status).toBe('denied');
    expect(denied.conflicts).toEqual([
      expect.objectContaining({ claim_id: hold.id, holder: A, landing_id: 'L-1', scope: [{ file: 'held.ts' }], files: ['held.ts'], expires_at: HOLD_EXPIRES }),
    ]);
  });

  it('heartbeats count holds in renewed and never shorten them', () => {
    const { hub, advance, clock } = setup();
    const hold = landFiles(hub, ['a.ts']).held[0];
    const lease = hub.claim(P, A, { files: ['b.ts'] }).claim!;
    advance(10_000);
    const beat = hub.heartbeat(P, A);
    expect(beat.renewed).toBe(2);
    expect(beat.claims.map((c) => [c.id, c.expires_at])).toEqual([
      [hold.id, HOLD_EXPIRES],
      [lease.id, clock.t + 60_000],
    ]);
    expect(hub.heartbeat(P, A, { claim_ids: [hold.id] })).toMatchObject({ renewed: 1, claims: [{ id: hold.id, expires_at: HOLD_EXPIRES }] });
    // A claim request renews every lease of the agent's, and leaves the hold as it is.
    hub.claim(P, A, { files: ['c.ts'] });
    expect(hub.getClaim(P, hold.id).expires_at).toBe(HOLD_EXPIRES);
    expect(hub.getClaim(P, lease.id).expires_at).toBe(clock.t + 60_000);
  });

  it("the holder's new claim on a held file is a separate lease that survives the hold's release", () => {
    const { hub, clock } = setup();
    const r = landFiles(hub, ['a.ts']); // T-1, L-1
    const hold = r.held[0];
    const mine = hub.claim(P, A, { files: ['a.ts'] });
    expect(mine).toMatchObject({ status: 'granted', renewed: false, claim: { holder: A, landing_id: null, expires_at: clock.t + 60_000 } });
    expect(mine.claim!.id).not.toBe(hold.id);
    expect(mine.claims.map((c) => c.id)).toEqual([mine.claim!.id]);
    // Asked again, the lease is renewed: the hold never covers a request.
    expect(hub.claim(P, A, { files: ['a.ts'] })).toMatchObject({ renewed: true, claim: { id: mine.claim!.id } });
    // The hold is not its holder's conflict: neither the guard nor hub_wait's check sees it.
    expect(hub.check(P, A, ['a.ts']).conflicts).toEqual([]);
    expect(hub.check(P, A, ['a.ts'], 'auto').conflicts).toEqual([]);

    const landed = landLanding(hub, 'L-1');
    expect(landed.released.map((c) => [c.id, c.status, c.end_reason])).toEqual([[hold.id, 'released', 'landed L-1']]);
    expect(hub.getClaim(P, mine.claim!.id)).toMatchObject({ status: 'active', landing_id: null });
    expect(hub.claim(P, B, { files: ['a.ts'] }).status).toBe('denied');
    expect(hub.listTasks(P).find((t) => t.id === 'T-1')).toMatchObject({ status: 'done', owner: A });
  });

  it('landing releases the holds, promotes the waiters and completes the task, unblocking its dependents', () => {
    const { hub, events } = setup();
    hub.createTask(P, A, { title: 'one' }); // T-1
    hub.createTask(P, B, { title: 'after one', deps: ['T-1'] }); // T-2
    hub.takeTask(P, A, 'T-1');
    hub.claim(P, A, { files: ['x.ts'] });
    hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true, files: ['x.ts'] });
    const waiting = hub.claim(P, B, { files: ['x.ts'], queue: true });
    expect(waiting).toMatchObject({ status: 'queued', conflicts: [{ landing_id: 'L-1' }] });

    const before = events.length;
    const landed = landLanding(hub, 'L-1');
    expect(landed.unblocked).toEqual(['T-2']);
    expect(landed.promoted.map((c) => c.id)).toEqual([waiting.claim!.id]);
    expect(hub.getClaim(P, waiting.claim!.id).status).toBe('active');
    expect(events.slice(before).map((e) => e.type)).toEqual(['claim.released', 'claim.granted', 'task.updated', 'task.unblocked']);
    expect(events[before].data).toMatchObject({ reason: 'landed L-1', landing_id: 'L-1' });
    expect(events[before + 2].data).toEqual({ task_id: 'T-1', status: 'done', previous: 'landing' });
    expect(hub.listTasks(P)[0]).toMatchObject({ status: 'done', owner: A });
  });

  it('the holder cannot release a hold (409 held_by_landing); all, task_id and files skip holds', () => {
    const { hub } = setup();
    const r = landFiles(hub, ['a.ts', 'b.ts']); // T-1
    const hold = r.held[0];
    const err = errorOf(() => hub.release(P, A, { claim_id: hold.id }));
    expect([err.code, err.status]).toEqual(['held_by_landing', 409]);
    expect(err.message).toContain('L-1');
    expect(errorOf(() => hub.release(P, B, { claim_id: hold.id })).code).toBe('forbidden');

    const lease = hub.claim(P, A, { files: ['a.ts'], task_id: 'T-1' }).claim!;
    expect(hub.release(P, A, { files: ['a.ts', 'b.ts'] })).toMatchObject({ released: [{ id: lease.id }], trimmed: [] });
    hub.claim(P, A, { files: ['c.ts'], task_id: 'T-1' });
    expect(hub.release(P, A, { task_id: 'T-1' }).released.map((c) => c.scope[0].file)).toEqual(['c.ts']);
    hub.claim(P, A, { files: ['d.ts'] });
    expect(hub.release(P, A, { all: true }).released.map((c) => c.scope[0].file)).toEqual(['d.ts']);
    expect(hub.getClaim(P, hold.id)).toMatchObject({ status: 'active', scope: [{ file: 'a.ts' }, { file: 'b.ts' }] });
  });

  it('no false deadlock: an agent with a hold queues for a file held by someone who waits for the hold', () => {
    const { hub } = setup();
    landFiles(hub, ['x.ts']); // A's L-1 holds x.ts
    hub.claim(P, B, { files: ['y.ts'] });
    expect(hub.claim(P, B, { files: ['x.ts'], queue: true }).status).toBe('queued');
    // B waits for the landing, not for A: A waiting for B closes no cycle.
    const a = hub.claim(P, A, { files: ['y.ts'], queue: true });
    expect(a.status).toBe('queued');
    expect(a.deadlock).toBeUndefined();
    const denied = hub.claim(P, A, { files: ['y.ts'] });
    expect(denied.status).toBe('denied');
    expect(denied.deadlock).toBeUndefined();
    expect(hub.check(P, A, ['y.ts'], 'auto').deadlock).toBeUndefined();

    // L-1 lands: B gets x.ts; A waits for y.ts until B lets go of it.
    landLanding(hub, 'L-1');
    expect(hub.listClaims(P, { holder: B }).map((c) => [c.scope[0].file, c.status])).toEqual([
      ['y.ts', 'active'],
      ['x.ts', 'active'],
    ]);
    expect(hub.getClaim(P, a.claim!.id).status).toBe('queued');
    hub.release(P, B, { files: ['y.ts'] });
    expect(hub.getClaim(P, a.claim!.id).status).toBe('active');
  });

  it('the same waits through an ordinary lease are a deadlock, as in Phase 1', () => {
    const { hub } = setup();
    hub.claim(P, A, { files: ['x.ts'] });
    hub.claim(P, B, { files: ['y.ts'] });
    expect(hub.claim(P, B, { files: ['x.ts'], queue: true }).status).toBe('queued');
    expect(errorOf(() => hub.claim(P, A, { files: ['y.ts'], queue: true })).code).toBe('deadlock');
  });

  it("a guard check by a third agent sees another agent's hold, shared or not, as a conflict", () => {
    const { hub } = setup();
    hub.claim(P, B, { files: ['shared.md'], mode: 'shared' });
    const r = hub.land(P, A, { commit: sha('1'), queue: true, branch: 'a', files: ['x.ts', 'shared.md'] });
    const [excl, shared] = r.held;
    expect([excl.mode, shared.mode]).toEqual(['exclusive', 'shared']);
    expect(hub.check(P, C, ['x.ts', 'shared.md', 'free.ts']).conflicts).toEqual([
      expect.objectContaining({ claim_id: excl.id, holder: A, landing_id: 'L-1', files: ['x.ts'], scope: [{ file: 'x.ts' }] }),
      expect.objectContaining({ claim_id: shared.id, holder: A, landing_id: 'L-1', files: ['shared.md'], mode: 'shared' }),
    ]);
    // Without an agent (a guard without identity), the holds count as well.
    expect(hub.check(P, null, ['x.ts']).conflicts.map((c) => c.claim_id)).toEqual([excl.id]);
    // hub_wait's check (with a mode) answers what a claim would be denied for.
    expect(hub.check(P, C, ['x.ts'], 'auto').conflicts).toEqual([expect.objectContaining({ claim_id: excl.id, landing_id: 'L-1' })]);
    expect(hub.check(P, C, ['shared.md'], 'shared').conflicts).toEqual([]);
  });

  it('a landing that comes back turns its holds into leases for the send-back grace, and its task is in progress again', () => {
    const { hub, advance, clock, events } = setup();
    const r = landFiles(hub, ['a.ts']);
    const hold = r.held[0];
    const waiting = hub.claim(P, B, { files: ['a.ts'], queue: true }).claim!;
    const before = events.length;

    const back = failLanding(hub, 'L-1');
    const failedAt = clock.t;
    expect(back.released).toEqual([
      expect.objectContaining({ id: hold.id, landing_id: null, status: 'active', expires_at: failedAt + 30 * MIN, intent: 'Let login take an options object' }),
    ]);
    expect(hub.getClaim(P, hold.id)).toMatchObject({ landing_id: null, expires_at: failedAt + 30 * MIN });
    expect(hub.listTasks(P)[0]).toMatchObject({ status: 'in_progress', owner: A });
    const mine = events.slice(before);
    expect(mine.map((e) => e.type)).toEqual(['claim.granted', 'task.updated']);
    expect(mine[0].data).toMatchObject({ claim_id: hold.id, holder: A, landing_id: null, files: ['a.ts'] });
    expect(mine[1].data).toEqual({ task_id: 'T-1', status: 'in_progress', previous: 'landing' });

    // A live agent's heartbeats keep it, without cutting the grace short.
    advance(30_000);
    hub.heartbeat(P, A);
    hub.heartbeat(P, B);
    expect(hub.getClaim(P, hold.id).expires_at).toBe(failedAt + 30 * MIN);
    expect(hub.getClaim(P, waiting.id).status).toBe('queued');
    // An agent that went away lets it lapse after the grace, and the waiter (still beating) gets the file.
    for (let i = 0; i < 60; i++) {
      advance(30_000);
      hub.heartbeat(P, B);
    }
    expect(hub.getClaim(P, hold.id)).toMatchObject({ status: 'expired', ended_at: failedAt + 30 * MIN });
    expect(hub.getClaim(P, waiting.id).status).toBe('active');
  });

  it('a send-back grace shorter than the lease TTL leaves the TTL', () => {
    const { hub, store, clock } = setup({ leaseTtlMs: 2 * HOUR });
    store.putLanderControl(P, { policy: { keep_place_retries: 2, sendback_grace_min: 0, approval_timeout_hours: 24, claim_gate: 'fail' } }, clock.t);
    const hold = landFiles(hub, ['a.ts']).held[0];
    failLanding(hub, 'L-1');
    expect(hub.getClaim(P, hold.id).expires_at).toBe(clock.t + 2 * HOUR);
  });

  it('setHolds rescopes the hold rows in place: trimmed entries are released and their waiters promoted, new ones granted', () => {
    const { hub, events } = setup();
    const r = landFiles(hub, ['a.ts', 'b.ts']);
    const hold = r.held[0];
    const waiting = hub.claim(P, C, { files: ['b.ts'], queue: true }).claim!;
    const before = events.length;

    const done = inWrite(hub, (ix, now) => {
      const landing = ix.store.getLanding(P, 'L-1')!;
      const result = setHolds(ix, P, landing, [{ file: 'a.ts' }, { file: 'c.ts' }], null, 'fail', now);
      if (result.trimmed) ix.promoteQueued(P, now);
      return result;
    });
    expect(done.holds).toEqual([expect.objectContaining({ id: hold.id, scope: [{ file: 'a.ts' }, { file: 'c.ts' }], landing_id: 'L-1' })]);
    expect(done).toMatchObject({ applied: true, conflicts: [], dropped: [], trimmed: true });
    expect(events.slice(before).map((e) => [e.type, e.data.claim_id, e.data.files])).toEqual([
      ['claim.released', hold.id, ['b.ts']],
      ['claim.granted', hold.id, ['c.ts']],
      ['claim.granted', waiting.id, ['b.ts']],
    ]);
    expect(events[before].data).toMatchObject({ partial: true, landing_id: 'L-1', scope: [{ file: 'b.ts' }] });
    expect(hub.getClaim(P, waiting.id).status).toBe('active');

    // The same gate as at land: fail refuses and changes nothing, warn leaves the entry out.
    const theirs = hub.claim(P, B, { files: ['d.ts'] }).claim!;
    const seen = events.length;
    const refused = inWrite(hub, (ix, now) => setHolds(ix, P, ix.store.getLanding(P, 'L-1')!, [{ file: 'd.ts' }], null, 'fail', now));
    expect(refused).toMatchObject({ applied: false, dropped: [], trimmed: false });
    expect(refused.conflicts).toEqual([expect.objectContaining({ claim_id: theirs.id, holder: B, files: ['d.ts'], scope: [{ file: 'd.ts' }] })]);
    expect(refused.holds.map((h) => h.id)).toEqual([hold.id]);
    expect(hub.getClaim(P, hold.id).scope).toEqual([{ file: 'a.ts' }, { file: 'c.ts' }]);
    expect(events.length).toBe(seen);
    const warned = inWrite(hub, (ix, now) => setHolds(ix, P, ix.store.getLanding(P, 'L-1')!, [{ file: 'a.ts' }, { file: 'd.ts' }], null, 'warn', now));
    expect(warned.dropped).toEqual([{ file: 'd.ts' }]);
    expect(warned.conflicts.map((c) => c.claim_id)).toEqual([theirs.id]);
    expect(warned.holds.map((h) => h.scope)).toEqual([[{ file: 'a.ts' }]]);

    // An empty scope ends the hold.
    const none = inWrite(hub, (ix, now) => setHolds(ix, P, ix.store.getLanding(P, 'L-1')!, [], null, 'fail', now));
    expect(none.holds).toEqual([]);
    expect(hub.getClaim(P, hold.id).status).toBe('released');
  });
});
