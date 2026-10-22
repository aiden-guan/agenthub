import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub, SqliteStore, startServer } from '@agenthub/hub';
import type { LandingAdvanceRequest, LandingResolveRequest, SymbolChange, SymbolChangeInput, SymbolChangesResult } from '@agenthub/hub/protocol';
import { MAPPER_VERSION } from '@agenthub/symbols';
import type { HubPort } from '../src/ports.js';
import { override } from './helpers.js';
import { approver, P, Scenario } from './scenario.js';

// Phase 3 in the lander (design §2.2.4 step 4, §2.5 "Producers", §2.2.6
// step 4, §3.12), against a real hub on port 0 and a real bare remote: the
// lander's authoritative symbol scope at admission, the landed signature
// changes it reports (T0 vs C, at landed and at an in-doubt resolution), and
// the declarations named in a conflict report. The AI resolver's parse gate
// is in lander.ai.integration.test.ts.

const T = 60_000;

const AUTH = [
  'export function login(user: string): string {',
  '  return user;',
  '}',
  '',
  'export function logout(): string {',
  "  return 'bye';",
  '}',
  '',
  'export function refresh(token: string): string {',
  '  return token;',
  '}',
  '',
].join('\n');
const LOGIN_BEFORE = 'function login(user: string): string';
const LOGIN_AFTER = 'function login(user: string, opts: LoginOpts): Promise<Session>';
const WITH_OPTS = AUTH.replace('login(user: string): string', 'login(user: string, opts: LoginOpts): Promise<Session>');

/**
 * Whether the hub records signature changes (H6: POST/GET /symbol-changes,
 * landed rows from advance and resolve landed). The lander's half is tested
 * either way; the hub's rows are checked once H6 is merged (CP3).
 */
const HUB_RECORDS_SYMBOL_CHANGES = await (async () => {
  const hub = new Hub({ store: new SqliteStore(':memory:') });
  const front = await startServer({ hub, port: 0, host: '127.0.0.1' });
  try {
    const r = await fetch(`${front.url}/v1/p/${encodeURIComponent(P)}/symbol-changes`, { headers: { 'x-hub-agent': 'maya/claude-1' } });
    return r.ok;
  } finally {
    await front.close();
    (hub.store as { close?: () => void }).close?.();
  }
})();

let s: Scenario | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

type Sent = { id: string; req: LandingAdvanceRequest } | { id: string; req: LandingResolveRequest };

/** A scenario seeded with src/auth.ts; every advance and resolve the lander sends is recorded. */
async function scenario(o: Parameters<typeof Scenario.create>[0] = {}): Promise<{ sc: Scenario; sent: Sent[] }> {
  const sent: Sent[] = [];
  const wrapHub = (hub: HubPort): HubPort =>
    override(hub, {
      advance: (id: string, req: LandingAdvanceRequest) => {
        sent.push({ id, req });
        return hub.advance(id, req);
      },
      resolve: (id: string, req: LandingResolveRequest) => {
        sent.push({ id, req });
        return hub.resolve(id, req);
      },
    });
  s = await Scenario.create({ seed: { 'src/auth.ts': AUTH }, wrapHub, ...o });
  return { sc: s, sent };
}

/** The symbol_changes of the landed advance (or landed resolve) the lander sent for `id`. */
function landedChanges(sent: Sent[], id: string): SymbolChangeInput[] | null {
  for (const { id: x, req } of sent) {
    if (x !== id) continue;
    if ('to' in req && req.to === 'landed') return req.symbol_changes;
    if ('outcome' in req && req.outcome === 'landed') return req.symbol_changes;
  }
  return null;
}

async function http<R>(sc: Scenario, method: 'GET' | 'POST', route: string, agent: string, body?: unknown): Promise<R> {
  const r = await fetch(`${sc.front.url}/v1/p/${encodeURIComponent(P)}${route}`, {
    method,
    headers: { 'x-hub-agent': agent, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await r.json()) as R;
  if (!r.ok) throw new Error(`${method} ${route}: ${r.status} ${JSON.stringify(json)}`);
  return json;
}

describe('hub-lander, Phase 3 symbols (design §2.2.4 step 4, §2.5, §3.12)', () => {
  it(
    "symbol-disjoint changes to one file both admit and land; a change overlapping another agent's live symbol claim fails admission with claim_conflict naming the symbol",
    async () => {
      const { sc } = await scenario();
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      const seedTip = sc.trunk();
      a.commit('a: trim the user', { 'src/auth.ts': AUTH.replace('  return user;', '  return user.trim();') });
      b.commit('b: say goodbye', { 'src/auth.ts': AUTH.replace("  return 'bye';", "  return 'goodbye';") });
      // maya's adapter sends its advisory symbol scope; sam's edit never went through the hooks (nothing advisory).
      const La = sc.land(a, { summary: 'trim the user', files: ['src/auth.ts'], scope: [{ file: 'src/auth.ts', symbol: 'login' }], mapper: MAPPER_VERSION });
      const Lb = sc.land(b, { summary: 'say goodbye', files: [] });
      expect(La.status).toBe('submitted');
      expect(Lb.status).toBe('submitted');

      // Admission maps each change itself: one key each, in one file, with the mapper; both are admitted.
      expect(await sc.admit()).toBe(2);
      for (const [L, symbol] of [[La, 'login'], [Lb, 'logout']] as const) {
        const admitted = sc.landing(L.id);
        expect(admitted, L.id).toMatchObject({ status: 'queued', files: ['src/auth.ts'], scope: [{ file: 'src/auth.ts', symbol }], mapper: MAPPER_VERSION });
        const holds = sc.hub.listClaims(P).filter((c) => c.landing_id === L.id);
        expect(holds.map((h) => ({ scope: h.scope, mapper: h.mapper })), L.id).toEqual([{ scope: [{ file: 'src/auth.ts', symbol }], mapper: MAPPER_VERSION }]);
      }

      // Both land, the second merged onto the first.
      await sc.once();
      await sc.once();
      expect(sc.landing(La.id).status).toBe('landed');
      expect(sc.landing(Lb.id).status).toBe('landed');
      const [Ca, Cb] = sc.firstParents(seedTip);
      expect(sc.firstParents(seedTip)).toHaveLength(2);
      expect(sc.landing(Lb.id).trunk_sha).toBe(Cb);
      expect(sc.rev(`${Cb}^1`)).toBe(Ca);
      expect(sc.show(Cb!, 'src/auth.ts')).toBe(AUTH.replace('  return user;', '  return user.trim();').replace("  return 'bye';", "  return 'goodbye';"));

      // zed holds a live claim on refresh. maya's change to logout, in the same file, is admitted and lands.
      const z = sc.clone('zed/claude-1');
      const claim = sc.hub.claim(P, z.agent, { scope: [{ file: 'src/auth.ts', symbol: 'refresh' }], mapper: MAPPER_VERSION, intent: 'rotating tokens' });
      expect(claim.status).toBe('granted');
      a.git('fetch', '-q', 'origin', 'main');
      a.git('reset', '-q', '--hard', 'origin/main');
      const current = a.read('src/auth.ts');
      a.commit('a: logout says see you', { 'src/auth.ts': current.replace("  return 'goodbye';", "  return 'see you';") });
      const Lc = sc.land(a, { summary: 'see you', files: [] });
      await sc.once();
      expect(sc.landing(Lc.id)).toMatchObject({ status: 'landed', scope: [{ file: 'src/auth.ts', symbol: 'logout' }] });

      // Her next change touches refresh, which zed holds: claim_conflict, naming the symbol and its holder.
      a.git('fetch', '-q', 'origin', 'main');
      a.git('reset', '-q', '--hard', 'origin/main');
      a.commit('a: refresh trims', { 'src/auth.ts': a.read('src/auth.ts').replace('  return token;', '  return token.trim();') });
      const Ld = sc.land(a, { summary: 'refresh trims', files: [] });
      const trunkBefore = sc.trunk();
      await sc.once();
      const failed = sc.landing(Ld.id);
      expect(failed.status).toBe('failed');
      expect(failed.failure?.code).toBe('claim_conflict');
      expect(failed.failure?.summary).toContain('src/auth.ts#refresh');
      expect(failed.failure?.summary).toContain(z.agent);
      expect(failed.failure?.summary).toContain(claim.claim!.id);
      expect(failed).toMatchObject({ files: ['src/auth.ts'], scope: [{ file: 'src/auth.ts', symbol: 'refresh' }], mapper: MAPPER_VERSION });
      expect(sc.trunk()).toBe(trunkBefore);
      expect(sc.hub.inbox(P, a.agent, { peek: true }).messages.some((m) => m.body.includes(Ld.id) && m.body.includes('claim_conflict'))).toBe(true);
    },
    T,
  );

  it(
    "a landing that changes login's signature: advance landed reports the SymbolChange, T0 vs C, with the task",
    async () => {
      const { sc, sent } = await scenario();
      const a = sc.clone('maya/claude-1');
      const task = sc.task(a, 'Login takes options');
      a.commit('a: login takes opts', { 'src/auth.ts': WITH_OPTS, 'README.md': '# demo, with opts\n' });
      const L = sc.land(a, { task_id: task, summary: 'login takes opts' });
      await sc.once();
      expect(sc.landing(L.id).status).toBe('landed');
      expect(landedChanges(sent, L.id)).toEqual([{ file: 'src/auth.ts', symbol: 'login', kind: 'signature', before: LOGIN_BEFORE, after: LOGIN_AFTER, task_id: task }]);
    },
    T,
  );

  it.runIf(HUB_RECORDS_SYMBOL_CHANGES)(
    "a landing that changes login's signature records a landed SymbolChange with the right before and after, and supersedes the author's in-progress row (needs H6)",
    async () => {
      const { sc } = await scenario();
      const a = sc.clone('maya/claude-1');
      const task = sc.task(a, 'Login takes options');
      // maya's post-edit hook posted the change while she worked on it.
      const posted = await http<SymbolChangesResult>(sc, 'POST', '/symbol-changes', a.agent, {
        changes: [{ file: 'src/auth.ts', symbol: 'login', kind: 'signature', before: LOGIN_BEFORE, after: LOGIN_AFTER, task_id: task }],
      });
      expect(posted.changes).toEqual([expect.objectContaining({ agent: a.agent, symbol: 'login', status: 'in_progress', task_id: task })]);
      const inProgress = posted.changes[0]!;
      a.commit('a: login takes opts', { 'src/auth.ts': WITH_OPTS });
      const L = sc.land(a, { task_id: task, summary: 'login takes opts' });
      await sc.once();
      expect(sc.landing(L.id).status).toBe('landed');

      const all = (await http<SymbolChangesResult>(sc, 'GET', '/symbol-changes?status=in_progress,landed,superseded,withdrawn', 'sam/claude-1')).changes;
      const landed = all.filter((c: SymbolChange) => c.status === 'landed');
      expect(landed).toEqual([
        expect.objectContaining({ agent: a.agent, landing_id: L.id, task_id: task, file: 'src/auth.ts', symbol: 'login', name: 'login', kind: 'signature', before: LOGIN_BEFORE, after: LOGIN_AFTER }),
      ]);
      expect(all.find((c: SymbolChange) => c.id === inProgress.id)?.status).toBe('superseded');
      expect(all.filter((c: SymbolChange) => c.status === 'in_progress')).toEqual([]);
      expect(sc.events.some((e) => e.type === 'symbol.changed' && e.data.landing_id === L.id && e.data.status === 'landed' && e.data.symbol === 'login')).toBe(true);
    },
    T,
  );

  it(
    'an in-doubt landing resolved as landed reports its signature changes too (resolve {landed}, §2.2.7 step 2/3)',
    async () => {
      const { sc, sent } = await scenario();
      const a = sc.clone('maya/claude-1');
      const task = sc.task(a, 'Login takes options');
      a.commit('a: login takes opts', { 'src/auth.ts': WITH_OPTS });
      const L = sc.land(a, { task_id: task, summary: 'login takes opts' });
      // The remote refuses the trunk update: the landing stays in pushing, landing pauses.
      writeFileSync(path.join(sc.remote, 'refuse-trunk'), '');
      await sc.once();
      const stuck = sc.landing(L.id);
      expect(stuck).toMatchObject({ status: 'running', phase: 'pushing' });
      rmSync(path.join(sc.remote, 'refuse-trunk'));
      sc.hub.resumeLander(P, {}, approver('sam'));
      await sc.once();
      const done = sc.landing(L.id);
      expect(done.status).toBe('landed');
      expect(done.trunk_sha).toBe(stuck.candidate);
      const resolved = sent.find((x) => x.id === L.id && 'outcome' in x.req && x.req.outcome === 'landed');
      expect(resolved).toBeDefined();
      expect(landedChanges(sent, L.id)).toEqual([{ file: 'src/auth.ts', symbol: 'login', kind: 'signature', before: LOGIN_BEFORE, after: LOGIN_AFTER, task_id: task }]);
    },
    T,
  );

  it(
    'a conflict report names the declarations each hunk lies in',
    async () => {
      const { sc } = await scenario();
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      a.commit('a: trim', { 'src/auth.ts': AUTH.replace('  return user;', '  return user.trim();') });
      const La = sc.land(a, { summary: 'trim' });
      await sc.once();
      expect(sc.landing(La.id).status).toBe('landed');
      b.commit('b: lowercase', { 'src/auth.ts': AUTH.replace('  return user;', '  return user.toLowerCase();') });
      const Lb = sc.land(b, { summary: 'lowercase' });
      await sc.once();
      const failed = sc.landing(Lb.id);
      expect(failed.failure?.code).toBe('conflict');
      expect(failed.report?.conflicts).toEqual([expect.objectContaining({ file: 'src/auth.ts', kind: 'content' })]);
      expect(failed.report?.conflicts[0]?.hunks).toEqual([expect.objectContaining({ symbols: ['login'], trunk: '  return user.trim();\n', yours: '  return user.toLowerCase();\n' })]);
    },
    T,
  );
});
