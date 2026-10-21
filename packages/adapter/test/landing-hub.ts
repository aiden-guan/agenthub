import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LANDER_LEASE_KEY, landRef } from '@agenthub/contract';
import { Hub, HubError, SqliteStore, startServer, type HubAuth, type LandingReport } from '@agenthub/hub';
import { git } from './helpers.js';

// Phase 2 test rig for the adapter (step A1). Lane H's HTTP routes for the
// landing queue (H4) aren't merged yet, so a small front server serves the
// design §1.7 routes over the real, merged `Hub` (H1-H3), computing `auth` from
// the headers the way the design says the server will, and passes every other
// request (Phase 1 routes, the WebSocket feed) through to the real server on
// the same Hub. Once H4 is merged this can be the real server alone.

export const LANDER = 'lander/testbox-4242-a1b2';
export const LANDER_TOKEN = 'lander-secret-for-tests';
export const PROJECT = 'demo';

export interface LandingHub {
  url: string;
  hub: Hub;
  close(): Promise<void>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Ctx = { project: string; agent: string | null; body: any; query: URLSearchParams; params: string[]; auth: HubAuth };
type Route = { method: string; pattern: RegExp; run: (c: Ctx) => unknown };

function routes(hub: Hub): Route[] {
  const r = (method: string, p: string, run: Route['run']): Route => ({ method, pattern: new RegExp(`^${p.replace(/:[a-z]+/g, '([^/]+)')}$`), run });
  const me = (c: Ctx) => {
    if (!c.agent) throw new HubError('bad_agent', 'send your agent id in the x-hub-agent header', 400);
    return c.agent;
  };
  const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : undefined);
  return [
    r('POST', '/claims', (c) => hub.claim(c.project, me(c), c.body, c.auth)),
    r('GET', '/landings', (c) => ({
      landings: hub.listLandings(c.project, {
        statuses: list(c.query.get('status')) as any,
        agent: c.query.get('agent') ?? undefined,
        task_id: c.query.get('task') ?? undefined,
        limit: c.query.has('limit') ? Number(c.query.get('limit')) : undefined,
      }),
    })),
    r('GET', '/landings/stats', (c) => hub.landingStats(c.project, c.query.get('days') ?? undefined)),
    r('GET', '/landings/:id', (c) => ({ landing: hub.getLanding(c.project, c.params[0]) })),
    r('POST', '/landings/:id/cancel', (c) => hub.cancelLanding(c.project, c.auth.approver ? null : me(c), c.params[0], c.body, c.auth)),
    r('POST', '/landings/:id/approve', (c) => hub.approveLanding(c.project, c.params[0], c.body, c.auth)),
    r('POST', '/landings/:id/reject', (c) => hub.rejectLanding(c.project, c.params[0], c.body, c.auth)),
    r('POST', '/landings/:id/admit', (c) => hub.admitLanding(c.project, me(c), c.params[0], c.body, c.auth)),
    r('POST', '/landings/:id/advance', (c) => hub.advanceLanding(c.project, me(c), c.params[0], c.body, c.auth)),
    r('POST', '/landings/:id/resolve', (c) => hub.resolveLanding(c.project, me(c), c.params[0], c.body, c.auth)),
    r('POST', '/lander/next', (c) => hub.nextLanding(c.project, me(c), c.body, c.auth)),
    r('POST', '/lander/trunk', (c) => hub.reportTrunk(c.project, me(c), c.body, c.auth)),
    r('POST', '/lander/pause', (c) => hub.pauseLander(c.project, me(c), c.body, c.auth)),
    r('POST', '/lander/resume', (c) => hub.resumeLander(c.project, c.body, c.auth)),
    r('GET', '/lander', (c) => hub.landerStatus(c.project)),
  ];
}

/** A real Hub behind the real server, with the Phase 2 routes in front. `approvers`: name → token (the hub keeps only digests). */
export async function startLandingHub(opts: { approvers?: Record<string, string>; leaseTtlMs?: number } = {}): Promise<LandingHub> {
  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: opts.leaseTtlMs });
  const backend = await startServer({ hub, port: 0, sweepIntervalMs: 100 });
  const approvers = new Map(Object.entries(opts.approvers ?? {}).map(([name, token]) => [name, sha256(token)]));
  const table = routes(hub);
  const header = (req: IncomingMessage, name: string): string | null => {
    const v = req.headers[name];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
  const authOf = (req: IncomingMessage): HubAuth => {
    const name = header(req, 'x-hub-approver');
    let approver: string | null = null;
    if (name !== null) {
      if (approvers.size === 0) throw new HubError('approvals_disabled', 'this hub has no --approvers file', 403);
      const want = approvers.get(name);
      if (!want || want !== sha256(header(req, 'x-hub-approver-token') ?? '')) throw new HubError('not_approver', `wrong approver token for ${name}`, 403);
      approver = name;
    }
    return { lander: header(req, 'x-hub-lander-token') === LANDER_TOKEN, approver };
  };

  const proxy = (req: IncomingMessage, res: ServerResponse) => {
    const up = httpRequest({ host: '127.0.0.1', port: backend.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
  };

  const front = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    const m = /^\/v1\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
    let hit: { route: Route; params: string[] } | null = null;
    if (m) {
      for (const route of table) {
        const pm = route.method === req.method ? route.pattern.exec(m[2]) : null;
        if (pm) {
          hit = { route, params: pm.slice(1).map(decodeURIComponent) };
          break;
        }
      }
    }
    if (!m || !hit) return proxy(req, res);
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = req.method === 'POST' && text ? JSON.parse(text) : {};
        const result = hit.route.run({ project: decodeURIComponent(m[1]), agent: header(req, 'x-hub-agent'), body, query: url.searchParams, params: hit.params, auth: authOf(req) });
        send(res, 200, result);
      } catch (err) {
        const e = err instanceof HubError ? err : new HubError('internal', (err as Error).message, 500);
        send(res, e.status, { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
      }
    });
  });

  const upgraded = new Set<Socket>();
  front.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on('error', () => {});
    upgraded.add(socket);
    const up = connect(backend.port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    up.on('close', () => socket.destroy());
    socket.on('close', () => {
      up.destroy();
      upgraded.delete(socket);
    });
  });

  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  const { port } = front.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    hub,
    close: async () => {
      for (const s of upgraded) s.destroy();
      front.closeAllConnections();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await backend.close();
    },
  };
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** The lander's side, played by the test over HTTP with the lander token: lease, admit, next, advance. */
export class TestLander {
  lease: { lease_claim_id: string; epoch: string } | null = null;
  constructor(
    readonly url: string,
    readonly id = LANDER,
  ) {}

  async call<T = any>(method: 'GET' | 'POST', p: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}/v1/p/${PROJECT}${p}`, {
      method,
      headers: { 'x-hub-agent': this.id, 'x-hub-lander-token': LANDER_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`lander ${method} ${p}: HTTP ${res.status} ${JSON.stringify(data)}`);
    return data as T;
  }

  async takeLease(): Promise<void> {
    const r = await this.call('POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 600_000, intent: 'lander on testbox' });
    const epoch = (await (await fetch(`${this.url}/v1/p/${PROJECT}/events?wait_ms=0`)).json()).epoch as string;
    this.lease = { lease_claim_id: r.claim.id, epoch };
  }

  admit(id: string, body: Record<string, unknown>) {
    return this.call('POST', `/landings/${id}/admit`, { lease: this.lease, files: [], scope: null, mapper: null, protected: [], required: [], waits_for: null, warnings: [], ...body });
  }

  next() {
    return this.call('POST', '/lander/next', { lease: this.lease });
  }

  advance(id: string, body: Record<string, unknown>) {
    return this.call('POST', `/landings/${id}/advance`, { lease: this.lease, ...body });
  }

  /** Admit, pick and run L to `landed` on `trunk_sha`, through the phases a real lander goes through. */
  async landIt(id: string, o: { base: string; trunkBase: string; candidate: string; files: string[]; report?: Partial<LandingReport> }): Promise<void> {
    await this.admit(id, { base_sha: o.base, files: o.files });
    const next = await this.next();
    if (next.landing?.id !== id) throw new Error(`next picked ${next.landing?.id}, not ${id}`);
    const attempt = next.landing.attempt;
    await this.advance(id, { attempt, to: 'running', phase: 'merging', deadline_ms: 600_000, trunk_base: o.trunkBase });
    await this.advance(id, { attempt, to: 'running', phase: 'checking', deadline_ms: 600_000 });
    const candidate_ref = `refs/agenthub/cand/00000000/${id}/${o.candidate.slice(0, 12)}`;
    await this.advance(id, { attempt, to: 'running', phase: 'pushing', candidate: o.candidate, candidate_ref, trunk_base: o.trunkBase, tree: o.candidate, required: [] });
    await this.advance(id, {
      attempt,
      to: 'landed',
      trunk_sha: o.candidate,
      base_sha: o.base,
      files: o.files,
      report: report({ message: `${id} landed.`, ...o.report }),
      also_landed: [],
      symbol_changes: [],
    });
  }

  /** Admit, pick and fail L with `code` and the report. */
  async failIt(id: string, o: { base: string; trunkBase: string; files: string[]; code: string; report: Partial<LandingReport> }): Promise<void> {
    await this.admit(id, { base_sha: o.base, files: o.files });
    const next = await this.next();
    const attempt = next.landing.attempt;
    await this.advance(id, { attempt, to: 'running', phase: 'merging', deadline_ms: 600_000, trunk_base: o.trunkBase });
    await this.advance(id, { attempt, to: 'failed', code: o.code, report: report(o.report) });
  }
}

/** A lander report with neutral defaults. */
export function report(extra: Partial<LandingReport> = {}): LandingReport {
  return { message: '', resolved_by: 'clean', files_via: [], conflicts: [], check: null, resolver: null, next_steps: [], warnings: [], foreign_commits: [], timings: null, ...extra };
}

export interface LandingRepo {
  dir: string;
  remote: string;
  /** Agent clones of the remote. */
  a: string;
  b: string;
  cleanup(): void;
}

/** The team config every landing test uses: the queue on, migrations protected. */
export const TEAM_CONFIG = {
  project: PROJECT,
  land: { check: 'node check.mjs', protected: [{ paths: ['migrations/**'], approvers: ['maya', 'sam'], distinct: true }] },
};

/** A bare remote seeded with a small project and agenthub.json (land section on), and two agent clones. */
export function makeLandingRepo(teamConfig: unknown = TEAM_CONFIG): LandingRepo {
  const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-land-'));
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seed);
  mkdirSync(path.join(seed, 'src'), { recursive: true });
  mkdirSync(path.join(seed, 'migrations'), { recursive: true });
  writeFileSync(path.join(seed, 'src', 'auth.ts'), 'export function login(user: string) {\n  return `session-${user}`;\n}\n');
  writeFileSync(path.join(seed, 'src', 'users.ts'), 'export const users = ["maya", "sam"];\n');
  writeFileSync(path.join(seed, 'migrations', '0001_init.sql'), 'create table users (id int);\n');
  writeFileSync(path.join(seed, 'check.mjs'), 'process.exit(0);\n');
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify(teamConfig, null, 2)}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const a = path.join(dir, 'wt-a');
  const b = path.join(dir, 'wt-b');
  git(dir, 'clone', '-q', remote, a);
  git(dir, 'clone', '-q', remote, b);
  git(a, 'checkout', '-q', '-b', 'agent-a');
  git(b, 'checkout', '-q', '-b', 'agent-b');
  return { dir, remote, a, b, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Commit `files` (path → content) in `wt` and return the new HEAD. */
export function commit(wt: string, files: Record<string, string>, message = 'change'): string {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(wt, p)), { recursive: true });
    writeFileSync(path.join(wt, p), content);
  }
  git(wt, 'add', '--', ...Object.keys(files));
  git(wt, 'commit', '-q', '-m', message);
  return git(wt, 'rev-parse', 'HEAD').trim();
}

/** The land refs on the remote: name → sha. */
export function landRefs(remote: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of git(remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/agenthub/').split('\n').filter(Boolean)) {
    const [name, sha] = line.split(' ');
    out[name] = sha;
  }
  return out;
}

export { landRef };
