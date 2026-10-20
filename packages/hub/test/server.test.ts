import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Hub, SqliteStore, startServer, type FeedServerFrame, type HubEvent, type RunningServer } from '../src/index.js';

const A = 'maya/claude-1';
const B = 'sam/claude-1';
const here = path.dirname(fileURLToPath(import.meta.url));

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(opts: { leaseTtlMs?: number; heartbeatIntervalMs?: number; sweepIntervalMs?: number; token?: string } = {}) {
  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: opts.leaseTtlMs, heartbeatIntervalMs: opts.heartbeatIntervalMs });
  const server = await startServer({ hub, port: 0, sweepIntervalMs: opts.sweepIntervalMs, token: opts.token });
  servers.push(server);
  return server;
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
});
