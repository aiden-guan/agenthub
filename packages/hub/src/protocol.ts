// Wire types shared by the hub and the adapter. This module has no runtime
// imports, so the adapter can `import type` from it without pulling in SQLite.
// All timestamps are milliseconds since the Unix epoch.

export type ClaimMode = 'exclusive' | 'shared';
/** `auto` = exclusive when nobody else holds the file, shared when others hold it shared. */
export type ClaimRequestMode = ClaimMode | 'auto';
export type ClaimStatus = 'active' | 'queued' | 'released' | 'expired';

/** One entry of a claim's scope. Phase 1 compares files only; `symbol` is stored for Phase 3. */
export interface ScopeEntry {
  /**
   * Repo-relative POSIX path, stored and compared in NFC form. The hub answers
   * 400 `invalid_path` for control, line-separator or bidi characters, an
   * unpaired surrogate, an absolute path, or a `.`, `..` or empty segment.
   */
  file: string;
  symbol?: string;
}

export interface Claim {
  id: string;
  project: string;
  holder: string;
  /** The request's task_id, else the holder's one task in progress when the claim was made (or, if it had none, renewed). */
  task_id: string | null;
  scope: ScopeEntry[];
  mode: ClaimMode;
  intent: string;
  base_commit: string | null;
  status: ClaimStatus;
  created_at: number;
  granted_at: number | null;
  /** The lease runs out at this time unless a heartbeat renews it. */
  expires_at: number;
  ttl_ms: number;
  heartbeat_interval_ms: number;
  ended_at: number | null;
  end_reason: string | null;
}

export interface ClaimRequest {
  files?: string[];
  scope?: ScopeEntry[];
  mode?: ClaimRequestMode;
  intent?: string;
  task_id?: string;
  base_commit?: string;
  ttl_ms?: number;
  heartbeat_interval_ms?: number;
  /** When contended: true joins the queue, false (default) returns `denied`. */
  queue?: boolean;
}

/** Another agent's claim that stands in the way of a request. */
export interface ClaimConflict {
  claim_id: string;
  holder: string;
  mode: ClaimMode;
  status: ClaimStatus;
  intent: string;
  task_id: string | null;
  /** The overlapping files. */
  files: string[];
  expires_at: number;
}

export interface ClaimResult {
  status: 'granted' | 'queued' | 'denied';
  /** The claim created (granted or queued) or, on renewal, the first covering claim. */
  claim?: Claim;
  /** Every claim of yours that covers the request after this call. */
  claims: Claim[];
  renewed: boolean;
  conflicts: ClaimConflict[];
  /** Position in the queue (1 = next), only when queued. */
  position?: number;
  /**
   * Only when denied, and only when waiting would deadlock: a holder in the way is
   * itself waiting, directly or not, for a claim of yours. Names the claims and
   * agents in the cycle (no paths or intents) and which of your claims to release.
   * When the holder only waits in line behind a queued claim of yours, it also says
   * that asking again with `queue: true` works: the hub then reorders that line.
   */
  deadlock?: string;
  now: number;
  seq: number;
}

/** `claim_id`, `task_id` and `files` narrow each other (`files` drops just those files from a claim); `all` alone names every claim of yours. */
export interface ReleaseRequest {
  claim_id?: string;
  files?: string[];
  task_id?: string;
  all?: boolean;
}

export interface ReleaseResult {
  released: Claim[];
  /** Claims that lost some files but still hold others. */
  trimmed: Claim[];
  /** Queued claims (anyone's) granted as a result. */
  promoted: Claim[];
  now: number;
  seq: number;
}

export interface HeartbeatRequest {
  claim_ids?: string[];
  client?: string;
  branch?: string;
  worktree?: string;
}

export interface HeartbeatResult {
  renewed: number;
  claims: Claim[];
  next_heartbeat_ms: number;
  now: number;
  seq: number;
}

export interface CheckResult {
  /** Active exclusive claims by other agents on the given files. */
  conflicts: ClaimConflict[];
  now: number;
  seq: number;
}

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';

export interface Task {
  id: string;
  project: string;
  title: string;
  description: string;
  deps: string[];
  owner: string | null;
  status: TaskStatus;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  /** Dependencies that are not done yet. A task with any is blocked: it can't be taken or completed (409 `task_blocked`). */
  blocked_by: string[];
}

export interface TaskCreateRequest {
  title: string;
  description?: string;
  deps?: string[];
}

export interface Message {
  id: number;
  project: string;
  from: string;
  /** Recipient agent for a direct message. */
  to: string | null;
  /** Channel name such as `#general` for a channel message. */
  channel: string | null;
  body: string;
  created_at: number;
}

export interface InboxResult {
  messages: Message[];
  unread_remaining: number;
  now: number;
}

export interface Decision {
  id: string;
  project: string;
  agent: string;
  summary: string;
  rationale: string;
  files: string[];
  symbols: string[];
  task_id: string | null;
  created_at: number;
}

export interface DecisionRequest {
  summary: string;
  rationale?: string;
  files?: string[];
  symbols?: string[];
  task_id?: string;
}

export interface Landing {
  id: string;
  project: string;
  agent: string;
  task_id: string | null;
  branch: string | null;
  commit: string | null;
  summary: string;
  status: 'recorded';
  created_at: number;
}

export interface LandRequest {
  task_id?: string;
  branch?: string;
  commit?: string;
  summary?: string;
  /**
   * Release the claims tied to the task, and those tied to no task once no other
   * task of yours is in progress; claims tied to another task stay. With no
   * task_id, release all of yours (default true).
   */
  release_claims?: boolean;
}

export interface LandResult {
  landing: Landing;
  task: Task | null;
  released: Claim[];
  unblocked: string[];
  /** For the agent: nothing was merged, and which of its claims it still holds, if any. */
  note: string;
  now: number;
  seq: number;
}

export interface AgentInfo {
  agent: string;
  client: string | null;
  branch: string | null;
  worktree: string | null;
  first_seen: number;
  last_seen: number;
  online: boolean;
  current_task: string | null;
}

export interface StatusResult {
  project: string;
  agent: string | null;
  now: number;
  seq: number;
  lease: { ttl_ms: number; heartbeat_interval_ms: number };
  agents: AgentInfo[];
  /** Active and queued claims, all agents. */
  claims: Claim[];
  tasks: Task[];
  unread: number;
  decisions: Decision[];
  landings: Landing[];
}

export type HubEventType =
  | 'agent.online'
  | 'claim.granted'
  | 'claim.queued'
  | 'claim.released'
  | 'claim.expired'
  | 'task.created'
  | 'task.taken'
  | 'task.updated'
  | 'task.unblocked'
  | 'message.posted'
  | 'decision.recorded'
  | 'land.requested';

export interface HubEvent {
  seq: number;
  project: string;
  type: HubEventType;
  actor: string | null;
  at: number;
  data: Record<string, unknown>;
  /** null = everyone in the project; otherwise only these agents may see it. */
  targets: string[] | null;
}

/** Frames sent by the hub over the WebSocket feed. */
export type FeedServerFrame =
  | { type: 'hello'; project: string; agent: string | null; seq: number; now: number; heartbeat_interval_ms: number }
  | { type: 'event'; event: HubEvent }
  | { type: 'heartbeat.ack'; renewed: number; next_heartbeat_ms: number; now: number }
  | { type: 'pong'; now: number }
  | { type: 'error'; code: string; message: string };

/** Frames a client may send over the WebSocket feed. */
export type FeedClientFrame = { type: 'heartbeat'; claim_ids?: string[]; client?: string; branch?: string; worktree?: string } | { type: 'ping' };

export interface ApiError {
  error: { code: string; message: string };
}

/** `human/agent`, e.g. `maya/claude-2`. */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CHANNEL_RE = /^#[a-z0-9][a-z0-9._-]{0,63}$/;
export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/;
/**
 * A character no repo path may contain: C0 and C1 controls, line and paragraph
 * separators, bidi controls, and unpaired surrogates (which aren't text, and
 * which SQLite would store as U+FFFD, so the path would never match itself).
 */
export const PATH_FORBIDDEN_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\p{Cs}]/u;
