import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { Hub, HubError, assertAgent, isVisibleTo } from './hub.js';
import type { EventsResult, FeedClientFrame, FeedServerFrame, HubEvent, TaskStatus } from './protocol.js';

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
  /**
   * Browser origins (`scheme://host[:port]`) allowed to call the hub. HTTP
   * requests and feed upgrades that carry any other `Origin` header are refused
   * with 403, so a web page can't reach a hub on localhost through the
   * developer's browser. Node clients send no Origin. Default: none.
   */
  allowOrigins?: string[];
  /**
   * Host names, besides IP addresses, `localhost`, `*.localhost` and `host`,
   * that requests may be addressed to (the `Host` header). Anything else is
   * refused with 403, which stops a web page that rebinds its own domain to
   * the hub's address: it counts as same-origin, so it sends no Origin header.
   * A hub listening on loopback always checks Host. One listening on a network
   * address is reached by whatever names that network gives it, so it checks
   * Host only when this list is non-empty.
   */
  allowHosts?: string[];
}

export interface RunningServer {
  url: string;
  port: number;
  hub: Hub;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;
/** A feed replays missed events this many at a time, letting other requests run in between. */
const REPLAY_PAGE = 500;
/** ...and waits while more than this much of the replay is still waiting to be sent to the client. */
const MAX_REPLAY_BUFFERED = 1_000_000;
/** New events a feed holds back while it replays; a client that falls this far behind is dropped. */
const MAX_HELD_EVENTS = 10_000;

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
  const allowedOrigins = new Set((opts.allowOrigins ?? []).map(toOrigin));
  const allowedHosts = new Set((opts.allowHosts ?? []).map(toHostname));
  const bindName = opts.host && isIP(opts.host) === 0 ? hostnameOf(opts.host) : null;
  if (bindName !== null) allowedHosts.add(bindName);
  // Settled once listening: on for a loopback address or an explicit allowlist.
  let hostCheck = true;

  /** Throws unless the request has no Origin or an allowed one; returns the allowed origin. */
  function checkOrigin(req: IncomingMessage): string | null {
    // Sec-WebSocket-Origin is what browsers sent before RFC 6455 renamed it Origin.
    for (const origin of [req.headers.origin, req.headers['sec-websocket-origin'] as string | undefined]) {
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        throw new HubError('forbidden_origin', `requests from origin ${JSON.stringify(origin)} are not allowed (see hub-server --allow-origin)`, 403);
      }
    }
    return req.headers.origin ?? null;
  }

  /** Throws unless the Host header is an IP address, a localhost name or an allowed name: none of these can be rebound. */
  function checkHost(req: IncomingMessage): void {
    const header = req.headers.host;
    if (!hostCheck || header === undefined) return;
    const name = hostnameOf(header);
    if (name !== null && (isIP(name.replace(/^\[(.*)\]$/, '$1')) !== 0 || name === 'localhost' || name.endsWith('.localhost') || allowedHosts.has(name))) return;
    const fix = name !== null && HOSTNAME.test(name) ? ` If clients use this name in their hub URL, restart the hub with: hub-server --allow-host ${name}` : ' Names clients use in their hub URL are allowed with hub-server --allow-host <name>';
    throw new HubError(
      'forbidden_host',
      `requests for host ${JSON.stringify(name ?? header)} are not allowed: this hub answers only to IP addresses, localhost, its --host name and names given with --allow-host, ` +
        `so web pages can't reach it through DNS rebinding.${fix} (Docker Desktop containers, for example, need --allow-host host.docker.internal).`,
      403,
    );
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    checkHost(req);
    const origin = checkOrigin(req);
    if (origin !== null) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'authorization, content-type, x-hub-agent', 'access-control-max-age': '600' });
        return void res.end();
      }
    }
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
  wss.on('error', (err) => console.error('[hub] feed server error:', err));
  const sockets = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    // Node takes its own 'error' listener off the socket before emitting
    // 'upgrade'. Without this one, a client that resets the connection while a
    // refusal is being written (EPIPE, ECONNRESET) would crash the hub.
    socket.on('error', () => {});
    try {
      checkHost(req);
      checkOrigin(req);
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
      // Same error envelope as HTTP, so a client can show why the feed was refused.
      const e = err instanceof HubError ? err : new HubError('bad_request', 'bad feed request');
      const body = JSON.stringify({ error: { code: e.code, message: e.message } });
      socket.once('finish', () => socket.destroy());
      socket.end(
        `HTTP/1.1 ${e.status} ${STATUS_CODES[e.status] ?? 'Bad Request'}\r\nConnection: close\r\n` +
          `Content-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    }
  });

  function onFeed(ws: WebSocket, project: string, agent: string | null, since: number | null): void {
    // ws reports a frame it rejects (over maxPayload, unmasked, bad UTF-8, bad
    // opcode...) as 'error' and then closes the connection itself with the
    // matching status code. Without a listener the error would crash the hub.
    ws.on('error', (err) => console.error(`[hub] feed connection dropped: ${err.message}`));
    sockets.add(ws);
    let alive = true;
    const send = (frame: FeedServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    // Subscribe before replaying so nothing committed in between is lost; the
    // client de-duplicates by seq. A since past the latest seq is from another
    // database (the client sees a new epoch in hello), so the feed starts now.
    const latest = hub.latestSeq(project);
    let lastSent = Math.min(since ?? latest, latest);
    // While the missed events are replayed, new ones wait here, so they go out in seq order after them.
    let held: HubEvent[] | null = since !== null ? [] : null;
    const deliver = (event: HubEvent) => {
      if (event.project !== project || event.seq <= lastSent || !isVisibleTo(event, agent)) return;
      if (held) {
        // A client that reads nothing while a long replay runs is dropped; it reconnects with its since.
        if (held.length >= MAX_HELD_EVENTS) return ws.terminate();
        held.push(event);
        return;
      }
      lastSent = event.seq;
      send({ type: 'event', event });
    };
    const unsubscribe = hub.subscribe(deliver);
    send({ type: 'hello', project, agent, seq: latest, epoch: hub.epoch, now: hub.now(), heartbeat_interval_ms: hub.heartbeatIntervalMs });
    if (since !== null) {
      // Everything missed, however much, past any number of events this agent can't
      // see: a bounded read at a time, letting other requests run in between and the
      // socket drain, so a long replay holds up neither the hub nor its memory.
      void (async () => {
        let cursor = lastSent;
        for (;;) {
          if (ws.readyState !== ws.OPEN) return;
          const page = hub.readEvents(project, agent, cursor, { limit: REPLAY_PAGE });
          for (const event of page.events) {
            lastSent = event.seq;
            send({ type: 'event', event });
          }
          cursor = page.next_since;
          if (page.end) break;
          await new Promise<void>((resolve) => setImmediate(resolve));
          while (ws.readyState === ws.OPEN && ws.bufferedAmount > MAX_REPLAY_BUFFERED) await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        const waiting = held ?? [];
        held = null;
        for (const event of waiting) deliver(event);
        // The cursor to reconnect from: past every event read, those this agent can't see included.
        send({ type: 'replayed', next_since: Math.max(lastSent, cursor) });
      })().catch((err) => {
        console.error('[hub] feed replay failed:', err);
        ws.terminate();
      });
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

  // ---- lease sweeper: expires claims whose heartbeats stopped and pushes the
  // events, along with those other hub processes on the same database committed
  const sweeper = setInterval(() => {
    try {
      hub.sweep();
      hub.catchUp();
    } catch (err) {
      console.error('[hub] sweep failed:', err);
    }
  }, opts.sweepIntervalMs ?? 1000);
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7077, opts.host ?? '127.0.0.1', () => resolve());
  });
  const { port, address } = server.address() as AddressInfo;
  hostCheck = isLoopback(address) || (opts.allowHosts ?? []).length > 0;
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
    r('POST', '/claims/check', (c) => hub.check(c.project, c.agent, Array.isArray(c.body.files) ? c.body.files : [], c.body.mode ?? undefined)),
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
function longPollEvents(hub: Hub, c: RequestContext, maxWaitMs: number): Promise<EventsResult> | EventsResult {
  const since = Number(c.query.get('since') ?? hub.latestSeq(c.project));
  if (!Number.isFinite(since)) throw new HubError('bad_request', 'since must be a number');
  const waitMs = Math.min(maxWaitMs, Math.max(0, Number(c.query.get('wait_ms') ?? 0) || 0));
  const types = c.query.get('types')?.split(',').filter(Boolean);
  let end = true;
  const read = (from: number): EventsResult => {
    const r = hub.readEvents(c.project, c.agent, from, { types });
    end = r.end;
    return { events: r.events, seq: hub.latestSeq(c.project), next_since: r.next_since, epoch: hub.epoch };
  };
  const now = read(since);
  // A read that stopped short of the latest event answers at once: the caller reads on from next_since.
  if (now.events.length > 0 || waitMs === 0 || !end) return now;

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      // On from where the first read stopped, past what it already passed over.
      resolve(read(now.next_since));
    };
    const unsubscribe = hub.subscribe((e) => {
      if (e.project === c.project && e.seq > now.next_since && isVisibleTo(e, c.agent) && (!types || types.includes(e.type))) finish();
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

/** Normalizes an allowlist entry to the form browsers send in `Origin`. */
function toOrigin(s: string): string {
  let url: URL | null = null;
  try {
    url = new URL(s);
  } catch {
    // reported below
  }
  if (!url || url.origin === 'null' || url.href !== `${url.origin}/`) {
    throw new Error(`allowed origin ${JSON.stringify(s)} is not an origin; expected scheme://host[:port], e.g. https://dash.example.com`);
  }
  return url.origin;
}

/** Whether a listening address only accepts connections from this machine (`0.0.0.0` and `::` don't). */
function isLoopback(address: string): boolean {
  const v4 = address.replace(/^::ffff:/i, '');
  return isIP(v4) === 4 ? v4.startsWith('127.') : address === '::1';
}

/** The lowercased host name in a `Host` header (`name[:port]`), or null if it is something else. */
function hostnameOf(header: string): string | null {
  let url: URL;
  try {
    url = new URL(`http://${header}`);
  } catch {
    return null;
  }
  return url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '' ? url.hostname : null;
}

/** A lowercased host name that `--allow-host` accepts. */
const HOSTNAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

/** Normalizes a host allowlist entry, which must be a bare name: no scheme, port or wildcard. */
function toHostname(s: string): string {
  const name = /^[^:/?#@\\[\]]+$/.test(s) ? hostnameOf(s) : null;
  if (name === null || !HOSTNAME.test(name)) {
    throw new Error(`allowed host ${JSON.stringify(s)} is not a host name; expected a bare name such as hub.example.com`);
  }
  return name;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HubError('bad_request', 'bad URL encoding');
  }
}

function toApiError(err: unknown): { status: number; code: string; message: string; details?: Record<string, unknown> } {
  if (err instanceof HubError) return { status: err.status, code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) };
  console.error('[hub] internal error:', err);
  return { status: 500, code: 'internal', message: 'internal error' };
}

function sendError(res: ServerResponse, err: unknown): void {
  const e = toApiError(err);
  if (res.headersSent) return void res.end();
  sendJson(res, e.status, { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
