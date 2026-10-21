import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { DEFAULT_LAND_POLICY, defaultLanderControl } from './landing-row.js';
import {
  PATH_FORBIDDEN_RE,
  type Claim,
  type ClaimStatus,
  type Decision,
  type HubEvent,
  type Landing,
  type LandingApproval,
  type LandingStatus,
  type LanderControl,
  type Message,
  type SymbolChangeStatus,
  type Task,
} from './protocol.js';
import type {
  AgentRow,
  AgentTouch,
  ApprovalRow,
  ClaimFilter,
  ClaimPatch,
  LandingFilter,
  LandingPatch,
  Store,
  SymbolChangeFilter,
  SymbolChangePatch,
  SymbolChangeRow,
  TransactionOptions,
} from './store.js';

const SCHEMA = `
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

const RETRIES_NONE = '{"trunk_moved":0,"lander_lost":0,"step_timeout":0}';

/**
 * Columns Phases 2 and 3 add to Phase 1 tables (design §1.3), in this order.
 * Each is added only when `PRAGMA table_info` doesn't list it, so a Phase 1
 * database opens and keeps its rows, and a new one gets the same columns.
 */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: 'claims' | 'landings', column: string, declaration: string]> = [
  // claims: holds and symbol mapping
  ['claims', 'landing_id', 'TEXT'], // set while the claim is a landing hold
  ['claims', 'mapper', 'TEXT'], // MAPPER_VERSION of its symbol entries
  // landings: the queue
  ['landings', 'updated_at', 'INTEGER'],
  ['landings', 'queue_seq', 'INTEGER'], // queue order (counter 'landing-queue'); inherited by re-lands
  ['landings', 'phase', 'TEXT'],
  ['landings', 'phase_at', 'INTEGER'],
  ['landings', 'attempt', 'INTEGER NOT NULL DEFAULT 0'],
  ['landings', 'lander', 'TEXT'],
  ['landings', 'lease_claim_id', 'TEXT'],
  ['landings', 'in_doubt', 'INTEGER NOT NULL DEFAULT 0'],
  ['landings', 'deadline_at', 'INTEGER'],
  ['landings', 'base_sha', 'TEXT'],
  ['landings', 'first_base', 'TEXT'],
  ['landings', 'trunk_base', 'TEXT'],
  ['landings', 'candidate', 'TEXT'],
  ['landings', 'candidate_ref', 'TEXT'],
  ['landings', 'candidate_checked', 'INTEGER NOT NULL DEFAULT 0'],
  ['landings', 'trunk_sha', 'TEXT'],
  ['landings', 'files', "TEXT NOT NULL DEFAULT '[]'"],
  ['landings', 'scope', 'TEXT'], // JSON ScopeEntry[] | null
  ['landings', 'mapper', 'TEXT'],
  ['landings', 'protected', "TEXT NOT NULL DEFAULT '[]'"],
  ['landings', 'approval', "TEXT NOT NULL DEFAULT '[]'"], // pending ApprovalRequirement[]
  ['landings', 'hold_ids', "TEXT NOT NULL DEFAULT '[]'"],
  ['landings', 'report', 'TEXT'], // JSON LandingReport
  ['landings', 'failure', 'TEXT'], // JSON {code, summary}
  ['landings', 'retries', `TEXT NOT NULL DEFAULT '${RETRIES_NONE}'`],
  ['landings', 'retry_of', 'TEXT'],
  ['landings', 'retry', 'INTEGER NOT NULL DEFAULT 0'],
  ['landings', 'supersedes', 'TEXT'],
  ['landings', 'superseded_by', 'TEXT'],
  ['landings', 'waits_for', 'TEXT'],
  ['landings', 'landed_with', 'TEXT'],
  ['landings', 'reconciled', 'INTEGER NOT NULL DEFAULT 0'],
  ['landings', 'started_at', 'INTEGER'],
  ['landings', 'ended_at', 'INTEGER'],
];

/** The rest of the Phases 2 and 3 schema (design §1.3), run after the columns exist. */
const PHASE2_SCHEMA = `
CREATE INDEX IF NOT EXISTS claims_by_landing ON claims (project, landing_id) WHERE landing_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS landings_queue ON landings (project, status, queue_seq);
CREATE INDEX IF NOT EXISTS landings_by_commit ON landings (project, agent, commit_sha);
CREATE INDEX IF NOT EXISTS landings_due ON landings (status, deadline_at);
-- At most one running landing per project, enforced by the database itself:
CREATE UNIQUE INDEX IF NOT EXISTS landings_one_running ON landings (project) WHERE status = 'running';

-- approvals: append-only audit
CREATE TABLE IF NOT EXISTS landing_approvals (
  project TEXT NOT NULL, landing_id TEXT NOT NULL, n INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('protected','merged','ai_resolution')),
  digest TEXT NOT NULL, approver TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  note TEXT NOT NULL, carried_from TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (project, landing_id, n));
CREATE TRIGGER IF NOT EXISTS landing_approvals_no_update BEFORE UPDATE ON landing_approvals
BEGIN SELECT RAISE(ABORT, 'approvals are append-only'); END;
CREATE TRIGGER IF NOT EXISTS landing_approvals_no_delete BEFORE DELETE ON landing_approvals
BEGIN SELECT RAISE(ABORT, 'approvals are append-only'); END;

-- per-project lander control
CREATE TABLE IF NOT EXISTS lander_control (
  project TEXT PRIMARY KEY, paused TEXT, trunk TEXT, policy TEXT, updated_at INTEGER NOT NULL);

-- Phase 3: signature changes
CREATE TABLE IF NOT EXISTS symbol_changes (
  project TEXT NOT NULL, id TEXT NOT NULL,
  agent TEXT NOT NULL, task_id TEXT, landing_id TEXT,
  file TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('signature','removed','renamed')),
  before TEXT NOT NULL, after TEXT, renamed_to TEXT,
  status TEXT NOT NULL CHECK (status IN ('in_progress','landed','withdrawn','superseded')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (project, id));
CREATE INDEX IF NOT EXISTS symbol_changes_recent ON symbol_changes (project, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS symbol_changes_open ON symbol_changes (project, agent, file, symbol) WHERE status = 'in_progress';
`;

const FORBIDDEN_IN_PATH = new RegExp(PATH_FORBIDDEN_RE.source, 'gu');

/**
 * A hub from before path validation stored any path its normalizer let
 * through, in any Unicode spelling, newlines and bidi controls included. Read
 * such old paths back in NFC, the form requests use now, with those characters
 * escaped (`\u000a`), so an old row can't forge a line or reorder text in a
 * teammate's view. Paths stored since then are unchanged.
 */
function storedPath(file: string): string {
  return file.normalize('NFC').replace(FORBIDDEN_IN_PATH, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

interface ClaimRowDb {
  project: string;
  id: string;
  holder: string;
  task_id: string | null;
  scope: string;
  mode: Claim['mode'];
  intent: string;
  base_commit: string | null;
  status: ClaimStatus;
  created_at: number;
  granted_at: number | null;
  expires_at: number;
  ttl_ms: number;
  heartbeat_interval_ms: number;
  ended_at: number | null;
  end_reason: string | null;
  landing_id: string | null;
  mapper: string | null;
}

function toClaim(r: ClaimRowDb): Claim {
  return {
    id: r.id,
    project: r.project,
    holder: r.holder,
    task_id: r.task_id,
    scope: (JSON.parse(r.scope) as Claim['scope']).map((entry) => ({ ...entry, file: storedPath(entry.file) })),
    mode: r.mode,
    intent: r.intent,
    base_commit: r.base_commit,
    status: r.status,
    created_at: r.created_at,
    granted_at: r.granted_at,
    expires_at: r.expires_at,
    ttl_ms: r.ttl_ms,
    heartbeat_interval_ms: r.heartbeat_interval_ms,
    ended_at: r.ended_at,
    end_reason: r.end_reason,
    landing_id: r.landing_id,
    mapper: r.mapper,
  };
}

interface LandingRowDb {
  project: string;
  id: string;
  agent: string;
  task_id: string | null;
  branch: string | null;
  commit_sha: string | null;
  summary: string;
  status: LandingStatus;
  created_at: number;
  seq: number;
  /** null on a Phase 1 row the migration didn't backfill. */
  updated_at: number | null;
  queue_seq: number | null;
  phase: Landing['phase'];
  phase_at: number | null;
  attempt: number;
  lander: string | null;
  lease_claim_id: string | null;
  in_doubt: number;
  deadline_at: number | null;
  base_sha: string | null;
  first_base: string | null;
  trunk_base: string | null;
  candidate: string | null;
  candidate_ref: string | null;
  candidate_checked: number;
  trunk_sha: string | null;
  files: string;
  scope: string | null;
  mapper: string | null;
  protected: string;
  approval: string;
  hold_ids: string;
  report: string | null;
  failure: string | null;
  retries: string;
  retry_of: string | null;
  retry: number;
  supersedes: string | null;
  superseded_by: string | null;
  waits_for: string | null;
  landed_with: string | null;
  reconciled: number;
  started_at: number | null;
  ended_at: number | null;
  /** JSON LandingApproval[]: the granted rows of landing_approvals, oldest first (see LANDING_SELECT). */
  approvals_json: string;
}

/**
 * A landing row as a `Landing`. Phase 1 listed each landing as its whole row
 * (`commit_sha` as `commit`), so the row's keys come first in that order, the
 * undeclared `seq` included, then the Phase 2 and 3 fields. `position` and
 * `eta_ms` are computed by the Hub, not stored.
 */
function toLanding(r: LandingRowDb): Landing {
  const landing: Landing & { seq: number } = {
    project: r.project,
    id: r.id,
    agent: r.agent,
    task_id: r.task_id,
    branch: r.branch,
    summary: r.summary,
    status: r.status,
    created_at: r.created_at,
    seq: r.seq,
    commit: r.commit_sha,
    updated_at: r.updated_at ?? r.created_at,
    queue_seq: r.queue_seq,
    position: null,
    eta_ms: null,
    phase: r.phase,
    phase_at: r.phase_at,
    attempt: r.attempt,
    lander: r.lander,
    lease_claim_id: r.lease_claim_id,
    in_doubt: r.in_doubt !== 0,
    deadline_at: r.deadline_at,
    base_sha: r.base_sha,
    first_base: r.first_base,
    trunk_base: r.trunk_base,
    candidate: r.candidate,
    candidate_ref: r.candidate_ref,
    candidate_checked: r.candidate_checked !== 0,
    trunk_sha: r.trunk_sha,
    files: JSON.parse(r.files),
    scope: r.scope === null ? null : JSON.parse(r.scope),
    mapper: r.mapper,
    protected: JSON.parse(r.protected),
    approval: JSON.parse(r.approval),
    approvals: JSON.parse(r.approvals_json) as LandingApproval[],
    hold_ids: JSON.parse(r.hold_ids),
    report: r.report === null ? null : JSON.parse(r.report),
    failure: r.failure === null ? null : JSON.parse(r.failure),
    retries: JSON.parse(r.retries),
    retry_of: r.retry_of,
    retry: r.retry,
    supersedes: r.supersedes,
    superseded_by: r.superseded_by,
    waits_for: r.waits_for,
    landed_with: r.landed_with,
    reconciled: r.reconciled !== 0,
    started_at: r.started_at,
    ended_at: r.ended_at,
  };
  return landing;
}

/** How one stored `Landing` field is written: its column, and its value as SQLite stores it. */
interface LandingCodec {
  column: string;
  encode(value: unknown): unknown;
}

/** A plain column; a missing value is `fallback` (the column's default). */
const plainColumn = (column: string, fallback: number | null = null): LandingCodec => ({ column, encode: (v) => v ?? fallback });
/** A boolean stored as 0 or 1. */
const flagColumn = (column: string): LandingCodec => ({ column, encode: (v) => (v ? 1 : 0) });
/** A JSON column; a missing or null value is `empty` (null where the column allows it, its default otherwise). */
const jsonColumn = (column: string, empty: string | null): LandingCodec => ({ column, encode: (v) => (v === undefined || v === null ? empty : JSON.stringify(v)) });

/** Every stored field but the identity (id, project, agent, created_at): what insertLanding writes after it and updateLanding may change. */
const LANDING_CODECS: { readonly [K in keyof LandingPatch]-?: LandingCodec } = {
  task_id: plainColumn('task_id'),
  branch: plainColumn('branch'),
  commit: plainColumn('commit_sha'),
  summary: plainColumn('summary'),
  status: plainColumn('status'),
  updated_at: plainColumn('updated_at'),
  queue_seq: plainColumn('queue_seq'),
  phase: plainColumn('phase'),
  phase_at: plainColumn('phase_at'),
  attempt: plainColumn('attempt', 0),
  lander: plainColumn('lander'),
  lease_claim_id: plainColumn('lease_claim_id'),
  in_doubt: flagColumn('in_doubt'),
  deadline_at: plainColumn('deadline_at'),
  base_sha: plainColumn('base_sha'),
  first_base: plainColumn('first_base'),
  trunk_base: plainColumn('trunk_base'),
  candidate: plainColumn('candidate'),
  candidate_ref: plainColumn('candidate_ref'),
  candidate_checked: flagColumn('candidate_checked'),
  trunk_sha: plainColumn('trunk_sha'),
  files: jsonColumn('files', '[]'),
  scope: jsonColumn('scope', null),
  mapper: plainColumn('mapper'),
  protected: jsonColumn('protected', '[]'),
  approval: jsonColumn('approval', '[]'),
  hold_ids: jsonColumn('hold_ids', '[]'),
  report: jsonColumn('report', null),
  failure: jsonColumn('failure', null),
  retries: jsonColumn('retries', RETRIES_NONE),
  retry_of: plainColumn('retry_of'),
  retry: plainColumn('retry', 0),
  supersedes: plainColumn('supersedes'),
  superseded_by: plainColumn('superseded_by'),
  waits_for: plainColumn('waits_for'),
  landed_with: plainColumn('landed_with'),
  reconciled: flagColumn('reconciled'),
  started_at: plainColumn('started_at'),
  ended_at: plainColumn('ended_at'),
};
const LANDING_FIELDS = Object.keys(LANDING_CODECS) as Array<keyof LandingPatch>;

const INSERT_LANDING = (() => {
  const columns = ['project', 'id', 'agent', 'created_at', 'seq', ...LANDING_FIELDS.map((f) => LANDING_CODECS[f].column)];
  return `INSERT INTO landings (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`;
})();

/** Landing rows with their granted approvals (`approvals_json`), oldest first; a query adds WHERE / ORDER BY on `l`. */
const LANDING_SELECT = `
  SELECT l.*, (
    SELECT json_group_array(
             json_object('kind', a.kind, 'digest', a.digest, 'by', a.approver, 'at', a.at, 'note', a.note, 'carried_from', a.carried_from)
             ORDER BY a.n)
    FROM landing_approvals a
    WHERE a.project = l.project AND a.landing_id = l.id AND a.decision = 'approve'
  ) AS approvals_json
  FROM landings l`;

interface LanderControlRowDb {
  paused: string | null;
  trunk: string | null;
  policy: string | null;
}

interface TaskRowDb {
  project: string;
  id: string;
  title: string;
  description: string;
  deps: string;
  owner: string | null;
  status: Task['status'];
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function toTask(r: TaskRowDb): Omit<Task, 'blocked_by'> {
  return {
    id: r.id,
    project: r.project,
    title: r.title,
    description: r.description,
    deps: JSON.parse(r.deps),
    owner: r.owner,
    status: r.status,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

interface MessageRowDb {
  id: number;
  project: string;
  from_agent: string;
  to_agent: string | null;
  channel: string | null;
  body: string;
  created_at: number;
}

function toMessage(r: MessageRowDb): Message {
  return { id: r.id, project: r.project, from: r.from_agent, to: r.to_agent, channel: r.channel, body: r.body, created_at: r.created_at };
}

interface EventRowDb {
  seq: number;
  project: string;
  type: HubEvent['type'];
  actor: string | null;
  at: number;
  data: string;
  targets: string | null;
}

function toEvent(r: EventRowDb): HubEvent {
  return { seq: r.seq, project: r.project, type: r.type, actor: r.actor, at: r.at, data: eventData(r.data), targets: r.targets ? JSON.parse(r.targets) : null };
}

/** Claim and decision events list their paths in `files`. */
function eventData(json: string): Record<string, unknown> {
  const data = JSON.parse(json) as Record<string, unknown>;
  if (Array.isArray(data.files)) data.files = data.files.map((f: unknown) => (typeof f === 'string' ? storedPath(f) : f));
  return data;
}

const CLAIM_PATCH_COLUMNS = ['status', 'granted_at', 'expires_at', 'ended_at', 'end_reason', 'task_id', 'intent', 'landing_id', 'mapper', 'holder'] as const;

/**
 * Statements compiled once per SQL text. Every request renews each lease its
 * agent holds, and a statement prepared per call keeps its native memory until
 * its JS wrapper is collected: gigabytes for an agent with a long queue.
 */
class StatementCache {
  private readonly db: Database.Database;
  private readonly byText = new Map<string, Database.Statement>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  prepare(text: string): Database.Statement {
    let stmt = this.byText.get(text);
    if (!stmt) this.byText.set(text, (stmt = this.db.prepare(text)));
    return stmt;
  }
}

/** `Store` on better-sqlite3. Pass `':memory:'` for tests. */
export class SqliteStore implements Store {
  readonly db: Database.Database;
  private readonly statements: StatementCache;
  private readonly epochId: string;
  /** The outermost open transaction commits with synchronous = FULL. */
  private durable = false;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.statements = new StatementCache(this.db);
    // busy_timeout first, so a second process opening the same file waits instead of failing.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.migrate();
    // The first process to open a new file makes its epoch; every later one reads it.
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', ?)").run(randomUUID());
    this.epochId = this.db.prepare("SELECT value FROM meta WHERE key = 'epoch'").pluck().get() as string;
    this.indexLiveClaimsAsNfc();
  }

  /**
   * A hub from before NFC keys indexed claims under paths as sent. Index live
   * claims under the NFC form too, so a lease taken before an upgrade still
   * conflicts with requests, which now always name files in NFC.
   */
  private indexLiveClaimsAsNfc(): void {
    const rows = this.db
      .prepare(
        `SELECT f.project, f.claim_id, f.file, f.symbol FROM claim_files f
         JOIN claims c ON c.project = f.project AND c.id = f.claim_id
         WHERE c.status IN ('active', 'queued')`,
      )
      .all() as { project: string; claim_id: string; file: string; symbol: string }[];
    const insert = this.db.prepare('INSERT OR IGNORE INTO claim_files (project, claim_id, file, symbol) VALUES (?, ?, ?, ?)');
    for (const r of rows) {
      if (r.file !== r.file.normalize('NFC')) insert.run(r.project, r.claim_id, r.file.normalize('NFC'), r.symbol);
    }
  }

  /**
   * Phases 2 and 3 (design §1.3), after the Phase 1 SCHEMA: the added columns,
   * then the new indexes, tables and triggers. One IMMEDIATE transaction reads
   * `PRAGMA table_info` and adds what is missing, so processes opening one file
   * at once add each column once, and a Phase 1 database keeps its rows.
   */
  private migrate(): void {
    this.transaction(() => {
      const existing = new Map<string, Set<string>>();
      for (const [table, column, declaration] of ADDED_COLUMNS) {
        let columns = existing.get(table);
        if (!columns) {
          columns = new Set((this.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
          existing.set(table, columns);
        }
        if (columns.has(column)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
        // A Phase 1 landing was last updated when it was recorded.
        if (table === 'landings' && column === 'updated_at') this.db.exec('UPDATE landings SET updated_at = created_at WHERE updated_at IS NULL');
      }
      this.db.exec(PHASE2_SCHEMA);
    });
  }

  transaction<T>(fn: () => T, opts: TransactionOptions = {}): T {
    // IMMEDIATE takes the write lock up front, so even a second process on the
    // same file can't interleave with a claim decision.
    const run = this.db.transaction(fn);
    if (this.db.inTransaction) {
      // A nested transaction is a savepoint: it commits with the outermost one,
      // and SQLite can't change synchronous inside a transaction.
      if (opts.durable && !this.durable) throw new Error('a durable transaction cannot run inside a non-durable one');
      return run.immediate();
    }
    if (!opts.durable) return run.immediate();
    // FULL syncs the WAL at commit, so the write survives a power loss, not only a crash.
    this.db.pragma('synchronous = FULL');
    this.durable = true;
    try {
      return run.immediate();
    } finally {
      this.durable = false;
      this.db.pragma('synchronous = NORMAL');
    }
  }

  close(): void {
    this.db.close();
  }

  epoch(): string {
    return this.epochId;
  }

  ensureProject(project: string, now: number): void {
    this.statements.prepare('INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)').run(project, now);
  }

  listProjects(): string[] {
    return this.statements.prepare('SELECT id FROM projects ORDER BY id').pluck().all() as string[];
  }

  nextCounter(project: string, kind: string): number {
    return this.statements
      .prepare(
        `INSERT INTO counters (project, kind, value) VALUES (?, ?, 1)
         ON CONFLICT (project, kind) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .pluck()
      .get(project, kind) as number;
  }

  touchAgent(project: string, agent: string, now: number, info: AgentTouch = {}): { previous_last_seen: number | null } {
    const prev = this.statements.prepare('SELECT last_seen FROM agents WHERE project = ? AND agent = ?').pluck().get(project, agent) as
      | number
      | undefined;
    this.statements
      .prepare(
        `INSERT INTO agents (project, agent, client, branch, worktree, first_seen, last_seen)
         VALUES (@project, @agent, @client, @branch, @worktree, @now, @now)
         ON CONFLICT (project, agent) DO UPDATE SET
           last_seen = @now,
           client = COALESCE(@client, client),
           branch = COALESCE(@branch, branch),
           worktree = COALESCE(@worktree, worktree)`,
      )
      .run({ project, agent, now, client: info.client ?? null, branch: info.branch ?? null, worktree: info.worktree ?? null });
    return { previous_last_seen: prev ?? null };
  }

  listAgents(project: string): AgentRow[] {
    return this.statements.prepare('SELECT * FROM agents WHERE project = ? ORDER BY agent').all(project) as AgentRow[];
  }

  insertTask(task: Omit<Task, 'blocked_by'>): void {
    const seq = this.nextCounter(task.project, 'task-order');
    this.statements
      .prepare(
        `INSERT INTO tasks (project, id, title, description, deps, owner, status, created_by, created_at, updated_at, seq)
         VALUES (@project, @id, @title, @description, @deps, @owner, @status, @created_by, @created_at, @updated_at, @seq)`,
      )
      .run({ ...task, deps: JSON.stringify(task.deps), seq });
  }

  getTask(project: string, id: string): Omit<Task, 'blocked_by'> | null {
    const row = this.statements.prepare('SELECT * FROM tasks WHERE project = ? AND id = ?').get(project, id) as TaskRowDb | undefined;
    return row ? toTask(row) : null;
  }

  updateTask(project: string, id: string, patch: Partial<Pick<Task, 'owner' | 'status' | 'updated_at'>>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { project, id };
    for (const key of ['owner', 'status', 'updated_at'] as const) {
      if (key in patch) {
        sets.push(`${key} = @${key}`);
        params[key] = patch[key] ?? null;
      }
    }
    if (sets.length === 0) return;
    this.statements.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE project = @project AND id = @id`).run(params);
  }

  listTasks(project: string): Omit<Task, 'blocked_by'>[] {
    return (this.statements.prepare('SELECT * FROM tasks WHERE project = ? ORDER BY seq').all(project) as TaskRowDb[]).map(toTask);
  }

  insertClaim(claim: Claim): void {
    const order = this.nextCounter(claim.project, 'claim-order');
    this.statements
      .prepare(
        `INSERT INTO claims (project, id, holder, task_id, scope, mode, intent, base_commit, status, created_at, granted_at,
                             expires_at, ttl_ms, heartbeat_interval_ms, ended_at, end_reason, queue_order, landing_id, mapper)
         VALUES (@project, @id, @holder, @task_id, @scope, @mode, @intent, @base_commit, @status, @created_at, @granted_at,
                 @expires_at, @ttl_ms, @heartbeat_interval_ms, @ended_at, @end_reason, @queue_order, @landing_id, @mapper)`,
      )
      .run({ ...claim, scope: JSON.stringify(claim.scope), queue_order: order, landing_id: claim.landing_id ?? null, mapper: claim.mapper ?? null });
    this.writeClaimFiles(claim.project, claim.id, claim.scope);
  }

  private writeClaimFiles(project: string, claimId: string, scope: Claim['scope']): void {
    this.statements.prepare('DELETE FROM claim_files WHERE project = ? AND claim_id = ?').run(project, claimId);
    const insert = this.statements.prepare('INSERT OR IGNORE INTO claim_files (project, claim_id, file, symbol) VALUES (?, ?, ?, ?)');
    for (const entry of scope) insert.run(project, claimId, entry.file, entry.symbol ?? '');
  }

  getClaim(project: string, id: string): Claim | null {
    const row = this.statements.prepare('SELECT * FROM claims WHERE project = ? AND id = ?').get(project, id) as ClaimRowDb | undefined;
    return row ? toClaim(row) : null;
  }

  updateClaim(project: string, id: string, patch: ClaimPatch): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { project, id };
    for (const key of CLAIM_PATCH_COLUMNS) {
      if (key in patch) {
        sets.push(`${key} = @${key}`);
        params[key] = patch[key] ?? null;
      }
    }
    if (patch.scope) {
      sets.push('scope = @scope');
      params.scope = JSON.stringify(patch.scope);
      this.writeClaimFiles(project, id, patch.scope);
    }
    if (sets.length === 0) return;
    this.statements.prepare(`UPDATE claims SET ${sets.join(', ')} WHERE project = @project AND id = @id`).run(params);
  }

  listClaims(project: string, filter: ClaimFilter): Claim[] {
    const where = ['project = @project', 'status IN (SELECT value FROM json_each(@statuses))'];
    const params: Record<string, unknown> = { project, statuses: JSON.stringify(filter.statuses) };
    if (filter.holder !== undefined) {
      where.push('holder = @holder');
      params.holder = filter.holder;
    }
    if (filter.task_id !== undefined) {
      where.push('task_id = @task_id');
      params.task_id = filter.task_id;
    }
    if (filter.landing_id === null) {
      where.push('landing_id IS NULL');
    } else if (filter.landing_id !== undefined) {
      where.push('landing_id = @landing_id');
      params.landing_id = filter.landing_id;
    }
    if (filter.expiresAtOrBefore !== undefined) {
      where.push('expires_at <= @expires');
      params.expires = filter.expiresAtOrBefore;
    }
    const rows = this.statements.prepare(`SELECT * FROM claims WHERE ${where.join(' AND ')} ORDER BY queue_order`).all(params) as ClaimRowDb[];
    return rows.map(toClaim);
  }

  claimsForFiles(project: string, files: string[], statuses: ClaimStatus[]): Claim[] {
    if (files.length === 0) return [];
    // `+f.file` makes the file list a lookup set instead of one index probe per
    // listed file for every live claim, which grew with files x claims.
    const rows = this.statements
      .prepare(
        `SELECT c.* FROM claims c
         WHERE c.project = @project
           AND c.status IN (SELECT value FROM json_each(@statuses))
           AND EXISTS (
             SELECT 1 FROM claim_files f
             WHERE f.project = c.project AND f.claim_id = c.id
               AND +f.file IN (SELECT value FROM json_each(@files))
           )
         ORDER BY c.queue_order`,
      )
      .all({ project, statuses: JSON.stringify(statuses), files: JSON.stringify(files) }) as ClaimRowDb[];
    return rows.map(toClaim);
  }

  projectsWithDueWork(now: number): string[] {
    // A landing in pushing has no deadline: only a lander that looked at the
    // remote moves it on (design §1.4 T10).
    return this.statements
      .prepare(
        `SELECT project FROM claims WHERE status IN ('active', 'queued') AND expires_at <= @now
         UNION
         SELECT project FROM landings WHERE status = 'running' AND phase IS NOT 'pushing' AND deadline_at <= @now
         UNION
         SELECT project FROM landings WHERE status = 'needs_approval' AND deadline_at <= @now
         ORDER BY project`,
      )
      .pluck()
      .all({ now }) as string[];
  }

  insertMessage(message: Omit<Message, 'id'>): number {
    const info = this.statements
      .prepare(
        `INSERT INTO messages (project, from_agent, to_agent, channel, body, created_at)
         VALUES (@project, @from, @to, @channel, @body, @created_at)`,
      )
      .run(message);
    return Number(info.lastInsertRowid);
  }

  messagesFor(project: string, agent: string, afterId: number, limit: number): Message[] {
    const rows = this.statements
      .prepare(
        `SELECT * FROM messages
         WHERE project = @project AND id > @afterId
           AND (to_agent = @agent OR (channel IS NOT NULL AND from_agent != @agent))
         ORDER BY id LIMIT @limit`,
      )
      .all({ project, agent, afterId, limit }) as MessageRowDb[];
    return rows.map(toMessage);
  }

  countMessagesFor(project: string, agent: string, afterId: number): number {
    return this.statements
      .prepare(
        `SELECT COUNT(*) FROM messages
         WHERE project = @project AND id > @afterId
           AND (to_agent = @agent OR (channel IS NOT NULL AND from_agent != @agent))`,
      )
      .pluck()
      .get({ project, agent, afterId }) as number;
  }

  getInboxCursor(project: string, agent: string): number {
    const v = this.statements.prepare('SELECT last_read FROM inbox_cursors WHERE project = ? AND agent = ?').pluck().get(project, agent);
    return (v as number | undefined) ?? 0;
  }

  setInboxCursor(project: string, agent: string, lastRead: number): void {
    this.statements
      .prepare(
        `INSERT INTO inbox_cursors (project, agent, last_read) VALUES (?, ?, ?)
         ON CONFLICT (project, agent) DO UPDATE SET last_read = MAX(last_read, excluded.last_read)`,
      )
      .run(project, agent, lastRead);
  }

  insertDecision(d: Decision): void {
    const seq = this.nextCounter(d.project, 'decision-order');
    this.statements
      .prepare(
        `INSERT INTO decisions (project, id, agent, summary, rationale, files, symbols, task_id, created_at, seq)
         VALUES (@project, @id, @agent, @summary, @rationale, @files, @symbols, @task_id, @created_at, @seq)`,
      )
      .run({ ...d, files: JSON.stringify(d.files), symbols: JSON.stringify(d.symbols), seq });
  }

  listDecisions(project: string, limit: number): Decision[] {
    const rows = this.statements.prepare('SELECT * FROM decisions WHERE project = ? ORDER BY seq DESC LIMIT ?').all(project, limit) as Array<
      Omit<Decision, 'files' | 'symbols'> & { files: string; symbols: string }
    >;
    return rows.map((r) => ({
      id: r.id,
      project: r.project,
      agent: r.agent,
      summary: r.summary,
      rationale: r.rationale,
      files: (JSON.parse(r.files) as string[]).map(storedPath),
      symbols: JSON.parse(r.symbols),
      task_id: r.task_id,
      created_at: r.created_at,
    }));
  }

  insertLanding(l: Landing): void {
    const params: Record<string, unknown> = { project: l.project, id: l.id, agent: l.agent, created_at: l.created_at, seq: this.nextCounter(l.project, 'landing-order') };
    for (const field of LANDING_FIELDS) {
      const codec = LANDING_CODECS[field];
      params[codec.column] = codec.encode(l[field]);
    }
    this.statements.prepare(INSERT_LANDING).run(params);
  }

  getLanding(project: string, id: string): Landing | null {
    const row = this.statements.prepare(`${LANDING_SELECT} WHERE l.project = ? AND l.id = ?`).get(project, id) as LandingRowDb | undefined;
    return row ? toLanding(row) : null;
  }

  updateLanding(project: string, id: string, patch: LandingPatch): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { project, id };
    for (const field of LANDING_FIELDS) {
      if (patch[field] === undefined) continue;
      const codec = LANDING_CODECS[field];
      sets.push(`${codec.column} = @${codec.column}`);
      params[codec.column] = codec.encode(patch[field]);
    }
    if (sets.length === 0) return;
    this.statements.prepare(`UPDATE landings SET ${sets.join(', ')} WHERE project = @project AND id = @id`).run(params);
  }

  listLandings(project: string, filter: LandingFilter): Landing[] {
    const where = ['l.project = @project'];
    const params: Record<string, unknown> = { project };
    if (filter.statuses !== undefined) {
      where.push('l.status IN (SELECT value FROM json_each(@statuses))');
      params.statuses = JSON.stringify(filter.statuses);
    }
    if (filter.agent !== undefined) {
      where.push('l.agent = @agent');
      params.agent = filter.agent;
    }
    for (const key of ['task_id', 'branch'] as const) {
      const value = filter[key];
      if (value === null) {
        where.push(`l.${key} IS NULL`);
      } else if (value !== undefined) {
        where.push(`l.${key} = @${key}`);
        params[key] = value;
      }
    }
    if (filter.commit !== undefined) {
      where.push('l.commit_sha = @commit');
      params.commit = filter.commit;
    }
    // An inherited queue place shares its queue_seq: those run in the order they were made.
    const order = filter.order === 'queue' ? 'l.queue_seq IS NULL, l.queue_seq, l.seq' : 'l.seq DESC';
    params.limit = filter.limit === undefined ? -1 : Math.max(0, Math.floor(filter.limit));
    const rows = this.statements.prepare(`${LANDING_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT @limit`).all(params) as LandingRowDb[];
    return rows.map(toLanding);
  }

  insertApproval(a: Omit<ApprovalRow, 'n'>): ApprovalRow {
    const n = this.statements
      .prepare(
        `INSERT INTO landing_approvals (project, landing_id, n, kind, digest, approver, decision, note, carried_from, at)
         SELECT @project, @landing_id, COALESCE(MAX(n), 0) + 1, @kind, @digest, @approver, @decision, @note, @carried_from, @at
         FROM landing_approvals WHERE project = @project AND landing_id = @landing_id
         RETURNING n`,
      )
      .pluck()
      .get({
        project: a.project,
        landing_id: a.landing_id,
        kind: a.kind,
        digest: a.digest,
        approver: a.approver,
        decision: a.decision,
        note: a.note,
        carried_from: a.carried_from,
        at: a.at,
      }) as number;
    return { project: a.project, landing_id: a.landing_id, n, kind: a.kind, digest: a.digest, approver: a.approver, decision: a.decision, note: a.note, carried_from: a.carried_from, at: a.at };
  }

  listApprovals(project: string, landingId: string): ApprovalRow[] {
    return this.statements.prepare('SELECT * FROM landing_approvals WHERE project = ? AND landing_id = ? ORDER BY n').all(project, landingId) as ApprovalRow[];
  }

  getLanderControl(project: string): LanderControl {
    const row = this.statements.prepare('SELECT paused, trunk, policy FROM lander_control WHERE project = ?').get(project) as LanderControlRowDb | undefined;
    if (!row) return defaultLanderControl();
    return {
      paused: row.paused === null ? null : JSON.parse(row.paused),
      trunk: row.trunk === null ? null : JSON.parse(row.trunk),
      policy: { ...DEFAULT_LAND_POLICY, ...(row.policy === null ? {} : JSON.parse(row.policy)) },
    };
  }

  putLanderControl(project: string, patch: Partial<LanderControl>, now: number): LanderControl {
    const control = this.getLanderControl(project);
    if (patch.paused !== undefined) control.paused = patch.paused;
    if (patch.trunk !== undefined) control.trunk = patch.trunk;
    if (patch.policy !== undefined) control.policy = { ...patch.policy };
    this.statements
      .prepare(
        `INSERT INTO lander_control (project, paused, trunk, policy, updated_at) VALUES (@project, @paused, @trunk, @policy, @now)
         ON CONFLICT (project) DO UPDATE SET paused = excluded.paused, trunk = excluded.trunk, policy = excluded.policy, updated_at = excluded.updated_at`,
      )
      .run({
        project,
        paused: control.paused === null ? null : JSON.stringify(control.paused),
        trunk: control.trunk === null ? null : JSON.stringify(control.trunk),
        policy: JSON.stringify(control.policy),
        now,
      });
    return control;
  }

  upsertSymbolChange(c: Omit<SymbolChangeRow, 'id'>): SymbolChangeRow {
    const fields = {
      project: c.project,
      agent: c.agent,
      task_id: c.task_id,
      landing_id: c.landing_id,
      file: c.file,
      symbol: c.symbol,
      name: c.name,
      kind: c.kind,
      before: c.before,
      after: c.after,
      renamed_to: c.renamed_to,
      status: c.status,
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
    if (c.status === 'in_progress') {
      const open = this.statements
        .prepare(`SELECT id FROM symbol_changes WHERE project = ? AND agent = ? AND file = ? AND symbol = ? AND status = 'in_progress'`)
        .pluck()
        .get(c.project, c.agent, c.file, c.symbol) as string | undefined;
      if (open !== undefined) {
        this.statements
          .prepare(
            `UPDATE symbol_changes SET task_id = @task_id, landing_id = @landing_id, name = @name, kind = @kind, before = @before, after = @after,
                                       renamed_to = @renamed_to, updated_at = @updated_at
             WHERE project = @project AND id = @id`,
          )
          .run({ ...fields, id: open });
        return this.getSymbolChange(c.project, open)!;
      }
    }
    const id = `S-${this.nextCounter(c.project, 'symbol-change')}`;
    this.statements
      .prepare(
        `INSERT INTO symbol_changes (project, id, agent, task_id, landing_id, file, symbol, name, kind, before, after, renamed_to, status, created_at, updated_at)
         VALUES (@project, @id, @agent, @task_id, @landing_id, @file, @symbol, @name, @kind, @before, @after, @renamed_to, @status, @created_at, @updated_at)`,
      )
      .run({ ...fields, id });
    return this.getSymbolChange(c.project, id)!;
  }

  private getSymbolChange(project: string, id: string): SymbolChangeRow | null {
    return (this.statements.prepare('SELECT * FROM symbol_changes WHERE project = ? AND id = ?').get(project, id) as SymbolChangeRow | undefined) ?? null;
  }

  updateSymbolChanges(filter: SymbolChangeFilter, patch: SymbolChangePatch): SymbolChangeRow[] {
    const where = ['project = @project'];
    const params: Record<string, unknown> = { project: filter.project };
    if (filter.ids !== undefined) {
      where.push('id IN (SELECT value FROM json_each(@ids))');
      params.ids = JSON.stringify(filter.ids);
    }
    if (filter.statuses !== undefined) {
      where.push('status IN (SELECT value FROM json_each(@statuses))');
      params.statuses = JSON.stringify(filter.statuses);
    }
    if (filter.task_id === null) {
      where.push('task_id IS NULL');
    } else if (filter.task_id !== undefined) {
      where.push('task_id = @task_id');
      params.task_id = filter.task_id;
    }
    for (const key of ['agent', 'landing_id', 'file', 'symbol'] as const) {
      if (filter[key] === undefined) continue;
      where.push(`${key} = @${key}`);
      params[key] = filter[key];
    }
    const ids = this.statements.prepare(`SELECT id FROM symbol_changes WHERE ${where.join(' AND ')} ORDER BY rowid`).pluck().all(params) as string[];
    if (ids.length === 0) return [];
    const sets: string[] = [];
    const values: Record<string, unknown> = { project: filter.project, ids: JSON.stringify(ids) };
    for (const key of ['status', 'landing_id', 'task_id', 'updated_at'] as const) {
      if (patch[key] === undefined) continue;
      sets.push(`${key} = @${key}`);
      values[key] = patch[key];
    }
    if (sets.length > 0) {
      this.statements.prepare(`UPDATE symbol_changes SET ${sets.join(', ')} WHERE project = @project AND id IN (SELECT value FROM json_each(@ids))`).run(values);
    }
    return this.statements
      .prepare('SELECT * FROM symbol_changes WHERE project = @project AND id IN (SELECT value FROM json_each(@ids)) ORDER BY rowid')
      .all({ project: filter.project, ids: JSON.stringify(ids) }) as SymbolChangeRow[];
  }

  listSymbolChanges(project: string, filter: { since: number; statuses: SymbolChangeStatus[]; limit?: number }): SymbolChangeRow[] {
    return this.statements
      .prepare(
        `SELECT * FROM symbol_changes
         WHERE project = @project AND updated_at >= @since AND status IN (SELECT value FROM json_each(@statuses))
         ORDER BY updated_at DESC, rowid DESC LIMIT @limit`,
      )
      .all({
        project,
        since: filter.since,
        statuses: JSON.stringify(filter.statuses),
        limit: filter.limit === undefined ? -1 : Math.max(0, Math.floor(filter.limit)),
      }) as SymbolChangeRow[];
  }

  appendEvent(e: Omit<HubEvent, 'seq'>): number {
    const info = this.statements
      .prepare('INSERT INTO events (project, type, actor, at, data, targets) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.project, e.type, e.actor, e.at, JSON.stringify(e.data), e.targets ? JSON.stringify(e.targets) : null);
    return Number(info.lastInsertRowid);
  }

  eventsSince(project: string, afterSeq: number, limit: number): HubEvent[] {
    const rows = this.statements.prepare('SELECT * FROM events WHERE project = ? AND seq > ? ORDER BY seq LIMIT ?').all(project, afterSeq, limit) as EventRowDb[];
    return rows.map(toEvent);
  }

  latestSeq(project: string): number {
    const v = this.statements.prepare('SELECT MAX(seq) FROM events WHERE project = ?').pluck().get(project);
    return (v as number | null) ?? 0;
  }

  allEventsSince(afterSeq: number, limit: number): HubEvent[] {
    const rows = this.statements.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(afterSeq, limit) as EventRowDb[];
    return rows.map(toEvent);
  }

  lastSeq(): number {
    const v = this.statements.prepare('SELECT MAX(seq) FROM events').pluck().get();
    return (v as number | null) ?? 0;
  }
}
