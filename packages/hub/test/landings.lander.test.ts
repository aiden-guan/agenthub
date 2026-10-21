import { describe, expect, it } from 'vitest';
import { NO_AUTH, type ApprovalKind, type ApprovalRequirement, type ApprovalRule, type LandPolicy } from '../src/index.js';
import { phase1Landing } from '../src/landing-row.js';
import {
  A,
  B,
  C,
  HOUR,
  LANDER,
  LANDER_AUTH,
  MIN,
  P,
  STANDBY,
  approverAuth,
  errorOf,
  failLanding,
  passedReport,
  report,
  setup,
  sha,
  takeLease,
} from './landing-setup.js';

// H3 (design §1.4 T2-T16, §1.5, §2.1): the lander protocol. Admission,
// next, the fenced and attempt-checked advance with replay detection, the
// in-doubt rule, approvals, cancel, deadlines, trunk reports, pause and
// resume, status and stats. Fake clock, in-memory store.

const POLICY: LandPolicy = { keep_place_retries: 2, sendback_grace_min: 30, approval_timeout_hours: 24, claim_gate: 'fail' };
const DAY = 24 * HOUR;
/** A content digest (sha256 hex) made of one repeated hex digit. */
const dig = (c: string) => c.repeat(64);
const RULE: ApprovalRule = { paths: ['migrations/**'], approvers: null, distinct: true };

function requirement(digest: string, rules: ApprovalRule[] = [RULE], paths = ['migrations/0042.sql'], kind: ApprovalKind = 'protected'): ApprovalRequirement {
  return { kind, digest, paths, rules, candidate: null, candidate_ref: null, trunk_base: null };
}

function codeOf(fn: () => unknown): [string, number] {
  const err = errorOf(fn);
  return [err.code, err.status];
}

/** A hub with an active lander lease (C-1, a day long) and the calls a lander makes. */
function world() {
  const s = setup();
  const { hub } = s;
  const lease = takeLease(hub, LANDER, DAY);
  const L = lease.lease;
  /** `agent` takes a new task (or `task`), claims `files` and queues `commit` for it. */
  const land = (agent: string, files: string[], commit: string, o: { task?: string; title?: string } = {}) => {
    let task = o.task;
    if (!task) {
      task = hub.createTask(P, agent, { title: o.title ?? `work on ${files[0] ?? 'nothing'}` }).id;
      hub.takeTask(P, agent, task);
    }
    if (files.length > 0) hub.claim(P, agent, { files });
    return hub.land(P, agent, { task_id: task, commit, queue: true, files });
  };
  const admit = (id: string, files: string[], extra: Record<string, unknown> = {}) =>
    hub.admitLanding(P, LANDER, id, { lease: L, base_sha: sha('0'), files, scope: null, mapper: null, protected: [], required: [], waits_for: null, warnings: [], ...extra } as never, LANDER_AUTH);
  const next = () => hub.nextLanding(P, LANDER, { lease: L }, LANDER_AUTH);
  const advance = (id: string, req: Record<string, unknown>) => hub.advanceLanding(P, LANDER, id, { lease: L, attempt: 1, ...req } as never, LANDER_AUTH);
  const phase = (id: string, to: string, extra: Record<string, unknown> = {}) => advance(id, { to: 'running', phase: to, deadline_ms: 10 * MIN, ...extra });
  const pushing = (id: string, extra: Record<string, unknown> = {}) =>
    advance(id, { to: 'running', phase: 'pushing', candidate: sha('c'), candidate_ref: `refs/agenthub/cand/x/${id}/cccccccccccc`, trunk_base: sha('a'), tree: sha('e'), required: [], ...extra });
  const landed = (id: string, extra: Record<string, unknown> = {}) =>
    advance(id, { to: 'landed', trunk_sha: sha('c'), base_sha: sha('0'), files: hub.getLanding(P, id).files, report: report(`${id} landed.`), also_landed: [], symbol_changes: [], ...extra });
  const resolve = (id: string, req: Record<string, unknown>, lease = L, agent = LANDER) => hub.resolveLanding(P, agent, id, { lease, ...req } as never, LANDER_AUTH);
  const trunk = (req: Record<string, unknown>) =>
    hub.reportTrunk(P, LANDER, { lease: L, from: null, to: sha('a'), commits: [], rewritten: false, policy: POLICY, ...req } as never, LANDER_AUTH);
  const approve = (id: string, digest: string, who: string, kind: ApprovalKind = 'protected', note?: string) => hub.approveLanding(P, id, { kind, digest, note }, approverAuth(who));
  return { ...s, tick: s.advance, lease, L, land, admit, next, advance, phase, pushing, landed, resolve, trunk, approve };
}

describe('admission (T2, T3)', () => {
  it('admits a submitted landing: its holds shrink to the exact scope, and a waiter on what they no longer hold is granted', () => {
    const w = world();
    const r = w.land(A, ['a.ts', 'b.ts'], sha('1'));
    const hold = r.held[0];
    const waiter = w.hub.claim(P, B, { files: ['b.ts'], queue: true });
    expect(waiter.status).toBe('queued');
    const before = w.events.length;
    const res = w.admit('L-1', ['a.ts'], { base_sha: sha('9') });
    expect(res.conflicts).toEqual([]);
    expect(res.landing).toMatchObject({ id: 'L-1', status: 'queued', base_sha: sha('9'), files: ['a.ts'], scope: null, mapper: null, approval: [], hold_ids: [hold.id], queue_seq: 1, position: 1 });
    expect(res.landing).not.toHaveProperty('seq');
    expect(w.hub.getClaim(P, hold.id)).toMatchObject({ status: 'active', landing_id: 'L-1', scope: [{ file: 'a.ts' }] });
    expect(w.hub.getClaim(P, waiter.claim!.id).status).toBe('active');
    const mine = w.events.slice(before);
    expect(mine.map((e) => e.type)).toEqual(['claim.released', 'landing.updated', 'claim.granted']);
    expect(mine[0].data).toMatchObject({ claim_id: hold.id, files: ['b.ts'], partial: true, landing_id: 'L-1' });
    expect(mine[1]).toMatchObject({ actor: LANDER, targets: null, data: { landing_id: 'L-1', agent: A, task_id: 'T-1', status: 'queued', phase: null, attempt: 0, reason: 'admitted', position: 1 } });
    expect(mine[2].data).toMatchObject({ claim_id: waiter.claim!.id, from_queue: true });
  });

  it('admitting again is a replay; a terminal landing answers 409 landing_closed, an unknown one 404', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.admit('L-1', ['a.ts']);
    const before = w.events.length;
    expect(w.admit('L-1', ['a.ts', 'other.ts'], { base_sha: sha('8') }).landing).toMatchObject({ status: 'queued', files: ['a.ts'], base_sha: sha('0') });
    expect(w.events.length).toBe(before);
    w.hub.cancelLanding(P, A, 'L-1', {});
    expect(codeOf(() => w.admit('L-1', ['a.ts']))).toEqual(['landing_closed', 409]);
    expect(codeOf(() => w.admit('L-9', ['a.ts']))).toEqual(['not_found', 404]);
    expect(codeOf(() => w.admit('L-1', ['a.ts'], { base_sha: 'abc' }))).toEqual(['bad_request', 400]);
  });

  it("the gate fails the landing (claim_conflict) when the exact scope overlaps another agent's claim; the holds go back to the agent", () => {
    const w = world();
    const r = w.land(A, ['a.ts'], sha('1'));
    const hold = r.held[0];
    const theirs = w.hub.claim(P, B, { files: ['c.ts'], intent: 'do not show this' }).claim!;
    const before = w.events.length;
    const res = w.admit('L-1', ['a.ts', 'c.ts']);
    expect(res.conflicts).toEqual([expect.objectContaining({ claim_id: theirs.id, holder: B, files: ['c.ts'], scope: [{ file: 'c.ts' }], landing_id: null })]);
    expect(res.landing).toMatchObject({ status: 'failed', failure: { code: 'claim_conflict' }, files: ['a.ts', 'c.ts'], base_sha: sha('0'), ended_at: w.clock.t, position: null });
    expect(res.landing.failure!.summary).toContain('c.ts');
    expect(res.landing.failure!.summary).toContain(B);
    expect(res.landing.failure!.summary).not.toContain('do not show');
    expect(w.hub.getClaim(P, hold.id)).toMatchObject({ status: 'active', landing_id: null, expires_at: w.clock.t + 30 * MIN, scope: [{ file: 'a.ts' }] });
    expect(w.hub.listTasks(P)[0]).toMatchObject({ status: 'in_progress', owner: A });
    const mine = w.events.slice(before);
    expect(mine.map((e) => e.type)).toEqual(['claim.granted', 'task.updated', 'landing.failed']);
    expect(mine[2]).toMatchObject({ actor: LANDER, data: { landing_id: 'L-1', agent: A, task_id: 'T-1', code: 'claim_conflict', files: ['a.ts', 'c.ts'] } });
  });

  it('with claim_gate warn the conflicting entries are left out of the holds, and the landing is queued', () => {
    const w = world();
    w.trunk({ policy: { ...POLICY, claim_gate: 'warn' } });
    const r = w.land(A, ['a.ts'], sha('1'));
    const theirs = w.hub.claim(P, B, { files: ['c.ts'] }).claim!;
    const res = w.admit('L-1', ['a.ts', 'c.ts']);
    expect(res.landing.status).toBe('queued');
    expect(res.conflicts.map((c) => c.claim_id)).toEqual([theirs.id]);
    expect(w.hub.getClaim(P, r.held[0].id).scope).toEqual([{ file: 'a.ts' }]);
  });

  it('asks for approvals at once: what is still needed is pending, and approvers hear of it (needs_approval, parked false)', () => {
    const w = world();
    w.land(A, ['migrations/0042.sql', 'src/a.ts'], sha('1'));
    const r1 = requirement(dig('1'), [{ paths: ['migrations/**'], approvers: ['sam', 'lee'], distinct: true }]);
    const r2 = requirement(dig('2'), [{ paths: ['agenthub.json', '.gitattributes'], approvers: null, distinct: true }], ['agenthub.json']);
    const before = w.events.length;
    const res = w.admit('L-1', ['agenthub.json', 'migrations/0042.sql', 'src/a.ts'], { protected: ['agenthub.json', 'migrations/0042.sql'], required: [r1, r2] });
    expect(res.landing).toMatchObject({ status: 'queued', protected: ['agenthub.json', 'migrations/0042.sql'], approval: [r1, r2], approvals: [] });
    const asked = w.events.slice(before).filter((e) => e.type === 'landing.needs_approval');
    expect(asked.map((e) => [e.actor, e.data])).toEqual([
      [LANDER, { landing_id: 'L-1', agent: A, task_id: 'T-1', kinds: ['protected'], paths: ['agenthub.json', 'migrations/0042.sql'], approvers: null, parked: false }],
    ]);
    // Rules that name their approvers: the union of them.
    w.land(B, ['migrations/0043.sql'], sha('2'));
    const named = requirement(dig('3'), [{ paths: ['migrations/**'], approvers: ['maya'], distinct: true }, { paths: ['**/*.sql'], approvers: ['lee', 'maya'], distinct: false }], ['migrations/0043.sql']);
    w.admit('L-2', ['migrations/0043.sql'], { required: [named] });
    expect(w.events.at(-1)).toMatchObject({ type: 'landing.needs_approval', data: { landing_id: 'L-2', approvers: ['maya', 'lee'], parked: false } });
    // Bad requirements are refused.
    w.land(C, ['x.sql'], sha('3'));
    expect(codeOf(() => w.admit('L-3', ['x.sql'], { required: [{ ...named, kind: 'other' }] }))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.admit('L-3', ['x.sql'], { required: [{ ...named, rules: [] }] }))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.admit('L-3', ['x.sql'], { required: [{ ...named, digest: 'not hex' }] }))).toEqual(['bad_request', 400]);
  });

  it('carries an approval along the retry and supersede chain while its digest is unchanged', () => {
    const w = world();
    const r1 = requirement(dig('1'));
    w.land(A, ['migrations/0042.sql'], sha('1'));
    w.admit('L-1', ['migrations/0042.sql'], { required: [r1] });
    w.approve('L-1', dig('1'), 'sam', 'protected', 'additive, safe');
    const approvedAt = w.clock.t;
    w.next();
    w.advance('L-1', { to: 'failed', code: 'checks_failed', report: report('L-1 came back: the checks failed.') });
    w.tick(MIN);
    // A fixes the test and lands T-1 again: a retry of L-1.
    w.land(A, ['migrations/0042.sql'], sha('2'), { task: 'T-1' });
    const r2 = requirement(dig('2'), [RULE], ['migrations/0043.sql']);
    const res = w.admit('L-2', ['migrations/0042.sql', 'migrations/0043.sql'], { required: [r1, r2] });
    expect(res.landing).toMatchObject({ retry_of: 'L-1', approval: [r2] });
    expect(res.landing.approvals).toEqual([{ kind: 'protected', digest: dig('1'), by: 'sam', at: approvedAt, note: 'additive, safe', carried_from: 'L-1' }]);
    // L-3 supersedes L-2 while it waits: the approval goes on, still naming where it was given.
    w.land(A, ['migrations/0042.sql'], sha('3'), { task: 'T-1' });
    const res3 = w.admit('L-3', ['migrations/0042.sql'], { required: [r1] });
    expect(res3.landing).toMatchObject({ supersedes: 'L-2', approval: [], approvals: [expect.objectContaining({ by: 'sam', digest: dig('1'), carried_from: 'L-1' })] });
    // Another task's landing is no chain: nothing carries over.
    w.land(A, ['migrations/0044.sql'], sha('4'));
    expect(w.admit('L-4', ['migrations/0044.sql'], { required: [r1] }).landing).toMatchObject({ approval: [r1], approvals: [] });
  });

  it('T3: an admission failure ends a submitted landing and gives its claims back, through advance (attempt 0) or admit', () => {
    const w = world();
    const r = w.land(A, ['a.ts'], sha('1'));
    const message = "L-1 came back: refs/agenthub/land/1111111111111111111111111111111111111111 isn't on the remote.\nPush it again: call land.";
    const res = w.advance('L-1', { attempt: 0, to: 'failed', code: 'not_pushed', report: report(message) });
    expect(res.landing).toMatchObject({
      status: 'failed',
      attempt: 0,
      failure: { code: 'not_pushed', summary: "L-1 came back: refs/agenthub/land/1111111111111111111111111111111111111111 isn't on the remote." },
      report: { message },
    });
    expect(res.released).toEqual([expect.objectContaining({ id: r.held[0].id, landing_id: null })]);
    expect(w.advance('L-1', { attempt: 0, to: 'failed', code: 'not_pushed', report: report(message) }).replayed).toBe(true);

    w.land(B, ['b.ts'], sha('2'));
    const viaAdmit = w.admit('L-2', [], { code: 'nothing_to_land', report: report('L-2 has nothing to land.') });
    expect(viaAdmit.landing).toMatchObject({ status: 'failed', failure: { code: 'nothing_to_land', summary: 'L-2 has nothing to land.' } });

    // An admitted landing is not failed that way: that would skip attempt fencing.
    w.land(C, ['c.ts'], sha('3'));
    w.admit('L-3', ['c.ts']);
    expect(codeOf(() => w.advance('L-3', { attempt: 0, to: 'failed', code: 'not_pushed', report: report() }))).toEqual(['landing_stale', 409]);
  });
});

describe('next (T4)', () => {
  it('picks the lowest queue_seq: running in merging, attempt 1, under this lease, with a 10 minute deadline', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.land(B, ['b.ts'], sha('2'));
    w.land(C, ['c.ts'], sha('3')); // stays submitted
    w.admit('L-2', ['b.ts']);
    w.admit('L-1', ['a.ts']);
    expect(w.hub.getLanding(P, 'L-2').position).toBe(2);
    const before = w.events.length;
    const r = w.next();
    expect(r).toMatchObject({
      resolve: false,
      control: { paused: null, trunk: null, policy: POLICY },
      landing: { id: 'L-1', status: 'running', phase: 'merging', phase_at: w.clock.t, attempt: 1, lander: LANDER, lease_claim_id: w.lease.claim.id, in_doubt: false, started_at: w.clock.t, deadline_at: w.clock.t + 10 * MIN, position: null },
    });
    expect(w.events.slice(before).map((e) => [e.type, e.actor, e.data])).toEqual([
      ['landing.updated', LANDER, { landing_id: 'L-1', agent: A, task_id: 'T-1', status: 'running', phase: 'merging', attempt: 1, reason: 'picked', position: null }],
    ]);
    // The running landing counts as ahead.
    expect([w.hub.getLanding(P, 'L-2').position, w.hub.getLanding(P, 'L-3').position]).toEqual([2, 3]);
    // While it runs, next returns it again and starts nothing else.
    expect(w.next()).toMatchObject({ resolve: false, landing: { id: 'L-1', attempt: 1 } });
    expect(w.events.length).toBe(before + 1);
    // The database itself allows one running landing per project.
    expect(() => w.store.updateLanding(P, 'L-2', { status: 'running' })).toThrow();
  });

  it('skips a landing whose waits_for is live, and starts nothing while paused or when nothing is queued', () => {
    const w = world();
    expect(w.next()).toMatchObject({ landing: null, resolve: false });
    w.land(A, ['a.ts'], sha('1')); // stays submitted
    w.land(A, ['b.ts'], sha('2')); // A's next task, on top of L-1's commit
    w.land(B, ['c.ts'], sha('3'));
    w.admit('L-2', ['b.ts'], { waits_for: 'L-1' });
    w.admit('L-3', ['c.ts']);
    expect(w.hub.getLanding(P, 'L-2').waits_for).toBe('L-1');
    expect(w.next().landing!.id).toBe('L-3');
    w.landed('L-3');
    expect(w.next().landing).toBeNull();
    w.hub.cancelLanding(P, A, 'L-1', {});
    w.hub.pauseLander(P, LANDER, { lease: w.L, reason: 'config_invalid', detail: 'agenthub.json: "land.check" is required' }, LANDER_AUTH);
    expect(w.next()).toMatchObject({ landing: null, control: { paused: { reason: 'config_invalid', by: LANDER } } });
    w.hub.resumeLander(P, {}, approverAuth('maya'));
    expect(w.next().landing).toMatchObject({ id: 'L-2', attempt: 1 });
    expect(codeOf(() => w.admit('L-3', ['c.ts']))).toEqual(['landing_closed', 409]);
    w.land(C, ['d.ts'], sha('4'));
    expect(codeOf(() => w.admit('L-4', ['d.ts'], { waits_for: 'L-99' }))).toEqual(['bad_request', 400]);
  });
});

describe('advance (T5, T6, T9, T11, T13)', () => {
  it('moves through the phases: trunk_base sets first_base once, deadlines are clamped to 1 min to 6 h, and a repeat is a replay', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.admit('L-1', ['a.ts']);
    w.next();
    const before = w.events.length;
    const m = w.phase('L-1', 'merging', { trunk_base: sha('a'), deadline_ms: 10 * MIN });
    expect(m).toMatchObject({ replayed: false, released: [], unblocked: [], landing: { phase: 'merging', trunk_base: sha('a'), first_base: sha('a'), deadline_at: w.clock.t + 10 * MIN } });
    expect(w.events.length).toBe(before); // the same phase: no event
    expect(w.phase('L-1', 'merging', { trunk_base: sha('a') }).replayed).toBe(true);
    w.tick(MIN);
    expect(w.phase('L-1', 'resolving', { deadline_ms: 1000 }).landing).toMatchObject({ phase: 'resolving', phase_at: w.clock.t, deadline_at: w.clock.t + MIN, trunk_base: sha('a') });
    expect(w.phase('L-1', 'checking', { deadline_ms: 30 * DAY }).landing.deadline_at).toBe(w.clock.t + 6 * HOUR);
    expect(w.events.slice(before).map((e) => [e.type, e.data.phase, e.data.reason])).toEqual([
      ['landing.updated', 'resolving', 'phase'],
      ['landing.updated', 'checking', 'phase'],
    ]);
    expect(codeOf(() => w.phase('L-1', 'merging'))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.phase('L-1', 'checking', { deadline_ms: 'soon' }))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.advance('L-1', { to: 'elsewhere' }))).toEqual(['bad_request', 400]);
    // A second attempt merges onto a newer trunk; first_base stays the first attempt's.
    w.advance('L-1', { to: 'queued', reason: 'trunk_moved' });
    w.next();
    expect(w.phase('L-1', 'merging', { attempt: 2, trunk_base: sha('b') }).landing).toMatchObject({ attempt: 2, trunk_base: sha('b'), first_base: sha('a') });
  });

  it('into pushing: the staged candidate and every required approval are needed (409 approval_missing); the write is durable and has no deadline', () => {
    const w = world();
    const r1 = requirement(dig('1'));
    w.land(A, ['migrations/0042.sql'], sha('1'));
    w.admit('L-1', ['migrations/0042.sql'], { required: [r1] });
    w.next();
    w.phase('L-1', 'checking', { trunk_base: sha('a') });
    const missing = errorOf(() => w.pushing('L-1', { required: [r1] }));
    expect([missing.code, missing.status, missing.details]).toEqual(['approval_missing', 409, { missing: [r1] }]);
    // The hub holds to its own pending list, whatever the lander sends.
    expect(errorOf(() => w.pushing('L-1')).details).toEqual({ missing: [r1] });
    expect(w.hub.getLanding(P, 'L-1').phase).toBe('checking');
    w.approve('L-1', dig('1'), 'sam');
    const merged: ApprovalRequirement = { ...requirement(dig('2'), [RULE], ['migrations/0042.sql'], 'merged'), candidate: sha('c'), candidate_ref: 'refs/agenthub/cand/x/L-1/cccccccccccc', trunk_base: sha('a') };
    expect(errorOf(() => w.pushing('L-1', { required: [r1, merged] })).details).toEqual({ missing: [merged] });
    expect(codeOf(() => w.pushing('L-1', { candidate: 'abc' }))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.advance('L-1', { to: 'running', phase: 'pushing', trunk_base: sha('a'), tree: sha('e'), required: [] }))).toEqual(['bad_request', 400]);

    const durable: boolean[] = [];
    const tx = w.store.transaction.bind(w.store);
    w.store.transaction = ((fn: () => unknown, opts?: { durable?: boolean }) => {
      durable.push(opts?.durable === true);
      return tx(fn, opts);
    }) as typeof w.store.transaction;
    const before = w.events.length;
    const p = w.pushing('L-1', { required: [r1] });
    expect(durable).toEqual([true]);
    expect(p).toMatchObject({
      replayed: false,
      landing: { status: 'running', phase: 'pushing', candidate: sha('c'), candidate_ref: 'refs/agenthub/cand/x/L-1/cccccccccccc', trunk_base: sha('a'), first_base: sha('a'), deadline_at: null, in_doubt: false },
    });
    expect(w.events.slice(before).map((e) => [e.type, e.data.phase, e.data.reason])).toEqual([['landing.updated', 'pushing', 'phase']]);
    // A repeat is a replay. From pushing only landed (or resolve) moves it on.
    expect(w.pushing('L-1', { required: [r1] }).replayed).toBe(true);
    expect(codeOf(() => w.phase('L-1', 'checking'))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.advance('L-1', { to: 'queued', reason: 'trunk_moved' }))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.advance('L-1', { to: 'failed', code: 'checks_failed', report: report() }))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.advance('L-1', { to: 'needs_approval', required: [r1], report: passedReport() }))).toEqual(['bad_request', 400]);
    // Nobody can pull it out from under the push.
    expect(codeOf(() => w.hub.cancelLanding(P, A, 'L-1', {}))).toEqual(['too_late', 409]);
    expect(codeOf(() => w.land(A, ['migrations/0042.sql'], sha('2'), { task: 'T-1' }))).toEqual(['too_late', 409]);
  });

  it('parks a checked landing that still needs an approval (T6): the slot is freed, and an approval queues it again in its place (T7)', () => {
    const w = world();
    const r1 = requirement(dig('1'));
    w.land(A, ['migrations/0042.sql'], sha('1'));
    w.land(B, ['b.ts'], sha('2'));
    w.admit('L-1', ['migrations/0042.sql'], { required: [r1] });
    w.admit('L-2', ['b.ts']);
    expect(w.next().landing!.id).toBe('L-1'); // it runs its checks while it waits
    w.phase('L-1', 'checking', { trunk_base: sha('a') });
    expect(codeOf(() => w.advance('L-1', { to: 'needs_approval', required: [r1], report: report('no checks') }))).toEqual(['bad_request', 400]);
    const before = w.events.length;
    const parked = w.advance('L-1', { to: 'needs_approval', required: [r1], report: passedReport(), candidate: sha('c'), candidate_ref: 'refs/agenthub/cand/x/L-1/cccccccccccc' });
    expect(parked.landing).toMatchObject({
      status: 'needs_approval',
      phase: null,
      candidate: sha('c'),
      candidate_ref: 'refs/agenthub/cand/x/L-1/cccccccccccc',
      candidate_checked: true,
      approval: [r1],
      deadline_at: w.clock.t + DAY,
      queue_seq: 1,
      position: null,
      eta_ms: null,
      report: { message: 'The checks passed.' },
    });
    expect(w.events.slice(before).map((e) => [e.type, e.actor, e.data])).toEqual([
      ['landing.needs_approval', LANDER, { landing_id: 'L-1', agent: A, task_id: 'T-1', kinds: ['protected'], paths: ['migrations/0042.sql'], approvers: null, parked: true }],
    ]);
    expect(w.advance('L-1', { to: 'needs_approval', required: [r1], report: passedReport() }).replayed).toBe(true);
    expect(w.hub.listClaims(P, { holder: A })).toEqual([expect.objectContaining({ landing_id: 'L-1', status: 'active' })]);
    // The next landing runs meanwhile.
    expect(w.next().landing!.id).toBe('L-2');
    w.landed('L-2');
    expect(w.next().landing).toBeNull();
    // The approval puts it back at the head of the queue.
    const ok = w.approve('L-1', dig('1'), 'sam', 'protected', 'ok');
    expect(ok.landing).toMatchObject({
      status: 'queued',
      queue_seq: 1,
      position: 1,
      approval: [],
      deadline_at: null,
      candidate_checked: true,
      approvals: [{ kind: 'protected', digest: dig('1'), by: 'sam', at: w.clock.t, note: 'ok', carried_from: null }],
    });
    expect(w.events.at(-1)).toMatchObject({ type: 'landing.updated', actor: 'sam', data: { landing_id: 'L-1', status: 'queued', reason: 'approved', position: 1 } });
    expect(w.next().landing).toMatchObject({ id: 'L-1', attempt: 2, candidate: sha('c'), candidate_checked: true, trunk_base: sha('a') });
    // The approved resume pushes the checked candidate.
    expect(w.pushing('L-1', { attempt: 2, required: [r1] }).landing).toMatchObject({ phase: 'pushing', candidate_checked: true });
  });

  it('a parked landing nobody approves fails (approval_timeout, T8); one whose approvals all came in meanwhile goes straight back to the queue', () => {
    const w = world();
    const r1 = requirement(dig('1'));
    w.land(A, ['migrations/0042.sql'], sha('1'));
    w.admit('L-1', ['migrations/0042.sql'], { required: [r1] });
    w.next();
    w.advance('L-1', { to: 'needs_approval', required: [r1], report: passedReport() });
    w.tick(DAY - 1);
    w.hub.heartbeat(P, LANDER);
    w.hub.sweep();
    expect(w.hub.getLanding(P, 'L-1').status).toBe('needs_approval');
    w.tick(1);
    const before = w.events.length;
    expect(w.hub.sweep()).toEqual([P]);
    expect(w.hub.getLanding(P, 'L-1')).toMatchObject({ status: 'failed', failure: { code: 'approval_timeout' }, deadline_at: null });
    expect(w.events.slice(before).map((e) => [e.type, e.actor])).toEqual([
      ['claim.granted', A],
      ['task.updated', null],
      ['landing.failed', null],
    ]);

    // L-2's approval came in while its checks ran: parking it queues it again at once.
    w.hub.heartbeat(P, LANDER);
    w.land(B, ['migrations/0043.sql'], sha('2'));
    const r2 = requirement(dig('2'), [RULE], ['migrations/0043.sql']);
    w.admit('L-2', ['migrations/0043.sql'], { required: [r2] });
    w.next();
    w.approve('L-2', dig('2'), 'maya');
    const back = w.advance('L-2', { to: 'needs_approval', required: [r2], report: passedReport(), candidate: sha('d') });
    expect(back.landing).toMatchObject({ status: 'queued', candidate: sha('d'), candidate_checked: true, approval: [], position: 1 });
    expect(w.events.at(-1)).toMatchObject({ type: 'landing.updated', data: { landing_id: 'L-2', status: 'queued', reason: 'approved' } });
  });

  it('requeues (T9) in place: trunk_moved counts up to 3 and then fails trunk_busy; lander_stopping never counts', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.land(B, ['b.ts'], sha('2'));
    w.admit('L-1', ['a.ts']);
    w.admit('L-2', ['b.ts']);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(w.next().landing).toMatchObject({ id: 'L-1', attempt });
      const before = w.events.length;
      const r = w.advance('L-1', { attempt, to: 'queued', reason: 'trunk_moved' });
      expect(r.landing).toMatchObject({ status: 'queued', phase: null, lander: null, lease_claim_id: null, deadline_at: null, queue_seq: 1, position: 1, retries: { trunk_moved: attempt, lander_lost: 0, step_timeout: 0 } });
      expect(w.events.slice(before).map((e) => [e.type, e.actor, e.data.reason])).toEqual([['landing.updated', LANDER, 'requeued:trunk_moved']]);
      expect(w.advance('L-1', { attempt, to: 'queued', reason: 'trunk_moved' }).replayed).toBe(true);
    }
    w.next();
    expect(w.advance('L-1', { attempt: 4, to: 'queued', reason: 'lander_stopping' }).landing.retries.trunk_moved).toBe(3);
    w.next();
    const busy = w.advance('L-1', { attempt: 5, to: 'queued', reason: 'trunk_moved' });
    expect(busy.landing).toMatchObject({ status: 'failed', failure: { code: 'trunk_busy' }, retries: { trunk_moved: 4 } });
    expect(busy.released).toEqual([expect.objectContaining({ holder: A, landing_id: null, status: 'active' })]);
    expect(w.next().landing!.id).toBe('L-2');
    // Reasons only the hub gives are refused.
    expect(codeOf(() => w.advance('L-2', { to: 'queued', reason: 'lander_lost' }))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.advance('L-2', { to: 'queued', reason: 'approved' }))).toEqual(['bad_request', 400]);
  });

  it('lands (T11): holds released and a waiter granted, the task done and its dependents unblocked, also_landed annotated, control.trunk set; a repeat is a replay', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.admit('L-1', ['a.ts']);
    w.next();
    w.advance('L-1', { to: 'failed', code: 'checks_failed', report: report() });
    w.hub.createTask(P, B, { title: 'after T-1', deps: ['T-1'] }); // T-2
    const r = w.land(A, ['a.ts'], sha('2'), { task: 'T-1' }); // L-2 carries L-1's commit too
    const waiter = w.hub.claim(P, B, { files: ['a.ts'], queue: true }).claim!;
    w.admit('L-2', ['a.ts']);
    w.next();
    w.phase('L-2', 'checking', { trunk_base: sha('a') });
    w.pushing('L-2');
    // In pushing, what landed is the candidate.
    expect(codeOf(() => w.landed('L-2', { trunk_sha: sha('d') }))).toEqual(['bad_request', 400]);
    const before = w.events.length;
    const done = w.landed('L-2', { also_landed: ['L-1'] });
    expect(done).toMatchObject({ replayed: false, unblocked: ['T-2'], landing: { status: 'landed', phase: null, trunk_sha: sha('c'), ended_at: w.clock.t, deadline_at: null, reconciled: false, report: { message: 'L-2 landed.' } } });
    expect(done.released).toEqual([expect.objectContaining({ id: r.held[0].id, status: 'released', end_reason: 'landed L-2' })]);
    expect(w.hub.getClaim(P, waiter.id).status).toBe('active');
    expect(w.hub.listTasks(P).find((t) => t.id === 'T-1')).toMatchObject({ status: 'done', owner: A });
    expect(w.hub.getLanding(P, 'L-1').landed_with).toBe('L-2');
    expect(w.store.getLanderControl(P).trunk).toEqual({ sha: sha('c'), landing_id: 'L-2', at: w.clock.t });
    expect(w.events.slice(before).map((e) => e.type)).toEqual(['claim.released', 'claim.granted', 'task.updated', 'task.unblocked', 'landing.landed', 'trunk.moved']);
    expect(w.events.at(-2)).toMatchObject({ actor: LANDER, data: { landing_id: 'L-2', agent: A, task_id: 'T-1', trunk_sha: sha('c'), files: ['a.ts'], resolved_by: 'clean', also_landed: ['L-1'], reconciled: false } });
    expect(w.events.at(-1)!.data).toEqual({ from: sha('a'), to: sha('c'), landing_id: 'L-2', files: ['a.ts'], foreign: false });
    // The response was lost: the same request again is a replay and changes nothing.
    expect(w.landed('L-2', { also_landed: ['L-1'] })).toMatchObject({ replayed: true, released: [], unblocked: [], landing: { status: 'landed' } });
    expect(w.events.length).toBe(before + 6);
    expect(codeOf(() => w.phase('L-2', 'checking'))).toEqual(['landing_stale', 409]);
    expect(codeOf(() => w.landed('L-2', { trunk_sha: sha('d') }))).toEqual(['landing_stale', 409]);
  });

  it('fails (T13): the holds go back to the agent for the send-back grace, the task is in progress again, and landing.failed carries no text', () => {
    const w = world();
    const r = w.land(A, ['a.ts', 'b.ts'], sha('1'));
    w.admit('L-1', ['a.ts', 'b.ts']);
    w.next();
    w.phase('L-1', 'checking');
    const before = w.events.length;
    const f = w.advance('L-1', { to: 'failed', code: 'checks_failed', report: report('L-1 came back: npm test exited 1 after 2m41s.\nThe log follows.') });
    expect(f.landing).toMatchObject({ status: 'failed', failure: { code: 'checks_failed', summary: 'L-1 came back: npm test exited 1 after 2m41s.' }, phase: null, deadline_at: null, ended_at: w.clock.t, lander: LANDER, attempt: 1 });
    expect(f.released).toEqual([expect.objectContaining({ id: r.held[0].id, landing_id: null, status: 'active', expires_at: w.clock.t + 30 * MIN })]);
    expect(w.hub.listTasks(P)[0]).toMatchObject({ status: 'in_progress', owner: A });
    expect(w.events.slice(before).map((e) => e.type)).toEqual(['claim.granted', 'task.updated', 'landing.failed']);
    expect(w.events.at(-1)!.data).toEqual({ landing_id: 'L-1', agent: A, task_id: 'T-1', code: 'checks_failed', files: ['a.ts', 'b.ts'] });
    expect(w.advance('L-1', { to: 'failed', code: 'checks_failed', report: report() }).replayed).toBe(true);
    expect(codeOf(() => w.advance('L-1', { to: 'failed', code: 'conflict', report: report() }))).toEqual(['landing_stale', 409]);
    w.land(B, ['c.ts'], sha('2'));
    w.admit('L-2', ['c.ts']);
    w.next();
    expect(codeOf(() => w.advance('L-2', { to: 'failed', code: 'no_such_code', report: report() }))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.advance('L-2', { to: 'failed', code: 'conflict', report: 'not a report' }))).toEqual(['bad_request', 400]);
  });

  it('fences every attempt: after a cancel, a supersede or a requeue the old attempt gets 409 landing_stale', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.admit('L-1', ['a.ts']);
    w.next();
    w.hub.cancelLanding(P, A, 'L-1', { reason: 'wrong approach' });
    expect(codeOf(() => w.phase('L-1', 'checking'))).toEqual(['landing_stale', 409]);
    expect(codeOf(() => w.pushing('L-1'))).toEqual(['landing_stale', 409]);

    w.land(A, ['b.ts'], sha('2')); // L-2, T-2
    w.admit('L-2', ['b.ts']);
    w.next();
    w.land(A, ['b.ts'], sha('3'), { task: 'T-2' }); // L-3 supersedes the running L-2
    expect(w.hub.getLanding(P, 'L-2')).toMatchObject({ status: 'superseded', superseded_by: 'L-3' });
    expect(codeOf(() => w.landed('L-2'))).toEqual(['landing_stale', 409]);

    w.admit('L-3', ['b.ts']);
    w.next();
    w.tick(10 * MIN);
    w.hub.heartbeat(P, LANDER); // any write requeues it past its deadline
    expect(w.hub.getLanding(P, 'L-3')).toMatchObject({ status: 'queued', retries: { step_timeout: 1 } });
    expect(codeOf(() => w.phase('L-3', 'checking'))).toEqual(['landing_stale', 409]);
    expect(w.next().landing).toMatchObject({ id: 'L-3', attempt: 2 });
    expect(codeOf(() => w.phase('L-3', 'checking'))).toEqual(['landing_stale', 409]);
    expect(w.phase('L-3', 'checking', { attempt: 2 }).replayed).toBe(false);
  });
});

describe('deadlines, lease loss and in-doubt landings (T9, T10, T11, T12)', () => {
  it('a step past its deadline is requeued (step_timeout) by the sweep or a read; the third time it fails lander_stuck', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.admit('L-1', ['a.ts']);
    w.next();
    w.tick(10 * MIN - 1);
    w.hub.sweep();
    expect(w.hub.getLanding(P, 'L-1').status).toBe('running');
    w.tick(1);
    expect(w.store.projectsWithDueWork(w.clock.t)).toEqual([P]);
    const before = w.events.length;
    expect(w.hub.sweep()).toEqual([P]);
    expect(w.hub.getLanding(P, 'L-1')).toMatchObject({ status: 'queued', queue_seq: 1, lander: null, retries: { step_timeout: 1 } });
    expect(w.events.slice(before).map((e) => [e.type, e.actor, e.data.reason])).toEqual([['landing.updated', null, 'requeued:step_timeout']]);
    w.next();
    w.tick(10 * MIN);
    expect(w.hub.status(P, null).queue).toEqual([expect.objectContaining({ id: 'L-1', status: 'queued', retries: { trunk_moved: 0, lander_lost: 0, step_timeout: 2 } })]);
    w.next();
    w.tick(10 * MIN);
    w.hub.sweep();
    expect(w.hub.getLanding(P, 'L-1')).toMatchObject({ status: 'failed', failure: { code: 'lander_stuck' }, retries: { step_timeout: 3 } });
  });

  it('a lease that ends in pushing leaves the landing in doubt (T10): no sweep, deadline or lease loss requeues it, and the next lease holder gets it first, with resolve', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.land(B, ['b.ts'], sha('2'));
    w.admit('L-1', ['a.ts']);
    w.admit('L-2', ['b.ts']);
    w.next();
    w.phase('L-1', 'checking', { trunk_base: sha('a') });
    w.pushing('L-1');
    const standby = takeLease(w.hub, STANDBY);
    expect(standby.status).toBe('queued');
    const before = w.events.length;
    w.hub.release(P, LANDER, { claim_id: w.lease.claim.id });
    expect(w.hub.getLanding(P, 'L-1')).toMatchObject({ status: 'running', phase: 'pushing', in_doubt: true, deadline_at: null, retries: { lander_lost: 0 } });
    expect(w.events.slice(before).map((e) => [e.type, e.data.claim_id ?? e.data.reason])).toEqual([
      ['claim.released', w.lease.claim.id],
      ['landing.updated', 'in_doubt'],
      ['claim.granted', standby.claim.id],
    ]);
    // A week passes; the standby's lease lapses too. Nothing moves it.
    w.tick(7 * DAY);
    w.hub.sweep();
    expect(w.hub.getClaim(P, standby.claim.id).status).toBe('expired');
    expect(w.hub.getLanding(P, 'L-1')).toMatchObject({ status: 'running', phase: 'pushing', in_doubt: true, queue_seq: 1 });
    expect(codeOf(() => w.landed('L-1'))).toEqual(['not_lander', 409]);

    // A new lease holder gets it back first, with resolve, even while paused; nothing else starts.
    const third = takeLease(w.hub, STANDBY);
    w.hub.pauseLander(P, STANDBY, { lease: third.lease, reason: 'push_rejected', detail: 'main is protected' }, LANDER_AUTH);
    expect(w.hub.nextLanding(P, STANDBY, { lease: third.lease }, LANDER_AUTH)).toMatchObject({ resolve: true, landing: { id: 'L-1', in_doubt: true, phase: 'pushing', candidate: sha('c'), trunk_base: sha('a') } });
    // It is resolved, never advanced: its attempt belongs to another lease.
    const advanceAsThird = { lease: third.lease, attempt: 1, to: 'landed', trunk_sha: sha('c'), base_sha: sha('0'), files: ['a.ts'], report: report(), also_landed: [], symbol_changes: [] };
    expect(codeOf(() => w.hub.advanceLanding(P, STANDBY, 'L-1', advanceAsThird as never, LANDER_AUTH))).toEqual(['landing_stale', 409]);
    // Trunk moved past trunk_base without the candidate: requeue, in its place, counting trunk_moved.
    const rq = w.resolve('L-1', { outcome: 'requeue', trunk_sha: sha('d') }, third.lease, STANDBY);
    expect(rq.landing).toMatchObject({ status: 'queued', in_doubt: false, phase: null, queue_seq: 1, lander: null, lease_claim_id: null, retries: { trunk_moved: 1 } });
    expect(w.events.at(-1)).toMatchObject({ type: 'landing.updated', actor: STANDBY, data: { reason: 'requeued:trunk_moved' } });
    expect(w.resolve('L-1', { outcome: 'requeue', trunk_sha: sha('d') }, third.lease, STANDBY).replayed).toBe(true);
    expect(w.store.getLanderControl(P).trunk).toBeNull(); // the next trunk report says where trunk is
    expect(w.hub.nextLanding(P, STANDBY, { lease: third.lease }, LANDER_AUTH).landing).toBeNull(); // paused
    w.hub.resumeLander(P, {}, approverAuth('sam'));
    expect(w.hub.nextLanding(P, STANDBY, { lease: third.lease }, LANDER_AUTH).landing).toMatchObject({ id: 'L-1', attempt: 2, lease_claim_id: third.claim.id });
  });

  it('resolve {landed} applies the landed effects; resolve is only for an in-doubt landing or the lease’s own landing in pushing', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.admit('L-1', ['a.ts']);
    w.next();
    expect(codeOf(() => w.resolve('L-1', { outcome: 'landed', trunk_sha: sha('c'), symbol_changes: [] }))).toEqual(['landing_stale', 409]);
    w.pushing('L-1');
    expect(codeOf(() => w.resolve('L-1', { outcome: 'maybe', trunk_sha: sha('c') }))).toEqual(['bad_request', 400]);
    const r = w.resolve('L-1', { outcome: 'landed', trunk_sha: sha('c'), symbol_changes: [] });
    expect(r).toMatchObject({ replayed: false, landing: { status: 'landed', trunk_sha: sha('c'), in_doubt: false, reconciled: false } });
    expect(r.released).toHaveLength(1);
    expect(w.hub.listTasks(P)[0].status).toBe('done');
    expect(w.store.getLanderControl(P).trunk).toMatchObject({ sha: sha('c'), landing_id: 'L-1' });
    expect(w.events.slice(-2).map((e) => e.type)).toEqual(['landing.landed', 'trunk.moved']);
    expect(w.resolve('L-1', { outcome: 'landed', trunk_sha: sha('c'), symbol_changes: [] }).replayed).toBe(true);
    expect(codeOf(() => w.resolve('L-1', { outcome: 'landed', trunk_sha: sha('d'), symbol_changes: [] }))).toEqual(['landing_stale', 409]);
  });
});

describe('approvals (T7, T8)', () => {
  it('an approval while queued drops the requirement; a stale digest is 409 approval_stale; an approver no rule allows is 403 not_approver, naming the rule', () => {
    const w = world();
    const r1 = requirement(dig('1'), [{ paths: ['migrations/**'], approvers: ['sam', 'lee'], distinct: true }]);
    w.land(A, ['migrations/0042.sql'], sha('1'));
    w.admit('L-1', ['migrations/0042.sql'], { required: [r1] });
    expect(codeOf(() => w.approve('L-1', dig('9'), 'sam'))).toEqual(['approval_stale', 409]);
    expect(codeOf(() => w.approve('L-1', dig('1'), 'sam', 'merged'))).toEqual(['approval_stale', 409]);
    const wrong = errorOf(() => w.approve('L-1', dig('1'), 'kim'));
    expect([wrong.code, wrong.status]).toEqual(['not_approver', 403]);
    expect(wrong.message).toContain('migrations/**');
    expect(wrong.message).toContain('sam');
    const before = w.events.length;
    const ok = w.approve('L-1', dig('1'), 'lee', 'protected', 'additive');
    expect(ok.landing).toMatchObject({ status: 'queued', approval: [], approvals: [expect.objectContaining({ by: 'lee', note: 'additive', carried_from: null })] });
    expect(w.events.slice(before).map((e) => [e.type, e.actor, e.data.reason, e.data.status])).toEqual([['landing.updated', 'lee', 'approved', 'queued']]);
    expect(codeOf(() => w.approve('L-1', dig('1'), 'sam'))).toEqual(['approval_stale', 409]);
    expect(w.store.listApprovals(P, 'L-1')).toEqual([expect.objectContaining({ n: 1, approver: 'lee', decision: 'approve', kind: 'protected', digest: dig('1') })]);
    // Approving needs an approver.
    expect(codeOf(() => w.hub.approveLanding(P, 'L-1', { kind: 'protected', digest: dig('1') }, NO_AUTH))).toEqual(['not_approver', 403]);
    expect(codeOf(() => w.hub.approveLanding(P, 'L-9', { kind: 'protected', digest: dig('1') }, approverAuth('sam')))).toEqual(['not_found', 404]);
  });

  it("with distinct, the author's own human can't approve; two rules need two humans", () => {
    const w = world();
    const two = requirement(dig('1'), [
      { paths: ['migrations/**'], approvers: ['maya', 'sam'], distinct: true },
      { paths: ['**/*.sql'], approvers: ['lee'], distinct: false },
    ]);
    w.land(A, ['migrations/0042.sql'], sha('1')); // by maya's agent
    w.admit('L-1', ['migrations/0042.sql'], { required: [two] });
    const own = errorOf(() => w.approve('L-1', dig('1'), 'maya'));
    expect([own.code, own.status]).toEqual(['not_approver', 403]);
    expect(own.message).toContain('distinct');
    w.approve('L-1', dig('1'), 'sam');
    expect(w.hub.getLanding(P, 'L-1').approval).toEqual([two]); // still waits for lee
    const events = w.events.length;
    w.approve('L-1', dig('1'), 'sam'); // asking again changes nothing
    expect(w.events.length).toBe(events);
    expect(w.store.listApprovals(P, 'L-1')).toHaveLength(1);
    w.next();
    expect(errorOf(() => w.pushing('L-1', { required: [two] })).code).toBe('approval_missing');
    const done = w.approve('L-1', dig('1'), 'lee');
    expect(done.landing).toMatchObject({ status: 'running', approval: [] });
    expect(done.landing.approvals.map((a) => a.by)).toEqual(['sam', 'lee']);
    expect(w.pushing('L-1', { required: [two] }).landing.phase).toBe('pushing');
  });

  it('a rejection fails the landing (approval_rejected, T8) and gives its claims back; a closed landing answers landing_closed', () => {
    const w = world();
    const r1 = requirement(dig('1'));
    const r = w.land(A, ['migrations/0042.sql'], sha('1'));
    w.admit('L-1', ['migrations/0042.sql'], { required: [r1] });
    expect(codeOf(() => w.hub.rejectLanding(P, 'L-1', { reason: '' }, approverAuth('sam')))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.hub.rejectLanding(P, 'L-1', { reason: 'no' }, approverAuth('maya')))).toEqual(['not_approver', 403]);
    w.next();
    w.advance('L-1', { to: 'needs_approval', required: [r1], report: passedReport() });
    const before = w.events.length;
    const no = w.hub.rejectLanding(P, 'L-1', { reason: 'Split the migration first.' }, approverAuth('sam'));
    expect(no.landing).toMatchObject({ status: 'failed', failure: { code: 'approval_rejected' } });
    expect(no.landing.failure!.summary).toContain('sam');
    expect(no.landing.failure!.summary).toContain('Split the migration first.');
    expect(w.store.listApprovals(P, 'L-1')).toEqual([expect.objectContaining({ approver: 'sam', decision: 'reject', note: 'Split the migration first.', digest: dig('1') })]);
    expect(w.hub.getClaim(P, r.held[0].id).landing_id).toBeNull();
    expect(w.events.slice(before).map((e) => [e.type, e.actor])).toEqual([
      ['claim.granted', A],
      ['task.updated', 'sam'],
      ['landing.failed', 'sam'],
    ]);
    expect(codeOf(() => w.approve('L-1', dig('1'), 'sam'))).toEqual(['landing_closed', 409]);
    expect(codeOf(() => w.hub.rejectLanding(P, 'L-1', { reason: 'x' }, approverAuth('sam')))).toEqual(['landing_closed', 409]);
    // Nothing to reject: no approval is pending.
    w.land(B, ['b.ts'], sha('2'));
    w.admit('L-2', ['b.ts']);
    expect(codeOf(() => w.hub.rejectLanding(P, 'L-2', { reason: 'x' }, approverAuth('maya')))).toEqual(['approval_stale', 409]);
  });
});

describe('cancel (T14)', () => {
  it('the author or an approver cancels a live landing in any state but pushing; pushing is 409 too_late, a terminal landing 409 landing_closed', () => {
    const w = world();
    const r1 = requirement(dig('1'));
    // submitted
    const r = w.land(A, ['a.ts'], sha('1'));
    expect(codeOf(() => w.hub.cancelLanding(P, B, 'L-1', {}))).toEqual(['forbidden', 403]);
    expect(codeOf(() => w.hub.cancelLanding(P, null, 'L-1', {}))).toEqual(['forbidden', 403]);
    const before = w.events.length;
    const c1 = w.hub.cancelLanding(P, A, 'L-1', { reason: 'wrong approach' });
    expect(c1.landing).toMatchObject({ status: 'cancelled', failure: null, ended_at: w.clock.t, position: null });
    expect(w.hub.getClaim(P, r.held[0].id)).toMatchObject({ landing_id: null, status: 'active', expires_at: w.clock.t + 30 * MIN });
    expect(w.hub.listTasks(P)[0].status).toBe('in_progress');
    expect(w.events.slice(before).map((e) => [e.type, e.actor, e.data.reason ?? null])).toEqual([
      ['claim.granted', A, null],
      ['task.updated', A, null],
      ['landing.updated', A, 'cancelled'],
    ]);
    expect(codeOf(() => w.hub.cancelLanding(P, A, 'L-1', {}))).toEqual(['landing_closed', 409]);
    // queued, by an approver
    w.land(A, ['a.ts'], sha('2'), { task: 'T-1' }); // L-2
    w.admit('L-2', ['a.ts']);
    expect(w.hub.cancelLanding(P, null, 'L-2', {}, approverAuth('sam')).landing.status).toBe('cancelled');
    expect(w.events.at(-1)).toMatchObject({ type: 'landing.updated', actor: 'sam', data: { reason: 'cancelled', status: 'cancelled' } });
    // needs_approval
    w.land(A, ['migrations/0042.sql'], sha('3'), { task: 'T-1' }); // L-3
    w.admit('L-3', ['migrations/0042.sql'], { required: [r1] });
    w.next();
    w.advance('L-3', { to: 'needs_approval', required: [r1], report: passedReport() });
    expect(w.hub.cancelLanding(P, A, 'L-3', {}).landing.status).toBe('cancelled');
    // running (checking): the lander's next call is stale
    w.land(A, ['a.ts'], sha('4'), { task: 'T-1' }); // L-4
    w.admit('L-4', ['a.ts']);
    expect(w.next().landing).toMatchObject({ id: 'L-4' });
    w.phase('L-4', 'checking');
    expect(w.hub.cancelLanding(P, A, 'L-4', {}).landing).toMatchObject({ status: 'cancelled', phase: null, deadline_at: null });
    expect(codeOf(() => w.phase('L-4', 'checking'))).toEqual(['landing_stale', 409]);
    expect(w.next().landing).toBeNull();
    // pushing
    w.land(A, ['a.ts'], sha('5'), { task: 'T-1' }); // L-5
    w.admit('L-5', ['a.ts']);
    w.next();
    w.pushing('L-5');
    const late = errorOf(() => w.hub.cancelLanding(P, A, 'L-5', {}));
    expect([late.code, late.status]).toEqual(['too_late', 409]);
    expect(codeOf(() => w.hub.cancelLanding(P, null, 'L-5', {}, approverAuth('sam')))).toEqual(['too_late', 409]);
    expect(codeOf(() => w.hub.cancelLanding(P, A, 'L-9', {}))).toEqual(['not_found', 404]);
  });
});

describe('trunk reports, pause and resume (T16)', () => {
  it('reconciles a landing found on trunk, even a cancelled one, reports foreign commits and keeps the reported policy', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.hub.cancelLanding(P, A, 'L-1', {});
    w.land(B, ['b.ts'], sha('2'));
    w.admit('L-2', ['b.ts']);
    w.next();
    w.landed('L-2', { trunk_sha: sha('5') });
    const before = w.events.length;
    const policy: LandPolicy = { keep_place_retries: 1, sendback_grace_min: 10, approval_timeout_hours: 12, claim_gate: 'warn' };
    const res = w.trunk({
      from: sha('5'),
      to: sha('7'),
      policy,
      commits: [
        { sha: sha('6'), landing: `${P}/L-1`, hub: w.hub.epoch, source: sha('1'), files: ['a.ts'] },
        { sha: sha('7'), landing: null, hub: null, source: null, files: ['README.md'] },
      ],
    });
    expect(res.control).toEqual({ paused: null, trunk: { sha: sha('7'), landing_id: null, at: w.clock.t }, policy });
    expect(w.hub.getLanding(P, 'L-1')).toMatchObject({ status: 'landed', reconciled: true, trunk_sha: sha('6'), ended_at: w.clock.t });
    const mine = w.events.slice(before);
    expect(mine.map((e) => e.type)).toEqual(['landing.landed', 'trunk.moved', 'message.posted', 'trunk.moved']);
    expect(mine[0].data).toEqual({ landing_id: 'L-1', agent: A, task_id: 'T-1', trunk_sha: sha('6'), files: ['a.ts'], resolved_by: null, also_landed: [], reconciled: true });
    expect(mine[1].data).toEqual({ from: sha('5'), to: sha('6'), landing_id: 'L-1', files: ['a.ts'], foreign: false });
    expect(mine[3].data).toEqual({ from: sha('6'), to: sha('7'), landing_id: null, files: ['README.md'], foreign: true });
    expect(w.hub.inbox(P, A).messages.at(-1)).toMatchObject({ from: LANDER, to: A, body: expect.stringContaining('L-1 is on trunk after all') });
    expect(w.store.getLanderControl(P).policy).toEqual(policy);
    expect(codeOf(() => w.trunk({ policy: { ...policy, claim_gate: 'maybe' } }))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.trunk({ to: 'main' }))).toEqual(['bad_request', 400]);
  });

  it('a commit is a landing only when Landing, Hub and Source all match; one already landed changes nothing', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.land(B, ['b.ts'], sha('2'));
    w.admit('L-2', ['b.ts']);
    w.next();
    w.landed('L-2', { trunk_sha: sha('5') });
    const before = w.events.length;
    w.trunk({
      from: sha('5'),
      to: sha('9'),
      commits: [
        { sha: sha('6'), landing: `${P}/L-1`, hub: '00000000-0000-4000-8000-000000000000', source: sha('1'), files: ['a.ts'] },
        { sha: sha('7'), landing: `${P}/L-1`, hub: w.hub.epoch, source: sha('3'), files: ['a.ts'] },
        { sha: sha('8'), landing: 'other/L-1', hub: w.hub.epoch, source: sha('1'), files: ['a.ts'] },
        { sha: sha('9'), landing: `${P}/L-2`, hub: w.hub.epoch, source: sha('2'), files: ['b.ts'] },
      ],
    });
    expect(w.hub.getLanding(P, 'L-1').status).toBe('submitted');
    expect(w.events.slice(before).map((e) => [e.type, e.data.to, e.data.foreign])).toEqual([
      ['trunk.moved', sha('6'), true],
      ['trunk.moved', sha('7'), true],
      ['trunk.moved', sha('8'), true],
    ]);
    expect(w.store.getLanderControl(P).trunk).toEqual({ sha: sha('9'), landing_id: 'L-2', at: w.clock.t });
  });

  it('a rewritten trunk pauses landing (lander.paused) until an approver resumes it, accepting a tip', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    w.land(B, ['b.ts'], sha('2'));
    w.admit('L-1', ['a.ts']);
    w.admit('L-2', ['b.ts']);
    w.trunk({ to: sha('a') });
    w.next();
    w.phase('L-1', 'merging', { trunk_base: sha('a') });
    const before = w.events.length;
    const res = w.trunk({ from: sha('a'), to: sha('b'), rewritten: true });
    expect(res.control.paused).toMatchObject({ reason: 'trunk_rewritten', by: LANDER, at: w.clock.t });
    expect(res.control.paused!.detail).toContain('aaaaaaaaaaaa');
    expect(res.control.trunk).toMatchObject({ sha: sha('a') }); // the hub doesn't take the rewritten tip
    expect(w.events.slice(before).map((e) => [e.type, e.actor, e.data])).toEqual([['lander.paused', LANDER, { reason: 'trunk_rewritten', by: LANDER }]]);
    // The running landing is the lander's own: next still returns it, and it is requeued.
    expect(w.next()).toMatchObject({ resolve: false, landing: { id: 'L-1' } });
    w.advance('L-1', { to: 'queued', reason: 'trunk_rewritten' });
    expect(w.next()).toMatchObject({ landing: null, control: { paused: { reason: 'trunk_rewritten' } } });
    // Only an approver resumes, and after a rewrite only by accepting a tip.
    expect(codeOf(() => w.hub.resumeLander(P, {}, NO_AUTH))).toEqual(['not_approver', 403]);
    expect(codeOf(() => w.hub.resumeLander(P, {}, approverAuth('maya')))).toEqual(['bad_request', 400]);
    expect(codeOf(() => w.hub.resumeLander(P, { accept_trunk: 'main' }, approverAuth('maya')))).toEqual(['bad_request', 400]);
    const resumed = w.hub.resumeLander(P, { accept_trunk: sha('b') }, approverAuth('maya'));
    expect(resumed.control).toMatchObject({ paused: null, trunk: { sha: sha('b'), landing_id: null, at: w.clock.t } });
    expect(w.events.at(-1)).toMatchObject({ type: 'lander.resumed', actor: 'maya', data: { reason: 'human', by: 'maya' } });
    expect(w.next().landing).toMatchObject({ id: 'L-1', attempt: 2, retries: { trunk_moved: 0 } });
  });

  it('the lander pauses (push_rejected, config_invalid, external_push); an approver resumes', () => {
    const w = world();
    const p = w.hub.pauseLander(P, LANDER, { lease: w.L, reason: 'external_push', detail: '8c7b6a594837 reached main outside the landing queue' }, LANDER_AUTH);
    expect(p.control.paused).toEqual({ reason: 'external_push', detail: '8c7b6a594837 reached main outside the landing queue', at: w.clock.t, by: LANDER });
    expect(w.events.at(-1)).toMatchObject({ type: 'lander.paused', actor: LANDER, data: { reason: 'external_push', by: LANDER } });
    const count = w.events.length;
    w.hub.pauseLander(P, LANDER, { lease: w.L, reason: 'external_push', detail: 'again' }, LANDER_AUTH);
    expect(w.events.length).toBe(count); // already paused for that reason
    expect(codeOf(() => w.hub.pauseLander(P, LANDER, { lease: w.L, reason: 'human', detail: '' } as never, LANDER_AUTH))).toEqual(['bad_request', 400]);
    const resumed = w.hub.resumeLander(P, {}, approverAuth('sam'));
    expect(resumed.control.paused).toBeNull();
    expect(w.store.getLanderControl(P).paused).toBeNull();
  });
});

describe('status and stats', () => {
  it('status lists the live queue in queue order, the lander lease and the control', () => {
    const w = world();
    takeLease(w.hub, STANDBY);
    w.land(A, ['a.ts'], sha('1'));
    w.land(B, ['b.ts'], sha('2'));
    w.land(C, ['c.ts'], sha('3'));
    w.admit('L-1', ['a.ts']);
    w.admit('L-2', ['b.ts']);
    w.next();
    w.trunk({ to: sha('a') });
    const s = w.hub.status(P, A);
    expect(s.queue.map((l) => [l.id, l.status, l.position])).toEqual([
      ['L-1', 'running', null],
      ['L-2', 'queued', 2],
      ['L-3', 'submitted', 3],
    ]);
    expect(s.queue[0]).not.toHaveProperty('seq');
    expect(s.queue[1].eta_ms).toBe(5 * MIN + 5 * MIN);
    expect(s.lander).toEqual({ holder: LANDER, claim_id: w.lease.claim.id, expires_at: w.lease.claim.expires_at, standby: [STANDBY] });
    expect(s.control).toEqual({ paused: null, trunk: { sha: sha('a'), landing_id: null, at: w.clock.t }, policy: POLICY });
    expect(w.hub.landerStatus(P)).toEqual({ lease: s.lander, control: s.control });
    // Landings: live ones first in queue order, then the most recent.
    w.landed('L-1');
    expect(w.hub.listLandings(P).map((l) => l.id)).toEqual(['L-2', 'L-3', 'L-1']);
    expect(w.hub.listLandings(P, { statuses: ['landed'] }).map((l) => l.id)).toEqual(['L-1']);
    expect(w.hub.listLandings(P, { agent: B }).map((l) => l.id)).toEqual(['L-2']);
    expect(w.hub.getLanding(P, 'L-2')).toMatchObject({ id: 'L-2', position: 1 });
    expect(codeOf(() => w.hub.getLanding(P, 'L-9'))).toEqual(['not_found', 404]);
  });

  it('landingStats summarizes a synthetic history: time to trunk per chain, first-try rate, send-backs, check time and queue wait', () => {
    const { hub, store, clock } = setup();
    const t = clock.t - DAY;
    const at = (m: number) => t + m * MIN;
    const check = (minutes: number) => ({ ...passedReport().check!, duration_ms: minutes * MIN });
    const put = (id: string, status: 'landed' | 'failed' | 'superseded', o: Record<string, unknown>) =>
      store.insertLanding({ ...phase1Landing({ id, project: P, agent: A, task_id: null, branch: null, commit: sha('1'), summary: '', status, created_at: o.created as number }), ...o });
    // Chain 1: sent back once, then landed 20 minutes after the first land.
    put('L-1', 'failed', { created: at(0), started_at: at(1), ended_at: at(5), failure: { code: 'checks_failed', summary: '' }, report: report('', { check: check(3), resolved_by: 'clean' }) });
    put('L-2', 'landed', { created: at(10), started_at: at(12), ended_at: at(20), retry_of: 'L-1', retry: 1, report: report('', { check: check(4), resolved_by: 'clean' }) });
    // Chain 2: landed first try in 10 minutes.
    put('L-3', 'landed', { created: at(30), started_at: at(31), ended_at: at(40), report: report('', { check: check(6), resolved_by: 'structural' }) });
    // Chain 3: superseded (no send-back), then landed 40 minutes after the first land.
    put('L-4', 'superseded', { created: at(50), ended_at: at(55), superseded_by: 'L-5' });
    put('L-5', 'landed', { created: at(55), started_at: at(60), ended_at: at(90), supersedes: 'L-4', report: report('', { check: check(8), resolved_by: 'ai' }) });
    // Chain 4: a conflict that never landed.
    put('L-6', 'failed', { created: at(100), started_at: at(101), ended_at: at(105), failure: { code: 'conflict', summary: '' }, report: report('', { resolved_by: null }) });
    // Outside the window.
    put('L-7', 'landed', { created: t - 10 * DAY, started_at: t - 10 * DAY, ended_at: t - 10 * DAY + MIN, report: report('', { check: check(60), resolved_by: 'clean' }) });
    expect(hub.landingStats(P, 7)).toEqual({
      days: 7,
      landed: 3,
      median_to_trunk_ms: 20 * MIN,
      p90_to_trunk_ms: 40 * MIN,
      first_try_rate: 0.67,
      sendbacks: { checks_failed: 1, conflict: 1 },
      median_check_ms: 5 * MIN,
      median_queue_wait_ms: MIN,
      resolved_by: { clean: 1, structural: 1, ai: 1 },
    });
    expect(hub.landingStats(P, 30)).toMatchObject({ days: 30, landed: 4 });
    expect(hub.landingStats('empty')).toEqual({
      days: 7,
      landed: 0,
      median_to_trunk_ms: null,
      p90_to_trunk_ms: null,
      first_try_rate: null,
      sendbacks: {},
      median_check_ms: null,
      median_queue_wait_ms: null,
      resolved_by: {},
    });
  });
});

describe('a landing that comes back', () => {
  it("ends its author's queued claim that would close a wait cycle once the holds are leases again", () => {
    const w = world();
    w.land(A, ['x.ts'], sha('1')); // L-1 holds x.ts
    const theirs = w.hub.claim(P, B, { files: ['y.ts'] }).claim!;
    const bWaits = w.hub.claim(P, B, { files: ['x.ts'], queue: true }); // B waits for the landing
    const aWaits = w.hub.claim(P, A, { files: ['y.ts'], queue: true }); // A waits for B: no cycle while x.ts is a hold
    expect([bWaits.status, aWaits.status]).toEqual(['queued', 'queued']);
    w.hub.cancelLanding(P, A, 'L-1', {});
    // x.ts is A's again, so A's wait for B would close a cycle: it ends, with the reason.
    expect(w.hub.getClaim(P, aWaits.claim!.id)).toMatchObject({ status: 'released', end_reason: expect.stringContaining('L-1') });
    expect(w.hub.getClaim(P, bWaits.claim!.id).status).toBe('queued');
    expect(w.hub.getClaim(P, theirs.id).status).toBe('active');
    // Asking again is refused with the deadlock explained, as for any request that would close one.
    expect(codeOf(() => w.hub.claim(P, A, { files: ['y.ts'], queue: true }))).toEqual(['deadlock', 409]);
    // Once A lets x.ts go, B gets it.
    w.hub.release(P, A, { files: ['x.ts'] });
    expect(w.hub.getClaim(P, bWaits.claim!.id).status).toBe('active');
  });
});

describe('the H2 helpers stay consistent with the protocol', () => {
  it('a landing failed by the test helper is a retry chain start, like one the lander failed', () => {
    const w = world();
    w.land(A, ['a.ts'], sha('1'));
    failLanding(w.hub, 'L-1');
    expect(w.land(A, ['a.ts'], sha('2'), { task: 'T-1' }).landing).toMatchObject({ retry_of: 'L-1', retry: 1, queue_seq: 1 });
  });
});
