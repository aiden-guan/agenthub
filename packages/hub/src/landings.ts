import { FULL_SHA_RE, LANDER_LEASE_KEY, RESERVED_PREFIX, humanOf } from '@agenthub/contract';
import { HubError, assertNotReserved, capText, cleanText, entryName, idOf, normalizeRepoPath, unique, type HubInternals } from './common.js';
import { holdsToLeases, moveHolds, planHolds, releaseHolds, setHolds, type HoldOwner } from './holds.js';
import { normalizeLandingScope, type AdmitInput, type AdvanceInput, type ResolveInput } from './landing-requests.js';
import { phase1Landing } from './landing-row.js';
import { recordLandedChanges, type ChangeInput } from './symbol-changes.js';
import type {
  ApprovalKind,
  ApprovalRequirement,
  ApprovalRule,
  Claim,
  ClaimConflict,
  LandRequest,
  LandResult,
  LanderInfo,
  Landing,
  LandingApproval,
  LandingFailureCode,
  LandingPhase,
  LandingReport,
  LandingStats,
  LandingStatus,
  RequeueReason,
  ResolvedBy,
  ScopeEntry,
  Task,
} from './protocol.js';
import type { LandingPatch, Store } from './store.js';

// The landing queue (design §1.4, §2.1): the agent's queue-mode land (T1,
// T15), queue positions and ETAs, the effects of a landing that lands or comes
// back, and the lander protocol (T2-T14): admission, next, the fenced advance
// and resolve, approvals and cancel. Every function that changes anything runs
// inside Hub.write; the lander's lease is checked before (lander-control.ts).

/** Landings that still hold their change: they may yet reach trunk. */
export const LIVE_LANDING_STATUSES: readonly LandingStatus[] = ['submitted', 'queued', 'needs_approval', 'running'];

const MAX_LAND_FILES = 20_000;
const MAX_SUMMARY = 4000;
const MAX_MAPPER = 200;
/** A send-back this recent starts a retry chain when the agent lands the task again. */
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** ETAs come from the median of this many recent attempts, or this default without any. */
const ETA_SAMPLE = 20;
const DEFAULT_ATTEMPT_MS = 5 * 60_000;
/** At most this many paths or claims are named in a note or message. */
const MAX_NAMED = 3;

/** A queue-mode LandRequest, validated. */
export interface QueueRequest {
  task_id: string | undefined;
  branch: string | null;
  commit: string;
  summary: string;
  /** Changed paths (advisory), the scope's files included. */
  files: string[];
  /** The advisory scope as sent, deduplicated: [] when none. */
  scope: ScopeEntry[];
  mapper: string | null;
  release_claims: boolean;
  /** What the adapter's preview found protected (advisory: the lander decides). */
  protected: string[];
}

/** Validates a queue-mode land before any write: 400 bad_commit, bad_request, invalid_path or invalid_symbol. */
export function parseQueueRequest(req: LandRequest): QueueRequest {
  if (typeof req.commit !== 'string' || !FULL_SHA_RE.test(req.commit)) {
    throw new HubError('bad_commit', 'queue mode needs `commit`: the full lowercase sha (40 or 64 hex digits) of the commit you pushed to refs/agenthub/land/<sha>');
  }
  const listOf = (value: unknown, name: string): unknown[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new HubError('bad_request', `${name} must be a list`);
    if (value.length > MAX_LAND_FILES) throw new HubError('bad_request', `a landing names at most ${MAX_LAND_FILES} files`);
    return value;
  };
  let mapper: string | null = null;
  if (req.mapper !== undefined && req.mapper !== null) {
    if (typeof req.mapper !== 'string') throw new HubError('bad_request', 'mapper must be a string');
    mapper = cleanText(req.mapper, MAX_MAPPER) || null;
  }
  const files = unique(listOf(req.files, 'files').map((f) => assertNotReserved(normalizeRepoPath(f))));
  const scope = normalizeLandingScope(listOf(req.scope, 'scope'), mapper);
  const all = unique([...files, ...scope.map((e) => e.file)]);
  if (all.length > MAX_LAND_FILES) throw new HubError('bad_request', `a landing names at most ${MAX_LAND_FILES} files`);
  let protectedPaths: string[] = [];
  if (req.preview !== undefined && req.preview !== null) {
    if (typeof req.preview !== 'object' || Array.isArray(req.preview)) throw new HubError('bad_request', 'preview must be an object');
    protectedPaths = unique(listOf(req.preview.protected, 'preview.protected').map(normalizeRepoPath));
  }
  return {
    task_id: idOf(req.task_id, 'task_id'),
    branch: cleanText(req.branch, 200) || null,
    commit: req.commit,
    summary: cleanText(req.summary, MAX_SUMMARY, true),
    files: all,
    scope,
    mapper,
    release_claims: req.release_claims !== false,
    protected: protectedPaths,
  };
}

/**
 * T1 (design §1.4, §2.1): queue `req.commit` for the lander, in one durable
 * write. A live landing of the same (agent, commit) comes back as it is
 * (`replayed`). Otherwise, after the Phase 1 task rules: a live landing of the
 * same task (or, without one, the same branch) is superseded, its holds and
 * queue place going to the new one, unless it is being pushed (409 too_late);
 * a send-back of the task in the last day makes this a retry that keeps its
 * place for `keep_place_retries` retries. The holds cover the advisory scope
 * plus the claims the Phase 1 land rule selects (which end, "moved to landing
 * L-n"), gated by `claim_gate`: fail refuses with 409 claim_conflict and
 * changes nothing; warn leaves the conflicting entries out. The task goes to
 * `landing`, and the landing starts `submitted`.
 */
export function queueLanding(ix: HubInternals, project: string, agent: string, req: QueueRequest, now: number): LandResult {
  const { store } = ix;
  ix.touch(project, agent, now);

  const replay = store.listLandings(project, { agent, commit: req.commit, statuses: [...LIVE_LANDING_STATUSES], order: 'recent', limit: 1 })[0];
  if (replay) return replayed(ix, project, withoutSeq(replay), now);

  let task: Omit<Task, 'blocked_by'> | null = null;
  if (req.task_id) {
    const t = store.getTask(project, req.task_id);
    if (!t) throw new HubError('not_found', `no task ${req.task_id}`, 404);
    if (t.status === 'landing' && t.owner !== agent) throw taskLandingError(store, project, t);
    if (t.owner && t.owner !== agent) throw new HubError('forbidden', `${t.id} is owned by ${t.owner}`, 403);
    if (t.status === 'done' || t.status === 'cancelled') throw new HubError('task_closed', `${t.id} is already ${t.status}`, 409);
    ix.assertUnblocked(project, t, 'landed');
    task = t;
  }

  // The predecessor: the agent's live landing of the same task, or of the same
  // branch when there is no task (a landing with neither has none).
  const predecessors = task
    ? store.listLandings(project, { agent, task_id: task.id, statuses: [...LIVE_LANDING_STATUSES], order: 'queue' })
    : req.branch
      ? store.listLandings(project, { agent, branch: req.branch, task_id: null, statuses: [...LIVE_LANDING_STATUSES], order: 'queue' })
      : [];
  const pushing = predecessors.find((l) => l.status === 'running' && l.phase === 'pushing');
  if (pushing) {
    throw new HubError(
      'too_late',
      `${pushing.id} is being pushed to trunk right now, so it can't be replaced. Wait a few seconds (hub_wait {"landing_id": "${pushing.id}"}) and land on top of it.`,
      409,
    );
  }

  const policy = store.getLanderControl(project).policy;
  const id = `L-${store.nextCounter(project, 'landing')}`;
  const owner: HoldOwner = { id, agent, task_id: task?.id ?? null, summary: req.summary, files: req.files };

  // The claims the Phase 1 land rule selects: those tied to the task, and those
  // tied to none once no other task of the agent's is in progress (all of them
  // without a task). Holds never count: they belong to their landings. Nor
  // does a claim under RESERVED_PREFIX (the lander lease): moved into a
  // landing hold it would never expire (HOLD_EXPIRES), and a standby lander
  // would wait behind that hold until the landing ended.
  const otherTasks = store.listTasks(project).filter((t) => t.owner === agent && t.status === 'in_progress' && t.id !== task?.id);
  const selected = req.release_claims
    ? store
        .listClaims(project, { statuses: ['active', 'queued'], holder: agent, landing_id: null })
        .filter((c) => !c.scope.some((e) => e.file.startsWith(RESERVED_PREFIX)))
        .filter((c) => !task || c.task_id === task.id || (c.task_id === null && otherTasks.length === 0))
    : [];
  // A queued claim held nothing: only the active ones are continued by the hold.
  const continued = selected.filter((c) => c.status === 'active');
  const inherited = predecessors.flatMap((l) => store.listClaims(project, { statuses: ['active'], landing_id: l.id }));
  const entries = [
    ...req.scope,
    ...req.files.filter((f) => !req.scope.some((e) => e.file === f)).map((file) => ({ file })),
    ...[...continued, ...inherited].flatMap((c) => entriesFor(c, req.mapper)),
  ];

  // An entry keeps the mode of the claim or hold it continues (§1.6 step 3).
  const own = [...continued, ...inherited];
  // The gate first, so a refusal changes nothing.
  const plan = planHolds(ix, project, agent, entries, req.mapper, own);
  if (policy.claim_gate === 'fail' && plan.conflicts.length > 0) {
    throw new HubError('claim_conflict', claimConflictMessage(store, project, plan.conflicts, now), 409, { conflicts: plan.conflicts });
  }

  // Queue place and retry chain.
  const predecessor = predecessors[0] ?? null;
  let queueSeq: number | null = null;
  let retryOf: string | null = null;
  let retry = 0;
  if (predecessor) {
    queueSeq = predecessor.queue_seq;
    retryOf = predecessor.retry_of;
    retry = predecessor.retry;
  } else if (task) {
    const failed = store.listLandings(project, { agent, task_id: task.id, statuses: ['failed'], order: 'recent', limit: 1 })[0];
    if (failed && (failed.ended_at ?? failed.updated_at) >= now - RETRY_WINDOW_MS) {
      retryOf = failed.id;
      retry = failed.retry + 1;
      if (retry <= policy.keep_place_retries) queueSeq = failed.queue_seq;
    }
  }
  queueSeq ??= store.nextCounter(project, 'landing-queue');

  // T15: the predecessors step aside for this landing.
  for (const p of predecessors) {
    store.updateLanding(project, p.id, { status: 'superseded', superseded_by: id, deadline_at: null, updated_at: now, ended_at: now });
    ix.emit(project, 'landing.updated', agent, {
      landing_id: p.id,
      agent: p.agent,
      task_id: p.task_id,
      status: 'superseded',
      phase: p.phase,
      attempt: p.attempt,
      reason: 'superseded',
      position: null,
    });
    moveHolds(ix, project, p, owner);
  }

  const released = selected.map((c) => ix.endClaim(project, c, 'released', `moved to landing ${id}`, now));
  const holds = setHolds(ix, project, owner, entries, req.mapper, policy.claim_gate, now, { own });

  let taskOut: Task | null = null;
  if (task) {
    if (task.status !== 'landing' || task.owner !== agent) {
      store.updateTask(project, task.id, { status: 'landing', owner: agent, updated_at: now });
      ix.emit(project, 'task.updated', agent, { task_id: task.id, status: 'landing', previous: task.status });
    }
    taskOut = ix.withBlocked(project, { ...task, status: 'landing', owner: agent, updated_at: now });
  }

  const landing: Landing = {
    ...phase1Landing({ id, project, agent, task_id: owner.task_id, branch: req.branch, commit: req.commit, summary: req.summary, status: 'submitted', created_at: now }),
    queue_seq: queueSeq,
    files: req.files,
    scope: req.scope.length > 0 ? req.scope : null,
    mapper: req.mapper,
    hold_ids: holds.holds.map((h) => h.id),
    retry_of: retryOf,
    retry,
    supersedes: predecessor?.id ?? null,
  };
  store.insertLanding(landing);
  const view = queueView(store, project, now);
  const shown = withEstimates(view, landing);
  ix.emit(project, 'landing.created', agent, {
    landing_id: id,
    agent,
    task_id: landing.task_id,
    commit: landing.commit,
    position: shown.position,
    supersedes: landing.supersedes,
    retry_of: retryOf,
  });
  if (released.length > 0 || holds.trimmed) ix.promoteQueued(project, now);

  const superseded = predecessors.map((l) => l.id);
  return {
    landing: shown,
    task: taskOut,
    released,
    unblocked: [],
    held: holds.holds,
    superseded,
    replayed: false,
    position: shown.position,
    eta_ms: shown.eta_ms,
    lander: view.lander,
    note: queueNote({ landing: shown, task, superseded, holds: holds.holds, dropped: holds.conflicts, protectedPaths: req.protected, keep: policy.keep_place_retries, view }),
    now,
    seq: store.latestSeq(project),
  };
}

/** The answer to a land of a commit that a live landing of the agent's already carries. */
function replayed(ix: HubInternals, project: string, landing: Landing, now: number): LandResult {
  const { store } = ix;
  const view = queueView(store, project, now);
  const shown = withEstimates(view, landing);
  const task = landing.task_id ? store.getTask(project, landing.task_id) : null;
  const where = shown.position !== null ? `${landing.status}, position ${shown.position}` : landing.status === 'running' ? `running: ${landing.phase ?? 'starting'}` : landing.status;
  return {
    landing: shown,
    task: task ? ix.withBlocked(project, task) : null,
    released: [],
    unblocked: [],
    held: store.listClaims(project, { statuses: ['active'], landing_id: landing.id }),
    superseded: [],
    replayed: true,
    position: shown.position,
    eta_ms: shown.eta_ms,
    lander: view.lander,
    note: `${landing.id} already has this commit (${where}); nothing new was queued. hub_wait {"landing_id": "${landing.id}"} waits for the result.`,
    now,
    seq: store.latestSeq(project),
  };
}

/** A claim's entries as a hold with `mapper` keeps them: symbols only from the same mapper, otherwise the whole file. */
function entriesFor(c: Claim, mapper: string | null): ScopeEntry[] {
  return mapper !== null && c.mapper === mapper ? c.scope : c.scope.map((e) => ({ file: e.file }));
}

/** 409 task_landing: a live landing carries the task, so nobody can take, update or land it until that is over. */
export function taskLandingError(store: Store, project: string, task: Pick<Task, 'id' | 'owner'>): HubError {
  const carrier = store.listLandings(project, { task_id: task.id, statuses: [...LIVE_LANDING_STATUSES], order: 'queue', limit: 1 })[0];
  const by = carrier ? `${carrier.id} by ${carrier.agent}` : `a landing by ${task.owner ?? 'someone'}`;
  return new HubError(
    'task_landing',
    `${task.id} is being landed (${by}): it is done when that lands and in progress again if it comes back${carrier ? `; its author can cancel ${carrier.id} to get it back now` : ''}`,
    409,
  );
}

// ------------------------------------------------------- position and ETA

/** The live queue at one moment, for positions and ETAs. */
export interface QueueView {
  now: number;
  /** The one running landing, if any. */
  running: Landing | null;
  /** Submitted and queued landings in queue order. */
  waiting: Landing[];
  lander: LanderInfo | null;
  /** Median duration of recent attempts. */
  attemptMs: number;
}

export function queueView(store: Store, project: string, now: number): QueueView {
  const live = store.listLandings(project, { statuses: ['submitted', 'queued', 'running'], order: 'queue' });
  return {
    now,
    running: live.find((l) => l.status === 'running') ?? null,
    waiting: live.filter((l) => l.status !== 'running'),
    lander: landerInfo(store, project),
    attemptMs: medianAttemptMs(store, project),
  };
}

/** 1 = next: the submitted and queued landings ahead in queue order, plus a running one. Null unless submitted or queued. */
export function positionOf(view: QueueView, landing: Pick<Landing, 'id' | 'status'>): number | null {
  if (landing.status !== 'submitted' && landing.status !== 'queued') return null;
  const i = view.waiting.findIndex((l) => l.id === landing.id);
  if (i < 0) return null;
  return i + 1 + (view.running ? 1 : 0);
}

/** Milliseconds until it is on trunk, from the median attempt; null without a lander, and while it waits for a human. */
export function etaOf(view: QueueView, landing: Pick<Landing, 'id' | 'status' | 'started_at'>): number | null {
  if (!view.lander) return null;
  const left = (l: Pick<Landing, 'started_at'>) => Math.max(0, view.attemptMs - (view.now - (l.started_at ?? view.now)));
  if (landing.status === 'running') return left(landing);
  const i = landing.status === 'submitted' || landing.status === 'queued' ? view.waiting.findIndex((l) => l.id === landing.id) : -1;
  if (i < 0) return null;
  return (view.running ? left(view.running) : 0) + (i + 1) * view.attemptMs;
}

export function withEstimates(view: QueueView, landing: Landing): Landing {
  return { ...landing, position: positionOf(view, landing), eta_ms: etaOf(view, landing) };
}

/** The active lander lease, and the landers standing by on it. */
export function landerInfo(store: Store, project: string): LanderInfo | null {
  const lease = store.claimsForFiles(project, [LANDER_LEASE_KEY], ['active'])[0];
  if (!lease) return null;
  const standby = unique(store.claimsForFiles(project, [LANDER_LEASE_KEY], ['queued']).map((c) => c.holder));
  return { holder: lease.holder, claim_id: lease.id, expires_at: lease.expires_at, standby };
}

/** Median duration of the last ETA_SAMPLE finished attempts (DEFAULT_ATTEMPT_MS without any). */
export function medianAttemptMs(store: Store, project: string): number {
  const durations = store
    .listLandings(project, { statuses: ['landed', 'failed'], order: 'recent', limit: ETA_SAMPLE * 5 })
    .filter((l) => !l.reconciled && l.started_at !== null && l.ended_at !== null && l.ended_at >= l.started_at)
    .slice(0, ETA_SAMPLE)
    .map((l) => l.ended_at! - l.started_at!)
    .sort((a, b) => a - b);
  if (durations.length === 0) return DEFAULT_ATTEMPT_MS;
  const mid = durations.length >> 1;
  return durations.length % 2 === 1 ? durations[mid] : Math.round((durations[mid - 1] + durations[mid]) / 2);
}

// --------------------------------------------------- landed and failed

/**
 * What landing does to the hub's claims and tasks (design §1.4 landed
 * effects; the lander protocol adds the rest): the holds are released and the
 * waiters behind them promoted, and the task is done, unless another live
 * landing carries it, with its dependents announced.
 */
export function landedEffects(ix: HubInternals, project: string, landing: Landing, now: number, actor: string): { released: Claim[]; promoted: Claim[]; unblocked: string[] } {
  const released = releaseHolds(ix, project, landing.id, `landed ${landing.id}`, now);
  const promoted = released.length > 0 ? ix.promoteQueued(project, now) : [];
  let unblocked: string[] = [];
  const task = carriedTask(ix.store, project, landing);
  if (task) {
    ix.store.updateTask(project, task.id, { status: 'done', updated_at: now });
    ix.emit(project, 'task.updated', actor, { task_id: task.id, status: 'done', previous: 'landing' });
    unblocked = ix.announceUnblocked(project, task.id, actor);
  }
  return { released, promoted, unblocked };
}

/**
 * What a landing that comes back (failed or cancelled) does: its holds turn
 * back into the agent's leases for at least `sendback_grace_min`, and its task
 * is in progress again with the same owner, unless another live landing
 * carries it.
 */
export function failureEffects(ix: HubInternals, project: string, landing: Landing, now: number, actor: string | null = null): { released: Claim[] } {
  const grace = ix.store.getLanderControl(project).policy.sendback_grace_min;
  const released = holdsToLeases(ix, project, landing.id, now, grace);
  // Its files are the agent's leases again: a claim it queued meanwhile for something held by one of their waiters would now deadlock.
  if (released.length > 0) {
    ix.breakWaitCycles(project, landing.agent, now, `deadlock: ${landing.id} came back, so you hold its files again, and this claim waited for someone who waits for them. Ask again once you can let them go`);
  }
  const task = carriedTask(ix.store, project, landing);
  if (task) {
    ix.store.updateTask(project, task.id, { status: 'in_progress', updated_at: now });
    ix.emit(project, 'task.updated', actor, { task_id: task.id, status: 'in_progress', previous: 'landing' });
  }
  return { released };
}

/** The landing's task while it is `landing` and no other live landing carries it. */
function carriedTask(store: Store, project: string, landing: Landing): Omit<Task, 'blocked_by'> | null {
  if (!landing.task_id) return null;
  const task = store.getTask(project, landing.task_id);
  if (!task || task.status !== 'landing') return null;
  const others = store.listLandings(project, { task_id: task.id, statuses: [...LIVE_LANDING_STATUSES], order: 'queue' }).filter((l) => l.id !== landing.id);
  return others.length === 0 ? task : null;
}

// ------------------------------------------------------------- texts

/** The 409 claim_conflict message: entries and holders only (intents are in details, as the holders' words). */
function claimConflictMessage(store: Store, project: string, conflicts: ClaimConflict[], now: number): string {
  const view = queueView(store, project, now);
  const items = conflicts.map((c) => `${andList(capped(c.scope.map(entryName), MAX_NAMED))} ${c.scope.length > 1 ? 'are' : 'is'} ${heldBy(c, view)}`);
  return `Your change touches code other agents hold: ${items.join('; ')}. Nothing was queued: coordinate with them (hub_post), wait for them (hub_wait with those files), or land without those files.`;
}

function heldBy(c: ClaimConflict, view: QueueView): string {
  if (!c.landing_id) return `claimed by ${c.holder} (${c.claim_id})`;
  const waiting = view.waiting.find((l) => l.id === c.landing_id);
  const position = waiting ? positionOf(view, waiting) : null;
  return `being landed by ${c.landing_id} (${c.holder}${position !== null ? `, position ${position}` : ''})`;
}

/** What happens next, for the agent that landed. Ids, paths and agent ids only: no agent-written text. */
function queueNote(o: {
  landing: Landing;
  task: Pick<Task, 'id'> | null;
  superseded: string[];
  holds: Claim[];
  dropped: ClaimConflict[];
  protectedPaths: string[];
  keep: number;
  view: QueueView;
}): string {
  const { landing } = o;
  const at = landing.position !== null ? ` at position ${landing.position}` : '';
  const parts = [
    o.view.lander
      ? `Submitted ${landing.id}${at}${landing.eta_ms !== null ? `, about ${minutes(landing.eta_ms)} to trunk` : ''}: the lander admits it, merges it onto the latest trunk, runs the checks and lands it, or sends it back with what to fix.`
      : `Submitted ${landing.id}${at}, but no lander is running for this project, so nothing lands until a human starts \`hub-lander run\` (tell your human).`,
  ];
  if (o.superseded.length > 0) {
    parts.push(`It replaces ${andList(o.superseded)}, your earlier landing of ${o.task ? o.task.id : `branch ${landing.branch}`}, and keeps its place in the queue.`);
  } else if (landing.retry_of) {
    parts.push(
      landing.retry <= o.keep
        ? `It is retry ${landing.retry} of ${o.keep} after ${landing.retry_of} came back, so it keeps that landing's place in the queue.`
        : `It is retry ${landing.retry} after ${landing.retry_of} came back; past ${o.keep} retries a landing goes to the back of the queue.`,
    );
  }
  if (o.holds.length > 0) {
    const files = unique(o.holds.flatMap((h) => h.scope.map((e) => e.file)));
    parts.push(
      `Your claims on ${files.length} file${files.length === 1 ? '' : 's'} are held by ${andList(o.holds.map((h) => h.id))} until it lands; if it comes back they are yours again.`,
    );
  } else {
    parts.push('It holds no files: none were named and you held no claims.');
  }
  if (o.dropped.length > 0) {
    const named = o.dropped.map(
      (c) => `${andList(capped(c.scope.map(entryName), MAX_NAMED))} (${c.landing_id ? `being landed by ${c.holder} in ${c.landing_id}` : `claimed by ${c.holder}, ${c.claim_id}`})`,
    );
    parts.push(`Other agents hold code your change touches, so these are not held: ${named.join('; ')}. Coordinate with them (hub_post).`);
  }
  if (o.protectedPaths.length > 0) {
    parts.push(`It changes protected paths (${andList(capped(o.protectedPaths, MAX_NAMED))}): it lands only once a human approves it.`);
  }
  parts.push(`Don't amend or rebase these commits; to fix something, commit on top and land again. hub_wait {"landing_id": "${landing.id}"} waits for the result.`);
  return parts.join(' ');
}

function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

function capped(items: string[], max: number): string[] {
  return items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : items;
}

function andList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A stored landing as the hub answers it: without the row's undeclared seq (status().landings keeps it, as Phase 1 did). */
export function withoutSeq(landing: Landing): Landing {
  const { seq: _seq, ...rest } = landing as Landing & { seq?: number };
  return rest;
}

// =============================================================== lander protocol (H3)

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A picked landing must report progress within this (design §1.4 T4). */
const PICK_DEADLINE_MS = 10 * MINUTE_MS;
/** Step deadlines the lander asks for are clamped to this range (T5). */
const MIN_STEP_MS = MINUTE_MS;
const MAX_STEP_MS = 6 * HOUR_MS;
const PHASE_ORDER: Record<LandingPhase, number> = { merging: 0, resolving: 1, checking: 2, pushing: 3 };
/** Requeues that count against a limit, and what the landing fails with past it (T9). */
const RETRY_LIMITS: Partial<Record<RequeueReason, { key: keyof Landing['retries']; max: number; code: LandingFailureCode; why: string }>> = {
  trunk_moved: { key: 'trunk_moved', max: 3, code: 'trunk_busy', why: 'trunk was pushed outside the landing queue more than 3 times while it was landing' },
  lander_lost: { key: 'lander_lost', max: 3, code: 'lander_lost', why: 'the lander running it stopped more than 3 times' },
  step_timeout: { key: 'step_timeout', max: 2, code: 'lander_stuck', why: 'a step of its landing outlived its deadline more than twice (the lander seems stuck)' },
};

/** What a lander or approver write did to a landing. */
export interface Transition {
  landing: Landing;
  /** Holds released (landed) or turned back into leases (failed, cancelled). */
  released: Claim[];
  unblocked: string[];
  /** The request was already applied; nothing changed now. */
  replayed: boolean;
}

export function isLive(landing: Pick<Landing, 'status'>): boolean {
  return LIVE_LANDING_STATUSES.includes(landing.status);
}

/** A stored landing, without the row's seq; 404 when there is none. */
export function mustGetLanding(store: Store, project: string, id: string): Landing {
  const landing = typeof id === 'string' ? store.getLanding(project, id) : null;
  if (!landing) throw new HubError('not_found', `no landing ${id}`, 404);
  return withoutSeq(landing);
}

/** A landing as the hub shows it: with its position and ETA. */
export function shownLanding(store: Store, project: string, landing: Landing, now: number): Landing {
  return withEstimates(queueView(store, project, now), landing);
}

/** Writes `patch` (and updated_at) and reads the landing back. */
export function updateLanding(ix: HubInternals, project: string, landing: Pick<Landing, 'id'>, patch: LandingPatch, now: number): Landing {
  ix.store.updateLanding(project, landing.id, { ...patch, updated_at: now });
  return mustGetLanding(ix.store, project, landing.id);
}

/** landing.updated: fixed reason codes and ids only, no agent text (design §1.8). */
export function emitUpdated(ix: HubInternals, project: string, landing: Landing, reason: string, actor: string | null, now: number): void {
  ix.emit(project, 'landing.updated', actor, {
    landing_id: landing.id,
    agent: landing.agent,
    task_id: landing.task_id,
    status: landing.status,
    phase: landing.phase,
    attempt: landing.attempt,
    reason,
    position: positionOf(queueView(ix.store, project, now), landing),
  });
}

function emitNeedsApproval(ix: HubInternals, project: string, landing: Landing, pending: ApprovalRequirement[], parked: boolean, actor: string): void {
  const rules = pending.flatMap((r) => r.rules);
  ix.emit(project, 'landing.needs_approval', actor, {
    landing_id: landing.id,
    agent: landing.agent,
    task_id: landing.task_id,
    kinds: unique(pending.map((r) => r.kind)),
    paths: unique(pending.flatMap((r) => r.paths)).sort().slice(0, 20),
    approvers: rules.some((r) => r.approvers === null) ? null : unique(rules.flatMap((r) => r.approvers ?? [])),
    parked,
  });
}

/**
 * T9 and T12: back to the queue in its place (queue_seq kept), lander and
 * lease cleared. trunk_moved, lander_lost and step_timeout count, and past
 * their limits the landing fails instead (trunk_busy, lander_lost,
 * lander_stuck); the other reasons don't count.
 */
export function requeueLanding(ix: HubInternals, project: string, landing: Landing, reason: RequeueReason, now: number, actor: string | null): Transition {
  const retries = { ...landing.retries };
  const limit = RETRY_LIMITS[reason];
  if (limit) {
    retries[limit.key] += 1;
    if (retries[limit.key] > limit.max) {
      return failLanding(ix, project, landing, limit.code, `${landing.id} came back: ${limit.why}. Nothing of it reached trunk, and it is not caused by your change: land again once this is sorted out.`, null, now, actor, { retries });
    }
  }
  const queued = updateLanding(ix, project, landing, { status: 'queued', phase: null, lander: null, lease_claim_id: null, deadline_at: null, in_doubt: false, retries }, now);
  emitUpdated(ix, project, queued, `requeued:${reason}`, actor, now);
  return { landing: queued, released: [], unblocked: [], replayed: false };
}

/** T3, T8, T13 and the retry limits: failed, with the failure effects and landing.failed. */
export function failLanding(
  ix: HubInternals,
  project: string,
  landing: Landing,
  code: LandingFailureCode,
  summary: string,
  report: LandingReport | null,
  now: number,
  actor: string | null,
  extra: LandingPatch = {},
): Transition {
  const failed = updateLanding(
    ix,
    project,
    landing,
    { status: 'failed', failure: { code, summary: capText(summary, 1000) }, ...(report ? { report } : {}), phase: null, deadline_at: null, in_doubt: false, ended_at: now, ...extra },
    now,
  );
  const { released } = failureEffects(ix, project, failed, now, actor);
  ix.emit(project, 'landing.failed', actor, { landing_id: failed.id, agent: failed.agent, task_id: failed.task_id, code, files: failed.files.slice(0, 50) });
  return { landing: failed, released, unblocked: [], replayed: false };
}

/**
 * T11 and T16: landed. The landed effects (holds released, waiters promoted,
 * the task done, its dependents announced), also_landed annotated, and,
 * unless reconciled from a trunk report (which says where trunk is itself),
 * control.trunk and trunk.moved. Phase 3: with the lander's `symbol_changes`
 * (advance and resolve landed; a trunk report has none), the landed rows are
 * recorded and supersede the author's in-progress rows for the task (§2.5).
 */
export function completeLanding(
  ix: HubInternals,
  project: string,
  landing: Landing,
  o: {
    trunk_sha: string;
    base_sha?: string | null;
    files?: string[] | null;
    report?: LandingReport | null;
    also_landed?: string[];
    symbol_changes?: readonly ChangeInput[];
    reconciled: boolean;
  },
  now: number,
  actor: string,
): Transition {
  const { store } = ix;
  const known = store.getLanderControl(project).trunk;
  const from = landing.trunk_base ?? known?.sha ?? null;
  // The hub's trunk moves from where this landing merged onto (or a trunk it
  // doesn't know yet) to the landing; a landing found on trunk at an older
  // commit never moves it back.
  const advancesTrunk = known === null || known.sha === from || known.sha === o.trunk_sha;
  const patch: LandingPatch = { status: 'landed', trunk_sha: o.trunk_sha, phase: null, deadline_at: null, in_doubt: false, ended_at: now, reconciled: o.reconciled };
  if (o.base_sha) patch.base_sha = o.base_sha;
  if (o.files) patch.files = o.files;
  if (o.report) patch.report = o.report;
  const done = updateLanding(ix, project, landing, patch, now);
  const effects = landedEffects(ix, project, done, now, actor);
  const also: string[] = [];
  for (const id of o.also_landed ?? []) {
    const other = store.getLanding(project, id);
    if (!other || other.id === done.id || other.agent !== done.agent || !['failed', 'superseded', 'cancelled'].includes(other.status)) continue;
    store.updateLanding(project, id, { landed_with: done.id, updated_at: now });
    also.push(id);
  }
  if (!o.reconciled && advancesTrunk) store.putLanderControl(project, { trunk: { sha: o.trunk_sha, landing_id: done.id, at: now } }, now);
  ix.emit(project, 'landing.landed', actor, {
    landing_id: done.id,
    agent: done.agent,
    task_id: done.task_id,
    trunk_sha: o.trunk_sha,
    files: done.files.slice(0, 200),
    resolved_by: done.report?.resolved_by ?? null,
    also_landed: also,
    reconciled: o.reconciled,
  });
  if (!o.reconciled && from !== o.trunk_sha) {
    ix.emit(project, 'trunk.moved', actor, { from, to: o.trunk_sha, landing_id: done.id, files: done.files.slice(0, 200), foreign: false });
  }
  if (o.symbol_changes) recordLandedChanges(ix, project, done, o.symbol_changes, now, actor);
  return { landing: done, released: effects.released, unblocked: effects.unblocked, replayed: false };
}

/**
 * T4: the landing to work on. A running landing comes first: in doubt (in
 * pushing when the lease that ran it ended), or this lease's own, also while
 * paused, with `resolve` when it is in pushing. Otherwise, unless paused, the
 * lowest queue_seq queued landing whose waits_for is terminal starts: running,
 * merging, attempt + 1, under this lease, with a 10 minute deadline.
 */
export function nextLanding(ix: HubInternals, project: string, agent: string, lease: Claim, now: number): { landing: Landing | null; resolve: boolean } {
  const { store } = ix;
  const running = store.listLandings(project, { statuses: ['running'], order: 'queue', limit: 1 })[0];
  if (running) {
    const landing = withoutSeq(running);
    // Another lease's running landing that isn't in doubt: that lease is live, so it isn't ours to touch.
    if (landing.in_doubt || landing.lease_claim_id === lease.id) return { landing, resolve: landing.phase === 'pushing' };
    return { landing: null, resolve: false };
  }
  if (store.getLanderControl(project).paused) return { landing: null, resolve: false };
  for (const queued of store.listLandings(project, { statuses: ['queued'], order: 'queue' })) {
    if (queued.waits_for !== null) {
      const first = store.getLanding(project, queued.waits_for);
      if (first && isLive(first)) continue;
    }
    const picked = updateLanding(
      ix,
      project,
      queued,
      { status: 'running', phase: 'merging', phase_at: now, attempt: queued.attempt + 1, lander: agent, lease_claim_id: lease.id, in_doubt: false, started_at: now, deadline_at: now + PICK_DEADLINE_MS },
      now,
    );
    emitUpdated(ix, project, picked, 'picked', agent, now);
    return { landing: picked, resolve: false };
  }
  return { landing: null, resolve: false };
}

/**
 * T2 and T3: the lander's authoritative view of a submitted landing. The
 * holds are re-made from its exact scope through the gate (claim_gate fail:
 * the landing fails with claim_conflict; warn: the conflicting entries are
 * left out), entries the change doesn't touch are released, approvals the
 * landing's chain already granted for the same content carry over, and what
 * is still needed is asked for at once. A landing that is no longer submitted
 * makes this a replay; a terminal one is 409 landing_closed.
 */
export function admitLanding(ix: HubInternals, project: string, agent: string, id: string, req: AdmitInput, now: number): { landing: Landing; conflicts: ClaimConflict[] } {
  const { store } = ix;
  const landing = mustGetLanding(store, project, id);
  if (landing.status !== 'submitted') {
    if (!isLive(landing)) throw closedError(landing);
    return { landing, conflicts: [] };
  }
  if (req.waits_for !== null && (req.waits_for === id || !store.getLanding(project, req.waits_for))) {
    throw new HubError('bad_request', `waits_for names no other landing of this project: ${req.waits_for}`);
  }
  const recorded: LandingPatch = {
    base_sha: req.base_sha ?? landing.base_sha,
    files: req.files,
    scope: req.scope,
    mapper: req.mapper,
    protected: req.protected,
    waits_for: req.waits_for,
  };
  if (req.failure) {
    const failed = failLanding(ix, project, landing, req.failure.code, summaryOf(req.failure.report, req.failure.code, id), req.failure.report, now, agent, recorded);
    return { landing: failed.landing, conflicts: [] };
  }

  const gate = store.getLanderControl(project).policy.claim_gate;
  const own = store.listClaims(project, { statuses: ['active'], landing_id: id });
  const scope = req.scope ?? [];
  const entries = [...scope, ...req.files.filter((f) => !scope.some((e) => e.file === f)).map((file) => ({ file }))];
  const holds = setHolds(ix, project, { ...landing, files: req.files }, entries, req.mapper, gate, now, { own });
  if (!holds.applied) {
    const failed = failLanding(ix, project, landing, 'claim_conflict', conflictSummary(landing.id, holds.conflicts), null, now, agent, recorded);
    return { landing: failed.landing, conflicts: holds.conflicts };
  }

  carryApprovals(store, project, landing, req.required);
  const approvals = mustGetLanding(store, project, id).approvals;
  const pending = req.required.filter((r) => !satisfied(r, approvals, landing.agent));
  const admitted = updateLanding(
    ix,
    project,
    landing,
    { ...recorded, status: 'queued', approval: pending, hold_ids: holds.holds.map((h) => h.id), ...(req.warnings.length > 0 ? { report: warningsReport(req.warnings) } : {}) },
    now,
  );
  emitUpdated(ix, project, admitted, 'admitted', agent, now);
  if (pending.length > 0) emitNeedsApproval(ix, project, admitted, pending, false, agent);
  if (holds.trimmed) ix.promoteQueued(project, now);
  return { landing: admitted, conflicts: holds.conflicts };
}

/**
 * T5, T6, T9, T11 and T13 for the lease's own attempt (`lease` checked by
 * assertLander), plus T3 for a submitted landing at attempt 0. A request the
 * row already reflects answers replayed: true; any other request for a landing
 * that isn't running this attempt under this lease is 409 landing_stale.
 */
export function advanceLanding(ix: HubInternals, project: string, agent: string, id: string, req: AdvanceInput, lease: Claim, now: number): Transition {
  const { store } = ix;
  const landing = mustGetLanding(store, project, id);
  if (landing.status === 'submitted' && req.to === 'failed' && req.attempt === 0 && landing.attempt === 0) {
    return failLanding(ix, project, landing, req.code, summaryOf(req.report, req.code, id), req.report, now, agent);
  }
  if (isReplay(landing, req, lease.id)) return { landing, released: [], unblocked: [], replayed: true };
  if (landing.status !== 'running' || landing.attempt !== req.attempt || landing.lease_claim_id !== lease.id) throw staleError(landing, req.attempt);
  const pushing = landing.phase === 'pushing';
  if (pushing && req.to !== 'landed') {
    throw new HubError('bad_request', `${id} is in pushing: it moves on only as landed (the push went through) or by resolve, once the remote has been inspected`);
  }
  switch (req.to) {
    case 'running':
      return req.phase === 'pushing' ? enterPushing(ix, project, landing, req, now, agent) : changePhase(ix, project, landing, req, now, agent);
    case 'queued':
      return requeueLanding(ix, project, landing, req.reason, now, agent);
    case 'needs_approval':
      return park(ix, project, landing, req, now, agent);
    case 'landed':
      if (pushing && req.trunk_sha !== landing.candidate) {
        throw new HubError('bad_request', `${id} was pushing candidate ${landing.candidate}: landed means trunk is that commit, not ${req.trunk_sha}`);
      }
      return completeLanding(
        ix,
        project,
        landing,
        { trunk_sha: req.trunk_sha, base_sha: req.base_sha, files: req.files, report: req.report, also_landed: req.also_landed, symbol_changes: req.symbol_changes, reconciled: false },
        now,
        agent,
      );
    case 'failed':
      return failLanding(ix, project, landing, req.code, summaryOf(req.report, req.code, id), req.report, now, agent);
  }
}

/** Whether the row already reflects `req` (design §1.5 replay): same attempt and lease, and the state asked for. */
function isReplay(l: Landing, req: AdvanceInput, leaseId: string): boolean {
  if (l.attempt !== req.attempt) return false;
  // A landing failed at admission (attempt 0) ran under no lease.
  const ours = l.lease_claim_id === leaseId || (req.attempt === 0 && l.lease_claim_id === null);
  switch (req.to) {
    case 'running':
      if (l.status !== 'running' || !ours) return false;
      if (req.phase === 'pushing') return l.phase === 'pushing' && l.candidate === req.candidate;
      return l.phase === req.phase && (req.trunk_base === null || req.trunk_base === l.trunk_base);
    case 'queued':
      // A requeue clears the lease; the attempt number still names it.
      return l.status === 'queued';
    case 'needs_approval':
      return l.status === 'needs_approval' && ours;
    case 'landed':
      return l.status === 'landed' && l.trunk_sha === req.trunk_sha && ours;
    case 'failed':
      return l.status === 'failed' && l.failure?.code === req.code && ours;
  }
}

/** T5 short of pushing: phases only go forward; trunk_base (and first_base once); a deadline of 1 min to 6 h. */
function changePhase(ix: HubInternals, project: string, landing: Landing, req: Extract<AdvanceInput, { to: 'running' }> & { deadline_ms: number }, now: number, agent: string): Transition {
  const current = landing.phase ?? 'merging';
  if (PHASE_ORDER[req.phase] < PHASE_ORDER[current]) {
    throw new HubError('bad_request', `${landing.id} is in ${current}: phases go merging, resolving, checking, pushing, never back`);
  }
  const patch: LandingPatch = { deadline_at: now + Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, Math.round(req.deadline_ms))) };
  const moves = req.phase !== landing.phase;
  if (moves) Object.assign(patch, { phase: req.phase, phase_at: now });
  if (req.trunk_base !== null) {
    patch.trunk_base = req.trunk_base;
    if (landing.first_base === null) patch.first_base = req.trunk_base;
  }
  const moved = updateLanding(ix, project, landing, patch, now);
  if (moves) emitUpdated(ix, project, moved, 'phase', agent, now);
  return { landing: moved, released: [], unblocked: [], replayed: false };
}

/**
 * T5 into pushing, the write-ahead: the request names the staged candidate,
 * and every requirement it lists, and every pending one the hub holds for this
 * candidate, has a granted approval (409 approval_missing with
 * details.missing). From here on the landing has no deadline.
 */
function enterPushing(ix: HubInternals, project: string, landing: Landing, req: Extract<AdvanceInput, { phase: 'pushing' }>, now: number, agent: string): Transition {
  const needed = new Map<string, ApprovalRequirement>();
  for (const r of [...req.required, ...landing.approval.filter((p) => p.candidate === null || p.candidate === req.candidate)]) {
    const key = `${r.kind}\u0000${r.digest}`;
    if (!needed.has(key)) needed.set(key, r);
  }
  const missing = [...needed.values()].filter((r) => !satisfied(r, landing.approvals, landing.agent));
  if (missing.length > 0) {
    throw new HubError(
      'approval_missing',
      `${landing.id} can't be pushed yet: ${missing.length === 1 ? 'an approval is' : `${missing.length} approvals are`} missing (${missing.map((r) => `${r.kind} ${r.paths.slice(0, 3).join(', ')}`).join('; ')}). Park it (needs_approval) until an approver grants ${missing.length === 1 ? 'it' : 'them'}.`,
      409,
      { missing },
    );
  }
  const moved = updateLanding(
    ix,
    project,
    landing,
    {
      phase: 'pushing',
      phase_at: now,
      candidate: req.candidate,
      candidate_ref: req.candidate_ref,
      candidate_checked: landing.candidate_checked && landing.candidate === req.candidate,
      trunk_base: req.trunk_base,
      first_base: landing.first_base ?? req.trunk_base,
      deadline_at: null,
    },
    now,
  );
  emitUpdated(ix, project, moved, 'phase', agent, now);
  return { landing: moved, released: [], unblocked: [], replayed: false };
}

/**
 * T6: the checks passed on the staged candidate but an approval is still
 * missing. The landing parks in needs_approval (the running slot is free, its
 * holds stay) until approved (back to the queue in its place) or rejected, or
 * approval_timeout_hours pass. If its approvals all came in while it ran, it
 * goes straight back to the queue instead.
 */
function park(ix: HubInternals, project: string, landing: Landing, req: Extract<AdvanceInput, { to: 'needs_approval' }>, now: number, agent: string): Transition {
  const check = req.report.check;
  if (!check || check.exit_code !== 0 || check.timed_out) {
    throw new HubError('bad_request', `${landing.id} parks for an approval only once its checks passed: report.check must be the passing run on the candidate`);
  }
  const fromRequirement = req.required.find((r) => r.candidate !== null && (req.candidate === null || r.candidate === req.candidate));
  const candidate = req.candidate ?? fromRequirement?.candidate ?? landing.candidate;
  const candidate_ref = req.candidate_ref ?? fromRequirement?.candidate_ref ?? (candidate === landing.candidate ? landing.candidate_ref : null);
  const pending = req.required.filter((r) => !satisfied(r, landing.approvals, landing.agent));
  const common: LandingPatch = { phase: null, candidate, candidate_ref, candidate_checked: candidate !== null, report: req.report };
  if (pending.length === 0) {
    const queued = updateLanding(ix, project, landing, { ...common, status: 'queued', approval: [], lander: null, lease_claim_id: null, deadline_at: null }, now);
    emitUpdated(ix, project, queued, 'approved', agent, now);
    return { landing: queued, released: [], unblocked: [], replayed: false };
  }
  const hours = ix.store.getLanderControl(project).policy.approval_timeout_hours;
  const parked = updateLanding(ix, project, landing, { ...common, status: 'needs_approval', approval: pending, deadline_at: now + hours * HOUR_MS }, now);
  emitNeedsApproval(ix, project, parked, pending, true, agent);
  return { landing: parked, released: [], unblocked: [], replayed: false };
}

/**
 * T11 and T12 for a landing in pushing that is in doubt (any lease holder) or
 * this lease's own, after the lander inspected the remote: landed applies the
 * landed effects; requeue (trunk moved past trunk_base without the candidate,
 * or the candidate is gone) keeps its place and counts trunk_moved.
 */
export function resolveLanding(ix: HubInternals, project: string, agent: string, id: string, req: ResolveInput, lease: Claim, now: number): Transition {
  const landing = mustGetLanding(ix.store, project, id);
  if (landing.status === 'running' && landing.phase === 'pushing' && (landing.in_doubt || landing.lease_claim_id === lease.id)) {
    if (req.outcome === 'landed') return completeLanding(ix, project, landing, { trunk_sha: req.trunk_sha, symbol_changes: req.symbol_changes, reconciled: false }, now, agent);
    return requeueLanding(ix, project, landing, 'trunk_moved', now, agent);
  }
  const already = req.outcome === 'landed' ? landing.status === 'landed' && landing.trunk_sha === req.trunk_sha : landing.status === 'queued';
  if (already) return { landing, released: [], unblocked: [], replayed: true };
  throw new HubError('landing_stale', `${id} is ${describe(landing)}: resolve is only for a landing in pushing that is in doubt or this lease's own`, 409);
}

/**
 * T7: `approver` grants the pending requirement with this kind and digest
 * (409 approval_stale if none). A rule allows the approver when it names
 * them (or anyone) and, if distinct, they aren't the author's human (403
 * not_approver otherwise, naming the rules). The approval is appended; once
 * nothing is pending, a parked landing goes back to the queue in its place.
 */
export function approveLanding(ix: HubInternals, project: string, id: string, req: { kind: ApprovalKind; digest: string; note: string }, approver: string, now: number): Landing {
  const { store } = ix;
  const landing = mustGetLanding(store, project, id);
  if (!isLive(landing)) throw closedError(landing);
  const matching = landing.approval.filter((r) => r.kind === req.kind && r.digest === req.digest);
  if (matching.length === 0) {
    throw new HubError(
      'approval_stale',
      `${id} waits for no ${req.kind} approval with that digest${landing.approval.length > 0 ? ': the content changed since it was computed, so look at it again (hub approve recomputes it)' : ''}`,
      409,
    );
  }
  const rules = matching.flatMap((r) => r.rules);
  if (!rules.some((rule) => allowedBy(rule, approver, landing.agent))) throw notApprover(approver, landing, rules);
  if (landing.approvals.some((a) => a.by === approver && a.kind === req.kind && a.digest === req.digest)) return landing;
  store.insertApproval({ project, landing_id: id, kind: req.kind, digest: req.digest, approver, decision: 'approve', note: req.note, carried_from: null, at: now });
  const approvals = mustGetLanding(store, project, id).approvals;
  const pending = landing.approval.filter((r) => !satisfied(r, approvals, landing.agent));
  const patch: LandingPatch = { approval: pending };
  if (pending.length === 0 && landing.status === 'needs_approval') Object.assign(patch, { status: 'queued', lander: null, lease_claim_id: null, deadline_at: null });
  const after = updateLanding(ix, project, landing, patch, now);
  emitUpdated(ix, project, after, 'approved', approver, now);
  return after;
}

/** T8: `approver`, allowed by a rule of a pending requirement, rejects the landing: approval_rejected, with the failure effects. */
export function rejectLanding(ix: HubInternals, project: string, id: string, req: { reason: string }, approver: string, now: number): Landing {
  const { store } = ix;
  const landing = mustGetLanding(store, project, id);
  if (!isLive(landing)) throw closedError(landing);
  if (landing.status === 'running' && landing.phase === 'pushing') throw tooLate(landing);
  if (landing.approval.length === 0) throw new HubError('approval_stale', `${id} waits for no approval, so there is nothing to reject; cancel it instead`, 409);
  const mine = landing.approval.filter((r) => r.rules.some((rule) => allowedBy(rule, approver, landing.agent)));
  if (mine.length === 0) throw notApprover(approver, landing, landing.approval.flatMap((r) => r.rules));
  for (const r of mine) {
    store.insertApproval({ project, landing_id: id, kind: r.kind, digest: r.digest, approver, decision: 'reject', note: req.reason, carried_from: null, at: now });
  }
  const summary = `${id} was rejected by ${approver}. Their reason, as written: "${capText(req.reason, 500)}"`;
  return failLanding(ix, project, landing, 'approval_rejected', summary, null, now, approver).landing;
}

/** T14: the author or an approver cancels a live landing, except in pushing (409 too_late); its holds go back to the author. */
export function cancelLanding(ix: HubInternals, project: string, id: string, agent: string | null, approver: string | null, now: number): Landing {
  const landing = mustGetLanding(ix.store, project, id);
  const actor = agent === landing.agent ? agent : approver;
  if (actor === null) throw new HubError('forbidden', `${id} is ${landing.agent}'s landing: only its author or an approver can cancel it`, 403);
  if (!isLive(landing)) throw closedError(landing);
  if (landing.status === 'running' && landing.phase === 'pushing') throw tooLate(landing);
  const cancelled = updateLanding(ix, project, landing, { status: 'cancelled', phase: null, deadline_at: null, in_doubt: false, ended_at: now }, now);
  failureEffects(ix, project, cancelled, now, actor);
  emitUpdated(ix, project, cancelled, 'cancelled', actor, now);
  return cancelled;
}

// ------------------------------------------------------------- approvals

/** A rule lets `approver` approve `agent`'s landing: it names them (or anyone), and, if distinct, they aren't the agent's human. */
export function allowedBy(rule: ApprovalRule, approver: string, agent: string): boolean {
  return (rule.approvers === null || rule.approvers.includes(approver)) && !(rule.distinct && approver === humanOf(agent));
}

/** Every rule of the requirement has an approval with its kind and digest from a human the rule allows. */
export function satisfied(r: ApprovalRequirement, approvals: readonly LandingApproval[], agent: string): boolean {
  return r.rules.every((rule) => approvals.some((a) => a.kind === r.kind && a.digest === r.digest && allowedBy(rule, a.by, agent)));
}

/**
 * Copies the approvals that the landing's chain (its retry_of and supersedes
 * predecessors, of the same agent) granted with a required kind and digest,
 * from approvers its rules allow, naming the landing each was first given on.
 */
function carryApprovals(store: Store, project: string, landing: Landing, required: readonly ApprovalRequirement[]): void {
  if (required.length === 0) return;
  const key = (approver: string, kind: string, digest: string) => `${approver}\u0000${kind}\u0000${digest}`;
  const have = new Set(store.listApprovals(project, landing.id).filter((a) => a.decision === 'approve').map((a) => key(a.approver, a.kind, a.digest)));
  for (const prior of chainOf(landing, (id) => store.getLanding(project, id))) {
    for (const row of store.listApprovals(project, prior.id)) {
      if (row.decision !== 'approve' || have.has(key(row.approver, row.kind, row.digest))) continue;
      const rules = required.filter((r) => r.kind === row.kind && r.digest === row.digest).flatMap((r) => r.rules);
      if (!rules.some((rule) => allowedBy(rule, row.approver, landing.agent))) continue;
      have.add(key(row.approver, row.kind, row.digest));
      store.insertApproval({ project, landing_id: landing.id, kind: row.kind, digest: row.digest, approver: row.approver, decision: 'approve', note: row.note, carried_from: row.carried_from ?? row.landing_id, at: row.at });
    }
  }
}

/** The landings before this one in its retry and supersede chain, nearest first (the same agent's only). */
function chainOf(landing: Pick<Landing, 'id' | 'agent' | 'retry_of' | 'supersedes'>, get: (id: string) => Landing | null): Landing[] {
  const out: Landing[] = [];
  const seen = new Set([landing.id]);
  const todo = [landing.retry_of, landing.supersedes];
  while (todo.length > 0 && out.length < 100) {
    const id = todo.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const prior = get(id);
    if (!prior || prior.agent !== landing.agent) continue;
    out.push(withoutSeq(prior));
    todo.push(prior.retry_of, prior.supersedes);
  }
  return out;
}

function notApprover(approver: string, landing: Landing, rules: ApprovalRule[]): HubError {
  const why = unique(
    rules.map((rule) => {
      const where = `the rule for ${rule.paths.join(', ')}`;
      if (rule.approvers !== null && !rule.approvers.includes(approver)) return `${where} allows only ${andList(rule.approvers)}`;
      return `${where} is distinct: ${approver} is the human of ${landing.agent}, whose change this is, so someone else approves it`;
    }),
  );
  return new HubError('not_approver', `${approver} can't approve ${landing.id}: ${why.join('; ')}.`, 403);
}

// --------------------------------------------------------- statistics

/**
 * Landing statistics over the last `days` days (landings that ended in that
 * window): per retry/supersede chain, the time from its first land to trunk
 * (median and p90, nearest rank), the share of chains that landed with no
 * send-back, send-backs by code, the median check run and queue wait
 * (picked minus submitted), and how landed merges were resolved.
 */
export function landingStats(store: Store, project: string, days: number, now: number): LandingStats {
  const since = now - days * DAY_MS;
  const all = store.listLandings(project, { order: 'recent' }).map(withoutSeq);
  const byId = new Map(all.map((l) => [l.id, l]));
  const ended = all.filter((l) => l.ended_at !== null && l.ended_at >= since);
  const landed = ended.filter((l) => l.status === 'landed');
  const toTrunk: number[] = [];
  let firstTry = 0;
  for (const l of landed) {
    const chain = [l, ...chainOf(l, (id) => byId.get(id) ?? null)];
    const first = chain.reduce((a, b) => (b.created_at < a.created_at ? b : a));
    toTrunk.push(l.ended_at! - first.created_at);
    if (!chain.some((x) => x.status === 'failed')) firstTry++;
  }
  const sendbacks: LandingStats['sendbacks'] = {};
  for (const l of ended) if (l.status === 'failed' && l.failure) sendbacks[l.failure.code] = (sendbacks[l.failure.code] ?? 0) + 1;
  const finished = ended.filter((l) => l.status === 'landed' || l.status === 'failed');
  const checks = finished.map((l) => l.report?.check?.duration_ms).filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));
  const waits = finished.filter((l) => l.started_at !== null && l.started_at >= l.created_at).map((l) => l.started_at! - l.created_at);
  const resolvedBy: LandingStats['resolved_by'] = {};
  for (const l of landed) {
    const by = l.report?.resolved_by as ResolvedBy | null | undefined;
    if (by) resolvedBy[by] = (resolvedBy[by] ?? 0) + 1;
  }
  return {
    days,
    landed: landed.length,
    median_to_trunk_ms: median(toTrunk),
    p90_to_trunk_ms: percentile(toTrunk, 0.9),
    first_try_rate: landed.length > 0 ? Math.round((firstTry / landed.length) * 100) / 100 : null,
    sendbacks,
    median_check_ms: median(checks),
    median_queue_wait_ms: median(waits),
    resolved_by: resolvedBy,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Nearest rank. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1];
}

// ------------------------------------------------------------- texts

export function closedError(landing: Pick<Landing, 'id' | 'status'>): HubError {
  return new HubError('landing_closed', `${landing.id} is ${landing.status}: it can't change any more`, 409);
}

function tooLate(landing: Pick<Landing, 'id'>): HubError {
  return new HubError('too_late', `${landing.id} is being pushed to trunk right now, so it can't be stopped; it lands or comes back within seconds (hub_wait {"landing_id": "${landing.id}"}).`, 409);
}

function staleError(landing: Landing, attempt: number): HubError {
  return new HubError('landing_stale', `${landing.id} is ${describe(landing)}, not attempt ${attempt} under this lease: stop working on it (kill its check, push nothing)`, 409);
}

function describe(landing: Landing): string {
  if (landing.status === 'running') return `running attempt ${landing.attempt} (${landing.phase ?? 'starting'}${landing.in_doubt ? ', in doubt' : ''})`;
  return landing.superseded_by ? `${landing.status} by ${landing.superseded_by}` : landing.status;
}

/** failure.summary: the first line of the lander's own message, else a hub-written one. */
function summaryOf(report: LandingReport, code: LandingFailureCode, id: string): string {
  const first = cleanText(report.message.split('\n')[0] ?? '', 500);
  return first || `${id} came back: ${code}`;
}

/** The claim_conflict failure: entries and holders only (intents stay in the conflicts, as the holders' words). */
function conflictSummary(id: string, conflicts: ClaimConflict[]): string {
  const items = conflicts.map((c) => {
    const what = andList(capped(c.scope.map(entryName), MAX_NAMED));
    return `${what} ${c.scope.length > 1 ? 'are' : 'is'} ${c.landing_id ? `being landed by ${c.landing_id} (${c.holder})` : `claimed by ${c.holder} (${c.claim_id})`}`;
  });
  return `${id} touches code other agents hold: ${items.join('; ')}. Coordinate with them (hub_post) or wait for them, then land again.`;
}

/** Admission warnings, kept on the landing until the lander writes its report. */
function warningsReport(warnings: string[]): LandingReport {
  return { message: '', resolved_by: null, files_via: [], conflicts: [], check: null, resolver: null, next_steps: [], warnings, foreign_commits: [], timings: null };
}
