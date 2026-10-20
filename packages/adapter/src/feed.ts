import WebSocket from 'ws';
import type { FeedServerFrame, HeartbeatRequest, HubEvent } from '@agenthub/hub/protocol';
import type { HubClient } from './client.js';

export interface FeedOptions {
  /** Heartbeat period; defaults to what the hub announces in its hello frame. */
  heartbeatMs?: number;
  /** Presence info sent with every heartbeat. */
  info?: Omit<HeartbeatRequest, 'claim_ids'>;
  log?: (msg: string) => void;
}

const BUFFER_LIMIT = 1000;

/**
 * The adapter's live link to the hub, used by the long-running `hub mcp`
 * process:
 *  - keeps a WebSocket to the project feed open (reconnecting with backoff and
 *    replaying missed events by sequence number), buffering recent events for
 *    hub_wait;
 *  - sends a heartbeat every interval, over the socket when it's open and over
 *    HTTP otherwise, which renews every claim this agent holds. When this
 *    process dies the heartbeats stop and the hub expires the claims.
 */
export class Feed {
  lastSeq = 0;
  heartbeatsSent = 0;
  private ws: WebSocket | null = null;
  private open = false;
  private stopped = true;
  private buffer: HubEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 500;
  private reportedDown = false;
  private heartbeatMs: number;
  private readonly fixedHeartbeat: boolean;

  constructor(
    private readonly client: HubClient,
    private readonly opts: FeedOptions = {},
  ) {
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.fixedHeartbeat = opts.heartbeatMs !== undefined;
  }

  get connected(): boolean {
    return this.open;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.scheduleHeartbeat(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.terminate();
    this.ws = null;
    this.open = false;
    for (const w of this.waiters) w();
  }

  /** Wait for visible events after `since` that match `pred`. Resolves [] on timeout. */
  async waitFor(since: number, pred: (e: HubEvent) => boolean, timeoutMs: number): Promise<HubEvent[]> {
    if (!this.open) return this.longPoll(since, pred, timeoutMs);
    const hits = () => this.buffer.filter((e) => e.seq > since && pred(e));
    const now = hits();
    if (now.length) return now;
    return new Promise((resolve) => {
      const check = () => {
        const h = hits();
        if (h.length || this.stopped) finish(h);
      };
      const finish = (result: HubEvent[]) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(result);
      };
      const timer = setTimeout(() => finish(hits()), timeoutMs);
      this.waiters.add(check);
    });
  }

  private async longPoll(since: number, pred: (e: HubEvent) => boolean, timeoutMs: number): Promise<HubEvent[]> {
    const deadline = Date.now() + timeoutMs;
    let cursor = since;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return [];
      const { events } = await this.client.events(cursor, Math.min(remaining, 60_000));
      const hits = events.filter(pred);
      if (hits.length) return hits;
      if (events.length) cursor = events[events.length - 1].seq;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.client.feedUrl(this.lastSeq || undefined), { headers: this.client.headers() });
    this.ws = ws;
    ws.on('open', () => {
      this.open = true;
      this.backoffMs = 500;
      if (this.reportedDown) this.opts.log?.('hub feed reconnected');
      this.reportedDown = false;
    });
    ws.on('message', (raw) => {
      let frame: FeedServerFrame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === 'hello') {
        if (this.lastSeq === 0) this.lastSeq = frame.seq;
        if (!this.fixedHeartbeat && frame.heartbeat_interval_ms > 0) this.heartbeatMs = frame.heartbeat_interval_ms;
      } else if (frame.type === 'event' && frame.event.seq > this.lastSeq) {
        this.lastSeq = frame.event.seq;
        this.buffer.push(frame.event);
        if (this.buffer.length > BUFFER_LIMIT) this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
        for (const w of [...this.waiters]) w();
      } else if (frame.type === 'error') {
        this.opts.log?.(`hub feed error: ${frame.code}: ${frame.message}`);
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.open = false;
      }
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.reconnectTimer.unref();
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    });
    ws.on('error', (err) => {
      // Report an outage once, not on every reconnect attempt.
      if (!this.reportedDown) this.opts.log?.(`hub feed unavailable (${err.message}); heartbeats continue over HTTP, retrying`);
      this.reportedDown = true;
    });
  }

  private scheduleHeartbeat(delayMs: number): void {
    if (this.stopped) return;
    this.heartbeatTimer = setTimeout(() => void this.beat(), delayMs);
    this.heartbeatTimer.unref();
  }

  private async beat(): Promise<void> {
    try {
      if (this.ws && this.open) {
        this.ws.send(JSON.stringify({ type: 'heartbeat', ...this.opts.info }));
      } else {
        await this.client.heartbeat(this.opts.info ?? {});
      }
      this.heartbeatsSent++;
    } catch (err) {
      this.opts.log?.(`heartbeat failed: ${(err as Error).message}`);
    } finally {
      this.scheduleHeartbeat(this.heartbeatMs);
    }
  }
}
