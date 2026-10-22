import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANDER_LEASE_KEY } from '@agenthub/contract';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Hub, SqliteStore, approverTokenDigest, isLoopbackHost, parseApprovers, startServer, type HubEvent, type RunningServer, type ServerOptions } from '../src/index.js';

// H4 (design §1.7, §1.2 hub-server flags, §6.3.7): the landing, lander and
// approver routes over real HTTP, the lander and approver credentials the
// server checks before it calls the hub, the new hub-server flags, and the
// contract fixtures: every request fixture is accepted, and every response
// has its fixture's keys and types.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'contract');
const bin = path.join(here, '..', 'bin', 'hub-server.js');

const A = 'maya/claude-1';
const B = 'sam/claude-1';
const C = 'lee/codex-1';
const LANDER = 'lander/build1-48213-9f3c';
const STANDBY = 'lander/build2-51007-04ad';
const LANDER_TOKEN = 'lander-token-5f1c0e2a9b7d';
const TOKENS: Record<string, string> = { maya: 'maya-approver-token-1', sam: 'sam-approver-token-2' };
const APPROVERS = { maya: approverTokenDigest(TOKENS.maya), sam: approverTokenDigest(TOKENS.sam) };
const MIN = 60_000;
/** A full lowercase sha made of one repeated hex digit. */
const sha = (c: string) => c.repeat(40);
/** A content digest (sha256 hex) made of one repeated hex digit. */
const dig = (c: string) => c.repeat(64);
const RULE = { paths: ['migrations/**'], approvers: null, distinct: true };
const requirement = (digest: string, paths = ['migrations/0042.sql']) => ({ kind: 'protected', digest, paths, rules: [RULE], candidate: null, candidate_ref: null, trunk_base: null });

const servers: RunningServer[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const c of cleanups.splice(0).reverse()) c();
});

async function start(opts: Partial<Omit<ServerOptions, 'hub'>> = {}): Promise<RunningServer> {
  const hub = new Hub({ store: new SqliteStore(':memory:') });
  const server = await startServer({ hub, port: 0, ...opts });
  servers.push(server);
  return server;
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-h4-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Who sends a request: the headers of an agent, a lander or an approver. */
interface As {
  agent?: string;
  landerToken?: string;
  approver?: string;
  approverToken?: string;
}

async function call(base: string, method: string, route: string, body?: unknown, as: As = {}, project = 'demo'): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/v1/p/${encodeURIComponent(project)}${route}`, {
    method,
    headers: {
      ...(as.agent ? { 'x-hub-agent': as.agent } : {}),
      ...(as.landerToken !== undefined ? { 'x-hub-lander-token': as.landerToken } : {}),
      ...(as.approver !== undefined ? { 'x-hub-approver': as.approver } : {}),
      ...(as.approverToken !== undefined ? { 'x-hub-approver-token': as.approverToken } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

const asLander: As = { agent: LANDER, landerToken: LANDER_TOKEN };

/** Opens the demo feed as `agent` (with a lander token when given): 101 once it opened, else the refusal's status and body. */
function feedAs(base: string, agent: string, landerToken?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/p/demo/feed?agent=${encodeURIComponent(agent)}`, {
      headers: landerToken !== undefined ? { 'x-hub-lander-token': landerToken } : {},
    });
    ws.on('open', () => {
      ws.close();
      resolve({ status: 101, body: '' });
    });
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    ws.on('error', reject);
  });
}
const approver = (name: string): As => ({ approver: name, approverToken: TOKENS[name] });

/** A running hub (lander token and approvers unless `opts` says otherwise) and the calls the tests make. */
async function world(opts: Partial<Omit<ServerOptions, 'hub'>> = { landerToken: LANDER_TOKEN, approvers: APPROVERS }, project = 'demo') {
  const s = await start(opts);
  const send = (method: string, route: string, body?: unknown, as: As = {}) => call(s.url, method, route, body, as, project);
  /** A request that must answer 200; returns its body. */
  const ok = async (method: string, route: string, body?: unknown, as: As = {}) => {
    const r = await send(method, route, body, as);
    expect(r.status, `${method} ${route}: ${JSON.stringify(r.json)}`).toBe(200);
    return r.json;
  };
  /** A request that must fail with this status and code; returns the error body. */
  const refused = async (want: [number, string], method: string, route: string, body?: unknown, as: As = {}) => {
    const r = await send(method, route, body, as);
    expect([r.status, r.json.error?.code], `${method} ${route}: ${JSON.stringify(r.json)}`).toEqual(want);
    return r.json.error as { code: string; message: string; details?: any };
  };
  const takeLease = async (agent = LANDER) => {
    const r = await ok('POST', '/claims', { files: [LANDER_LEASE_KEY], mode: 'exclusive', queue: true, ttl_ms: 10 * MIN, intent: `lander on ${agent.split('/')[1]}` }, { ...asLander, agent });
    return { lease_claim_id: r.claim.id as string, epoch: s.hub.epoch };
  };
  const createTask = async (agent: string, title: string, deps?: string[]) => (await ok('POST', '/tasks', { title, ...(deps ? { deps } : {}) }, { agent })).task.id as string;
  const task = async (agent: string, title: string) => {
    const id = await createTask(agent, title);
    await ok('POST', `/tasks/${id}/take`, {}, { agent });
    return id;
  };
  /** `agent` claims `files` for its task and queues `commit` for the lander. */
  const land = async (agent: string, taskId: string, commit: string, files: string[]) => {
    await ok('POST', '/claims', { files, task_id: taskId }, { agent });
    return ok('POST', '/land', { task_id: taskId, commit, queue: true, files }, { agent });
  };
  type Lease = { lease_claim_id: string; epoch: string };
  const admit = (lease: Lease, id: string, files: string[], extra: Record<string, unknown> = {}) =>
    ok('POST', `/landings/${id}/admit`, { lease, base_sha: sha('0'), files, scope: null, mapper: null, protected: [], required: [], waits_for: null, warnings: [], ...extra }, asLander);
  const next = (lease: Lease) => ok('POST', '/lander/next', { lease }, asLander);
  const advance = (lease: Lease, id: string, body: Record<string, unknown>) => ok('POST', `/landings/${id}/advance`, { lease, attempt: 1, ...body }, asLander);
  const phase = (lease: Lease, id: string, to: string, extra: Record<string, unknown> = {}) => advance(lease, id, { to: 'running', phase: to, deadline_ms: 10 * MIN, ...extra });
  const pushing = (lease: Lease, id: string, extra: Record<string, unknown> = {}) =>
    advance(lease, id, { to: 'running', phase: 'pushing', candidate: sha('c'), candidate_ref: `refs/agenthub/cand/x/${id}/cccccccccccc`, trunk_base: sha('a'), tree: sha('e'), required: [], ...extra });
  const landed = (lease: Lease, id: string, extra: Record<string, unknown> = {}) =>
    advance(lease, id, { to: 'landed', trunk_sha: sha('c'), base_sha: sha('0'), files: [], report: report(`${id} landed.`), also_landed: [], symbol_changes: [], ...extra });
  const events = async (since = 0, as: As = { agent: A }) => (await ok('GET', `/events?since=${since}`, undefined, as)).events as HubEvent[];
  return { s, send, ok, refused, takeLease, createTask, task, land, admit, next, advance, phase, pushing, landed, events };
}

function report(message: string) {
  return { message, resolved_by: 'clean', files_via: [], conflicts: [], check: null, resolver: null, next_steps: [], warnings: [], foreign_commits: [], timings: null };
}

// ------------------------------------------------------------------ shapes

/** Objects whose keys are data (a code or path per key), not field names: only their values' types are compared. */
const MAP_KEYS = new Set(['sendbacks', 'resolved_by', 'explanations']);
/** Keys the protocol declares optional (`ScopeEntry.symbol`): either side may leave them out. */
const OPTIONAL_KEYS = new Set(['symbol']);

function kindOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

/**
 * Where `actual` differs from the fixture `expected` in keys or types. A null
 * on either side matches anything (the field is nullable and the fixture or
 * this run shows the other case). Each element of an array must match some
 * element of the fixture's array (entries such as {file} and {file, symbol}).
 */
function shapeProblems(actual: unknown, expected: unknown, at = '$'): string[] {
  if (actual === null || expected === null) return [];
  const ka = kindOf(actual);
  const ke = kindOf(expected);
  if (ka !== ke) return [`${at}: ${ka}, the fixture has ${ke}`];
  if (ka === 'array') {
    const a = actual as unknown[];
    const e = expected as unknown[];
    if (a.length === 0 || e.length === 0) return [];
    return a.flatMap((item, i) => {
      const tries = e.map((x) => shapeProblems(item, x, `${at}[${i}]`));
      return tries.some((t) => t.length === 0) ? [] : tries[0];
    });
  }
  if (ka !== 'object') return [];
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  const key = at.split('.').at(-1)!;
  if (MAP_KEYS.has(key)) {
    const sample = Object.values(e)[0];
    return sample === undefined ? [] : Object.entries(a).flatMap(([k, v]) => shapeProblems(v, sample, `${at}.${k}`));
  }
  const problems: string[] = [];
  for (const k of Object.keys(e)) if (!(k in a) && !OPTIONAL_KEYS.has(k)) problems.push(`${at}.${k}: missing`);
  for (const k of Object.keys(a)) if (!(k in e) && !OPTIONAL_KEYS.has(k)) problems.push(`${at}.${k}: not in the fixture`);
  for (const k of Object.keys(e)) if (k in a) problems.push(...shapeProblems(a[k], e[k], `${at}.${k}`));
  return problems;
}

/** Fixtures read so far: the conformance test checks it used every one. */
const used = new Set<string>();
function fixture(name: string): any {
  used.add(name);
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function expectShape(actual: unknown, fixtureName: string, pick: (f: any) => unknown = (f) => f): void {
  expect(shapeProblems(actual, pick(fixture(fixtureName))), fixtureName).toEqual([]);
}

/**
 * Each event whose type the fixture shows matches one of the fixture's events
 * of that type: the same keys and types, in data too. Claim events may carry
 * more data keys than the fixture shows (partial, from_queue, moved_from, ...),
 * and a partial release has no `was` or `reason`, as in Phase 1.
 */
function eventProblems(events: HubEvent[], fixtureEvents: HubEvent[]): string[] {
  return events.flatMap((e) => {
    const same = fixtureEvents.filter((f) => f.type === e.type);
    if (same.length === 0) return [];
    const tries = same.map((f) => {
      if (!e.type.startsWith('claim.')) return shapeProblems(e, f, `#${e.seq} ${e.type}`);
      const want = e.data.partial === true ? Object.fromEntries(Object.entries(f.data).filter(([k]) => k !== 'was' && k !== 'reason')) : f.data;
      const data = Object.fromEntries(Object.entries(e.data).filter(([k]) => k in want));
      return shapeProblems({ ...e, data }, { ...f, data: want }, `#${e.seq} ${e.type}`);
    });
    return tries.some((t) => t.length === 0) ? [] : tries[0];
  });
}

// ---------------------------------------------------------- the contract

describe('landing routes over HTTP: the contract fixtures (design §6.3.7)', () => {
  /** H6 adds POST/GET /symbol-changes; those two fixtures are checked there. */
  const LATER = ['symbol-changes.request.json', 'symbol-changes.response.json'];

  it('accepts every request fixture and answers every route in its response fixture’s shape', async () => {
    const w = await world();
    const { ok } = w;
    const lease = await w.takeLease();
    const t1 = await w.task(A, 'Let login take an options object');
    const t2 = await w.createTask(A, 'Use the login options in the mobile client', [t1]);
    await ok('POST', '/decisions', { summary: 'Lock an account for 15 minutes after 5 failed logins', task_id: t1, symbols: ['login'] }, { agent: B });

    // claims.symbol.request.json and claims.check.scope.request.json are accepted.
    const claimed = await ok('POST', '/claims', { ...fixture('claims.symbol.request.json'), task_id: t1 }, { agent: A });
    expect(claimed.status).toBe('granted');
    const checked = await ok('POST', '/claims/check', fixture('claims.check.scope.request.json'), { agent: B });
    expect(checked.conflicts.map((c: any) => c.holder)).toEqual([A]);

    // land (queue mode) → LandResult.
    const queued = await ok('POST', '/land', { ...fixture('land.queue.request.json'), task_id: t1 }, { agent: A });
    expectShape(queued, 'land.queue.response.json');
    const X = queued.landing.id;
    expect(queued.landing).toMatchObject({ status: 'submitted', task_id: t1, position: 1 });

    // Another agent's change that touches the held code: 409 claim_conflict with details.conflicts.
    const ts = await w.task(B, 'Rate-limit login attempts per user');
    const conflict = await w.send('POST', '/land', { task_id: ts, commit: sha('5'), queue: true, files: ['src/auth.ts'] }, { agent: B });
    expect(conflict.status).toBe(409);
    expectShape(conflict.json, 'claim.conflict.error.json');
    expect(conflict.json.error.details.conflicts[0]).toMatchObject({ holder: A, landing_id: X });

    // admit → approve → next → merging → checking → pushing → landed.
    const admitted = await ok('POST', `/landings/${X}/admit`, { ...fixture('landing.admit.request.json'), lease }, asLander);
    expectShape(admitted, 'landing.admit.response.json');
    expect(admitted.landing).toMatchObject({ status: 'queued', approval: [expect.objectContaining({ kind: 'protected' })] });
    const approved = await ok('POST', `/landings/${X}/approve`, fixture('landing.approve.request.json'), approver('sam'));
    expectShape(approved, 'landing.get.response.json');
    expect(approved.landing).toMatchObject({ approval: [], approvals: [expect.objectContaining({ by: 'sam', kind: 'protected' })] });
    const picked = await ok('POST', '/lander/next', { ...fixture('lander.next.request.json'), lease }, asLander);
    expectShape(picked, 'lander.next.response.json');
    expect(picked).toMatchObject({ resolve: false, landing: { id: X, status: 'running', phase: 'merging', attempt: 1 } });
    expectShape(await ok('POST', `/landings/${X}/advance`, { ...fixture('landing.advance.merging.request.json'), lease }, asLander), 'landing.advance.response.json');
    await w.phase(lease, X, 'checking');
    const pushingX = await ok('POST', `/landings/${X}/advance`, { ...fixture('landing.advance.pushing.request.json'), lease }, asLander);
    expectShape(pushingX, 'landing.advance.response.json');
    expect(pushingX.landing).toMatchObject({ phase: 'pushing', deadline_at: null });
    const landedX = await ok('POST', `/landings/${X}/advance`, { ...fixture('landing.advance.landed.request.json'), lease }, asLander);
    expectShape(landedX, 'landing.advance.response.json');
    expect(landedX).toMatchObject({ replayed: false, unblocked: [t2], landing: { status: 'landed', trunk_sha: '5d4c3b2a1908f7e6d5c4b3a2918f7e6d5c4b3a29' } });
    expect(landedX.released.map((c: any) => c.landing_id)).toEqual([X]);

    // A send-back: advance failed.
    await ok('POST', '/claims', { files: ['src/session.ts'], task_id: ts }, { agent: B });
    const U = (await ok('POST', '/land', { task_id: ts, commit: sha('6'), queue: true, files: ['src/session.ts'] }, { agent: B })).landing.id;
    await w.admit(lease, U, ['src/session.ts']);
    expect((await w.next(lease)).landing.id).toBe(U);
    const failed = await ok('POST', `/landings/${U}/advance`, { ...fixture('landing.advance.failed.request.json'), lease }, asLander);
    expectShape(failed, 'landing.advance.response.json');
    expect(failed.landing).toMatchObject({ status: 'failed', failure: { code: 'resolver_failed' } });

    // Parked for approval after the checks, approved by two humans, then cancelled by its author.
    const tl = await w.task(C, 'Keep sessions in their own table');
    const Y = (await w.land(C, tl, sha('7'), ['migrations/0043_sessions.sql'])).landing.id;
    await w.admit(lease, Y, ['migrations/0043_sessions.sql']);
    expect((await w.next(lease)).landing.id).toBe(Y);
    await w.phase(lease, Y, 'checking');
    const parked = await ok('POST', `/landings/${Y}/advance`, { ...fixture('landing.advance.needs_approval.request.json'), lease }, asLander);
    expectShape(parked, 'landing.advance.response.json');
    expect(parked.landing).toMatchObject({ status: 'needs_approval', candidate: '5d4c3b2a1908f7e6d5c4b3a2918f7e6d5c4b3a29', candidate_checked: true });
    expect(parked.landing.approval.map((r: any) => r.kind)).toEqual(['protected', 'merged']);
    await ok('POST', `/landings/${Y}/approve`, fixture('landing.approve.request.json'), approver('maya'));
    const merged = parked.landing.approval[1];
    const requeued = await ok('POST', `/landings/${Y}/approve`, { kind: 'merged', digest: merged.digest }, approver('sam'));
    expect(requeued.landing).toMatchObject({ status: 'queued', approval: [], queue_seq: parked.landing.queue_seq });
    const cancelled = await ok('POST', `/landings/${Y}/cancel`, fixture('landing.cancel.request.json'), { agent: C });
    expectShape(cancelled, 'landing.get.response.json');
    expect(cancelled.landing.status).toBe('cancelled');

    // In doubt: the lease ends in pushing; the next lease holder resolves it.
    const t3 = await w.task(A, 'Drop expired sessions');
    const Z = (await w.land(A, t3, sha('8'), ['src/z.ts'])).landing.id;
    await w.admit(lease, Z, ['src/z.ts']);
    expect((await w.next(lease)).landing.id).toBe(Z);
    await w.pushing(lease, Z, { trunk_base: '5d4c3b2a1908f7e6d5c4b3a2918f7e6d5c4b3a29' });
    await ok('POST', '/claims/release', { claim_id: lease.lease_claim_id }, asLander);
    const lease2 = await w.takeLease();
    const inDoubt = await ok('POST', '/lander/next', { ...fixture('lander.next.request.json'), lease: lease2 }, asLander);
    expectShape(inDoubt, 'lander.next.resolve.response.json');
    expect(inDoubt).toMatchObject({ resolve: true, landing: { id: Z, in_doubt: true, phase: 'pushing' } });
    const back = await ok('POST', `/landings/${Z}/resolve`, { ...fixture('landing.resolve.requeue.request.json'), lease: lease2 }, asLander);
    expectShape(back, 'landing.advance.response.json');
    expect(back.landing).toMatchObject({ status: 'queued', in_doubt: false });
    expect((await w.next(lease2)).landing).toMatchObject({ id: Z, attempt: 2 });
    await w.pushing(lease2, Z, { attempt: 2 });
    const resolved = await ok('POST', `/landings/${Z}/resolve`, { ...fixture('landing.resolve.landed.request.json'), lease: lease2 }, asLander);
    expectShape(resolved, 'landing.advance.response.json');
    expect(resolved.landing).toMatchObject({ status: 'landed', trunk_sha: '5d4c3b2a1908f7e6d5c4b3a2918f7e6d5c4b3a29' });

    // Something left in the queue for status: a queued landing and a submitted retry.
    const tq = await w.task(C, 'Show the session list');
    const Q = (await w.land(C, tq, sha('9'), ['src/q.ts'])).landing.id;
    await w.admit(lease2, Q, ['src/q.ts']);
    const retry = await ok('POST', '/land', { task_id: ts, commit: sha('a'), queue: true, files: ['src/session.ts'] }, { agent: B });
    expect(retry.landing).toMatchObject({ status: 'submitted', retry_of: U });

    // Trunk report, pause, resume and the lander's status.
    const trunk = await ok('POST', '/lander/trunk', { ...fixture('lander.trunk.request.json'), lease: lease2 }, asLander);
    expectShape(trunk, 'lander.control.response.json');
    const paused = await ok('POST', '/lander/pause', { lease: lease2, reason: 'external_push', detail: '8c7b6a594837 reached main outside the landing queue (externalPushes: pause).' }, asLander);
    expectShape(paused, 'lander.control.response.json');
    expect(paused.control.paused).toMatchObject({ reason: 'external_push', by: LANDER });
    const resumed = await ok('POST', '/lander/resume', {}, approver('maya'));
    expectShape(resumed, 'lander.control.response.json');
    expect(resumed.control.paused).toBeNull();
    const lander = await ok('GET', '/lander');
    expect(Object.keys(lander).sort()).toEqual(['control', 'lease']);
    expectShape(lander.lease, 'status.response.json', (f) => f.lander);
    expectShape(lander, 'lander.control.response.json', (f) => ({ lease: lander.lease, control: f.control }));

    // Reads.
    expectShape(await ok('GET', '/landings'), 'landings.list.response.json');
    expectShape(await ok('GET', `/landings/${X}`), 'landing.get.response.json');
    expectShape(await ok('GET', '/landings/stats?days=7'), 'landing.stats.response.json');
    const status = await ok('GET', '/status', undefined, { agent: A });
    // status().landings lists rows as Phase 1 did, with their undeclared `seq`
    // (test/phase1-landings.test.ts): the one key the fixture doesn't show.
    expect(status.landings.every((l: any) => typeof l.seq === 'number')).toBe(true);
    expectShape({ ...status, landings: status.landings.map(({ seq: _seq, ...l }: any) => l) }, 'status.response.json');
    // The retry keeps U's place in the queue, ahead of Q.
    expect(status.queue.map((l: any) => l.id)).toEqual([retry.landing.id, Q]);

    // The event log: GET /events, and every landing event type in the fixture's shape.
    const log = await ok('GET', '/events?since=0', undefined, { agent: A });
    const fixtureEvents = fixture('events.landing.json');
    expectShape({ ...log, events: [] }, 'events.landing.json', (f) => ({ ...f, events: [] }));
    expect(eventProblems(log.events, fixtureEvents.events)).toEqual([]);
    const types = new Set(log.events.map((e: HubEvent) => e.type));
    const missing = [...new Set<string>(fixtureEvents.events.map((e: HubEvent) => e.type))].filter((t) => !types.has(t as HubEvent['type']));
    expect(missing).toEqual([]);
    // The landed fixtures' symbol_changes were recorded: landed rows of the landing's task, announced without signature text.
    const landedChanges = log.events.filter((e: HubEvent) => e.type === 'symbol.changed' && e.data.status === 'landed');
    expect(landedChanges.map((e: HubEvent) => [e.data.landing_id, e.data.task_id, e.data.symbol])).toEqual([
      [X, t1, 'login'],
      [Z, t3, 'login'],
    ]);

    // Record mode, on a project that never had a lander.
    const rec = (method: string, route: string, body?: unknown, as: As = {}) => call(w.s.url, method, route, body, as, 'acme/web');
    const tr = (await rec('POST', '/tasks', { title: 'Fix the typo in the login error message' }, { agent: A })).json.task.id;
    await rec('POST', `/tasks/${tr}/take`, {}, { agent: A });
    await rec('POST', '/claims', { files: ['src/auth.ts'], task_id: tr }, { agent: A });
    const recorded = await rec('POST', '/land', { task_id: tr, branch: 'maya/typo', commit: '3f2a9c1e5b7d', summary: 'Fix the typo in the login error message.' }, { agent: A });
    expect(recorded.status).toBe(200);
    expectShape(recorded.json, 'land.record.response.json');

    // Every fixture was used, but H6's.
    const all = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
    expect([...used].sort()).toEqual(all.filter((f) => !LATER.includes(f)).sort());
  });

  it('accepts symbol-changes.request.json and answers POST and GET /symbol-changes in symbol-changes.response.json’s shape', async () => {
    const w = await world();
    const t = await w.task(A, 'Let login take an options object');
    const decision = (await w.ok('POST', '/decisions', { summary: 'login() takes an options object instead of positional flags', task_id: t, symbols: ['login'] }, { agent: A })).decision;
    // Only task_id is replaced by the live value.
    const req = fixture('symbol-changes.request.json');
    const posted = await w.ok('POST', '/symbol-changes', { changes: req.changes.map((c: any) => ({ ...c, task_id: t })) }, { agent: A });
    expectShape(posted, 'symbol-changes.response.json');
    expect(posted.changes.map((c: any) => [c.id, c.symbol, c.name, c.kind, c.status, c.task_id, c.renamed_to])).toEqual([
      ['S-1', 'login', 'login', 'signature', 'in_progress', t, null],
      ['S-2', 'rememberDays', 'rememberDays', 'renamed', 'in_progress', t, 'sessionDays'],
    ]);
    expect(posted.changes[0].decisions).toEqual([{ id: decision.id, agent: A, summary: decision.summary }]);
    const read = await w.ok('GET', '/symbol-changes?status=in_progress,landed', undefined, {});
    expectShape(read, 'symbol-changes.response.json');
    expect(read.changes.map((c: any) => c.id)).toEqual(['S-2', 'S-1']);
    // symbol.changed in the event fixture's shape.
    const changed = (await w.events(0, { agent: B })).filter((e) => e.type === 'symbol.changed');
    expect(changed.map((e) => e.data.change_id)).toEqual(['S-1', 'S-2']);
    expect(eventProblems(changed, fixture('events.landing.json').events)).toEqual([]);
    for (const f of LATER) expect(used.has(f), f).toBe(true);
  });
});

// ---------------------------------------------------------- a full cycle

describe('a full landing cycle over HTTP', () => {
  it('land, admit, next, merging, checking, pushing, landed: the events come in order and the holds are released', async () => {
    const w = await world();
    const lease = await w.takeLease();
    const t1 = await w.task(A, 'Let login take an options object');
    const t2 = await w.createTask(A, 'Use the login options in the mobile client', [t1]);
    await w.ok('POST', '/claims', { files: ['src/auth.ts', 'src/routes.ts'], task_id: t1 }, { agent: A });
    const since = (await w.ok('GET', '/status', undefined, { agent: A })).seq;

    const r = await w.ok('POST', '/land', { task_id: t1, commit: sha('1'), queue: true, files: ['src/auth.ts', 'src/routes.ts'] }, { agent: A });
    expect(r.held).toHaveLength(1);
    const hold = r.held[0];
    expect(hold).toMatchObject({ holder: A, landing_id: 'L-1', status: 'active' });
    // B waits for a file the landing holds.
    const waiter = await w.ok('POST', '/claims', { files: ['src/routes.ts'], queue: true }, { agent: B });
    expect(waiter.status).toBe('queued');

    expect((await w.admit(lease, 'L-1', ['src/auth.ts', 'src/routes.ts'])).landing.status).toBe('queued');
    expect((await w.next(lease)).landing).toMatchObject({ id: 'L-1', status: 'running', phase: 'merging', attempt: 1 });
    expect((await w.phase(lease, 'L-1', 'merging', { trunk_base: sha('a') })).landing.phase).toBe('merging');
    expect((await w.phase(lease, 'L-1', 'checking')).landing.phase).toBe('checking');
    expect((await w.pushing(lease, 'L-1')).landing.phase).toBe('pushing');
    const done = await w.landed(lease, 'L-1', { files: ['src/auth.ts', 'src/routes.ts'] });
    expect(done).toMatchObject({ replayed: false, unblocked: [t2], landing: { status: 'landed', trunk_sha: sha('c'), hold_ids: [hold.id] } });
    expect(done.released).toEqual([expect.objectContaining({ id: hold.id, status: 'released', end_reason: 'landed L-1' })]);
    // A repeat of the landed report is a replay.
    expect((await w.landed(lease, 'L-1', { files: ['src/auth.ts', 'src/routes.ts'] })).replayed).toBe(true);

    const log = (await w.events(since)).map((e) => {
      if (e.type === 'landing.updated') return `${e.type}:${e.data.reason}`;
      if (e.type.startsWith('claim.')) return `${e.type}:${e.data.holder}`;
      return e.type;
    });
    expect(log).toEqual([
      // land
      `claim.released:${A}`,
      `claim.granted:${A}`,
      'task.updated',
      'landing.created',
      // B's first request
      'agent.online',
      `claim.queued:${B}`,
      // admit, next, (merging again: nothing), checking, pushing
      'landing.updated:admitted',
      'landing.updated:picked',
      'landing.updated:phase',
      'landing.updated:phase',
      // landed
      `claim.released:${A}`,
      `claim.granted:${B}`,
      'task.updated',
      'task.unblocked',
      'landing.landed',
      'trunk.moved',
    ]);
    const all = await w.events(since);
    expect(all.find((e) => e.type === 'landing.landed')!.data).toMatchObject({ landing_id: 'L-1', trunk_sha: sha('c'), reconciled: false });
    expect(all.find((e) => e.type === 'trunk.moved')!.data).toMatchObject({ to: sha('c'), landing_id: 'L-1', foreign: false });

    // The hold is gone: nothing live belongs to the landing, and B holds the file it waited for.
    expect((await w.ok('GET', `/claims/${hold.id}`)).claim).toMatchObject({ status: 'released', end_reason: 'landed L-1' });
    const live = (await w.ok('GET', '/claims')).claims;
    expect(live.filter((c: any) => c.landing_id !== null)).toEqual([]);
    expect(live.find((c: any) => c.id === waiter.claim.id)).toMatchObject({ status: 'active', holder: B });
    expect((await w.ok('GET', '/tasks')).tasks.find((t: any) => t.id === t1).status).toBe('done');
    const status = await w.ok('GET', '/status', undefined, { agent: A });
    expect(status).toMatchObject({ queue: [], control: { trunk: { sha: sha('c'), landing_id: 'L-1' } } });
  });
});

// ------------------------------------------------- routes and their errors

describe('landing routes: happy paths and the errors design §1.7 lists', () => {
  it('POST /land: bad_commit, task_closed, task_blocked, task_landing, too_late, claim_conflict (details.conflicts), landing_queue_active', async () => {
    const w = await world();
    const lease = await w.takeLease();
    const t1 = await w.task(A, 'one');
    await w.refused([400, 'bad_commit'], 'POST', '/land', { task_id: t1, commit: 'abc', queue: true }, { agent: A });
    await w.refused([400, 'bad_commit'], 'POST', '/land', { task_id: t1, commit: sha('A'), queue: true }, { agent: A });
    // task_blocked: a dependency isn't done.
    const tb = await w.createTask(A, 'blocked', [t1]);
    await w.refused([409, 'task_blocked'], 'POST', '/land', { task_id: tb, commit: sha('1'), queue: true }, { agent: A });
    // task_closed: a done or cancelled task.
    const tc = await w.task(A, 'closed');
    await w.ok('POST', `/tasks/${tc}/update`, { status: 'cancelled' }, { agent: A });
    await w.refused([409, 'task_closed'], 'POST', '/land', { task_id: tc, commit: sha('1'), queue: true }, { agent: A });
    // task_landing: another agent's land on a task a live landing carries.
    const first = await w.land(A, t1, sha('1'), ['a.ts']);
    expect(first.landing.status).toBe('submitted');
    await w.refused([409, 'task_landing'], 'POST', '/land', { task_id: t1, commit: sha('2'), queue: true }, { agent: B });
    // claim_conflict: B's change touches what A's landing holds.
    const tb2 = await w.task(B, 'touch a');
    const conflict = await w.refused([409, 'claim_conflict'], 'POST', '/land', { task_id: tb2, commit: sha('3'), queue: true, files: ['a.ts'] }, { agent: B });
    expect(conflict.details.conflicts).toEqual([expect.objectContaining({ holder: A, landing_id: 'L-1', files: ['a.ts'], scope: [{ file: 'a.ts' }] })]);
    // invalid_symbol: a scope symbol that is no declaration key, or one without its mapper.
    await w.refused([400, 'invalid_symbol'], 'POST', '/land', { task_id: tb2, commit: sha('3'), queue: true, scope: [{ file: 'b.ts', symbol: 'not a key' }], mapper: 'm1' }, { agent: B });
    await w.refused([400, 'invalid_symbol'], 'POST', '/land', { task_id: tb2, commit: sha('3'), queue: true, scope: [{ file: 'b.ts', symbol: 'login' }] }, { agent: B });
    // too_late: superseding a landing that is being pushed.
    await w.admit(lease, 'L-1', ['a.ts']);
    await w.next(lease);
    await w.pushing(lease, 'L-1');
    await w.refused([409, 'too_late'], 'POST', '/land', { task_id: t1, commit: sha('4'), queue: true, files: ['a.ts'] }, { agent: A });
    // The same commit again is a replay.
    expect((await w.ok('POST', '/land', { task_id: t1, commit: sha('1'), queue: true }, { agent: A })).replayed).toBe(true);
    // Record mode on a project that has a lander: landing_queue_active.
    const tr = await w.task(C, 'record');
    await w.refused([409, 'landing_queue_active'], 'POST', '/land', { task_id: tr, commit: '3f2a9c1e5b7d' }, { agent: C });
  });

  it('GET /landings with filters, /landings/stats, /landings/:id (404 for an unknown id) and GET /lander', async () => {
    const w = await world();
    expect(await w.ok('GET', '/lander')).toMatchObject({ lease: null, control: { paused: null, trunk: null } });
    const lease = await w.takeLease();
    await w.takeLease(STANDBY);
    expect((await w.ok('GET', '/lander')).lease).toMatchObject({ holder: LANDER, claim_id: lease.lease_claim_id, standby: [STANDBY] });
    const ta = await w.task(A, 'a');
    const tb = await w.task(B, 'b');
    await w.land(A, ta, sha('1'), ['a.ts']);
    await w.land(B, tb, sha('2'), ['b.ts']);
    await w.admit(lease, 'L-2', ['b.ts']);
    await w.ok('POST', '/landings/L-1/cancel', {}, { agent: A });
    const ids = async (q: string) => (await w.ok('GET', `/landings${q}`)).landings.map((l: any) => l.id);
    // Live landings first, in queue order, then the most recent.
    expect(await ids('')).toEqual(['L-2', 'L-1']);
    expect(await ids('?status=queued,submitted')).toEqual(['L-2']);
    expect(await ids('?status=cancelled')).toEqual(['L-1']);
    expect(await ids(`?agent=${encodeURIComponent(A)}`)).toEqual(['L-1']);
    expect(await ids(`?task=${tb}`)).toEqual(['L-2']);
    expect(await ids('?limit=1')).toEqual(['L-2']);
    await w.refused([400, 'bad_request'], 'GET', '/landings?status=nope');
    await w.refused([400, 'bad_request'], 'GET', '/landings?limit=many');
    expect((await w.ok('GET', '/landings/L-2')).landing).toMatchObject({ id: 'L-2', status: 'queued', position: 1 });
    expect((await w.ok('GET', '/landings/L-2')).landing).not.toHaveProperty('seq');
    await w.refused([404, 'not_found'], 'GET', '/landings/L-9');
    // /landings/stats is its own route, not the landing "stats".
    expect(await w.ok('GET', '/landings/stats')).toMatchObject({ days: 7, landed: 0 });
    expect(await w.ok('GET', '/landings/stats?days=30')).toMatchObject({ days: 30 });
    await w.refused([400, 'bad_request'], 'GET', '/landings/stats?days=week');
  });

  it('cancel: by its author or an approver; 403 for anyone else, too_late in pushing, landing_closed once terminal', async () => {
    const w = await world();
    const lease = await w.takeLease();
    const ta = await w.task(A, 'a');
    const r = await w.land(A, ta, sha('1'), ['a.ts']);
    await w.refused([403, 'forbidden'], 'POST', '/landings/L-1/cancel', {}, { agent: B });
    await w.refused([400, 'bad_agent'], 'POST', '/landings/L-1/cancel', {});
    const cancelled = await w.ok('POST', '/landings/L-1/cancel', { reason: 'Taking a different approach.' }, { agent: A });
    expect(cancelled.landing).toMatchObject({ id: 'L-1', status: 'cancelled' });
    // The hold went back to A as a lease.
    expect((await w.ok('GET', `/claims/${r.held[0].id}`)).claim).toMatchObject({ status: 'active', landing_id: null, holder: A });
    await w.refused([409, 'landing_closed'], 'POST', '/landings/L-1/cancel', {}, { agent: A });
    // An approver cancels someone else's landing.
    const tb = await w.task(B, 'b');
    await w.land(B, tb, sha('2'), ['b.ts']);
    expect((await w.ok('POST', '/landings/L-2/cancel', {}, approver('maya'))).landing.status).toBe('cancelled');
    // Nobody stops a landing in pushing.
    const tc = await w.task(C, 'c');
    await w.land(C, tc, sha('3'), ['c.ts']);
    await w.admit(lease, 'L-3', ['c.ts']);
    await w.next(lease);
    await w.pushing(lease, 'L-3');
    await w.refused([409, 'too_late'], 'POST', '/landings/L-3/cancel', {}, { agent: C });
    await w.refused([409, 'too_late'], 'POST', '/landings/L-3/cancel', {}, approver('sam'));
    await w.refused([404, 'not_found'], 'POST', '/landings/L-9/cancel', {}, { agent: C });
  });

  it('approve and reject: not_approver (a rule’s approvers, distinct), approval_stale, landing_closed; a rejection sends the landing back', async () => {
    const w = await world();
    const lease = await w.takeLease();
    const ta = await w.task(A, 'a');
    await w.land(A, ta, sha('1'), ['migrations/0042.sql']);
    const named = { ...requirement(dig('2')), rules: [{ paths: ['migrations/**'], approvers: ['sam'], distinct: true }] };
    await w.admit(lease, 'L-1', ['migrations/0042.sql'], { protected: ['migrations/0042.sql'], required: [requirement(dig('1')), named] });
    // maya is the author's human (distinct); maya isn't among the second rule's approvers.
    const distinct = await w.refused([403, 'not_approver'], 'POST', '/landings/L-1/approve', { kind: 'protected', digest: dig('1') }, approver('maya'));
    expect(distinct.message).toContain('maya');
    await w.refused([403, 'not_approver'], 'POST', '/landings/L-1/approve', { kind: 'protected', digest: dig('2') }, approver('maya'));
    await w.refused([409, 'approval_stale'], 'POST', '/landings/L-1/approve', { kind: 'protected', digest: dig('9') }, approver('sam'));
    await w.refused([409, 'approval_stale'], 'POST', '/landings/L-1/approve', { kind: 'merged', digest: dig('1') }, approver('sam'));
    await w.refused([400, 'bad_request'], 'POST', '/landings/L-1/approve', { kind: 'protected', digest: 'not hex' }, approver('sam'));
    const one = await w.ok('POST', '/landings/L-1/approve', { kind: 'protected', digest: dig('1'), note: 'fine' }, approver('sam'));
    expect(one.landing.approval.map((r: any) => r.digest)).toEqual([dig('2')]);
    expect(one.landing.approvals).toEqual([expect.objectContaining({ by: 'sam', digest: dig('1'), note: 'fine', carried_from: null })]);
    // A rejection by an allowed approver fails the landing (approval_rejected).
    await w.refused([400, 'bad_request'], 'POST', '/landings/L-1/reject', { reason: '' }, approver('sam'));
    await w.refused([403, 'not_approver'], 'POST', '/landings/L-1/reject', { reason: 'no' }, approver('maya'));
    const rejected = await w.ok('POST', '/landings/L-1/reject', { reason: 'Split the migration in two.' }, approver('sam'));
    expect(rejected.landing).toMatchObject({ status: 'failed', failure: { code: 'approval_rejected' } });
    expect(rejected.landing.failure.summary).toContain('Split the migration in two.');
    await w.refused([409, 'landing_closed'], 'POST', '/landings/L-1/approve', { kind: 'protected', digest: dig('2') }, approver('sam'));
    await w.refused([409, 'landing_closed'], 'POST', '/landings/L-1/reject', { reason: 'no' }, approver('sam'));
    await w.refused([404, 'not_found'], 'POST', '/landings/L-9/approve', { kind: 'protected', digest: dig('2') }, approver('sam'));
  });

  it('lander routes: not_lander for a released lease or another epoch; admit landing_closed; advance landing_stale, approval_missing (details.missing), bad_request; resolve landing_stale', async () => {
    const w = await world();
    const lease = await w.takeLease();
    const ta = await w.task(A, 'a');
    await w.land(A, ta, sha('1'), ['migrations/0042.sql']);
    const tb = await w.task(B, 'b');
    await w.land(B, tb, sha('2'), ['b.ts']);
    // Another database's epoch, or a lease id that isn't the active lease.
    const notLander = await w.refused([409, 'not_lander'], 'POST', '/lander/next', { lease: { ...lease, epoch: '1b4e28ba-2fa1-11d2-883f-0016d3cca427' } }, asLander);
    expect(notLander.message).toContain(LANDER);
    await w.refused([409, 'not_lander'], 'POST', '/lander/next', { lease: { ...lease, lease_claim_id: 'C-99' } }, asLander);
    await w.refused([400, 'bad_request'], 'POST', '/lander/next', {}, asLander);
    await w.refused([409, 'not_lander'], 'POST', '/landings/L-1/admit', { lease: { ...lease, lease_claim_id: 'C-99' }, base_sha: sha('0'), files: ['a.ts'] }, asLander);
    // Admit, run, and the guards of advance.
    await w.admit(lease, 'L-1', ['migrations/0042.sql'], { protected: ['migrations/0042.sql'], required: [requirement(dig('1'))] });
    expect((await w.next(lease)).landing.id).toBe('L-1');
    await w.refused([409, 'landing_stale'], 'POST', '/landings/L-1/advance', { lease, attempt: 2, to: 'running', phase: 'checking', deadline_ms: MIN }, asLander);
    await w.refused([409, 'landing_stale'], 'POST', '/landings/L-2/advance', { lease, attempt: 1, to: 'running', phase: 'checking', deadline_ms: MIN }, asLander);
    await w.refused([400, 'bad_request'], 'POST', '/landings/L-1/advance', { lease, attempt: 1, to: 'flying' }, asLander);
    await w.refused([400, 'bad_request'], 'POST', '/landings/L-1/advance', { lease, attempt: 1, to: 'queued', reason: 'lander_lost' }, asLander);
    const missing = await w.refused([409, 'approval_missing'], 'POST', '/landings/L-1/advance', {
      lease,
      attempt: 1,
      to: 'running',
      phase: 'pushing',
      candidate: sha('c'),
      candidate_ref: 'refs/agenthub/cand/x/L-1/cccccccccccc',
      trunk_base: sha('a'),
      tree: sha('e'),
      required: [requirement(dig('1'))],
    }, asLander);
    expect(missing.details.missing).toEqual([expect.objectContaining({ kind: 'protected', digest: dig('1') })]);
    // resolve is for a landing in pushing only.
    await w.refused([409, 'landing_stale'], 'POST', '/landings/L-1/resolve', { lease, outcome: 'requeue', trunk_sha: sha('b') }, asLander);
    // The lease ends: every lander write is refused.
    await w.ok('POST', '/claims/release', { claim_id: lease.lease_claim_id }, asLander);
    await w.refused([409, 'not_lander'], 'POST', '/landings/L-1/advance', { lease, attempt: 1, to: 'running', phase: 'checking', deadline_ms: MIN }, asLander);
    await w.refused([409, 'not_lander'], 'POST', '/landings/L-1/resolve', { lease, outcome: 'requeue', trunk_sha: sha('b') }, asLander);
    // A new lease: the landing came back (lander_lost), and admitting a closed landing is refused.
    const lease2 = await w.takeLease();
    expect((await w.ok('GET', '/landings/L-1')).landing).toMatchObject({ status: 'queued', retries: { lander_lost: 1 } });
    await w.ok('POST', '/landings/L-2/cancel', {}, { agent: B });
    await w.refused([409, 'landing_closed'], 'POST', '/landings/L-2/admit', { lease: lease2, base_sha: sha('0'), files: ['b.ts'] }, asLander);
  });

  it('trunk, pause and resume answer the control; not_lander and not_approver; resume after a rewrite needs accept_trunk', async () => {
    const w = await world();
    const lease = await w.takeLease();
    const policy = { keep_place_retries: 1, sendback_grace_min: 10, approval_timeout_hours: 2, claim_gate: 'warn' };
    const first = await w.ok('POST', '/lander/trunk', { lease, from: null, to: sha('a'), commits: [{ sha: sha('a'), landing: null, hub: null, source: null, files: ['README.md'] }], rewritten: false, policy }, asLander);
    expect(first.control).toMatchObject({ paused: null, trunk: { sha: sha('a'), landing_id: null }, policy });
    await w.refused([409, 'not_lander'], 'POST', '/lander/trunk', { lease: { ...lease, lease_claim_id: 'C-99' }, from: null, to: sha('a'), commits: [], rewritten: false, policy }, asLander);
    await w.refused([400, 'bad_request'], 'POST', '/lander/trunk', { lease, from: null, to: sha('a'), commits: [], rewritten: false, policy: {} }, asLander);
    const rewritten = await w.ok('POST', '/lander/trunk', { lease, from: sha('a'), to: sha('b'), commits: [], rewritten: true, policy }, asLander);
    expect(rewritten.control.paused).toMatchObject({ reason: 'trunk_rewritten', by: LANDER });
    await w.refused([409, 'not_lander'], 'POST', '/lander/pause', { lease: { ...lease, epoch: 'other' }, reason: 'push_rejected', detail: 'x' }, asLander);
    await w.refused([403, 'not_approver'], 'POST', '/lander/resume', {}, { approver: 'maya', approverToken: 'wrong' });
    await w.refused([400, 'bad_request'], 'POST', '/lander/resume', {}, approver('maya'));
    const resumed = await w.ok('POST', '/lander/resume', { accept_trunk: sha('b') }, approver('maya'));
    expect(resumed.control).toMatchObject({ paused: null, trunk: { sha: sha('b') } });
    const paused = await w.ok('POST', '/lander/pause', { lease, reason: 'push_rejected', detail: 'main is protected' }, asLander);
    expect(paused.control.paused).toMatchObject({ reason: 'push_rejected', detail: 'main is protected' });
    expect((await w.ok('GET', '/lander')).control.paused).toMatchObject({ reason: 'push_rejected' });
    const types = (await w.events()).map((e) => e.type).filter((t) => t.startsWith('lander.'));
    expect(types).toEqual(['lander.paused', 'lander.resumed', 'lander.paused']);
  });

  it('claims: the lease key needs lander credentials (403 forbidden), a hold can’t be released (held_by_landing), and check takes a scope', async () => {
    const w = await world();
    await w.refused([403, 'forbidden'], 'POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true }, { agent: A, landerToken: LANDER_TOKEN });
    await w.refused([403, 'forbidden'], 'POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true }, { agent: LANDER });
    await w.refused([403, 'forbidden'], 'POST', '/claims', { scope: [{ file: LANDER_LEASE_KEY }], queue: true }, { agent: LANDER, landerToken: 'wrong' });
    await w.refused([403, 'forbidden'], 'POST', '/claims', { files: ['.git/agenthub/other'] }, asLander);
    await w.refused([403, 'forbidden'], 'POST', '/claims', { files: [LANDER_LEASE_KEY], mode: 'shared' }, asLander);
    const lease = await w.takeLease();
    expect(lease.lease_claim_id).toMatch(/^C-\d+$/);
    // A hold is released by its landing, not by its holder.
    const ta = await w.task(A, 'a');
    const r = await w.land(A, ta, sha('1'), ['a.ts']);
    const held = await w.refused([409, 'held_by_landing'], 'POST', '/claims/release', { claim_id: r.held[0].id }, { agent: A });
    expect(held.message).toContain('L-1');
    // The guard's check: another agent's hold conflicts; a scope names files too.
    expect((await w.ok('POST', '/claims/check', { files: ['a.ts'] }, { agent: B })).conflicts).toEqual([expect.objectContaining({ landing_id: 'L-1', holder: A })]);
    expect((await w.ok('POST', '/claims/check', { scope: [{ file: 'a.ts', symbol: 'login' }], mapper: 'm1' }, { agent: B })).conflicts).toEqual([expect.objectContaining({ landing_id: 'L-1' })]);
    expect((await w.ok('POST', '/claims/check', { scope: [{ file: 'free.ts' }] }, { agent: B })).conflicts).toEqual([]);
  });

  it('claims and check: invalid_symbol for a bad symbol key or a symbol without a mapper, and symbol-level answers (H5)', async () => {
    const w = await world();
    const login = { file: 'a.ts', symbol: 'login' };
    for (const route of ['/claims', '/claims/check']) {
      await w.refused([400, 'invalid_symbol'], 'POST', route, { scope: [{ file: 'a.ts', symbol: 'not a key' }], mapper: 'm1' }, { agent: A });
      await w.refused([400, 'invalid_symbol'], 'POST', route, { scope: [login] }, { agent: A });
      await w.refused([400, 'bad_request'], 'POST', route, { scope: [login], mapper: 7 }, { agent: A });
      await w.refused([400, 'bad_request'], 'POST', route, { scope: 'a.ts', mapper: 'm1' }, { agent: A });
    }
    expect((await w.ok('POST', '/claims', { scope: [login], mapper: 'm1' }, { agent: A })).claim).toMatchObject({ scope: [login], mapper: 'm1' });
    expect((await w.ok('POST', '/claims', { scope: [{ file: 'a.ts', symbol: 'logout' }], mapper: 'm1' }, { agent: B })).status).toBe('granted');
    expect((await w.ok('POST', '/claims/check', { scope: [{ file: 'a.ts', symbol: 'refresh' }], mapper: 'm1' }, { agent: C })).conflicts).toEqual([]);
    expect((await w.ok('POST', '/claims/check', { scope: [login], mapper: 'm1', mode: 'auto' }, { agent: C })).conflicts).toEqual([expect.objectContaining({ holder: A, scope: [login] })]);
    expect((await w.ok('POST', '/claims/check', { files: ['a.ts'] }, { agent: C })).conflicts.map((c: any) => c.holder)).toEqual([A, B]);
  });
});

// ---------------------------------------------------- lander credentials

describe('lander credentials (design §1.2, §1.7)', () => {
  /** Every lander route, with a body the hub would accept from a lander that holds lease C-1. */
  const LANDER_ROUTES: Array<[string, Record<string, unknown>]> = [
    ['/lander/next', {}],
    ['/landings/L-1/admit', { base_sha: sha('0'), files: ['a.ts'] }],
    ['/landings/L-1/advance', { attempt: 1, to: 'running', phase: 'checking', deadline_ms: MIN }],
    ['/landings/L-1/resolve', { outcome: 'requeue', trunk_sha: sha('b') }],
    ['/lander/trunk', { from: null, to: sha('a'), commits: [], rewritten: false, policy: { keep_place_retries: 2, sendback_grace_min: 30, approval_timeout_hours: 24, claim_gate: 'fail' } }],
    ['/lander/pause', { reason: 'push_rejected', detail: 'x' }],
  ];

  it('a hub on 0.0.0.0 without a lander token answers 403 lander_token_required on every lander route and on the lease claim', async () => {
    const w = await world({ host: '0.0.0.0', approvers: APPROVERS });
    expect(w.s.loopback).toBe(false);
    const lease = { lease_claim_id: 'C-1', epoch: w.s.hub.epoch };
    for (const [route, body] of LANDER_ROUTES) {
      const err = await w.refused([403, 'lander_token_required'], 'POST', route, { lease, ...body }, { agent: LANDER });
      expect(err.message).toContain('--lander-token');
    }
    await w.refused([403, 'lander_token_required'], 'POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true }, { agent: LANDER });
    await w.refused([403, 'lander_token_required'], 'POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true }, asLander);
    // Agents work as before, and reads need no credentials.
    expect((await w.ok('POST', '/claims', { files: ['a.ts'] }, { agent: A })).status).toBe('granted');
    expect((await w.ok('GET', '/lander')).lease).toBeNull();
  });

  it('with a lander token, a wrong or missing token answers 403 on every lander route, on 0.0.0.0 and on loopback alike', async () => {
    for (const host of ['0.0.0.0', '127.0.0.1']) {
      const w = await world({ host, landerToken: LANDER_TOKEN });
      for (const bad of ['wrong', undefined, `${LANDER_TOKEN}x`, LANDER_TOKEN.slice(1)]) {
        await w.refused([403, 'forbidden'], 'POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true }, { agent: LANDER, landerToken: bad });
      }
      const lease = await w.takeLease();
      for (const [route, body] of LANDER_ROUTES) {
        const wrong = await w.refused([403, 'forbidden'], 'POST', route, { lease, ...body }, { agent: LANDER, landerToken: 'wrong' });
        expect(wrong.message).toContain('x-hub-lander-token');
        await w.refused([403, 'forbidden'], 'POST', route, { lease, ...body }, { agent: LANDER });
        // The right token, but not a lander's agent id.
        await w.refused([403, 'forbidden'], 'POST', route, { lease, ...body }, { agent: A, landerToken: LANDER_TOKEN });
      }
      expect((await w.ok('POST', '/lander/next', { lease }, asLander)).landing).toBeNull();
    }
  });

  it('with a lander token, a lander/ agent id needs it on heartbeat, release and events too; other agents and tokenless hubs are unchanged', async () => {
    const w = await world({ landerToken: LANDER_TOKEN });
    const lease = await w.takeLease();
    const asIs: Array<[string, string, Record<string, unknown> | undefined]> = [
      ['POST', '/heartbeat', { claim_ids: [lease.lease_claim_id] }],
      ['GET', '/events?since=0', undefined],
      ['POST', '/claims/release', { files: ['nothing.ts'] }],
    ];
    for (const [method, route, body] of asIs) {
      for (const bad of [undefined, 'wrong']) {
        const err = await w.refused([403, 'forbidden'], method, route, body, { agent: LANDER, landerToken: bad });
        expect(err.message).toContain('x-hub-lander-token');
        expect(err.message).not.toContain(LANDER_TOKEN);
      }
      await w.ok(method, route, body, asLander);
      await w.ok(method, route, body, { agent: A });
    }
    // Nobody released the lease or let it lapse.
    expect(w.s.hub.getClaim('demo', lease.lease_claim_id).status).toBe('active');
    // A loopback hub without a token checks nothing, as before.
    const open = await world({});
    await open.ok('POST', '/heartbeat', {}, { agent: LANDER });
    await open.ok('GET', '/events?since=0', undefined, { agent: LANDER });
  });

  it('with a lander token, a lander/ agent id needs it on any claim, on land and on the WebSocket feed: none of them renews, moves or follows the lease without it (CP2)', async () => {
    const w = await world({ landerToken: LANDER_TOKEN });
    const lease = await w.takeLease();
    const leaseClaim = () => w.s.hub.getClaim('demo', lease.lease_claim_id);
    const before = leaseClaim().expires_at;
    const sends: Array<[string, Record<string, unknown>]> = [
      // A claim on an ordinary file renews every lease its agent holds, the lander lease included.
      ['/claims', { files: ['x.ts'] }],
      // A queue-mode land would take the agent's claims into its landing.
      ['/land', { commit: sha('d'), queue: true, files: ['x.ts'] }],
    ];
    for (const bad of [undefined, 'wrong']) {
      for (const [route, body] of sends) {
        const err = await w.refused([403, 'forbidden'], 'POST', route, body, { agent: LANDER, landerToken: bad });
        expect(err.message).toContain('x-hub-lander-token');
        expect(err.message).not.toContain(LANDER_TOKEN);
      }
      const ws = await feedAs(w.s.url, LANDER, bad);
      expect(ws.status).toBe(403);
      expect(JSON.parse(ws.body).error.code).toBe('forbidden');
    }
    // Nothing renewed or moved the lease.
    expect(leaseClaim()).toMatchObject({ status: 'active', expires_at: before, landing_id: null });
    // With the token they work, and an agent's need none.
    expect((await feedAs(w.s.url, LANDER, LANDER_TOKEN)).status).toBe(101);
    expect((await feedAs(w.s.url, A)).status).toBe(101);
    expect((await w.ok('POST', '/claims', { files: ['x.ts'] }, asLander)).status).toBe('granted');
    expect((await w.ok('POST', '/claims', { files: ['y.ts'] }, { agent: A })).status).toBe('granted');
    await w.ok('POST', '/land', { commit: sha('e'), queue: true, files: ['y.ts'] }, { agent: A });
    // Even with the token, a lander/ id's land never takes the lease into its landing (see landings.queue.test.ts).
    const landed = await w.ok('POST', '/land', { commit: sha('d'), queue: true, files: ['x.ts'] }, asLander);
    expect(landed.released.map((c: { id: string }) => c.id)).not.toContain(lease.lease_claim_id);
    expect(leaseClaim()).toMatchObject({ status: 'active', landing_id: null });
    // A loopback hub without a token checks nothing, as before.
    const open = await world({});
    await open.ok('POST', '/claims', { files: ['x.ts'] }, { agent: LANDER });
    expect((await feedAs(open.s.url, LANDER)).status).toBe(101);
  });

  it('on loopback without a token, lander/ agents may use the lander routes and claim the lease; other agents may not', async () => {
    const w = await world({});
    expect(w.s.loopback).toBe(true);
    await w.refused([403, 'forbidden'], 'POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true }, { agent: A });
    const r = await w.ok('POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 10 * MIN }, { agent: LANDER });
    const lease = { lease_claim_id: r.claim.id, epoch: w.s.hub.epoch };
    expect((await w.ok('POST', '/lander/next', { lease }, { agent: LANDER })).resolve).toBe(false);
    await w.refused([403, 'forbidden'], 'POST', '/lander/next', { lease }, { agent: A });
    await w.refused([400, 'bad_agent'], 'POST', '/lander/next', { lease });
  });
});

// -------------------------------------------------- approver credentials

describe('approver credentials (design §1.2, §1.7)', () => {
  async function waiting(opts: Partial<Omit<ServerOptions, 'hub'>>) {
    const w = await world(opts);
    const r = await w.ok('POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 10 * MIN }, { agent: LANDER, landerToken: opts.landerToken });
    const lease = { lease_claim_id: r.claim.id, epoch: w.s.hub.epoch };
    const ta = await w.task(A, 'a');
    await w.land(A, ta, sha('1'), ['migrations/0042.sql']);
    await w.ok('POST', '/landings/L-1/admit', { lease, base_sha: sha('0'), files: ['migrations/0042.sql'], protected: ['migrations/0042.sql'], required: [requirement(dig('1'))] }, { agent: LANDER, landerToken: opts.landerToken });
    return w;
  }
  const approve = { kind: 'protected', digest: dig('1') };

  it('a wrong token, a missing token or an unknown name answers 403 not_approver; the right token approves', async () => {
    const w = await waiting({ landerToken: LANDER_TOKEN, approvers: APPROVERS });
    for (const as of [
      { approver: 'sam', approverToken: 'wrong' },
      { approver: 'sam', approverToken: TOKENS.maya },
      { approver: 'sam' },
      { approver: 'sam', approverToken: '' },
      { approver: 'lee', approverToken: TOKENS.sam },
      { approver: 'not a name', approverToken: TOKENS.sam },
      { approverToken: TOKENS.sam },
      {},
    ] as As[]) {
      await w.refused([403, 'not_approver'], 'POST', '/landings/L-1/approve', approve, as);
      await w.refused([403, 'not_approver'], 'POST', '/landings/L-1/reject', { reason: 'no' }, as);
      await w.refused([403, 'not_approver'], 'POST', '/lander/resume', {}, as);
    }
    // An agent id is no approver.
    await w.refused([403, 'not_approver'], 'POST', '/landings/L-1/approve', approve, { agent: B });
    // A wrong approver token on a cancel is refused too, even from someone who could cancel otherwise.
    await w.refused([403, 'not_approver'], 'POST', '/landings/L-1/cancel', {}, { approver: 'sam', approverToken: 'wrong' });
    expect((await w.ok('GET', '/landings/L-1')).landing.status).toBe('queued');
    const ok = await w.ok('POST', '/landings/L-1/approve', approve, approver('sam'));
    expect(ok.landing.approvals).toEqual([expect.objectContaining({ by: 'sam' })]);
  });

  it('without an approvers file, approve, reject, resume and an approver’s cancel answer 403 approvals_disabled', async () => {
    const w = await waiting({ landerToken: LANDER_TOKEN });
    for (const as of [approver('sam'), {}]) {
      const err = await w.refused([403, 'approvals_disabled'], 'POST', '/landings/L-1/approve', approve, as);
      expect(err.message).toContain('--approvers');
      await w.refused([403, 'approvals_disabled'], 'POST', '/landings/L-1/reject', { reason: 'no' }, as);
      await w.refused([403, 'approvals_disabled'], 'POST', '/lander/resume', {}, as);
    }
    await w.refused([403, 'approvals_disabled'], 'POST', '/landings/L-1/cancel', {}, approver('sam'));
    // Its author can still cancel it.
    expect((await w.ok('POST', '/landings/L-1/cancel', {}, { agent: A })).landing.status).toBe('cancelled');
  });

  it('--allow-unauthenticated-approvals on loopback takes the name alone; startServer refuses it off loopback', async () => {
    const w = await waiting({ allowUnauthenticatedApprovals: true });
    await w.refused([403, 'not_approver'], 'POST', '/landings/L-1/approve', approve, {});
    await w.refused([403, 'not_approver'], 'POST', '/landings/L-1/approve', approve, { approver: 'maya' }); // distinct: maya is the author's human
    expect((await w.ok('POST', '/landings/L-1/approve', approve, { approver: 'sam' })).landing.approvals).toEqual([expect.objectContaining({ by: 'sam' })]);
    const hub = new Hub({ store: new SqliteStore(':memory:') });
    await expect(startServer({ hub, port: 0, host: '0.0.0.0', allowUnauthenticatedApprovals: true })).rejects.toThrow(/allow-unauthenticated-approvals.*loopback/);
  });

  it('parseApprovers takes {name: "sha256:<hex>"} and refuses anything else, naming the problem', () => {
    const map = parseApprovers({ maya: approverTokenDigest('t'), 'sam.k': `sha256:${'AB'.repeat(32)}` });
    expect([...map.keys()]).toEqual(['maya', 'sam.k']);
    expect(approverTokenDigest('t')).toBe(`sha256:${createHash('sha256').update('t').digest('hex')}`);
    for (const [bad, why] of [
      [[], /JSON object/],
      [null, /JSON object/],
      ['maya', /JSON object/],
      [{}, /no approvers/],
      [{ 'maya/claude-1': approverTokenDigest('t') }, /human name/],
      [{ maya: 'plain-token' }, /sha256:/],
      [{ maya: `sha256:${'a'.repeat(63)}` }, /sha256:/],
      [{ maya: 42 }, /sha256:/],
    ] as Array<[unknown, RegExp]>) {
      expect(() => parseApprovers(bad), JSON.stringify(bad)).toThrow(why);
    }
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
    expect(isLoopbackHost('hub.example.com')).toBe(false);
  });
});

// -------------------------------------------------------- hub-server flags

describe('hub-server landing flags', () => {
  /** Runs hub-server with settings that must be refused before the database opens; returns its one-line complaint. */
  function refused(args: string[], env: Record<string, string> = {}): string {
    const db = path.join(tempDir(), 'hub.db');
    const r = spawnSync(process.execPath, [bin, '--port', '0', '--db', db, ...args], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...env } });
    const what = `${args.join(' ')} ${JSON.stringify(env)}`;
    expect(r.stdout, what).not.toContain('listening');
    expect(r.status, `${what}: ${r.stderr}`).toBe(2);
    expect(r.stderr.trim().split('\n'), what).toHaveLength(1);
    expect(existsSync(db), what).toBe(false);
    return r.stderr.trim();
  }

  /** Starts hub-server and resolves once its startup report is complete. */
  async function startCli(args: string[], env: Record<string, string> = {}): Promise<{ url: string; child: ChildProcess; output: () => string }> {
    const db = path.join(tempDir(), 'hub.db');
    const child = spawn(process.execPath, [bin, '--port', '0', '--db', db, ...args], { env: { ...process.env, ...env } });
    cleanups.push(() => child.kill('SIGKILL'));
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    child.stderr!.on('data', (d) => (out += d));
    const url = await new Promise<string>((resolve, reject) => {
      const check = () => {
        const m = /listening on (http:\/\/\S+)[^]*\n {2}(?:approvals|warning: --allow-unauthenticated-approvals).*\n/.exec(out);
        if (m) resolve(m[1]);
      };
      child.stdout!.on('data', check);
      child.stderr!.on('data', check);
      child.on('exit', (code) => reject(new Error(`hub-server exited with ${code}: ${out}`)));
    });
    return { url, child, output: () => out };
  }

  function approversFile(content: string): string {
    const file = path.join(tempDir(), 'approvers.json');
    writeFileSync(file, content);
    return file;
  }

  it('refuses --allow-unauthenticated-approvals with --host 0.0.0.0 (exit 2, one line) before opening the database', () => {
    expect(refused(['--allow-unauthenticated-approvals', '--host', '0.0.0.0'])).toMatch(/^hub-server: --allow-unauthenticated-approvals .*loopback/);
    expect(refused(['--allow-unauthenticated-approvals', '--host', '::'])).toMatch(/^hub-server: --allow-unauthenticated-approvals /);
    expect(refused(['--allow-unauthenticated-approvals'], { HUB_HOST: '0.0.0.0' })).toMatch(/^hub-server: --allow-unauthenticated-approvals /);
    expect(refused(['--allow-unauthenticated-approvals', '--host', 'hub.example.com'])).toMatch(/^hub-server: --allow-unauthenticated-approvals /);
  });

  it('refuses an empty or unsendable lander token and a bad approvers file, in one line, before opening the database', () => {
    expect(refused(['--lander-token', ''])).toMatch(/^hub-server: --lander-token must be/);
    expect(refused(['--lander-token', 'has space'])).toMatch(/^hub-server: --lander-token must be/);
    expect(refused([], { HUB_LANDER_TOKEN: 'tab\there' })).toMatch(/^hub-server: HUB_LANDER_TOKEN must be/);
    const missing = path.join(tempDir(), 'nope.json');
    expect(refused(['--approvers', missing])).toMatch(new RegExp(`^hub-server: --approvers ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
    expect(refused(['--approvers', approversFile('{"maya": ')])).toMatch(/^hub-server: --approvers .*: not JSON/);
    expect(refused(['--approvers', approversFile('{"maya": "secret-token"}')])).toMatch(/^hub-server: --approvers .*sha256:/);
    expect(refused([], { HUB_APPROVERS_FILE: approversFile('[]') })).toMatch(/^hub-server: HUB_APPROVERS_FILE .*JSON object/);
    // The complaint never repeats a token.
    expect(refused(['--lander-token', 'secret value'])).not.toContain('secret value');
  });

  it('takes the lander token and the approvers file from flags or the environment, warns at startup, and logs landing ids', async () => {
    const file = approversFile(JSON.stringify(APPROVERS));
    const s = await startCli(['--lander-token', LANDER_TOKEN, '--approvers', file]);
    expect(s.output()).toContain('approvals: maya, sam');
    expect(s.output()).not.toContain('warning');
    expect(s.output()).not.toContain(LANDER_TOKEN);
    const lease = await call(s.url, 'POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 10 * MIN }, asLander);
    expect(lease.json.status).toBe('granted');
    expect((await call(s.url, 'POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true }, { agent: STANDBY, landerToken: 'wrong' })).status).toBe(403);
    expect((await call(s.url, 'POST', '/lander/resume', {}, approver('sam'))).status).toBe(200);
    expect((await call(s.url, 'POST', '/lander/resume', {}, { approver: 'sam', approverToken: 'wrong' })).status).toBe(403);
    // Log lines name the landing.
    const t = (await call(s.url, 'POST', '/tasks', { title: 'a' }, { agent: A })).json.task.id;
    await call(s.url, 'POST', `/tasks/${t}/take`, {}, { agent: A });
    expect((await call(s.url, 'POST', '/land', { task_id: t, commit: sha('1'), queue: true, files: ['a.ts'] }, { agent: A })).status).toBe(200);
    await expect.poll(() => s.output()).toMatch(new RegExp(`#\\d+ landing\\.created ${A} L-1`));

    // The same from the environment.
    const e = await startCli([], { HUB_LANDER_TOKEN: LANDER_TOKEN, HUB_APPROVERS_FILE: file });
    expect((await call(e.url, 'POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true }, asLander)).json.status).toBe('granted');
    expect((await call(e.url, 'POST', '/lander/resume', {}, approver('maya'))).status).toBe(200);

    // No token on loopback, approvals disabled: a warning and a note.
    const plain = await startCli([]);
    expect(plain.output()).toMatch(/warning: no --lander-token/);
    expect(plain.output()).toMatch(/approvals: disabled/);
    expect((await call(plain.url, 'POST', '/lander/resume', {}, approver('maya'))).json.error.code).toBe('approvals_disabled');
    // No token on a network address: lander routes are closed, and it says so.
    const net = await startCli(['--host', '0.0.0.0']);
    expect(net.output()).toMatch(/warning: no --lander-token.*lander_token_required/);
    expect((await call(net.url, 'POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true }, { agent: LANDER })).json.error.code).toBe('lander_token_required');
    // Unauthenticated approvals on loopback: a warning, and the name alone approves.
    const demo = await startCli(['--allow-unauthenticated-approvals']);
    expect(demo.output()).toMatch(/warning: --allow-unauthenticated-approvals/);
    expect((await call(demo.url, 'POST', '/lander/resume', {}, { approver: 'maya' })).status).toBe(200);
  });
});
