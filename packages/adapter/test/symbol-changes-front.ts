import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { isValidSymbolKey } from '@agenthub/contract';
import { Hub, HubError, cleanText, normalizeRepoPath } from '@agenthub/hub';
import type { SymbolChange, SymbolChangeKind, SymbolChangeStatus } from '@agenthub/hub/protocol';
import { startLandingHub, type LandingHub } from './landing-hub.js';

// The Phase 3 test rig for A4 (impact warnings): the real Hub behind H4's real
// server (startLandingHub), with POST/GET /symbol-changes (design §1.7, §2.5).
//
// Lane H builds those routes in H6, in parallel with A4. Until H6 is merged
// into this checkout, a small front in this file serves the two routes the
// way H6's notes (packages/hub/LANE-NOTES.md, "H6: symbol changes") describe
// them, on the hub's own store and inside its own write transaction, so the
// `symbol.changed` events reach the feed and the long-poll like any other:
//
// - one in-progress row per (agent, file, symbol), measured from the first
//   `before`; a change whose `after` equals its own `before` or the open row's
//   `before` withdraws the row (nothing is written when none is open);
// - the task the change names, else the agent's only task in progress, else
//   the open row's;
// - `symbol` must be a declaration key (400 invalid_symbol);
// - GET: the last 24 h by default (`since_ms` a time), `status` a list
//   (default in_progress,landed), newest first;
// - up to 3 decisions linked on read: the change's task, or decisions whose
//   symbols name the key, the name, `file#key` or `file#name` (a trailing
//   `()` ignored);
// - `symbol.changed` carries ids and names only.
//
// Everything else (the WebSocket feed included) passes through to the real
// server. Once the hub has H6 (Hub.prototype.postSymbolChanges), this returns
// the real server alone and the front is not used.

export interface ImpactHub extends LandingHub {
  /** The /symbol-changes routes are this file's stand-in, not the hub's own (H6 not merged yet). */
  emulated: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS: readonly SymbolChangeKind[] = ['signature', 'removed', 'renamed'];
const STATUSES: readonly SymbolChangeStatus[] = ['in_progress', 'landed', 'withdrawn', 'superseded'];

type Row = Omit<SymbolChange, 'decisions'>;

export async function startImpactHub(): Promise<ImpactHub> {
  const inner = await startLandingHub();
  if (typeof (Hub.prototype as unknown as Record<string, unknown>).postSymbolChanges === 'function') return { ...inner, emulated: false };
  const backend = new URL(inner.url);
  const hub = inner.hub as unknown as {
    store: any;
    write<T>(project: string, fn: (now: number) => T): T;
    read<T>(project: string, fn: (now: number) => T): T;
    emit(project: string, type: string, actor: string | null, data: Record<string, unknown>): void;
    touch(project: string, agent: string, now: number): void;
    resolveTaskId(project: string, agent: string, taskId: string | undefined): string | null;
  };

  const linkDecisions = (project: string, rows: Row[]): SymbolChange[] => {
    const decisions = hub.store.listDecisions(project, 2000) as Array<{ id: string; agent: string; summary: string; task_id: string | null; symbols: string[] }>;
    return rows.map((row) => {
      const refs = new Set([row.symbol, row.name, `${row.file}#${row.symbol}`, `${row.file}#${row.name}`]);
      const linked = decisions
        .filter((d) => (row.task_id !== null && d.task_id === row.task_id) || d.symbols.some((s) => refs.has(s.normalize('NFC').trim().replace(/\(\)$/, ''))))
        .slice(0, 3)
        .map((d) => ({ id: d.id, agent: d.agent, summary: d.summary }));
      return { ...row, decisions: linked };
    });
  };

  const emitChanged = (project: string, row: Row, actor: string) =>
    hub.emit(project, 'symbol.changed', actor, {
      change_id: row.id,
      agent: row.agent,
      file: row.file,
      symbol: row.symbol,
      name: row.name,
      kind: row.kind,
      status: row.status,
      landing_id: row.landing_id,
      task_id: row.task_id,
    });

  const post = (project: string, agent: string, body: any) => {
    if (!body || !Array.isArray(body.changes)) throw new HubError('bad_request', 'the request is {changes: [...]}');
    const changes = (body.changes as any[]).map((c, i) => {
      const key = (v: unknown) => {
        const k = typeof v === 'string' ? v.normalize('NFC') : '';
        if (!isValidSymbolKey(k) || k.startsWith('@')) throw new HubError('invalid_symbol', `changes[${i}].symbol must be a declaration key`);
        return k;
      };
      if (!KINDS.includes(c?.kind)) throw new HubError('bad_request', `changes[${i}].kind`);
      const before = cleanText(c.before, 500, true);
      if (!before) throw new HubError('bad_request', `changes[${i}].before is empty`);
      const after = c.after === undefined || c.after === null ? null : cleanText(c.after, 500, true);
      if (c.kind === 'signature' && after === null) throw new HubError('bad_request', `changes[${i}]: a signature change needs after`);
      if (c.kind === 'removed' && after !== null) throw new HubError('bad_request', `changes[${i}]: a removed symbol has no after`);
      return {
        file: normalizeRepoPath(c.file),
        symbol: key(c.symbol),
        kind: c.kind as SymbolChangeKind,
        before,
        after,
        renamed_to: c.kind === 'renamed' ? key(c.renamed_to) : null,
        task_id: typeof c.task_id === 'string' ? c.task_id : undefined,
      };
    });
    return hub.write(project, (now) => {
      hub.touch(project, agent, now);
      const out = new Map<string, Row>();
      for (const c of changes) {
        const open: Row | null = hub.store.updateSymbolChanges({ project, agent, file: c.file, symbol: c.symbol, statuses: ['in_progress'] }, {})[0] ?? null;
        const taskId = hub.resolveTaskId(project, agent, c.task_id) ?? open?.task_id ?? null;
        if (c.after !== null && (c.after === c.before || c.after === open?.before)) {
          if (!open) continue;
          const [withdrawn] = hub.store.updateSymbolChanges({ project, ids: [open.id] }, { status: 'withdrawn', updated_at: now }) as Row[];
          emitChanged(project, withdrawn, agent);
          out.set(withdrawn.id, withdrawn);
          continue;
        }
        const next = {
          project,
          agent,
          task_id: taskId,
          landing_id: null,
          file: c.file,
          symbol: c.symbol,
          name: c.symbol.slice(c.symbol.lastIndexOf('.') + 1),
          kind: c.kind,
          before: open?.before ?? c.before,
          after: c.after,
          renamed_to: c.renamed_to,
          status: 'in_progress' as const,
          created_at: now,
          updated_at: now,
        };
        if (open && open.kind === next.kind && open.before === next.before && open.after === next.after && open.renamed_to === next.renamed_to && open.task_id === next.task_id) {
          out.set(open.id, open);
          continue;
        }
        const row = hub.store.upsertSymbolChange(next) as Row;
        emitChanged(project, row, agent);
        out.set(row.id, row);
      }
      return { changes: linkDecisions(project, [...out.values()]), now, seq: hub.store.latestSeq(project) };
    });
  };

  const list = (project: string, query: URLSearchParams) => {
    const sinceRaw = query.get('since_ms');
    const statuses = (query.get('status') ?? '').split(',').filter(Boolean);
    if (statuses.some((s) => !STATUSES.includes(s as SymbolChangeStatus))) throw new HubError('bad_request', 'status');
    return hub.read(project, (now) => {
      const since = sinceRaw ? Number(sinceRaw) : now - DAY_MS;
      const rows = hub.store.listSymbolChanges(project, { since, statuses: statuses.length ? statuses : ['in_progress', 'landed'], limit: 1000 }) as Row[];
      return { changes: linkDecisions(project, rows), now, seq: hub.store.latestSeq(project) };
    });
  };

  const proxy = (req: IncomingMessage, res: ServerResponse, body: Buffer | null) => {
    const up = httpRequest({ host: backend.hostname, port: backend.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on('close', () => up.destroy());
    if (body) up.end(body);
    else req.pipe(up);
  };

  const front = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    const m = /^\/v1\/p\/([^/]+)\/symbol-changes$/.exec(url.pathname);
    if (!m) return proxy(req, res, null);
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      try {
        const project = decodeURIComponent(m[1]!);
        if (req.method === 'GET') return send(res, 200, list(project, url.searchParams));
        if (req.method !== 'POST') return proxy(req, res, Buffer.concat(chunks));
        const agent = req.headers['x-hub-agent'];
        if (typeof agent !== 'string' || !agent) throw new HubError('bad_request', 'x-hub-agent is required', 400);
        const text = Buffer.concat(chunks).toString('utf8');
        send(res, 200, post(project, agent, text ? JSON.parse(text) : {}));
      } catch (err) {
        const e = err instanceof HubError ? err : new HubError('internal', (err as Error).message, 500);
        send(res, e.status, { error: { code: e.code, message: e.message } });
      }
    });
  });

  const upgraded = new Set<Socket>();
  front.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on('error', () => {});
    upgraded.add(socket);
    const up = connect(Number(backend.port), backend.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    up.on('close', () => socket.destroy());
    socket.on('close', () => {
      up.destroy();
      upgraded.delete(socket);
    });
  });

  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  const { port } = front.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    hub: inner.hub,
    emulated: true,
    close: async () => {
      for (const s of upgraded) s.destroy();
      front.closeAllConnections();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await inner.close();
    },
  };
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
