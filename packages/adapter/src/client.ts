import type {
  CheckResult,
  Claim,
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

/** The hub could not be reached (network error or timeout). */
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
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { ...this.headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = (err as Error).name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : ((err as Error).cause as Error)?.message ?? (err as Error).message;
      throw new HubUnavailableError(`hub at ${this.cfg.url} is unreachable (${reason})`);
    }
    const text = await res.text();
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
  check(files: string[]): Promise<CheckResult> {
    return this.request('POST', '/claims/check', { files });
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
