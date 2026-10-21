import { FULL_SHA_RE, LANDER_LEASE_KEY, isValidSymbolKey } from '@agenthub/contract';
import { HubError, cleanText, entryName, idOf, normalizeRepoPath, unique, type HubInternals } from './common.js';
import { holdsToLeases, moveHolds, planHolds, releaseHolds, setHolds, type HoldOwner } from './holds.js';
import { phase1Landing } from './landing-row.js';
import type { Claim, ClaimConflict, LandRequest, LandResult, LanderInfo, Landing, LandingStatus, ScopeEntry, Task } from './protocol.js';
import type { Store } from './store.js';

// The landing queue's agent side (design §1.4 T1 and T15, §2.1): queue-mode
// land, queue positions and ETAs, and the effects of a landing that lands or
// comes back, which the lander protocol applies. Every function that changes
// anything runs inside Hub.write.

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
  const files = unique(listOf(req.files, 'files').map(normalizeRepoPath));
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
 * Scope entries of a landing: `{file}` is the whole file; a symbol must be a
 * declaration key (SYMBOL_KEY_RE, at most 200 characters) and needs the
 * mapper that produced it (400 invalid_symbol).
 */
function normalizeLandingScope(raw: unknown[], mapper: string | null): ScopeEntry[] {
  const seen = new Set<string>();
  const out: ScopeEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') throw new HubError('bad_request', 'scope entries look like {file, symbol?}');
    const { file: rawFile, symbol: rawSymbol } = entry as { file?: unknown; symbol?: unknown };
    const file = normalizeRepoPath(rawFile);
    let symbol: string | undefined;
    if (rawSymbol !== undefined && rawSymbol !== null) {
      if (typeof rawSymbol !== 'string' || !isValidSymbolKey(rawSymbol.normalize('NFC'))) {
        throw new HubError('invalid_symbol', 'scope symbols are declaration keys such as login, Session.refresh, @imports or @toplevel, at most 200 characters');
      }
      if (mapper === null) throw new HubError('invalid_symbol', 'symbol entries need the mapper (MAPPER_VERSION) that produced them');
      symbol = rawSymbol.normalize('NFC');
    }
    const key = `${file}\u0000${symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(symbol === undefined ? { file } : { file, symbol });
  }
  return out;
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
  // without a task). Holds never count: they belong to their landings.
  const otherTasks = store.listTasks(project).filter((t) => t.owner === agent && t.status === 'in_progress' && t.id !== task?.id);
  const selected = req.release_claims
    ? store
        .listClaims(project, { statuses: ['active', 'queued'], holder: agent, landing_id: null })
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

/** A stored landing as land answers it: without the row's undeclared seq. */
function withoutSeq(landing: Landing): Landing {
  const { seq: _seq, ...rest } = landing as Landing & { seq?: number };
  return rest;
}
