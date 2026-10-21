import Database from 'better-sqlite3';
import { PATH_FORBIDDEN_RE, type Claim, type ClaimStatus, type Decision, type HubEvent, type Landing, type Message, type Task } from './protocol.js';
import type { AgentRow, AgentTouch, ClaimFilter, ClaimPatch, Store } from './store.js';

const SCHEMA = `
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
  };
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

/** Claim and decision events list their paths in `files`. */
function eventData(json: string): Record<string, unknown> {
  const data = JSON.parse(json) as Record<string, unknown>;
  if (Array.isArray(data.files)) data.files = data.files.map((f: unknown) => (typeof f === 'string' ? storedPath(f) : f));
  return data;
}

const CLAIM_PATCH_COLUMNS = ['status', 'granted_at', 'expires_at', 'ended_at', 'end_reason', 'task_id', 'intent'] as const;

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

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    this.statements = new StatementCache(this.db);
    // busy_timeout first, so a second process opening the same file waits instead of failing.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
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

  transaction<T>(fn: () => T): T {
    // IMMEDIATE takes the write lock up front, so even a second process on the
    // same file can't interleave with a claim decision.
    return this.db.transaction(fn).immediate();
  }

  close(): void {
    this.db.close();
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
                             expires_at, ttl_ms, heartbeat_interval_ms, ended_at, end_reason, queue_order)
         VALUES (@project, @id, @holder, @task_id, @scope, @mode, @intent, @base_commit, @status, @created_at, @granted_at,
                 @expires_at, @ttl_ms, @heartbeat_interval_ms, @ended_at, @end_reason, @queue_order)`,
      )
      .run({ ...claim, scope: JSON.stringify(claim.scope), queue_order: order });
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

  projectsWithDueClaims(now: number): string[] {
    return this.statements
      .prepare(`SELECT DISTINCT project FROM claims WHERE status IN ('active', 'queued') AND expires_at <= ?`)
      .pluck()
      .all(now) as string[];
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
    const seq = this.nextCounter(l.project, 'landing-order');
    this.statements
      .prepare(
        `INSERT INTO landings (project, id, agent, task_id, branch, commit_sha, summary, status, created_at, seq)
         VALUES (@project, @id, @agent, @task_id, @branch, @commit, @summary, @status, @created_at, @seq)`,
      )
      .run({ ...l, seq });
  }

  listLandings(project: string, limit: number): Landing[] {
    const rows = this.statements.prepare('SELECT * FROM landings WHERE project = ? ORDER BY seq DESC LIMIT ?').all(project, limit) as Array<
      Omit<Landing, 'commit'> & { commit_sha: string | null }
    >;
    return rows.map(({ commit_sha, ...rest }) => ({ ...rest, commit: commit_sha }));
  }

  appendEvent(e: Omit<HubEvent, 'seq'>): number {
    const info = this.statements
      .prepare('INSERT INTO events (project, type, actor, at, data, targets) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.project, e.type, e.actor, e.at, JSON.stringify(e.data), e.targets ? JSON.stringify(e.targets) : null);
    return Number(info.lastInsertRowid);
  }

  eventsSince(project: string, afterSeq: number, limit: number): HubEvent[] {
    const rows = this.statements
      .prepare('SELECT * FROM events WHERE project = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(project, afterSeq, limit) as Array<{
      seq: number;
      project: string;
      type: HubEvent['type'];
      actor: string | null;
      at: number;
      data: string;
      targets: string | null;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      project: r.project,
      type: r.type,
      actor: r.actor,
      at: r.at,
      data: eventData(r.data),
      targets: r.targets ? JSON.parse(r.targets) : null,
    }));
  }

  latestSeq(project: string): number {
    const v = this.statements.prepare('SELECT MAX(seq) FROM events WHERE project = ?').pluck().get(project);
    return (v as number | null) ?? 0;
  }
}
