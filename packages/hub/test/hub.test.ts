import { describe, expect, it } from 'vitest';
import { Hub, HubError, SqliteStore, type HubEvent } from '../src/index.js';

const P = 'demo';
const A = 'maya/claude-1';
const B = 'sam/claude-1';
const C = 'lee/codex-1';

function setup(opts: { leaseTtlMs?: number } = {}) {
  const clock = { t: Date.UTC(2026, 9, 20, 9, 0, 0) };
  const store = new SqliteStore(':memory:');
  const hub = new Hub({ store, now: () => clock.t, leaseTtlMs: opts.leaseTtlMs ?? 60_000, heartbeatIntervalMs: 15_000 });
  const events: HubEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const advance = (ms: number) => {
    clock.t += ms;
  };
  return { hub, store, clock, events, advance };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof HubError) return err.code;
    throw err;
  }
  return undefined;
}

describe('claims', () => {
  it('grants a free file and denies another agent, naming the holder and intent', () => {
    const { hub } = setup();
    const a = hub.claim(P, A, { files: ['src/auth.ts'], intent: 'Migrate login to OAuth2' });
    expect(a.status).toBe('granted');
    expect(a.claim).toMatchObject({ id: 'C-1', holder: A, mode: 'exclusive', status: 'active', scope: [{ file: 'src/auth.ts' }] });

    const b = hub.claim(P, B, { files: ['src/auth.ts'], intent: 'fix typo' });
    expect(b.status).toBe('denied');
    expect(b.claim).toBeUndefined();
    expect(b.conflicts).toEqual([
      expect.objectContaining({ claim_id: 'C-1', holder: A, intent: 'Migrate login to OAuth2', files: ['src/auth.ts'], mode: 'exclusive' }),
    ]);
    expect(hub.listClaims(P)).toHaveLength(1);
  });

  it("renews instead of conflicting when the holder claims its own file again", () => {
    const { hub, advance } = setup();
    const first = hub.claim(P, A, { files: ['a.ts'] });
    advance(30_000);
    const again = hub.claim(P, A, { files: ['./a.ts'] });
    expect(again.status).toBe('granted');
    expect(again.renewed).toBe(true);
    expect(again.claim!.id).toBe(first.claim!.id);
    expect(again.claim!.expires_at).toBe(first.claim!.expires_at + 30_000);
  });

  it('lets shared holders coexist; exclusive conflicts with shared; auto joins shared holders', () => {
    const { hub } = setup();
    expect(hub.claim(P, A, { files: ['CHANGELOG.md'], mode: 'shared' }).status).toBe('granted');
    expect(hub.claim(P, B, { files: ['CHANGELOG.md'], mode: 'shared' }).status).toBe('granted');
    expect(hub.claim(P, C, { files: ['CHANGELOG.md'], mode: 'exclusive' }).status).toBe('denied');
    const auto = hub.claim(P, C, { files: ['CHANGELOG.md'], mode: 'auto' });
    expect(auto.status).toBe('granted');
    expect(auto.claim!.mode).toBe('shared');
    // auto on a free file is exclusive
    expect(hub.claim(P, C, { files: ['src/x.ts'], mode: 'auto' }).claim!.mode).toBe('exclusive');
    // auto against an exclusive holder is denied
    expect(hub.claim(P, A, { files: ['src/x.ts'], mode: 'auto' }).status).toBe('denied');
  });

  it('is file-level in Phase 1: different symbols in one file still conflict', () => {
    const { hub } = setup();
    hub.claim(P, A, { scope: [{ file: 'src/session.ts', symbol: 'refreshToken' }] });
    const b = hub.claim(P, B, { scope: [{ file: 'src/session.ts', symbol: 'logout' }] });
    expect(b.status).toBe('denied');
  });

  it('rejects paths that are absolute or escape the repository', () => {
    const { hub } = setup();
    expect(errorCode(() => hub.claim(P, A, { files: ['/etc/passwd'] }))).toBe('bad_path');
    expect(errorCode(() => hub.claim(P, A, { files: ['../other/x.ts'] }))).toBe('bad_path');
    expect(errorCode(() => hub.claim(P, A, { files: [] }))).toBe('bad_request');
    expect(errorCode(() => hub.claim(P, 'not-an-agent', { files: ['a.ts'] }))).toBe('bad_agent');
  });

  it('serializes many simultaneous claims on one file: exactly one is granted', async () => {
    const { hub } = setup();
    const agents = Array.from({ length: 25 }, (_, i) => `dev${i}/claude-${i}`);
    const results = await Promise.all(agents.map((agent) => Promise.resolve().then(() => hub.claim(P, agent, { files: ['hot.ts'] }))));
    expect(results.filter((r) => r.status === 'granted')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'denied')).toHaveLength(24);
  });
});

describe('leases', () => {
  it('expire when heartbeats stop, freeing the file for others', () => {
    const { hub, events, advance } = setup({ leaseTtlMs: 60_000 });
    hub.claim(P, A, { files: ['a.ts'], intent: 'refactor' });
    advance(59_000);
    expect(hub.claim(P, B, { files: ['a.ts'] }).status).toBe('denied');
    advance(1_000);
    const b = hub.claim(P, B, { files: ['a.ts'] });
    expect(b.status).toBe('granted');
    expect(hub.getClaim(P, 'C-1')).toMatchObject({ status: 'expired', end_reason: 'lease expired: heartbeats stopped' });
    expect(events.map((e) => e.type)).toContain('claim.expired');
  });

  it('stay alive past the TTL while heartbeats arrive', () => {
    const { hub, advance } = setup({ leaseTtlMs: 60_000 });
    hub.claim(P, A, { files: ['a.ts'] });
    for (let i = 0; i < 10; i++) {
      advance(20_000);
      expect(hub.heartbeat(P, A).renewed).toBe(1);
    }
    expect(hub.getClaim(P, 'C-1').status).toBe('active');
    expect(hub.claim(P, B, { files: ['a.ts'] }).status).toBe('denied');
  });

  it("are renewed by any claim request from the holder, so hook-only agents keep earlier files", () => {
    const { hub, advance } = setup({ leaseTtlMs: 60_000 });
    hub.claim(P, A, { files: ['a.ts'] });
    advance(50_000);
    hub.claim(P, A, { files: ['b.ts'] }); // editing another file renews a.ts too
    advance(50_000);
    expect(hub.getClaim(P, 'C-1').status).toBe('active');
    expect(hub.claim(P, B, { files: ['a.ts'] }).status).toBe('denied'); // B's attempt doesn't renew A
    advance(11_000);
    expect(hub.claim(P, B, { files: ['a.ts'] }).status).toBe('granted');
  });

  it('are expired by the sweeper after missed heartbeats, and a late heartbeat does not revive them', () => {
    const { hub, events, advance } = setup({ leaseTtlMs: 60_000 });
    hub.claim(P, A, { files: ['a.ts'] });
    advance(20_000);
    hub.heartbeat(P, A);
    advance(61_000); // three 20 s heartbeats missed
    expect(hub.sweep()).toEqual([P]);
    const expired = events.filter((e) => e.type === 'claim.expired');
    expect(expired).toHaveLength(1);
    expect(expired[0].data).toMatchObject({ claim_id: 'C-1', holder: A, files: ['a.ts'] });
    expect(hub.heartbeat(P, A).renewed).toBe(0);
    expect(hub.getClaim(P, 'C-1').status).toBe('expired');
  });
});

describe('queueing and release', () => {
  it('queues contended claims FIFO and grants them on release', () => {
    const { hub, events } = setup();
    hub.claim(P, A, { files: ['a.ts'], intent: 'first' });
    const b = hub.claim(P, B, { files: ['a.ts'], intent: 'second', queue: true });
    const c = hub.claim(P, C, { files: ['a.ts'], intent: 'third', queue: true });
    expect(b).toMatchObject({ status: 'queued', position: 1 });
    expect(c).toMatchObject({ status: 'queued', position: 2 });
    expect(b.conflicts[0].holder).toBe(A);

    // Re-asking while queued keeps the place in line.
    expect(hub.claim(P, B, { files: ['a.ts'], queue: true }).claim!.id).toBe(b.claim!.id);

    const r1 = hub.release(P, A, { files: ['a.ts'] });
    expect(r1.released.map((x) => x.id)).toEqual(['C-1']);
    expect(r1.promoted.map((x) => x.id)).toEqual([b.claim!.id]);
    expect(hub.getClaim(P, b.claim!.id).status).toBe('active');
    expect(hub.getClaim(P, c.claim!.id).status).toBe('queued');
    expect(events.find((e) => e.type === 'claim.granted' && e.data.from_queue)?.data).toMatchObject({ holder: B, claim_id: b.claim!.id });

    hub.release(P, B, { claim_id: b.claim!.id });
    expect(hub.getClaim(P, c.claim!.id).status).toBe('active');
  });

  it('hands the file to the queue when the holder’s lease expires', () => {
    const { hub, advance } = setup({ leaseTtlMs: 60_000 });
    hub.claim(P, A, { files: ['a.ts'] });
    const b = hub.claim(P, B, { files: ['a.ts'], queue: true });
    advance(30_000);
    hub.heartbeat(P, B); // B keeps waiting; A has gone silent
    advance(31_000);
    hub.sweep();
    expect(hub.getClaim(P, 'C-1').status).toBe('expired');
    expect(hub.getClaim(P, b.claim!.id).status).toBe('active');
  });

  it('drops a queued claim whose waiter stops heartbeating', () => {
    const { hub, advance } = setup({ leaseTtlMs: 60_000 });
    hub.claim(P, A, { files: ['a.ts'] });
    const b = hub.claim(P, B, { files: ['a.ts'], queue: true });
    advance(61_000);
    hub.heartbeat(P, A); // too late for A as well: both expire
    expect(hub.getClaim(P, b.claim!.id).status).toBe('expired');
    expect(hub.claim(P, C, { files: ['a.ts'] }).status).toBe('granted');
  });

  it('a later request cannot overtake an earlier queued one for the same file', () => {
    const { hub } = setup();
    hub.claim(P, A, { files: ['a.ts', 'b.ts'] });
    hub.claim(P, B, { files: ['a.ts'], queue: true });
    hub.claim(P, C, { files: ['a.ts'], queue: true });
    hub.release(P, A, { files: ['b.ts'] }); // a.ts still held: nobody promoted
    expect(hub.listClaims(P).filter((c) => c.status === 'queued')).toHaveLength(2);
    const r = hub.release(P, A, { all: true });
    expect(r.promoted.map((c) => c.holder)).toEqual([B]);
  });

  it('releasing some files of a multi-file claim keeps the rest', () => {
    const { hub } = setup();
    hub.claim(P, A, { files: ['a.ts', 'b.ts'] });
    const r = hub.release(P, A, { files: ['a.ts'] });
    expect(r.trimmed[0].scope).toEqual([{ file: 'b.ts' }]);
    expect(hub.claim(P, B, { files: ['a.ts'] }).status).toBe('granted');
    expect(hub.claim(P, B, { files: ['b.ts'] }).status).toBe('denied');
  });

  it('only the holder can release a claim', () => {
    const { hub } = setup();
    hub.claim(P, A, { files: ['a.ts'] });
    expect(errorCode(() => hub.release(P, B, { claim_id: 'C-1' }))).toBe('forbidden');
    expect(hub.release(P, B, { files: ['a.ts'] }).released).toHaveLength(0);
  });
});

describe('tasks', () => {
  it('blocked tasks cannot be taken until their dependencies are done', () => {
    const { hub, events } = setup();
    const t1 = hub.createTask(P, A, { title: 'Add OAuth client' });
    const t2 = hub.createTask(P, A, { title: 'Switch login to OAuth', deps: [t1.id] });
    expect(t2.blocked_by).toEqual(['T-1']);
    expect(errorCode(() => hub.takeTask(P, B, t2.id))).toBe('task_blocked');

    hub.takeTask(P, A, t1.id);
    expect(errorCode(() => hub.takeTask(P, B, t1.id))).toBe('task_taken');
    expect(hub.listTasks(P).find((t) => t.id === 'T-2')!.blocked_by).toEqual(['T-1']);

    const landed = hub.land(P, A, { task_id: t1.id });
    expect(landed.task!.status).toBe('done');
    expect(landed.unblocked).toEqual(['T-2']);
    expect(events.some((e) => e.type === 'task.unblocked' && e.data.task_id === 'T-2')).toBe(true);

    expect(hub.takeTask(P, B, t2.id)).toMatchObject({ owner: B, status: 'in_progress', blocked_by: [] });
  });

  it('refuses dependencies that do not exist', () => {
    const { hub } = setup();
    expect(errorCode(() => hub.createTask(P, A, { title: 'x', deps: ['T-99'] }))).toBe('not_found');
  });

  it("attaches claims to the agent's task and releases them when it lands", () => {
    const { hub } = setup();
    hub.createTask(P, A, { title: 'Migrate login to OAuth2' });
    hub.takeTask(P, A, 'T-1');
    const claim = hub.claim(P, A, { files: ['src/auth.ts'] }).claim!;
    expect(claim).toMatchObject({ task_id: 'T-1', intent: 'Migrate login to OAuth2' });
    const r = hub.land(P, A, { task_id: 'T-1', branch: 'agent-a', commit: 'abc123' });
    expect(r.released.map((c) => c.id)).toEqual([claim.id]);
    expect(r.landing).toMatchObject({ id: 'L-1', status: 'recorded', branch: 'agent-a' });
    expect(hub.claim(P, B, { files: ['src/auth.ts'] }).status).toBe('granted');
  });
});

describe('messages and decisions', () => {
  it('delivers direct messages to the recipient only and channel messages to everyone else', () => {
    const { hub, events } = setup();
    hub.post(P, A, { to: B, body: 'hold off on auth.ts please' });
    hub.post(P, C, { to: '#general', body: 'standup in 5' });
    expect(hub.inbox(P, B, { peek: true }).messages.map((m) => m.from)).toEqual([A, C]);
    expect(hub.inbox(P, C).messages).toHaveLength(0);
    expect(hub.inbox(P, A).messages.map((m) => m.body)).toEqual(['standup in 5']);

    const read = hub.inbox(P, B);
    expect(read.messages).toHaveLength(2);
    expect(hub.inbox(P, B).messages).toHaveLength(0);

    const dm = events.find((e) => e.type === 'message.posted' && e.data.to === B)!;
    expect(dm.targets).toEqual([B, A]);
    expect(dm.data).not.toHaveProperty('body');
    expect(hub.events(P, C, 0).some((e) => e.seq === dm.seq)).toBe(false);
  });

  it('keeps decisions append-only', () => {
    const { hub, store } = setup();
    const d = hub.decide(P, A, { summary: 'refreshToken returns {token, expiresAt}', files: ['src/session.ts'], symbols: ['refreshToken'] });
    expect(d.id).toBe('D-1');
    expect(hub.listDecisions(P)[0]).toMatchObject({ summary: d.summary, files: ['src/session.ts'] });
    expect(() => store.db.prepare("UPDATE decisions SET summary = 'x'").run()).toThrow(/append-only/);
    expect(() => store.db.prepare('DELETE FROM decisions').run()).toThrow(/append-only/);
  });

  it('strips control and bidi characters from text other agents will read', () => {
    const { hub } = setup();
    const c = hub.claim(P, A, { files: ['a.ts'], intent: 'fix‮bug\nnow\u0007' }).claim!;
    expect(c.intent).toBe('fixbug now');
  });
});

describe('status and events', () => {
  it('reports presence, claims, tasks and unread counts', () => {
    const { hub, advance } = setup({ leaseTtlMs: 60_000 });
    hub.heartbeat(P, A, { client: 'mcp', branch: 'agent-a' });
    hub.heartbeat(P, B);
    hub.createTask(P, A, { title: 'x' });
    hub.takeTask(P, A, 'T-1');
    hub.claim(P, A, { files: ['a.ts'] });
    hub.post(P, A, { to: B, body: 'hi' });
    advance(61_000);
    hub.heartbeat(P, A);
    const s = hub.status(P, B);
    expect(s.agents.find((a) => a.agent === A)).toMatchObject({ online: true, current_task: 'T-1', branch: 'agent-a' });
    expect(s.agents.find((a) => a.agent === B)!.online).toBe(false);
    expect(s.unread).toBe(1);
    expect(s.claims).toHaveLength(0); // A's claim expired before its heartbeat came back
  });
});
