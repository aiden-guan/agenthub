// The ports the lander's pipeline is written against (design §2.2.1): the
// same code runs against real git and a real hub, and in the deterministic
// simulation (§5.2) against fakes. HubPort is implemented over HTTP by
// hub-client.ts, GitPort over @agenthub/gitops by git-port.ts, ChecksPort by
// checks.ts; ResolverPort comes with the AI resolver (L5) and Faults with
// faults.ts (L3). Only types and tiny defaults live here.

import type {
  ConflictEntry,
  LandedBase,
  LandingTrailers,
  MergeOptions,
  MergeResult,
  PushOutcome,
} from '@agenthub/gitops';
import type { ProtectedRule, ResolverConfig } from '@agenthub/contract';
import type {
  ApprovalRequirement,
  CheckReport,
  Claim,
  ClaimRequest,
  ClaimResult,
  Decision,
  EventsResult,
  HeartbeatRequest,
  HeartbeatResult,
  HubEventType,
  LanderControl,
  LanderInfo,
  LanderNextRequest,
  LanderNextResult,
  LanderPauseRequest,
  Landing,
  LandingAdmitRequest,
  LandingAdmitResult,
  LandingAdvanceRequest,
  LandingAdvanceResult,
  LandingResolveRequest,
  LandingStatus,
  Message,
  ReleaseRequest,
  ReleaseResult,
  ResolverReport,
  StatusResult,
  Task,
  TrunkReportRequest,
} from '@agenthub/hub/protocol';

// ------------------------------------------------------------------ hub

/**
 * Error codes a hub call can fail with: the hub's own codes (design §1.9 and
 * Phase 1's), plus `unavailable` (no answer: network error, timeout, or an
 * HTTP 5xx) and `bad_response` (an answer that isn't the hub's JSON).
 */
export type HubErrorCode =
  | 'not_lander'
  | 'landing_stale'
  | 'approval_missing'
  | 'landing_closed'
  | 'too_late'
  | 'claim_conflict'
  | 'held_by_landing'
  | 'lander_token_required'
  | 'forbidden'
  | 'unauthorized'
  | 'not_found'
  | 'bad_request'
  | 'bad_agent'
  | 'invalid_path'
  | 'invalid_symbol'
  | 'unavailable'
  | 'bad_response'
  /** The caller's own signal ended the call (a long-poll cut short); nothing is wrong with the hub. */
  | 'aborted'
  | (string & {});

/**
 * A hub call that failed. `status` is the HTTP status, or null when no
 * response came back (`unavailable`, `aborted`): then the request may or may
 * not have been applied, and a lander must treat it like a dropped response.
 */
export class HubCallError extends Error {
  constructor(
    readonly code: HubErrorCode,
    readonly status: number | null,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HubCallError';
  }

  /** No answer, or a broken hub (HTTP 5xx): the outcome is unknown and the call may be retried. */
  get unavailable(): boolean {
    return this.code === 'unavailable' || (this.status !== null && this.status >= 500);
  }
}

export function isHubError(err: unknown, ...codes: HubErrorCode[]): err is HubCallError {
  return err instanceof HubCallError && (codes.length === 0 || codes.includes(err.code));
}

export interface LandingsFilter {
  status?: LandingStatus[];
  agent?: string;
  task?: string;
  limit?: number;
}

export interface EventsQuery {
  /** After this seq; the hub's latest when omitted. */
  since?: number;
  types?: HubEventType[];
  /** Long-poll: wait up to this long for the first event (0 = answer at once). */
  waitMs?: number;
  signal?: AbortSignal;
}

/**
 * Every hub call the lander makes (design §1.7). Lander writes carry their
 * lease in the request (fencing, §1.5); the transport adds the lander's agent
 * id and token. Failures reject with HubCallError.
 */
export interface HubPort {
  /** POST /claims: the lander lease is a claim on LANDER_LEASE_KEY. */
  claim(req: ClaimRequest): Promise<ClaimResult>;
  /** GET /claims/:id: a standby watches its queued lease claim. */
  getClaim(id: string): Promise<Claim>;
  /** POST /heartbeat: renews the lease (and keeps a standby's place). */
  heartbeat(req?: HeartbeatRequest): Promise<HeartbeatResult>;
  /** POST /claims/release: gives the lease up at shutdown. */
  release(req: ReleaseRequest): Promise<ReleaseResult>;
  next(req: LanderNextRequest): Promise<LanderNextResult>;
  admit(id: string, req: LandingAdmitRequest): Promise<LandingAdmitResult>;
  advance(id: string, req: LandingAdvanceRequest): Promise<LandingAdvanceResult>;
  resolve(id: string, req: LandingResolveRequest): Promise<LandingAdvanceResult>;
  reportTrunk(req: TrunkReportRequest): Promise<{ control: LanderControl }>;
  pause(req: LanderPauseRequest): Promise<{ control: LanderControl }>;
  /** GET /lander. */
  lander(): Promise<{ lease: LanderInfo | null; control: LanderControl }>;
  /** GET /landings: live landings first, in queue order, then the most recent. */
  landings(filter?: LandingsFilter): Promise<Landing[]>;
  landing(id: string): Promise<Landing>;
  tasks(): Promise<Task[]>;
  decisions(limit?: number): Promise<Decision[]>;
  /** POST /messages: a direct message from the lander to an agent. */
  post(to: string, body: string): Promise<Message>;
  /** GET /events, optionally long-polling; also how the lander learns the hub epoch. */
  events(q?: EventsQuery): Promise<EventsResult>;
  status(): Promise<StatusResult>;
}

// ------------------------------------------------------------------ git

export type FetchOutcome =
  | { kind: 'ok' }
  /** A source ref the refspecs name doesn't exist on the remote. */
  | { kind: 'missing'; detail: string }
  /** The remote couldn't be reached, or refused: try again later (remote_unavailable). */
  | { kind: 'error'; detail: string };

export interface CommitInfo {
  sha: string;
  subject: string;
  author: { name: string; email: string; date: string };
}

/** A first-parent trunk commit that touched a path, with its subject and trailers. */
export type PathChange = LandingTrailers & { subject: string };

export interface MergeFileResult {
  /** `git merge-file -p --diff3` output, labels trunk / base / yours. */
  text: string;
  /** Conflict regions in `text`. */
  conflicts: number;
  /** The conflict-marker length used (at least 7; longer when a side has marker-like lines). */
  markerSize: number;
}

/**
 * Git as the pipeline sees it: the lander's bare mirror and its remote, a thin
 * layer over @agenthub/gitops (git-port.ts). Every call is isolated (§2.2.2).
 */
export interface GitPort {
  /** `git fetch --no-write-fetch-head <remote> <refspecs>` (explicit refspecs only). */
  fetch(refspecs: string[]): Promise<FetchOutcome>;
  revParse(rev: string): Promise<string | null>;
  isAncestor(a: string, b: string): Promise<boolean>;
  /** NFC paths changed a..b, sorted, no rename detection. */
  diffNames(a: string, b: string): Promise<string[]>;
  showBlob(rev: string, path: string): Promise<string | null>;
  blobId(rev: string, path: string): Promise<string | null>;
  /** The tree of a commit. */
  treeOf(commit: string): Promise<string>;
  commitInfo(commit: string): Promise<CommitInfo>;
  /** Commits reachable from `to` and not from `from`, oldest first, at most `limit` (the newest ones). */
  commits(from: string, to: string, limit: number): Promise<{ total: number; commits: CommitInfo[] }>;
  mergeTrees(ours: string, theirs: string, o: MergeOptions): Promise<MergeResult>;
  spliceTree(tree: string, blobs: Array<{ path: string; mode: string; content: string }>): Promise<string>;
  commitTree(tree: string, parent: string, message: string, author: { name: string; email: string; date: string }, committer: { name: string; email: string }): Promise<string>;
  landedBase(trunk: string, tip: string): Promise<LandedBase>;
  trunkTrailers(from: string | null, to: string, limit?: number): Promise<LandingTrailers[]>;
  findLandingCommit(from: string | null, to: string, key: { landing: string; hub: string; source: string }): Promise<string | null>;
  /** First-parent commits in from..to that changed `path`, newest first, at most `limit`. */
  pathHistory(from: string, to: string, path: string, limit: number): Promise<PathChange[]>;
  /** Three-way merge of blobs (null = absent), as `git merge-file -p --diff3 -L trunk -L base -L yours`. */
  mergeFile(blobs: { trunk: string | null; base: string | null; yours: string | null }): Promise<MergeFileResult>;
  pushTrunk(o: { trunk: string; candidate: string; expected: string; deleteRef?: string }): Promise<PushOutcome>;
  pushRef(o: { prefix: string; sha: string | null; ref: string }): Promise<PushOutcome>;
  lsRemote(ref: string): Promise<string | null>;
  /** Deletes a ref in the mirror (no-op when it is missing). */
  deleteLocalRef(ref: string): Promise<void>;
}

// ------------------------------------------------------------------ checks

/** One check run (design §2.2.8): trunk's check command in a fresh worktree of exactly the candidate. */
export interface CheckRunRequest {
  landingId: string;
  attempt: number;
  /** The candidate C (full sha), already in the mirror. */
  candidate: string;
  /** T0, the trunk tip C was built on. */
  trunk: string;
  /** The hub's database epoch: `passes_on_trunk` needs T0's Agenthub-Hub trailer to match it. */
  epoch: string;
  /** Trunk's `land.check`. */
  command: string;
  timeoutMs: number;
  checkEnv: Record<string, string>;
  allowDirtyTree: boolean;
  /** For the `reproduce` line: the agent-side remote name and the staged candidate ref. */
  remote: string;
  candidateRef: string;
  /** Polled while the check runs; resolving true aborts it (trunk moved: only a foreign push can do that). */
  trunkWatch?: { intervalMs: number; moved(): Promise<boolean> };
  /** Aborts the run from outside (not_lander, landing_stale, shutdown). */
  signal?: AbortSignal;
}

export type CheckStatus =
  | 'passed'
  /** Non-zero exit (checks_failed). */
  | 'failed'
  /** checkTimeoutMin passed; the process group was killed (check_timeout). */
  | 'timed_out'
  /** Exit 0, but tracked files changed (checks_modified_tree). */
  | 'modified_tree'
  /** The trunk watch saw trunk move; the run was killed (requeue trunk_moved). */
  | 'trunk_moved'
  /** `signal` aborted the run. */
  | 'aborted';

export interface CheckRunResult {
  status: CheckStatus;
  report: CheckReport;
  /** The full (redacted, capped) log on the lander machine. */
  logFile: string | null;
}

export interface ChecksPort {
  run(req: CheckRunRequest): Promise<CheckRunResult>;
  /** Startup recovery: kill the process groups a previous lander process left running (state.json). */
  killOrphans(): Promise<number[]>;
}

// ------------------------------------------------------------------ resolver (stage 3 of the merge ladder; completed in L5)

export interface ResolveRequest {
  landing: Landing;
  /** The conflicts structural merging left (design §2.2.6 step 3). */
  conflicts: ConflictEntry[];
  /** The merged tree so far (stages 1 and 2); resolved blobs are spliced into it. */
  tree: string;
  base: string;
  trunk: string;
  head: string;
  config: ResolverConfig;
  protectedRules: ProtectedRule[];
  /** Approved ai_resolution requirements of this landing: byte-identical stages reuse their result blobs. */
  approved: ApprovalRequirement[];
}

export interface ResolveResult {
  /** `tree` with every accepted resolution spliced in. */
  tree: string;
  resolved: string[];
  unresolved: Array<{ path: string; eligible: boolean; explanation: string | null }>;
  report: ResolverReport;
  /** With resolver.requireApproval: the ai_resolution requirement over the resolved files. */
  requirement: ApprovalRequirement | null;
}

/** null in the pipeline means the AI stage is skipped (resolver off, no key, no command). */
export interface ResolverPort {
  resolve(req: ResolveRequest): Promise<ResolveResult>;
}

// ------------------------------------------------------------------ clock and faults

export interface Clock {
  /** Wall-clock milliseconds since the Unix epoch. */
  now(): number;
  /** Monotonic milliseconds (self-fencing compares both, §1.5). */
  monotonic(): number;
  /** Resolves after `ms`, or early (without rejecting) when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    }),
};

/** The fault points of design §5.4 / §6.3.6, in pipeline order. */
export const FAULT_POINTS = [
  'after-admit',
  'after-next',
  'during-merge',
  'during-checks',
  'after-checks',
  'after-candidate-staged',
  'after-pushing-ack',
  'after-trunk-push',
  'before-landed-ack',
  'after-landed-ack',
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

/** Crash injection for tests (AGENTHUB_LANDER_FAULTS, NODE_ENV=test only; faults.ts). */
export interface Faults {
  at(point: FaultPoint, landingId?: string): void | Promise<void>;
}

export const noFaults: Faults = { at: () => {} };
