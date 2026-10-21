import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub, SqliteStore, type ApprovalRequirement, type Claim, type Landing, type LanderControl } from '../src/index.js';
import { phase1Landing } from '../src/landing-row.js';

// H1 (design §1.3): the Phase 2/3 migration, the landing row mapping, approvals,
// lander control, due work, symbol changes and durable transactions.

const here = path.dirname(fileURLToPath(import.meta.url));
const P = 'demo';
const A = 'maya/claude-1';
const B = 'sam/claude-1';
const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);
const sha = (c: string) => c.repeat(40);

/** The Phase 1 SCHEMA exactly as the Phase 1 hub (fix/phase1-review) created it. */
const PHASE1_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (project, kind)
);

CREATE TABLE IF NOT EXISTS agents (
  project TEXT NOT NULL,
  agent TEXT NOT NULL,
  client TEXT,
  branch TEXT,
  worktree TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (project, agent)
);

CREATE TABLE IF NOT EXISTS tasks (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  deps TEXT NOT NULL DEFAULT '[]',
  owner TEXT,
  status TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);

CREATE TABLE IF NOT EXISTS claims (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  holder TEXT NOT NULL,
  task_id TEXT,
  scope TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('exclusive', 'shared')),
  intent TEXT NOT NULL,
  base_commit TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'queued', 'released', 'expired')),
  created_at INTEGER NOT NULL,
  granted_at INTEGER,
  expires_at INTEGER NOT NULL,
  ttl_ms INTEGER NOT NULL,
  heartbeat_interval_ms INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  queue_order INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS claims_live ON claims (project, status, expires_at);
CREATE INDEX IF NOT EXISTS claims_due ON claims (status, expires_at);

-- One row per scope entry, so "who holds this file?" is an index lookup.
CREATE TABLE IF NOT EXISTS claim_files (
  project TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  file TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project, claim_id, file, symbol)
);
CREATE INDEX IF NOT EXISTS claim_files_by_file ON claim_files (project, file);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  channel TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_project ON messages (project, id);

CREATE TABLE IF NOT EXISTS inbox_cursors (
  project TEXT NOT NULL,
  agent TEXT NOT NULL,
  last_read INTEGER NOT NULL,
  PRIMARY KEY (project, agent)
);

CREATE TABLE IF NOT EXISTS decisions (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  agent TEXT NOT NULL,
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL,
  files TEXT NOT NULL,
  symbols TEXT NOT NULL,
  task_id TEXT,
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decisions
BEGIN SELECT RAISE(ABORT, 'decisions are append-only'); END;

CREATE TABLE IF NOT EXISTS landings (
  project TEXT NOT NULL,
  id TEXT NOT NULL,
  agent TEXT NOT NULL,
  task_id TEXT,
  branch TEXT,
  commit_sha TEXT,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (project, id)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT,
  at INTEGER NOT NULL,
  data TEXT NOT NULL,
  targets TEXT
);
CREATE INDEX IF NOT EXISTS events_by_project ON events (project, seq);
`;

const EPOCH = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const OLD_LANDINGS = [
  { project: P, id: 'L-1', agent: A, task_id: 'T-1', branch: 'agent-a', commit: 'abc123def456', summary: 'login takes options', status: 'recorded' as const, created_at: T0 - 50_000 },
  { project: P, id: 'L-2', agent: A, task_id: null, branch: null, commit: null, summary: '', status: 'recorded' as const, created_at: T0 - 40_000 },
];

/** A database file exactly as a Phase 1 hub left it: a live claim, a task in progress, two recorded landings. */
function phase1Database(file: string): void {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(PHASE1_SCHEMA);
  db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?)").run(EPOCH);
  db.prepare('INSERT INTO projects (id, created_at) VALUES (?, ?)').run(P, T0 - 100_000);
  const counter = db.prepare('INSERT INTO counters (project, kind, value) VALUES (?, ?, ?)');
  for (const [kind, value] of [['task', 1], ['task-order', 1], ['claim', 1], ['claim-order', 1], ['landing', 2], ['landing-order', 2]] as const) counter.run(P, kind, value);
  db.prepare(
    `INSERT INTO tasks (project, id, title, description, deps, owner, status, created_by, created_at, updated_at, seq)
     VALUES (?, 'T-1', 'Login options', '', '[]', ?, 'in_progress', ?, ?, ?, 1)`,
  ).run(P, A, A, T0 - 90_000, T0 - 80_000);
  db.prepare(
    `INSERT INTO claims (project, id, holder, task_id, scope, mode, intent, base_commit, status, created_at, granted_at,
                         expires_at, ttl_ms, heartbeat_interval_ms, ended_at, end_reason, queue_order)
     VALUES (?, 'C-1', ?, 'T-1', '[{"file":"src/auth.ts"}]', 'exclusive', 'edit login', NULL, 'active', ?, ?, ?, 60000, 15000, NULL, NULL, 1)`,
  ).run(P, A, T0 - 70_000, T0 - 70_000, T0 + 60_000);
  db.prepare("INSERT INTO claim_files (project, claim_id, file, symbol) VALUES (?, 'C-1', 'src/auth.ts', '')").run(P);
  const landing = db.prepare(
    `INSERT INTO landings (project, id, agent, task_id, branch, commit_sha, summary, status, created_at, seq)
     VALUES (@project, @id, @agent, @task_id, @branch, @commit, @summary, @status, @created_at, @seq)`,
  );
  OLD_LANDINGS.forEach((l, i) => landing.run({ ...l, seq: i + 1 }));
  db.prepare("INSERT INTO events (project, type, actor, at, data, targets) VALUES (?, 'land.requested', ?, ?, '{}', NULL)").run(P, A, T0 - 40_000);
  db.close();
}

const PHASE2_LANDING_COLUMNS = [
  'updated_at', 'queue_seq', 'phase', 'phase_at', 'attempt', 'lander', 'lease_claim_id', 'in_doubt', 'deadline_at', 'base_sha', 'first_base',
  'trunk_base', 'candidate', 'candidate_ref', 'candidate_checked', 'trunk_sha', 'files', 'scope', 'mapper', 'protected', 'approval', 'hold_ids',
  'report', 'failure', 'retries', 'retry_of', 'retry', 'supersedes', 'superseded_by', 'waits_for', 'landed_with', 'reconciled', 'started_at', 'ended_at',
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-store-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryStore(): SqliteStore {
  const store = new SqliteStore(':memory:');
  store.ensureProject(P, T0);
  cleanups.push(() => store.close());
  return store;
}

function columns(store: SqliteStore, table: string): string[] {
  return (store.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

function schemaObjects(store: SqliteStore): string[] {
  return store.db.prepare("SELECT type || ' ' || name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1").pluck().all() as string[];
}

/** A landing in the given state with neutral Phase 2 fields, as the Hub would build it. */
function landing(id: string, over: Partial<Landing> = {}): Landing {
  return {
    ...phase1Landing({ id, project: P, agent: A, task_id: null, branch: null, commit: sha('a'), summary: '', status: 'submitted', created_at: T0 }),
    ...over,
  };
}

const REQUIREMENT: ApprovalRequirement = {
  kind: 'protected',
  digest: '2c0c16c3025564058c6cb19167011763864f3056d6066b8cec2ee067e161f00e',
  paths: ['migrations/0042_login_options.sql'],
  rules: [
    { paths: ['migrations/**'], approvers: null, distinct: true },
    { paths: ['package.json'], approvers: ['maya', 'sam'], distinct: false },
  ],
  candidate: null,
  candidate_ref: null,
  trunk_base: null,
};

/** Every stored landing field set to a non-neutral value (the report and scope come from the frozen fixture). */
function everyField(): Landing {
  const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'contract', 'landing.get.response.json'), 'utf8')).landing as Landing;
  return {
    ...fixture,
    project: P,
    id: 'L-6',
    agent: A,
    status: 'running',
    created_at: T0,
    updated_at: T0 + 9_000,
    queue_seq: 5,
    position: null,
    eta_ms: null,
    phase: 'pushing',
    phase_at: T0 + 8_000,
    attempt: 3,
    in_doubt: true,
    deadline_at: T0 + 600_000,
    candidate_checked: true,
    trunk_sha: sha('c'),
    protected: ['migrations/0042_login_options.sql'],
    approval: [REQUIREMENT, { ...REQUIREMENT, kind: 'merged', digest: 'b'.repeat(64), candidate: sha('6'), candidate_ref: 'refs/agenthub/cand/1b4e28ba/L-6/666666666666', trunk_base: sha('1') }],
    approvals: [],
    hold_ids: ['C-3', 'C-4'],
    retries: { trunk_moved: 1, lander_lost: 2, step_timeout: 1 },
    retry_of: 'L-4',
    retry: 2,
    supersedes: 'L-5',
    superseded_by: 'L-8',
    waits_for: 'L-3',
    landed_with: 'L-7',
    reconciled: true,
    started_at: T0 + 1_000,
    ended_at: T0 + 10_000,
  };
}

describe('migration from a Phase 1 database', () => {
  it('keeps the claims, tasks and landings, and reads old landings as recorded with neutral defaults', () => {
    const file = path.join(tempDir(), 'hub.db');
    phase1Database(file);

    const store = new SqliteStore(file);
    cleanups.push(() => store.close());
    expect(store.epoch()).toBe(EPOCH);
    expect(columns(store, 'claims').slice(-2)).toEqual(['landing_id', 'mapper']);
    expect(columns(store, 'landings')).toEqual([
      'project', 'id', 'agent', 'task_id', 'branch', 'commit_sha', 'summary', 'status', 'created_at', 'seq', ...PHASE2_LANDING_COLUMNS,
    ]);
    expect(schemaObjects(store)).toEqual(
      expect.arrayContaining([
        'index claims_by_landing',
        'index landings_queue',
        'index landings_by_commit',
        'index landings_due',
        'index landings_one_running',
        'table landing_approvals',
        'trigger landing_approvals_no_update',
        'trigger landing_approvals_no_delete',
        'table lander_control',
        'table symbol_changes',
        'index symbol_changes_recent',
        'index symbol_changes_open',
      ]),
    );

    expect(store.getTask(P, 'T-1')).toMatchObject({ id: 'T-1', owner: A, status: 'in_progress', title: 'Login options' });
    expect(store.getClaim(P, 'C-1')).toEqual({
      id: 'C-1', project: P, holder: A, task_id: 'T-1', scope: [{ file: 'src/auth.ts' }], mode: 'exclusive', intent: 'edit login', base_commit: null,
      status: 'active', created_at: T0 - 70_000, granted_at: T0 - 70_000, expires_at: T0 + 60_000, ttl_ms: 60_000, heartbeat_interval_ms: 15_000,
      ended_at: null, end_reason: null, landing_id: null, mapper: null,
    } satisfies Claim);
    const [l1, l2] = OLD_LANDINGS;
    expect(store.getLanding(P, 'L-1')).toEqual({ ...phase1Landing(l1), seq: 1 });
    expect(store.getLanding(P, 'L-2')).toEqual({ ...phase1Landing(l2), seq: 2 });
    expect(store.getLanding(P, 'L-1')).toMatchObject({ status: 'recorded', updated_at: l1.created_at, files: [], retries: { trunk_moved: 0, lander_lost: 0, step_timeout: 0 } });
    expect(store.listLandings(P, { order: 'recent' }).map((l) => l.id)).toEqual(['L-2', 'L-1']);
    expect(store.getLanderControl(P)).toEqual({
      paused: null,
      trunk: null,
      policy: { keep_place_retries: 2, sendback_grace_min: 30, approval_timeout_hours: 24, claim_gate: 'fail' },
    } satisfies LanderControl);

    // The hub on the upgraded file: the old lease still holds its file, the old
    // landings list as Phase 1 listed them, and new ids carry on from the counters.
    const hub = new Hub({ store, now: () => T0 + 1_000, leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
    expect(hub.claim(P, B, { files: ['src/auth.ts'] })).toMatchObject({ status: 'denied', conflicts: [expect.objectContaining({ claim_id: 'C-1', holder: A })] });
    expect(hub.status(P, A).landings.map((l) => [l.id, l.status])).toEqual([['L-2', 'recorded'], ['L-1', 'recorded']]);
    const third = hub.land(P, A, { summary: 'docs' }).landing;
    expect(third.id).toBe('L-3');
    expect(store.getLanding(P, 'L-3')).toEqual({ ...third, seq: 3 });
  });

  it('runs once: reopening the file changes nothing', () => {
    const file = path.join(tempDir(), 'hub.db');
    phase1Database(file);
    const first = new SqliteStore(file);
    const shape = { landings: columns(first, 'landings'), claims: columns(first, 'claims'), objects: schemaObjects(first) };
    first.close();
    const again = new SqliteStore(file);
    cleanups.push(() => again.close());
    expect({ landings: columns(again, 'landings'), claims: columns(again, 'claims'), objects: schemaObjects(again) }).toEqual(shape);
    expect(again.listLandings(P, { order: 'recent' }).map((l) => l.id)).toEqual(['L-2', 'L-1']);
  });

  it('a new database gets the same columns as an upgraded one', () => {
    const file = path.join(tempDir(), 'hub.db');
    phase1Database(file);
    const upgraded = new SqliteStore(file);
    cleanups.push(() => upgraded.close());
    const fresh = memoryStore();
    for (const table of ['claims', 'landings', 'landing_approvals', 'lander_control', 'symbol_changes']) {
      expect(columns(fresh, table)).toEqual(columns(upgraded, table));
    }
    expect(schemaObjects(fresh)).toEqual(schemaObjects(upgraded));
  });

  it('separate processes opening one Phase 1 file at once all succeed, and the columns are added once', async () => {
    const file = path.join(tempDir(), 'hub.db');
    phase1Database(file);
    const startAt = Date.now() + 1500;
    const runs = Array.from(
      { length: 4 },
      () =>
        new Promise<{ status: string | null }>((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(here, 'fixtures', 'open-child.mjs'), file, String(startAt)]);
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (err += d));
          child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`))));
        }),
    );
    expect(await Promise.all(runs)).toEqual(Array.from({ length: 4 }, () => ({ status: 'recorded' })));
    const store = new SqliteStore(file);
    cleanups.push(() => store.close());
    expect(columns(store, 'landings').slice(10)).toEqual(PHASE2_LANDING_COLUMNS);
  });
});

describe('landing rows', () => {
  it('round-trip every column, JSON ones included; position and eta_ms are not stored', () => {
    const store = memoryStore();
    const full = everyField();
    store.insertLanding({ ...full, position: 2, eta_ms: 90_000 });
    expect(store.getLanding(P, 'L-6')).toEqual({ ...full, seq: 1 });
    expect(store.getLanding(P, 'L-404')).toBeNull();
  });

  it('updateLanding writes every patchable column, and back to neutral values', () => {
    const store = memoryStore();
    const full = everyField();
    const blank = landing('L-6', { agent: A, created_at: T0 });
    store.insertLanding(blank);
    expect(store.getLanding(P, 'L-6')).toEqual({ ...blank, seq: 1 });

    const { id: _id, project: _project, agent: _agent, created_at: _created, position: _position, eta_ms: _eta, approvals: _approvals, ...patch } = full;
    store.updateLanding(P, 'L-6', patch);
    expect(store.getLanding(P, 'L-6')).toEqual({ ...full, seq: 1 });

    // A partial patch leaves the other columns alone; null clears the nullable JSON ones.
    store.updateLanding(P, 'L-6', { status: 'failed', phase: null, scope: null, report: null, failure: null, in_doubt: false, files: [] });
    expect(store.getLanding(P, 'L-6')).toEqual({ ...full, seq: 1, status: 'failed', phase: null, scope: null, report: null, failure: null, in_doubt: false, files: [] });
    store.updateLanding(P, 'L-6', {});
    expect(store.getLanding(P, 'L-6')).toMatchObject({ status: 'failed', queue_seq: 5 });
  });

  it('a commit filter finds the landing of an (agent, commit)', () => {
    const store = memoryStore();
    store.insertLanding(landing('L-1', { commit: sha('a') }));
    store.insertLanding(landing('L-2', { commit: sha('b') }));
    store.insertLanding(landing('L-3', { commit: sha('b'), agent: B }));
    expect(store.listLandings(P, { agent: A, commit: sha('b'), order: 'recent' }).map((l) => l.id)).toEqual(['L-2']);
  });

  it('listLandings orders by queue_seq for the queue and by seq descending for recent, with filters and a limit', () => {
    const store = memoryStore();
    store.insertLanding(landing('L-1', { status: 'recorded', queue_seq: null }));
    store.insertLanding(landing('L-2', { status: 'queued', queue_seq: 3 }));
    store.insertLanding(landing('L-3', { status: 'submitted', queue_seq: 1, task_id: 'T-1' }));
    store.insertLanding(landing('L-4', { status: 'running', queue_seq: 2, agent: B, phase: 'merging' }));
    store.insertLanding(landing('L-5', { status: 'failed', queue_seq: 4, task_id: 'T-1' }));
    store.insertLanding(landing('L-6', { status: 'queued', queue_seq: 1, agent: B, branch: 'b-1' }));

    const ids = (ls: Landing[]) => ls.map((l) => l.id);
    // Equal queue_seqs (an inherited place) run in the order they were made; rows without one come last.
    expect(ids(store.listLandings(P, { order: 'queue' }))).toEqual(['L-3', 'L-6', 'L-4', 'L-2', 'L-5', 'L-1']);
    expect(ids(store.listLandings(P, { order: 'recent' }))).toEqual(['L-6', 'L-5', 'L-4', 'L-3', 'L-2', 'L-1']);
    const live = ['submitted', 'queued', 'needs_approval', 'running'] as const;
    expect(ids(store.listLandings(P, { statuses: [...live], order: 'queue' }))).toEqual(['L-3', 'L-6', 'L-4', 'L-2']);
    expect(ids(store.listLandings(P, { statuses: [...live], order: 'queue', limit: 2 }))).toEqual(['L-3', 'L-6']);
    expect(ids(store.listLandings(P, { order: 'recent', limit: 3 }))).toEqual(['L-6', 'L-5', 'L-4']);
    expect(ids(store.listLandings(P, { agent: B, order: 'recent' }))).toEqual(['L-6', 'L-4']);
    expect(ids(store.listLandings(P, { agent: A, task_id: 'T-1', order: 'recent' }))).toEqual(['L-5', 'L-3']);
    expect(ids(store.listLandings(P, { agent: A, task_id: null, order: 'recent' }))).toEqual(['L-2', 'L-1']);
    expect(ids(store.listLandings(P, { branch: 'b-1', order: 'recent' }))).toEqual(['L-6']);
    expect(ids(store.listLandings(P, { statuses: ['failed'], agent: A, task_id: 'T-1', order: 'recent', limit: 1 }))).toEqual(['L-5']);
    expect(store.listLandings(P, { statuses: [], order: 'recent' })).toEqual([]);
    expect(store.listLandings('other', { order: 'recent' })).toEqual([]);
  });

  it('a second running landing in one project violates landings_one_running', () => {
    const store = memoryStore();
    store.insertLanding(landing('L-1', { status: 'running', phase: 'merging' }));
    expect(() => store.insertLanding(landing('L-2', { status: 'running', phase: 'merging' }))).toThrow(/UNIQUE/);
    store.insertLanding(landing('L-2', { status: 'queued' }));
    expect(() => store.updateLanding(P, 'L-2', { status: 'running' })).toThrow(/UNIQUE/);
    expect(store.getLanding(P, 'L-2')!.status).toBe('queued');
    // Another project has its own running slot, and the slot frees when the landing leaves running.
    store.ensureProject('other', T0);
    store.insertLanding({ ...landing('L-1', { status: 'running' }), project: 'other' });
    store.updateLanding(P, 'L-1', { status: 'landed' });
    store.updateLanding(P, 'L-2', { status: 'running' });
    expect(store.listLandings(P, { statuses: ['running'], order: 'queue' }).map((l) => l.id)).toEqual(['L-2']);
  });
});

describe('approvals', () => {
  it('are appended in order, and a landing lists the granted ones', () => {
    const store = memoryStore();
    store.insertLanding(landing('L-1'));
    store.insertLanding(landing('L-2'));
    const base = { project: P, landing_id: 'L-1', kind: 'protected' as const, digest: REQUIREMENT.digest, carried_from: null };
    expect(store.insertApproval({ ...base, approver: 'lee', decision: 'reject', note: 'not yet', at: T0 + 1 })).toMatchObject({ n: 1 });
    expect(store.insertApproval({ ...base, approver: 'sam', decision: 'approve', note: 'ok', at: T0 + 2 })).toMatchObject({ n: 2 });
    expect(store.insertApproval({ ...base, kind: 'merged', digest: 'b'.repeat(64), approver: 'lee', decision: 'approve', note: '', at: T0 + 3, carried_from: 'L-0' }).n).toBe(3);
    expect(store.insertApproval({ ...base, landing_id: 'L-2', approver: 'sam', decision: 'approve', note: '', at: T0 + 4 }).n).toBe(1);

    expect(store.listApprovals(P, 'L-1').map((a) => [a.n, a.approver, a.decision])).toEqual([
      [1, 'lee', 'reject'],
      [2, 'sam', 'approve'],
      [3, 'lee', 'approve'],
    ]);
    expect(store.listApprovals(P, 'L-1')[0]).toEqual({ ...base, n: 1, approver: 'lee', decision: 'reject', note: 'not yet', at: T0 + 1 });
    expect(store.getLanding(P, 'L-1')!.approvals).toEqual([
      { kind: 'protected', digest: REQUIREMENT.digest, by: 'sam', at: T0 + 2, note: 'ok', carried_from: null },
      { kind: 'merged', digest: 'b'.repeat(64), by: 'lee', at: T0 + 3, note: '', carried_from: 'L-0' },
    ]);
    expect(store.listLandings(P, { order: 'queue' }).map((l) => l.approvals.length)).toEqual([2, 1]);
    expect(store.listApprovals(P, 'L-3')).toEqual([]);
  });

  it('can be neither changed nor deleted', () => {
    const store = memoryStore();
    store.insertApproval({ project: P, landing_id: 'L-1', kind: 'protected', digest: 'd', approver: 'sam', decision: 'approve', note: '', carried_from: null, at: T0 });
    expect(() => store.db.prepare("UPDATE landing_approvals SET decision = 'reject'").run()).toThrow(/append-only/);
    expect(() => store.db.prepare('DELETE FROM landing_approvals').run()).toThrow(/append-only/);
    expect(() => store.db.prepare("INSERT INTO landing_approvals VALUES (?, 'L-1', 2, 'other', 'd', 'sam', 'approve', '', NULL, 0)").run(P)).toThrow(/CHECK/);
    expect(store.listApprovals(P, 'L-1')).toHaveLength(1);
  });
});

describe('lander control', () => {
  it('reads defaults until written, and keeps what a partial write leaves out', () => {
    const store = memoryStore();
    const defaults = store.getLanderControl(P);
    expect(defaults).toEqual({ paused: null, trunk: null, policy: { keep_place_retries: 2, sendback_grace_min: 30, approval_timeout_hours: 24, claim_gate: 'fail' } });

    const trunk = { sha: sha('1'), landing_id: 'L-5', at: T0 };
    expect(store.putLanderControl(P, { trunk }, T0)).toEqual({ ...defaults, trunk });
    const paused = { reason: 'trunk_rewritten' as const, detail: `${sha('1')} -> ${sha('2')}`, at: T0 + 1, by: 'lander/build1-1-abcd' };
    store.putLanderControl(P, { paused }, T0 + 1);
    const policy = { keep_place_retries: 1, sendback_grace_min: 10, approval_timeout_hours: 2, claim_gate: 'warn' as const };
    store.putLanderControl(P, { policy }, T0 + 2);
    expect(store.getLanderControl(P)).toEqual({ paused, trunk, policy });
    store.putLanderControl(P, { paused: null }, T0 + 3);
    expect(store.getLanderControl(P)).toEqual({ paused: null, trunk, policy });
    expect(store.db.prepare('SELECT updated_at FROM lander_control WHERE project = ?').pluck().get(P)).toBe(T0 + 3);
    expect(store.getLanderControl('other')).toEqual(defaults);
  });
});

describe('projectsWithDueWork', () => {
  it('finds a due claim, a running landing past its deadline (not in pushing) and an expired needs_approval', () => {
    const store = memoryStore();
    const now = T0 + 60_000;
    const at = (project: string, l: Landing) => {
      store.ensureProject(project, T0);
      store.insertLanding({ ...l, project });
    };
    const claim = (project: string, id: string, status: Claim['status'], expires_at: number): Claim => ({
      id, project, holder: A, task_id: null, scope: [{ file: 'a.ts' }], mode: 'exclusive', intent: '', base_commit: null, status,
      created_at: T0, granted_at: T0, expires_at, ttl_ms: 60_000, heartbeat_interval_ms: 15_000, ended_at: null, end_reason: null, landing_id: null, mapper: null,
    });
    expect(store.projectsWithDueWork(now)).toEqual([]);

    store.ensureProject('claim-due', T0);
    store.insertClaim(claim('claim-due', 'C-1', 'queued', now));
    store.ensureProject('claim-ended', T0);
    store.insertClaim(claim('claim-ended', 'C-1', 'expired', T0));
    store.ensureProject('hold', T0);
    store.insertClaim({ ...claim('hold', 'C-1', 'active', 8_640_000_000_000_000), landing_id: 'L-1' });
    at('step-due', landing('L-1', { status: 'running', phase: 'checking', deadline_at: now }));
    at('step-later', landing('L-1', { status: 'running', phase: 'merging', deadline_at: now + 1 }));
    at('pushing', landing('L-1', { status: 'running', phase: 'pushing', deadline_at: T0, in_doubt: true }));
    at('approval-due', landing('L-1', { status: 'needs_approval', deadline_at: T0 }));
    at('approval-later', landing('L-1', { status: 'needs_approval', deadline_at: now + 1 }));
    at('queued', landing('L-1', { status: 'queued', deadline_at: T0 }));
    at('no-deadline', landing('L-1', { status: 'running', phase: 'merging', deadline_at: null }));

    expect(store.projectsWithDueWork(now)).toEqual(['approval-due', 'claim-due', 'step-due']);
    expect(store.projectsWithDueWork(now + 1)).toEqual(['approval-due', 'approval-later', 'claim-due', 'step-due', 'step-later']);
  });

  it('drives the hub sweep', () => {
    const clock = { t: T0 };
    const store = new SqliteStore(':memory:');
    cleanups.push(() => store.close());
    const hub = new Hub({ store, now: () => clock.t, leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
    hub.claim(P, A, { files: ['a.ts'] });
    expect(hub.sweep()).toEqual([]);
    clock.t += 60_000;
    expect(hub.sweep()).toEqual([P]);
    expect(store.getClaim(P, 'C-1')!.status).toBe('expired');
  });
});

describe('claims with landing_id and mapper', () => {
  it('store, patch and filter them', () => {
    const store = memoryStore();
    const hold: Claim = {
      id: 'C-1', project: P, holder: A, task_id: 'T-1', scope: [{ file: 'src/auth.ts', symbol: 'login' }, { file: 'src/x.ts' }], mode: 'exclusive',
      intent: 'landing L-1: login options', base_commit: null, status: 'active', created_at: T0, granted_at: T0, expires_at: 8_640_000_000_000_000,
      ttl_ms: 60_000, heartbeat_interval_ms: 15_000, ended_at: null, end_reason: null, landing_id: 'L-1', mapper: 'sym1;m',
    };
    store.insertClaim(hold);
    store.insertClaim({ ...hold, id: 'C-2', landing_id: null, mapper: null, scope: [{ file: 'b.ts' }], expires_at: T0 + 60_000 });
    expect(store.getClaim(P, 'C-1')).toEqual(hold);
    expect(store.listClaims(P, { statuses: ['active'], landing_id: 'L-1' }).map((c) => c.id)).toEqual(['C-1']);
    expect(store.listClaims(P, { statuses: ['active'], landing_id: null }).map((c) => c.id)).toEqual(['C-2']);
    expect(store.claimsForFiles(P, ['src/auth.ts'], ['active']).map((c) => c.id)).toEqual(['C-1']);

    // Failure effects turn a hold back into a lease; supersede moves it to another landing and holder-side fields stay.
    store.updateClaim(P, 'C-1', { landing_id: null, expires_at: T0 + 1_800_000 });
    expect(store.getClaim(P, 'C-1')).toEqual({ ...hold, landing_id: null, expires_at: T0 + 1_800_000 });
    store.updateClaim(P, 'C-1', { landing_id: 'L-2', mapper: 'sym2;m', holder: B });
    expect(store.getClaim(P, 'C-1')).toMatchObject({ landing_id: 'L-2', mapper: 'sym2;m', holder: B });
    expect(store.listClaims(P, { statuses: ['active'], holder: B }).map((c) => c.id)).toEqual(['C-1']);
  });

  it('a claim built without the Phase 2 fields reads them as null', () => {
    const store = memoryStore();
    const old = {
      id: 'C-1', project: P, holder: A, task_id: null, scope: [{ file: 'a.ts' }], mode: 'exclusive' as const, intent: '', base_commit: null, status: 'active' as const,
      created_at: T0, granted_at: T0, expires_at: T0 + 60_000, ttl_ms: 60_000, heartbeat_interval_ms: 15_000, ended_at: null, end_reason: null,
    };
    store.insertClaim(old as Claim);
    expect(store.getClaim(P, 'C-1')).toEqual({ ...old, landing_id: null, mapper: null });
  });
});

describe('symbol changes', () => {
  const change = (over: Record<string, unknown> = {}) => ({
    project: P,
    agent: A,
    task_id: 'T-1',
    landing_id: null,
    file: 'src/auth.ts',
    symbol: 'login',
    name: 'login',
    kind: 'signature' as const,
    before: 'login(user: string, password: string): Promise<Session>',
    after: 'login(user: string, opts: LoginOptions): Promise<Session>',
    renamed_to: null,
    status: 'in_progress' as const,
    created_at: T0,
    updated_at: T0,
    ...over,
  });

  it('upserts the in-progress row of an (agent, file, symbol) in place', () => {
    const store = memoryStore();
    const first = store.upsertSymbolChange(change());
    expect(first).toEqual({ id: 'S-1', ...change() });
    const again = store.upsertSymbolChange(change({ after: 'login(opts: LoginOptions): Promise<Session>', updated_at: T0 + 5, created_at: T0 + 5 }));
    expect(again).toEqual({ id: 'S-1', ...change({ after: 'login(opts: LoginOptions): Promise<Session>', updated_at: T0 + 5 }) });
    // Another agent, another symbol, another file: their own rows.
    expect(store.upsertSymbolChange(change({ agent: B })).id).toBe('S-2');
    expect(store.upsertSymbolChange(change({ symbol: 'Session.refresh', name: 'refresh' })).id).toBe('S-3');
    expect(store.upsertSymbolChange(change({ file: 'src/other.ts' })).id).toBe('S-4');
    expect(store.listSymbolChanges(P, { since: 0, statuses: ['in_progress'] })).toHaveLength(4);
    // The database refuses a second open row for one key.
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO symbol_changes (project, id, agent, task_id, landing_id, file, symbol, name, kind, before, after, renamed_to, status, created_at, updated_at)
           VALUES (?, 'S-99', ?, NULL, NULL, 'src/auth.ts', 'login', 'login', 'signature', 'a', 'b', NULL, 'in_progress', 0, 0)`,
        )
        .run(P, A),
    ).toThrow(/UNIQUE/);
  });

  it('a withdrawn or superseded row frees the key, and landed rows are always new', () => {
    const store = memoryStore();
    store.upsertSymbolChange(change());
    store.upsertSymbolChange(change({ symbol: 'logout', name: 'logout', task_id: 'T-2' }));
    const withdrawn = store.updateSymbolChanges({ project: P, agent: A, file: 'src/auth.ts', symbol: 'login', statuses: ['in_progress'] }, { status: 'withdrawn', updated_at: T0 + 1 });
    expect(withdrawn).toEqual([{ id: 'S-1', ...change({ status: 'withdrawn', updated_at: T0 + 1 }) }]);
    expect(store.upsertSymbolChange(change({ updated_at: T0 + 2, created_at: T0 + 2 })).id).toBe('S-3');

    const landed = store.upsertSymbolChange(change({ status: 'landed', landing_id: 'L-1', updated_at: T0 + 3, created_at: T0 + 3 }));
    expect(landed).toMatchObject({ id: 'S-4', status: 'landed', landing_id: 'L-1' });
    expect(store.upsertSymbolChange(change({ status: 'landed', landing_id: 'L-2', updated_at: T0 + 4, created_at: T0 + 4 })).id).toBe('S-5');
    // Landed rows supersede the author's in-progress rows for the task.
    const superseded = store.updateSymbolChanges({ project: P, agent: A, task_id: 'T-1', statuses: ['in_progress'] }, { status: 'superseded', updated_at: T0 + 5 });
    expect(superseded.map((c) => [c.id, c.status])).toEqual([['S-3', 'superseded']]);
    expect(store.updateSymbolChanges({ project: P, ids: ['S-2'] }, { landing_id: 'L-3', updated_at: T0 + 6 }).map((c) => c.landing_id)).toEqual(['L-3']);
    expect(store.updateSymbolChanges({ project: P, ids: [] }, { status: 'withdrawn' })).toEqual([]);

    const ids = (statuses: Parameters<SqliteStore['listSymbolChanges']>[1]['statuses'], since = 0) => store.listSymbolChanges(P, { since, statuses }).map((c) => c.id);
    // Newest first.
    expect(ids(['in_progress', 'landed'])).toEqual(['S-2', 'S-5', 'S-4']);
    expect(ids(['in_progress', 'landed', 'withdrawn', 'superseded'])).toEqual(['S-2', 'S-3', 'S-5', 'S-4', 'S-1']);
    expect(ids(['in_progress', 'landed', 'withdrawn', 'superseded'], T0 + 4)).toEqual(['S-2', 'S-3', 'S-5']);
    expect(ids(['withdrawn'])).toEqual(['S-1']);
    expect(store.listSymbolChanges(P, { since: 0, statuses: ['landed'], limit: 1 }).map((c) => c.id)).toEqual(['S-5']);
    expect(store.listSymbolChanges('other', { since: 0, statuses: ['landed'] })).toEqual([]);
  });

  it('keep the renamed and removed shapes', () => {
    const store = memoryStore();
    const renamed = store.upsertSymbolChange(change({ symbol: 'rememberDays', name: 'rememberDays', kind: 'renamed', renamed_to: 'sessionDays', after: 'sessionDays(): number' }));
    const removed = store.upsertSymbolChange(change({ symbol: 'logout', name: 'logout', kind: 'removed', after: null }));
    expect(store.listSymbolChanges(P, { since: 0, statuses: ['in_progress'] })).toEqual([removed, renamed]);
    expect(renamed).toMatchObject({ kind: 'renamed', renamed_to: 'sessionDays' });
    expect(removed).toMatchObject({ kind: 'removed', after: null, renamed_to: null });
  });
});

describe('durable transactions', () => {
  it('commit with PRAGMA synchronous = FULL (2) and restore NORMAL (1) after, even when they throw', () => {
    const store = new SqliteStore(path.join(tempDir(), 'hub.db'));
    cleanups.push(() => store.close());
    const sync = () => store.db.pragma('synchronous', { simple: true });
    expect(sync()).toBe(1);
    expect(store.transaction(() => sync(), { durable: true })).toBe(2);
    expect(sync()).toBe(1);
    expect(store.transaction(() => sync())).toBe(1);
    expect(store.transaction(() => sync(), { durable: false })).toBe(1);
    expect(() =>
      store.transaction(
        () => {
          store.ensureProject('rolled-back', T0);
          throw new Error('boom');
        },
        { durable: true },
      ),
    ).toThrow('boom');
    expect(sync()).toBe(1);
    expect(store.listProjects()).not.toContain('rolled-back');

    // Nested: an inner transaction commits with the outer one, so it is as durable as that one.
    expect(store.transaction(() => store.transaction(() => sync()), { durable: true })).toBe(2);
    expect(store.transaction(() => store.transaction(() => sync(), { durable: true }), { durable: true })).toBe(2);
    expect(() => store.transaction(() => store.transaction(() => sync(), { durable: true }))).toThrow(/durable/);
    expect(sync()).toBe(1);
  });

  it('write what they commit', () => {
    const file = path.join(tempDir(), 'hub.db');
    const store = new SqliteStore(file);
    store.ensureProject(P, T0);
    store.transaction(() => store.insertLanding(landing('L-1', { status: 'running', phase: 'pushing', candidate: sha('c') })), { durable: true });
    store.close();
    const again = new SqliteStore(file);
    cleanups.push(() => again.close());
    expect(again.getLanding(P, 'L-1')).toMatchObject({ status: 'running', phase: 'pushing', candidate: sha('c') });
  });
});
