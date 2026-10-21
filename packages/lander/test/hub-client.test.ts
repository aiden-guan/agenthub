import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  ClaimRequest,
  LanderNextRequest,
  LanderPauseRequest,
  LandingAdmitRequest,
  LandingAdvanceRequest,
  LandingResolveRequest,
  TrunkReportRequest,
} from '@agenthub/hub/protocol';
import { HubClient } from '../src/hub-client.js';
import { HubCallError, isHubError } from '../src/ports.js';

// Lane L's hub client against the frozen contract fixtures (design §6.3.7):
// every request fixture goes out exactly as given, every response fixture
// comes back exactly as served, through a fake HTTP server that speaks the
// §1.7 routes. The real routes arrive with H4; the fixtures are the contract.

const FIXTURES = new URL('../../hub/test/fixtures/contract/', import.meta.url);
const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;

const AGENT = 'lander/build1-48213-9f3c';
const PROJECT = 'acme/web';
const BASE = `/v1/p/${encodeURIComponent(PROJECT)}`;

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
}

type Reply = { status: number; body: unknown; raw?: string; delayMs?: number } | ((seen: Seen, res: ServerResponse) => void);

describe('HubClient (HubPort over HTTP) against the contract fixtures', () => {
  let server: Server;
  let url: string;
  const seen: Seen[] = [];
  const replies = new Map<string, Reply>();

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const u = new URL(req.url ?? '/', 'http://hub.local');
      const text = Buffer.concat(chunks).toString('utf8');
      const s: Seen = { method: req.method ?? '', path: u.pathname, query: u.searchParams, headers: req.headers, body: text ? JSON.parse(text) : undefined };
      seen.push(s);
      const reply = replies.get(`${s.method} ${s.path}`);
      if (!reply) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ error: { code: 'not_found', message: `no route for ${s.method} ${s.path}` } }));
      }
      if (typeof reply === 'function') return reply(s, res);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.raw ?? JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(() => {
    seen.length = 0;
    replies.clear();
  });

  const client = (o: { timeoutMs?: number; token?: string | null; landerToken?: string | null } = {}) =>
    new HubClient({ url, project: PROJECT, agent: AGENT, token: o.token === undefined ? 'hub-bearer' : o.token, landerToken: o.landerToken === undefined ? 'lander-secret' : o.landerToken, timeoutMs: o.timeoutMs ?? 5000 });
  const serve = (method: string, path: string, body: unknown, status = 200) => replies.set(`${method} ${BASE}${path}`, { status, body });
  const last = () => seen[seen.length - 1]!;

  it('sends the lander agent id, the bearer token and the lander token on every call', async () => {
    serve('POST', '/lander/next', fixture('lander.next.response.json'));
    serve('GET', '/lander', { lease: null, control: fixture('lander.control.response.json').control });
    await client().next(fixture<LanderNextRequest>('lander.next.request.json'));
    await client().lander();
    for (const s of seen) {
      expect(s.headers['x-hub-agent']).toBe(AGENT);
      expect(s.headers.authorization).toBe('Bearer hub-bearer');
      expect(s.headers['x-hub-lander-token']).toBe('lander-secret');
    }
    expect(seen[0]!.headers['content-type']).toBe('application/json');
    // Without tokens, no empty headers are sent.
    await client({ token: null, landerToken: null }).lander();
    expect(last().headers.authorization).toBeUndefined();
    expect(last().headers['x-hub-lander-token']).toBeUndefined();
  });

  const writes: Array<{ name: string; path: string; request: string; response: string; call: (c: HubClient, req: any) => Promise<unknown> }> = [
    { name: 'next', path: '/lander/next', request: 'lander.next.request.json', response: 'lander.next.response.json', call: (c, r) => c.next(r as LanderNextRequest) },
    { name: 'next (resolve)', path: '/lander/next', request: 'lander.next.request.json', response: 'lander.next.resolve.response.json', call: (c, r) => c.next(r) },
    { name: 'admit', path: '/landings/L-7/admit', request: 'landing.admit.request.json', response: 'landing.admit.response.json', call: (c, r) => c.admit('L-7', r as LandingAdmitRequest) },
    ...['merging', 'pushing', 'needs_approval', 'landed', 'failed'].map((to) => ({
      name: `advance ${to}`,
      path: '/landings/L-7/advance',
      request: `landing.advance.${to}.request.json`,
      response: 'landing.advance.response.json',
      call: (c: HubClient, r: unknown) => c.advance('L-7', r as LandingAdvanceRequest),
    })),
    ...['landed', 'requeue'].map((outcome) => ({
      name: `resolve ${outcome}`,
      path: '/landings/L-7/resolve',
      request: `landing.resolve.${outcome}.request.json`,
      response: 'landing.advance.response.json',
      call: (c: HubClient, r: unknown) => c.resolve('L-7', r as LandingResolveRequest),
    })),
    { name: 'trunk report', path: '/lander/trunk', request: 'lander.trunk.request.json', response: 'lander.control.response.json', call: (c, r) => c.reportTrunk(r as TrunkReportRequest) },
  ];

  for (const w of writes) {
    it(`${w.name}: POST ${w.path} sends the request fixture and returns the response fixture`, async () => {
      const response = fixture(w.response);
      serve('POST', w.path, response);
      const request = fixture(w.request);
      const result = await w.call(client(), request);
      expect(last().method).toBe('POST');
      expect(last().path).toBe(`${BASE}${w.path}`);
      expect(last().body).toEqual(request);
      expect(result).toEqual(response);
    });
  }

  it('pause and the lander status go to their routes', async () => {
    const control = fixture('lander.control.response.json');
    serve('POST', '/lander/pause', control);
    const pause: LanderPauseRequest = { lease: fixture<LanderNextRequest>('lander.next.request.json').lease, reason: 'push_rejected', detail: 'remote: protected branch main' };
    expect(await client().pause(pause)).toEqual(control);
    expect(last().body).toEqual(pause);
    const status = { lease: { holder: AGENT, claim_id: 'C-12', expires_at: 1792573200000, standby: ['lander/laptop-881-0c3f'] }, control: control.control };
    serve('GET', '/lander', status);
    expect(await client().lander()).toEqual(status);
    expect(last().method).toBe('GET');
    expect(last().body).toBeUndefined();
  });

  it('reads landings with the §1.7 query, and unwraps landings, landing, tasks and decisions', async () => {
    const list = fixture('landings.list.response.json');
    serve('GET', '/landings', list);
    expect(await client().landings({ status: ['submitted', 'queued'], agent: 'maya/claude-1', task: 'T-3', limit: 50 })).toEqual(list.landings);
    expect(Object.fromEntries(last().query)).toEqual({ status: 'submitted,queued', agent: 'maya/claude-1', task: 'T-3', limit: '50' });
    await client().landings();
    expect([...last().query]).toEqual([]);

    const one = fixture('landing.get.response.json');
    serve('GET', '/landings/L-7', one);
    expect(await client().landing('L-7')).toEqual(one.landing);

    const status = fixture('status.response.json');
    serve('GET', '/status', status);
    expect(await client().status()).toEqual(status);
    serve('GET', '/tasks', { tasks: status.tasks });
    expect(await client().tasks()).toEqual(status.tasks);
    serve('GET', '/decisions', { decisions: status.decisions });
    expect(await client().decisions(200)).toEqual(status.decisions);
    expect(last().query.get('limit')).toBe('200');
  });

  it('lease calls: claim, heartbeat, getClaim, release; and direct messages', async () => {
    const claim = fixture('status.response.json').claims[0];
    const granted = { status: 'granted', claim, claims: [claim], renewed: false, conflicts: [], now: 1, seq: 1 };
    serve('POST', '/claims', granted);
    const symbolClaim = fixture<ClaimRequest>('claims.symbol.request.json');
    expect(await client().claim(symbolClaim)).toEqual(granted);
    expect(last().body).toEqual(symbolClaim);
    serve('POST', '/heartbeat', { renewed: 1, claims: [claim], next_heartbeat_ms: 15000, now: 1, seq: 2 });
    expect((await client().heartbeat({ claim_ids: ['C-12'] })).renewed).toBe(1);
    expect(last().body).toEqual({ claim_ids: ['C-12'] });
    await client().heartbeat();
    expect(last().body).toEqual({});
    serve('GET', '/claims/C-12', { claim });
    expect(await client().getClaim('C-12')).toEqual(claim);
    serve('POST', '/claims/release', { released: [claim], trimmed: [], promoted: [], now: 1, seq: 3 });
    expect((await client().release({ claim_id: 'C-12' })).released).toEqual([claim]);
    const message = { id: 9, project: PROJECT, from: AGENT, to: 'maya/claude-1', channel: null, body: 'L-7 landed', created_at: 1 };
    serve('POST', '/messages', { message });
    expect(await client().post('maya/claude-1', 'L-7 landed')).toEqual(message);
    expect(last().body).toEqual({ to: 'maya/claude-1', body: 'L-7 landed' });
  });

  it('long-polls events with types, since and wait, waiting past its normal timeout', async () => {
    const events = fixture('events.landing.json');
    replies.set(`GET ${BASE}/events`, { status: 200, body: events, delayMs: 300 });
    const r = await client({ timeoutMs: 100 }).events({ since: 412, types: ['landing.created', 'landing.updated', 'lander.resumed'], waitMs: 1000 });
    expect(r).toEqual(events);
    expect(Object.fromEntries(last().query)).toEqual({ since: '412', types: 'landing.created,landing.updated,lander.resumed', wait_ms: '1000' });
    replies.set(`GET ${BASE}/events`, { status: 200, body: events });
    await client().events();
    expect(Object.fromEntries(last().query)).toEqual({ wait_ms: '0' });
  });

  it('an aborted long-poll rejects as aborted, not as an unavailable hub', async () => {
    replies.set(`GET ${BASE}/events`, { status: 200, body: fixture('events.landing.json'), delayMs: 2000 });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    const err = await client().events({ waitMs: 60_000, signal: ctl.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(HubCallError);
    expect(err.code).toBe('aborted');
    expect(err.unavailable).toBe(false);
  });

  it('maps error bodies to typed codes, keeping details (claim_conflict carries the conflicts)', async () => {
    const conflict = fixture('claim.conflict.error.json');
    serve('POST', '/landings/L-7/admit', conflict, 409);
    const err = await client().admit('L-7', fixture('landing.admit.request.json')).catch((e) => e);
    expect(err).toBeInstanceOf(HubCallError);
    expect(err).toMatchObject({ code: 'claim_conflict', status: 409, message: conflict.error.message, details: conflict.error.details });
    expect(err.details.conflicts[0]).toMatchObject({ claim_id: 'C-37', landing_id: 'L-7', scope: [{ file: 'src/auth.ts', symbol: 'login' }] });
    expect(isHubError(err, 'claim_conflict')).toBe(true);
    expect(isHubError(err, 'not_lander')).toBe(false);
    expect(err.unavailable).toBe(false);

    for (const [code, status, details] of [
      ['not_lander', 409, undefined],
      ['landing_stale', 409, undefined],
      ['approval_missing', 409, { missing: [{ kind: 'protected', digest: 'ab' }] }],
      ['too_late', 409, undefined],
      ['lander_token_required', 403, undefined],
      ['forbidden', 403, undefined],
    ] as const) {
      serve('POST', '/landings/L-7/advance', { error: { code, message: `it is ${code}`, ...(details ? { details } : {}) } }, status);
      const e = await client().advance('L-7', fixture('landing.advance.merging.request.json')).catch((x) => x);
      expect(e).toMatchObject({ code, status, message: `it is ${code}` });
      expect(e.details).toEqual(details);
    }
  });

  it('classifies an unreachable, broken or garbled hub', async () => {
    // Nothing listens there.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const down = new HubClient({ url: `http://127.0.0.1:${port}`, project: PROJECT, agent: AGENT, timeoutMs: 2000 });
    const e1 = await down.next(fixture('lander.next.request.json')).catch((e) => e);
    expect(e1).toMatchObject({ code: 'unavailable', status: null });
    expect(e1.unavailable).toBe(true);

    replies.set(`POST ${BASE}/lander/next`, { status: 200, body: {}, delayMs: 500 });
    const e2 = await client({ timeoutMs: 100 }).next(fixture('lander.next.request.json')).catch((e) => e);
    expect(e2).toMatchObject({ code: 'unavailable', status: null });
    expect(e2.message).toMatch(/100 ms/);

    serve('POST', '/lander/next', { error: { code: 'internal', message: 'internal error' } }, 500);
    const e3 = await client().next(fixture('lander.next.request.json')).catch((e) => e);
    expect(e3).toMatchObject({ code: 'internal', status: 500 });
    expect(e3.unavailable).toBe(true);

    replies.set(`POST ${BASE}/lander/next`, { status: 502, body: null, raw: '<html>bad gateway</html>' });
    const e4 = await client().next(fixture('lander.next.request.json')).catch((e) => e);
    expect(e4).toMatchObject({ code: 'bad_response', status: 502 });
    expect(e4.unavailable).toBe(true);

    replies.set(`POST ${BASE}/lander/next`, { status: 200, body: null, raw: 'not json' });
    const e5 = await client().next(fixture('lander.next.request.json')).catch((e) => e);
    expect(e5).toMatchObject({ code: 'bad_response', status: 200 });

    replies.set(`POST ${BASE}/lander/next`, (_s, res) => {
      res.writeHead(409);
      res.end('');
    });
    const e6 = await client().next(fixture('lander.next.request.json')).catch((e) => e);
    expect(e6).toMatchObject({ code: 'http_error', status: 409 });
  });

  it('encodes landing and claim ids into the path', async () => {
    serve('GET', `/landings/${encodeURIComponent('L-7/../x')}`, { landing: null });
    await client().landing('L-7/../x');
    expect(last().path).toBe(`${BASE}/landings/L-7%2F..%2Fx`);
  });
});
