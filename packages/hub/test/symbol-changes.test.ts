import { afterEach, describe, expect, it } from 'vitest';
import { Hub, SqliteStore, startServer, type HubEvent, type RunningServer, type SymbolChangeStatus } from '../src/index.js';
import { A, B, C, HOUR, LANDER, LANDER_AUTH, MIN, P, T0, errorOf, report, setup, sha, takeLease } from './landing-setup.js';

// H6 (design §2.5, §1.7, §1.8, §2.1): signature changes. Agents post
// in-progress changes (an upsert per agent, file and symbol; after == before
// withdraws); the lander's landed changes are recorded at advance/resolve
// landed and supersede the author's in-progress rows for the task; reads link
// up to 3 decisions; symbol.changed carries ids and names, never signature
// text. Fake clock, in-memory store, and the two routes over HTTP.

const DAY = 24 * HOUR;
const AUTH = 'src/auth.ts';
const LOGIN_0 = 'login(user: string, password: string, remember: boolean): Promise<Session>';
const LOGIN_1 = 'login(user: string, password: string, opts?: LoginOptions): Promise<Session>';
const LOGIN_2 = 'login(user: string, opts: LoginOptions): Promise<Session>';
const LOGOUT_0 = 'logout(session: Session): void';
const LOGOUT_1 = 'logout(session: Session, everywhere: boolean): void';
const REFRESH_0 = 'refresh(): void';
const REFRESH_1 = 'refresh(force: boolean): void';
/** Every signature text the tests post: none of it may appear in an event. */
const TEXTS = [LOGIN_0, LOGIN_1, LOGIN_2, LOGOUT_0, LOGOUT_1, REFRESH_0, REFRESH_1];
const EVENT_KEYS = ['agent', 'change_id', 'file', 'kind', 'landing_id', 'name', 'status', 'symbol', 'task_id'];

/** A signature change of `symbol` in src/auth.ts. */
const sig = (symbol: string, before: string, after: string, extra: Record<string, unknown> = {}) => ({ file: AUTH, symbol, kind: 'signature', before, after, ...extra });

function world() {
  const s = setup();
  const { hub } = s;
  const lease = takeLease(hub, LANDER, DAY).lease;
  const task = (agent: string, title: string) => {
    const id = hub.createTask(P, agent, { title }).id;
    hub.takeTask(P, agent, id);
    return id;
  };
  const post = (agent: string, changes: unknown[]) => hub.postSymbolChanges(P, agent, { changes } as never);
  const list = (opts: { since_ms?: number | string; statuses?: string[] } = {}) => hub.listSymbolChanges(P, opts as never).changes;
  const rows = (statuses: SymbolChangeStatus[]) => list({ since_ms: 0, statuses });
  const changed = (since = 0) => s.events.filter((e) => e.type === 'symbol.changed' && e.seq > since);
  const seq = () => s.events.at(-1)?.seq ?? 0;
  /** `agent` queues `commit` for `taskId` (or for no task), and the lander takes it to pushing candidate `candidate`. */
  const toPushing = (agent: string, taskId: string | undefined, files: string[], commit: string, candidate = sha('c'), l = lease) => {
    hub.claim(P, agent, { files, ...(taskId ? { task_id: taskId } : {}) });
    const id = hub.land(P, agent, { ...(taskId ? { task_id: taskId } : {}), commit, queue: true, files }).landing.id;
    hub.admitLanding(P, LANDER, id, { lease: l, base_sha: sha('0'), files, scope: null, mapper: null, protected: [], required: [], waits_for: null, warnings: [] } as never, LANDER_AUTH);
    const picked = hub.nextLanding(P, LANDER, { lease: l }, LANDER_AUTH).landing!;
    expect(picked.id).toBe(id);
    hub.advanceLanding(
      P,
      LANDER,
      id,
      { lease: l, attempt: picked.attempt, to: 'running', phase: 'pushing', candidate, candidate_ref: `refs/agenthub/cand/x/${id}/cccccccccccc`, trunk_base: sha('a'), tree: sha('e'), required: [] } as never,
      LANDER_AUTH,
    );
    return id;
  };
  const landed = (id: string, symbol_changes: unknown, trunk_sha = sha('c'), l = lease) =>
    hub.advanceLanding(
      P,
      LANDER,
      id,
      { lease: l, attempt: hub.getLanding(P, id).attempt, to: 'landed', trunk_sha, base_sha: sha('0'), files: hub.getLanding(P, id).files, report: report(`${id} landed.`), also_landed: [], symbol_changes } as never,
      LANDER_AUTH,
    );
  return { ...s, tick: s.advance, lease, task, post, list, rows, changed, seq, toPushing, landed };
}

/** Each symbol.changed event has exactly the §1.8 keys and none of the posted signature text. */
function expectNoText(events: HubEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    expect(e.type).toBe('symbol.changed');
    expect(e.targets).toBeNull();
    expect(Object.keys(e.data).sort()).toEqual(EVENT_KEYS);
    const text = JSON.stringify(e);
    for (const t of TEXTS) expect(text).not.toContain(t);
    expect(text).not.toMatch(/\(|LoginOptions|Promise/);
  }
}

describe('in-progress changes (POST /symbol-changes)', () => {
  it('upserts one row per (agent, file, symbol): S-n ids, name = the last segment, the first before kept, and each new or changed row emits symbol.changed', () => {
    const w = world();
    const t1 = w.task(A, 'Let login take an options object');
    const r1 = w.post(A, [sig('login', LOGIN_0, LOGIN_1), { file: 'src/session.ts', symbol: 'Session.refresh', kind: 'signature', before: REFRESH_0, after: REFRESH_1 }]);
    expect(r1).toMatchObject({ now: T0, seq: w.seq() });
    expect(r1.changes).toEqual([
      {
        id: 'S-1',
        project: P,
        agent: A,
        task_id: t1,
        landing_id: null,
        file: AUTH,
        symbol: 'login',
        name: 'login',
        kind: 'signature',
        before: LOGIN_0,
        after: LOGIN_1,
        renamed_to: null,
        status: 'in_progress',
        created_at: T0,
        updated_at: T0,
        decisions: [],
      },
      expect.objectContaining({ id: 'S-2', file: 'src/session.ts', symbol: 'Session.refresh', name: 'refresh', before: REFRESH_0, after: REFRESH_1, task_id: t1 }),
    ]);
    const first = w.changed();
    expect(first.map((e) => [e.actor, e.data])).toEqual([
      [A, { change_id: 'S-1', agent: A, file: AUTH, symbol: 'login', name: 'login', kind: 'signature', status: 'in_progress', landing_id: null, task_id: t1 }],
      [A, { change_id: 'S-2', agent: A, file: 'src/session.ts', symbol: 'Session.refresh', name: 'refresh', kind: 'signature', status: 'in_progress', landing_id: null, task_id: t1 }],
    ]);

    // The next edit of login: the same row, the change since the first before.
    w.tick(MIN);
    let since = w.seq();
    const r2 = w.post(A, [sig('login', LOGIN_1, LOGIN_2)]);
    expect(r2.changes).toEqual([expect.objectContaining({ id: 'S-1', before: LOGIN_0, after: LOGIN_2, status: 'in_progress', created_at: T0, updated_at: T0 + MIN })]);
    expect(w.changed(since).map((e) => e.data.change_id)).toEqual(['S-1']);

    // The same change again changes nothing: no event, the row as it was.
    w.tick(MIN);
    since = w.seq();
    expect(w.post(A, [sig('login', LOGIN_1, LOGIN_2)]).changes).toEqual([expect.objectContaining({ id: 'S-1', after: LOGIN_2, updated_at: T0 + MIN })]);
    expect(w.changed(since)).toEqual([]);

    // Another agent's change of the same symbol is its own row.
    const r3 = w.post(B, [sig('login', LOGIN_0, LOGIN_1)]);
    expect(r3.changes).toEqual([expect.objectContaining({ id: 'S-3', agent: B, task_id: null, before: LOGIN_0, after: LOGIN_1 })]);
    expect(w.list().map((c) => c.id)).toEqual(['S-3', 'S-1', 'S-2']);
    expect(w.hub.store.listSymbolChanges(P, { since: 0, statuses: ['in_progress', 'landed', 'withdrawn', 'superseded'] })).toHaveLength(3);
  });

  it("takes the request's task, else the agent's one task in progress, else the row's; an unknown task is 404 and nothing is written", () => {
    const w = world();
    const t1 = w.task(A, 'one');
    const t2 = w.task(A, 'two');
    // Two tasks in progress: none is guessed.
    expect(w.post(A, [sig('login', LOGIN_0, LOGIN_1)]).changes[0].task_id).toBeNull();
    expect(w.post(A, [sig('login', LOGIN_1, LOGIN_2, { task_id: t2 })]).changes[0]).toMatchObject({ id: 'S-1', task_id: t2 });
    // A later edit that names no task keeps the row's.
    expect(w.post(A, [sig('login', LOGIN_2, LOGIN_1)]).changes[0]).toMatchObject({ id: 'S-1', task_id: t2 });
    expect(w.post(A, [sig('logout', LOGOUT_0, LOGOUT_1, { task_id: t1 })]).changes[0]).toMatchObject({ id: 'S-2', task_id: t1 });

    const since = w.seq();
    const err = errorOf(() => w.post(A, [sig('Session.refresh', REFRESH_0, REFRESH_1), sig('logout', LOGOUT_1, LOGOUT_0, { task_id: 'T-99' })]));
    expect([err.code, err.status]).toEqual(['not_found', 404]);
    expect(w.changed(since)).toEqual([]);
    expect(w.rows(['in_progress', 'withdrawn']).map((c) => c.id).sort()).toEqual(['S-1', 'S-2']);
  });

  it('removed and renamed: after is null for a removed symbol; renamed_to names the new key', () => {
    const w = world();
    const r = w.post(A, [
      { file: AUTH, symbol: 'logout', kind: 'removed', before: LOGOUT_0, after: null },
      { file: AUTH, symbol: 'rememberDays', kind: 'renamed', before: 'rememberDays(remember: boolean): number', after: 'sessionDays(opts: LoginOptions): number', renamed_to: 'sessionDays' },
      { file: AUTH, symbol: 'Session.close', kind: 'removed', before: 'close(): void' },
    ]);
    expect(r.changes).toEqual([
      expect.objectContaining({ id: 'S-1', symbol: 'logout', name: 'logout', kind: 'removed', before: LOGOUT_0, after: null, renamed_to: null }),
      expect.objectContaining({ id: 'S-2', symbol: 'rememberDays', kind: 'renamed', after: 'sessionDays(opts: LoginOptions): number', renamed_to: 'sessionDays' }),
      expect.objectContaining({ id: 'S-3', symbol: 'Session.close', name: 'close', kind: 'removed', after: null }),
    ]);
    // An edit after a signature change that removes the symbol: removed, measured from the first before.
    w.post(A, [sig('login', LOGIN_0, LOGIN_1)]);
    expect(w.post(A, [{ file: AUTH, symbol: 'login', kind: 'removed', before: LOGIN_1, after: null }]).changes[0]).toMatchObject({ id: 'S-4', kind: 'removed', before: LOGIN_0, after: null });
  });
});

describe('withdrawing (after == before)', () => {
  it('a change whose after equals its before withdraws the open row: withdrawn, announced, and out of the default listing', () => {
    const w = world();
    w.post(A, [sig('login', LOGIN_0, LOGIN_1), sig('logout', LOGOUT_0, LOGOUT_1)]);
    w.tick(MIN);
    const since = w.seq();
    const r = w.post(A, [sig('login', LOGIN_1, LOGIN_1)]);
    expect(r.changes).toEqual([expect.objectContaining({ id: 'S-1', status: 'withdrawn', before: LOGIN_0, after: LOGIN_1, updated_at: T0 + MIN })]);
    expect(w.changed(since).map((e) => [e.actor, e.data.change_id, e.data.status])).toEqual([[A, 'S-1', 'withdrawn']]);
    expect(w.list().map((c) => c.id)).toEqual(['S-2']);
    expect(w.list({ statuses: ['withdrawn'] }).map((c) => c.id)).toEqual(['S-1']);
    // Another agent's post never withdraws A's row.
    w.post(B, [sig('logout', LOGOUT_0, LOGOUT_0)]);
    expect(w.list().map((c) => [c.id, c.status])).toEqual([['S-2', 'in_progress']]);
  });

  it('an edit that brings the signature back to the first before withdraws the change', () => {
    const w = world();
    w.post(A, [sig('login', LOGIN_0, LOGIN_1)]);
    w.post(A, [sig('login', LOGIN_1, LOGIN_2)]);
    const since = w.seq();
    expect(w.post(A, [sig('login', LOGIN_2, LOGIN_0)]).changes).toEqual([expect.objectContaining({ id: 'S-1', status: 'withdrawn' })]);
    expect(w.changed(since).map((e) => e.data.status)).toEqual(['withdrawn']);
    expect(w.list()).toEqual([]);
  });

  it('with nothing open, withdrawing records nothing; the next change opens a new row', () => {
    const w = world();
    const since = w.seq();
    expect(w.post(A, [sig('login', LOGIN_0, LOGIN_0)]).changes).toEqual([]);
    expect(w.changed(since)).toEqual([]);
    w.post(A, [sig('login', LOGIN_0, LOGIN_1)]);
    w.post(A, [sig('login', LOGIN_1, LOGIN_1)]);
    expect(w.post(A, [sig('login', LOGIN_0, LOGIN_2)]).changes).toEqual([expect.objectContaining({ id: 'S-2', status: 'in_progress', before: LOGIN_0, after: LOGIN_2 })]);
    expect(w.rows(['in_progress', 'withdrawn']).map((c) => [c.id, c.status])).toEqual([
      ['S-2', 'in_progress'],
      ['S-1', 'withdrawn'],
    ]);
  });
});

describe('landed changes (advance landed, resolve landed)', () => {
  it("advance landed records the landed rows with the landing id and supersedes the author's in-progress rows for that task, and nothing else", () => {
    const w = world();
    const t1 = w.task(A, 'Let login take an options object');
    const t2 = w.task(A, 'Cache sessions');
    const t3 = w.task(B, 'Rate-limit login');
    w.post(A, [sig('login', LOGIN_0, LOGIN_1, { task_id: t1 }), sig('logout', LOGOUT_0, LOGOUT_1, { task_id: t1 })]);
    w.post(A, [{ file: 'src/cache.ts', symbol: 'Cache.get', kind: 'signature', before: 'get(k: string): Session', after: 'get(k: string): Session | null', task_id: t2 }]);
    w.post(B, [sig('login', LOGIN_0, LOGIN_2)]);
    expect(w.list().map((c) => [c.id, c.agent, c.task_id])).toEqual([
      ['S-4', B, t3],
      ['S-3', A, t2],
      ['S-2', A, t1],
      ['S-1', A, t1],
    ]);

    const id = w.toPushing(A, t1, [AUTH], sha('1'));
    w.tick(MIN);
    const since = w.seq();
    // The lander's task_id is not what the hub records: the landing's task is.
    const r = w.landed(id, [sig('login', LOGIN_0, LOGIN_2, { task_id: 'T-9' })]);
    expect(r.landing.status).toBe('landed');
    const after = w.events.filter((e) => e.seq > since);
    expect(after.map((e) => e.type).slice(-5)).toEqual(['landing.landed', 'trunk.moved', 'symbol.changed', 'symbol.changed', 'symbol.changed']);
    expect(w.changed(since).map((e) => [e.actor, e.data])).toEqual([
      [LANDER, { change_id: 'S-5', agent: A, file: AUTH, symbol: 'login', name: 'login', kind: 'signature', status: 'landed', landing_id: id, task_id: t1 }],
      [LANDER, { change_id: 'S-1', agent: A, file: AUTH, symbol: 'login', name: 'login', kind: 'signature', status: 'superseded', landing_id: null, task_id: t1 }],
      [LANDER, { change_id: 'S-2', agent: A, file: AUTH, symbol: 'logout', name: 'logout', kind: 'signature', status: 'superseded', landing_id: null, task_id: t1 }],
    ]);
    expect(w.list()).toEqual([
      expect.objectContaining({ id: 'S-5', agent: A, task_id: t1, landing_id: id, status: 'landed', before: LOGIN_0, after: LOGIN_2, created_at: T0 + MIN, updated_at: T0 + MIN }),
      expect.objectContaining({ id: 'S-4', agent: B, status: 'in_progress' }),
      expect.objectContaining({ id: 'S-3', agent: A, task_id: t2, status: 'in_progress' }),
    ]);
    expect(w.list({ statuses: ['superseded'] }).map((c) => [c.id, c.updated_at])).toEqual([
      ['S-2', T0 + MIN],
      ['S-1', T0 + MIN],
    ]);

    // A repeated advance landed is a replay: no second row, no event.
    const replaySince = w.seq();
    expect(w.landed(id, [sig('login', LOGIN_0, LOGIN_2)]).replayed).toBe(true);
    expect(w.changed(replaySince)).toEqual([]);
    expect(w.rows(['landed'])).toHaveLength(1);

    // A's next edit of login, after the landing: a new in-progress row.
    expect(w.post(A, [sig('login', LOGIN_2, LOGIN_1)]).changes[0]).toMatchObject({ id: 'S-6', status: 'in_progress', before: LOGIN_2 });
  });

  it("resolve landed (in doubt) records them too; an entry the hub can't record is left out rather than refusing the landing", () => {
    const w = world();
    const t1 = w.task(A, 'Let login take an options object');
    w.post(A, [sig('login', LOGIN_0, LOGIN_1)]);
    const id = w.toPushing(A, t1, [AUTH], sha('1'));
    // The lease ends while the landing is in pushing: in doubt, resolved by the next lease.
    w.hub.release(P, LANDER, { claim_id: w.lease.lease_claim_id });
    const lease2 = takeLease(w.hub, LANDER, DAY).lease;
    expect(w.hub.nextLanding(P, LANDER, { lease: lease2 }, LANDER_AUTH)).toMatchObject({ resolve: true, landing: { id, in_doubt: true } });
    const since = w.seq();
    const r = w.hub.resolveLanding(
      P,
      LANDER,
      id,
      {
        lease: lease2,
        outcome: 'landed',
        trunk_sha: sha('c'),
        symbol_changes: [
          sig('not a key', LOGIN_0, LOGIN_1),
          { file: '/etc/passwd', symbol: 'login', kind: 'signature', before: LOGIN_0, after: LOGIN_1 },
          sig('login', LOGIN_0, LOGIN_1, { kind: 'moved' }),
          'login',
          sig('login', LOGIN_0, LOGIN_2),
          sig('logout', LOGOUT_0, LOGOUT_0),
        ],
      } as never,
      LANDER_AUTH,
    );
    expect(r.landing.status).toBe('landed');
    expect(w.changed(since).map((e) => [e.data.change_id, e.data.symbol, e.data.status, e.data.landing_id])).toEqual([
      ['S-2', 'login', 'landed', id],
      ['S-1', 'login', 'superseded', null],
    ]);
    expect(w.list()).toEqual([expect.objectContaining({ id: 'S-2', landing_id: id, task_id: t1, before: LOGIN_0, after: LOGIN_2 })]);
    // A replayed resolve records nothing more.
    expect(w.hub.resolveLanding(P, LANDER, id, { lease: lease2, outcome: 'landed', trunk_sha: sha('c'), symbol_changes: [sig('login', LOGIN_0, LOGIN_2)] } as never, LANDER_AUTH).replayed).toBe(true);
    expect(w.rows(['landed'])).toHaveLength(1);
  });

  it('a landing that reports no change still supersedes the in-progress rows of its task; one without a task, those without a task', () => {
    const w = world();
    const t1 = w.task(A, 'Let login take an options object');
    w.post(A, [sig('login', LOGIN_0, LOGIN_1)]);
    const l1 = w.toPushing(A, t1, [AUTH], sha('1'));
    w.landed(l1, []);
    expect(w.rows(['superseded']).map((c) => c.id)).toEqual(['S-1']);
    expect(w.rows(['landed'])).toEqual([]);

    // No task in progress now: A's next change has none, and neither has the next landing.
    w.post(A, [sig('logout', LOGOUT_0, LOGOUT_1)]);
    const t2 = w.task(A, 'Cache sessions');
    w.post(A, [{ file: 'src/cache.ts', symbol: 'Cache.get', kind: 'signature', before: 'get(k: string): Session', after: 'get(k: string): Session | null' }]);
    expect(w.list().map((c) => [c.id, c.task_id])).toEqual([
      ['S-3', t2],
      ['S-2', null],
    ]);
    const l2 = w.toPushing(A, undefined, ['src/other.ts'], sha('2'), sha('d'));
    w.landed(l2, [], sha('d'));
    expect(w.rows(['superseded']).map((c) => c.id)).toEqual(['S-2', 'S-1']);
    expect(w.list().map((c) => [c.id, c.status])).toEqual([['S-3', 'in_progress']]);
  });

  it('a landing found on trunk by a trunk report (reconciled) leaves symbol changes alone', () => {
    const w = world();
    const t1 = w.task(A, 'Let login take an options object');
    w.post(A, [sig('login', LOGIN_0, LOGIN_1)]);
    w.hub.claim(P, A, { files: [AUTH], task_id: t1 });
    const landing = w.hub.land(P, A, { task_id: t1, commit: sha('1'), queue: true, files: [AUTH] }).landing;
    const since = w.seq();
    w.hub.reportTrunk(
      P,
      LANDER,
      {
        lease: w.lease,
        from: null,
        to: sha('b'),
        commits: [{ sha: sha('b'), landing: `${P}/${landing.id}`, hub: w.hub.epoch, source: sha('1'), files: [AUTH] }],
        rewritten: false,
        policy: { keep_place_retries: 2, sendback_grace_min: 30, approval_timeout_hours: 24, claim_gate: 'fail' },
      },
      LANDER_AUTH,
    );
    expect(w.hub.getLanding(P, landing.id)).toMatchObject({ status: 'landed', reconciled: true });
    expect(w.changed(since)).toEqual([]);
    expect(w.list().map((c) => [c.id, c.status])).toEqual([['S-1', 'in_progress']]);
  });
});

describe('decision linkage', () => {
  it('links up to 3 decisions, newest first: those of the same task, or whose symbols name the key or the name', () => {
    const w = world();
    const t1 = w.task(A, 'Let login take an options object');
    const t2 = w.task(B, 'Something else');
    const decide = (agent: string, summary: string, extra: { task_id?: string; symbols?: string[] } = {}) => w.hub.decide(P, agent, { summary, ...extra }).id;
    const d1 = decide(B, 'Sessions are refreshed by the client', { task_id: t1 });
    const d2 = decide(C, 'refresh takes a force flag', { symbols: ['refresh'] });
    const d3 = decide(B, 'Session.refresh must be idempotent', { symbols: ['Session.refresh'] });
    const d4 = decide(C, 'Refreshing is explicit', { symbols: ['src/session.ts#Session.refresh'] });
    decide(C, 'Session is a class', { symbols: ['Session'] });
    decide(C, 'other refresh', { symbols: ['src/other.ts#refresh'] });
    decide(C, 'unrelated', { task_id: t2, symbols: ['logout'] });

    const r = w.post(A, [
      { file: 'src/session.ts', symbol: 'Session.refresh', kind: 'signature', before: REFRESH_0, after: REFRESH_1, task_id: t1 },
      sig('login', LOGIN_0, LOGIN_1, { task_id: t1 }),
      sig('Auth.check', 'check(): boolean', 'check(strict: boolean): boolean', { task_id: t2 }),
    ]);
    expect(r.changes.map((c) => c.decisions)).toEqual([
      [
        { id: d4, agent: C, summary: 'Refreshing is explicit' },
        { id: d3, agent: B, summary: 'Session.refresh must be idempotent' },
        { id: d2, agent: C, summary: 'refresh takes a force flag' },
      ],
      [{ id: d1, agent: B, summary: 'Sessions are refreshed by the client' }],
      [expect.objectContaining({ summary: 'unrelated' })],
    ]);

    // Linked when read: a decision recorded after the change shows on the next read, and in both directions (task, symbol).
    const d8 = decide(B, 'login() takes an options object', { symbols: ['login()'] });
    const login = w.list().find((c) => c.symbol === 'login')!;
    expect(login.decisions.map((d) => d.id)).toEqual([d8, d1]);
    expect(Object.keys(login.decisions[0]).sort()).toEqual(['agent', 'id', 'summary']);
    // A change with no task and no decision naming it: none (D-5 names the container, not its member).
    expect(w.post(C, [{ file: AUTH, symbol: 'Session.close', kind: 'removed', before: 'close(): void', after: null }]).changes[0].decisions).toEqual([]);
  });

  it('landed rows are linked too: by their landing’s task', () => {
    const w = world();
    const t1 = w.task(A, 'Let login take an options object');
    const d1 = w.hub.decide(P, A, { summary: 'login() takes an options object', task_id: t1 }).id;
    const id = w.toPushing(A, t1, [AUTH], sha('1'));
    w.landed(id, [sig('Auth.verify', 'verify(): void', 'verify(token: string): void')]);
    expect(w.list()).toEqual([expect.objectContaining({ symbol: 'Auth.verify', status: 'landed', decisions: [{ id: d1, agent: A, summary: 'login() takes an options object' }] })]);
  });
});

describe('symbol.changed events', () => {
  it('carry change_id, agent, file, symbol, name, kind, status, landing_id and task_id: never signature text', () => {
    const w = world();
    const t1 = w.task(A, 'Let login take an options object');
    w.post(A, [sig('login', LOGIN_0, LOGIN_1), sig('logout', LOGOUT_0, LOGOUT_1), { file: 'src/session.ts', symbol: 'Session.refresh', kind: 'signature', before: REFRESH_0, after: REFRESH_1 }]);
    w.post(A, [sig('logout', LOGOUT_1, LOGOUT_0)]);
    w.post(A, [{ file: AUTH, symbol: 'rememberDays', kind: 'renamed', before: 'rememberDays(remember: boolean): number', after: 'sessionDays(opts: LoginOptions): number', renamed_to: 'sessionDays' }]);
    const id = w.toPushing(A, t1, [AUTH], sha('1'));
    w.landed(id, [sig('login', LOGIN_0, LOGIN_2), { file: AUTH, symbol: 'Session.close', kind: 'removed', before: 'close(): void', after: null }]);
    const events = w.changed();
    expect(events.map((e) => e.data.status)).toEqual(['in_progress', 'in_progress', 'in_progress', 'withdrawn', 'in_progress', 'landed', 'landed', 'superseded', 'superseded', 'superseded']);
    expectNoText(events);
    expect(JSON.stringify(events)).not.toContain('sessionDays');
    expect(JSON.stringify(events)).not.toContain('close()');
  });
});

describe('validation', () => {
  it('invalid_symbol: a symbol or renamed_to that is not a declaration key; nothing is written', () => {
    const w = world();
    const refused = (change: Record<string, unknown>) => {
      const since = w.seq();
      const err = errorOf(() => w.post(A, [sig('login', LOGIN_0, LOGIN_1), change]));
      expect([err.code, err.status], JSON.stringify(change)).toEqual(['invalid_symbol', 400]);
      expect(w.changed(since)).toEqual([]);
    };
    refused(sig('not a key', LOGIN_0, LOGIN_1));
    refused(sig('', LOGIN_0, LOGIN_1));
    refused(sig('a'.repeat(201), LOGIN_0, LOGIN_1));
    refused(sig('Session..refresh', LOGIN_0, LOGIN_1));
    refused(sig('@imports', LOGIN_0, LOGIN_1));
    refused(sig('@toplevel', LOGIN_0, LOGIN_1));
    refused(sig(42 as never, LOGIN_0, LOGIN_1));
    refused({ file: AUTH, kind: 'signature', before: LOGIN_0, after: LOGIN_1 });
    refused({ file: AUTH, symbol: 'rememberDays', kind: 'renamed', before: 'rememberDays(): number', after: 'session days(): number', renamed_to: 'session days' });
    expect(w.rows(['in_progress', 'landed', 'withdrawn', 'superseded'])).toEqual([]);
    // A key of 200 characters, and an NFD spelling stored as NFC.
    expect(w.post(A, [sig('a'.repeat(200), LOGIN_0, LOGIN_1), sig('Café.ok', LOGIN_0, LOGIN_1)]).changes.map((c) => c.symbol)).toEqual(['a'.repeat(200), 'Café.ok']);
  });

  it('other problems are 400 bad_request, invalid_path or 403 forbidden; signature text is cleaned and capped at 500 characters', () => {
    const w = world();
    const code = (body: unknown) => {
      const err = errorOf(() => w.hub.postSymbolChanges(P, A, body as never));
      return [err.code, err.status];
    };
    expect(code({})).toEqual(['bad_request', 400]);
    expect(code({ changes: 'login' })).toEqual(['bad_request', 400]);
    expect(code({ changes: Array.from({ length: 201 }, () => sig('login', LOGIN_0, LOGIN_1)) })).toEqual(['bad_request', 400]);
    expect(code({ changes: ['login'] })).toEqual(['bad_request', 400]);
    expect(code({ changes: [sig('login', LOGIN_0, LOGIN_1, { kind: 'moved' })] })).toEqual(['bad_request', 400]);
    expect(code({ changes: [sig('login', '', LOGIN_1)] })).toEqual(['bad_request', 400]);
    expect(code({ changes: [{ file: AUTH, symbol: 'login', kind: 'signature', after: LOGIN_1 }] })).toEqual(['bad_request', 400]);
    expect(code({ changes: [sig('login', LOGIN_0, null as never)] })).toEqual(['bad_request', 400]);
    expect(code({ changes: [{ file: AUTH, symbol: 'login', kind: 'removed', before: LOGIN_0, after: LOGIN_1 }] })).toEqual(['bad_request', 400]);
    expect(code({ changes: [{ file: AUTH, symbol: 'login', kind: 'renamed', before: LOGIN_0, after: LOGIN_1 }] })).toEqual(['bad_request', 400]);
    expect(code({ changes: [sig('login', LOGIN_0, LOGIN_1, { renamed_to: 'signIn' })] })).toEqual(['bad_request', 400]);
    expect(code({ changes: [sig('login', LOGIN_0, LOGIN_1, { task_id: { id: 'T-1' } })] })).toEqual(['bad_request', 400]);
    expect(code({ changes: [sig('login', LOGIN_0, LOGIN_1, { file: '/etc/passwd' })] })).toEqual(['invalid_path', 400]);
    expect(code({ changes: [sig('login', LOGIN_0, LOGIN_1, { file: 'src/../auth.ts' })] })).toEqual(['invalid_path', 400]);
    expect(code({ changes: [sig('login', LOGIN_0, LOGIN_1, { file: '.git/agenthub/lander' })] })).toEqual(['forbidden', 403]);
    expect(errorOf(() => w.hub.postSymbolChanges(P, 'not an agent', { changes: [] })).code).toBe('bad_agent');
    expect(w.rows(['in_progress', 'landed', 'withdrawn', 'superseded'])).toEqual([]);

    // An empty list is fine, and changes nothing.
    expect(w.post(A, [])).toMatchObject({ changes: [], now: T0 });
    const long = `login(${'x: number, '.repeat(80)})`;
    const [row] = w.post(A, [sig('login', `login(\u0007user‮: string)`, long)]).changes;
    expect(row.before).toBe('login(user: string)');
    expect(row.after).toHaveLength(500);
    expect(row.after!.endsWith('…')).toBe(true);
  });
});

describe('listing (GET /symbol-changes)', () => {
  it('defaults to the last 24 hours, in progress and landed; since_ms (a time) and status choose otherwise', () => {
    const w = world();
    w.post(A, [sig('login', LOGIN_0, LOGIN_1), sig('logout', LOGOUT_0, LOGOUT_1)]);
    w.post(A, [sig('logout', LOGOUT_1, LOGOUT_0)]);
    w.tick(DAY + MIN);
    w.post(B, [sig('login', LOGIN_0, LOGIN_2)]);
    expect(w.list().map((c) => c.id)).toEqual(['S-3']);
    expect(w.hub.listSymbolChanges(P)).toMatchObject({ now: T0 + DAY + MIN, seq: w.seq() });
    expect(w.list({ since_ms: 0 }).map((c) => c.id)).toEqual(['S-3', 'S-1']);
    expect(w.list({ since_ms: String(T0) }).map((c) => c.id)).toEqual(['S-3', 'S-1']);
    expect(w.list({ since_ms: T0 + 1 }).map((c) => c.id)).toEqual(['S-3']);
    expect(w.list({ since_ms: 0, statuses: ['withdrawn'] }).map((c) => c.id)).toEqual(['S-2']);
    expect(w.list({ since_ms: 0, statuses: ['in_progress', 'withdrawn'] }).map((c) => c.id)).toEqual(['S-3', 'S-2', 'S-1']);
    expect(w.list({ since_ms: '', statuses: [] }).map((c) => c.id)).toEqual(['S-3']);
    for (const bad of [{ statuses: ['done'] }, { since_ms: 'yesterday' }, { since_ms: -1 }, { statuses: 'landed' }]) {
      expect(errorOf(() => w.list(bad as never)).code, JSON.stringify(bad)).toBe('bad_request');
    }
  });
});

// ------------------------------------------------------------ over HTTP

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('the routes over HTTP', () => {
  it('POST /symbol-changes needs an agent; GET /symbol-changes reads with since_ms and status; errors keep their codes', async () => {
    const hub = new Hub({ store: new SqliteStore(':memory:') });
    const server = await startServer({ hub, port: 0 });
    servers.push(server);
    const call = async (method: string, route: string, body?: unknown, agent?: string) => {
      const res = await fetch(`${server.url}/v1/p/demo${route}`, {
        method,
        headers: { ...(agent ? { 'x-hub-agent': agent } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json()) as any };
    };
    expect(await call('POST', '/symbol-changes', { changes: [sig('login', LOGIN_0, LOGIN_1)] })).toMatchObject({ status: 400, json: { error: { code: 'bad_agent' } } });
    expect(await call('POST', '/symbol-changes', { changes: [sig('not a key', LOGIN_0, LOGIN_1)] }, A)).toMatchObject({ status: 400, json: { error: { code: 'invalid_symbol' } } });
    const posted = await call('POST', '/symbol-changes', { changes: [sig('login', LOGIN_0, LOGIN_1), sig('logout', LOGOUT_0, LOGOUT_1)] }, A);
    expect(posted.status).toBe(200);
    expect(posted.json.changes.map((c: any) => [c.id, c.status])).toEqual([
      ['S-1', 'in_progress'],
      ['S-2', 'in_progress'],
    ]);
    await call('POST', '/symbol-changes', { changes: [sig('logout', LOGOUT_1, LOGOUT_0)] }, A);

    const read = await call('GET', '/symbol-changes');
    expect(read.status).toBe(200);
    expect(Object.keys(read.json).sort()).toEqual(['changes', 'now', 'seq']);
    expect(read.json.changes.map((c: any) => c.id)).toEqual(['S-1']);
    expect((await call('GET', '/symbol-changes?status=in_progress,withdrawn&since_ms=0')).json.changes.map((c: any) => c.id)).toEqual(['S-2', 'S-1']);
    expect((await call('GET', `/symbol-changes?since_ms=${Date.now() + DAY}`)).json.changes).toEqual([]);
    expect(await call('GET', '/symbol-changes?status=done')).toMatchObject({ status: 400, json: { error: { code: 'bad_request' } } });
    const events = (await call('GET', '/events?since=0', undefined, B)).json.events.filter((e: any) => e.type === 'symbol.changed');
    expect(events.map((e: any) => e.data.status)).toEqual(['in_progress', 'in_progress', 'withdrawn']);
    expectNoText(events);
  });
});
