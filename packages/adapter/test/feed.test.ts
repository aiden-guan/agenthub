import { createServer, type IncomingMessage } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub, SqliteStore, startServer, type RunningServer } from '@agenthub/hub';
import type { HubEvent } from '@agenthub/hub/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HubClient } from '../src/client.js';
import type { HubConfig } from '../src/config.js';
import { Feed } from '../src/feed.js';
import { createMcpServer } from '../src/mcp.js';
import { A, B, PROJECT, client, makeRepo, sleep, type SampleRepo } from './helpers.js';

let repo: SampleRepo;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(() => {
  repo = makeRepo();
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(() => repo.cleanup());

/** A real hub on a random port (or `port`, to bring one back where it was), closed after the test. */
async function hubAt(opts: { leaseTtlMs?: number; hub?: Hub; port?: number } = {}): Promise<RunningServer> {
  const hub = opts.hub ?? new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: opts.leaseTtlMs });
  const srv = await startServer({ hub, port: opts.port ?? 0, sweepIntervalMs: 25 });
  let closed = false;
  const close = srv.close;
  srv.close = async () => {
    if (closed) return;
    closed = true;
    await close();
  };
  cleanups.push(() => srv.close());
  return srv;
}

/** `hub mcp` as runMcp builds it (the heartbeat period comes from the hub), driven over an in-memory transport. */
async function mcpFor(url: string, agent: string) {
  const cfg: HubConfig = { url, agent, project: PROJECT, token: null, failClosed: false, timeoutMs: 3000, root: repo.wtA, configFiles: [], projectSource: 'env', warnings: [] };
  const hubClient = new HubClient(cfg);
  const logs: string[] = [];
  const feed = new Feed(hubClient, { info: { client: 'mcp' }, log: (m) => logs.push(m) });
  feed.start();
  const server = createMcpServer({ cfg, client: hubClient, feed, cwd: repo.wtA });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'test', version: '0' });
  await mcp.connect(clientSide);
  cleanups.push(async () => {
    feed.stop();
    await mcp.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return res.content.map((c) => c.text).join('\n');
  };
  return { call, feed, logs, client: hubClient };
}

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(25);
  }
}

/**
 * A TCP proxy in front of a hub. freeze() black-holes the WebSocket
 * connections open right now: nothing passes either way and no FIN or RST is
 * passed on, as when NAT state is lost. reset() sends an RST to their client
 * side. New connections go through normally.
 */
async function proxyTo(port: number) {
  const pairs = new Set<{ client: net.Socket; upstream: net.Socket; ws: boolean; frozen: boolean }>();
  const server = net.createServer((client) => {
    const upstream = net.connect(port, '127.0.0.1');
    const pair = { client, upstream, ws: false, frozen: false };
    pairs.add(pair);
    client.on('data', (d) => {
      if (/^upgrade: websocket/im.test(String(d))) pair.ws = true;
      if (!pair.frozen) upstream.write(d);
    });
    upstream.on('data', (d) => {
      if (!pair.frozen) client.write(d);
    });
    client.on('close', () => {
      pairs.delete(pair);
      if (!pair.frozen) upstream.destroy();
    });
    upstream.on('close', () => {
      if (!pair.frozen) client.destroy();
    });
    client.on('error', () => {});
    upstream.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxy = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    freeze: () => {
      for (const p of pairs) if (p.ws) p.frozen = true;
    },
    reset: () => {
      for (const p of pairs) {
        if (!p.ws) continue;
        p.frozen = true;
        p.client.resetAndDestroy();
        p.upstream.destroy();
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const p of pairs) {
          p.client.destroy();
          p.upstream.destroy();
        }
        server.close(() => resolve());
      }),
  };
  cleanups.push(proxy.close);
  return proxy;
}

describe('feed heartbeat period', () => {
  it("heartbeats as often as the hub's acks ask, so a claim with a TTL shorter than the hub's interval stays alive", async () => {
    // TTL 6 s: the hub announces 1500 ms. A raw-API claim with ttl_ms 1200 needs a heartbeat every 400 ms.
    const srv = await hubAt({ leaseTtlMs: 6000 });
    const raw = client(srv.url, A);
    const claim = (await raw.claim({ files: ['src/auth.ts'], intent: 'short lease', ttl_ms: 1200 })).claim!;
    expect(claim.heartbeat_interval_ms).toBe(400);
    const { feed } = await mcpFor(srv.url, A);
    await until(() => feed.connected);
    await sleep(2500);
    expect((await raw.getClaim(claim.id)).status).toBe('active');
  });

  it('follows the heartbeat result over HTTP when the WebSocket never connects', async () => {
    // TTL 3 s: the hub wants a heartbeat every 750 ms, but without a hello the feed used to wait 30 s.
    const srv = await hubAt({ leaseTtlMs: 3000 });
    const raw = client(srv.url, A);
    const claim = (await raw.claim({ files: ['src/http.ts'], intent: 'http only' })).claim!;
    const broken = Object.create(raw) as HubClient;
    broken.feedUrl = () => 'ws://127.0.0.1:9/feed';
    const feed = new Feed(broken, { info: { client: 'mcp' } });
    feed.start();
    cleanups.push(() => feed.stop());
    await sleep(4500);
    expect(feed.connected).toBe(false);
    expect((await raw.getClaim(claim.id)).status).toBe('active');
  });

  it("learns the interval of a claim made elsewhere (the edit hook's process) from the next answer, sent at once", async () => {
    const srv = await hubAt({ leaseTtlMs: 6000 });
    const { feed } = await mcpFor(srv.url, A);
    await until(() => feed.connected && feed.heartbeatsSent >= 1);
    const other = client(srv.url, A); // the same agent, another process
    const claim = (await other.claim({ files: ['src/hook.ts'], intent: 'edit', ttl_ms: 900 })).claim!;
    await sleep(2500);
    expect((await other.getClaim(claim.id)).status).toBe('active');
  });

  it('heartbeats at once at the interval of a claim it was just given', async () => {
    const srv = await hubAt({ leaseTtlMs: 6000 });
    const raw = client(srv.url, A);
    const feed = new Feed(raw, { info: { client: 'mcp' } });
    feed.start();
    cleanups.push(() => feed.stop());
    await until(() => feed.connected && feed.heartbeatsSent >= 1);
    // The next heartbeat is 1.5 s away, but this lease lasts only 900 ms.
    const res = await raw.claim({ files: ['src/fast.ts'], intent: 'fast', ttl_ms: 900 });
    feed.noteClaims([res.claim!]);
    await sleep(2500);
    expect((await raw.getClaim(res.claim!.id)).status).toBe('active');
  });
});

describe('feed liveness', () => {
  it('notices a half-open socket: heartbeats go over HTTP, the claim survives, hub_wait still wakes and the feed reconnects', async () => {
    const srv = await hubAt({ leaseTtlMs: 3000 }); // heartbeat every 750 ms
    const proxy = await proxyTo(srv.port);
    const a = await mcpFor(proxy.url, A);
    await until(() => a.feed.connected);
    expect(await a.call('claim', { files: ['src/auth.ts'], intent: 'long edit' })).toMatch(/^Granted (C-\d+)/);
    const mine = (await client(srv.url, A).status()).claims.find((c) => c.holder === A)!;
    const theirs = (await client(srv.url, B).claim({ files: ['src/users.ts'], intent: 'B holds it' })).claim!;
    await sleep(300);

    proxy.freeze();
    const t0 = Date.now();
    const waiting = a.call('hub_wait', { files: ['src/users.ts'], timeout_s: 10 });
    setTimeout(() => void client(srv.url, B).release({ claim_id: theirs.id }), 500);
    const woke = await waiting;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(woke).toMatch(/Woke up after: sam\/claude-1 released C-\d+ \(src\/users\.ts\)/);

    await sleep(Math.max(0, 4500 - (Date.now() - t0))); // past the 3 s TTL since the freeze
    expect((await client(srv.url, A).getClaim(mine.id)).status).toBe('active');
    await until(() => a.feed.connected);
    expect(a.logs.join('\n')).toMatch(/stopped answering/);
  });

  it('logs a feed connection that drops after it opened, even when the reconnect succeeds at once', async () => {
    const srv = await hubAt();
    const proxy = await proxyTo(srv.port);
    const a = await mcpFor(proxy.url, A);
    await until(() => a.feed.connected);
    proxy.reset();
    await until(() => !a.feed.connected);
    await until(() => a.feed.connected);
    expect(a.logs.join('\n')).toMatch(/hub feed connection lost[\s\S]*hub feed reconnected/);
  });

  it("tells the agent in its next tool result when one of its leases expired while it wasn't heartbeating", async () => {
    const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 1000 });
    let srv = await hubAt({ hub });
    const port = srv.port;
    const a = await mcpFor(srv.url, A);
    await until(() => a.feed.connected);
    const id = /^Granted (C-\d+)/.exec(await a.call('claim', { files: ['src/auth.ts'], intent: 'long edit' }))![1];

    await srv.close(); // the hub is down for longer than the lease, then comes back on the same database
    await sleep(1500);
    srv = await hubAt({ hub, port });
    await until(() => a.feed.connected);
    await until(async () => (await client(srv.url, A).getClaim(id)).status === 'expired');
    await sleep(300);

    const status = await a.call('hub_status');
    expect(status).toContain(`your claim ${id} (src/auth.ts) expired (lease expired: heartbeats stopped)`);
    expect(status).toMatch(/Claim them again before you edit them/);
    expect(a.logs.join('\n')).toContain(`lost claim ${id} (src/auth.ts)`);
    expect(await a.call('hub_status')).not.toContain(`your claim ${id}`);
  });

  it('notices a lost lease from the HTTP heartbeat answers when the WebSocket never connects', async () => {
    const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 1000 });
    let srv = await hubAt({ hub });
    const port = srv.port;
    const raw = client(srv.url, A);
    const broken = Object.create(raw) as HubClient;
    broken.feedUrl = () => 'ws://127.0.0.1:9/feed';
    const feed = new Feed(broken, { info: { client: 'mcp' } });
    feed.start();
    cleanups.push(() => feed.stop());
    const res = await raw.claim({ files: ['src/http.ts'], intent: 'http only' });
    feed.noteClaims(res.claims);
    await sleep(500);

    await srv.close();
    await sleep(1500);
    srv = await hubAt({ hub, port });
    const notices: string[] = [];
    await until(() => (notices.push(...feed.takeNotices()), notices.length > 0));
    expect(notices).toEqual([`your claim ${res.claim!.id} (src/http.ts) expired (lease expired: heartbeats stopped), so other agents can claim those files now. Claim them again before you edit them.`]);
  });
});

describe('feed after the hub comes back with a fresh database', () => {
  it('drops the old history, hears the new hub and says the claims are gone', async () => {
    let srv = await hubAt();
    const port = srv.port;
    const a = await mcpFor(srv.url, A);
    await until(() => a.feed.connected);
    const old = await a.call('claim', { files: ['src/auth.ts'], intent: 'before the reset' });
    const oldId = /^Granted (C-\d+)/.exec(old)![1];
    const b = client(srv.url, B);
    for (let i = 0; i < 10; i++) {
      const c = (await b.claim({ files: [`gen/f${i}.ts`], intent: 'busy' })).claim!;
      await b.release({ claim_id: c.id });
    }
    await until(() => a.feed.lastSeq >= 20);

    await srv.close();
    srv = await hubAt({ port }); // same URL, empty database
    await until(() => a.feed.connected);
    await until(() => a.feed.lastSeq < 20);

    // No phantom wake-ups from the old hub's events...
    const t0 = Date.now();
    const quiet = await a.call('hub_wait', { timeout_s: 1 });
    expect(quiet).toMatch(/^Nothing relevant happened in 1s\./);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    // Said by the reconnecting feed, or by an HTTP heartbeat that reached the new hub first.
    expect(quiet).toMatch(new RegExp(`the claims this session held there are gone: ${oldId} \\(src/auth\\.ts\\)|your claim ${oldId} \\(src/auth\\.ts\\) is gone`));

    // ...and the new hub's events get through.
    const b2 = client(srv.url, B);
    const held = (await b2.claim({ files: ['src/y.ts'], intent: 'on the new hub' })).claim!;
    const waiting = a.call('hub_wait', { files: ['src/y.ts'], timeout_s: 8 });
    setTimeout(() => void b2.release({ claim_id: held.id }), 300);
    const t1 = Date.now();
    const woke = await waiting;
    expect(Date.now() - t1).toBeLessThan(4000);
    expect(woke).toMatch(new RegExp(`Woke up after: sam/claude-1 released ${held.id} \\(src/y\\.ts\\)`));
    expect(woke).not.toContain('gone');
  });

  /** A hub whose history is well past what a fresh one has, with B holding src/y.ts. */
  async function busyHub() {
    const srv = await hubAt();
    const a = await mcpFor(srv.url, A);
    await until(() => a.feed.connected);
    const b = client(srv.url, B);
    for (let i = 0; i < 20; i++) {
      const c = (await b.claim({ files: [`gen/f${i}.ts`], intent: 'busy' })).claim!;
      await b.release({ claim_id: c.id });
    }
    await b.claim({ files: ['src/y.ts'], intent: 'B holds y' });
    return { srv, a };
  }

  it('ends a hub_wait on files when the hub comes back on a fresh database, which has no claims on them', async () => {
    const { srv, a } = await busyHub();
    const t0 = Date.now();
    const waiting = a.call('hub_wait', { files: ['src/y.ts'], timeout_s: 10 });
    await sleep(300);
    await srv.close();
    await hubAt({ port: srv.port });
    const woke = await waiting;
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(woke).toMatch(/^The hub came back with a different database while you waited; the claims it had are gone\.\nsrc\/y\.ts is free of other agents' claims now\./);
  });

  it("ends a hub_wait on a queued claim when the hub comes back on a fresh database, even where someone else's claim reuses its id", async () => {
    const { srv, a } = await busyHub();
    const id = /Queued as (C-\d+)/.exec(await a.call('claim', { files: ['src/y.ts'], intent: 'A needs y' }))![1];
    const t0 = Date.now();
    const waiting = a.call('hub_wait', { claim_id: id, timeout_s: 8 });
    await sleep(300);
    await srv.close();
    const srv2 = await hubAt({ port: srv.port });
    const b = client(srv2.url, B);
    for (let i = 0; i < Number(id.slice(2)); i++) await b.claim({ files: [`other/b${i}.ts`], intent: "B's own work" });
    expect((await b.getClaim(id)).holder).toBe(B);
    const woke = await waiting;
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(woke).toMatch(new RegExp(`^The hub came back with a different database while you waited, so your queued claim ${id} is gone\\. Claim again if you still need it\\.`));
    expect(woke).not.toContain('is granted');
  });
});

/** A stand-in hub feed: answers each WebSocket with what `hello` returns for that connection, and GET /events with `events` (never, for null). */
async function fakeFeedHub(opts: {
  hello: (n: number, since: string | null) => Record<string, unknown>;
  onOpen?: (ws: WebSocket, n: number) => void;
  events?: (since: string | null) => Record<string, unknown> | null;
}) {
  const sinces: Array<string | null> = [];
  const polled: Array<string | null> = [];
  const http = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    req.resume();
    if (url.pathname.endsWith('/events') && opts.events) {
      polled.push(url.searchParams.get('since'));
      const page = opts.events(url.searchParams.get('since'));
      if (page) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
      return;
    }
    if (url.pathname.endsWith('/heartbeat')) {
      fake.onHeartbeat();
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ renewed: 0, claims: [], next_heartbeat_ms: 30_000, now: Date.now(), seq: 0 }));
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'not_found', message: 'no' } }));
  });
  const wss = new WebSocketServer({ server: http });
  const sockets = new Set<WebSocket>();
  wss.on('connection', (ws, req) => {
    sockets.add(ws);
    const since = new URL(req.url ?? '/', 'http://fake').searchParams.get('since');
    sinces.push(since);
    ws.send(JSON.stringify({ type: 'hello', project: PROJECT, agent: A, now: Date.now(), heartbeat_interval_ms: 30_000, ...opts.hello(sinces.length, since) }));
    opts.onOpen?.(ws, sinces.length);
    ws.on('message', () => ws.send(JSON.stringify({ type: 'heartbeat.ack', renewed: 0, next_heartbeat_ms: 30_000, now: Date.now() })));
    ws.on('close', () => sockets.delete(ws));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const fake = {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    onHeartbeat: () => {},
    sinces,
    polled,
    dropAll: () => {
      for (const ws of sockets) ws.terminate();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of sockets) ws.terminate();
        wss.close();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
  cleanups.push(fake.close);
  return fake;
}

const message = (seq: number): HubEvent => ({
  seq,
  project: PROJECT,
  type: 'message.posted',
  actor: B,
  at: Date.now(),
  data: { message_id: seq, from: B, to: null, channel: '#general' },
  targets: null,
});

describe('feed epochs and cursors', () => {
  it("resets when the hello's epoch changes even if its seq didn't go back, and reconnects from the new cursor when its own was ahead", async () => {
    const hellos: Array<Record<string, unknown>> = [
      { epoch: 'db-1', seq: 5 },
      { epoch: 'db-2', seq: 10 }, // new database, seq happens to be higher
      { epoch: 'db-3', seq: 2 }, // new database, behind the feed's cursor
      { epoch: 'db-3', seq: 2 },
    ];
    const fake = await fakeFeedHub({
      hello: (n) => hellos[Math.min(n, hellos.length) - 1],
      onOpen: (ws, n) => {
        if (n === 1) ws.send(JSON.stringify({ type: 'event', event: message(6) }));
      },
    });
    const feed = new Feed(client(fake.url, A), { info: { client: 'mcp' } });
    feed.start();
    cleanups.push(() => feed.stop());
    await until(() => feed.lastSeq === 6);
    expect((await feed.waitFor(0, () => true, 50)).events).toHaveLength(1);

    fake.dropAll();
    await until(() => fake.sinces.length === 2 && feed.connected);
    expect(fake.sinces[1]).toBe('6');
    expect(feed.lastSeq).toBe(10);
    expect((await feed.waitFor(0, () => true, 50)).events).toEqual([]); // db-1's event is gone

    fake.dropAll();
    await until(() => fake.sinces.length === 4 && feed.connected);
    expect(fake.sinces.slice(2)).toEqual(['10', '2']);
    expect(feed.lastSeq).toBe(2);
  });

  it('heartbeats over HTTP when an ack renews fewer claims than it knows of, and reports one the hub no longer has', async () => {
    let httpBeats = 0;
    const fake = await fakeFeedHub({ hello: () => ({ epoch: 'db-1', seq: 0, heartbeat_interval_ms: 200 }) });
    fake.onHeartbeat = () => httpBeats++;
    const feed = new Feed(client(fake.url, A), { info: { client: 'mcp' } });
    feed.start();
    cleanups.push(() => feed.stop());
    await until(() => feed.connected && feed.heartbeatsSent >= 2);
    const before = httpBeats;
    const claim = { id: 'C-9', project: PROJECT, holder: A, task_id: null, scope: [{ file: 'src/a.ts' }], mode: 'exclusive', intent: 'x', base_commit: null, status: 'active', created_at: 0, granted_at: 0, expires_at: 0, ttl_ms: 600, heartbeat_interval_ms: 200, ended_at: null, end_reason: null } as const;
    feed.noteClaims([{ ...claim, scope: [...claim.scope] }]);
    const notices: string[] = [];
    await until(() => (notices.push(...feed.takeNotices()), notices.length > 0), 3000);
    expect(httpBeats).toBeGreaterThan(before);
    expect(notices).toEqual(['your claim C-9 (src/a.ts) is gone (the hub no longer has it), so other agents can claim those files now. Claim them again before you edit them.']);
  });

  it('long-polls from next_since, and a new epoch ends the wait (what it waited on went with the old database)', async () => {
    const pages: Array<Record<string, unknown>> = [
      { events: [], seq: 50, next_since: 40, epoch: 'db-1' }, // nothing visible up to 40
      { events: [], seq: 60, next_since: 40, epoch: 'db-2' }, // a new database: since=40 means nothing there
      { events: [message(4)], seq: 4, next_since: 4, epoch: 'db-2' },
    ];
    const fake = await fakeFeedHub({ hello: () => ({}), events: () => pages.shift() ?? { events: [], seq: 3, epoch: 'db-2' } });
    const feed = new Feed(client(fake.url, A)); // never started: hub_wait's HTTP path
    expect(await feed.waitFor(0, (e) => e.type === 'message.posted', 5000)).toEqual({ events: [], restarted: true });
    expect(fake.polled).toEqual(['0', '40']);
    const got = await feed.waitFor(3, (e) => e.type === 'message.posted', 5000);
    expect(got).toEqual({ events: [message(4)].map((e) => ({ ...e, at: expect.any(Number) })), restarted: false });
    expect(fake.polled).toEqual(['0', '40', '3']);
  });

  it('a long-poll answer whose history ends before the cursor ends the wait too (a hub that sends no epoch)', async () => {
    const fake = await fakeFeedHub({ hello: () => ({}), events: (since) => (Number(since) < 4 ? { events: [message(4)], seq: 4 } : { events: [], seq: 3 }) });
    const feed = new Feed(client(fake.url, A));
    expect(await feed.waitFor(40, () => true, 1000)).toEqual({ events: [], restarted: true });
    expect(fake.polled).toEqual(['40']);
  });

  it("stops a long-poll that the socket's coming back makes moot", async () => {
    // GET /events never answers; the socket opens 300 ms in and brings an event.
    const fake = await fakeFeedHub({
      hello: () => ({ seq: 0 }),
      onOpen: (ws) => setTimeout(() => ws.send(JSON.stringify({ type: 'event', event: message(1) })), 50),
      events: () => null,
    });
    const raw = client(fake.url, A);
    const late = Object.create(raw) as HubClient;
    let opened = false;
    late.feedUrl = (since) => (opened ? raw.feedUrl(since) : 'ws://127.0.0.1:9/feed');
    setTimeout(() => (opened = true), 300);
    const feed = new Feed(late);
    feed.start();
    cleanups.push(() => feed.stop());
    const t0 = Date.now();
    const got = await feed.waitFor(0, () => true, 8000);
    expect(got.events.map((e) => e.seq)).toEqual([1]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('feed heartbeat period that shrinks', () => {
  it('drops a socket that left a heartbeat unanswered for half the new, shorter period', async () => {
    const srv = await hubAt({ leaseTtlMs: 8000 }); // heartbeat every 2 s
    const proxy = await proxyTo(srv.port);
    const raw = client(proxy.url, A);
    const feed = new Feed(raw, { info: { client: 'mcp' } });
    feed.start();
    cleanups.push(() => feed.stop());
    await until(() => feed.connected && feed.heartbeatsSent >= 1);
    proxy.freeze();
    const sent = feed.heartbeatsSent;
    await until(() => feed.heartbeatsSent > sent, 4000); // this one goes into the black hole
    // Answered by now on a live socket; this lease needs a heartbeat every 200 ms.
    const res = await raw.claim({ files: ['src/fast.ts'], intent: 'fast', ttl_ms: 600 });
    feed.noteClaims([res.claim!]);
    await sleep(2000);
    expect((await raw.getClaim(res.claim!.id)).status).toBe('active');
  });
});
