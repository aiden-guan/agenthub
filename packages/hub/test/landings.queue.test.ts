import { HOLD_EXPIRES, LANDER_LEASE_KEY } from '@agenthub/contract';
import { describe, expect, it } from 'vitest';
import { startServer } from '../src/index.js';
import { phase1Landing } from '../src/landing-row.js';
import { A, B, C, HOUR, LANDER, LANDER_AUTH, MIN, P, STANDBY, errorOf, failLanding, setRunning, setup, sha } from './landing-setup.js';

// H2 (design §1.4 T0, T1, T15; §2.1 queueLanding): queue-mode land, replay,
// supersede, the retry chain, the advisory claim gate and record mode's refusal.

const LIVE = ['submitted', 'queued', 'needs_approval', 'running'] as const;

describe('queue-mode land', () => {
  it('queues the commit: the task goes to landing, the claims move into one hold, and the events follow in order', () => {
    const { hub, store, events, clock } = setup();
    hub.createTask(P, A, { title: 'Let login take an options object' });
    hub.takeTask(P, A, 'T-1');
    const c1 = hub.claim(P, A, { files: ['src/auth.ts', 'src/routes.ts'] }).claim!;
    const c2 = hub.claim(P, A, { files: ['migrations/0042.sql'] }).claim!;
    const before = events.length;

    const r = hub.land(P, A, {
      task_id: 'T-1',
      branch: 'maya/login-opts',
      commit: sha('3'),
      summary: 'login() takes an options object',
      queue: true,
      files: ['migrations/0042.sql', 'src/auth.ts', 'src/routes.ts'],
    });

    expect(r.replayed).toBe(false);
    expect(r.superseded).toEqual([]);
    expect(r.unblocked).toEqual([]);
    expect(r.task).toMatchObject({ id: 'T-1', status: 'landing', owner: A });
    expect(r.released.map((c) => [c.id, c.status, c.end_reason])).toEqual([
      [c1.id, 'released', 'moved to landing L-1'],
      [c2.id, 'released', 'moved to landing L-1'],
    ]);
    expect(r.held).toHaveLength(1);
    const hold = r.held[0];
    expect(hold).toMatchObject({
      holder: A,
      task_id: 'T-1',
      landing_id: 'L-1',
      mode: 'exclusive',
      status: 'active',
      intent: 'landing L-1: Let login take an options object',
      expires_at: HOLD_EXPIRES,
      ttl_ms: 60_000,
      granted_at: clock.t,
      mapper: null,
      scope: [{ file: 'migrations/0042.sql' }, { file: 'src/auth.ts' }, { file: 'src/routes.ts' }],
    });
    expect(r.landing).toMatchObject({
      id: 'L-1',
      status: 'submitted',
      agent: A,
      task_id: 'T-1',
      branch: 'maya/login-opts',
      commit: sha('3'),
      summary: 'login() takes an options object',
      queue_seq: 1,
      position: 1,
      eta_ms: null,
      attempt: 0,
      files: ['migrations/0042.sql', 'src/auth.ts', 'src/routes.ts'],
      hold_ids: [hold.id],
      retry: 0,
      retry_of: null,
      supersedes: null,
      created_at: clock.t,
      updated_at: clock.t,
    });
    expect(r.position).toBe(1);
    expect(r.eta_ms).toBeNull();
    expect(r.lander).toBeNull();
    expect(r.note).toContain('Submitted L-1 at position 1');
    expect(r.note).toContain('no lander is running');
    expect(r.note).toContain(`held by ${hold.id}`);
    expect(r.note).toContain("Don't amend");

    // The stored row is the one returned (but for the computed position).
    expect(store.getLanding(P, 'L-1')).toMatchObject({ ...r.landing, position: null, eta_ms: null });
    expect(hub.listTasks(P)[0]).toMatchObject({ status: 'landing', owner: A });

    const mine = events.slice(before);
    expect(mine.map((e) => e.type)).toEqual(['claim.released', 'claim.released', 'claim.granted', 'task.updated', 'landing.created']);
    expect(mine[0].data).toMatchObject({ claim_id: c1.id, reason: 'moved to landing L-1', landing_id: null, scope: c1.scope });
    expect(mine[2].data).toEqual({
      claim_id: hold.id,
      holder: A,
      files: ['migrations/0042.sql', 'src/auth.ts', 'src/routes.ts'],
      mode: 'exclusive',
      intent: hold.intent,
      task_id: 'T-1',
      landing_id: 'L-1',
      scope: hold.scope,
    });
    expect(mine[3].data).toEqual({ task_id: 'T-1', status: 'landing', previous: 'in_progress' });
    expect(mine[4]).toMatchObject({
      type: 'landing.created',
      actor: A,
      targets: null,
      data: { landing_id: 'L-1', agent: A, task_id: 'T-1', commit: sha('3'), position: 1, supersedes: null, retry_of: null },
    });
    // No agent-written text in the event.
    expect(JSON.stringify(mine[4].data)).not.toContain('options');
  });

  it('holds the advisory scope and the claims the Phase 1 rule selects, and leaves claims tied to other tasks alone', () => {
    const { hub, store } = setup();
    hub.createTask(P, A, { title: 'one' });
    hub.createTask(P, A, { title: 'two' });
    const early = hub.claim(P, A, { files: ['early.ts'] }).claim!; // no task: none was in progress
    hub.takeTask(P, A, 'T-1');
    const tied = hub.claim(P, A, { files: ['a.ts'] }).claim!;
    const other = hub.claim(P, A, { files: ['later.ts'], task_id: 'T-2' }).claim!;

    const r = hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true, files: ['b.ts'] });
    // early.ts goes too: no other task of A's is in progress.
    expect(r.released.map((c) => c.id)).toEqual([early.id, tied.id]);
    expect(r.held[0].scope).toEqual([{ file: 'a.ts' }, { file: 'b.ts' }, { file: 'early.ts' }]);
    expect(store.getClaim(P, other.id)).toMatchObject({ status: 'active', landing_id: null });

    // Without a task, every claim of the agent's moves into the hold.
    hub.claim(P, A, { files: ['c.ts'], task_id: 'T-2' });
    const all = hub.land(P, A, { commit: sha('2'), queue: true, branch: 'side' });
    expect(all.released.map((c) => c.id).sort()).toEqual([other.id, 'C-5'].sort());
    expect(all.held[0].scope).toEqual([{ file: 'c.ts' }, { file: 'later.ts' }]);

    // release_claims: false keeps the claims as they are; the hold covers the advisory files only.
    hub.takeTask(P, A, 'T-2');
    const kept = hub.claim(P, A, { files: ['d.ts'] }).claim!;
    const r3 = hub.land(P, A, { task_id: 'T-2', commit: sha('3'), queue: true, files: ['e.ts'], release_claims: false });
    expect(r3.released).toEqual([]);
    expect(r3.held[0].scope).toEqual([{ file: 'e.ts' }]);
    expect(store.getClaim(P, kept.id)!.status).toBe('active');
  });

  it('keeps symbol entries only with a mapper, and a whole-file entry covers the symbols of its file', () => {
    const { hub } = setup();
    const mapper = 'sym1;vtsw0.3.1;wts0.27.0;4be1c2d9';
    const r = hub.land(P, A, {
      commit: sha('1'),
      queue: true,
      branch: 'x',
      files: ['src/auth.ts', 'src/routes.ts', 'README.md'],
      scope: [{ file: 'src/auth.ts', symbol: 'login' }, { file: 'src/routes.ts', symbol: 'handleLogin' }, { file: 'src/routes.ts' }],
      mapper,
    });
    expect(r.landing).toMatchObject({ mapper, scope: [{ file: 'src/auth.ts', symbol: 'login' }, { file: 'src/routes.ts', symbol: 'handleLogin' }, { file: 'src/routes.ts' }] });
    expect(r.landing.files).toEqual(['src/auth.ts', 'src/routes.ts', 'README.md']);
    expect(r.held[0]).toMatchObject({ mapper, scope: [{ file: 'README.md' }, { file: 'src/auth.ts', symbol: 'login' }, { file: 'src/routes.ts' }] });

    expect(errorOf(() => hub.land(P, B, { commit: sha('2'), queue: true, scope: [{ file: 'a.ts', symbol: 'f' }] })).code).toBe('invalid_symbol');
    expect(errorOf(() => hub.land(P, B, { commit: sha('2'), queue: true, scope: [{ file: 'a.ts', symbol: 'a b' }], mapper })).code).toBe('invalid_symbol');
    expect(errorOf(() => hub.land(P, B, { commit: sha('2'), queue: true, scope: [{ file: 'a.ts', symbol: 'x'.repeat(201) }], mapper })).code).toBe('invalid_symbol');
    expect(errorOf(() => hub.land(P, B, { commit: sha('2'), queue: true, files: ['../x.ts'] })).code).toBe('invalid_path');
    expect(errorOf(() => hub.land(P, B, { commit: sha('2'), queue: true, files: 'a.ts' as unknown as string[] })).code).toBe('bad_request');
    expect(errorOf(() => hub.land(P, B, { commit: sha('2'), queue: true, files: Array.from({ length: 20_001 }, (_, i) => `f${i}.ts`) })).code).toBe('bad_request');
    expect(errorOf(() => hub.land(P, B, { commit: sha('2'), queue: 'yes' as unknown as boolean })).code).toBe('bad_request');
    expect(hub.land(P, B, { commit: sha('2'), queue: true, files: Array.from({ length: 300 }, (_, i) => `f${i}.ts`) }).held[0].scope).toHaveLength(300);
  });

  it('refuses a commit that is not a full lowercase sha (400 bad_commit) and creates nothing', () => {
    const { hub, events, store } = setup();
    hub.createTask(P, A, { title: 'x' });
    hub.takeTask(P, A, 'T-1');
    hub.claim(P, A, { files: ['a.ts'] });
    const before = events.length;
    for (const commit of [undefined, '', 'abc123', sha('A'), sha('g'), 'a'.repeat(39), 'a'.repeat(41), ` ${sha('a')}`]) {
      const err = errorOf(() => hub.land(P, A, { task_id: 'T-1', commit, queue: true }));
      expect([err.code, err.status]).toEqual(['bad_commit', 400]);
    }
    expect(events.length).toBe(before);
    expect(store.listLandings(P, { order: 'recent' })).toEqual([]);
    expect(hub.listTasks(P)[0].status).toBe('in_progress');
    // sha-256 object ids are full shas too.
    expect(hub.land(P, A, { task_id: 'T-1', commit: 'b'.repeat(64), queue: true }).landing.commit).toBe('b'.repeat(64));
  });

  it('replays a live landing of the same commit instead of making a second one', () => {
    const { hub, events } = setup();
    hub.createTask(P, A, { title: 'x' });
    hub.takeTask(P, A, 'T-1');
    hub.claim(P, A, { files: ['a.ts'] });
    const first = hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true, files: ['a.ts'] });
    const before = events.length;

    const again = hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true, files: ['a.ts', 'b.ts'], summary: 'other words' });
    expect(again.replayed).toBe(true);
    expect(again.landing).toEqual(first.landing);
    expect(again.held.map((c) => c.id)).toEqual(first.held.map((c) => c.id));
    expect(again.released).toEqual([]);
    expect(again.superseded).toEqual([]);
    expect(again.task).toMatchObject({ id: 'T-1', status: 'landing' });
    expect(again.note).toContain('L-1 already has this commit');
    expect(events.length).toBe(before);
    // Even without the task: (agent, commit) names the landing.
    expect(hub.land(P, A, { commit: sha('1'), queue: true }).landing.id).toBe('L-1');

    // Another agent's landing of the same commit is its own.
    expect(hub.land(P, B, { commit: sha('1'), queue: true, branch: 'b' })).toMatchObject({ replayed: false, landing: { id: 'L-2' } });

    // Once the landing is over, the same commit queues afresh.
    failLanding(hub, 'L-1');
    expect(hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true })).toMatchObject({ replayed: false, landing: { id: 'L-3', retry_of: 'L-1' } });
  });

  it('applies the Phase 1 task rules, and refuses a task another agent is landing (task_landing)', () => {
    const { hub, events, store } = setup();
    hub.createTask(P, A, { title: 'taken by B' }); // T-1
    hub.takeTask(P, B, 'T-1');
    hub.createTask(P, A, { title: 'done' }); // T-2
    hub.updateTask(P, A, 'T-2', 'done');
    hub.createTask(P, A, { title: 'cancelled' }); // T-3
    hub.updateTask(P, A, 'T-3', 'cancelled');
    hub.createTask(P, A, { title: 'blocked', deps: ['T-1'] }); // T-4
    hub.createTask(P, A, { title: 'landing' }); // T-5
    hub.takeTask(P, C, 'T-5');
    hub.land(P, C, { task_id: 'T-5', commit: sha('c'), queue: true });
    const before = events.length;

    const cases: Array<[string, string, number]> = [
      ['T-1', 'forbidden', 403],
      ['T-2', 'task_closed', 409],
      ['T-3', 'task_closed', 409],
      ['T-4', 'task_blocked', 409],
      ['T-5', 'task_landing', 409],
      ['T-99', 'not_found', 404],
    ];
    for (const [task, code, status] of cases) {
      const err = errorOf(() => hub.land(P, A, { task_id: task, commit: sha('a'), queue: true }));
      expect([task, err.code, err.status]).toEqual([task, code, status]);
    }
    expect(errorOf(() => hub.land(P, A, { task_id: 'T-5', commit: sha('a'), queue: true })).message).toContain('L-1');
    expect(events.length).toBe(before);
    expect(store.listLandings(P, { order: 'recent' }).map((l) => l.id)).toEqual(['L-1']);

    // An open, unowned task becomes the landing agent's.
    hub.createTask(P, A, { title: 'open' }); // T-6
    expect(hub.land(P, A, { task_id: 'T-6', commit: sha('a'), queue: true }).task).toMatchObject({ status: 'landing', owner: A });
  });

  it('a task in landing cannot be taken or updated, and new claims are no longer tied to it', () => {
    const { hub } = setup();
    hub.createTask(P, A, { title: 'x' });
    hub.takeTask(P, A, 'T-1');
    hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true });
    for (const agent of [A, B]) {
      const err = errorOf(() => hub.takeTask(P, agent, 'T-1'));
      expect([err.code, err.status]).toEqual(['task_landing', 409]);
      expect(err.message).toContain('L-1');
    }
    for (const status of ['done', 'open', 'cancelled'] as const) expect(errorOf(() => hub.updateTask(P, A, 'T-1', status)).code).toBe('task_landing');
    // Record mode can't complete it behind the landing's back either.
    expect(errorOf(() => hub.land(P, A, { task_id: 'T-1' })).code).toBe('task_landing');
    // The landing task is not in progress: a new claim ties to nothing, and status shows no current task.
    expect(hub.claim(P, A, { files: ['next.ts'] }).claim!.task_id).toBeNull();
    expect(hub.status(P, A).agents.find((a) => a.agent === A)!.current_task).toBeNull();
  });
});

describe('supersede', () => {
  it('a newer commit of the same task supersedes the live landing: holds move, queue_seq is inherited', () => {
    const { hub, store, events } = setup();
    hub.createTask(P, A, { title: 'login' });
    hub.takeTask(P, A, 'T-1');
    hub.claim(P, A, { files: ['src/auth.ts'] });
    const first = hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true, files: ['src/auth.ts'] });
    const hold = first.held[0];
    // B queues behind L-1.
    hub.land(P, B, { commit: sha('b'), queue: true, branch: 'sam' });
    // A keeps working on the task after landing: a new lease, then a new commit.
    const extra = hub.claim(P, A, { files: ['src/session.ts'] }).claim!;
    expect(extra.task_id).toBeNull();
    const before = events.length;

    const second = hub.land(P, A, { task_id: 'T-1', commit: sha('2'), queue: true, files: ['src/auth.ts', 'src/session.ts'] });
    expect(second.superseded).toEqual(['L-1']);
    expect(second.landing).toMatchObject({ id: 'L-3', supersedes: 'L-1', queue_seq: first.landing.queue_seq, position: 1, hold_ids: [hold.id] });
    expect(store.getLanding(P, 'L-1')).toMatchObject({ status: 'superseded', superseded_by: 'L-3', ended_at: second.now });
    // The hold is the same row, now L-3's, covering the new commit's files.
    expect(second.held).toEqual([expect.objectContaining({ id: hold.id, landing_id: 'L-3', intent: 'landing L-3: login', expires_at: hold.expires_at })]);
    expect(second.held[0].scope).toEqual([{ file: 'src/auth.ts' }, { file: 'src/session.ts' }]);
    expect(second.released.map((c) => [c.id, c.end_reason])).toEqual([[extra.id, 'moved to landing L-3']]);
    expect(hub.listTasks(P)[0]).toMatchObject({ status: 'landing', owner: A });

    const mine = events.slice(before);
    expect(mine.find((e) => e.type === 'landing.updated')).toMatchObject({
      data: { landing_id: 'L-1', agent: A, task_id: 'T-1', status: 'superseded', reason: 'superseded', position: null },
    });
    expect(mine.find((e) => e.type === 'landing.created')!.data).toMatchObject({ landing_id: 'L-3', supersedes: 'L-1', position: 1 });
    // The task was landing already: no task event.
    expect(mine.some((e) => e.type === 'task.updated')).toBe(false);
    // B is still behind A.
    expect(store.listLandings(P, { statuses: [...LIVE], order: 'queue' }).map((l) => l.id)).toEqual(['L-3', 'L-2']);
  });

  it('without a task, a newer commit of the same branch supersedes; without a branch either, nothing is superseded', () => {
    const { hub, store } = setup();
    hub.land(P, A, { commit: sha('1'), queue: true, branch: 'feature' });
    expect(hub.land(P, A, { commit: sha('2'), queue: true, branch: 'feature' }).superseded).toEqual(['L-1']);
    expect(hub.land(P, A, { commit: sha('3'), queue: true, branch: 'other' }).superseded).toEqual([]);
    expect(hub.land(P, A, { commit: sha('4'), queue: true }).superseded).toEqual([]);
    expect(hub.land(P, A, { commit: sha('5'), queue: true }).superseded).toEqual([]);
    expect(store.listLandings(P, { statuses: [...LIVE], order: 'queue' }).map((l) => l.id)).toEqual(['L-2', 'L-3', 'L-4', 'L-5']);
  });

  it('a running landing that is not pushing can be superseded; one in pushing answers 409 too_late and nothing changes', () => {
    const { hub, store, events, clock } = setup();
    hub.createTask(P, A, { title: 'x' });
    hub.takeTask(P, A, 'T-1');
    hub.claim(P, A, { files: ['a.ts'] });
    hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true });
    setRunning(hub, 'L-1', 'checking', clock.t);
    expect(hub.land(P, A, { task_id: 'T-1', commit: sha('2'), queue: true })).toMatchObject({ superseded: ['L-1'], landing: { id: 'L-2', queue_seq: 1 } });
    expect(store.getLanding(P, 'L-1')!.status).toBe('superseded');

    setRunning(hub, 'L-2', 'pushing', clock.t);
    const row = store.getLanding(P, 'L-2');
    const holds = hub.listClaims(P, { holder: A });
    const before = events.length;
    const err = errorOf(() => hub.land(P, A, { task_id: 'T-1', commit: sha('3'), queue: true }));
    expect([err.code, err.status]).toEqual(['too_late', 409]);
    expect(err.message).toContain('L-2');
    expect(store.getLanding(P, 'L-2')).toEqual(row);
    expect(hub.listClaims(P, { holder: A })).toEqual(holds);
    expect(events.length).toBe(before);
    expect(store.getLanding(P, 'L-3')).toBeNull();
  });
});

describe('retry chain', () => {
  it('a re-land after a send-back keeps the queue place for keep_place_retries retries, then goes to the back', () => {
    const { hub, store } = setup();
    hub.createTask(P, A, { title: 'x' });
    hub.takeTask(P, A, 'T-1');
    hub.claim(P, A, { files: ['a.ts'] });
    const l1 = hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true });
    expect(l1.landing.queue_seq).toBe(1);
    // B queues behind A.
    expect(hub.land(P, B, { commit: sha('b'), queue: true, branch: 'b' }).landing).toMatchObject({ id: 'L-2', queue_seq: 2, position: 2 });

    let previous = 'L-1';
    let commit = 2;
    for (const retry of [1, 2]) {
      failLanding(hub, previous);
      expect(hub.listTasks(P)[0]).toMatchObject({ status: 'in_progress', owner: A });
      const r = hub.land(P, A, { task_id: 'T-1', commit: sha(String(commit++)), queue: true });
      expect(r.landing).toMatchObject({ retry_of: previous, retry, queue_seq: 1, position: 1 });
      expect(r.note).toContain(`retry ${retry} of 2`);
      previous = r.landing.id;
    }
    failLanding(hub, previous);
    const third = hub.land(P, A, { task_id: 'T-1', commit: sha(String(commit++)), queue: true });
    expect(third.landing).toMatchObject({ retry_of: previous, retry: 3, queue_seq: 3, position: 2 });
    expect(third.note).toContain('back of the queue');
    expect(store.listLandings(P, { statuses: [...LIVE], order: 'queue' }).map((l) => l.id)).toEqual(['L-2', third.landing.id]);
  });

  it('follows the reported policy, and a send-back older than a day starts a new chain', () => {
    const { hub, store, advance, clock } = setup();
    hub.createTask(P, A, { title: 'x' });
    hub.takeTask(P, A, 'T-1');
    hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true });
    failLanding(hub, 'L-1');
    store.putLanderControl(P, { policy: { keep_place_retries: 0, sendback_grace_min: 30, approval_timeout_hours: 24, claim_gate: 'fail' } }, clock.t);
    expect(hub.land(P, A, { task_id: 'T-1', commit: sha('2'), queue: true }).landing).toMatchObject({ retry_of: 'L-1', retry: 1, queue_seq: 2 });
    failLanding(hub, 'L-2');
    advance(24 * HOUR + 1);
    expect(hub.land(P, A, { task_id: 'T-1', commit: sha('3'), queue: true }).landing).toMatchObject({ retry_of: null, retry: 0, queue_seq: 3 });
    // A chain is per task: a landing without one never retries another.
    failLanding(hub, 'L-3');
    expect(hub.land(P, A, { commit: sha('4'), queue: true, branch: 'b' }).landing).toMatchObject({ retry_of: null, retry: 0 });
  });

  it('a superseding landing inherits the chain of the landing it replaces', () => {
    const { hub } = setup();
    hub.createTask(P, A, { title: 'x' });
    hub.takeTask(P, A, 'T-1');
    hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true });
    failLanding(hub, 'L-1');
    hub.land(P, A, { task_id: 'T-1', commit: sha('2'), queue: true });
    expect(hub.land(P, A, { task_id: 'T-1', commit: sha('3'), queue: true }).landing).toMatchObject({ supersedes: 'L-2', retry_of: 'L-1', retry: 1, queue_seq: 1 });
  });
});

describe('the advisory claim gate', () => {
  it("fails with 409 claim_conflict naming the other agent's claim, and creates no landing or hold", () => {
    const { hub, store, events } = setup();
    const theirs = hub.claim(P, B, { files: ['src/x.ts', 'src/y.ts'], intent: 'refactor x' }).claim!;
    hub.createTask(P, A, { title: 'x' });
    hub.takeTask(P, A, 'T-1');
    const mine = hub.claim(P, A, { files: ['src/a.ts'] }).claim!;
    const before = events.length;

    const err = errorOf(() => hub.land(P, A, { task_id: 'T-1', commit: sha('1'), queue: true, files: ['src/a.ts', 'src/x.ts'] }));
    expect([err.code, err.status]).toEqual(['claim_conflict', 409]);
    expect(err.details).toEqual({
      conflicts: [
        {
          claim_id: theirs.id,
          holder: B,
          mode: 'exclusive',
          status: 'active',
          intent: 'refactor x',
          task_id: null,
          files: ['src/x.ts'],
          expires_at: theirs.expires_at,
          scope: [{ file: 'src/x.ts' }],
          landing_id: null,
        },
      ],
    });
    expect(err.message).toContain(`src/x.ts is claimed by ${B} (${theirs.id})`);
    expect(err.message).not.toContain('refactor');
    expect(events.length).toBe(before);
    expect(store.listLandings(P, { order: 'recent' })).toEqual([]);
    expect(store.getClaim(P, mine.id)).toMatchObject({ status: 'active', landing_id: null });
    expect(hub.listTasks(P)[0].status).toBe('in_progress');
    expect(hub.listClaims(P).filter((c) => c.landing_id !== null)).toEqual([]);
  });

  it("another landing's hold is a conflict too, and names that landing", () => {
    const { hub } = setup();
    hub.land(P, B, { commit: sha('b'), queue: true, branch: 'b', files: ['src/y.ts'] });
    const err = errorOf(() => hub.land(P, A, { commit: sha('a'), queue: true, branch: 'a', files: ['src/y.ts'] }));
    expect(err.code).toBe('claim_conflict');
    expect(err.details!.conflicts).toEqual([expect.objectContaining({ holder: B, landing_id: 'L-1', files: ['src/y.ts'] })]);
    expect(err.message).toContain(`src/y.ts is being landed by L-1 (${B}, position 1)`);
  });

  it("the agent's own claims, others' queued claims and shared claims don't block it", () => {
    const { hub } = setup();
    hub.claim(P, A, { files: ['a.ts'] });
    // C waits for a.ts: queued claims of others are not gate blockers.
    expect(hub.claim(P, C, { files: ['a.ts'], queue: true }).status).toBe('queued');
    hub.claim(P, B, { files: ['CHANGELOG.md'], mode: 'shared' });
    hub.claim(P, A, { files: ['NOTES.md'], mode: 'shared' });
    hub.claim(P, B, { files: ['NOTES.md'], mode: 'shared' });
    const r = hub.land(P, A, { commit: sha('1'), queue: true, branch: 'a', files: ['a.ts', 'CHANGELOG.md', 'NOTES.md'] });
    // Shared where B holds it shared (auto) or A held it shared; exclusive otherwise.
    expect(r.held.map((h) => [h.mode, h.scope])).toEqual([
      ['exclusive', [{ file: 'a.ts' }]],
      ['shared', [{ file: 'CHANGELOG.md' }, { file: 'NOTES.md' }]],
    ]);
    expect(r.landing.hold_ids).toEqual(r.held.map((h) => h.id));
  });

  it('in warn mode the landing goes ahead without the conflicting entries, and the note says so', () => {
    const { hub, store, clock } = setup();
    store.putLanderControl(P, { policy: { keep_place_retries: 2, sendback_grace_min: 30, approval_timeout_hours: 24, claim_gate: 'warn' } }, clock.t);
    const theirs = hub.claim(P, B, { files: ['src/x.ts'] }).claim!;
    hub.claim(P, A, { files: ['src/a.ts'] });
    const r = hub.land(P, A, { commit: sha('1'), queue: true, branch: 'a', files: ['src/a.ts', 'src/x.ts'] });
    expect(r.landing.status).toBe('submitted');
    expect(r.held.map((h) => h.scope)).toEqual([[{ file: 'src/a.ts' }]]);
    expect(r.note).toContain(`not held: src/x.ts (claimed by ${B}, ${theirs.id})`);
    // B keeps its claim.
    expect(store.getClaim(P, theirs.id)!.status).toBe('active');
    // Everything conflicting: the landing has no hold at all.
    const r2 = hub.land(P, A, { commit: sha('2'), queue: true, branch: 'b', files: ['src/x.ts'] });
    expect(r2.held).toEqual([]);
    expect(r2.landing.hold_ids).toEqual([]);
  });
});

describe('record mode', () => {
  it('keeps working while no lander ever existed, and answers 409 landing_queue_active once one has', () => {
    const { hub, store, events } = setup();
    hub.createTask(P, A, { title: 'x' });
    hub.takeTask(P, A, 'T-1');
    hub.claim(P, A, { files: ['a.ts'] });
    expect(hub.land(P, A, { task_id: 'T-1', commit: 'abc123' })).toMatchObject({ landing: { status: 'recorded' }, task: { status: 'done' } });
    // Queue mode next to it doesn't close record mode.
    hub.land(P, B, { commit: sha('b'), queue: true, branch: 'b' });
    expect(hub.land(P, A, { summary: 'docs' }).landing.status).toBe('recorded');

    // A lander lease claim, even one released since, closes it for good.
    const lease = hub.claim(P, LANDER, { files: [LANDER_LEASE_KEY], intent: 'lander on build1' }, LANDER_AUTH).claim!;
    hub.release(P, LANDER, { claim_id: lease.id });
    hub.createTask(P, A, { title: 'y' });
    hub.takeTask(P, A, 'T-2');
    hub.claim(P, A, { files: ['b.ts'] });
    const before = events.length;
    const err = errorOf(() => hub.land(P, A, { task_id: 'T-2', commit: 'def456' }));
    expect([err.code, err.status]).toEqual(['landing_queue_active', 409]);
    expect(err.message).toContain('hub land');
    expect(events.length).toBe(before);
    expect(hub.listTasks(P).find((t) => t.id === 'T-2')!.status).toBe('in_progress');
    expect(hub.listClaims(P, { holder: A }).map((c) => c.scope[0].file)).toEqual(['b.ts']);
    expect(store.listLandings(P, { order: 'recent' })).toHaveLength(3);
    // Queue mode still works, and so does record mode in another project.
    expect(hub.land(P, A, { task_id: 'T-2', commit: sha('2'), queue: true }).landing.status).toBe('submitted');
    expect(hub.land('other', A, { summary: 'x' }).landing.status).toBe('recorded');
  });

  it("record mode never releases another landing's holds", () => {
    const { hub } = setup();
    hub.land(P, A, { commit: sha('1'), queue: true, branch: 'a', files: ['held.ts'] });
    hub.claim(P, A, { files: ['lease.ts'] });
    const r = hub.land(P, A, { summary: 'record' });
    expect(r.released.map((c) => c.scope[0].file)).toEqual(['lease.ts']);
    expect(hub.listClaims(P, { holder: A })).toEqual([expect.objectContaining({ landing_id: 'L-1', status: 'active' })]);
  });
});

describe('position, ETA and lander', () => {
  it('counts submitted and queued landings ahead, a running one too, and estimates from recent attempts once a lander runs', () => {
    const { hub, store, clock, advance } = setup();
    // Synthetic history: finished attempts of 2, 3 and 4 minutes (median 3 min).
    const t = clock.t - HOUR;
    [2, 3, 4].forEach((m, i) =>
      store.insertLanding({
        ...phase1Landing({ id: `L-${i + 1}`, project: P, agent: C, task_id: null, branch: null, commit: sha('9'), summary: '', status: 'landed', created_at: t }),
        started_at: t,
        ended_at: t + m * MIN,
      }),
    );
    for (let i = 0; i < 3; i++) store.nextCounter(P, 'landing');

    // No lander: no ETA, and the note says nothing lands yet.
    const first = hub.land(P, A, { commit: sha('1'), queue: true, branch: 'a' });
    expect(first).toMatchObject({ position: 1, eta_ms: null, lander: null, landing: { id: 'L-4', position: 1, eta_ms: null } });

    const lease = hub.claim(P, LANDER, { files: [LANDER_LEASE_KEY], ttl_ms: 10 * MIN }, LANDER_AUTH).claim!;
    hub.claim(P, STANDBY, { files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 10 * MIN }, LANDER_AUTH);
    const second = hub.land(P, B, { commit: sha('2'), queue: true, branch: 'b' });
    expect(second.lander).toEqual({ holder: LANDER, claim_id: lease.id, expires_at: lease.expires_at, standby: [STANDBY] });
    expect(second).toMatchObject({ position: 2, eta_ms: 6 * MIN, landing: { position: 2, eta_ms: 6 * MIN } });
    expect(second.note).toContain('about 6 min');

    // L-4 runs, started a minute ago: it counts as ahead, with what is left of a median attempt.
    setRunning(hub, 'L-4', 'checking', clock.t);
    advance(MIN);
    const third = hub.land(P, C, { commit: sha('3'), queue: true, branch: 'c' });
    expect(third).toMatchObject({ position: 3, eta_ms: 2 * MIN + 3 * MIN + 3 * MIN });
  });
});

describe('over HTTP', () => {
  it('POST /land queues the commit, and a claim_conflict carries details.conflicts in the error body', async () => {
    const { hub } = setup();
    const server = await startServer({ hub, port: 0 });
    try {
      const post = async (agent: string, route: string, body: unknown) => {
        const res = await fetch(`${server.url}/v1/p/${P}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-agent': agent }, body: JSON.stringify(body) });
        return { status: res.status, json: (await res.json()) as Record<string, any> };
      };
      expect((await post(B, '/claims', { files: ['src/x.ts'] })).status).toBe(200);
      const queued = await post(A, '/land', { commit: sha('1'), queue: true, branch: 'a', files: ['src/a.ts'] });
      expect(queued.status).toBe(200);
      expect(queued.json).toMatchObject({ replayed: false, position: 1, landing: { id: 'L-1', status: 'submitted' }, held: [{ landing_id: 'L-1' }] });

      const refused = await post(A, '/land', { commit: sha('2'), queue: true, branch: 'b', files: ['src/x.ts'] });
      expect(refused.status).toBe(409);
      expect(refused.json.error).toMatchObject({ code: 'claim_conflict', details: { conflicts: [{ claim_id: 'C-1', holder: B, files: ['src/x.ts'], landing_id: null }] } });
      // Other errors carry no details.
      const bad = await post(A, '/land', { commit: 'abc', queue: true });
      expect(bad).toMatchObject({ status: 400, json: { error: { code: 'bad_commit' } } });
      expect(bad.json.error).not.toHaveProperty('details');
    } finally {
      await server.close();
    }
  });
});
