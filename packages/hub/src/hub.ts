import {
  AGENT_ID_RE,
  CHANNEL_RE,
  PATH_FORBIDDEN_RE,
  PROJECT_RE,
  type AgentInfo,
  type CheckResult,
  type Claim,
  type ClaimConflict,
  type ClaimMode,
  type ClaimRequest,
  type ClaimRequestMode,
  type ClaimResult,
  type Decision,
  type DecisionRequest,
  type HeartbeatRequest,
  type HeartbeatResult,
  type HubEvent,
  type HubEventType,
  type InboxResult,
  type Landing,
  type LandRequest,
  type LandResult,
  type Message,
  type ReleaseRequest,
  type ReleaseResult,
  type ScopeEntry,
  type StatusResult,
  type Task,
  type TaskCreateRequest,
  type TaskStatus,
} from './protocol.js';
import { phase1Landing } from './landing-row.js';
import type { AgentTouch, Store } from './store.js';

export interface HubOptions {
  store: Store;
  /** Injectable clock for tests. */
  now?: () => number;
  /** How long a claim lives without a heartbeat. Default 2 minutes. */
  leaseTtlMs?: number;
  /** How often adapters are asked to heartbeat: at most a third of the lease TTL. Default 30 seconds, or TTL/4 if less. */
  heartbeatIntervalMs?: number;
  /** An agent counts as online if seen within this window. Default = lease TTL. */
  presenceTtlMs?: number;
}

export type LeaseSettings = Required<Pick<HubOptions, 'leaseTtlMs' | 'heartbeatIntervalMs' | 'presenceTtlMs'>>;

export class HubError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

const MAX_FILES_PER_CLAIM = 200;
const MAX_INTENT = 300;
const MAX_TITLE = 200;
const MAX_LONG_TEXT = 4000;
const MAX_SUMMARY = 300;
/** Lease TTLs a hub or a claim can have: up to a day. TTLs under a second are for tests. */
const MIN_LEASE_TTL_MS = 100;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
/** The shortest heartbeat interval a hub asks for or a claim gets (what the shortest TTL gives by default). */
const MIN_HEARTBEAT_MS = 25;
/** Past this many events since a wait graph was built, building a new one is cheaper than checking them. */
const MAX_EVENTS_TO_REUSE = 100;
/** Events read from the store at a time. */
const EVENT_PAGE = 500;
/**
 * At most this many events are read from the store for one readEvents call (a
 * GET /events, one step of a feed's replay), so a reader far behind, or behind
 * a long run of events it can't see, can't hold up the hub: it reads on from
 * `next_since`.
 */
const MAX_EVENTS_SCANNED = 5000;

/** At most this many claims are named in a landing note. */
const MAX_NOTE_CLAIMS = 10;

/**
 * The coordination core. Every state change goes through `write()`, which
 * runs synchronously inside one store transaction and is not re-entrant, so
 * claim decisions are strictly serialized: two agents can never both win the
 * same file. Events are published to subscribers only after the transaction
 * commits.
 */
export class Hub {
  readonly store: Store;
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly presenceTtlMs: number;
  /** The store's epoch: made once per database, so clients can tell a recreated one apart. */
  readonly epoch: string;
  private readonly clock: () => number;
  private readonly listeners = new Set<(event: HubEvent) => void>();
  /** Every committed event up to this seq has been published to the listeners (see publish). */
  private publishedSeq: number;
  private pending: HubEvent[] | null = null;
  private txNow = 0;
  /** Each project's last wait graph, with the event seq it was built at (see waitGraph). */
  private readonly waitGraphs = new Map<string, { seq: number; waits: Waits }>();

  constructor(opts: HubOptions) {
    this.store = opts.store;
    this.clock = opts.now ?? Date.now;
    const lease = leaseSettings(opts);
    this.leaseTtlMs = lease.leaseTtlMs;
    this.heartbeatIntervalMs = lease.heartbeatIntervalMs;
    this.presenceTtlMs = lease.presenceTtlMs;
    this.epoch = this.store.epoch();
    this.publishedSeq = this.store.lastSeq();
  }

  now(): number {
    return this.clock();
  }

  /**
   * Receive every committed event (all projects), in seq order, including those
   * other hub processes on the same store commit (see catchUp). Returns an
   * unsubscribe function.
   */
  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Publishes the events other hub processes on the same store committed since
   * the last event published here. The server calls this on every sweep, so
   * its feeds and long-polls hear of those events within a tick. This hub's
   * own commits publish them first anyway, keeping subscribers in seq order.
   */
  catchUp(): void {
    this.publish([]);
  }

  // ---------------------------------------------------------------- claims

  claim(project: string, agent: string, req: ClaimRequest): ClaimResult {
    assertAgent(agent);
    const scope = normalizeScope(req);
    const mode = req.mode ?? 'exclusive';
    if (mode !== 'exclusive' && mode !== 'shared' && mode !== 'auto') {
      throw new HubError('bad_request', 'mode must be exclusive, shared or auto');
    }
    const ttl = clampInt(req.ttl_ms, this.leaseTtlMs, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS, 'ttl_ms');
    // Heartbeats for a claim come before its lease runs out, by default three times per lease.
    const heartbeat = clampInt(req.heartbeat_interval_ms, Math.min(this.heartbeatIntervalMs, Math.floor(ttl / 3)), MIN_HEARTBEAT_MS, ttl - 1, 'heartbeat_interval_ms');
    const intentIn = cleanText(req.intent, MAX_INTENT);
    const baseCommit = cleanText(req.base_commit, 64) || null;
    const requestedTask = idOf(req.task_id, 'task_id');

    // A deadlock refusal comes back as a value so the renewal below still commits.
    const result = this.write(project, (now): ClaimResult | HubError => {
      this.touch(project, agent, now);
      // A claim request proves the agent is alive, so it renews every lease the
      // agent holds. Agents that only run the edit hook (no heartbeating MCP
      // server) keep the files they touched earlier in the session.
      const held = this.renewLeases(project, agent, now);
      // Nobody can wait for an agent that holds nothing, so its requests need no graph.
      const waitedFor = held.length > 0;
      const files = unique(scope.map((s) => s.file));
      const { covering, uncovered, queuedOnFiles, waiters, blockers, effectiveMode, waits } = this.standing(project, agent, files, mode, waitedFor);
      if (uncovered.length === 0) {
        // A renewal ties the claims it renews that have no task to the task it is
        // for, as a new claim would be, so landing that task releases them (see
        // land). A task_id that names no task ties nothing; the renewal stands.
        const untied = covering.filter((c) => c.task_id === null);
        const known = !requestedTask || this.store.getTask(project, requestedTask) !== null;
        const taskId = untied.length > 0 && known ? this.resolveTaskId(project, agent, requestedTask) : null;
        for (const c of taskId ? untied : []) {
          c.task_id = taskId;
          this.store.updateClaim(project, c.id, { task_id: taskId });
        }
        return { status: 'granted', claim: covering[0], claims: covering, renewed: true, conflicts: [], now, seq: this.store.latestSeq(project) };
      }

      const conflicts = blockers.map((c) => toConflict(c, uncovered));
      // A holder in the way that waits, directly or not, for a claim this agent holds
      // would wait forever, and so would this request. That can't be queued.
      const waitsForMe = waitedFor && blockers.some((c) => waits().reach.has(c.holder, agent));
      const cycle = waitsForMe ? waitCycle(waits().held, agent, blockers) : null;

      if (conflicts.length > 0 && !req.queue) {
        const deadlock = denialDeadlock(waits, agent, blockers, waitsForMe, cycle);
        return {
          status: 'denied',
          claims: covering,
          renewed: covering.length > 0,
          conflicts,
          ...(deadlock ? { deadlock } : {}),
          now,
          seq: this.store.latestSeq(project),
        };
      }
      if (cycle) {
        return new HubError(
          'deadlock',
          `queueing would deadlock: ${cycle.steps}, so none of these claims could ever be granted. Release ${cycle.release}, or go on without this claim.`,
          409,
        );
      }

      const taskId = this.resolveTaskId(project, agent, requestedTask);
      const intent = intentIn || this.defaultIntent(project, taskId, uncovered);
      const claimScope = scope.filter((s) => uncovered.includes(s.file));

      if (conflicts.length > 0) {
        const existing = queuedOnFiles.find((c) => c.holder === agent && c.mode === effectiveMode && sameFiles(c, uncovered));
        let claim: Claim;
        if (existing) {
          existing.expires_at = now + existing.ttl_ms;
          this.store.updateClaim(project, existing.id, { expires_at: existing.expires_at });
          claim = existing;
        } else {
          claim = this.newClaim(project, agent, {
            taskId,
            scope: claimScope,
            mode: effectiveMode,
            intent,
            baseCommit,
            status: 'queued',
            now,
            ttl,
            heartbeat,
          });
          this.store.insertClaim(claim);
          this.emit(project, 'claim.queued', agent, {
            claim_id: claim.id,
            holder: agent,
            files: uncovered,
            mode: effectiveMode,
            intent,
            waiting_for: unique(conflicts.map((c) => c.holder)),
          });
          // Now that this agent waits for others, a claim queued before this one
          // may have to let a waiter go first, which may grant that waiter. (A
          // direct grant reorders nothing: only agents that already wait for this
          // one come to wait for it.)
          if (waitedFor) this.promoteQueued(project, now);
        }
        const inTheWay = new Set(blockers);
        const ahead = waiters.filter((q) => q.id !== claim.id && (claimOrderBefore(q, claim) || inTheWay.has(q))).length;
        return {
          status: 'queued',
          claim,
          claims: covering,
          renewed: covering.length > 0,
          conflicts,
          position: ahead + 1,
          now,
          seq: this.store.latestSeq(project),
        };
      }

      const claim = this.newClaim(project, agent, { taskId, scope: claimScope, mode: effectiveMode, intent, baseCommit, status: 'active', now, ttl, heartbeat });
      this.store.insertClaim(claim);
      this.emit(project, 'claim.granted', agent, { claim_id: claim.id, holder: agent, files: uncovered, mode: effectiveMode, intent, task_id: taskId });
      return {
        status: 'granted',
        claim,
        claims: [...covering, claim],
        renewed: false,
        conflicts: [],
        now,
        seq: this.store.latestSeq(project),
      };
    });
    if (result instanceof HubError) throw result;
    return result;
  }

  /**
   * Where a claim request of `agent`'s for `files` in `mode` stands, as claim()
   * decides it: the agent's claims that already cover files (`covering`), the
   * files they don't (`uncovered`) and, for those, the other agents' claims in
   * the way (`blockers`) and the mode a grant would have. `waitedFor`: the
   * agent holds a claim, active or queued, so others may wait for it.
   */
  private standing(project: string, agent: string, files: string[], mode: ClaimRequestMode, waitedFor: boolean) {
    const live = this.store.claimsForFiles(project, files, ['active']);
    const mine = live.filter((c) => c.holder === agent);
    const others = live.filter((c) => c.holder !== agent);
    let graph: Waits | undefined;
    const waits = () => (graph ??= this.waitGraph(project));

    // A claim of mine covers a file if it includes it with a strong enough mode.
    const covers = (c: Claim, file: string) => hasFile(c, file) && (mode !== 'exclusive' || c.mode === 'exclusive');
    const covering = mine.filter((c) => files.some((f) => covers(c, f)));
    const uncovered = files.filter((f) => !mine.some((c) => covers(c, f)));
    if (uncovered.length === 0) {
      return { covering, uncovered, queuedOnFiles: [] as Claim[], waiters: [] as Claim[], blockers: [] as Claim[], effectiveMode: (mode === 'shared' ? 'shared' : 'exclusive') as ClaimMode, waits };
    }

    // Earlier waiters stand in the way like holders do, so a later request can't
    // overtake them. A waiter whose agent is itself waiting, directly or not, for
    // this agent doesn't: it can't be granted before this agent lets go anyway,
    // so this request goes ahead of it, queued or not (see waitGraph).
    const queuedOnFiles = this.store.claimsForFiles(project, uncovered, ['queued']);
    const theirs = queuedOnFiles.filter((q) => q.holder !== agent);
    const waiters = theirs.filter((q) => !(waitedFor && waits().reach.has(q.holder, agent)));
    const blocking = [...others.filter((c) => uncovered.some((f) => hasFile(c, f))), ...waiters];
    const effectiveMode: ClaimMode =
      mode === 'auto' ? (blocking.length > 0 && blocking.every((c) => c.mode === 'shared') ? 'shared' : 'exclusive') : mode;
    const blockers = blocking.filter((c) => c.mode === 'exclusive' || effectiveMode === 'exclusive');
    return { covering, uncovered, queuedOnFiles, waiters, blockers, effectiveMode, waits };
  }

  /** `claim_id`, `task_id` and `files` each narrow what is released; `all` alone names every claim of the agent's. */
  release(project: string, agent: string, req: ReleaseRequest): ReleaseResult {
    assertAgent(agent);
    if (req.files != null && !Array.isArray(req.files)) throw new HubError('bad_request', 'files must be a list of repo paths');
    // An empty list names no files, so it narrows nothing.
    const files = req.files?.length ? unique(req.files.map(normalizeRepoPath)) : undefined;
    const claimId = idOf(req.claim_id, 'claim_id');
    const taskId = idOf(req.task_id, 'task_id');
    if (!claimId && !files && !taskId && !req.all) {
      throw new HubError('bad_request', 'say what to release: claim_id, files, task_id or all');
    }
    return this.write(project, (now) => {
      let targets: Claim[];
      if (claimId) {
        const c = this.store.getClaim(project, claimId);
        if (!c) throw new HubError('not_found', `no claim ${claimId}`, 404);
        if (c.holder !== agent) throw new HubError('forbidden', `${c.id} is held by ${c.holder}; only its holder can release it`, 403);
        targets = (c.status === 'active' || c.status === 'queued') && (!taskId || c.task_id === taskId) ? [c] : [];
      } else {
        targets = this.store.listClaims(project, { statuses: ['active', 'queued'], holder: agent, task_id: taskId });
      }
      if (files) targets = targets.filter((c) => c.scope.some((s) => files.includes(s.file)));

      const released: Claim[] = [];
      const trimmed: Claim[] = [];
      for (const c of targets) {
        const remaining = files ? c.scope.filter((s) => !files.includes(s.file)) : [];
        if (remaining.length > 0) {
          const removed = unique(c.scope.filter((s) => files!.includes(s.file)).map((s) => s.file));
          this.store.updateClaim(project, c.id, { scope: remaining });
          trimmed.push({ ...c, scope: remaining });
          this.emit(project, 'claim.released', agent, { claim_id: c.id, holder: c.holder, files: removed, partial: true });
        } else {
          released.push(this.endClaim(project, c, 'released', 'released by holder', now));
        }
      }
      const promoted = released.length + trimmed.length > 0 ? this.promoteQueued(project, now) : [];
      return { released, trimmed, promoted, now, seq: this.store.latestSeq(project) };
    });
  }

  /** Renew the agent's active and queued leases (all of them, or `claim_ids`) and mark it present. */
  heartbeat(project: string, agent: string, req: HeartbeatRequest = {}): HeartbeatResult {
    assertAgent(agent);
    const claimIds = req.claim_ids == null ? undefined : idList(req.claim_ids, 'claim_ids');
    return this.write(project, (now) => {
      this.touch(project, agent, now, {
        client: cleanText(req.client, 64) || null,
        branch: cleanText(req.branch, 200) || null,
        worktree: cleanText(req.worktree, 500) || null,
      });
      const claims = this.renewLeases(project, agent, now, claimIds);
      const next = claims.length ? Math.min(...claims.map((c) => c.heartbeat_interval_ms)) : this.heartbeatIntervalMs;
      return { renewed: claims.length, claims, next_heartbeat_ms: next, now, seq: this.store.latestSeq(project) };
    });
  }

  /**
   * Without `mode`: active exclusive claims by anyone other than `agent` on
   * these files (for the pre-commit guard). With it: for each file, what a
   * claim request of `agent`'s for that file alone in `mode`, with queue
   * false, would be denied for right now, so a wait for the files (hub_wait)
   * ends exactly when the edit hook's request would be granted. Changes nothing.
   */
  check(project: string, agent: string | null, files: string[], mode?: ClaimRequestMode): CheckResult {
    if (agent !== null) assertAgent(agent);
    if (mode !== undefined && mode !== 'exclusive' && mode !== 'shared' && mode !== 'auto') {
      throw new HubError('bad_request', 'mode must be exclusive, shared or auto');
    }
    const norm = unique(files.map(normalizeRepoPath));
    return this.read(project, (now) => {
      if (mode === undefined) {
        const live = this.store.claimsForFiles(project, norm, ['active']);
        const conflicts = live.filter((c) => c.holder !== agent && c.mode === 'exclusive').map((c) => toConflict(c, norm));
        return { conflicts, now, seq: this.store.latestSeq(project) };
      }
      const me = agent ?? '';
      const waitedFor = agent !== null && this.store.listClaims(project, { statuses: ['active', 'queued'], holder: agent }).length > 0;
      const byClaim = new Map<string, ClaimConflict>();
      let deadlock: string | null = null;
      for (const file of norm) {
        const { uncovered, blockers, waits } = this.standing(project, me, [file], mode, waitedFor);
        for (const c of blockers) {
          const seen = byClaim.get(c.id);
          if (seen) seen.files = unique([...seen.files, ...toConflict(c, uncovered).files]);
          else byClaim.set(c.id, toConflict(c, uncovered));
        }
        const waitsForMe = waitedFor && blockers.some((c) => waits().reach.has(c.holder, me));
        deadlock ??= blockers.length ? denialDeadlock(waits, me, blockers, waitsForMe, waitsForMe ? waitCycle(waits().held, me, blockers) : null) : null;
      }
      return { conflicts: [...byClaim.values()], ...(deadlock ? { deadlock } : {}), now, seq: this.store.latestSeq(project) };
    });
  }

  listClaims(project: string, filter: { holder?: string; file?: string; include_ended?: boolean } = {}): Claim[] {
    return this.read(project, () => {
      const statuses = filter.include_ended ? (['active', 'queued', 'released', 'expired'] as const) : (['active', 'queued'] as const);
      const claims = filter.file
        ? this.store.claimsForFiles(project, [normalizeRepoPath(filter.file)], [...statuses])
        : this.store.listClaims(project, { statuses: [...statuses] });
      return filter.holder ? claims.filter((c) => c.holder === filter.holder) : claims;
    });
  }

  getClaim(project: string, id: string): Claim {
    return this.read(project, () => {
      const c = this.store.getClaim(project, id);
      if (!c) throw new HubError('not_found', `no claim ${id}`, 404);
      return c;
    });
  }

  /** Expire every lease whose heartbeat stopped, across all projects. Returns the projects touched. */
  sweep(): string[] {
    const projects = this.store.projectsWithDueClaims(this.clock());
    for (const project of projects) this.write(project, () => undefined);
    return projects;
  }

  // ----------------------------------------------------------------- tasks

  createTask(project: string, agent: string, req: TaskCreateRequest): Task {
    assertAgent(agent);
    const title = cleanText(req.title, MAX_TITLE);
    if (!title) throw new HubError('bad_request', 'a task needs a title');
    const description = cleanText(req.description, MAX_LONG_TEXT, true);
    const deps = unique((req.deps ?? []).map((d) => String(d).trim()).filter(Boolean));
    return this.write(project, (now) => {
      for (const d of deps) {
        if (!this.store.getTask(project, d)) throw new HubError('not_found', `dependency ${d} does not exist`, 404);
      }
      const id = `T-${this.store.nextCounter(project, 'task')}`;
      const task = { id, project, title, description, deps, owner: null, status: 'open' as const, created_by: agent, created_at: now, updated_at: now };
      this.store.insertTask(task);
      this.emit(project, 'task.created', agent, { task_id: id, title, deps });
      return this.withBlocked(project, task);
    });
  }

  takeTask(project: string, agent: string, id: string): Task {
    assertAgent(agent);
    return this.write(project, (now) => {
      const task = this.store.getTask(project, id);
      if (!task) throw new HubError('not_found', `no task ${id}`, 404);
      if (task.owner === agent && task.status === 'in_progress') return this.withBlocked(project, task);
      if (task.status === 'done' || task.status === 'cancelled') throw new HubError('task_closed', `${id} is already ${task.status}`, 409);
      if (task.status === 'in_progress' && task.owner) throw new HubError('task_taken', `${id} is already taken by ${task.owner}`, 409);
      this.assertUnblocked(project, task, 'taken');
      this.store.updateTask(project, id, { owner: agent, status: 'in_progress', updated_at: now });
      this.emit(project, 'task.taken', agent, { task_id: id, title: task.title, owner: agent });
      return this.withBlocked(project, { ...task, owner: agent, status: 'in_progress', updated_at: now });
    });
  }

  updateTask(project: string, agent: string, id: string, status: TaskStatus): { task: Task; unblocked: string[] } {
    assertAgent(agent);
    if (!['open', 'done', 'cancelled'].includes(status)) {
      throw new HubError('bad_request', 'status must be open, done or cancelled (use take to start a task)');
    }
    return this.write(project, (now) => {
      const task = this.store.getTask(project, id);
      if (!task) throw new HubError('not_found', `no task ${id}`, 404);
      if (task.owner && task.owner !== agent) throw new HubError('forbidden', `${id} is owned by ${task.owner}`, 403);
      if (status === 'done' && task.status !== 'done') this.assertCompletable(project, task);
      const owner = status === 'open' ? null : task.owner;
      this.store.updateTask(project, id, { status, owner, updated_at: now });
      this.emit(project, 'task.updated', agent, { task_id: id, status, previous: task.status });
      const unblocked = status === 'done' ? this.announceUnblocked(project, id, agent) : [];
      return { task: this.withBlocked(project, { ...task, status, owner, updated_at: now }), unblocked };
    });
  }

  listTasks(project: string): Task[] {
    return this.read(project, () => {
      const tasks = this.store.listTasks(project);
      const statusById = new Map(tasks.map((t) => [t.id, t.status]));
      return tasks.map((t) => ({ ...t, blocked_by: t.deps.filter((d) => statusById.get(d) !== 'done') }));
    });
  }

  // -------------------------------------------------------------- messages

  post(project: string, from: string, req: { to: string; body: string }): Message {
    assertAgent(from);
    const to = String(req.to ?? '').trim();
    const isChannel = CHANNEL_RE.test(to);
    if (!isChannel && !AGENT_ID_RE.test(to)) {
      throw new HubError('bad_request', '`to` must be an agent id like maya/claude-2 or a channel like #general');
    }
    if (typeof req.body === 'string' && req.body.length > MAX_LONG_TEXT) {
      throw new HubError('too_long', `message bodies are limited to ${MAX_LONG_TEXT} characters`);
    }
    const body = cleanText(req.body, MAX_LONG_TEXT, true);
    if (!body) throw new HubError('bad_request', 'message body is empty');
    return this.write(project, (now) => {
      this.touch(project, from, now);
      const message = { project, from, to: isChannel ? null : to, channel: isChannel ? to : null, body, created_at: now };
      const id = this.store.insertMessage(message);
      // The event carries no body: recipients read content through the inbox.
      this.emit(project, 'message.posted', from, { message_id: id, from, to: message.to, channel: message.channel }, isChannel ? null : unique([to, from]));
      return { id, ...message };
    });
  }

  inbox(project: string, agent: string, opts: { peek?: boolean; limit?: number } = {}): InboxResult {
    assertAgent(agent);
    const limit = clampInt(opts.limit, 50, 1, 200, 'limit');
    const run = (now: number): InboxResult => {
      const cursor = this.store.getInboxCursor(project, agent);
      const total = this.store.countMessagesFor(project, agent, cursor);
      const messages = this.store.messagesFor(project, agent, cursor, limit);
      if (!opts.peek && messages.length > 0) this.store.setInboxCursor(project, agent, messages[messages.length - 1].id);
      return { messages, unread_remaining: total - messages.length, now };
    };
    return opts.peek ? this.read(project, run) : this.write(project, run);
  }

  // ------------------------------------------------------------- decisions

  decide(project: string, agent: string, req: DecisionRequest): Decision {
    assertAgent(agent);
    const summary = cleanText(req.summary, MAX_SUMMARY);
    if (!summary) throw new HubError('bad_request', 'a decision needs a summary');
    const rationale = cleanText(req.rationale, MAX_LONG_TEXT, true);
    const files = unique((req.files ?? []).map(normalizeRepoPath));
    const symbols = unique((req.symbols ?? []).map((s) => cleanText(s, 200)).filter(Boolean));
    const requestedTask = idOf(req.task_id, 'task_id');
    return this.write(project, (now) => {
      const taskId = requestedTask ? this.resolveTaskId(project, agent, requestedTask) : null;
      const decision: Decision = { id: `D-${this.store.nextCounter(project, 'decision')}`, project, agent, summary, rationale, files, symbols, task_id: taskId, created_at: now };
      this.store.insertDecision(decision);
      this.emit(project, 'decision.recorded', agent, { decision_id: decision.id, agent, summary, files, symbols });
      return decision;
    });
  }

  listDecisions(project: string, limit = 20): Decision[] {
    return this.read(project, () => this.store.listDecisions(project, clampInt(limit, 20, 1, 500, 'limit')));
  }

  // --------------------------------------------------------------- landing

  /**
   * Phase 1 stub: records the request, marks the task done and releases its
   * claims, and those tied to no task once no other task of the agent's is in
   * progress. With no task, it releases all of the agent's claims.
   */
  land(project: string, agent: string, req: LandRequest): LandResult {
    assertAgent(agent);
    const requestedTask = idOf(req.task_id, 'task_id');
    return this.write(project, (now) => {
      let task: Task | null = null;
      let unblocked: string[] = [];
      if (requestedTask) {
        const t = this.store.getTask(project, requestedTask);
        if (!t) throw new HubError('not_found', `no task ${requestedTask}`, 404);
        if (t.owner && t.owner !== agent) throw new HubError('forbidden', `${t.id} is owned by ${t.owner}`, 403);
        const owner = t.owner ?? agent;
        if (t.status !== 'done') {
          this.assertCompletable(project, t);
          this.store.updateTask(project, t.id, { status: 'done', owner, updated_at: now });
          this.emit(project, 'task.updated', agent, { task_id: t.id, status: 'done', previous: t.status });
          unblocked = this.announceUnblocked(project, t.id, agent);
        }
        task = this.withBlocked(project, { ...t, status: 'done', owner, updated_at: now });
      }
      const landing: Landing = phase1Landing({
        id: `L-${this.store.nextCounter(project, 'landing')}`,
        project,
        agent,
        task_id: task?.id ?? null,
        branch: cleanText(req.branch, 200) || null,
        commit: cleanText(req.commit, 64) || null,
        summary: cleanText(req.summary, MAX_LONG_TEXT, true),
        status: 'recorded',
        created_at: now,
      });
      this.store.insertLanding(landing);
      this.emit(project, 'land.requested', agent, { landing_id: landing.id, agent, task_id: landing.task_id, branch: landing.branch, commit: landing.commit });

      // Unless the request named one, a claim is tied to a task only when it was
      // made or renewed while that was the agent's one task in progress, so the
      // edit hook's claims from before task_take, or from while two tasks were,
      // are tied to none. Once no other task of the agent's is in progress, those
      // can only be for this one, so they go too. A claim tied to another task
      // stays for it.
      const inProgress = this.store.listTasks(project).filter((t) => t.owner === agent && t.status === 'in_progress').map((t) => t.id);
      const released: Claim[] = [];
      if (req.release_claims !== false) {
        const mine = this.store
          .listClaims(project, { statuses: ['active', 'queued'], holder: agent })
          .filter((c) => !task || c.task_id === task.id || (c.task_id === null && inProgress.length === 0));
        for (const c of mine) released.push(this.endClaim(project, c, 'released', `landed ${landing.id}`, now));
        if (released.length) this.promoteQueued(project, now);
      }
      const held = this.store.listClaims(project, { statuses: ['active', 'queued'], holder: agent });
      return {
        landing,
        task,
        released,
        unblocked,
        held: [],
        superseded: [],
        replayed: false,
        position: null,
        eta_ms: null,
        lander: null,
        note: landNote(task, released, held, inProgress),
        now,
        seq: this.store.latestSeq(project),
      };
    });
  }

  // ------------------------------------------------------- status & events

  status(project: string, agent: string | null): StatusResult {
    if (agent !== null) assertAgent(agent);
    return this.read(project, (now) => {
      const tasks = this.listTasks(project);
      const agents: AgentInfo[] = this.store.listAgents(project).map((a) => ({
        agent: a.agent,
        client: a.client,
        branch: a.branch,
        worktree: a.worktree,
        first_seen: a.first_seen,
        last_seen: a.last_seen,
        online: now - a.last_seen <= this.presenceTtlMs,
        current_task: tasks.find((t) => t.owner === a.agent && t.status === 'in_progress')?.id ?? null,
      }));
      return {
        project,
        agent,
        now,
        seq: this.store.latestSeq(project),
        lease: { ttl_ms: this.leaseTtlMs, heartbeat_interval_ms: this.heartbeatIntervalMs },
        agents,
        claims: this.store.listClaims(project, { statuses: ['active', 'queued'] }),
        tasks,
        unread: agent ? this.store.countMessagesFor(project, agent, this.store.getInboxCursor(project, agent)) : 0,
        decisions: this.store.listDecisions(project, 10),
        landings: this.store.listLandings(project, 5),
        queue: [],
        lander: null,
        control: {
          paused: null,
          trunk: null,
          policy: { keep_place_retries: 2, sendback_grace_min: 30, approval_timeout_hours: 24, claim_gate: 'fail' },
        },
      };
    });
  }

  /** Committed events after `since` that `agent` may see, at most `limit`. */
  events(project: string, agent: string | null, since: number, limit = 500): HubEvent[] {
    return this.readEvents(project, agent, since, { limit }).events;
  }

  /**
   * Committed events after `since` that `agent` may see, oldest first: at most
   * `limit`, and only those of `types` if given, from at most `maxScan` events
   * read (default MAX_EVENTS_SCANNED). `next_since` is where to read on: after
   * the last event returned, or, short of `limit`, after every event read, seen
   * or not, so a run of other agents' direct messages can't hold a reader back.
   * `end`: every event up to the latest seq was read. A `since` past the latest
   * seq comes from another database (see epoch), so reading starts at the latest seq.
   */
  readEvents(
    project: string,
    agent: string | null,
    since: number,
    opts: { limit?: number; types?: readonly string[]; maxScan?: number } = {},
  ): { events: HubEvent[]; next_since: number; end: boolean } {
    assertProject(project);
    const limit = opts.limit ?? 500;
    const maxScan = Math.max(1, opts.maxScan ?? MAX_EVENTS_SCANNED);
    const events: HubEvent[] = [];
    let cursor = Math.min(since, this.store.latestSeq(project));
    let scanned = 0;
    for (;;) {
      const want = Math.min(EVENT_PAGE, maxScan - scanned);
      const page = this.store.eventsSince(project, cursor, want);
      scanned += page.length;
      for (const e of page) {
        cursor = e.seq;
        if (!isVisibleTo(e, agent) || (opts.types && !opts.types.includes(e.type))) continue;
        if (events.push(e) >= limit) return { events, next_since: cursor, end: cursor >= this.store.latestSeq(project) };
      }
      if (page.length < want) return { events, next_since: cursor, end: true };
      if (scanned >= maxScan) return { events, next_since: cursor, end: false };
    }
  }

  latestSeq(project: string): number {
    assertProject(project);
    return this.store.latestSeq(project);
  }

  // -------------------------------------------------------------- internals

  /**
   * The single serialized write path. Runs `fn` synchronously in one store
   * transaction after expiring overdue leases; refuses re-entry; publishes the
   * events `fn` emitted only once the transaction has committed.
   */
  private write<T>(project: string, fn: (now: number) => T): T {
    assertProject(project);
    if (this.pending) throw new Error('Hub.write is not re-entrant');
    const pending: HubEvent[] = [];
    this.pending = pending;
    let result: T;
    try {
      result = this.store.transaction(() => {
        const now = this.clock();
        this.txNow = now;
        this.store.ensureProject(project, now);
        this.expireDue(project, now);
        return fn(now);
      });
    } catch (err) {
      // A wait graph built in a transaction that rolled back describes claims that
      // never were, at an event seq that the next commit reuses.
      this.waitGraphs.delete(project);
      throw err;
    } finally {
      this.pending = null;
    }
    if (pending.length > 0) this.publish(pending);
    return result;
  }

  /**
   * Publishes committed events to the listeners, each once and in seq order:
   * first those other processes on the store committed since the last one
   * published here, then `own`, which this hub has just committed. Seq order is
   * commit order, so every event before `own` was committed before it.
   */
  private publish(own: HubEvent[]): void {
    const before = own.length > 0 ? own[0].seq : Infinity;
    const events: HubEvent[] = [];
    for (let cursor = this.publishedSeq; cursor < before - 1; ) {
      const page = this.store.allEventsSince(cursor, EVENT_PAGE);
      events.push(...page.filter((e) => e.seq < before));
      if (page.length < EVENT_PAGE || page[page.length - 1].seq >= before) break;
      cursor = page[page.length - 1].seq;
    }
    events.push(...own);
    if (events.length === 0) return;
    this.publishedSeq = Math.max(this.publishedSeq, events[events.length - 1].seq);
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // A failing subscriber must not affect the hub or other subscribers.
        }
      }
    }
  }

  /** Reads go through `write` only when a lease is overdue, so they never see a dead claim. */
  private read<T>(project: string, fn: (now: number) => T): T {
    assertProject(project);
    if (this.pending) return fn(this.txNow);
    const now = this.clock();
    if (this.store.listClaims(project, { statuses: ['active', 'queued'], expiresAtOrBefore: now }).length > 0) {
      this.write(project, () => undefined);
    }
    return fn(this.clock());
  }

  private emit(project: string, type: HubEventType, actor: string | null, data: Record<string, unknown>, targets: string[] | null = null): void {
    if (!this.pending) throw new Error('events can only be emitted inside a write');
    const event = { project, type, actor, at: this.txNow, data, targets };
    const seq = this.store.appendEvent(event);
    this.pending.push({ seq, ...event });
  }

  /** Record that the agent is alive; announce it when it was new or had gone quiet. */
  private touch(project: string, agent: string, now: number, info: AgentTouch = {}): void {
    const { previous_last_seen } = this.store.touchAgent(project, agent, now, info);
    if (previous_last_seen === null || now - previous_last_seen > this.presenceTtlMs) {
      this.emit(project, 'agent.online', agent, { agent, client: info.client ?? null, branch: info.branch ?? null });
    }
  }

  /** Push out the expiry of the agent's active and queued claims (all, or just `claimIds`). */
  private renewLeases(project: string, agent: string, now: number, claimIds?: string[]): Claim[] {
    let claims = this.store.listClaims(project, { statuses: ['active', 'queued'], holder: agent });
    if (claimIds?.length) claims = claims.filter((c) => claimIds.includes(c.id));
    for (const c of claims) {
      c.expires_at = now + c.ttl_ms;
      this.store.updateClaim(project, c.id, { expires_at: c.expires_at });
    }
    return claims;
  }

  private expireDue(project: string, now: number): void {
    const due = this.store.listClaims(project, { statuses: ['active', 'queued'], expiresAtOrBefore: now });
    if (due.length === 0) return;
    for (const c of due) this.endClaim(project, c, 'expired', 'lease expired: heartbeats stopped', now);
    this.promoteQueued(project, now);
  }

  private endClaim(project: string, c: Claim, status: 'released' | 'expired', reason: string, now: number): Claim {
    this.store.updateClaim(project, c.id, { status, ended_at: now, end_reason: reason });
    this.emit(project, status === 'expired' ? 'claim.expired' : 'claim.released', status === 'expired' ? null : c.holder, {
      claim_id: c.id,
      holder: c.holder,
      files: claimFiles(c),
      was: c.status,
      reason,
    });
    return { ...c, status, ended_at: now, end_reason: reason };
  }

  /**
   * Grant every queued claim that waits for nothing in waitGraph, until none is
   * left. Such claims conflict with no active claim and with no other of them,
   * and the line they wait in keeps a later request from overtaking an earlier
   * one for the same file. The grant keeps the lease the waiter's last heartbeat
   * or request gave it: only the waiter itself can prove it is still alive.
   */
  private promoteQueued(project: string, now: number): Claim[] {
    const promoted: Claim[] = [];
    for (;;) {
      const { queue, blocked } = this.waitGraph(project);
      const ready = queue.filter((q) => !blocked.has(q.id));
      if (ready.length === 0) return promoted;
      for (const q of ready) {
        this.store.updateClaim(project, q.id, { status: 'active', granted_at: now });
        this.emit(project, 'claim.granted', q.holder, {
          claim_id: q.id,
          holder: q.holder,
          files: claimFiles(q),
          mode: q.mode,
          intent: q.intent,
          task_id: q.task_id,
          from_queue: true,
        });
        // As stored: a graph from an earlier request can predate the waiter's last heartbeat.
        promoted.push(this.store.getClaim(project, q.id)!);
      }
    }
  }

  /**
   * Who waits for whom, with an agent that is waiting keeping what it holds. A
   * queued claim waits for the active claims it conflicts with, and for the
   * conflicting queued claims ahead of it in line. The line is FIFO, except that
   * an earlier claim whose agent already waits, directly or through others, for
   * a later claim's agent goes behind it: it can't be granted before that agent
   * lets go anyway, and going first would leave each waiting for the other.
   * Claims are decided in queue order, each against those before it, given all
   * waits for active claims and the decisions made so far. That adds no cycle
   * the waits for active claims (`held`) don't already have, and claim() never
   * queues a claim that closes one there. So the graph stays acyclic, and some
   * claim can always go next.
   *
   * Whatever changes which claims are queued or active, or the files they name,
   * emits an event in the same transaction. So a graph still holds, even after
   * another process wrote, while the events since it was built queue, promote or
   * end no waiter and grant or end no claim on a file a waiter names. Requests
   * then reuse it instead of going over the whole queue again.
   */
  private waitGraph(project: string): Waits {
    const seq = this.store.latestSeq(project);
    const cached = this.waitGraphs.get(project);
    if (cached && (cached.seq === seq || this.leftAlone(project, cached.seq, cached.waits))) {
      cached.seq = seq;
      return cached.waits;
    }
    const queue = this.store.listClaims(project, { statuses: ['queued'] });
    const files = new Set(queue.flatMap(claimFiles));
    const waits = buildWaits(queue, files, this.store.claimsForFiles(project, [...files], ['active']));
    this.waitGraphs.set(project, { seq, waits });
    return waits;
  }

  /** Whether the events after `seq` leave `waits` as they are (see waitGraph). */
  private leftAlone(project: string, seq: number, waits: Waits): boolean {
    const events = this.store.eventsSince(project, seq, MAX_EVENTS_TO_REUSE + 1);
    if (events.length > MAX_EVENTS_TO_REUSE) return false;
    return events.every((e) => {
      if (!e.type.startsWith('claim.')) return true;
      const { claim_id: id, files } = e.data;
      return (
        e.type !== 'claim.queued' &&
        !waits.ids.has(id as string) &&
        Array.isArray(files) &&
        !files.some((f) => waits.files.has(f as string))
      );
    });
  }

  private newClaim(
    project: string,
    holder: string,
    o: { taskId: string | null; scope: ScopeEntry[]; mode: ClaimMode; intent: string; baseCommit: string | null; status: 'active' | 'queued'; now: number; ttl: number; heartbeat: number },
  ): Claim {
    return {
      id: `C-${this.store.nextCounter(project, 'claim')}`,
      project,
      holder,
      task_id: o.taskId,
      scope: o.scope,
      mode: o.mode,
      intent: o.intent,
      base_commit: o.baseCommit,
      status: o.status,
      created_at: o.now,
      granted_at: o.status === 'active' ? o.now : null,
      expires_at: o.now + o.ttl,
      ttl_ms: o.ttl,
      heartbeat_interval_ms: o.heartbeat,
      ended_at: null,
      end_reason: null,
      landing_id: null,
      mapper: null,
    };
  }

  /** An explicit task id must exist; otherwise attach the agent's only in-progress task, if any. */
  private resolveTaskId(project: string, agent: string, taskId: string | undefined): string | null {
    if (taskId) {
      if (!this.store.getTask(project, taskId)) throw new HubError('not_found', `no task ${taskId}`, 404);
      return taskId;
    }
    const mine = this.store.listTasks(project).filter((t) => t.owner === agent && t.status === 'in_progress');
    return mine.length === 1 ? mine[0].id : null;
  }

  /** The task's title, else the files (some of them), capped like an intent the request gives. */
  private defaultIntent(project: string, taskId: string | null, files: string[]): string {
    const task = taskId ? this.store.getTask(project, taskId) : null;
    if (task) return capText(task.title, MAX_INTENT);
    return capText(`edit ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`, MAX_INTENT);
  }

  private blockedBy(project: string, task: Pick<Task, 'deps'>): string[] {
    return task.deps.filter((d) => this.store.getTask(project, d)?.status !== 'done');
  }

  /** A task with a dependency that isn't done can be neither taken nor completed. */
  private assertUnblocked(project: string, task: Pick<Task, 'id' | 'deps'>, what: 'taken' | 'completed'): void {
    const blockedBy = this.blockedBy(project, task);
    if (blockedBy.length === 0) return;
    const detail = blockedBy.map((d) => `${d} (${this.store.getTask(project, d)?.status ?? 'missing'})`).join(', ');
    throw new HubError('task_blocked', `${task.id} is blocked by ${detail}; it can be ${what} once those are done`, 409);
  }

  /** Marking a task done needs it unblocked, and a cancelled one reopened first. */
  private assertCompletable(project: string, task: Pick<Task, 'id' | 'deps' | 'status'>): void {
    if (task.status === 'cancelled') throw new HubError('task_closed', `${task.id} is cancelled; reopen it before marking it done`, 409);
    this.assertUnblocked(project, task, 'completed');
  }

  private withBlocked(project: string, task: Omit<Task, 'blocked_by'>): Task {
    return { ...task, blocked_by: this.blockedBy(project, task) };
  }

  private announceUnblocked(project: string, doneId: string, actor: string): string[] {
    const unblocked: string[] = [];
    for (const t of this.store.listTasks(project)) {
      if (t.status !== 'open' || !t.deps.includes(doneId)) continue;
      if (this.blockedBy(project, t).length > 0) continue;
      this.emit(project, 'task.unblocked', actor, { task_id: t.id, title: t.title, after: doneId });
      unblocked.push(t.id);
    }
    return unblocked;
  }
}

// ------------------------------------------------------------------ helpers

export function isVisibleTo(event: HubEvent, agent: string | null): boolean {
  return event.targets === null || (agent !== null && event.targets.includes(agent));
}

export function assertAgent(agent: unknown): asserts agent is string {
  if (typeof agent !== 'string' || !AGENT_ID_RE.test(agent)) {
    throw new HubError('bad_agent', 'agent id must look like human/agent, e.g. maya/claude-2', 400);
  }
}

export function assertProject(project: unknown): asserts project is string {
  if (typeof project !== 'string' || !PROJECT_RE.test(project) || project.includes('..')) {
    throw new HubError('bad_project', 'project ids use letters, digits, ".", "_", "-" and "/"', 400);
  }
}

const MAX_PATH = 4096;

/**
 * The claim key for a repo-relative POSIX path: the NFC form of the path as
 * sent, nothing else changed, so every client names a file the same way.
 * Refuses PATH_FORBIDDEN_RE characters, absolute paths (`/x`, or a Windows
 * drive root like `C:/x`) and `.`, `..` or empty segments. `a:b.md` and
 * `..env` are legal.
 */
export function normalizeRepoPath(input: unknown): string {
  if (typeof input !== 'string') throw new HubError('invalid_path', 'file paths must be strings');
  const p = input.normalize('NFC');
  const bad = PATH_FORBIDDEN_RE.exec(p);
  if (bad) throw invalidPath(p, `contains ${codePoint(bad[0])}; control, line-separator and bidi characters and unpaired surrogates are not allowed`);
  if (p.length > MAX_PATH) throw invalidPath(p, `is longer than ${MAX_PATH} characters`);
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) throw invalidPath(p, 'is absolute; use a path relative to the repository root');
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw invalidPath(p, 'has a ".", ".." or empty segment');
  }
  return p;
}

function invalidPath(p: string, reason: string): HubError {
  return new HubError('invalid_path', `invalid path ${escapePath(p)}: ${reason}`);
}

/** JSON-quote a path for a message with every invisible or line-breaking character escaped; long paths are cut short. */
function escapePath(p: string): string {
  const shown = p.length > 200 ? `${p.slice(0, 200)}…` : p;
  return JSON.stringify(shown).replace(/[\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

function codePoint(ch: string): string {
  return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
}

function normalizeScope(req: ClaimRequest): ScopeEntry[] {
  const raw: ScopeEntry[] = [...(req.scope ?? []), ...(req.files ?? []).map((file) => ({ file }))];
  if (raw.length === 0) throw new HubError('bad_request', 'a claim needs at least one file');
  const seen = new Set<string>();
  const out: ScopeEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') throw new HubError('bad_request', 'scope entries look like {file, symbol?}');
    const file = normalizeRepoPath(entry.file);
    const symbol = entry.symbol ? cleanText(entry.symbol, 200) : undefined;
    const key = `${file}\u0000${symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(symbol ? { file, symbol } : { file });
  }
  if (unique(out.map((s) => s.file)).length > MAX_FILES_PER_CLAIM) {
    throw new HubError('bad_request', `a claim may cover at most ${MAX_FILES_PER_CLAIM} files`);
  }
  return out;
}

/** Strip control and bidi-override characters, collapse whitespace unless multiline, cap length. */
export function cleanText(value: unknown, max: number, multiline = false): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HubError('bad_request', 'expected a string');
  let s = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '');
  s = multiline ? s.replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return capText(s.trim(), max);
}

/** `s`, cut to at most `max` characters with a trailing ellipsis, never between the halves of a surrogate pair. */
function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  if (/[\uD800-\uDBFF]/.test(s[end - 1] ?? '')) end--;
  return `${s.slice(0, end)}…`;
}

/**
 * The lease settings a hub runs with, defaults filled in. Throws a RangeError
 * naming the first setting that can't work, under the name `names` gives it
 * (hub-server passes the flag or variable it came from). Leases need a TTL
 * from 100 ms to a day, and heartbeats at least three times per lease TTL
 * and presence window, so a live agent keeps its leases across a late
 * heartbeat. Adapters heartbeat at the announced interval at the slowest, so a
 * longer one would let leases expire while their holders run.
 */
export function leaseSettings(opts: Partial<LeaseSettings>, names: Partial<Record<keyof LeaseSettings, string>> = {}): LeaseSettings {
  const check = (key: keyof LeaseSettings, value: number, min: number, max: number, why = '') => {
    const name = names[key] ?? key;
    if (!Number.isInteger(value)) throw new RangeError(`${name} must be a whole number of milliseconds, got ${value}`);
    if (value < min || value > max) throw new RangeError(`${name} must be from ${min} to ${max} ms${why}, got ${value}`);
    return value;
  };
  const leaseTtlMs = check('leaseTtlMs', opts.leaseTtlMs ?? 120_000, MIN_LEASE_TTL_MS, MAX_LEASE_TTL_MS);
  const heartbeatIntervalMs = check('heartbeatIntervalMs', opts.heartbeatIntervalMs ?? Math.min(30_000, Math.floor(leaseTtlMs / 4)), MIN_HEARTBEAT_MS, Math.floor(leaseTtlMs / 3), ` (a third of the ${leaseTtlMs} ms lease TTL)`);
  const presenceTtlMs = check('presenceTtlMs', opts.presenceTtlMs ?? leaseTtlMs, 3 * heartbeatIntervalMs, MAX_LEASE_TTL_MS, ` (three ${heartbeatIntervalMs} ms heartbeats or more)`);
  return { leaseTtlMs, heartbeatIntervalMs, presenceTtlMs };
}

/**
 * A task or claim id from a request body: a string, or a number taken as its
 * digits; missing or empty means none. Anything else is refused with 400, not
 * handed to the store (which would fail with a 500).
 */
function idOf(value: unknown, name: 'task_id' | 'claim_id'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new HubError('bad_request', `${name} must be an id such as ${name === 'task_id' ? 'T-3' : 'C-3'}`);
}

/** A list of claim ids from a request body (see idOf). */
function idList(value: unknown, name: string): string[] {
  const ids = Array.isArray(value) ? value.map((v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : null)) : null;
  if (!ids || ids.includes(null)) throw new HubError('bad_request', `${name} must be a list of claim ids such as C-3`);
  return ids as string[];
}

function clampInt(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HubError('bad_request', `${name} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function claimFiles(c: Claim): string[] {
  return unique(c.scope.map((s) => s.file));
}

function hasFile(c: Claim, file: string): boolean {
  return c.scope.some((s) => s.file === file);
}

function sameFiles(c: Claim, files: string[]): boolean {
  const mine = claimFiles(c);
  return mine.length === files.length && files.every((f) => mine.includes(f));
}

/**
 * Two claims that name the same file conflict unless they have one holder or
 * are both shared. Phase 1 is file-level: whatever the symbols.
 */
function clash(a: Claim, b: Claim): boolean {
  return a.holder !== b.holder && !(a.mode === 'shared' && b.mode === 'shared');
}

function byFile(claims: Claim[]): Map<string, Claim[]> {
  const map = new Map<string, Claim[]>();
  for (const c of claims) for (const f of claimFiles(c)) (map.get(f) ?? map.set(f, []).get(f)!).push(c);
  return map;
}

/** The claims in `index` that name any of `q`'s files, each once. */
function near(index: Map<string, Claim[]>, q: Claim): Claim[] {
  const files = claimFiles(q);
  if (files.length === 1) return index.get(files[0]) ?? [];
  const found = new Map<string, Claim>();
  for (const f of files) for (const c of index.get(f) ?? []) found.set(c.id, c);
  return [...found.values()];
}

/** The queue positions in `line` (per file, in queue order) of the claims that name any of `files`, each once, in queue order. */
function inLine(line: Map<string, number[]>, files: string[]): number[] {
  if (files.length === 1) return line.get(files[0]) ?? [];
  return [...new Set(files.flatMap((f) => line.get(f) ?? []))].sort((a, b) => a - b);
}

/** `waiter` (a queued claim, or null for the request being decided) waits for `blocker`. */
type Wait = { waiter: Claim | null; blocker: Claim };
/** For each agent, one wait for each agent its queued claims wait for. */
type WaitGraph = Map<string, Map<string, Wait>>;

interface Waits {
  /** Queued claims in queue order. */
  queue: Claim[];
  /** Their ids. */
  ids: Set<string>;
  /** The files they name. */
  files: Set<string>;
  /** Ids of the queued claims that wait for something. */
  blocked: Set<string>;
  /** Only the waits for active claims. */
  held: WaitGraph;
  /** All waits, for active claims and in line. */
  all: WaitGraph;
  /** Who waits for whom in `all`, directly or through others. */
  reach: Reach;
}

/** See Hub.waitGraph: `queue` in queue order, `files` the files it names, `active` the active claims on them. */
function buildWaits(queue: Claim[], files: Set<string>, active: Claim[]): Waits {
  const reach = new Reach([...queue, ...active].map((c) => c.holder));
  const waits: Waits = { queue, ids: new Set(queue.map((q) => q.id)), files, blocked: new Set(), held: new Map(), all: new Map(), reach };
  const who = queue.map((q) => reach.at(q.holder));
  // A wait the others already imply (its agent waits for that one through someone
  // else) changes nothing about who waits for whom, so `all` and `reach` skip it:
  // a line of n waiters for one file then takes about n links, not n²/2.
  const wait = (waiter: Claim, w: number, blocker: Claim, b: number) => {
    if (!reach.hasAt(w, b) && link(waits.all, waiter, blocker)) reach.add(w, b);
  };

  const activeByFile = byFile(active);
  const held: HeldWait[] = [];
  queue.forEach((q, i) => {
    for (const a of near(activeByFile, q)) {
      if (!clash(a, q)) continue;
      waits.blocked.add(q.id);
      link(waits.held, q, a);
      held.push({ waiter: q, w: who[i], blocker: a, b: reach.at(a.holder) });
    }
  });
  // Agents that wait for nobody first, then those that wait only for them, and so
  // on: nobody waits for an agent yet when its waits are added, so each extends
  // just its own row (Reach.extend). Agents in a cycle, which claim() never lets
  // form, come last and go the long way.
  const { ordered, acyclic } = sinksFirst(held, reach.size);
  ordered.forEach((h, k) => {
    if (k >= acyclic) wait(h.waiter, h.w, h.blocker, h.b);
    else if (!reach.hasAt(h.w, h.b) && link(waits.all, h.waiter, h.blocker)) reach.extend(h.w, h.b);
  });

  const earlier = new Map<string, number[]>(); // per file, the queue positions of the claims so far
  queue.forEach((q, i) => {
    const qFiles = claimFiles(q);
    const line = inLine(earlier, qFiles);
    const w = who[i];
    // Each decided against the waits before this claim's own are added. Nobody can go
    // behind a claim whose agent nobody waits for yet. Nearest first: waiting for the
    // claim just ahead implies waiting for those it waits for.
    const goesBehind = reach.waitedFor(w) ? new Set(line.filter((j) => clash(queue[j], q) && reach.hasAt(who[j], w))) : null;
    let inLineWait = false;
    for (let k = line.length - 1; k >= 0; k--) {
      const j = line[k];
      if (!clash(queue[j], q)) continue;
      if (goesBehind?.has(j)) {
        waits.blocked.add(queue[j].id);
        wait(queue[j], who[j], q, w);
      } else {
        inLineWait = true;
        wait(q, w, queue[j], who[j]);
      }
    }
    if (inLineWait) waits.blocked.add(q.id);
    for (const f of qFiles) (earlier.get(f) ?? earlier.set(f, []).get(f)!).push(i);
  });
  return waits;
}

/** A queued claim (agent `w`) that waits for an active one (agent `b`). */
type HeldWait = { waiter: Claim; w: number; blocker: Claim; b: number };

/**
 * `held` ordered so that an agent's waits come after those of every agent it
 * waits for: the first `acyclic` of them; the waits of agents in a cycle follow.
 */
function sinksFirst(held: HeldWait[], agents: number): { ordered: HeldWait[]; acyclic: number } {
  const out = new Array<number>(agents).fill(0);
  const into = new Map<number, HeldWait[]>();
  const from = new Map<number, HeldWait[]>();
  for (const h of held) {
    out[h.w]++;
    (into.get(h.b) ?? into.set(h.b, []).get(h.b)!).push(h);
    (from.get(h.w) ?? from.set(h.w, []).get(h.w)!).push(h);
  }
  const ordered: HeldWait[] = [];
  const done = new Set<number>();
  const ready: number[] = [];
  for (let a = 0; a < agents; a++) if (out[a] === 0) ready.push(a);
  while (ready.length) {
    const a = ready.pop()!;
    done.add(a);
    for (const h of from.get(a) ?? []) ordered.push(h);
    for (const h of into.get(a) ?? []) if (--out[h.w] === 0) ready.push(h.w);
  }
  const acyclic = ordered.length;
  for (const h of held) if (!done.has(h.w)) ordered.push(h);
  return { ordered, acyclic };
}

/** Record that `waiter`'s agent waits for `blocker`'s; false if `graph` already had them waiting directly. */
function link(graph: WaitGraph, waiter: Claim, blocker: Claim): boolean {
  const out = graph.get(waiter.holder) ?? graph.set(waiter.holder, new Map()).get(waiter.holder)!;
  if (out.has(blocker.holder)) return false;
  out.set(blocker.holder, { waiter, blocker });
  return true;
}

/** For each agent, a row of bits: the agents it waits for, directly or through others. */
class Reach {
  private readonly index = new Map<string, number>();
  private readonly rows: Uint32Array[] = [];
  /** The agents anyone waits for. */
  private readonly any: Uint32Array;

  constructor(agents: string[]) {
    for (const a of agents) if (!this.index.has(a)) this.index.set(a, this.index.size);
    const words = (this.index.size + 31) >>> 5;
    for (let i = 0; i < this.index.size; i++) this.rows.push(new Uint32Array(words));
    this.any = new Uint32Array(words);
  }

  get size(): number {
    return this.rows.length;
  }

  /** The number of one of the agents given to the constructor. */
  at(agent: string): number {
    return this.index.get(agent)!;
  }

  /** Whether `waiter` waits, directly or through others, for `blocker`. */
  has(waiter: string, blocker: string): boolean {
    const w = this.index.get(waiter);
    const b = this.index.get(blocker);
    return w !== undefined && b !== undefined && bit(this.rows[w], b);
  }

  hasAt(w: number, b: number): boolean {
    return bit(this.rows[w], b);
  }

  /** Whether anyone waits, directly or through others, for agent `b`. */
  waitedFor(b: number): boolean {
    return bit(this.any, b);
  }

  /** `w` now waits for `b` directly: so whoever waits for `w` waits for `b`, and for everyone it waits for. */
  add(w: number, b: number): void {
    if (bit(this.rows[w], b)) return;
    const beyond = this.rows[b];
    for (let s = 0; s < this.rows.length; s++) {
      const row = this.rows[s];
      // Whoever already waits for the blocker already waits for everyone it waits for.
      if ((s !== w && !bit(row, w)) || bit(row, b)) continue;
      row[b >>> 5] |= 1 << (b & 31);
      for (let k = 0; k < row.length; k++) row[k] |= beyond[k];
    }
    this.any[b >>> 5] |= 1 << (b & 31);
    for (let k = 0; k < beyond.length; k++) this.any[k] |= beyond[k];
  }

  /** As add, when nobody waits for `w` yet: only its own row changes. */
  extend(w: number, b: number): void {
    const row = this.rows[w];
    const beyond = this.rows[b];
    row[b >>> 5] |= 1 << (b & 31);
    this.any[b >>> 5] |= 1 << (b & 31);
    for (let k = 0; k < row.length; k++) {
      row[k] |= beyond[k];
      this.any[k] |= beyond[k];
    }
  }
}

function bit(row: Uint32Array, i: number): boolean {
  return (row[i >>> 5] & (1 << (i & 31))) !== 0;
}

/** Breadth-first from `start`: the shortest chain of waits that leads to `agent`, or null if none does. */
function waitChain(graph: WaitGraph, start: Wait[], agent: string): Wait[] | null {
  const reachedBy = new Map<string, Wait>();
  const todo: string[] = [];
  const visit = (w: Wait) => {
    if (reachedBy.has(w.blocker.holder)) return;
    reachedBy.set(w.blocker.holder, w);
    todo.push(w.blocker.holder);
  };
  start.forEach(visit);
  for (let next = todo.shift(); next !== undefined; next = todo.shift()) {
    if (next !== agent) {
      graph.get(next)?.forEach(visit);
      continue;
    }
    const chain = [reachedBy.get(agent)!];
    while (!start.includes(chain[0])) chain.unshift(reachedBy.get(chain[0].waiter!.holder)!);
    return chain;
  }
  return null;
}

/**
 * When waiting for `blockers` would close a wait cycle in `graph` back to
 * `agent`: how (claim and agent ids only), and the claim of `agent`'s it ends
 * at, which is the one to release. Otherwise null.
 */
function waitCycle(graph: WaitGraph, agent: string, blockers: Claim[]): { steps: string; release: string } | null {
  const chain = waitChain(graph, blockers.map((blocker) => ({ waiter: null, blocker })), agent);
  if (!chain) return null;
  const steps = chain.map((w) =>
    w.waiter === null
      ? `your request would wait for ${w.blocker.id} (${w.blocker.holder})`
      : `${w.waiter.id} (${w.waiter.holder}) waits for ${w.blocker.holder === agent ? `your ${w.blocker.id}` : `${w.blocker.id} (${w.blocker.holder})`}`,
  );
  return { steps: steps.join(', '), release: chain[chain.length - 1].blocker.id };
}

/**
 * For a request denied for `blockers` (see Hub.claim): why waiting for them
 * outside the queue would never end, or null if it would. A holder in the way
 * may wait, directly or not, for a claim of the requester's (`cycle`), or
 * wait in line behind one; queued instead, the request would let the hub
 * reorder that line (see waitGraph).
 */
function denialDeadlock(waits: () => Waits, agent: string, blockers: Claim[], waitsForMe: boolean, cycle: ReturnType<typeof waitCycle>): string | null {
  const inLine = cycle || !waitsForMe ? null : waitCycle(waits().all, agent, blockers);
  if (cycle) return `waiting for it would deadlock: ${cycle.steps}, so none of these claims could ever be granted. Release ${cycle.release}, or go on without this claim.`;
  if (inLine) {
    return `waiting for it outside the queue would deadlock: ${inLine.steps}. Ask again with queue: true and the hub reorders the line so this claim is granted in turn, or release ${inLine.release}, or go on without this claim.`;
  }
  return null;
}

function claimOrderBefore(a: Claim, b: Claim): boolean {
  return a.created_at < b.created_at || (a.created_at === b.created_at && idNumber(a.id) < idNumber(b.id));
}

function idNumber(id: string): number {
  return Number(id.split('-')[1] ?? 0);
}

/**
 * What land did, for the agent: nothing merged, and which of its claims (ids
 * only) it still holds, and which of its tasks in progress (`inProgress`)
 * landing would release them: a claim tied to no task needs all of them landed,
 * one tied to one of them that one, and one tied to any other task none.
 */
function landNote(task: Task | null, released: Claim[], held: Claim[], inProgress: string[]): string {
  const parts = ['Phase 1 records the landing request only; nothing was merged. Push or merge your branch the usual way.'];
  if (task) parts.push('The task is marked done.');
  if (held.length === 0) parts.push(released.length > 0 ? 'Your claims are released.' : 'You held no claims.');
  const groups = new Map<string, { tasks: string[]; claims: string[] }>();
  for (const c of held) {
    const tasks = c.task_id === null ? inProgress : inProgress.includes(c.task_id) ? [c.task_id] : [];
    const key = tasks.join(' ');
    if (!groups.has(key)) groups.set(key, { tasks, claims: [] });
    groups.get(key)!.claims.push(`${c.id} (${c.task_id ? `task ${c.task_id}` : 'no task'})`);
  }
  let left = MAX_NOTE_CLAIMS;
  let unnamed = 0;
  for (const { tasks, claims } of groups.values()) {
    if (left === 0) {
      unnamed += claims.length;
      continue;
    }
    const shown = capped(claims, left);
    left -= Math.min(left, claims.length);
    const them = claims.length === 1 ? 'it' : 'them';
    const list = andList(capped(tasks, MAX_NOTE_CLAIMS));
    const why = tasks.length > 0 ? ` while ${list} ${tasks.length === 1 ? 'is' : 'are'} in progress` : '';
    parts.push(`You still hold ${andList(shown)}${why}: release ${them} when you are done with ${them}${tasks.length > 0 ? `, or land ${list}` : ''}.`);
  }
  if (unnamed > 0) parts.push(`You also hold ${unnamed} more claim${unnamed === 1 ? '' : 's'}.`);
  return parts.join(' ');
}

/** The first `max` items, and how many more there are. */
function capped(items: string[], max: number): string[] {
  return items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : items;
}

function andList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function toConflict(c: Claim, files: string[]): ClaimConflict {
  return {
    claim_id: c.id,
    holder: c.holder,
    mode: c.mode,
    status: c.status,
    intent: c.intent,
    task_id: c.task_id,
    files: claimFiles(c).filter((f) => files.includes(f)),
    expires_at: c.expires_at,
    scope: c.scope.filter((s) => files.includes(s.file)),
    landing_id: null,
  };
}
