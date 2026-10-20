import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Hub, HubError, assertAgent, isVisibleTo } from './hub.js';
import type { FeedClientFrame, FeedServerFrame, HubEvent, TaskStatus } from './protocol.js';

export interface ServerOptions {
  hub: Hub;
  port?: number;
  host?: string;
  /** If set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** How often to expire leases whose heartbeats stopped. Default 1 s. */
  sweepIntervalMs?: number;
  /** Upper bound for long-poll waits on GET /events. Default 10 min. */
  maxWaitMs?: number;
}

export interface RunningServer {
  url: string;
  port: number;
  hub: Hub;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  project: string;
  params: string[];
  query: URLSearchParams;
  /** From the `x-hub-agent` header; null if absent. */
  agent: string | null;
  body: Record<string, any>;
}

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  handler: Handler;
}

/**
 * HTTP + WebSocket front end for a `Hub`.
 *
 *   GET  /healthz
 *   GET  /v1/p/:project/status
 *   POST /v1/p/:project/heartbeat
 *   GET  /v1/p/:project/tasks            POST /v1/p/:project/tasks
 *   POST /v1/p/:project/tasks/:id/take   POST /v1/p/:project/tasks/:id/update
 *   GET  /v1/p/:project/claims           POST /v1/p/:project/claims
 *   GET  /v1/p/:project/claims/:id
 *   POST /v1/p/:project/claims/release   POST /v1/p/:project/claims/check
 *   POST /v1/p/:project/messages         GET  /v1/p/:project/inbox
 *   GET  /v1/p/:project/decisions        POST /v1/p/:project/decisions
 *   POST /v1/p/:project/land
 *   GET  /v1/p/:project/events?since=N&wait_ms=M   (long-poll)
 *   WS   /v1/p/:project/feed?agent=A&since=N       (push feed + heartbeats)
 *
 * The caller's identity travels in the `x-hub-agent` header (WebSocket: the
 * `agent` query parameter). Phase 1 trusts it; see README "Security".
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { hub } = opts;
  const maxWaitMs = opts.maxWaitMs ?? 600_000;
  const routes = buildRoutes(hub, maxWaitMs);

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, now: hub.now() });
    }
    if (!authorized(req.headers.authorization, opts.token)) {
      throw new HubError('unauthorized', 'missing or wrong bearer token', 401);
    }
    const m = /^\/v1\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!m) throw new HubError('not_found', `no route for ${req.method} ${url.pathname}`, 404);
    const project = safeDecode(m[1]);
    const rest = m[2];
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const pm = route.pattern.exec(rest);
      if (!pm) continue;
      const agentHeader = req.headers['x-hub-agent'];
      const agent = typeof agentHeader === 'string' && agentHeader.length > 0 ? agentHeader : null;
      if (agent !== null) assertAgent(agent);
      const body = req.method === 'POST' ? await readJson(req) : {};
      const ctx: RequestContext = { req, res, project, params: pm.slice(1).map(safeDecode), query: url.searchParams, agent, body };
      const result = await route.handler(ctx);
      if (!res.headersSent) sendJson(res, 200, result);
      return;
    }
    throw new HubError('not_found', `no route for ${req.method} ${url.pathname}`, 404);
  }

  // ---- WebSocket push feed
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const sockets = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://hub.local');
      const m = /^\/v1\/p\/([^/]+)\/feed$/.exec(url.pathname);
      if (!m) throw new HubError('not_found', 'no such feed', 404);
      if (!authorized(req.headers.authorization, opts.token)) throw new HubError('unauthorized', 'missing or wrong bearer token', 401);
      const project = safeDecode(m[1]);
      hub.latestSeq(project); // validates the project id
      const agentParam = url.searchParams.get('agent') ?? (req.headers['x-hub-agent'] as string | undefined) ?? null;
      if (agentParam !== null) assertAgent(agentParam);
      const since = Number(url.searchParams.get('since') ?? NaN);
      wss.handleUpgrade(req, socket, head, (ws) => onFeed(ws, project, agentParam, Number.isFinite(since) ? since : null));
    } catch (err) {
      const status = err instanceof HubError ? err.status : 400;
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Request'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  });

  function onFeed(ws: WebSocket, project: string, agent: string | null, since: number | null): void {
    sockets.add(ws);
    let alive = true;
    const send = (frame: FeedServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    // Subscribe before replaying so nothing committed in between is lost; the
    // client de-duplicates by seq.
    let lastSent = since ?? hub.latestSeq(project);
    const deliver = (event: HubEvent) => {
      if (event.project !== project || event.seq <= lastSent || !isVisibleTo(event, agent)) return;
      lastSent = event.seq;
      send({ type: 'event', event });
    };
    const unsubscribe = hub.subscribe(deliver);
    send({ type: 'hello', project, agent, seq: hub.latestSeq(project), now: hub.now(), heartbeat_interval_ms: hub.heartbeatIntervalMs });
    if (since !== null) {
      for (const event of hub.events(project, agent, since)) deliver(event);
    }
    if (agent) {
      try {
        hub.heartbeat(project, agent);
      } catch {
        // presence is best effort
      }
    }
    ws.on('pong', () => {
      alive = true;
    });
    const keepalive = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    keepalive.unref();
    ws.on('message', (raw) => {
      let frame: FeedClientFrame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return send({ type: 'error', code: 'bad_frame', message: 'frames must be JSON' });
      }
      try {
        if (frame.type === 'ping') return send({ type: 'pong', now: hub.now() });
        if (frame.type === 'heartbeat') {
          if (!agent) return send({ type: 'error', code: 'bad_agent', message: 'connect with ?agent=human/agent to heartbeat' });
          const r = hub.heartbeat(project, agent, frame);
          return send({ type: 'heartbeat.ack', renewed: r.renewed, next_heartbeat_ms: r.next_heartbeat_ms, now: r.now });
        }
        send({ type: 'error', code: 'bad_frame', message: 'unknown frame type' });
      } catch (err) {
        const e = toApiError(err);
        send({ type: 'error', code: e.code, message: e.message });
      }
    });
    ws.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
      sockets.delete(ws);
    });
  }

  // ---- lease sweeper: expires claims whose heartbeats stopped and pushes the events
  const sweeper = setInterval(() => {
    try {
      hub.sweep();
    } catch (err) {
      console.error('[hub] sweep failed:', err);
    }
  }, opts.sweepIntervalMs ?? 1000);
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7077, opts.host ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const host = opts.host && opts.host !== '0.0.0.0' && opts.host !== '::' ? opts.host : '127.0.0.1';

  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    port,
    hub,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        for (const ws of sockets) ws.terminate();
        wss.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function buildRoutes(hub: Hub, maxWaitMs: number): Route[] {
  const r = (method: Route['method'], path: string, handler: Handler): Route => ({
    method,
    pattern: new RegExp(`^${path.replace(/:[a-z_]+/g, '([^/]+)')}$`),
    handler,
  });
  const me = (ctx: RequestContext): string => {
    if (!ctx.agent) throw new HubError('bad_agent', 'send your agent id (human/agent) in the x-hub-agent header', 400);
    return ctx.agent;
  };

  return [
    r('GET', '/status', (c) => hub.status(c.project, c.agent)),
    r('POST', '/heartbeat', (c) => hub.heartbeat(c.project, me(c), c.body)),

    r('GET', '/tasks', (c) => ({ tasks: hub.listTasks(c.project) })),
    r('POST', '/tasks', (c) => ({ task: hub.createTask(c.project, me(c), c.body as any) })),
    r('POST', '/tasks/:id/take', (c) => ({ task: hub.takeTask(c.project, me(c), c.params[0]) })),
    r('POST', '/tasks/:id/update', (c) => hub.updateTask(c.project, me(c), c.params[0], c.body.status as TaskStatus)),

    r('GET', '/claims', (c) => ({
      claims: hub.listClaims(c.project, {
        holder: c.query.get('holder') ?? undefined,
        file: c.query.get('file') ?? undefined,
        include_ended: c.query.get('include_ended') === '1',
      }),
    })),
    r('POST', '/claims', (c) => hub.claim(c.project, me(c), c.body)),
    r('POST', '/claims/release', (c) => hub.release(c.project, me(c), c.body)),
    r('POST', '/claims/check', (c) => hub.check(c.project, c.agent, Array.isArray(c.body.files) ? c.body.files : [])),
    r('GET', '/claims/:id', (c) => ({ claim: hub.getClaim(c.project, c.params[0]) })),

    r('POST', '/messages', (c) => ({ message: hub.post(c.project, me(c), c.body as any) })),
    r('GET', '/inbox', (c) =>
      hub.inbox(c.project, me(c), { peek: c.query.get('peek') === '1', limit: c.query.has('limit') ? Number(c.query.get('limit')) : undefined }),
    ),

    r('GET', '/decisions', (c) => ({ decisions: hub.listDecisions(c.project, c.query.has('limit') ? Number(c.query.get('limit')) : 20) })),
    r('POST', '/decisions', (c) => ({ decision: hub.decide(c.project, me(c), c.body as any) })),

    r('POST', '/land', (c) => hub.land(c.project, me(c), c.body)),

    r('GET', '/events', (c) => longPollEvents(hub, c, maxWaitMs)),
  ];
}

/** Returns visible events after `since`; if none, waits up to `wait_ms` for one. */
function longPollEvents(hub: Hub, c: RequestContext, maxWaitMs: number): Promise<unknown> | unknown {
  const since = Number(c.query.get('since') ?? hub.latestSeq(c.project));
  if (!Number.isFinite(since)) throw new HubError('bad_request', 'since must be a number');
  const waitMs = Math.min(maxWaitMs, Math.max(0, Number(c.query.get('wait_ms') ?? 0) || 0));
  const types = c.query.get('types')?.split(',').filter(Boolean);
  const pick = () => hub.events(c.project, c.agent, since).filter((e) => !types || types.includes(e.type));
  const now = pick();
  if (now.length > 0 || waitMs === 0) return { events: now, seq: hub.latestSeq(c.project) };

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ events: pick(), seq: hub.latestSeq(c.project) });
    };
    const unsubscribe = hub.subscribe((e) => {
      if (e.project === c.project && isVisibleTo(e, c.agent) && (!types || types.includes(e.type))) finish();
    });
    const timer = setTimeout(finish, waitMs);
    // The response closes when the client goes away; stop waiting then.
    c.res.on('close', finish);
  });
}

function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  const given = /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HubError('too_large', 'request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HubError('bad_json', 'request body must be a JSON object');
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HubError('bad_request', 'bad URL encoding');
  }
}

function toApiError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof HubError) return { status: err.status, code: err.code, message: err.message };
  console.error('[hub] internal error:', err);
  return { status: 500, code: 'internal', message: 'internal error' };
}

function sendError(res: ServerResponse, err: unknown): void {
  const e = toApiError(err);
  if (res.headersSent) return void res.end();
  sendJson(res, e.status, { error: { code: e.code, message: e.message } });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
