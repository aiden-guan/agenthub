import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Hub, SqliteStore, startServer, type FeedServerFrame, type HubEvent, type RunningServer } from '../src/index.js';

const A = 'maya/claude-1';
const B = 'sam/claude-1';
const here = path.dirname(fileURLToPath(import.meta.url));

const servers: RunningServer[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const c of cleanups.splice(0).reverse()) c(); // last in, first out: a database closes before its directory goes
});

async function start(opts: { leaseTtlMs?: number; heartbeatIntervalMs?: number; sweepIntervalMs?: number; token?: string; allowOrigins?: string[]; allowHosts?: string[]; host?: string } = {}) {
  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: opts.leaseTtlMs, heartbeatIntervalMs: opts.heartbeatIntervalMs });
  const server = await startServer({ hub, port: 0, host: opts.host, sweepIntervalMs: opts.sweepIntervalMs, token: opts.token, allowOrigins: opts.allowOrigins, allowHosts: opts.allowHosts });
  servers.push(server);
  return server;
}

/** A temporary directory, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-db-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A server with its own connection to the SQLite file `db`, as another hub process on that file would have. */
async function startOn(db: string, opts: { sweepIntervalMs?: number } = {}) {
  const store = new SqliteStore(db);
  const server = await startServer({ hub: new Hub({ store }), port: 0, sweepIntervalMs: opts.sweepIntervalMs });
  servers.push(server);
  cleanups.push(() => store.close());
  return server;
}

/** Runs the real `hub-server` CLI (built dist) on a random port with a temporary database, or with `db`. */
async function startCli(args: string[] = [], db?: string): Promise<{ url: string; port: number; child: ChildProcess; output: () => string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-cli-'));
  const child = spawn(process.execPath, [path.join(here, '..', 'bin', 'hub-server.js'), '--port', '0', '--db', db ?? path.join(dir, 'hub.db'), ...args]);
  cleanups.push(() => {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const url = await new Promise<string>((resolve, reject) => {
    const check = () => {
      // The startup report ends with the lease settings.
      const m = /listening on (http:\/\/\S+)[^]*lease ttl .*\n/.exec(out);
      if (m) resolve(m[1]);
    };
    child.stdout!.on('data', check);
    child.on('exit', (code) => reject(new Error(`hub-server exited with ${code}: ${out}`)));
  });
  return { url, port: Number(new URL(url).port), child, output: () => out };
}

/** Does a raw WebSocket handshake on the demo feed, sends `bytes` and waits for the hub to close the connection. */
async function sendRawFrame(port: number, bytes: Buffer): Promise<string> {
  const sock = connect(port, '127.0.0.1');
  sock.on('error', () => {}); // a reset is fine; only the outcome matters
  let got = '';
  sock.on('data', (d) => (got += d.toString('latin1')));
  await once(sock, 'connect');
  sock.write(
    `GET /v1/p/demo/feed HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  while (!got.includes('\r\n\r\n')) await once(sock, 'data');
  expect(got).toMatch(/^HTTP\/1\.1 101 /);
  sock.write(bytes);
  if (!sock.closed) await once(sock, 'close');
  return got;
}

/** A client-to-server frame (FIN set, masked) with a payload under 126 bytes. */
function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

/** Opens a feed socket and resolves with the HTTP status of the handshake (101 when it opened). */
function upgradeStatus(base: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/p/demo/feed?agent=${A}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('error', (err) => {
      const m = /Unexpected server response: (\d+)/.exec(err.message);
      if (m) resolve(Number(m[1]));
      else reject(err);
    });
  });
}

/** Opens a feed socket that the hub is expected to refuse; resolves with the refusal's status and body. */
function upgradeRefusal(base: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/p/demo/feed?agent=${A}`, { headers });
    ws.on('open', () => {
      ws.close();
      reject(new Error('the feed opened'));
    });
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, type: res.headers['content-type'], body }));
    });
    ws.on('error', reject);
  });
}

/** Sends a request to 127.0.0.1 with any Host header, the way a page on a rebound domain reaches the hub. */
function requestAs(port: number, host: string, route: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: route, method, headers: { ...headers, host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function api(base: string, method: string, route: string, body?: unknown, agent?: string, token?: string) {
  const res = await fetch(`${base}/v1/p/demo${route}`, {
    method,
    headers: {
      ...(agent ? { 'x-hub-agent': agent } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

function feed(base: string, agent: string, since?: number) {
  const q = new URLSearchParams({ agent, ...(since !== undefined ? { since: String(since) } : {}) });
  const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/p/demo/feed?${q}`);
  const frames: FeedServerFrame[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (raw) => {
    frames.push(JSON.parse(String(raw)));
    for (const l of listeners) l();
  });
  const events = () => frames.flatMap((f) => (f.type === 'event' ? [f.event] : []));
  const waitFor = (pred: (f: FeedServerFrame) => boolean, timeoutMs = 3000) =>
    new Promise<FeedServerFrame>((resolve, reject) => {
      const check = () => {
        const hit = frames.find(pred);
        if (hit) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve(hit);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`timed out; frames: ${JSON.stringify(frames)}`));
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  const isEvent = (type: HubEvent['type'], extra: (e: HubEvent) => boolean = () => true) => (f: FeedServerFrame) =>
    f.type === 'event' && f.event.type === type && extra(f.event);
  return { ws, frames, events, waitFor, isEvent };
}

describe('claim races over HTTP', () => {
  it('two concurrent claims on one file: exactly one is granted', async () => {
    const s = await start();
    const [a, b] = await Promise.all([
      api(s.url, 'POST', '/claims', { files: ['src/auth.ts'], intent: 'a' }, A),
      api(s.url, 'POST', '/claims', { files: ['src/auth.ts'], intent: 'b' }, B),
    ]);
    const statuses = [a.json.status, b.json.status].sort();
    expect(statuses).toEqual(['denied', 'granted']);
    const loser = a.json.status === 'denied' ? a.json : b.json;
    const winner = a.json.status === 'granted' ? A : B;
    expect(loser.conflicts[0].holder).toBe(winner);
  });

  it('thirty concurrent clients: exactly one is granted', async () => {
    const s = await start();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => api(s.url, 'POST', '/claims', { files: ['hot.ts'] }, `dev${i}/agent-${i}`)),
    );
    expect(results.filter((r) => r.json.status === 'granted')).toHaveLength(1);
    expect(results.filter((r) => r.json.status === 'denied')).toHaveLength(29);
    const { json } = await api(s.url, 'GET', '/claims');
    expect(json.claims).toHaveLength(1);
  });

  it('separate processes sharing one database: exactly one is granted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-race-'));
    try {
      const db = path.join(dir, 'hub.db');
      new SqliteStore(db).close(); // create the schema up front
      const startAt = Date.now() + 1500;
      const runs = Array.from(
        { length: 6 },
        (_, i) =>
          new Promise<{ agent: string; status: string }>((resolve, reject) => {
            const child = spawn(process.execPath, [path.join(here, 'fixtures', 'race-child.mjs'), db, `dev${i}/agent-${i}`, String(startAt)]);
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => (out += d));
            child.stderr.on('data', (d) => (err += d));
            child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`))));
          }),
      );
      const results = await Promise.all(runs);
      expect(results.filter((r) => r.status === 'granted')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'denied')).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Appends `n` events to the hub's store in one transaction, as another hub
 * process on the database would, and publishes them (to no one yet).
 */
function seedEvents(hub: Hub, n: number, event: (i: number) => Pick<HubEvent, 'type' | 'actor' | 'data' | 'targets'>): void {
  const at = hub.now();
  hub.store.transaction(() => {
    hub.store.ensureProject('demo', at);
    for (let i = 0; i < n; i++) hub.store.appendEvent({ project: 'demo', at, ...event(i) });
  });
  hub.catchUp();
}

/** A feed client that only counts what it receives, for replays too long to keep. */
function countingFeed(base: string, agent: string, since: number) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/p/demo/feed?agent=${agent}&since=${since}`);
  let events = 0;
  let lastSeq = since;
  let inOrder = true;
  const replayed = new Promise<{ events: number; lastSeq: number; inOrder: boolean; next_since: number }>((resolve, reject) => {
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw)) as FeedServerFrame;
      if (f.type === 'event') {
        events++;
        if (f.event.seq <= lastSeq) inOrder = false;
        lastSeq = f.event.seq;
      } else if (f.type === 'replayed') resolve({ events, lastSeq, inOrder, next_since: f.next_since });
    });
    ws.on('error', reject);
    ws.on('close', () => reject(new Error(`closed after ${events} events, before the replay ended`)));
  });
  return { ws, replayed };
}

describe('push feed', () => {
  it('pushes events over the WebSocket and replays missed ones after a reconnect', async () => {
    const s = await start();
    const f1 = feed(s.url, B);
    await f1.waitFor((f) => f.type === 'hello');
    await api(s.url, 'POST', '/claims', { files: ['a.ts'], intent: 'refactor a' }, A);
    const granted = await f1.waitFor(f1.isEvent('claim.granted'));
    expect(granted.type === 'event' && granted.event.data).toMatchObject({ holder: A, files: ['a.ts'], intent: 'refactor a' });
    const lastSeq = Math.max(...f1.events().map((e) => e.seq));
    f1.ws.close();

    await api(s.url, 'POST', '/claims/release', { files: ['a.ts'] }, A);
    await api(s.url, 'POST', '/decisions', { summary: 'use argon2id' }, A);

    const f2 = feed(s.url, B, lastSeq);
    await f2.waitFor(f2.isEvent('decision.recorded'));
    expect(f2.events().map((e) => e.type)).toEqual(['claim.released', 'decision.recorded']);
    f2.ws.close();
  });

  it('replays every missed event after a reconnect, however many there are', async () => {
    const s = await start();
    s.hub.claim('demo', A, { files: ['src/x.ts'] });
    const since = s.hub.latestSeq('demo');
    for (let i = 0; i < 260; i++) {
      s.hub.claim('demo', A, { files: [`f${i}.ts`] });
      s.hub.release('demo', A, { files: [`f${i}.ts`] });
    }
    s.hub.release('demo', A, { files: ['src/x.ts'] });
    const latest = s.hub.latestSeq('demo');
    expect(latest - since).toBeGreaterThan(500);

    const f = feed(s.url, B, since);
    await f.waitFor(f.isEvent('claim.released', (e) => e.seq === latest));
    const replayed = f.events().filter((e) => e.seq <= latest);
    expect(replayed.map((e) => e.seq)).toEqual(Array.from({ length: latest - since }, (_, i) => since + 1 + i));
    f.ws.close();
  });

  it('replays an event missed behind 500 direct messages between other agents', async () => {
    const s = await start();
    const C = 'lee/codex-1';
    s.hub.claim('demo', A, { files: ['src/x.ts'] });
    const since = s.hub.latestSeq('demo');
    for (let i = 0; i < 600; i++) s.hub.post('demo', A, { to: C, body: `dm ${i}` });
    s.hub.release('demo', A, { files: ['src/x.ts'] });

    const f = feed(s.url, B, since);
    const released = await f.waitFor(f.isEvent('claim.released'));
    expect(released.type === 'event' && released.event.data).toMatchObject({ holder: A, files: ['src/x.ts'] });
    expect(f.events().filter((e) => e.type === 'message.posted')).toEqual([]);
    f.ws.close();
  });

  it('replays a long missed history a part at a time, so the hub keeps answering, and then says where to resume', async () => {
    const s = await start();
    const C = 'lee/codex-1';
    const n = 120_000;
    seedEvents(s.hub, n, (i) => ({ type: 'message.posted', actor: C, data: { message_id: i + 1, from: C, to: null, channel: '#general' }, targets: null }));
    seedEvents(s.hub, 3000, (i) => ({ type: 'message.posted', actor: C, data: { message_id: n + i + 1, from: C, to: A, channel: null }, targets: [C, A] }));
    const latest = s.hub.latestSeq('demo');
    // The feeds run in this process, so a hub that stops to replay everything at once stops the clock here too.
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const feeds = [countingFeed(s.url, B, 0), countingFeed(s.url, B, 0)];
    const claim = api(s.url, 'POST', '/claims', { files: ['x.ts'] }, A);
    const done = await Promise.all(feeds.map((f) => f.replayed));
    lag.disable();
    expect((await claim).json.status).toBe('granted');
    for (const d of done) {
      expect(d.inOrder).toBe(true);
      expect(d.events).toBeGreaterThanOrEqual(n);
      // Past the direct messages B can't see, so a reconnect doesn't read them again.
      expect(d.next_since).toBeGreaterThanOrEqual(latest);
    }
    expect(lag.max / 1e6).toBeLessThan(500);
    for (const f of feeds) f.ws.close();
  }, 60_000);

  it('names the database in hello, and pushes events to a feed that resumes from a seq of a database since recreated', async () => {
    const before = await start();
    for (let i = 0; i < 30; i++) before.hub.post('demo', A, { to: B, body: `m${i}` });
    const old = feed(before.url, B);
    const oldHello = await old.waitFor((f) => f.type === 'hello');
    const lastSeq = before.hub.latestSeq('demo');
    old.ws.close();

    // The hub comes back on a fresh database, so its seqs start again below the client's.
    const after = await start();
    const f = feed(after.url, B, lastSeq);
    const hello = await f.waitFor((fr) => fr.type === 'hello');
    expect(hello).toMatchObject({ epoch: expect.stringMatching(/^\S{8,}$/) });
    expect(hello.type === 'hello' && hello.epoch).not.toBe(oldHello.type === 'hello' && oldHello.epoch);
    expect(hello.type === 'hello' && hello.seq).toBeLessThan(lastSeq);
    await api(after.url, 'POST', '/claims', { files: ['src/auth.ts'] }, A);
    const granted = await f.waitFor(f.isEvent('claim.granted'));
    expect(granted.type === 'event' && granted.event.seq).toBeLessThan(lastSeq);
    f.ws.close();

    // A long-poll from the old seq waits from the latest one and returns the next event.
    const poll = api(after.url, 'GET', `/events?since=${lastSeq}&wait_ms=5000`, undefined, B);
    setTimeout(() => void api(after.url, 'POST', '/claims/release', { files: ['src/auth.ts'] }, A), 150);
    const { json } = await poll;
    expect(json).toMatchObject({ events: [{ type: 'claim.released' }], epoch: hello.type === 'hello' && hello.epoch });
    expect(json.next_since).toBeLessThan(lastSeq);
  });

  it('keeps one epoch per database file: the same for every connection to it, another for a new file', async () => {
    const dir = tempDir();
    const one = await startOn(path.join(dir, 'hub.db'));
    const f = feed(one.url, B);
    const hello = await f.waitFor((fr) => fr.type === 'hello');
    f.ws.close();
    const epoch = (await api(one.url, 'GET', '/events?since=0', undefined, B)).json.epoch;
    expect(epoch).toMatch(/^\S{8,}$/);
    expect(hello).toMatchObject({ epoch });
    const again = await startOn(path.join(dir, 'hub.db'));
    expect((await api(again.url, 'GET', '/events?since=0', undefined, B)).json.epoch).toBe(epoch);
    const other = await startOn(path.join(dir, 'other.db'));
    expect((await api(other.url, 'GET', '/events?since=0', undefined, B)).json.epoch).not.toBe(epoch);
  });

  it('sends direct-message events only to the recipient', async () => {
    const s = await start();
    const toB = feed(s.url, B);
    const other = feed(s.url, 'lee/codex-1');
    await Promise.all([toB.waitFor((f) => f.type === 'hello'), other.waitFor((f) => f.type === 'hello')]);
    await api(s.url, 'POST', '/messages', { to: B, body: 'secret plan' }, A);
    await api(s.url, 'POST', '/messages', { to: '#general', body: 'hello all' }, A);
    await toB.waitFor(toB.isEvent('message.posted', (e) => e.data.channel === '#general'));
    await other.waitFor(other.isEvent('message.posted', (e) => e.data.channel === '#general'));
    expect(toB.events().filter((e) => e.type === 'message.posted')).toHaveLength(2);
    expect(other.events().filter((e) => e.type === 'message.posted')).toHaveLength(1);
    expect(JSON.stringify(toB.frames)).not.toContain('secret plan'); // bodies only via inbox
    toB.ws.close();
    other.ws.close();
  });

  it('expires a lease in real time when heartbeats stop and pushes claim.expired', async () => {
    const s = await start({ leaseTtlMs: 300, sweepIntervalMs: 25 });
    const watcher = feed(s.url, B);
    await watcher.waitFor((f) => f.type === 'hello');
    const t0 = Date.now();
    await api(s.url, 'POST', '/claims', { files: ['a.ts'] }, A);
    const expired = await watcher.waitFor(watcher.isEvent('claim.expired'), 3000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(expired.type === 'event' && expired.event.data).toMatchObject({ holder: A, files: ['a.ts'] });
    expect((await api(s.url, 'POST', '/claims', { files: ['a.ts'] }, B)).json.status).toBe('granted');
    watcher.ws.close();
  });

  it('keeps a lease alive with heartbeats sent over the WebSocket', async () => {
    const s = await start({ leaseTtlMs: 400, sweepIntervalMs: 25 });
    const holder = feed(s.url, A);
    await holder.waitFor((f) => f.type === 'hello');
    await api(s.url, 'POST', '/claims', { files: ['a.ts'] }, A);
    const timer = setInterval(() => holder.ws.send(JSON.stringify({ type: 'heartbeat' })), 100);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await api(s.url, 'POST', '/claims', { files: ['a.ts'] }, B)).json.status).toBe('denied');
    expect(holder.frames.some((f) => f.type === 'heartbeat.ack' && f.renewed === 1)).toBe(true);
    clearInterval(timer);
    await holder.waitFor(holder.isEvent('claim.expired'), 3000);
    holder.ws.close();
  });

  it('drops a feed connection that sends an oversized or malformed frame and keeps the hub-server process running', async () => {
    const s = await startCli();
    await fetch(`${s.url}/v1/p/demo/claims`, {
      method: 'POST',
      headers: { 'x-hub-agent': A, 'content-type': 'application/json' },
      body: JSON.stringify({ files: ['src/x.ts'] }),
    });
    const healthy = async () => (await fetch(`${s.url}/healthz`)).status;

    // A spec-compliant client sending one message over the 64 KiB limit.
    const big = new WebSocket(`${s.url.replace('http', 'ws')}/v1/p/demo/feed?agent=${B}`);
    big.on('error', () => {});
    await once(big, 'open');
    big.send('x'.repeat(70 * 1024));
    const [code] = await once(big, 'close');
    expect(code).toBe(1009);
    expect(await healthy()).toBe(200);

    // Frames that break the protocol: no client mask, invalid UTF-8 text, a reserved opcode.
    for (const bytes of [Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63]), maskedFrame(0x1, Buffer.from([0xff, 0xfe, 0xfd])), maskedFrame(0x3, Buffer.from('x'))]) {
      await sendRawFrame(s.port, bytes);
      expect(await healthy()).toBe(200);
    }

    expect(s.child.exitCode).toBe(null);
    expect(s.output()).toContain('[hub] feed connection dropped: Max payload size exceeded');
    const check = await fetch(`${s.url}/v1/p/demo/claims/check`, {
      method: 'POST',
      headers: { 'x-hub-agent': B, 'content-type': 'application/json' },
      body: JSON.stringify({ files: ['src/x.ts'] }),
    });
    expect(((await check.json()) as any).conflicts).toHaveLength(1); // the claim is still enforced
    const f = feed(s.url, B);
    await f.waitFor((fr) => fr.type === 'hello');
    f.ws.close();
  });

  it('keeps hub-server running when a client resets the connection while its feed upgrade is being refused, token or not', async () => {
    const s = await startCli(['--token', 'sekrit']);
    const refused = [
      `/v1/p/demo/feed?agent=${A}\r\nOrigin: https://evil.example`, // 403 forbidden_origin, before the token is looked at
      `/v1/p/demo/feed?agent=${A}`, // 401 unauthorized
      '/v1/p/demo/nope', // 404 not_found
    ];
    for (let i = 0; i < 10; i++) {
      for (const target of refused) {
        const sock = connect(s.port, '127.0.0.1');
        sock.on('error', () => {});
        await once(sock, 'connect');
        const [route, extra] = target.split('\r\n');
        sock.write(
          `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n${extra ? `${extra}\r\n` : ''}Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
        sock.resetAndDestroy(); // gone before the hub writes its refusal: EPIPE or ECONNRESET on the hub's side
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(s.child.exitCode).toBe(null);
    expect((await fetch(`${s.url}/healthz`)).status).toBe(200);
    expect(await upgradeStatus(s.url, { authorization: 'Bearer sekrit' })).toBe(101);
  });
});

describe('built-in dashboard', () => {
  it('serves a public static shell and local assets without exposing authenticated data', async () => {
    const s = await start({ token: 'dashboard-test-token' });
    const page = await fetch(s.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('Workspace overview');
    for (const [asset, type] of [['dashboard.js', 'text/javascript'], ['dashboard.css', 'text/css'], ['favicon.svg', 'image/svg+xml'], ['geist-latin.woff2', 'font/woff2']]) {
      const response = await fetch(`${s.url}/${asset}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(type);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect((await fetch(`${s.url}/v1/projects`)).status).toBe(401);
    expect((await fetch(`${s.url}/v1/p/demo/status`)).status).toBe(401);
    expect((await fetch(`${s.url}/src/server.ts`)).status).toBe(401);
  });

  it('lists actual projects only after authentication', async () => {
    const s = await start({ token: 'dashboard-test-token' });
    await api(s.url, 'POST', '/tasks', { title: 'A real project task' }, A, 'dashboard-test-token');
    const response = await fetch(`${s.url}/v1/projects`, { headers: { authorization: 'Bearer dashboard-test-token' } });
    expect(await response.json()).toEqual({ projects: ['demo'] });
  });

  it('accepts the dashboard origin while refusing other origins and rebound hosts', async () => {
    const s = await start();
    const response = await fetch(`${s.url}/v1/p/demo/tasks`, {
      method: 'POST', headers: { origin: s.url, 'x-hub-agent': A, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Created from the dashboard' }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as any).task.title).toBe('Created from the dashboard');
    expect(await upgradeStatus(s.url, { origin: s.url })).toBe(101);
    expect((await fetch(`${s.url}/v1/projects`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await requestAs(s.port, `rebind.evil.example:${s.port}`, '/', { origin: `http://rebind.evil.example:${s.port}` })).status).toBe(403);
    expect((await fetch(`${s.url}/dashboard.js/../server.ts`)).status).toBe(404);
  });
});

describe('browser origins', () => {
  it('refuses feed upgrades and HTTP requests that carry an Origin header that is not allowed', async () => {
    const s = await start();
    expect(await upgradeStatus(s.url, { origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(s.url, { origin: 'null' })).toBe(403);
    expect(await upgradeStatus(s.url)).toBe(101); // Node clients send no Origin

    for (const route of ['/healthz', '/v1/p/demo/status', '/v1/p/demo/events?since=0']) {
      const res = await fetch(`${s.url}${route}`, { headers: { origin: 'https://evil.example', 'x-hub-agent': A } });
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBe(null);
      expect(await res.json()).toMatchObject({ error: { code: 'forbidden_origin', message: expect.stringContaining('"https://evil.example"') } });
    }
    const post = await fetch(`${s.url}/v1/p/demo/claims`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'x-hub-agent': A, 'content-type': 'text/plain' },
      body: JSON.stringify({ files: ['a.ts'] }),
    });
    expect(post.status).toBe(403);
    expect((await api(s.url, 'GET', '/claims')).json.claims).toHaveLength(0);
  });

  it('serves allowlisted origins, including CORS preflights', async () => {
    const s = await start({ allowOrigins: ['http://localhost:5173', 'https://Dash.Example.com/'] });
    expect(await upgradeStatus(s.url, { origin: 'http://localhost:5173' })).toBe(101);
    expect(await upgradeStatus(s.url, { origin: 'https://dash.example.com' })).toBe(101);
    expect(await upgradeStatus(s.url, { origin: 'http://localhost:5174' })).toBe(403);

    const pre = await fetch(`${s.url}/v1/p/demo/claims`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-hub-agent' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(pre.headers.get('access-control-allow-headers')).toContain('x-hub-agent');

    const res = await fetch(`${s.url}/v1/p/demo/claims`, {
      method: 'POST',
      headers: { origin: 'http://localhost:5173', 'x-hub-agent': A, 'content-type': 'application/json' },
      body: JSON.stringify({ files: ['a.ts'] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(((await res.json()) as any).status).toBe('granted');

    const noOrigin = await fetch(`${s.url}/v1/p/demo/claims`, { method: 'OPTIONS' });
    expect(noOrigin.status).toBe(404);
  });

  it('checks the obsolete Sec-WebSocket-Origin header like Origin', async () => {
    const s = await start({ allowOrigins: ['http://localhost:5173'] });
    expect(await upgradeStatus(s.url, { 'sec-websocket-origin': 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(s.url, { 'sec-websocket-origin': 'http://localhost:5173' })).toBe(101);
  });

  it('refuses requests addressed to a host name it does not serve, as after DNS rebinding', async () => {
    const s = await start();
    await api(s.url, 'POST', '/tasks', { title: 'secret project Falcon' }, A);
    await api(s.url, 'POST', '/messages', { to: B, body: 'private note' }, A);

    // A rebound page is same-origin with its own domain, so it sends no Origin; only Host gives it away.
    const evil = `rebind.evil.example:${s.port}`;
    for (const route of ['/healthz', '/v1/p/demo/status', '/v1/p/demo/events?since=0', '/v1/p/demo/inbox']) {
      const res = await requestAs(s.port, evil, route, { 'x-hub-agent': B });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'forbidden_host', message: expect.stringContaining('"rebind.evil.example"') } });
      expect(res.body).not.toContain('Falcon');
    }
    expect((await requestAs(s.port, evil, '/v1/p/demo/heartbeat', { 'x-hub-agent': A }, 'POST')).status).toBe(403);
    expect(await upgradeStatus(s.url, { host: evil })).toBe(403);
    expect((await api(s.url, 'GET', '/inbox?peek=1', undefined, B)).json.messages).toHaveLength(1); // not consumed

    // IP addresses and localhost names can't be rebound, so they always work.
    for (const host of ['127.0.0.1', 'localhost', 'LocalHost', 'app.localhost', '[::1]', '10.0.0.7'].map((h) => `${h}:${s.port}`)) {
      expect((await requestAs(s.port, host, '/v1/p/demo/status', { 'x-hub-agent': A })).status).toBe(200);
    }
    expect(await upgradeStatus(s.url, { host: `localhost:${s.port}` })).toBe(101);
  });

  it('names the refused host and the exact --allow-host flag that serves it, on HTTP and on the feed upgrade', async () => {
    const s = await start();
    for (const name of ['host.docker.internal', 'my-laptop.local', 'hub.internal']) {
      const res = await requestAs(s.port, `${name}:${s.port}`, '/v1/p/demo/claims', { 'x-hub-agent': A, 'content-type': 'application/json' }, 'POST', JSON.stringify({ files: ['src/x.ts'] }));
      expect(res.status).toBe(403);
      const { error } = JSON.parse(res.body);
      expect(error.code).toBe('forbidden_host');
      expect(error.message).toContain(`"${name}"`);
      expect(error.message).toContain(`hub-server --allow-host ${name}`);
      expect(error.message).toContain('host.docker.internal'); // the common case, Docker Desktop containers

      const up = await upgradeRefusal(s.url, { host: `${name}:${s.port}` });
      expect(up.status).toBe(403);
      expect(up.type).toMatch(/^application\/json/);
      expect(JSON.parse(up.body)).toEqual({ error });
    }
    // A Host that no flag could allow gets no suggestion to pass it.
    const odd = await requestAs(s.port, `a..b:${s.port}`, '/healthz');
    expect(odd.status).toBe(403);
    expect(JSON.parse(odd.body).error.message).not.toContain('--allow-host a..b');
    expect((await api(s.url, 'GET', '/claims')).json.claims).toHaveLength(0);
  });

  it('serves host names given in the host allowlist', async () => {
    const s = await start({ allowHosts: ['Hub.Example.com'] });
    for (const host of ['hub.example.com', 'HUB.EXAMPLE.COM', 'hub.example.com:80']) {
      expect((await requestAs(s.port, host, '/v1/p/demo/status')).status).toBe(200);
    }
    expect((await requestAs(s.port, 'other.example.com', '/v1/p/demo/status')).status).toBe(403);
    expect(await upgradeStatus(s.url, { host: `hub.example.com:${s.port}` })).toBe(101);

    const hub = new Hub({ store: new SqliteStore(':memory:') });
    for (const bad of ['http://hub.example.com', 'hub.example.com:7077', 'hub.example.com/x', 'u@hub.example.com', '*', '*.example.com', '', 'a b']) {
      await expect(startServer({ hub, port: 0, allowHosts: [bad] })).rejects.toThrow(/not a host name/);
    }
  });

  it('serves any host name when listening on a network address, as on a private network', async () => {
    // Teammates reach such a hub by whatever name the network gives it (devbox.lan, a
    // compose service, a proxy), so without --allow-host it doesn't check Host.
    const s = await start({ host: '0.0.0.0' });
    const lan = `devbox.lan:${s.port}`;
    expect((await requestAs(s.port, lan, '/healthz')).status).toBe(200);
    expect((await requestAs(s.port, lan, '/v1/p/demo/status', { 'x-hub-agent': A })).status).toBe(200);
    const claim = await requestAs(s.port, lan, '/v1/p/demo/claims', { 'x-hub-agent': A, 'content-type': 'application/json' }, 'POST', JSON.stringify({ files: ['src/x.ts'] }));
    expect(JSON.parse(claim.body)).toMatchObject({ status: 'granted' });
    expect(await upgradeStatus(s.url, { host: lan })).toBe(101);
    // Browser origins are still refused.
    expect((await requestAs(s.port, lan, '/healthz', { origin: 'https://evil.example' })).status).toBe(403);
    expect(await upgradeStatus(s.url, { host: lan, origin: 'https://evil.example' })).toBe(403);
    // Host is unchecked here, so a page on a rebound name that matches its own origin is refused too.
    const rebound = `rebind.evil.example:${s.port}`;
    expect((await requestAs(s.port, rebound, '/v1/projects', { origin: `http://${rebound}` })).status).toBe(403);
    expect(await upgradeStatus(s.url, { host: rebound, origin: `http://${rebound}` })).toBe(403);
    // The dashboard opened by IP address still reaches the API: an IP can't be rebound.
    expect((await fetch(`${s.url}/v1/projects`, { headers: { origin: s.url } })).status).toBe(200);
    expect(await upgradeStatus(s.url, { origin: s.url })).toBe(101);
  });

  it('checks Host on a network address once names are given with allowHosts', async () => {
    const s = await start({ host: '0.0.0.0', allowHosts: ['devbox.lan'] });
    expect((await requestAs(s.port, `devbox.lan:${s.port}`, '/v1/p/demo/status')).status).toBe(200);
    expect((await requestAs(s.port, `127.0.0.1:${s.port}`, '/v1/p/demo/status')).status).toBe(200);
    expect((await requestAs(s.port, `rebind.evil.example:${s.port}`, '/v1/p/demo/status')).status).toBe(403);
    expect(await upgradeStatus(s.url, { host: `rebind.evil.example:${s.port}` })).toBe(403);
    // With Host checked, the dashboard served under an allowed name can call the API.
    const dashboard = `devbox.lan:${s.port}`;
    expect((await requestAs(s.port, dashboard, '/v1/projects', { origin: `http://${dashboard}` })).status).toBe(200);
    expect(await upgradeStatus(s.url, { host: dashboard, origin: `http://${dashboard}` })).toBe(101);
  });

  it('rejects an allowlist entry that is not an origin', async () => {
    const hub = new Hub({ store: new SqliteStore(':memory:') });
    for (const bad of ['localhost:5173', 'null', 'http://localhost:5173/app', 'file:///tmp/x.html', '*']) {
      await expect(startServer({ hub, port: 0, allowOrigins: [bad] })).rejects.toThrow(/not an origin/);
    }
  });

  it('hub-server takes repeatable --allow-origin flags', async () => {
    const s = await startCli(['--allow-origin', 'http://localhost:5173', '--allow-origin', 'https://dash.example.com']);
    expect(await upgradeStatus(s.url, { origin: 'http://localhost:5173' })).toBe(101);
    expect(await upgradeStatus(s.url, { origin: 'https://dash.example.com' })).toBe(101);
    expect(await upgradeStatus(s.url, { origin: 'https://evil.example' })).toBe(403);
    expect((await fetch(`${s.url}/healthz`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(`${s.url}/healthz`)).status).toBe(200);
  });

  it('hub-server takes repeatable --allow-host flags', async () => {
    const s = await startCli(['--allow-host', 'hub.example.com', '--allow-host', 'devbox.lan']);
    expect((await requestAs(s.port, `hub.example.com:${s.port}`, '/v1/p/demo/status')).status).toBe(200);
    expect((await requestAs(s.port, `devbox.lan:${s.port}`, '/v1/p/demo/status')).status).toBe(200);
    expect((await requestAs(s.port, `rebind.evil.example:${s.port}`, '/v1/p/demo/status')).status).toBe(403);
  });

  it('hub-server --allow-host host.docker.internal serves a Docker Desktop container on HTTP and on the feed', async () => {
    const docker = 'host.docker.internal';
    // Without the flag the refusal tells the user exactly what to run.
    const plain = await startCli();
    const refused = await requestAs(plain.port, `${docker}:${plain.port}`, '/v1/p/demo/claims', { 'x-hub-agent': A, 'content-type': 'application/json' }, 'POST', JSON.stringify({ files: ['src/x.ts'] }));
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body).error.message).toContain(`hub-server --allow-host ${docker}`);
    expect((await upgradeRefusal(plain.url, { host: `${docker}:${plain.port}` })).body).toContain(`hub-server --allow-host ${docker}`);

    const s = await startCli(['--allow-host', docker]);
    const claim = await requestAs(s.port, `${docker}:${s.port}`, '/v1/p/demo/claims', { 'x-hub-agent': A, 'content-type': 'application/json' }, 'POST', JSON.stringify({ files: ['src/x.ts'] }));
    expect(JSON.parse(claim.body)).toMatchObject({ status: 'granted' });
    const check = await requestAs(s.port, `${docker}:${s.port}`, '/v1/p/demo/claims/check', { 'x-hub-agent': B, 'content-type': 'application/json' }, 'POST', JSON.stringify({ files: ['src/x.ts'] }));
    expect(JSON.parse(check.body).conflicts).toHaveLength(1);
    expect(await upgradeStatus(s.url, { host: `${docker}:${s.port}` })).toBe(101);
    // Other names are still refused, on both paths.
    expect((await requestAs(s.port, `rebind.evil.example:${s.port}`, '/healthz')).status).toBe(403);
    expect(await upgradeStatus(s.url, { host: `rebind.evil.example:${s.port}` })).toBe(403);
  });

  it('hub-server --host 0.0.0.0 serves clients that use a DNS name in their hub URL', async () => {
    const s = await startCli(['--host', '0.0.0.0']);
    const lan = `devbox.lan:${s.port}`;
    expect((await requestAs(s.port, lan, '/healthz')).status).toBe(200);
    const claim = await requestAs(s.port, lan, '/v1/p/demo/claims', { 'x-hub-agent': A, 'content-type': 'application/json' }, 'POST', JSON.stringify({ files: ['src/x.ts'] }));
    expect(JSON.parse(claim.body)).toMatchObject({ status: 'granted' });
    // The default loopback hub still refuses the same name.
    const local = await startCli();
    expect((await requestAs(local.port, `devbox.lan:${local.port}`, '/healthz')).status).toBe(403);
  });

  it('hub-server reports a bad --allow-origin or --allow-host in one line, without a stack trace', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-cli-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(here, '..', 'bin', 'hub-server.js');
    for (const [flag, value, want] of [
      ['--allow-origin', 'localhost:5173', 'hub-server: allowed origin "localhost:5173" is not an origin'],
      ['--allow-host', 'https://hub.example.com', 'hub-server: allowed host "https://hub.example.com" is not a host name'],
    ]) {
      const r = spawnSync(process.execPath, [bin, '--port', '0', '--db', path.join(dir, 'hub.db'), flag, value], { encoding: 'utf8', timeout: 10_000 });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(want);
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stdout).not.toContain('listening');
    }
  });
});

describe('hub-server settings', () => {
  const bin = path.join(here, '..', 'bin', 'hub-server.js');
  /** Runs hub-server with settings that must be refused, and returns its one-line complaint. */
  function refused(args: string[], env: Record<string, string> = {}): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-cli-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = path.join(dir, 'hub.db');
    const r = spawnSync(process.execPath, [bin, '--db', db, ...args], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, ...env } });
    const what = `${args.join(' ')} ${JSON.stringify(env)}`;
    expect(r.stdout, what).not.toContain('listening');
    expect(r.status, `${what}: ${r.stderr}`).toBe(2);
    expect(r.stderr.trim().split('\n'), what).toHaveLength(1);
    expect(existsSync(db), what).toBe(false); // refused before the database is created
    return r.stderr.trim();
  }

  it('refuses a lease TTL that would expire leases at once, never, or in a flood of heartbeats, naming the option', () => {
    const range = 'must be from 100 to 86400000 ms';
    expect(refused(['--port', '0', '--lease-ttl-ms', '0'])).toBe(`hub-server: --lease-ttl-ms ${range}, got 0`);
    expect(refused(['--port', '0', '--lease-ttl-ms=-1'])).toBe('hub-server: --lease-ttl-ms must be a whole number of milliseconds, got "-1"');
    expect(refused(['--port', '0'], { HUB_LEASE_TTL_MS: '-1' })).toBe('hub-server: HUB_LEASE_TTL_MS must be a whole number of milliseconds, got "-1"');
    expect(refused(['--port', '0'], { HUB_LEASE_TTL_MS: ' ' })).toBe('hub-server: HUB_LEASE_TTL_MS must be a whole number of milliseconds, got " "');
    expect(refused(['--port', '0', '--lease-ttl-ms', '5'])).toBe(`hub-server: --lease-ttl-ms ${range}, got 5`);
    expect(refused(['--port', '0', '--lease-ttl-ms', '172800000'])).toBe(`hub-server: --lease-ttl-ms ${range}, got 172800000`);
    expect(refused(['--port', '0', '--lease-ttl-ms', '100000000000000000000'])).toBe(`hub-server: --lease-ttl-ms ${range}, got 100000000000000000000`);
    for (const value of ['2m', 'Infinity', '1e20', '0x10000', '1.5', 'abc']) {
      expect(refused(['--port', '0', '--lease-ttl-ms', value])).toBe(`hub-server: --lease-ttl-ms must be a whole number of milliseconds, got "${value}"`);
    }
    expect(refused(['--port', '0'], { HUB_LEASE_TTL_MS: '120000ms' })).toBe('hub-server: HUB_LEASE_TTL_MS must be a whole number of milliseconds, got "120000ms"');
    // A negative value after a space is taken for a flag; that is reported in one line too.
    expect(refused(['--port', '0', '--lease-ttl-ms', '-5'])).toContain("hub-server: Option '--lease-ttl-ms' argument is ambiguous.");
  });

  it('refuses a heartbeat interval that would let live sessions lose their leases, naming the option', () => {
    expect(refused(['--port', '0', '--heartbeat-ms', '30s'])).toBe('hub-server: --heartbeat-ms must be a whole number of milliseconds, got "30s"');
    expect(refused(['--port', '0', '--heartbeat-ms', '0'])).toBe('hub-server: --heartbeat-ms must be from 25 to 40000 ms (a third of the 120000 ms lease TTL), got 0');
    expect(refused(['--port', '0', '--heartbeat-ms', '1'])).toBe('hub-server: --heartbeat-ms must be from 25 to 40000 ms (a third of the 120000 ms lease TTL), got 1');
    expect(refused(['--port', '0', '--lease-ttl-ms', '3000', '--heartbeat-ms', '9000'])).toBe('hub-server: --heartbeat-ms must be from 25 to 1000 ms (a third of the 3000 ms lease TTL), got 9000');
    expect(refused(['--port', '0', '--lease-ttl-ms', '3000', '--heartbeat-ms', '3000'])).toBe('hub-server: --heartbeat-ms must be from 25 to 1000 ms (a third of the 3000 ms lease TTL), got 3000');
    // Lowering only the TTL while HUB_HEARTBEAT_MS keeps the documented 30000.
    expect(refused(['--port', '0', '--lease-ttl-ms', '20000'], { HUB_HEARTBEAT_MS: '30000' })).toBe('hub-server: HUB_HEARTBEAT_MS must be from 25 to 6666 ms (a third of the 20000 ms lease TTL), got 30000');
  });

  it('refuses a port that is not a whole number from 0 to 65535 instead of binding a random one, naming the option', () => {
    for (const value of [' ', 'abc', '7077x', '1.5', '0x1F00', '1e3']) {
      expect(refused(['--port', value])).toBe(`hub-server: --port must be a port number from 0 to 65535, got "${value}"`);
    }
    expect(refused(['--port', '70000'])).toBe('hub-server: --port must be a port number from 0 to 65535, got "70000"');
    expect(refused([], { HUB_PORT: ' ' })).toBe('hub-server: HUB_PORT must be a port number from 0 to 65535, got " "');
  });

  it("refuses a port Node's fetch won't connect to, which the adapter would take for a hub that is down", async () => {
    for (const port of ['6667', '10080', '9']) {
      expect(refused(['--port', port])).toBe(
        `hub-server: --port ${port} is a port Node's fetch (like browsers) refuses to connect to, so no adapter could reach the hub; pick another port, such as the default 7077`,
      );
    }
    expect(refused([], { HUB_PORT: '6667' })).toMatch(/^hub-server: HUB_PORT 6667 is a port Node's fetch/);
    await expect(fetch('http://127.0.0.1:6667/healthz')).rejects.toMatchObject({ cause: { message: 'bad port' } });
  });

  it('starts with settings in range and reports what it runs with', async () => {
    const s = await startCli(['--lease-ttl-ms', '3000', '--heartbeat-ms', '1000']);
    expect(s.output()).toContain('lease ttl 3000 ms, heartbeat every 1000 ms');
    const { json } = await api(s.url, 'GET', '/status', undefined, A);
    expect(json.lease).toEqual({ ttl_ms: 3000, heartbeat_interval_ms: 1000 });
    // Only the TTL given: the heartbeat comes four times per lease.
    const derived = await startCli(['--lease-ttl-ms', '20000']);
    expect(derived.output()).toContain('lease ttl 20000 ms, heartbeat every 5000 ms');
  });
});

describe('HTTP API', () => {
  it('long-polls /events until a matching event commits', async () => {
    const s = await start();
    const { json: st } = await api(s.url, 'GET', '/status', undefined, B);
    const t0 = Date.now();
    const poll = api(s.url, 'GET', `/events?since=${st.seq}&wait_ms=5000`, undefined, B);
    setTimeout(() => void api(s.url, 'POST', '/claims', { files: ['x.ts'] }, A), 150);
    const { json } = await poll;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(json.events.map((e: HubEvent) => e.type)).toContain('claim.granted');
  });

  it('moves the /events cursor past 500 direct messages the caller cannot see, and wakes a long-poll behind them', async () => {
    const s = await start();
    const C = 'lee/codex-1';
    s.hub.claim('demo', A, { files: ['src/auth.ts'] });
    s.hub.heartbeat('demo', C);
    const since = s.hub.latestSeq('demo');
    // One agent messaging itself is enough to fill the log with events nobody else sees.
    for (let i = 0; i < 600; i++) s.hub.post('demo', C, { to: C, body: `note ${i}` });
    const now = await api(s.url, 'GET', `/events?since=${since}`, undefined, B);
    expect(now.json).toMatchObject({ events: [], next_since: s.hub.latestSeq('demo'), epoch: expect.any(String) });

    const t0 = Date.now();
    const poll = api(s.url, 'GET', `/events?since=${since}&wait_ms=5000`, undefined, B);
    setTimeout(() => s.hub.release('demo', A, { files: ['src/auth.ts'] }), 150);
    const { json } = await poll;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(json.events.map((e: HubEvent) => e.type)).toEqual(['claim.released']);
    expect(json.next_since).toBe(json.events[0].seq);
  });

  it('reads /events past a long run of events the caller cannot see a part at a time, each answered at once, and next_since leads on to the event behind them', async () => {
    const s = await start();
    const C = 'lee/codex-1';
    s.hub.claim('demo', A, { files: ['src/auth.ts'] });
    const since = s.hub.latestSeq('demo');
    seedEvents(s.hub, 20_000, (i) => ({ type: 'message.posted', actor: C, data: { message_id: i + 1, from: C, to: A, channel: null }, targets: [C, A] }));
    s.hub.release('demo', A, { files: ['src/auth.ts'] });
    let cursor = since;
    let reads = 0;
    let events: HubEvent[] = [];
    while (events.length === 0 && reads < 20) {
      const t0 = Date.now();
      const { json } = await api(s.url, 'GET', `/events?since=${cursor}&wait_ms=5000`, undefined, B);
      reads++;
      // A long-poll whose read stopped short of the latest event doesn't wait.
      expect(Date.now() - t0).toBeLessThan(2500);
      expect(json.next_since).toBeGreaterThan(cursor);
      expect(json.next_since - cursor).toBeLessThanOrEqual(5000);
      cursor = json.next_since;
      events = json.events;
    }
    expect(reads).toBeGreaterThan(1);
    expect(events.map((e) => e.type)).toEqual(['claim.released']);
    expect(cursor).toBe(s.hub.latestSeq('demo'));
  });

  it('filters /events by type over the whole log, not over its first 500 events', async () => {
    const s = await start();
    s.hub.claim('demo', A, { files: ['a.ts'] });
    const since = s.hub.latestSeq('demo');
    for (let i = 0; i < 600; i++) s.hub.post('demo', B, { to: '#general', body: `m${i}` });
    s.hub.release('demo', A, { files: ['a.ts'] });
    const released = await api(s.url, 'GET', `/events?since=${since}&types=claim.released`, undefined, B);
    expect(released.json.events.map((e: HubEvent) => e.type)).toEqual(['claim.released']);
    expect(released.json.next_since).toBe(s.hub.latestSeq('demo'));

    const t0 = Date.now();
    const poll = api(s.url, 'GET', `/events?since=${since}&types=claim.granted&wait_ms=5000`, undefined, B);
    setTimeout(() => s.hub.claim('demo', A, { files: ['b.ts'] }), 150);
    const { json } = await poll;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(json.events).toMatchObject([{ type: 'claim.granted', data: { files: ['b.ts'] } }]);
  });

  it('returns /events in pages of 500, with next_since continuing after the last one returned', async () => {
    const s = await start();
    const since = s.hub.latestSeq('demo');
    for (let i = 0; i < 600; i++) s.hub.post('demo', A, { to: '#general', body: `m${i}` });
    const first = (await api(s.url, 'GET', `/events?since=${since}`, undefined, B)).json;
    expect(first.events).toHaveLength(500);
    expect(first.next_since).toBe(first.events[499].seq);
    const rest = (await api(s.url, 'GET', `/events?since=${first.next_since}`, undefined, B)).json;
    expect(rest.events).toHaveLength(101); // 601 in all: A's agent.online, then the posts
    expect(rest.events.at(-1).seq).toBe(s.hub.latestSeq('demo'));
    expect(rest).toMatchObject({ next_since: s.hub.latestSeq('demo'), seq: s.hub.latestSeq('demo'), epoch: first.epoch });
  });

  it('requires the bearer token when one is configured', async () => {
    const s = await start({ token: 's3cret' });
    expect((await api(s.url, 'GET', '/status', undefined, A)).status).toBe(401);
    expect((await api(s.url, 'GET', '/status', undefined, A, 'wrong')).status).toBe(401);
    expect((await api(s.url, 'GET', '/status', undefined, A, 's3cret')).status).toBe(200);
  });

  it('returns structured errors', async () => {
    const s = await start();
    const noAgent = await api(s.url, 'POST', '/claims', { files: ['a.ts'] });
    expect(noAgent).toMatchObject({ status: 400, json: { error: { code: 'bad_agent' } } });
    const blocked = await (async () => {
      const t1 = (await api(s.url, 'POST', '/tasks', { title: 'one' }, A)).json.task;
      const t2 = (await api(s.url, 'POST', '/tasks', { title: 'two', deps: [t1.id] }, A)).json.task;
      return api(s.url, 'POST', `/tasks/${t2.id}/take`, {}, B);
    })();
    expect(blocked).toMatchObject({ status: 409, json: { error: { code: 'task_blocked' } } });
    expect((await api(s.url, 'GET', '/nope', undefined, A)).status).toBe(404);
  });

  it('refuses to land or complete a task with unfinished dependencies with 409 task_blocked, and to complete a cancelled one', async () => {
    const s = await start();
    const t1 = (await api(s.url, 'POST', '/tasks', { title: 'one' }, A)).json.task;
    const t2 = (await api(s.url, 'POST', '/tasks', { title: 'two', deps: [t1.id] }, A)).json.task;
    const t3 = (await api(s.url, 'POST', '/tasks', { title: 'three', deps: [t2.id] }, A)).json.task;
    for (const [route, body] of [
      ['/land', { task_id: t2.id }],
      [`/tasks/${t2.id}/update`, { status: 'done' }],
    ] as const) {
      const res = await api(s.url, 'POST', route, body, B);
      expect(res).toMatchObject({ status: 409, json: { error: { code: 'task_blocked' } } });
      expect(res.json.error.message).toContain(`${t2.id} is blocked by ${t1.id} (open)`);
    }
    expect((await api(s.url, 'POST', `/tasks/${t3.id}/take`, {}, B)).json.error.code).toBe('task_blocked');
    const tasks = (await api(s.url, 'GET', '/tasks', undefined, A)).json.tasks;
    expect(tasks.map((t: { status: string }) => t.status)).toEqual(['open', 'open', 'open']);
    expect((await api(s.url, 'GET', '/status', undefined, A)).json.landings).toEqual([]);

    await api(s.url, 'POST', `/tasks/${t1.id}/update`, { status: 'cancelled' }, A);
    expect(await api(s.url, 'POST', '/land', { task_id: t1.id }, B)).toMatchObject({ status: 409, json: { error: { code: 'task_closed' } } });
  });

  it('refuses a task_id, claim_id or claim_ids that is not an id with 400 bad_request instead of failing with 500, renewals included', async () => {
    const s = await start();
    const t1 = (await api(s.url, 'POST', '/tasks', { title: 'one' }, A)).json.task;
    await api(s.url, 'POST', `/tasks/${t1.id}/take`, {}, A);
    const first = (await api(s.url, 'POST', '/claims', { files: ['src/auth.ts'] }, A)).json.claim;
    for (const bad of [{}, [], true]) {
      for (const [route, body] of [
        ['/claims', { files: ['src/auth.ts'], task_id: bad }], // a renewal: A holds the file
        ['/claims', { files: ['src/new.ts'], task_id: bad }],
        ['/decisions', { summary: 'x', task_id: bad }],
        ['/land', { task_id: bad }],
        ['/claims/release', { task_id: bad }],
        ['/claims/release', { claim_id: bad }],
        ['/heartbeat', { claim_ids: [bad] }],
        ['/heartbeat', { claim_ids: { 0: 'C-1' } }],
      ] as const) {
        const res = await api(s.url, 'POST', route, body, A);
        expect({ route, bad, status: res.status, code: res.json.error?.code }).toEqual({ route, bad, status: 400, code: 'bad_request' });
      }
    }
    // Nothing was changed by the refusals, and well-formed ids still work.
    const status = (await api(s.url, 'GET', '/status', undefined, A)).json;
    expect(status.claims.map((c: { id: string }) => c.id)).toEqual([first.id]);
    expect(status.landings).toEqual([]);
    expect((await api(s.url, 'POST', '/claims', { files: ['src/auth.ts'], task_id: t1.id }, A)).json).toMatchObject({ status: 'granted', renewed: true });
    expect((await api(s.url, 'POST', '/heartbeat', { claim_ids: [first.id] }, A)).json.renewed).toBe(1);
  });

  it('releases every claim for {all: true, files: []}, and only the named files of one claim for {claim_id, files}', async () => {
    const s = await start();
    await api(s.url, 'POST', '/claims', { files: ['src/auth.ts', 'src/users.ts'] }, A);
    const waiter = (await api(s.url, 'POST', '/claims', { files: ['src/users.ts'], queue: true }, B)).json.claim;
    const trim = await api(s.url, 'POST', '/claims/release', { claim_id: 'C-1', files: ['src/auth.ts'] }, A);
    expect(trim.json).toMatchObject({ released: [], trimmed: [{ id: 'C-1', scope: [{ file: 'src/users.ts' }] }], promoted: [] });
    const all = await api(s.url, 'POST', '/claims/release', { all: true, files: [] }, A);
    expect(all.json.released.map((c: { id: string }) => c.id)).toEqual(['C-1']);
    expect(all.json.promoted.map((c: { id: string }) => c.id)).toEqual([waiter.id]);
  });

  it('refuses a release whose files is not a list with 400 bad_request and releases nothing', async () => {
    const s = await start();
    await api(s.url, 'POST', '/claims', { files: ['a.ts', 'b.ts'] }, A);
    for (const body of [{ all: true, files: {} }, { all: true, files: 'a.ts' }, { files: 'a.ts' }, { claim_id: 'C-1', files: { 0: 'a.ts' } }]) {
      expect(await api(s.url, 'POST', '/claims/release', body, A)).toMatchObject({ status: 400, json: { error: { code: 'bad_request' } } });
    }
    expect((await api(s.url, 'GET', '/claims', undefined, A)).json.claims).toMatchObject([{ id: 'C-1', status: 'active', scope: [{ file: 'a.ts' }, { file: 'b.ts' }] }]);
  });

  it('keeps the queue order against edit-hook requests and refuses a deadlocking upgrade with 409 deadlock', async () => {
    const s = await start();
    const C = 'lee/codex-1';
    for (const agent of [A, B]) expect((await api(s.url, 'POST', '/claims', { files: ['CHANGELOG.md'], mode: 'shared' }, agent)).json.status).toBe('granted');
    const up = await api(s.url, 'POST', '/claims', { files: ['CHANGELOG.md'], queue: true }, A);
    expect(up.json).toMatchObject({ status: 'queued', position: 1 });
    // What `hub hook pre-edit` sends: it may not join the shared holders ahead of A's queued upgrade.
    const hook = await api(s.url, 'POST', '/claims', { files: ['CHANGELOG.md'], mode: 'auto', queue: false }, C);
    expect(hook.status).toBe(200);
    expect(hook.json.status).toBe('denied');
    expect(hook.json.conflicts).toContainEqual(expect.objectContaining({ claim_id: up.json.claim.id, holder: A, status: 'queued' }));
    const second = await api(s.url, 'POST', '/claims', { files: ['CHANGELOG.md'], queue: true }, B);
    expect(second).toMatchObject({ status: 409, json: { error: { code: 'deadlock' } } });
    expect(second.json.error.message).toContain(A);
    const released = await api(s.url, 'POST', '/claims/release', { all: true }, B);
    expect(released.json.promoted.map((c: { id: string }) => c.id)).toEqual([up.json.claim.id]);
  });

  it('grants an edit-hook request past a waiter that waits for it, and says when a denial would deadlock', async () => {
    const s = await start();
    const C = 'lee/codex-1';
    const hookEdit = (agent: string, file: string) => api(s.url, 'POST', '/claims', { files: [file], mode: 'auto', queue: false }, agent);
    expect((await hookEdit(C, 'src/y.ts')).json.status).toBe('granted');
    const b = await api(s.url, 'POST', '/claims', { files: ['src/x.ts', 'src/y.ts'], queue: true }, B);
    expect(b.json.status).toBe('queued');
    // B waits for C's y.ts, so holding C's edit of x.ts back would leave both waiting for good.
    expect((await hookEdit(C, 'src/x.ts')).json).toMatchObject({ status: 'granted', claim: { holder: C } });

    // A holds z.ts and queues for C's x.ts, so C waiting for z.ts would never end.
    expect((await hookEdit(A, 'src/z.ts')).json.status).toBe('granted');
    const aWaits = await api(s.url, 'POST', '/claims', { files: ['src/x.ts'], queue: true }, A);
    expect(aWaits.json.status).toBe('queued');
    const denied = await hookEdit(C, 'src/z.ts');
    expect(denied.status).toBe(200);
    expect(denied.json).toMatchObject({ status: 'denied', conflicts: [expect.objectContaining({ holder: A, status: 'active' })] });
    expect(denied.json.deadlock).toContain(`${aWaits.json.claim.id} (${A}) waits for your`);
  });

  it('queues a request ahead of a waiter that waits for it, the way its direct request would go, and grants it on release', async () => {
    const s = await start();
    const C = 'lee/codex-1';
    expect((await api(s.url, 'POST', '/claims', { files: ['src/x.ts'] }, A)).json.status).toBe('granted');
    expect((await api(s.url, 'POST', '/claims', { files: ['src/z.ts'] }, C)).json.status).toBe('granted');
    const b = await api(s.url, 'POST', '/claims', { files: ['src/x.ts', 'src/z.ts'], queue: true }, B);
    expect(b.json.status).toBe('queued');
    // What the MCP claim tool sends by default: queued behind A only, not refused as a deadlock behind B.
    const c = await api(s.url, 'POST', '/claims', { files: ['src/x.ts'], queue: true }, C);
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ status: 'queued', position: 1, conflicts: [expect.objectContaining({ holder: A, status: 'active' })] });
    const released = await api(s.url, 'POST', '/claims/release', { all: true }, A);
    expect(released.json.promoted.map((x: { id: string }) => x.id)).toEqual([c.json.claim.id]);
    const after = await api(s.url, 'POST', '/claims/release', { all: true }, C);
    expect(after.json.promoted.map((x: { id: string }) => x.id)).toEqual([b.json.claim.id]);
  });

  it('refuses paths with control or bidi characters with 400 invalid_path, naming the path escaped', async () => {
    const s = await start();
    const forged = 'src/a.ts\n- C-9 src/x.ts — admin/ops (exclusive) \u001b[2K\u202eX';
    for (const [method, route, body] of [
      ['POST', '/claims', { files: [forged], intent: 'x' }],
      ['POST', '/claims', { scope: [{ file: forged }] }],
      ['POST', '/decisions', { summary: 's', files: [forged] }],
      ['POST', '/claims/check', { files: ['ok.ts', forged] }],
      ['POST', '/claims/release', { files: [forged] }],
      ['GET', `/claims?file=${encodeURIComponent(forged)}`, undefined],
    ] as const) {
      const r = await api(s.url, method, route, body, A);
      expect(r).toMatchObject({ status: 400, json: { error: { code: 'invalid_path' } } });
      expect(r.json.error.message).toContain(String.raw`"src/a.ts\n- C-9 src/x.ts — admin/ops (exclusive) \u001b[2K\u202eX"`);
    }
    expect((await api(s.url, 'GET', '/status', undefined, B)).json).toMatchObject({ claims: [], decisions: [] });
  });

  it('refuses a path with an unpaired surrogate escape, so two agents cannot both hold it', async () => {
    const s = await start();
    // JSON.stringify sends the lone surrogate as the escape \ud800, which JSON.parse on the hub turns back into one.
    for (const agent of [A, B]) {
      const r = await api(s.url, 'POST', '/claims', { files: ['x\ud800.ts'] }, agent);
      expect(r).toMatchObject({ status: 400, json: { error: { code: 'invalid_path' } } });
      expect(r.json.error.message).toContain(String.raw`"x\ud800.ts"`);
    }
    expect((await api(s.url, 'GET', '/status', undefined, B)).json).toMatchObject({ claims: [] });
  });

  it('checks a commit batch that includes a drive-letter-like name such as a:b.md', async () => {
    const s = await start();
    expect((await api(s.url, 'POST', '/claims', { files: ['src/auth.ts'] }, A)).json.status).toBe('granted');
    const r = await api(s.url, 'POST', '/claims/check', { files: ['src/auth.ts', 'a:b.md'] }, B);
    expect(r.status).toBe(200);
    expect(r.json.conflicts).toEqual([expect.objectContaining({ holder: A, files: ['src/auth.ts'] })]);
    expect((await api(s.url, 'POST', '/claims', { files: ['a:b.md'] }, B)).json.status).toBe('granted');
  });
});

describe('several hub processes on one database', () => {
  it("pushes the events another process committed before this process's own, in seq order", async () => {
    const db = path.join(tempDir(), 'hub.db');
    // No sweeps, so only this process's own commits can publish the other's events.
    const one = await startOn(db, { sweepIntervalMs: 600_000 });
    const two = await startOn(db, { sweepIntervalMs: 600_000 });
    await api(one.url, 'POST', '/claims', { files: ['a.ts'] }, A);
    const queued = (await api(one.url, 'POST', '/claims', { files: ['a.ts'], queue: true }, B)).json;
    expect(queued.status).toBe('queued');
    const f = feed(one.url, B, queued.seq);
    await f.waitFor((fr) => fr.type === 'hello');

    await api(two.url, 'POST', '/claims/release', { files: ['a.ts'] }, A);
    await api(two.url, 'POST', '/messages', { to: B, body: 'a.ts is yours' }, A);
    await api(one.url, 'POST', '/decisions', { summary: 'use argon2id' }, A);
    await f.waitFor(f.isEvent('decision.recorded'));
    expect(f.events().map((e) => e.type)).toEqual(['claim.released', 'claim.granted', 'message.posted', 'decision.recorded']);
    expect(f.events().map((e) => e.seq)).toEqual([queued.seq + 1, queued.seq + 2, queued.seq + 3, queued.seq + 4]);
    f.ws.close();
  });

  it('wakes feeds and long-polls on one hub-server process for a release and grant committed through another', async () => {
    const db = path.join(tempDir(), 'hub.db');
    new SqliteStore(db).close(); // create the schema up front
    const [one, two] = await Promise.all([startCli([], db), startCli([], db)]);
    expect((await api(two.url, 'POST', '/claims', { files: ['src/auth.ts'] }, A)).json.status).toBe('granted');
    const queued = (await api(one.url, 'POST', '/claims', { files: ['src/auth.ts'], queue: true }, B)).json;
    expect(queued.status).toBe('queued');
    const f = feed(one.url, B);
    await f.waitFor((fr) => fr.type === 'hello');

    const t0 = Date.now();
    const poll = api(one.url, 'GET', `/events?since=${queued.seq}&wait_ms=8000`, undefined, B);
    setTimeout(() => void api(two.url, 'POST', '/claims/release', { files: ['src/auth.ts'] }, A), 200);
    await f.waitFor(f.isEvent('claim.granted', (e) => e.data.claim_id === queued.claim.id), 4000);
    const { json } = await poll;
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(json.events.map((e: HubEvent) => e.type)).toEqual(['claim.released', 'claim.granted']);
    f.ws.close();
  });
});
