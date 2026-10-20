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
import type { AgentTouch, Store } from './store.js';

export interface HubOptions {
  store: Store;
  /** Injectable clock for tests. */
  now?: () => number;
  /** How long a claim lives without a heartbeat. Default 2 minutes. */
  leaseTtlMs?: number;
  /** How often adapters are asked to heartbeat. Default 30 seconds. */
  heartbeatIntervalMs?: number;
  /** An agent counts as online if seen within this window. Default = lease TTL. */
  presenceTtlMs?: number;
}

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
const DAY_MS = 24 * 60 * 60 * 1000;

const LAND_NOTE =
  'Phase 1 records the landing request only; nothing was merged. Push or merge your branch the usual way. ' +
  'The task is marked done and its claims are released.';

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
  private readonly clock: () => number;
  private readonly listeners = new Set<(event: HubEvent) => void>();
  private pending: HubEvent[] | null = null;
  private txNow = 0;

  constructor(opts: HubOptions) {
    this.store = opts.store;
    this.clock = opts.now ?? Date.now;
    this.leaseTtlMs = opts.leaseTtlMs ?? 120_000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? Math.min(30_000, Math.max(1, Math.floor(this.leaseTtlMs / 4)));
    this.presenceTtlMs = opts.presenceTtlMs ?? this.leaseTtlMs;
  }

  now(): number {
    return this.clock();
  }

  /** Receive every committed event (all projects). Returns an unsubscribe function. */
  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------------------------------------------------------------- claims

  claim(project: string, agent: string, req: ClaimRequest): ClaimResult {
    assertAgent(agent);
    const scope = normalizeScope(req);
    const mode = req.mode ?? 'exclusive';
    if (mode !== 'exclusive' && mode !== 'shared' && mode !== 'auto') {
      throw new HubError('bad_request', 'mode must be exclusive, shared or auto');
    }
    const ttl = clampInt(req.ttl_ms, this.leaseTtlMs, 1, DAY_MS, 'ttl_ms');
    const heartbeat = clampInt(req.heartbeat_interval_ms, Math.min(this.heartbeatIntervalMs, Math.max(1, Math.floor(ttl / 3))), 1, ttl, 'heartbeat_interval_ms');
    const intentIn = cleanText(req.intent, MAX_INTENT);
    const baseCommit = cleanText(req.base_commit, 64) || null;

    return this.write(project, (now) => {
      this.touch(project, agent, now);
      // A claim request proves the agent is alive, so it renews every lease the
      // agent holds. Agents that only run the edit hook (no heartbeating MCP
      // server) keep the files they touched earlier in the session.
      this.renewLeases(project, agent, now);
      const files = unique(scope.map((s) => s.file));
      const live = this.store.claimsForFiles(project, files, ['active']);
      const mine = live.filter((c) => c.holder === agent);
      const others = live.filter((c) => c.holder !== agent);

      // A claim of mine covers a file if it includes it with a strong enough mode.
      const covers = (c: Claim, file: string) => hasFile(c, file) && (mode !== 'exclusive' || c.mode === 'exclusive');
      const covering = mine.filter((c) => files.some((f) => covers(c, f)));
      const uncovered = files.filter((f) => !mine.some((c) => covers(c, f)));
      if (uncovered.length === 0) {
        return { status: 'granted', claim: covering[0], claims: covering, renewed: true, conflicts: [], now, seq: this.store.latestSeq(project) };
      }

      const blocking = others.filter((c) => uncovered.some((f) => hasFile(c, f)));
      const effectiveMode: ClaimMode =
        mode === 'auto' ? (blocking.length > 0 && blocking.every((c) => c.mode === 'shared') ? 'shared' : 'exclusive') : mode;
      const conflicts = blocking.filter((c) => c.mode === 'exclusive' || effectiveMode === 'exclusive').map((c) => toConflict(c, uncovered));

      if (conflicts.length > 0 && !req.queue) {
        return { status: 'denied', claims: covering, renewed: covering.length > 0, conflicts, now, seq: this.store.latestSeq(project) };
      }

      const taskId = this.resolveTaskId(project, agent, req.task_id);
      const intent = intentIn || this.defaultIntent(project, taskId, uncovered);
      const claimScope = scope.filter((s) => uncovered.includes(s.file));

      if (conflicts.length > 0) {
        const queuedOnFiles = this.store.claimsForFiles(project, uncovered, ['queued']);
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
        }
        const ahead = queuedOnFiles.filter((q) => q.id !== claim.id && q.holder !== agent && claimOrderBefore(q, claim)).length;
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
  }

  release(project: string, agent: string, req: ReleaseRequest): ReleaseResult {
    assertAgent(agent);
    const files = req.files ? unique(req.files.map(normalizeRepoPath)) : undefined;
    if (!req.claim_id && !files?.length && !req.task_id && !req.all) {
      throw new HubError('bad_request', 'say what to release: claim_id, files, task_id or all');
    }
    return this.write(project, (now) => {
      let targets: Claim[];
      if (req.claim_id) {
        const c = this.store.getClaim(project, req.claim_id);
        if (!c) throw new HubError('not_found', `no claim ${req.claim_id}`, 404);
        if (c.holder !== agent) throw new HubError('forbidden', `${c.id} is held by ${c.holder}; only its holder can release it`, 403);
        targets = c.status === 'active' || c.status === 'queued' ? [c] : [];
      } else {
        targets = this.store.listClaims(project, { statuses: ['active', 'queued'], holder: agent, task_id: req.task_id });
        if (files) targets = targets.filter((c) => c.scope.some((s) => files.includes(s.file)));
      }

      const released: Claim[] = [];
      const trimmed: Claim[] = [];
      for (const c of targets) {
        const remaining = files && !req.claim_id ? c.scope.filter((s) => !files.includes(s.file)) : [];
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
    return this.write(project, (now) => {
      this.touch(project, agent, now, {
        client: cleanText(req.client, 64) || null,
        branch: cleanText(req.branch, 200) || null,
        worktree: cleanText(req.worktree, 500) || null,
      });
      const claims = this.renewLeases(project, agent, now, req.claim_ids);
      const next = claims.length ? Math.min(...claims.map((c) => c.heartbeat_interval_ms)) : this.heartbeatIntervalMs;
      return { renewed: claims.length, claims, next_heartbeat_ms: next, now, seq: this.store.latestSeq(project) };
    });
  }

  /** Active exclusive claims by anyone other than `agent` on these files (for the pre-commit guard). */
  check(project: string, agent: string | null, files: string[]): CheckResult {
    if (agent !== null) assertAgent(agent);
    const norm = unique(files.map(normalizeRepoPath));
    return this.read(project, (now) => {
      const live = this.store.claimsForFiles(project, norm, ['active']);
      const conflicts = live.filter((c) => c.holder !== agent && c.mode === 'exclusive').map((c) => toConflict(c, norm));
      return { conflicts, now, seq: this.store.latestSeq(project) };
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
      const blockedBy = this.blockedBy(project, task);
      if (blockedBy.length > 0) {
        const detail = blockedBy.map((d) => `${d} (${this.store.getTask(project, d)?.status ?? 'missing'})`).join(', ');
        throw new HubError('task_blocked', `${id} is blocked by ${detail}; it can be taken once those are done`, 409);
      }
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
    return this.write(project, (now) => {
      const taskId = req.task_id ? this.resolveTaskId(project, agent, req.task_id) : null;
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

  /** Phase 1 stub: records the request, marks the task done and releases its claims. */
  land(project: string, agent: string, req: LandRequest): LandResult {
    assertAgent(agent);
    return this.write(project, (now) => {
      let task: Task | null = null;
      let unblocked: string[] = [];
      if (req.task_id) {
        const t = this.store.getTask(project, req.task_id);
        if (!t) throw new HubError('not_found', `no task ${req.task_id}`, 404);
        if (t.owner && t.owner !== agent) throw new HubError('forbidden', `${t.id} is owned by ${t.owner}`, 403);
        const owner = t.owner ?? agent;
        if (t.status !== 'done') {
          this.store.updateTask(project, t.id, { status: 'done', owner, updated_at: now });
          this.emit(project, 'task.updated', agent, { task_id: t.id, status: 'done', previous: t.status });
          unblocked = this.announceUnblocked(project, t.id, agent);
        }
        task = this.withBlocked(project, { ...t, status: 'done', owner, updated_at: now });
      }
      const landing: Landing = {
        id: `L-${this.store.nextCounter(project, 'landing')}`,
        project,
        agent,
        task_id: task?.id ?? null,
        branch: cleanText(req.branch, 200) || null,
        commit: cleanText(req.commit, 64) || null,
        summary: cleanText(req.summary, MAX_LONG_TEXT, true),
        status: 'recorded',
        created_at: now,
      };
      this.store.insertLanding(landing);
      this.emit(project, 'land.requested', agent, { landing_id: landing.id, agent, task_id: landing.task_id, branch: landing.branch, commit: landing.commit });

      const released: Claim[] = [];
      if (req.release_claims !== false) {
        const mine = this.store.listClaims(project, { statuses: ['active', 'queued'], holder: agent, task_id: task?.id });
        for (const c of mine) released.push(this.endClaim(project, c, 'released', `landed ${landing.id}`, now));
        if (released.length) this.promoteQueued(project, now);
      }
      return { landing, task, released, unblocked, note: LAND_NOTE, now, seq: this.store.latestSeq(project) };
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
      };
    });
  }

  /** Committed events after `since` that `agent` may see. */
  events(project: string, agent: string | null, since: number, limit = 500): HubEvent[] {
    assertProject(project);
    return this.store.eventsSince(project, since, limit).filter((e) => isVisibleTo(e, agent));
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
    } finally {
      this.pending = null;
    }
    for (const event of pending) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // A failing subscriber must not affect the hub or other subscribers.
        }
      }
    }
    return result;
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
   * Grant queued claims in FIFO order. A queued claim is granted when no active
   * claim conflicts with it and no earlier, still-waiting claim does either,
   * so a later request can't overtake an earlier one for the same file.
   */
  private promoteQueued(project: string, now: number): Claim[] {
    const queued = this.store.listClaims(project, { statuses: ['queued'] });
    const promoted: Claim[] = [];
    const waiting: Claim[] = [];
    for (const q of queued) {
      const active = this.store.claimsForFiles(project, claimFiles(q), ['active']);
      if (active.some((a) => conflictsWith(a, q)) || waiting.some((w) => conflictsWith(w, q))) {
        waiting.push(q);
        continue;
      }
      const granted: Claim = { ...q, status: 'active', granted_at: now, expires_at: now + q.ttl_ms };
      this.store.updateClaim(project, q.id, { status: 'active', granted_at: now, expires_at: granted.expires_at });
      this.emit(project, 'claim.granted', q.holder, {
        claim_id: q.id,
        holder: q.holder,
        files: claimFiles(q),
        mode: q.mode,
        intent: q.intent,
        task_id: q.task_id,
        from_queue: true,
      });
      promoted.push(granted);
    }
    return promoted;
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

  private defaultIntent(project: string, taskId: string | null, files: string[]): string {
    const task = taskId ? this.store.getTask(project, taskId) : null;
    if (task) return task.title;
    return `edit ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;
  }

  private blockedBy(project: string, task: Pick<Task, 'deps'>): string[] {
    return task.deps.filter((d) => this.store.getTask(project, d)?.status !== 'done');
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
  s = s.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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

/** Phase 1 is file-level: any shared file counts as overlap, whatever the symbols. */
function conflictsWith(a: Claim, b: Claim): boolean {
  if (a.holder === b.holder) return false;
  if (a.mode === 'shared' && b.mode === 'shared') return false;
  return a.scope.some((s) => hasFile(b, s.file));
}

function claimOrderBefore(a: Claim, b: Claim): boolean {
  return a.created_at < b.created_at || (a.created_at === b.created_at && idNumber(a.id) < idNumber(b.id));
}

function idNumber(id: string): number {
  return Number(id.split('-')[1] ?? 0);
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
  };
}
