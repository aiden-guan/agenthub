// HubPort over HTTP (design §1.7): the lander's routes, plus the claims and
// heartbeat its lease is made of, direct messages, the reads its reports need
// and the long-poll it idles on. Every call carries the lander's agent id, the
// bearer token and the lander token; every failure becomes a HubCallError
// with the hub's code (or `unavailable`, `bad_response`, `aborted`).

import type {
  Claim,
  ClaimRequest,
  ClaimResult,
  Decision,
  EventsResult,
  HeartbeatRequest,
  HeartbeatResult,
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
  Message,
  ReleaseRequest,
  ReleaseResult,
  StatusResult,
  Task,
  TrunkReportRequest,
} from '@agenthub/hub/protocol';
import { HubCallError, type EventsQuery, type HubPort, type LandingsFilter } from './ports.js';

export interface HubClientConfig {
  /** The hub's base URL, e.g. http://127.0.0.1:7077. */
  url: string;
  project: string;
  /** The lander process's own agent id (lander/<host>-<pid>-<4 hex>), sent as x-hub-agent. */
  agent: string;
  /** The Phase 1 bearer token (HUB_TOKEN). */
  token?: string | null;
  /** x-hub-lander-token (HUB_LANDER_TOKEN): required by a hub on a network address. */
  landerToken?: string | null;
  /** Per request; a long-poll adds its wait to it. Default 15 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Slack on top of a long-poll's wait before the client gives up on the answer. */
const LONG_POLL_SLACK_MS = 5_000;

export class HubClient implements HubPort {
  readonly url: string;
  readonly project: string;
  readonly agent: string;
  readonly timeoutMs: number;
  // Private fields: never printed with the client, never serialized.
  readonly #token: string | null;
  readonly #landerToken: string | null;

  constructor(cfg: HubClientConfig) {
    this.url = cfg.url.replace(/\/+$/, '');
    this.project = cfg.project;
    this.agent = cfg.agent;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#token = cfg.token || null;
    this.#landerToken = cfg.landerToken || null;
  }

  private get base(): string {
    return `${this.url}/v1/p/${encodeURIComponent(this.project)}`;
  }

  private headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = { 'x-hub-agent': this.agent };
    if (this.#token) h.authorization = `Bearer ${this.#token}`;
    if (this.#landerToken) h['x-hub-lander-token'] = this.#landerToken;
    if (withBody) h['content-type'] = 'application/json';
    return h;
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const timeoutMs = o.timeoutMs ?? this.timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;
    const noAnswer = (err: unknown): HubCallError => {
      if (o.signal?.aborted) return new HubCallError('aborted', null, `${method} ${path} was aborted`);
      const e = err as Error;
      const reason = e.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : ((e.cause as Error | undefined)?.message ?? e.message);
      return new HubCallError('unavailable', null, `hub at ${this.url} is unreachable (${reason})`);
    };
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method, headers: this.headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (err) {
      throw noAnswer(err);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // The connection dropped mid-answer: a 4xx is still a refusal.
      if (res.status >= 400 && res.status < 500) throw new HubCallError('http_error', res.status, `HTTP ${res.status}`);
      throw noAnswer(err);
    }
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new HubCallError('bad_response', res.status, `hub at ${this.url} sent a non-JSON response (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const e = data && typeof data === 'object' ? data.error : undefined;
      const details = e && typeof e.details === 'object' && e.details !== null && !Array.isArray(e.details) ? (e.details as Record<string, unknown>) : undefined;
      throw new HubCallError(typeof e?.code === 'string' ? e.code : 'http_error', res.status, typeof e?.message === 'string' ? e.message : `HTTP ${res.status}`, details);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HubCallError('bad_response', res.status, `hub at ${this.url} sent ${JSON.stringify(data)?.slice(0, 40)} instead of an object`);
    return data as T;
  }

  /** The value under `key` of a hub answer; a missing one means the answer isn't the hub's. */
  private async unwrap<T>(key: string, p: Promise<Record<string, unknown>>): Promise<T> {
    const data = await p;
    if (!(key in data)) throw new HubCallError('bad_response', 200, `hub answer has no "${key}"`);
    return data[key] as T;
  }

  private id(s: string): string {
    return encodeURIComponent(s);
  }

  // ---- the lease (an ordinary claim on LANDER_LEASE_KEY)

  claim(req: ClaimRequest): Promise<ClaimResult> {
    return this.request('POST', '/claims', req);
  }
  getClaim(id: string): Promise<Claim> {
    return this.unwrap('claim', this.request('GET', `/claims/${this.id(id)}`));
  }
  heartbeat(req: HeartbeatRequest = {}): Promise<HeartbeatResult> {
    return this.request('POST', '/heartbeat', req);
  }
  release(req: ReleaseRequest): Promise<ReleaseResult> {
    return this.request('POST', '/claims/release', req);
  }

  // ---- lander routes (fenced by the lease in each request)

  next(req: LanderNextRequest): Promise<LanderNextResult> {
    return this.request('POST', '/lander/next', req);
  }
  admit(id: string, req: LandingAdmitRequest): Promise<LandingAdmitResult> {
    return this.request('POST', `/landings/${this.id(id)}/admit`, req);
  }
  advance(id: string, req: LandingAdvanceRequest): Promise<LandingAdvanceResult> {
    return this.request('POST', `/landings/${this.id(id)}/advance`, req);
  }
  resolve(id: string, req: LandingResolveRequest): Promise<LandingAdvanceResult> {
    return this.request('POST', `/landings/${this.id(id)}/resolve`, req);
  }
  reportTrunk(req: TrunkReportRequest): Promise<{ control: LanderControl }> {
    return this.request('POST', '/lander/trunk', req);
  }
  pause(req: LanderPauseRequest): Promise<{ control: LanderControl }> {
    return this.request('POST', '/lander/pause', req);
  }
  lander(): Promise<{ lease: LanderInfo | null; control: LanderControl }> {
    return this.request('GET', '/lander');
  }

  // ---- reads

  landings(filter: LandingsFilter = {}): Promise<Landing[]> {
    const q = new URLSearchParams();
    if (filter.status?.length) q.set('status', filter.status.join(','));
    if (filter.agent) q.set('agent', filter.agent);
    if (filter.task) q.set('task', filter.task);
    if (filter.limit !== undefined) q.set('limit', String(filter.limit));
    return this.unwrap('landings', this.request('GET', `/landings${q.size ? `?${q}` : ''}`));
  }
  landing(id: string): Promise<Landing> {
    return this.unwrap('landing', this.request('GET', `/landings/${this.id(id)}`));
  }
  tasks(): Promise<Task[]> {
    return this.unwrap('tasks', this.request('GET', '/tasks'));
  }
  decisions(limit = 20): Promise<Decision[]> {
    return this.unwrap('decisions', this.request('GET', `/decisions?limit=${limit}`));
  }
  status(): Promise<StatusResult> {
    return this.request('GET', '/status');
  }

  // ---- messages and events

  post(to: string, body: string): Promise<Message> {
    return this.unwrap('message', this.request('POST', '/messages', { to, body }));
  }

  /** GET /events: after `since` (the hub's latest without it), long-polling up to `waitMs` for the first one. */
  events(q: EventsQuery = {}): Promise<EventsResult> {
    const p = new URLSearchParams();
    if (q.since !== undefined) p.set('since', String(q.since));
    if (q.types?.length) p.set('types', q.types.join(','));
    const waitMs = q.waitMs ?? 0;
    p.set('wait_ms', String(waitMs));
    return this.request('GET', `/events?${p}`, undefined, { timeoutMs: waitMs + this.timeoutMs + LONG_POLL_SLACK_MS, signal: q.signal });
  }
}
