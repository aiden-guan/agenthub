import WebSocket from 'ws';
import type { Claim, FeedServerFrame, HeartbeatRequest, HeartbeatResult, HubEvent } from '@agenthub/hub/protocol';
import { HubApiError, classifyFailure, type HubClient } from './client.js';
import { claimFiles, inline } from './format.js';

export interface FeedOptions {
  /** Fixed heartbeat period. By default the feed follows the hub (see `periodMs`). */
  heartbeatMs?: number;
  /** Presence info sent with every heartbeat. */
  info?: Omit<HeartbeatRequest, 'claim_ids'>;
  log?: (msg: string) => void;
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
/** However short a claim's interval, heartbeats don't come faster than this. */
const MIN_PERIOD_MS = 100;

const validMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * The adapter's live link to the hub, used by the long-running `hub mcp`
 * process:
 *  - keeps a WebSocket to the project feed open (reconnecting with backoff and
 *    replaying missed events by sequence number), buffering recent events for
 *    hub_wait. When the hub's database changes (a new `epoch`, or the sequence
 *    going back), the old events and claims are forgotten and waits end;
 *  - sends a heartbeat every period, over the socket when it's open and over
 *    HTTP otherwise, which renews every claim this agent holds. A socket that
 *    hasn't answered one heartbeat when the next is due is dropped, so a
 *    half-open connection can't swallow them. When this process dies the
 *    heartbeats stop and the hub expires the claims;
 *  - notes when one of this agent's leases is lost, for the next tool result.
 */
export class Feed {
  lastSeq = 0;
  heartbeatsSent = 0;
  /** The hub database's id, from the last hello or long-poll answer; null before one or from a hub that doesn't send it. */
  epoch: string | null = null;
  /** How often the hub's history restarted (a different database) since this feed began. */
  restarts = 0;
  private ws: WebSocket | null = null;
  private open = false;
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
  private notices: string[] = [];

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
    return this.notices.splice(0);
  }

  /**
   * Wait for visible events after `since` that match `pred`; none on timeout.
   * Reads the buffer while the socket is open and long-polls over HTTP while
   * it isn't, switching as the socket comes and goes. Ends early when the
   * hub's history restarts after the count of `restarts` (default: now).
   */
  async waitFor(since: number, pred: (e: HubEvent) => boolean, timeoutMs: number, restarts = this.restarts): Promise<WaitResult> {
    const deadline = Date.now() + timeoutMs;
    let cursor = since;
    // The first poll after the socket or the hub went away answers at once, so a hub back on a fresh database shows at once.
    let probe = true;
    for (;;) {
      if (this.restarts !== restarts) return { events: [], restarted: true };
      if (this.halted) return { events: this.buffer.filter((e) => e.seq > cursor && pred(e)), restarted: false };
      const remaining = deadline - Date.now();
      if (this.open) {
        const hits = this.buffer.filter((e) => e.seq > cursor && pred(e));
        if (hits.length || remaining <= 0) return { events: hits, restarted: false };
        await this.nap(remaining);
        probe = true;
        continue;
      }
      if (remaining <= 0) return { events: [], restarted: false };
      let page: Awaited<ReturnType<HubClient['events']>>;
      // The socket opening (or closing, or the feed stopping) makes this poll moot.
      const moot = new AbortController();
      const stop = () => moot.abort();
      this.waiters.add(stop);
      try {
        page = await this.client.events(cursor, probe ? 0 : Math.min(remaining, 60_000), moot.signal);
      } catch (err) {
        if (moot.signal.aborted) continue;
        if (classifyFailure(err, this.client.cfg).kind !== 'unreachable') throw err;
        await this.nap(Math.min(remaining, 1000)); // down for now: ask again, or use the socket once it's back
        probe = true;
        continue;
      } finally {
        this.waiters.delete(stop);
      }
      probe = false;
      if (this.restarts !== restarts) continue; // the socket's hello saw it first
      // A different database: a new epoch or, without two epochs to compare, a history that ends before `cursor` (it never goes back).
      const otherDatabase = page.epoch !== undefined && this.epoch !== null ? page.epoch !== this.epoch : page.seq < cursor;
      if (page.epoch !== undefined) this.epoch = page.epoch;
      if (otherDatabase) {
        this.resetHistory(page.seq);
        continue;
      }
      const hits = page.events.filter(pred);
      if (hits.length) return { events: hits, restarted: false };
      cursor = page.next_since ?? page.events[page.events.length - 1]?.seq ?? cursor;
    }
  }

  /** Sleep until something changes (an event, the socket opening or closing, a stop) or `ms` passes. */
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
    const since = this.lastSeq || undefined;
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
      } else if (frame.type === 'event' && frame.event.seq > this.lastSeq) {
        this.lastSeq = frame.event.seq;
        this.buffer.push(frame.event);
        if (this.buffer.length > BUFFER_LIMIT) this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
        this.track(frame.event);
        this.wake();
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
      if (wasOpen) this.wake(); // waits switch to HTTP (one that never opened changes nothing for them)
      if (this.stopped) return;
      if (wasOpen) {
        this.opts.log?.('hub feed connection lost; heartbeats continue over HTTP, reconnecting');
        this.reportedDown = true;
      }
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
    else if (this.lastSeq === 0) this.lastSeq = hello.seq;
    // A socket opened at a cursor from the old database, past where this one stands, would skip its events up to there.
    if (since !== undefined && since > hello.seq) return this.dropSocket(0);
    this.open = true;
    if (this.reportedDown) this.opts.log?.('hub feed reconnected');
    this.reportedDown = false;
    this.wake();
    this.tighten();
  }

  /** The hub's database is not the one this feed followed: forget its events and this agent's claims there. */
  private resetHistory(seq: number): void {
    this.opts.log?.(`hub event history restarted (a different database); following it from seq ${seq}`);
    this.buffer = [];
    this.lastSeq = seq;
    this.restarts++;
    this.ackMs = null;
    if (this.held.size > 0) {
      const gone = [...this.held].map(([id, c]) => `${id} (${c.files.join(', ')})`).join(', ');
      this.notice(`the hub at ${this.client.cfg.url} came back with a different database, so the claims this session held there are gone: ${gone}. Claim again any files you still need.`);
    }
    this.held.clear();
    this.reportedLost.clear();
  }

  /** Give up on the socket (it stopped answering, or it was opened at a stale cursor) and connect again. */
  private dropSocket(delayMs?: number): void {
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    this.askedAt = null;
    ws?.terminate();
    this.wake();
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

  private notice(text: string, logLine = text): void {
    this.opts.log?.(logLine);
    if (this.notices.length < NOTICE_LIMIT) this.notices.push(text);
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
