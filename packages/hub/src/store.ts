import type { Claim, ClaimStatus, Decision, HubEvent, Landing, Message, Task } from './protocol.js';

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
  /** Run `fn` atomically. Writes made inside commit together or not at all. */
  transaction<T>(fn: () => T): T;
  close(): void;

  ensureProject(project: string, now: number): void;
  listProjects(): string[];
  /** Per-project monotonic counter, used for readable ids (T-1, C-7, D-3, L-2). */
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
  /** Projects that have active or queued claims with `expires_at <= now`. */
  projectsWithDueClaims(now: number): string[];

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

  // Landing requests
  insertLanding(landing: Landing): void;
  listLandings(project: string, limit: number): Landing[];

  // Event log (backs the push feed and replay after reconnect)
  appendEvent(event: Omit<HubEvent, 'seq'>): number;
  eventsSince(project: string, afterSeq: number, limit: number): HubEvent[];
  latestSeq(project: string): number;
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
  /** Only claims with expires_at <= this. */
  expiresAtOrBefore?: number;
}

export type ClaimPatch = Partial<
  Pick<Claim, 'status' | 'scope' | 'granted_at' | 'expires_at' | 'ended_at' | 'end_reason' | 'task_id' | 'intent'>
>;
