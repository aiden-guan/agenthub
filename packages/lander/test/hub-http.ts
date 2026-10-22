// A test-only HTTP front for the real Hub (H1-H3, merged at CP1a), speaking
// the design §1.7 routes the lander's HubClient uses. The hub's own lander
// and approver routes arrive with H4 (CP1); until then this front lets the
// integration tests run the real lander over HTTP against the real hub
// logic. At CP1 it can be swapped for @agenthub/hub's startServer.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hub, HubError, isVisibleTo, type HubAuth } from '@agenthub/hub';
import type { EventsResult, LandingStatus } from '@agenthub/hub/protocol';

export interface HubFront {
  url: string;
  hub: Hub;
  close(): Promise<void>;
}

type Ctx = { project: string; agent: string | null; params: string[]; query: URLSearchParams; body: Record<string, any>; auth: HubAuth; res: ServerResponse };
type Handler = (c: Ctx) => unknown | Promise<unknown>;

/** Serves `hub` on 127.0.0.1:0. Lander routes need `x-hub-agent: lander/…` (and the token when one is set); approvers send `x-hub-approver`. */
export async function startHubFront(hub: Hub, o: { landerToken?: string; sweepMs?: number } = {}): Promise<HubFront> {
  const me = (c: Ctx): string => {
    if (!c.agent) throw new HubError('bad_agent', 'send your agent id in x-hub-agent', 400);
    return c.agent;
  };
  const routes: Array<{ method: string; re: RegExp; fn: Handler }> = [];
  const r = (method: string, p: string, fn: Handler) => routes.push({ method, re: new RegExp(`^${p.replace(/:[a-z_]+/g, '([^/]+)')}$`), fn });

  r('GET', '/status', (c) => hub.status(c.project, c.agent));
  r('POST', '/heartbeat', (c) => hub.heartbeat(c.project, me(c), c.body));
  r('GET', '/tasks', (c) => ({ tasks: hub.listTasks(c.project) }));
  r('POST', '/claims', (c) => hub.claim(c.project, me(c), c.body, c.auth));
  r('POST', '/claims/release', (c) => hub.release(c.project, me(c), c.body));
  r('GET', '/claims/:id', (c) => ({ claim: hub.getClaim(c.project, c.params[0]!) }));
  r('POST', '/messages', (c) => ({ message: hub.post(c.project, me(c), c.body as any) }));
  r('GET', '/decisions', (c) => ({ decisions: hub.listDecisions(c.project, c.query.has('limit') ? Number(c.query.get('limit')) : 20) }));
  r('POST', '/land', (c) => hub.land(c.project, me(c), c.body));
  r('GET', '/landings', (c) => ({
    landings: hub.listLandings(c.project, {
      statuses: c.query.get('status')?.split(',').filter(Boolean) as LandingStatus[] | undefined,
      agent: c.query.get('agent') ?? undefined,
      task_id: c.query.get('task') ?? undefined,
      limit: c.query.has('limit') ? Number(c.query.get('limit')) : undefined,
    }),
  }));
  r('GET', '/landings/stats', (c) => hub.landingStats(c.project, c.query.get('days') ?? undefined));
  r('GET', '/landings/:id', (c) => ({ landing: hub.getLanding(c.project, c.params[0]!) }));
  r('POST', '/landings/:id/cancel', (c) => hub.cancelLanding(c.project, c.agent, c.params[0]!, c.body as any, c.auth));
  r('POST', '/landings/:id/approve', (c) => hub.approveLanding(c.project, c.params[0]!, c.body as any, c.auth));
  r('POST', '/landings/:id/reject', (c) => hub.rejectLanding(c.project, c.params[0]!, c.body as any, c.auth));
  r('POST', '/landings/:id/admit', (c) => hub.admitLanding(c.project, me(c), c.params[0]!, c.body as any, c.auth));
  r('POST', '/landings/:id/advance', (c) => hub.advanceLanding(c.project, me(c), c.params[0]!, c.body as any, c.auth));
  r('POST', '/landings/:id/resolve', (c) => hub.resolveLanding(c.project, me(c), c.params[0]!, c.body as any, c.auth));
  r('GET', '/lander', (c) => hub.landerStatus(c.project));
  r('POST', '/lander/next', (c) => hub.nextLanding(c.project, me(c), c.body as any, c.auth));
  r('POST', '/lander/trunk', (c) => hub.reportTrunk(c.project, me(c), c.body as any, c.auth));
  r('POST', '/lander/pause', (c) => hub.pauseLander(c.project, me(c), c.body as any, c.auth));
  r('POST', '/lander/resume', (c) => hub.resumeLander(c.project, c.body as any, c.auth));
  r('GET', '/events', (c) => longPoll(hub, c));

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    const m = /^\/v1\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!m) throw new HubError('not_found', `no route for ${req.method} ${url.pathname}`, 404);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const agent = typeof req.headers['x-hub-agent'] === 'string' ? req.headers['x-hub-agent'] : null;
    const token = req.headers['x-hub-lander-token'];
    const lander = agent !== null && agent.startsWith('lander/') && (o.landerToken === undefined || token === o.landerToken);
    const approver = typeof req.headers['x-hub-approver'] === 'string' ? req.headers['x-hub-approver'] : null;
    const ctxBase = { project: decodeURIComponent(m[1]!), agent, query: url.searchParams, body: text ? JSON.parse(text) : {}, auth: { lander, approver }, res };
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const pm = route.re.exec(m[2]!);
      if (!pm) continue;
      const result = await route.fn({ ...ctxBase, params: pm.slice(1).map(decodeURIComponent) });
      const body = JSON.stringify(result);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    throw new HubError('not_found', `no route for ${req.method} ${url.pathname}`, 404);
  }

  const sweeper = setInterval(() => {
    try {
      hub.sweep();
    } catch {
      // a test's database may be closing
    }
  }, o.sweepMs ?? 200);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hub,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function longPoll(hub: Hub, c: Ctx): EventsResult | Promise<EventsResult> {
  const since = Number(c.query.get('since') ?? hub.latestSeq(c.project));
  const waitMs = Math.max(0, Number(c.query.get('wait_ms') ?? 0) || 0);
  const types = c.query.get('types')?.split(',').filter(Boolean);
  const read = (from: number): EventsResult => {
    const r = hub.readEvents(c.project, c.agent, from, { types });
    return { events: r.events, seq: hub.latestSeq(c.project), next_since: r.next_since, epoch: hub.epoch };
  };
  const now = read(since);
  if (now.events.length > 0 || waitMs === 0) return now;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(read(now.next_since));
    };
    const unsubscribe = hub.subscribe((e) => {
      if (e.project === c.project && e.seq > now.next_since && isVisibleTo(e, c.agent) && (!types || types.includes(e.type))) finish();
    });
    const timer = setTimeout(finish, waitMs);
    c.res.on('close', finish);
  });
}

function sendError(res: ServerResponse, err: unknown): void {
  const e = err instanceof HubError ? err : null;
  if (!e) console.error('[hub-front] internal error:', err);
  const body = JSON.stringify({ error: { code: e?.code ?? 'internal', message: e?.message ?? 'internal error', ...(e?.details ? { details: e.details } : {}) } });
  if (res.headersSent) return void res.end();
  res.writeHead(e?.status ?? 500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
