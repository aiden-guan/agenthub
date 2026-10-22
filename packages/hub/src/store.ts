import type {
  ApprovalKind,
  Claim,
  ClaimStatus,
  Decision,
  HubEvent,
  Landing,
  LanderControl,
  LandingStatus,
  Message,
  SymbolChange,
  SymbolChangeStatus,
  Task,
} from './protocol.js';

/**
 * Persistence for one hub. The interface is synchronous on purpose: both
 * better-sqlite3 and a Cloudflare Durable Object's SQLite storage
 * (`ctx.storage.sql` + `transactionSync`) are synchronous, so the hub's
 * single serialized write path maps onto either without changes.
 *
 * Implementations hold no business rules; conflict detection, queueing and
 * lease expiry all live in `Hub`.
 */
export interface Store {
  /**
   * Run `fn` atomically. Writes made inside commit together or not at all.
   * `durable` commits so the write survives a power loss, not only a crash
   * (landing and control writes); a nested transaction commits with the
   * outermost one, so it can't be durable inside one that isn't.
   */
  transaction<T>(fn: () => T, opts?: TransactionOptions): T;
  close(): void;
  /** An id made once when the database is created, so clients can tell a recreated one (whose seqs start over) apart. */
  epoch(): string;

  ensureProject(project: string, now: number): void;
  listProjects(): string[];
  /** Per-project monotonic counter, used for readable ids (T-1, C-7, D-3, L-2) and queue order ('landing-queue'). */
  nextCounter(project: string, kind: string): number;

  // Presence
  touchAgent(project: string, agent: string, now: number, info?: AgentTouch): { previous_last_seen: number | null };
  listAgents(project: string): AgentRow[];

  // Tasks
  insertTask(task: Omit<Task, 'blocked_by'>): void;
  getTask(project: string, id: string): Omit<Task, 'blocked_by'> | null;
  updateTask(project: string, id: string, patch: Partial<Pick<Task, 'owner' | 'status' | 'updated_at'>>): void;
  listTasks(project: string): Omit<Task, 'blocked_by'>[];

  // Claims
  insertClaim(claim: Claim): void;
  getClaim(project: string, id: string): Claim | null;
  updateClaim(project: string, id: string, patch: ClaimPatch): void;
  /** Claims in the given states, oldest first (queue order). */
  listClaims(project: string, filter: ClaimFilter): Claim[];
  /** Claims in the given states whose scope touches any of `files`, oldest first. */
  claimsForFiles(project: string, files: string[], statuses: ClaimStatus[]): Claim[];
  /**
   * Projects with work the sweeper must do by `now`: an active or queued claim
   * with `expires_at <= now`, a running landing not in `pushing` past its
   * `deadline_at`, or a `needs_approval` landing past its `deadline_at`.
   */
  projectsWithDueWork(now: number): string[];

  // Messages
  insertMessage(message: Omit<Message, 'id'>): number;
  /** Direct messages to `agent` plus channel messages from others, with id > afterId. */
  messagesFor(project: string, agent: string, afterId: number, limit: number): Message[];
  countMessagesFor(project: string, agent: string, afterId: number): number;
  getInboxCursor(project: string, agent: string): number;
  setInboxCursor(project: string, agent: string, lastRead: number): void;

  // Decisions (append-only: the store must refuse updates and deletes)
  insertDecision(decision: Decision): void;
  listDecisions(project: string, limit: number): Decision[];

  // Landings. `position` and `eta_ms` are not stored (the Hub fills them on
  // read; the store returns null), and `approvals` are the granted rows of
  // landing_approvals. A landing read back also carries its row's `seq`
  // (insertion order), as Phase 1's status listing did.
  /** Stores every field but `position`, `eta_ms` and `approvals`. */
  insertLanding(landing: Landing): void;
  getLanding(project: string, id: string): Landing | null;
  /** Changes the given columns only; at most one landing per project may be `running` (the update throws otherwise). */
  updateLanding(project: string, id: string, patch: LandingPatch): void;
  listLandings(project: string, filter: LandingFilter): Landing[];

  // Approvals (append-only: the store must refuse updates and deletes)
  /** Appends a decision with the landing's next `n` (from 1). */
  insertApproval(approval: Omit<ApprovalRow, 'n'>): ApprovalRow;
  /** Every approval and rejection of the landing, oldest first. */
  listApprovals(project: string, landingId: string): ApprovalRow[];

  // Lander control (one row per project)
  /** The project's control; the defaults (not paused, no trunk, DEFAULT_LAND_POLICY) until written. */
  getLanderControl(project: string): LanderControl;
  /** Writes the given fields, keeping the others; returns the result. */
  putLanderControl(project: string, patch: Partial<LanderControl>, now: number): LanderControl;

  // Symbol changes (Phase 3)
  /**
   * An `in_progress` change replaces the open row of its (agent, file, symbol)
   * in place, keeping that row's id and `created_at`; any other change, or one
   * with no open row, is a new row with id `S-<n>`. Returns the stored row.
   */
  upsertSymbolChange(change: Omit<SymbolChangeRow, 'id'>): SymbolChangeRow;
  /** Applies `patch` to every row matching `filter`; returns those rows as they are now, oldest first. An empty patch only reads them. */
  updateSymbolChanges(filter: SymbolChangeFilter, patch: SymbolChangePatch): SymbolChangeRow[];
  /** Rows updated at or after `since` in the given states, newest first. */
  listSymbolChanges(project: string, filter: { since: number; statuses: SymbolChangeStatus[]; limit?: number }): SymbolChangeRow[];

  // Event log (backs the push feed and replay after reconnect). Seqs are unique
  // across projects and increase in commit order.
  appendEvent(event: Omit<HubEvent, 'seq'>): number;
  eventsSince(project: string, afterSeq: number, limit: number): HubEvent[];
  latestSeq(project: string): number;
  /** Events of every project after `afterSeq`, for publishing what other processes on the database committed. */
  allEventsSince(afterSeq: number, limit: number): HubEvent[];
  /** The latest seq of any project. */
  lastSeq(): number;
}

export interface TransactionOptions {
  /** Commit with `synchronous = FULL`: for the write-ahead `pushing` row and every other landing or control write. */
  durable?: boolean;
}

export interface AgentTouch {
  client?: string | null;
  branch?: string | null;
  worktree?: string | null;
}

export interface AgentRow {
  project: string;
  agent: string;
  client: string | null;
  branch: string | null;
  worktree: string | null;
  first_seen: number;
  last_seen: number;
}

export interface ClaimFilter {
  statuses: ClaimStatus[];
  holder?: string;
  task_id?: string;
  /** The holds of this landing; null: only claims that are not holds. */
  landing_id?: string | null;
  /** Only claims with expires_at <= this. */
  expiresAtOrBefore?: number;
}

export type ClaimPatch = Partial<
  Pick<Claim, 'status' | 'scope' | 'granted_at' | 'expires_at' | 'ended_at' | 'end_reason' | 'task_id' | 'intent' | 'landing_id' | 'mapper' | 'holder'>
>;

/** Columns `updateLanding` can change: all stored ones but the landing's identity. */
export type LandingPatch = Partial<Omit<Landing, 'id' | 'project' | 'agent' | 'created_at' | 'position' | 'eta_ms' | 'approvals'>>;

export interface LandingFilter {
  statuses?: LandingStatus[];
  agent?: string;
  /** A task id, or null for landings without a task. */
  task_id?: string | null;
  /** A branch, or null for landings without one. */
  branch?: string | null;
  /** The submitted commit. */
  commit?: string;
  /** At most this many; all when omitted. */
  limit?: number;
  /**
   * `queue`: by `queue_seq`, landings without one last, ties (an inherited
   * place) in the order they were made. `recent`: newest first (by `seq`).
   */
  order: 'queue' | 'recent';
}

/** A row of the append-only landing_approvals table: an approval or a rejection. */
export interface ApprovalRow {
  project: string;
  landing_id: string;
  /** Order within the landing, from 1 (assigned by insertApproval). */
  n: number;
  kind: ApprovalKind;
  digest: string;
  /** The approver's human name. */
  approver: string;
  decision: 'approve' | 'reject';
  note: string;
  /** The landing of the same chain this approval was carried over from. */
  carried_from: string | null;
  at: number;
}

/** A stored signature change: the decisions are linked on read, by the Hub. */
export type SymbolChangeRow = Omit<SymbolChange, 'decisions'>;

export interface SymbolChangeFilter {
  project: string;
  ids?: string[];
  agent?: string;
  /** A task id, or null for changes without a task. */
  task_id?: string | null;
  landing_id?: string;
  file?: string;
  symbol?: string;
  statuses?: SymbolChangeStatus[];
}

export type SymbolChangePatch = Partial<Pick<SymbolChangeRow, 'status' | 'landing_id' | 'task_id' | 'updated_at'>>;
