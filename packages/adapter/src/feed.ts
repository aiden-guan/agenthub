import WebSocket from 'ws';
import { humanOf } from '@agenthub/contract';
import { gitops } from '@agenthub/gitops';
import type { Claim, FeedServerFrame, HeartbeatRequest, HeartbeatResult, HubEvent, Landing } from '@agenthub/hub/protocol';
import { HubApiError, classifyFailure, type HubClient } from './client.js';
import { teamSections } from './config.js';
import { approversOf, claimFiles, inline, notices as noticeText } from './format.js';
import { fetchTrunk } from './sync.js';

export interface FeedOptions {
  /** Fixed heartbeat period. By default the feed follows the hub (see `periodMs`). */
  heartbeatMs?: number;
  /** Presence info sent with every heartbeat. */
  info?: Omit<HeartbeatRequest, 'claim_ids'>;
  log?: (msg: string) => void;
  /**
   * This agent's checkout: where trunk is fetched in the background when it
   * moves, and whose modified files a trunk.moved notice looks for. Without
   * one, those notices name held files only and nothing is fetched.
   */
  root?: string | null;
}

/** The hello frame. `epoch` names the hub's database; hubs older than it don't send one. */
type Hello = Extract<FeedServerFrame, { type: 'hello' }> & { epoch?: string };

export interface WaitResult {
  events: HubEvent[];
  /**
   * The hub's history restarted (a different database), which ended the wait:
   * the claims of the old database are gone, and `since` counted in it.
   */
  restarted: boolean;
}

const BUFFER_LIMIT = 1000;
const NOTICE_LIMIT = 50;
/** The background fetch of trunk on landing.landed and trunk.moved (design §2.3.4). */
const FETCH_TIMEOUT_MS = 10_000;
/**
 * However short an interval the hub announces, heartbeats don't come faster
 * than this: the shortest a hub hands out (25 ms, a third of its shortest
 * 100 ms lease, rounded down), so a lease that short still gets its heartbeats,
 * and an older hub that announces less can't make the feed flood it.
 */
const MIN_PERIOD_MS = 25;

const validMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * The adapter's live link to the hub, used by the long-running `hub mcp`
 * process:
 *  - keeps a WebSocket to the project feed open (reconnecting with backoff and
 *    replaying missed events by sequence number), buffering recent events for
 *    hub_wait. While the socket isn't open it follows the events by long-polling
 *    over HTTP instead. When the hub's database changes (a new `epoch`, or the
 *    sequence going back), the old events and claims are forgotten and waits end;
 *  - sends a heartbeat every period, over the socket when it's open and over
 *    HTTP otherwise, which renews every claim this agent holds. A socket that
 *    hasn't answered one heartbeat when the next is due is dropped, so a
 *    half-open connection can't swallow them. When this process dies the
 *    heartbeats stop and the hub expires the claims;
 *  - notes when one of this agent's leases is lost, for the next tool result.
 */
export class Feed {
  lastSeq = 0;
  /** `lastSeq` came from the hub (it may be 0, a database with no events yet); before that the feed starts from the hub's latest. */
  private synced = false;
  heartbeatsSent = 0;
  /** The hub database's id, from the last hello or long-poll answer; null before one or from a hub that doesn't send it. */
  epoch: string | null = null;
  /** How often the hub's history restarted (a different database) since this feed began. */
  restarts = 0;
  private ws: WebSocket | null = null;
  private open = false;
  /** The HTTP long-poll that stands in for the socket while it isn't open is running. */
  private following = false;
  private stopped = true;
  /** stop() was called: waits end. */
  private halted = false;
  private buffer: HubEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatDueAt = Infinity;
  private lastBeatAt = 0;
  private beating = false;
  /** When the oldest heartbeat the hub hasn't answered went out over the socket. */
  private askedAt: number | null = null;
  /** The hub renewed fewer claims than this process knows of: heartbeat over HTTP, whose answer lists them. */
  private reconcile = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 500;
  private reportedDown = false;
  private helloMs = 30_000;
  private ackMs: number | null = null;
  /** This agent's claims as far as this process knows, with their heartbeat interval when known. */
  private held = new Map<string, { files: string[]; interval: number | null }>();
  private readonly reportedLost = new Set<string>();
  /** For the next tool result; a landing notice names its landing and key, so showing that landing drops it (seenLanding). */
  private notices: Array<{ text: string; landing: string | null; key: string | null }> = [];
  /** Landings of this agent's, by id, as the landing events name them (so its own trunk.moved isn't news to it). */
  private readonly mine = new Set<string>();
  /** Landing notices already given (`landed:L-7`, `approval:L-9`, `trunk:<sha>`): each is said once. */
  private readonly noticed = new Set<string>();
  /** Landing notices the agent no longer needs: it was shown that landing in that state (seenLanding). */
  private readonly suppressed = new Set<string>();
  private fetching: Promise<void> | null = null;
  private fetchAgain = false;

  constructor(
    private readonly client: HubClient,
    private readonly opts: FeedOptions = {},
  ) {}

  get connected(): boolean {
    return this.open;
  }

  /**
   * The shortest of the hub's hello interval, the next_heartbeat_ms of its
   * latest answer and the interval of any claim this agent holds, unless fixed.
   */
  private get periodMs(): number {
    if (this.opts.heartbeatMs !== undefined) return this.opts.heartbeatMs;
    let ms = Math.min(this.helloMs, this.ackMs ?? Infinity);
    for (const c of this.held.values()) if (c.interval !== null) ms = Math.min(ms, c.interval);
    return Math.max(MIN_PERIOD_MS, ms);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = false;
    this.connect();
    void this.follow();
    this.scheduleHeartbeat(0);
  }

  stop(): void {
    this.stopped = true;
    this.halted = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
    this.ws = null;
    this.open = false;
    this.wake();
  }

  /** Claims this agent was just granted or queued for: heartbeat often enough for each of them. */
  noteClaims(claims: Claim[]): void {
    for (const c of claims) {
      if (c.holder === this.client.cfg.agent && (c.status === 'active' || c.status === 'queued')) {
        this.held.set(c.id, { files: claimFiles(c), interval: c.heartbeat_interval_ms });
      }
    }
    this.tighten();
  }

  /** What the agent must hear about its claims since the last call: leases that ran out, a hub that lost them. */
  takeNotices(): string[] {
    return this.notices.splice(0).map((n) => n.text);
  }

  /**
   * Wait for visible events after `since` that match `pred`; none on timeout.
   * A running feed reads its buffer, which the socket fills or, while it is
   * down, the feed's long-poll; one never started long-polls here. Ends early
   * when the hub's history restarts after the count of `restarts` (default: now).
   */
  async waitFor(since: number, pred: (e: HubEvent) => boolean, timeoutMs: number, restarts = this.restarts): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    let cursor = since;
    // The first poll after the hub went away answers at once, so a hub back on a fresh database shows at once.
    let probe = true;
    for (;;) {
      if (this.restarts !== restarts) return { events: [], restarted: true };
      if (this.halted) return { events: this.buffer.filter((e) => e.seq > cursor && pred(e)), restarted: false };
      const remaining = deadline - Date.now();
      if (!this.stopped) {
        const hits = this.buffer.filter((e) => e.seq > cursor && pred(e));
        if (hits.length || remaining <= 0) return { events: hits, restarted: false };
        await this.nap(remaining);
        continue;
      }
      if (remaining <= 0) return { events: [], restarted: false };
      let page: Awaited<ReturnType<Feed['poll']>>;
      try {
        page = await this.poll(cursor, probe ? 0 : Math.min(remaining, 60_000));
      } catch (err) {
        if (classifyFailure(err, this.client.cfg).kind !== 'unreachable') throw err;
        await this.nap(Math.min(remaining, 1000)); // down for now: ask again
        probe = true;
        continue;
      }
      probe = false;
      if (!page) continue; // a different database
      const hits = page.events.filter(pred);
      if (hits.length) return { events: hits, restarted: false };
      cursor = page.next;
    }
  }

  /**
   * One long-poll from `cursor` (from now when there is none): the events and
   * the cursor past them, or null when the hub's database changed (its history is reset then).
   */
  private async poll(cursor: number | undefined, waitMs: number, signal?: AbortSignal): Promise<{ events: HubEvent[]; next: number } | null> {
    const page = await this.client.events(cursor, waitMs, signal);
    // A different database: a new epoch, or a history that ends before `cursor`, which a live one
    // never does: the same database restored from a backup keeps its epoch but goes back.
    const otherDatabase = (page.epoch !== undefined && this.epoch !== null && page.epoch !== this.epoch) || (cursor !== undefined && page.seq < cursor);
    if (page.epoch !== undefined) this.epoch = page.epoch;
    if (otherDatabase) {
      this.resetHistory(page.seq);
      return null;
    }
    return { events: page.events, next: page.next_since ?? page.events[page.events.length - 1]?.seq ?? cursor ?? page.seq };
  }

  /**
   * While the socket isn't open (down, reconnecting, or never connecting),
   * follow the events by long-polling over HTTP, so waits still wake and a
   * claim this agent makes elsewhere (the edit hook) is heard, and heartbeated,
   * before its lease runs out. Ends when the socket opens or the feed stops.
   */
  private async follow(): Promise<void> {
    if (this.following) return;
    this.following = true;
    // The first poll after the socket or the hub went away answers at once, so a hub back on a fresh database shows at once.
    let probe = true;
    let failures = 0;
    try {
      while (!this.stopped && !this.open) {
        // The socket opening (or the feed stopping) makes the poll moot.
        const moot = new AbortController();
        const stop = () => moot.abort();
        this.waiters.add(stop);
        const got = await this.poll(this.synced ? this.lastSeq : undefined, probe ? 0 : 60_000, moot.signal).then(
          (page) => ({ page }),
          (err: unknown) => ({ err }),
        );
        this.waiters.delete(stop);
        if (moot.signal.aborted) continue;
        if ('err' in got) {
          const failure = classifyFailure(got.err, this.client.cfg);
          // Down for now: ask again soon. A refusal is reported once and asked again less and less often.
          if (failure.kind !== 'unreachable' && failures === 0) this.opts.log?.(`hub event poll failed: ${failure.message}`);
          failures++;
          probe = true;
          await this.nap(failure.kind === 'unreachable' ? 1000 : Math.min(500 * 2 ** failures, 15_000));
          continue;
        }
        probe = false;
        failures = 0;
        if (!got.page) continue; // a different database
        for (const e of got.page.events) this.ingest(e);
        this.lastSeq = Math.max(this.lastSeq, got.page.next);
        this.synced = true;
      }
    } finally {
      this.following = false;
    }
  }

  /** Sleep until something changes (an event, the socket opening, a different database, a stop) or `ms` passes. */
  private nap(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  private connect(): void {
    if (this.stopped) return;
    const since = this.synced ? this.lastSeq : undefined;
    const ws = new WebSocket(this.client.feedUrl(since), { headers: this.client.headers() });
    this.ws = ws;
    ws.on('message', (raw) => {
      if (this.ws !== ws) return;
      let frame: FeedServerFrame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === 'hello') {
        this.onHello(frame, since);
      } else if (frame.type === 'event') {
        this.ingest(frame.event);
      } else if (frame.type === 'replayed') {
        // Past the events of the replay this agent can't see, so the next reconnect doesn't read them again.
        if (typeof frame.next_since === 'number' && frame.next_since > this.lastSeq) this.lastSeq = frame.next_since;
      } else if (frame.type === 'heartbeat.ack') {
        this.askedAt = null;
        if (validMs(frame.next_heartbeat_ms)) this.ackMs = frame.next_heartbeat_ms;
        if (typeof frame.renewed === 'number' && frame.renewed < this.held.size) this.reconcile = true;
        this.tighten();
      } else if (frame.type === 'error') {
        this.askedAt = null; // the hub read the heartbeat, it just refused it
        this.opts.log?.(`hub feed error: ${frame.code}: ${frame.message}`);
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return; // dropped on purpose, or stopped
      const wasOpen = this.open;
      this.ws = null;
      this.open = false;
      this.askedAt = null;
      if (this.stopped) return;
      if (wasOpen) {
        this.opts.log?.('hub feed connection lost; heartbeats continue over HTTP, reconnecting');
        this.reportedDown = true;
      }
      void this.follow();
      this.reconnectLater();
    });
    ws.on('error', (err) => {
      if (this.open && this.ws === ws) return; // 'close' reports it
      // Report an outage once, not on every reconnect attempt.
      if (!this.reportedDown) this.opts.log?.(`hub feed unavailable (${err.message}); heartbeats continue over HTTP, retrying`);
      this.reportedDown = true;
    });
  }

  private onHello(hello: Hello, since: number | undefined): void {
    if (validMs(hello.heartbeat_interval_ms)) this.helloMs = hello.heartbeat_interval_ms;
    const newDatabase = (hello.epoch !== undefined && this.epoch !== null && hello.epoch !== this.epoch) || hello.seq < this.lastSeq;
    if (hello.epoch !== undefined) this.epoch = hello.epoch;
    this.backoffMs = 500;
    if (newDatabase) this.resetHistory(hello.seq);
    else if (!this.synced) this.lastSeq = hello.seq;
    this.synced = true;
    // A socket opened at a cursor from the old database, past where this one stands, would skip its events up to there.
    if (since !== undefined && since > hello.seq) return this.dropSocket(0);
    this.open = true;
    if (this.reportedDown) this.opts.log?.('hub feed reconnected');
    this.reportedDown = false;
    this.wake();
    this.tighten();
  }

  /** A new event from the socket or the long-poll: buffer it for waits and keep up with this agent's claims. */
  private ingest(e: HubEvent): void {
    if (e.seq <= this.lastSeq) return;
    this.lastSeq = e.seq;
    this.buffer.push(e);
    if (this.buffer.length > BUFFER_LIMIT) this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
    this.track(e);
    this.landingNotices(e);
    this.wake();
  }

  /** The hub's database is not the one this feed followed: forget its events and this agent's claims there; waits end. */
  private resetHistory(seq: number): void {
    this.opts.log?.(`hub event history restarted (a different database); following it from seq ${seq}`);
    this.buffer = [];
    this.lastSeq = seq;
    this.synced = true;
    this.restarts++;
    this.ackMs = null;
    if (this.held.size > 0) {
      const gone = [...this.held].map(([id, c]) => `${id} (${c.files.join(', ')})`).join(', ');
      this.notice(`the hub at ${this.client.cfg.url} came back with a different database, so the claims this session held there are gone: ${gone}. Claim again any files you still need.`);
    }
    this.held.clear();
    this.reportedLost.clear();
    this.wake();
  }

  /** Give up on the socket (it stopped answering, or it was opened at a stale cursor) and connect again. */
  private dropSocket(delayMs?: number): void {
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    this.askedAt = null;
    ws?.terminate();
    void this.follow();
    this.reconnectLater(delayMs);
  }

  private reconnectLater(delayMs = this.backoffMs): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
    this.reconnectTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
  }

  /** Keep `held` in step with this agent's claim events, and note the ones whose lease ran out. */
  private track(e: HubEvent): void {
    const d = e.data as Record<string, unknown>;
    const id = d.claim_id;
    if (typeof id !== 'string' || d.holder !== this.client.cfg.agent) return;
    const files = Array.isArray(d.files) ? d.files.filter((f): f is string => typeof f === 'string') : [];
    const known = this.held.get(id);
    if (e.type === 'claim.granted' || e.type === 'claim.queued') {
      this.held.set(id, { files: [...new Set([...(known?.files ?? []), ...files])], interval: known?.interval ?? null });
      // A claim made elsewhere (the edit hook): heartbeat now, and the answer says how often it needs one.
      if (!known) this.beatSoon();
    } else if (e.type === 'claim.released') {
      if (!d.partial) this.held.delete(id);
      else if (known) known.files = known.files.filter((f) => !files.includes(f));
    } else if (e.type === 'claim.expired') {
      this.lost(id, files, typeof d.reason === 'string' ? d.reason : null, d.was === 'queued');
    }
  }

  /** An HTTP heartbeat's answer lists every claim of this agent's it renewed; one missing was released or lost. */
  private onHeartbeat(r: HeartbeatResult): void {
    if (validMs(r.next_heartbeat_ms)) this.ackMs = r.next_heartbeat_ms;
    const before = this.held;
    this.held = new Map(r.claims.map((c) => [c.id, { files: claimFiles(c), interval: c.heartbeat_interval_ms }]));
    for (const [id, entry] of before) if (!this.held.has(id)) void this.checkGone(id, entry);
  }

  private async checkGone(id: string, entry: { files: string[]; interval: number | null }): Promise<void> {
    let c: Claim;
    try {
      c = await this.client.getClaim(id);
    } catch (err) {
      // Unknown to the hub: its database changed while this feed couldn't see its epoch.
      if (err instanceof HubApiError && err.status === 404) return this.lost(id, entry.files, 'the hub no longer has it', false, 'is gone');
      if (!this.held.has(id)) this.held.set(id, entry); // ask again after the next heartbeat
      return;
    }
    if (c.holder !== this.client.cfg.agent) return this.lost(id, entry.files, 'the hub no longer has it', false, 'is gone');
    if (c.status === 'expired') this.lost(c.id, claimFiles(c), c.end_reason, c.granted_at === null);
    else if (c.status === 'active' || c.status === 'queued') this.noteClaims([c]); // made while that heartbeat was on its way
  }

  private lost(id: string, files: string[], reason: string | null, queued: boolean, ended = 'expired'): void {
    this.held.delete(id);
    if (this.reportedLost.has(id)) return;
    this.reportedLost.add(id);
    const what = `${id} (${files.join(', ')})`;
    const why = inline(reason) || 'lease expired';
    this.notice(
      queued
        ? `your queued claim ${what} ${ended} (${why}) and lost its place in the queue. Claim again to queue anew.`
        : `your claim ${what} ${ended} (${why}), so other agents can claim those files now. Claim them again before you edit them.`,
      `lost claim ${what}: ${reason ?? ended}`,
    );
  }

  private notice(text: string, logLine = text, about: { landing: string; key: string } | null = null): void {
    if (about && this.suppressed.has(about.key)) return;
    this.opts.log?.(logLine);
    if (this.notices.length < NOTICE_LIMIT) this.notices.push({ text, landing: about?.landing ?? null, key: about?.key ?? null });
  }

  /**
   * The agent was just shown landing `l` as it is now (hub_wait, landing_status,
   * land_cancel): its pending notices go, and the state it was shown in is
   * not announced again when its event comes in afterwards.
   */
  seenLanding(l: Pick<Landing, 'id' | 'status' | 'in_doubt'>): void {
    this.notices = this.notices.filter((n) => n.landing !== l.id);
    const kinds: Partial<Record<Landing['status'], string[]>> = {
      landed: ['landed'],
      failed: ['failed'],
      cancelled: ['cancelled'],
      needs_approval: ['parked'],
      running: l.in_doubt ? ['in_doubt'] : [],
    };
    for (const k of kinds[l.status] ?? []) {
      this.noticed.add(`${k}:${l.id}`);
      this.suppressed.add(`${k}:${l.id}`);
    }
  }

  /**
   * Phase 2 notices (design §2.3.4), for the next tool result: this agent's
   * landings landing, coming back, parking for an approval, going in doubt or
   * being cancelled by someone else; an approval this agent's human may give;
   * trunk moving under files this agent holds or has modified. On
   * landing.landed and trunk.moved, trunk is also fetched in the background,
   * which only updates its remote-tracking ref, so hooks compare against a
   * fresh trunk without network calls. Event data carries no agent-written
   * text (§1.8): the notices quote codes and ids only.
   */
  private landingNotices(e: HubEvent): void {
    const me = this.client.cfg.agent;
    if (!me) return;
    const d = e.data as Record<string, unknown>;
    if (e.type === 'landing.landed' || e.type === 'trunk.moved') this.fetchTrunkSoon();
    const id = typeof d.landing_id === 'string' ? d.landing_id : null;
    if (!id && e.type !== 'trunk.moved') return;
    const own = d.agent === me;
    if (own && id) this.mine.add(id);
    const once = (key: string, text: () => string | null) => {
      if (this.noticed.has(key)) return;
      const t = text();
      if (t === null) return;
      this.noticed.add(key);
      this.notice(t, t, id ? { landing: id, key } : null);
    };
    if (own) {
      if (e.type === 'landing.landed') once(`landed:${id}`, () => noticeText.landed(d, this.trunkName()));
      else if (e.type === 'landing.failed') once(`failed:${id}`, () => noticeText.failed(d));
      else if (e.type === 'landing.updated' && d.reason === 'in_doubt') once(`in_doubt:${id}`, () => noticeText.inDoubt(d));
      else if (e.type === 'landing.updated' && d.reason === 'cancelled' && e.actor !== me) once(`cancelled:${id}`, () => noticeText.cancelled(d, e.actor ?? ''));
      else if (e.type === 'landing.needs_approval' && d.parked === true) this.later(`parked:${id}`, id, async () => {
        const l = await this.landingOf(id!);
        const pending = l ? [...new Set(l.approval.flatMap((r) => r.paths))].sort() : paths(d);
        return noticeText.parked(d, pending.length ? pending : paths(d), l ? approversOf(l.approval, l.agent) : null);
      });
    } else if (e.type === 'landing.needs_approval') {
      // Whether this agent's human may give it: the rules of the requirements still pending, the author's own human left out where a rule says distinct.
      this.later(`approval:${id}`, id, async () => {
        const l = await this.landingOf(id!);
        const human = humanOf(me);
        if (!l || l.agent === me) return null;
        const may = l.approval.some((r) => r.rules.some((rule) => (rule.approvers === null || rule.approvers.includes(human)) && !(rule.distinct && humanOf(l.agent) === human)));
        return may ? noticeText.relay(d, [...new Set(l.approval.flatMap((r) => r.paths))].sort(), human) : null;
      });
    } else if (e.type === 'trunk.moved' && !(id && this.mine.has(id))) {
      const files = Array.isArray(d.files) ? d.files.filter((f): f is string => typeof f === 'string') : [];
      if (files.length === 0) return;
      this.later(`trunk:${String(d.to)}`, null, async () => {
        const held = new Set([...this.held.values()].flatMap((c) => c.files));
        const modified = await this.modifiedFiles();
        const h = files.filter((f) => held.has(f));
        const m = files.filter((f) => !held.has(f) && modified.has(f));
        return h.length || m.length ? noticeText.trunkMoved(d, h, m) : null;
      });
    }
  }

  /** A notice that needs a hub or git call first; said once per key, best effort. */
  private later(key: string, landing: string | null, make: () => Promise<string | null>): void {
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    void make().then(
      (t) => {
        if (t !== null && !this.halted) this.notice(t, t, landing ? { landing, key } : null);
      },
      (err: unknown) => this.opts.log?.(`notice ${key} failed: ${(err as Error).message}`),
    );
  }

  private async landingOf(id: string): Promise<Landing | null> {
    try {
      return await this.client.landing(id);
    } catch {
      return null;
    }
  }

  /** The trunk branch's name, from trunk's agenthub.json (lenient). */
  private trunkName(): string {
    return this.landConfig()?.trunk ?? 'main';
  }

  private landConfig() {
    if (!this.opts.root) return null;
    try {
      return teamSections(this.opts.root, { strict: false }).sections.land;
    } catch {
      return null;
    }
  }

  /** Files this checkout changed: committed since its merge base with trunk, and uncommitted tracked changes. */
  private async modifiedFiles(): Promise<Set<string>> {
    const out = new Set<string>();
    const land = this.landConfig();
    if (!this.opts.root || !land) return out;
    const g = gitops.open(this.opts.root, { isolated: false });
    try {
      const base = await gitops.mergeBase(g, 'HEAD', `refs/remotes/${land.remote}/${land.trunk}`);
      if (base) for (const f of await gitops.diffNames(g, base, 'HEAD')) out.add(f);
    } catch {
      // no trunk fetched yet, or no commits: the uncommitted changes still count
    }
    try {
      const st = (await g.run(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no'])).stdout.split('\0');
      for (let i = 0; i < st.length; i++) {
        const rec = st[i];
        if (rec.length < 4) continue;
        out.add(rec.slice(3).normalize('NFC'));
        if (rec[0] === 'R' || rec[0] === 'C') out.add((st[++i] ?? '').normalize('NFC'));
      }
    } catch {
      // git failed: the committed changes are what we know
    }
    return out;
  }

  /** `git fetch` of trunk into its remote-tracking ref, in the background, one at a time (a request meanwhile runs once more after). */
  private fetchTrunkSoon(): void {
    if (!this.opts.root || this.halted) return;
    if (this.fetching) {
      this.fetchAgain = true;
      return;
    }
    const root = this.opts.root;
    this.fetching = (async () => {
      do {
        this.fetchAgain = false;
        const land = this.landConfig();
        if (!land) break;
        const error = await fetchTrunk(gitops.open(root, { isolated: false }), land.remote, land.trunk, FETCH_TIMEOUT_MS);
        if (error) this.opts.log?.(`background fetch of ${land.trunk} failed: ${error}`);
      } while (this.fetchAgain && !this.halted);
    })().finally(() => {
      this.fetching = null;
    });
  }

  private scheduleHeartbeat(delayMs: number): void {
    if (this.stopped) return;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatDueAt = Date.now() + delayMs;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      this.beating = true;
      // After I/O that is already waiting, so an ack held up by a busy event loop still counts.
      setImmediate(() => void this.beat());
    }, delayMs);
    this.heartbeatTimer.unref();
  }

  private beatSoon(): void {
    if (!this.stopped && !this.beating && this.heartbeatTimer !== null) this.scheduleHeartbeat(0);
  }

  /** Bring the next heartbeat forward when the period just got shorter. */
  private tighten(): void {
    if (this.stopped || this.beating || this.heartbeatTimer === null) return;
    const due = this.lastBeatAt + this.periodMs;
    if (due < this.heartbeatDueAt) this.scheduleHeartbeat(Math.max(0, due - Date.now()));
  }

  private async beat(): Promise<void> {
    if (this.stopped) return;
    this.lastBeatAt = Date.now();
    try {
      if (this.ws && this.open && this.askedAt !== null && Date.now() - this.askedAt >= this.periodMs / 2) {
        // A heartbeat is still unanswered when the next is due: the path is dead even if TCP hasn't noticed.
        this.opts.log?.('hub feed stopped answering heartbeats; reconnecting, heartbeats continue over HTTP');
        this.reportedDown = true;
        this.dropSocket();
      }
      if (this.ws && this.open && !this.reconcile) {
        // Overdue after half the period as it is then (it may have shrunk since), so the next regular beat
        // always finds an unanswered one overdue and one brought forward right after doesn't.
        this.askedAt ??= Date.now();
        this.ws.send(JSON.stringify({ type: 'heartbeat', ...this.opts.info }));
      } else {
        this.reconcile = false;
        this.onHeartbeat(await this.client.heartbeat(this.opts.info ?? {}));
      }
      this.heartbeatsSent++;
    } catch (err) {
      this.opts.log?.(`heartbeat failed: ${(err as Error).message}`);
    } finally {
      this.beating = false;
      this.scheduleHeartbeat(Math.max(0, this.lastBeatAt + this.periodMs - Date.now()));
    }
  }
}

function paths(d: Record<string, unknown>): string[] {
  return Array.isArray(d.paths) ? d.paths.filter((p): p is string => typeof p === 'string') : [];
}
