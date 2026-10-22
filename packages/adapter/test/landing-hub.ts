import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LANDER_LEASE_KEY, landRef } from '@agenthub/contract';
import { Hub, SqliteStore, startServer, type LandingReport } from '@agenthub/hub';
import { git } from './helpers.js';

// Phase 2 test rig for the adapter: the real Hub behind H4's real server,
// with a lander token and, when given, approvers by token digest, so the
// adapter's tests also cover the hub's HTTP layer for the landing queue
// (design §1.7: the lander routes need x-hub-lander-token; approvals need
// x-hub-approver plus a token whose sha256 the hub was given, else
// approvals_disabled). Until CP1 this was a test front serving those routes
// over the merged Hub; the integrator ran the suite against the real server at
// CP1 and asked for the switch.

export const LANDER = 'lander/testbox-4242-a1b2';
export const LANDER_TOKEN = 'lander-secret-for-tests';
export const PROJECT = 'demo';

export interface LandingHub {
  url: string;
  hub: Hub;
  close(): Promise<void>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A real Hub behind the real server, on a random port. `approvers`: name → token (the hub keeps only digests). */
export async function startLandingHub(opts: { approvers?: Record<string, string>; leaseTtlMs?: number } = {}): Promise<LandingHub> {
  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: opts.leaseTtlMs });
  const approvers = opts.approvers ? Object.fromEntries(Object.entries(opts.approvers).map(([name, token]) => [name, `sha256:${sha256(token)}`])) : undefined;
  const server = await startServer({ hub, port: 0, sweepIntervalMs: 100, landerToken: LANDER_TOKEN, approvers });
  return { url: server.url, hub, close: () => server.close() };
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
    const { epoch } = (await (await fetch(`${this.url}/v1/p/${PROJECT}/events?wait_ms=0`)).json()) as { epoch: string };
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
