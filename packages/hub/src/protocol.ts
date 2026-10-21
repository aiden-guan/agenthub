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
  /**
   * Phase 2: set while this claim is a landing hold. A hold never expires while
   * its landing is live (expires_at = HOLD_EXPIRES), never covers a new request
   * of its own holder, can't be released by its holder (409 held_by_landing),
   * and ends when the landing lands (released) or fails (back to a lease).
   */
  landing_id: string | null;
  /** Phase 3: MAPPER_VERSION that produced the symbol entries; null = every entry counts as its whole file. */
  mapper: string | null;
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
  /** Phase 3: required when any scope entry has a symbol; the MAPPER_VERSION that produced them (400 invalid_symbol otherwise). */
  mapper?: string;
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
  /** The holder's entries that overlap the request (an entry without symbol is its whole file). */
  scope: ScopeEntry[];
  /** Set when the conflicting claim is a landing hold: it frees when that landing lands or fails. */
  landing_id: string | null;
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

/** POST /claims/check. `files` alone is the Phase 1 file-level check; `scope` + `mapper` compare at symbol level (Phase 3). */
export interface CheckRequest {
  files?: string[];
  /**
   * Without it (the guard): only other agents' active exclusive claims count.
   * With it: for each file, the claims a `queue: false` request of the caller's
   * for that file alone in this mode would be denied for, queued waiters
   * included (`hub_wait` asks with `auto`, as the edit hook claims). Older hubs
   * ignore it.
   */
  mode?: ClaimRequestMode;
  scope?: ScopeEntry[];
  mapper?: string;
}

export interface CheckResult {
  /** Active exclusive claims by other agents on the given files; with `mode`, what such a request would be denied for. */
  conflicts: ClaimConflict[];
  /** Only with `mode`: waiting for these conflicts would never end (see ClaimResult.deadlock). */
  deadlock?: string;
  now: number;
  seq: number;
}

/**
 * Phase 2 adds `landing`: a live landing carries the task. It becomes `done`
 * when that landing lands and `in_progress` again (same owner) when it fails or
 * is cancelled. A landing task is not "in progress" for tying claims, can't be
 * taken by another agent, and `task update` refuses it (409 task_landing).
 */
export type TaskStatus = 'open' | 'in_progress' | 'landing' | 'done' | 'cancelled';

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

// Phase 1's `Landing` is replaced by the superset in the Phase 2 section below.

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
  /**
   * Phase 2: queue the commit for the lander. Requires `commit` to be a full sha
   * already pushed to `<refPrefix>land/<sha>`. Idempotent per (agent, commit)
   * while that landing is live (`replayed: true`).
   */
  queue?: boolean;
  /** Queue mode, advisory (the lander recomputes): paths changed base..commit, at most 20000. */
  files?: string[];
  /** Queue mode, Phase 3, advisory: the symbol scope of the change, with the mapper that produced it. */
  scope?: ScopeEntry[];
  mapper?: string;
  /** Queue mode, advisory: what the adapter's local preflight saw. */
  preview?: LandPreview;
}

export interface LandPreview {
  /** The trunk sha the adapter compared against. */
  trunk_seen: string | null;
  /** Paths git already sees conflicting with that trunk. */
  conflicts: string[];
  /** Changed paths that match protected rules on that trunk's agenthub.json. */
  protected: string[];
}

export interface LandResult {
  landing: Landing;
  task: Task | null;
  /** Record mode: claims released. Queue mode: the agent's claims that were moved into the hold (ended "moved to landing L-n"). */
  released: Claim[];
  /** Record mode only (queue mode unblocks when the landing lands). */
  unblocked: string[];
  /** Queue mode: the hold claims that now protect the change until it lands or fails. */
  held: Claim[];
  /** Queue mode: landings this one superseded. */
  superseded: string[];
  /** Queue mode: the same live landing already existed; nothing new was created. */
  replayed: boolean;
  /** Queue mode: 1 = next among submitted and queued landings (a running landing counts as ahead; design §2.1 step 7); null otherwise (needs_approval, running, terminal). */
  position: number | null;
  /** Queue mode: estimated milliseconds until it is on trunk; null without a lander. */
  eta_ms: number | null;
  /** Queue mode: the active lander, or null when none runs (nothing lands until one does). */
  lander: LanderInfo | null;
  /** For the agent: what happens next, written by the hub (no agent text). */
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
  /** Recent landings, newest first (at most 10, any status). */
  landings: Landing[];
  /** Phase 2: live landings (submitted, needs_approval, queued, running) in queue order. */
  queue: Landing[];
  /** Phase 2: the active lander lease, or null. */
  lander: LanderInfo | null;
  /** Phase 2: pause flag and the trunk tip the hub knows. */
  control: LanderControl;
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
  | 'land.requested'
  // Phase 2
  | 'landing.created'
  | 'landing.updated'
  | 'landing.needs_approval'
  | 'landing.landed'
  | 'landing.failed'
  | 'trunk.moved'
  | 'lander.paused'
  | 'lander.resumed'
  // Phase 3
  | 'symbol.changed';

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

/** GET /events. */
export interface EventsResult {
  /**
   * Events after `since` the caller may see, oldest first: at most 500, from at
   * most 5000 read. Fewer, or none, can come back while more follow: the read
   * stopped short of `seq`, and a long-poll then answers at once.
   */
  events: HubEvent[];
  /** The latest event seq. */
  seq: number;
  /**
   * The `since` to pass next time: after the last event returned, or, when
   * fewer than 500 came back, after every event read, including those the
   * caller can't see or didn't ask for. Below `seq`, more may follow. A `since`
   * past the latest seq is from another database (see `epoch`) and reads on
   * from the latest seq.
   */
  next_since: number;
  /** Made once per database; a new value means seqs started over. */
  epoch: string;
}

/** Frames sent by the hub over the WebSocket feed. */
export type FeedServerFrame =
  /**
   * `seq` is the latest seq when the feed opened. With `since`, every event
   * after it up to `seq` that this agent may see follows at once (a `since`
   * past `seq` is from another database and replays nothing). `epoch` is made
   * once per database; a new value means seqs started over.
   */
  | { type: 'hello'; project: string; agent: string | null; seq: number; epoch: string; now: number; heartbeat_interval_ms: number }
  | { type: 'event'; event: HubEvent }
  /**
   * After the events a `since` replays: `next_since` is the `since` to reconnect
   * with, past every event the replay read, those this agent can't see included.
   * Hubs older than it don't send it.
   */
  | { type: 'replayed'; next_since: number }
  | { type: 'heartbeat.ack'; renewed: number; next_heartbeat_ms: number; now: number }
  | { type: 'pong'; now: number }
  | { type: 'error'; code: string; message: string };

/** Frames a client may send over the WebSocket feed. */
export type FeedClientFrame = { type: 'heartbeat'; claim_ids?: string[]; client?: string; branch?: string; worktree?: string } | { type: 'ping' };

export interface ApiError {
  /** `details` carries structured data for some codes (claim_conflict: { conflicts: ClaimConflict[] }). */
  error: { code: string; message: string; details?: Record<string, unknown> };
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

// ===================================================================== Phase 2: landing queue
// Appended after the Phase 1 declarations. Every sha in a new field is a full
// lowercase object id (FULL_SHA_RE in @agenthub/contract); Phase 1 `recorded`
// rows may hold a 12-character commit.

export type LandingStatus =
  /** Phase 1 record-only rows; never processed. */
  | 'recorded'
  /** Created by `land`; holds taken from the agent's advisory scope; waits for lander admission. */
  | 'submitted'
  /** Admitted; waits for its turn (queue order: queue_seq). */
  | 'queued'
  /** Waits for a human approval; outside the one running slot. */
  | 'needs_approval'
  /** The one landing per project the lander works on (see `phase`). */
  | 'running'
  | 'landed'
  | 'failed'
  | 'cancelled'
  | 'superseded';

/**
 * Phases of a running landing. `pushing` is the write-ahead phase: the candidate
 * is staged on the remote and recorded before trunk is updated. A landing in
 * `pushing` can't be cancelled or superseded (409 too_late), is never requeued
 * by time or lease loss (it becomes `in_doubt`), and only a lander that has
 * looked at the remote moves it on.
 */
export type LandingPhase = 'merging' | 'resolving' | 'checking' | 'pushing';

export type LandingFailureCode =
  | 'not_pushed' // the land ref is missing or doesn't point at the commit
  | 'nothing_to_land'
  | 'too_large'
  | 'claim_conflict' // the change touches code another agent holds (claimGate: fail)
  | 'contains_unlanded' // the commit contains another agent's landing that did not land
  | 'conflict' // the merge ladder left conflicts
  | 'resolver_failed' // the AI resolver declined, its output failed verification, or the checks failed on it
  | 'checks_failed'
  | 'check_timeout'
  | 'checks_modified_tree'
  | 'trunk_busy' // trunk moved outside the queue more than 3 times in one landing
  | 'push_rejected' // the remote refused the trunk update for policy reasons (the project pauses)
  | 'approval_rejected'
  | 'approval_timeout'
  | 'lander_lost' // the lander died while running it more than 3 times
  | 'lander_stuck' // a step outlived its deadline more than twice
  | 'lander_error'; // a lander bug or infrastructure failure; not caused by the change

export type RequeueReason =
  | 'trunk_moved'
  | 'lander_lost'
  | 'lander_stopping'
  | 'step_timeout'
  | 'remote_unavailable'
  | 'config_invalid'
  | 'trunk_rewritten'
  | 'approved';

export type ResolvedBy = 'none' | 'clean' | 'structural' | 'ai';

/** What an approval covers (design §1.4): the agent's own protected change, the merged protected content, or an AI resolution. */
export type ApprovalKind = 'protected' | 'merged' | 'ai_resolution';

export interface ApprovalRule {
  /** Globs as written in trunk's agenthub.json. */
  paths: string[];
  /** Humans who may approve; null = any configured approver. */
  approvers: string[] | null;
  /** The approver must not be the landing agent's human. */
  distinct: boolean;
}

/** An approval the landing still needs, as computed by the lander from trunk's config. */
export interface ApprovalRequirement {
  kind: ApprovalKind;
  /** sha256 hex over exactly the content a human is shown (gitops.approvalDigest); `hub approve` recomputes it. */
  digest: string;
  /** Protected paths it covers, sorted. */
  paths: string[];
  /** Every rule must be satisfied by an approval with this digest from someone the rule allows. */
  rules: ApprovalRule[];
  /** merged / ai_resolution: the staged candidate the digest covers, and the trunk tip it was built on. */
  candidate: string | null;
  candidate_ref: string | null;
  trunk_base: string | null;
}

/** A granted approval (append-only audit, table landing_approvals). */
export interface LandingApproval {
  kind: ApprovalKind;
  digest: string;
  /** The approver's human name. */
  by: string;
  at: number;
  /** The approver's words: shown to agents as a teammate's text, never as instructions. */
  note: string;
  /** Set when carried over from an earlier landing of the same chain with the same digest. */
  carried_from: string | null;
}

export interface ConflictHunk {
  /** Lines of the conflict-marked file, 1-based. */
  start_line: number;
  end_line: number;
  /** Phase 3: declarations the hunk lies in; [] when unknown. */
  symbols: string[];
  /** Each side capped at 80 lines / 4 KiB. Code written by agents: untrusted text. */
  base: string;
  trunk: string;
  yours: string;
}

/** A trunk commit since the merge base that changed a conflicted file: who changed the trunk side, and why. */
export interface TrunkChange {
  commit: string;
  /** null: pushed outside the landing queue. */
  landing_id: string | null;
  agent: string | null;
  task_id: string | null;
  /** Another agent's summary: untrusted text. */
  summary: string;
  decisions: Array<{ id: string; summary: string }>;
}

export interface ConflictReport {
  file: string;
  kind: 'content' | 'modify_delete' | 'rename' | 'binary' | 'mode' | 'other';
  /** At most 10 per file. */
  hunks: ConflictHunk[];
  /** Newest first, at most 5. */
  trunk_changes: TrunkChange[];
  tried: ResolvedBy[];
  ai_eligible: boolean;
  /** The resolver's explanation when it declined (untrusted model text). */
  explanation: string | null;
}

export interface CheckReport {
  /** First 12 hex of sha256 of the check command (as in the Agenthub-Checked trailer). */
  command_hash: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  /** Last 200 lines / 16 KiB, ANSI stripped, secrets redacted. Output of repository code: untrusted text. */
  log_tail: string;
  /** Best effort, from vitest/jest, node:test, mocha, pytest, go test and cargo test output. */
  failed_tests: string[];
  /** true: the trunk tip landed through the queue under the same check command; null: unknown (e.g. a foreign commit). */
  passes_on_trunk: boolean | null;
  /** One shell line that reproduces the run on the agent's machine. */
  reproduce: string;
}

export interface ResolverReport {
  model: string;
  outcome: 'resolved' | 'cannot_resolve' | 'rejected_output' | 'error' | 'skipped';
  files: string[];
  /** Output lines found in none of base/trunk/incoming. */
  novel_lines: number;
  input_tokens: number;
  output_tokens: number;
  /** path → the resolver's explanation (untrusted model text). */
  explanations: Record<string, string>;
}

/** Lander-written report. Only the fields documented as untrusted carry agent- or code-derived text. */
export interface LandingReport {
  /** One paragraph for the author, written by the lander. */
  message: string;
  resolved_by: ResolvedBy | null;
  files_via: Array<{ file: string; via: ResolvedBy }>;
  conflicts: ConflictReport[];
  check: CheckReport | null;
  resolver: ResolverReport | null;
  /** Concrete next steps in order, with exact tool calls and commands. */
  next_steps: string[];
  warnings: string[];
  foreign_commits: string[];
  timings: { queued_ms: number; merge_ms: number; check_ms: number; push_ms: number } | null;
}

/** Superset of the Phase 1 `Landing`; Phase 1 field names are kept (`commit` = the submitted commit). */
export interface Landing {
  id: string;
  project: string;
  agent: string;
  task_id: string | null;
  branch: string | null;
  commit: string | null;
  summary: string;
  status: LandingStatus;
  created_at: number;
  updated_at: number;
  /** Queue order: lower runs first. Kept on requeue; inherited along a retry chain (keepPlaceRetries) and by a superseding landing. */
  queue_seq: number | null;
  /** Computed on read: 1 = next among submitted and queued landings (a running one counts as ahead); null in every other status. */
  position: number | null;
  /** Computed on read from recent attempt durations; null without a lander. */
  eta_ms: number | null;
  phase: LandingPhase | null;
  phase_at: number | null;
  /** 0 until a lander first picks it up; +1 per pickup. */
  attempt: number;
  /** The lander process that runs it (lander/<host>-<pid>-<rand>). */
  lander: string | null;
  /** The lander lease claim the current attempt runs under (fencing token, with the hub epoch). */
  lease_claim_id: string | null;
  /** In `pushing` when the lease that ran it ended: the next lease holder must resolve it from the remote first. */
  in_doubt: boolean;
  /** Running (not pushing): the hub requeues it (step_timeout) past this. needs_approval: it fails (approval_timeout) past this. */
  deadline_at: number | null;
  /** The base the lander diffed against (landed base, design §1.1). */
  base_sha: string | null;
  /** The trunk tip of the first attempt: the lower bound of every trailer search for this landing. */
  first_base: string | null;
  /** The trunk tip the current attempt merges onto (T0). */
  trunk_base: string | null;
  /** The staged candidate (set when entering `pushing`, or when parked in needs_approval). */
  candidate: string | null;
  candidate_ref: string | null;
  /** The checks passed on exactly `candidate` (a parked landing): resuming on the same trunk_base pushes it without re-running them. */
  candidate_checked: boolean;
  /** The trunk commit that carries it, once landed. */
  trunk_sha: string | null;
  /** Changed paths (adapter's advisory list until admission, the lander's after), at most 2000 returned. */
  files: string[];
  /** Phase 3: symbol scope of the change; null when unknown or file-level only. */
  scope: ScopeEntry[] | null;
  mapper: string | null;
  protected: string[];
  /** Approvals still needed. Requested at admission and may be pending while queued or running; the landing parks in needs_approval only once its checks have passed. */
  approval: ApprovalRequirement[];
  /** Approvals granted, oldest first. */
  approvals: LandingApproval[];
  /** The hold claims protecting the change while it is live. */
  hold_ids: string[];
  report: LandingReport | null;
  failure: { code: LandingFailureCode; summary: string } | null;
  retries: { trunk_moved: number; lander_lost: number; step_timeout: number };
  /** The failed landing of the same task and agent this one fixes. */
  retry_of: string | null;
  /** Retries so far in this chain (0 for a first landing). */
  retry: number;
  supersedes: string | null;
  superseded_by: string | null;
  /** Another live landing whose commit this one contains: `next` skips this one until that is terminal. */
  waits_for: string | null;
  /** Set on a same-agent failed or superseded landing whose commit landed inside this other landing. */
  landed_with: string | null;
  /** Marked landed by the lander's trunk scan (its commit was found on trunk) rather than by its own attempt. */
  reconciled: boolean;
  started_at: number | null;
  ended_at: number | null;
}

/** The active lander lease (an ordinary claim on LANDER_LEASE_KEY). */
export interface LanderInfo {
  holder: string;
  claim_id: string;
  expires_at: number;
  /** Landers queued on the lease, next first. */
  standby: string[];
}

export interface TrunkInfo {
  sha: string;
  /** The landing that put it there; null for a commit pushed outside the queue. */
  landing_id: string | null;
  at: number;
}

/** Policy the hub applies itself, as the lander read it from trunk's agenthub.json (defaults until a lander reports). */
export interface LandPolicy {
  keep_place_retries: number;
  sendback_grace_min: number;
  approval_timeout_hours: number;
  claim_gate: 'fail' | 'warn';
}

export interface LanderControl {
  /** While set, `next` starts nothing (it still returns in-doubt landings). Only an approver clears it. */
  paused: { reason: 'trunk_rewritten' | 'push_rejected' | 'config_invalid' | 'external_push' | 'human'; detail: string; at: number; by: string } | null;
  /** The trunk tip the hub last heard of from a lander. */
  trunk: TrunkInfo | null;
  policy: LandPolicy;
}

/** Every lander write carries its lease: the lease claim id and the hub epoch it was granted under. */
export interface LanderAuth {
  lease_claim_id: string;
  epoch: string;
}

export interface LanderNextRequest {
  lease: LanderAuth;
}

export interface LanderNextResult {
  /**
   * The landing to work on: an in-doubt landing, or the caller's own running
   * landing, first (also while paused); else, unless paused, the lowest
   * queue_seq queued landing whose waits_for is terminal, now running in phase
   * merging with attempt + 1. null when nothing is eligible.
   */
  landing: Landing | null;
  /** true: `landing` is in `pushing` and must be resolved from the remote before anything else. */
  resolve: boolean;
  control: LanderControl;
  now: number;
  seq: number;
}

export interface LandingAdmitRequest {
  lease: LanderAuth;
  /** The lander's own diff of base..commit (authoritative). */
  base_sha: string;
  files: string[];
  scope: ScopeEntry[] | null;
  mapper: string | null;
  protected: string[];
  /** Approvals the change needs per trunk's config (kind protected). */
  required: ApprovalRequirement[];
  waits_for: string | null;
  warnings: string[];
  /**
   * T3 (amended at CP1a): set to fail the landing at admission instead of admitting it
   * (not_pushed, nothing_to_land, too_large, contains_unlanded). The hub then applies the
   * failure effects; `base_sha` may be omitted when the land ref was never fetched.
   * `advance {to: 'failed', attempt: 0, code, report}` on a submitted landing does the same.
   */
  code?: LandingFailureCode;
  report?: LandingReport;
}

export interface LandingAdmitResult {
  landing: Landing;
  /** Non-empty when the claim gate failed the landing (or, with claimGate: warn, what both sides were told). */
  conflicts: ClaimConflict[];
  now: number;
  seq: number;
}

export type LandingAdvanceRequest =
  | { lease: LanderAuth; attempt: number; to: 'running'; phase: 'merging' | 'resolving' | 'checking'; deadline_ms: number; trunk_base?: string }
  | {
      lease: LanderAuth;
      attempt: number;
      to: 'running';
      phase: 'pushing';
      candidate: string;
      candidate_ref: string;
      trunk_base: string;
      tree: string;
      /** Every approval this exact candidate needs; the hub refuses (409 approval_missing) unless each is granted. */
      required: ApprovalRequirement[];
    }
  | { lease: LanderAuth; attempt: number; to: 'queued'; reason: RequeueReason }
  | {
      lease: LanderAuth;
      attempt: number;
      to: 'needs_approval';
      required: ApprovalRequirement[];
      report: LandingReport;
      /** (Amended at CP1a.) The candidate the checks passed on, staged at candidate_ref (§2.2.5 P8), for the approved fast path (P6). */
      candidate?: string;
      candidate_ref?: string;
    }
  | {
      lease: LanderAuth;
      attempt: number;
      to: 'landed';
      trunk_sha: string;
      base_sha: string;
      files: string[];
      report: LandingReport;
      /** Same-agent failed or superseded landings whose commits this one contained. */
      also_landed: string[];
      /** Phase 3: signature changes this landing made (lander-computed, T0 vs candidate). */
      symbol_changes: SymbolChangeInput[];
    }
  | { lease: LanderAuth; attempt: number; to: 'failed'; code: LandingFailureCode; report: LandingReport };

/** Resolving an in-doubt `pushing` landing (design §2.2.7): only after inspecting the remote. */
export type LandingResolveRequest =
  | { lease: LanderAuth; outcome: 'landed'; trunk_sha: string; symbol_changes: SymbolChangeInput[] }
  /** Only when trunk has moved past trunk_base without the candidate (it can never land now), or the staged candidate is gone. */
  | { lease: LanderAuth; outcome: 'requeue'; trunk_sha: string };

export interface LandingAdvanceResult {
  landing: Landing;
  /** Holds released (landed) or turned back into leases (failed, cancelled). */
  released: Claim[];
  unblocked: string[];
  /** true: this request was already applied; nothing changed now. */
  replayed: boolean;
  now: number;
  seq: number;
}

export interface TrunkReportRequest {
  lease: LanderAuth;
  /** The trunk tip the hub knew (control.trunk.sha), or null on the first report. */
  from: string | null;
  to: string;
  /**
   * First-parent commits from..to, oldest first, at most 500, with their
   * Agenthub trailers. The hub matches Landing + Hub (its epoch) + Source (the
   * landing's commit); a match whose landing isn't landed is reconciled to
   * landed; a commit matching nothing is foreign (trunk.moved {foreign: true}).
   */
  commits: Array<{ sha: string; landing: string | null; hub: string | null; source: string | null; files: string[] }>;
  /** `to` does not descend from `from`: the hub pauses landing (trunk_rewritten). */
  rewritten: boolean;
  /** Trunk's config as the lander parsed it: the hub applies these itself. */
  policy: LandPolicy;
}

export interface LanderPauseRequest {
  lease: LanderAuth;
  reason: 'push_rejected' | 'config_invalid' | 'external_push' | 'trunk_rewritten';
  detail: string;
}

/** Approver only. `accept_trunk` records that sha as the trunk tip after a rewrite. */
export interface LanderResumeRequest {
  accept_trunk?: string;
}

/** Approver only (headers x-hub-approver, x-hub-approver-token). */
export interface ApproveRequest {
  kind: ApprovalKind;
  /** Must equal a pending requirement's digest (409 approval_stale otherwise). */
  digest: string;
  note?: string;
}

export interface RejectRequest {
  reason: string;
}

export interface CancelRequest {
  reason?: string;
}

export interface LandingStats {
  days: number;
  landed: number;
  /** First landing of a retry chain created_at → landed ended_at. The Phase 2 goal: median under 15 minutes. */
  median_to_trunk_ms: number | null;
  p90_to_trunk_ms: number | null;
  /** Chains that landed with no send-back / chains that landed. */
  first_try_rate: number | null;
  sendbacks: Partial<Record<LandingFailureCode, number>>;
  median_check_ms: number | null;
  median_queue_wait_ms: number | null;
  resolved_by: Partial<Record<ResolvedBy, number>>;
}

// ===================================================================== Phase 3: symbol changes

export type SymbolChangeKind = 'signature' | 'removed' | 'renamed';
export type SymbolChangeStatus = 'in_progress' | 'landed' | 'withdrawn' | 'superseded';

export interface SymbolChangeInput {
  file: string;
  /** SYMBOL_KEY_RE key, e.g. `login` or `Session.refresh`. */
  symbol: string;
  kind: SymbolChangeKind;
  /** Normalized signature text, at most 500 characters. Code: untrusted text. */
  before: string;
  /** null for removed. For renamed: the new key's signature. */
  after: string | null;
  /** For renamed: the new key. */
  renamed_to?: string;
  task_id?: string;
}

export interface SymbolChange {
  id: string;
  project: string;
  agent: string;
  task_id: string | null;
  landing_id: string | null;
  file: string;
  symbol: string;
  /** Last segment of `symbol`: what references are matched by. */
  name: string;
  kind: SymbolChangeKind;
  before: string;
  after: string | null;
  renamed_to: string | null;
  status: SymbolChangeStatus;
  created_at: number;
  updated_at: number;
  /** Up to 3, newest first: decisions with the same task_id, or whose symbols name the key or name. Untrusted text. */
  decisions: Array<Pick<Decision, 'id' | 'agent' | 'summary'>>;
}

export interface SymbolChangesRequest {
  changes: SymbolChangeInput[];
}

export interface SymbolChangesResult {
  changes: SymbolChange[];
  now: number;
  seq: number;
}
