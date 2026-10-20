import type {
  CheckResult,
  Claim,
  ClaimConflict,
  ClaimRequest,
  ClaimResult,
  Decision,
  DecisionRequest,
  HeartbeatRequest,
  HeartbeatResult,
  HubEvent,
  InboxResult,
  LandRequest,
  LandResult,
  Message,
  ReleaseRequest,
  ReleaseResult,
  StatusResult,
  Task,
  TaskCreateRequest,
  TaskStatus,
} from '@agenthub/hub/protocol';
import type { HubConfig } from './config.js';

/** The hub could not be reached: no HTTP response at all (network error, refused connection, timeout). */
export class HubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubUnavailableError';
  }
}

/** The hub answered with an error. */
export class HubApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HubApiError';
  }
}

/**
 * What a failed hub call means for the hooks and the guard:
 * - `unreachable`: no HTTP response, or the hub is broken (HTTP 5xx, or an
 *   answer that isn't the hub's JSON). The only kind that may fail open, with a
 *   visible warning, and only when fail-closed isn't configured.
 * - `auth` (HTTP 401/403) and `refused` (any other 4xx): the hub is up and said no.
 * - `error`: anything else, such as a bug in the adapter.
 * All but `unreachable` always block.
 */
export interface HubFailure {
  kind: 'unreachable' | 'auth' | 'refused' | 'error';
  message: string;
}

export function classifyFailure(err: unknown, url: string): HubFailure {
  if (err instanceof HubUnavailableError) return { kind: 'unreachable', message: err.message };
  if (err instanceof HubApiError) {
    const detail = `HTTP ${err.status} ${err.code}: ${err.message}`;
    if (err.status === 401 || err.status === 403) {
      return { kind: 'auth', message: `hub at ${url} rejected this agent's credentials (${detail}); set HUB_TOKEN (or "token" in .hub.json) to the hub's token` };
    }
    if (err.status >= 400 && err.status < 500) return { kind: 'refused', message: `hub at ${url} refused the request (${detail})` };
    return { kind: 'unreachable', message: `hub at ${url} is failing (${detail})` };
  }
  return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
}

/** The hub rejects request bodies over 1,000,000 bytes; the guard's file list is sent in parts well below that. */
const CHECK_BATCH_BYTES = 256 * 1024;

export type ClientConfig = Pick<HubConfig, 'url' | 'project' | 'agent' | 'token' | 'timeoutMs'>;

export class HubClient {
  constructor(readonly cfg: ClientConfig) {}

  private get base(): string {
    return `${this.cfg.url}/v1/p/${encodeURIComponent(this.cfg.project)}`;
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.cfg.agent) h['x-hub-agent'] = this.cfg.agent;
    if (this.cfg.token) h.authorization = `Bearer ${this.cfg.token}`;
    return h;
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = this.cfg.timeoutMs): Promise<T> {
    // Built outside the try: a local mistake (a bad timeout) must not read as "hub unreachable".
    const signal = AbortSignal.timeout(timeoutMs);
    const unreachable = (err: unknown) => {
      const reason = (err as Error).name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : ((err as Error).cause as Error)?.message ?? (err as Error).message;
      return new HubUnavailableError(`hub at ${this.cfg.url} is unreachable (${reason})`);
    };
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw unreachable(err);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      // The connection dropped mid-answer. A 4xx status is still a refusal.
      if (res.status >= 400 && res.status < 500) throw new HubApiError(res.status, 'http_error', `HTTP ${res.status}`);
      throw unreachable(err);
    }
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new HubApiError(res.status, 'bad_response', `hub sent a non-JSON response (HTTP ${res.status})`);
    }
    if (!res.ok) throw new HubApiError(res.status, data?.error?.code ?? 'http_error', data?.error?.message ?? `HTTP ${res.status}`);
    return data as T;
  }

  status(): Promise<StatusResult> {
    return this.request('GET', '/status');
  }
  heartbeat(req: HeartbeatRequest = {}): Promise<HeartbeatResult> {
    return this.request('POST', '/heartbeat', req);
  }
  claim(req: ClaimRequest): Promise<ClaimResult> {
    return this.request('POST', '/claims', req);
  }
  release(req: ReleaseRequest): Promise<ReleaseResult> {
    return this.request('POST', '/claims/release', req);
  }
  /** Exclusive claims by others on `files`, asked in batches small enough for the hub's body limit. */
  async check(files: string[]): Promise<CheckResult> {
    const batches: string[][] = [[]];
    let size = 0;
    for (const f of files) {
      const bytes = Buffer.byteLength(JSON.stringify(f)) + 1;
      if (size + bytes > CHECK_BATCH_BYTES && batches[batches.length - 1].length > 0) {
        batches.push([]);
        size = 0;
      }
      batches[batches.length - 1].push(f);
      size += bytes;
    }
    let result: CheckResult | null = null;
    const byClaim = new Map<string, ClaimConflict>();
    for (const batch of batches) {
      result = await this.request<CheckResult>('POST', '/claims/check', { files: batch });
      for (const c of result.conflicts) {
        const seen = byClaim.get(c.claim_id);
        if (seen) seen.files = [...new Set([...seen.files, ...c.files])];
        else byClaim.set(c.claim_id, { ...c, files: [...c.files] });
      }
    }
    return { ...result!, conflicts: [...byClaim.values()] };
  }
  async getClaim(id: string): Promise<Claim> {
    return (await this.request<{ claim: Claim }>('GET', `/claims/${encodeURIComponent(id)}`)).claim;
  }
  async tasks(): Promise<Task[]> {
    return (await this.request<{ tasks: Task[] }>('GET', '/tasks')).tasks;
  }
  async createTask(req: TaskCreateRequest): Promise<Task> {
    return (await this.request<{ task: Task }>('POST', '/tasks', req)).task;
  }
  async takeTask(id: string): Promise<Task> {
    return (await this.request<{ task: Task }>('POST', `/tasks/${encodeURIComponent(id)}/take`, {})).task;
  }
  updateTask(id: string, status: TaskStatus): Promise<{ task: Task; unblocked: string[] }> {
    return this.request('POST', `/tasks/${encodeURIComponent(id)}/update`, { status });
  }
  async post(to: string, body: string): Promise<Message> {
    return (await this.request<{ message: Message }>('POST', '/messages', { to, body })).message;
  }
  inbox(opts: { peek?: boolean; limit?: number } = {}): Promise<InboxResult> {
    const q = new URLSearchParams();
    if (opts.peek) q.set('peek', '1');
    if (opts.limit) q.set('limit', String(opts.limit));
    return this.request('GET', `/inbox${q.size ? `?${q}` : ''}`);
  }
  async decisions(limit = 20): Promise<Decision[]> {
    return (await this.request<{ decisions: Decision[] }>('GET', `/decisions?limit=${limit}`)).decisions;
  }
  async decide(req: DecisionRequest): Promise<Decision> {
    return (await this.request<{ decision: Decision }>('POST', '/decisions', req)).decision;
  }
  land(req: LandRequest): Promise<LandResult> {
    return this.request('POST', '/land', req);
  }
  /** Long-poll: events after `since`, waiting up to `waitMs` for the first one. */
  events(since: number, waitMs = 0): Promise<{ events: HubEvent[]; seq: number }> {
    return this.request('GET', `/events?since=${since}&wait_ms=${waitMs}`, undefined, waitMs + this.cfg.timeoutMs + 5000);
  }

  feedUrl(since?: number): string {
    const q = new URLSearchParams();
    if (this.cfg.agent) q.set('agent', this.cfg.agent);
    if (since !== undefined) q.set('since', String(since));
    return `${this.base.replace(/^http/, 'ws')}/feed?${q}`;
  }
}
