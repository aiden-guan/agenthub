import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPORTS, TOPLEVEL, claimCovers, comparable, entriesOverlap, entryCovers, overlappingEntries, type ScopedLike } from '@agenthub/contract';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub, SqliteStore, startServer, type Claim, type ClaimRequest, type RunningServer, type ScopeEntry } from '../src/index.js';
import { overlapping, scopesOverlap } from '../src/scope.js';
import { A, B, C, LANDER, LANDER_AUTH, P, errorOf, setup, sha, takeLease } from './landing-setup.js';

// H5 (design §1.10, §4.2): symbol-scope claims. A scope entry is {file,
// symbol?}; two entries overlap by the contract's rules (entriesOverlap), and
// symbols count only between claims made with the same non-null mapper
// (overlappingEntries, claimCovers). The hub uses them wherever Phase 1
// compared files: grants, denials, the queue, coverage, check and the guard.

const here = path.dirname(fileURLToPath(import.meta.url));
/** The fixtures' MAPPER_VERSION, and a second one (another adapter or lander version). */
const M = 'sym1;vtsw0.3.1;wts0.27.0;4be1c2d9';
const M2 = 'sym1;vtsw0.3.1;wts0.27.0;00c0ffee';
const D = 'kim/claude-1';
const AUTH = 'src/auth.ts';
const ROUTES = 'src/routes.ts';
const at = (symbol: string, file = AUTH): ScopeEntry => ({ file, symbol });
const sym = (symbols: string[], extra: Partial<ClaimRequest> = {}, file = AUTH): ClaimRequest => ({ scope: symbols.map((s) => at(s, file)), mapper: M, ...extra });

describe('symbol-scope claims', () => {
  it('grants disjoint symbols of one file to different agents, and stores the mapper on the claim', () => {
    const { hub } = setup();
    const a = hub.claim(P, A, sym(['login'], { intent: 'options object' }));
    expect(a).toMatchObject({ status: 'granted', claim: { holder: A, scope: [at('login')], mapper: M } });
    expect(hub.claim(P, B, sym(['logout'])).status).toBe('granted');
    // Members of one container are disjoint, and so are names that only share a prefix.
    expect(hub.claim(P, C, sym(['Session.refresh'])).status).toBe('granted');
    expect(hub.claim(P, D, sym(['Session.close'])).status).toBe('granted');
    expect(hub.claim(P, D, sym(['loginx', 'log'])).status).toBe('granted');
    // Top-level statements are a key of their own.
    expect(hub.claim(P, D, sym([TOPLEVEL])).status).toBe('granted');
    expect(hub.listClaims(P).map((c) => [c.holder, c.scope.map((e) => e.symbol)])).toEqual([
      [A, ['login']],
      [B, ['logout']],
      [C, ['Session.refresh']],
      [D, ['Session.close']],
      [D, ['loginx', 'log']],
      [D, [TOPLEVEL]],
    ]);
    // A whole-file claim keeps no mapper: there is nothing for one to say.
    expect(hub.claim(P, A, { files: ['README.md'], mapper: M }).claim!.mapper).toBeNull();
  });

  it('denies the same symbol, a container against its member and a file against a symbol, naming the overlapping entries', () => {
    const { hub } = setup();
    const held = hub.claim(P, A, { scope: [at('login'), at('Session.refresh'), at('handleLogin', ROUTES)], mapper: M, intent: 'options object' }).claim!;
    const deniedFor = (req: ClaimRequest) => {
      const r = hub.claim(P, B, req);
      expect(r.status).toBe('denied');
      return r.conflicts.map((c) => ({ claim_id: c.claim_id, holder: c.holder, files: c.files, scope: c.scope }));
    };
    const conflict = (scope: ScopeEntry[]) => [{ claim_id: held.id, holder: A, files: [...new Set(scope.map((e) => e.file))], scope }];
    expect(deniedFor(sym(['login']))).toEqual(conflict([at('login')]));
    // The container conflicts with its members, and a member with its container.
    expect(deniedFor(sym(['Session']))).toEqual(conflict([at('Session.refresh')]));
    expect(deniedFor(sym(['Session.refresh.retry']))).toEqual(conflict([at('Session.refresh')]));
    // A whole file conflicts with every entry in it, and nothing else.
    expect(deniedFor({ files: [AUTH] })).toEqual(conflict([at('login'), at('Session.refresh')]));
    expect(deniedFor({ scope: [{ file: AUTH }, at('nothing', ROUTES)], mapper: M })).toEqual(conflict([at('login'), at('Session.refresh')]));
    expect(deniedFor({ scope: [at('logout'), at('handleLogin', ROUTES)], mapper: M })).toEqual(conflict([at('handleLogin', ROUTES)]));
    // A symbol conflicts with a whole-file claim of its file.
    hub.claim(P, C, { files: ['src/db.ts'], intent: 'schema' });
    const r = hub.claim(P, B, sym(['connect'], {}, 'src/db.ts'));
    expect(r).toMatchObject({ status: 'denied', conflicts: [{ holder: C, files: ['src/db.ts'], scope: [{ file: 'src/db.ts' }] }] });
    // @toplevel conflicts with @toplevel.
    hub.claim(P, C, sym([TOPLEVEL]));
    expect(hub.claim(P, B, sym([TOPLEVEL])).conflicts.map((c) => [c.holder, c.scope])).toEqual([[C, [at(TOPLEVEL)]]]);
    // Nothing was granted to B.
    expect(hub.listClaims(P, { holder: B })).toEqual([]);
  });

  it('grants @imports next to @imports, but not next to the whole file', () => {
    const { hub } = setup();
    expect(hub.claim(P, A, sym([IMPORTS])).status).toBe('granted');
    expect(hub.claim(P, B, sym([IMPORTS])).status).toBe('granted');
    expect(hub.claim(P, C, sym([TOPLEVEL, 'login'])).status).toBe('granted');
    const whole = hub.claim(P, D, { files: [AUTH] });
    expect(whole.conflicts.map((c) => [c.holder, c.scope])).toEqual([
      [A, [at(IMPORTS)]],
      [B, [at(IMPORTS)]],
      [C, [at(TOPLEVEL), at('login')]],
    ]);
  });

  it('compares at file level across mappers, and for stored symbol entries without one', () => {
    const { hub, store, clock } = setup();
    hub.claim(P, A, sym(['login']));
    // Another adapter version names the same code differently: the whole file counts.
    const other = hub.claim(P, B, sym(['logout'], { mapper: M2 }));
    expect(other).toMatchObject({ status: 'denied', conflicts: [{ holder: A, files: [AUTH], scope: [at('login')] }] });
    expect(hub.check(P, B, { scope: [at('logout')], mapper: M2 }).conflicts.map((c) => c.holder)).toEqual([A]);
    // A Phase 1 hub stored symbol text without a mapper: that is the whole file.
    const t = clock.t;
    store.insertClaim({
      id: 'C-90', project: P, holder: C, task_id: null, scope: [at('legacy', 'src/old.ts')], mode: 'exclusive', intent: 'phase 1', base_commit: null, status: 'active',
      created_at: t, granted_at: t, expires_at: t + 60_000, ttl_ms: 60_000, heartbeat_interval_ms: 15_000, ended_at: null, end_reason: null, landing_id: null, mapper: null,
    });
    for (const s of ['other', 'legacy']) {
      expect(hub.claim(P, B, sym([s], {}, 'src/old.ts'))).toMatchObject({ status: 'denied', conflicts: [{ claim_id: 'C-90', scope: [at('legacy', 'src/old.ts')] }] });
    }
    // Nor does it cover its holder's symbol request on that file: only a whole-file entry covers across mappers.
    expect(hub.claim(P, C, sym(['legacy'], {}, 'src/old.ts'))).toMatchObject({ status: 'granted', renewed: false });
  });

  it('covers a request with a whole-file claim, or with the symbol or its container under the same mapper', () => {
    const { hub } = setup();
    const file = hub.claim(P, A, { files: ['src/a.ts'] }).claim!;
    expect(hub.claim(P, A, sym(['f', IMPORTS], {}, 'src/a.ts'))).toMatchObject({ status: 'granted', renewed: true, claim: { id: file.id } });
    const container = hub.claim(P, A, sym(['Session'])).claim!;
    expect(hub.claim(P, A, sym(['Session.refresh', 'Session'])).claim!.id).toBe(container.id);
    expect(hub.claim(P, A, sym(['Session.refresh'])).renewed).toBe(true);
    // A member doesn't cover its container, nor does another mapper's symbol cover anything.
    const wider = hub.claim(P, A, sym(['Sessions', 'Session.x.y']));
    expect(wider).toMatchObject({ status: 'granted', renewed: false, claim: { scope: [at('Sessions')] } });
    expect(wider.claims.map((c) => c.id)).toEqual([container.id, wider.claim!.id]);
    expect(hub.claim(P, A, sym(['Session'], { mapper: M2 }))).toMatchObject({ status: 'granted', renewed: false, claim: { scope: [at('Session')], mapper: M2 } });
    // An exclusive request isn't covered by a shared claim, as in Phase 1.
    hub.claim(P, A, sym(['notes'], { mode: 'shared' }, 'NOTES.md'));
    expect(hub.claim(P, A, sym(['notes'], { mode: 'exclusive' }, 'NOTES.md')).renewed).toBe(false);
  });

  it('refuses symbols that are no declaration key, and symbols without their mapper (400 invalid_symbol)', () => {
    const { hub } = setup();
    for (const symbol of ['', 'a b', 'Session.', '.refresh', 'Session..refresh', '@exports', '#imports', 'x'.repeat(201), 'a‮b', 7, {}]) {
      expect(errorOf(() => hub.claim(P, A, { scope: [{ file: AUTH, symbol: symbol as string }], mapper: M })).code, String(symbol)).toBe('invalid_symbol');
      expect(errorOf(() => hub.check(P, A, { scope: [{ file: AUTH, symbol: symbol as string }], mapper: M })).code).toBe('invalid_symbol');
    }
    expect(errorOf(() => hub.claim(P, A, { scope: [at('login')] })).code).toBe('invalid_symbol');
    expect(errorOf(() => hub.claim(P, A, { scope: [at('login')], mapper: '' })).code).toBe('invalid_symbol');
    expect(errorOf(() => hub.check(P, A, { scope: [at('login')] })).code).toBe('invalid_symbol');
    // A mapper is a version string, not free text.
    for (const mapper of [7, 'x'.repeat(201), ' sym1', 'sym1\n2', 'a  b']) {
      expect(errorOf(() => hub.claim(P, A, { scope: [at('login')], mapper: mapper as string })).code, String(mapper)).toBe('bad_request');
    }
    // Unicode names are keys, compared in NFC form.
    const cafe = hub.claim(P, A, sym(['café']));
    expect(cafe.claim!.scope).toEqual([at('café')]);
    expect(hub.claim(P, B, sym(['café'])).status).toBe('denied');
    // A whole-file entry subsumes the symbol entries of its file in one request.
    expect(hub.claim(P, C, { scope: [at('x', 'b.ts'), { file: 'b.ts' }, at('y', 'b.ts'), at('z', 'c.ts')], mapper: M }).claim!.scope).toEqual([{ file: 'b.ts' }, at('z', 'c.ts')]);
    expect(hub.listClaims(P)).toHaveLength(2);
  });

  it('queues and promotes waiters entry by entry', () => {
    const { hub } = setup();
    const a = hub.claim(P, A, sym(['login'])).claim!; // C-1
    const b = hub.claim(P, B, sym(['login'], { queue: true }));
    expect(b).toMatchObject({ status: 'queued', position: 1, conflicts: [{ claim_id: a.id, scope: [at('login')] }] });
    // B waits in line for login only: logout doesn't wait behind it.
    expect(hub.claim(P, C, sym(['logout'], { queue: true })).status).toBe('granted'); // C-3
    // A whole-file request waits for all three.
    const d = hub.claim(P, D, { files: [AUTH], queue: true });
    expect(d).toMatchObject({ status: 'queued', position: 2 });
    expect(d.conflicts.map((c) => c.claim_id)).toEqual([a.id, 'C-3', b.claim!.id]);

    const r1 = hub.release(P, A, { claim_id: a.id });
    expect(r1.promoted.map((c) => [c.id, c.holder])).toEqual([[b.claim!.id, B]]);
    expect(hub.release(P, C, { all: true }).promoted).toEqual([]);
    expect(hub.release(P, B, { all: true }).promoted.map((c) => c.holder)).toEqual([D]);
    // The same request again renews the queued claim instead of queueing twice.
    const e = hub.claim(P, A, sym(['refresh', 'login'], { queue: true }));
    expect(e).toMatchObject({ status: 'queued' });
    expect(hub.claim(P, A, sym(['login', 'refresh'], { queue: true })).claim!.id).toBe(e.claim!.id);
    expect(hub.claim(P, A, sym(['login', 'refresh'], { queue: true, mapper: M2 })).claim!.id).not.toBe(e.claim!.id);
  });

  it('release by files drops every entry of those files and lets their waiters in', () => {
    const { hub, events } = setup();
    const a = hub.claim(P, A, { scope: [at('login'), at('logout'), at('handleLogin', ROUTES)], mapper: M }).claim!;
    const b = hub.claim(P, B, sym(['logout'], { queue: true })).claim!;
    const r = hub.release(P, A, { files: [AUTH] });
    expect(r.trimmed.map((c) => [c.id, c.scope])).toEqual([[a.id, [at('handleLogin', ROUTES)]]]);
    expect(r.promoted.map((c) => c.id)).toEqual([b.id]);
    const partial = events.find((e) => e.type === 'claim.released' && e.data.claim_id === a.id)!;
    expect(partial.data).toMatchObject({ files: [AUTH], partial: true, scope: [at('login'), at('logout')], mapper: M });
    expect(hub.getClaim(P, a.id)).toMatchObject({ status: 'active', scope: [at('handleLogin', ROUTES)], mapper: M });
  });

  it('detects a deadlock only where the symbols overlap', () => {
    const { hub } = setup();
    hub.claim(P, A, sym(['f'])); // C-1
    hub.claim(P, B, sym(['g'])); // C-2
    expect(hub.claim(P, A, sym(['g'], { queue: true })).status).toBe('queued'); // A waits for B
    expect(hub.claim(P, B, sym(['h'], { queue: true })).status).toBe('granted');
    const denied = hub.claim(P, B, sym(['f']));
    expect(denied.deadlock).toContain('would deadlock');
    expect(errorOf(() => hub.claim(P, B, sym(['f'], { queue: true }))).code).toBe('deadlock');
  });

  it('check compares entries, for the guard and with a mode, and still takes a list of files', () => {
    const { hub } = setup();
    hub.claim(P, A, { scope: [at('login'), at('handleLogin', ROUTES)], mapper: M, intent: 'options' }); // C-1
    hub.claim(P, B, sym(['logout'], { mode: 'shared' })); // C-2
    // The guard: other agents' exclusive claims whose entries overlap.
    expect(hub.check(P, C, { scope: [at('refresh')], mapper: M }).conflicts).toEqual([]);
    expect(hub.check(P, C, { scope: [at('login'), at('logout')], mapper: M }).conflicts.map((c) => [c.claim_id, c.scope])).toEqual([['C-1', [at('login')]]]);
    expect(hub.check(P, C, { files: [AUTH, ROUTES] }).conflicts.map((c) => [c.claim_id, c.files, c.scope])).toEqual([['C-1', [AUTH, ROUTES], [at('login'), at('handleLogin', ROUTES)]]]);
    expect(hub.check(P, C, [AUTH]).conflicts.map((c) => c.claim_id)).toEqual(['C-1']);
    // With a mode: what the edit hook's request for each file's entries would be denied for.
    const auto = hub.check(P, C, { scope: [at('login'), at('logout'), at('handleLogin', ROUTES), at('free', ROUTES)], mapper: M, mode: 'auto' });
    expect(auto.conflicts.map((c) => [c.claim_id, c.files, c.scope])).toEqual([
      ['C-1', [AUTH, ROUTES], [at('login'), at('handleLogin', ROUTES)]],
      ['C-2', [AUTH], [at('logout')]],
    ]);
    expect(hub.check(P, C, { scope: [at('logout')], mapper: M, mode: 'auto' }).conflicts).toEqual([]);
    expect(hub.check(P, C, { scope: [at('logout')], mapper: M, mode: 'exclusive' }).conflicts.map((c) => c.claim_id)).toEqual(['C-2']);
    expect(hub.check(P, C, { scope: [at('logout')], mapper: M2, mode: 'shared' }).conflicts.map((c) => c.claim_id)).toEqual(['C-1']);
    // And it agrees with the request itself.
    const real = hub.claim(P, C, sym(['login', 'logout'], { mode: 'auto' }));
    expect(real.conflicts.map((c) => [c.claim_id, c.scope])).toEqual(hub.check(P, C, sym(['login', 'logout'], { mode: 'auto' })).conflicts.map((c) => [c.claim_id, c.scope]));
    expect(hub.check(P, C, {}).conflicts).toEqual([]);
    expect(errorOf(() => hub.check(P, C, { scope: 'src/auth.ts' as never })).code).toBe('bad_request');
  });

  it('claim events carry the scope and the mapper', () => {
    const { hub, events, advance } = setup();
    const a = hub.claim(P, A, sym(['login'])).claim!;
    hub.claim(P, B, sym(['login', 'logout'], { queue: true }));
    hub.claim(P, C, { files: ['x.ts'] });
    hub.release(P, A, { claim_id: a.id });
    advance(61_000);
    hub.sweep();
    const claimEvents = events.filter((e) => e.type.startsWith('claim.')).map((e) => [e.type, e.data.claim_id, e.data.scope, e.data.mapper, e.data.files]);
    expect(claimEvents).toEqual([
      ['claim.granted', 'C-1', [at('login')], M, [AUTH]],
      ['claim.queued', 'C-2', [at('login'), at('logout')], M, [AUTH]],
      ['claim.granted', 'C-3', [{ file: 'x.ts' }], null, ['x.ts']],
      ['claim.released', 'C-1', [at('login')], M, [AUTH]],
      ['claim.granted', 'C-2', [at('login'), at('logout')], M, [AUTH]],
      ['claim.expired', 'C-2', [at('login'), at('logout')], M, [AUTH]],
      ['claim.expired', 'C-3', [{ file: 'x.ts' }], null, ['x.ts']],
    ]);
  });
});

describe('symbol-scope holds and the queue', () => {
  const admitBody = (lease: { lease_claim_id: string; epoch: string }, scope: ScopeEntry[], mapper: string) =>
    ({ lease, base_sha: sha('0'), files: [AUTH], scope, mapper, protected: [], required: [], waits_for: null, warnings: [] }) as never;

  it('a waiter for a symbol a hold no longer covers is granted once admission trims it', () => {
    const { hub, events } = setup();
    const task = hub.createTask(P, A, { title: 'Let login take an options object' });
    hub.takeTask(P, A, task.id);
    hub.claim(P, A, sym(['login', 'logout'])); // C-1
    const waiter = hub.claim(P, B, sym(['logout'], { queue: true })).claim!; // C-2
    const queued = hub.land(P, A, { task_id: task.id, commit: sha('1'), queue: true, files: [AUTH], scope: [at('login'), at('logout')], mapper: M });
    const hold = queued.held[0];
    expect(hold).toMatchObject({ landing_id: 'L-1', scope: [at('login'), at('logout')], mapper: M });
    expect(hub.getClaim(P, waiter.id).status).toBe('queued');
    // The lander maps the change exactly: it touches login only.
    const { lease } = takeLease(hub);
    hub.admitLanding(P, LANDER, 'L-1', admitBody(lease, [at('login')], M), LANDER_AUTH);
    expect(hub.getClaim(P, hold.id)).toMatchObject({ status: 'active', scope: [at('login')] });
    expect(hub.getClaim(P, waiter.id).status).toBe('active');
    const trim = events.find((e) => e.type === 'claim.released' && e.data.claim_id === hold.id)!;
    expect(trim.data).toMatchObject({ files: [], partial: true, scope: [at('logout')], mapper: M });
  });

  it("a hold re-made under the lander's mapper is compared by it from then on", () => {
    const { hub, events } = setup();
    // The adapter mapped the change under another version than the lander's.
    const queued = hub.land(P, A, { commit: sha('1'), queue: true, files: [AUTH], scope: [at('login')], mapper: M2 });
    const hold = queued.held[0];
    const waiter = hub.claim(P, B, sym(['logout'], { queue: true }));
    expect(waiter).toMatchObject({ status: 'queued', conflicts: [{ claim_id: hold.id, landing_id: 'L-1', scope: [at('login')] }] });
    const { lease } = takeLease(hub);
    hub.admitLanding(P, LANDER, 'L-1', admitBody(lease, [at('login')], M), LANDER_AUTH);
    expect(hub.getClaim(P, hold.id)).toMatchObject({ scope: [at('login')], mapper: M });
    expect(hub.getClaim(P, waiter.claim!.id).status).toBe('active');
    // The hold says it is now held under the new mapper.
    expect(events.filter((e) => e.type === 'claim.granted' && e.data.claim_id === hold.id).map((e) => e.data.mapper)).toEqual([M2, M]);
  });

  it("another agent's hold on a symbol blocks that symbol only", () => {
    const { hub } = setup();
    const queued = hub.land(P, A, { commit: sha('1'), queue: true, files: [AUTH], scope: [at('login')], mapper: M });
    expect(hub.claim(P, B, sym(['logout'])).status).toBe('granted');
    expect(hub.claim(P, B, sym(['login']))).toMatchObject({ status: 'denied', conflicts: [{ landing_id: 'L-1', scope: [at('login')] }] });
    // The guard sees the hold on login, not on logout.
    expect(hub.check(P, C, { scope: [at('login')], mapper: M }).conflicts.map((c) => c.claim_id)).toEqual([queued.held[0].id]);
    expect(hub.check(P, C, { scope: [at('logout')], mapper: M }).conflicts.map((c) => c.holder)).toEqual([B]);
    // Another agent's change to the file passes the gate unless it touches held code.
    expect(errorOf(() => hub.land(P, C, { commit: sha('2'), queue: true, files: [AUTH], scope: [at('login')], mapper: M })).code).toBe('claim_conflict');
    expect(hub.land(P, C, { commit: sha('2'), queue: true, files: [AUTH], scope: [at('refresh')], mapper: M }).landing).toMatchObject({ status: 'submitted', id: 'L-2' });
  });
});

// ------------------------------------------------------- property tests

/** A small seeded PRNG (mulberry32), so a failure names a seed that reproduces it. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = ['a.ts', 'b.ts'];
const SYMBOLS = [undefined, IMPORTS, TOPLEVEL, 'A', 'A.m', 'A.m.x', 'A.n', 'Ax', 'B', 'B.m'];
const MAPPERS = [null, M, M2];

function generator(seed: number, files: readonly string[] = FILES) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const entry = (): ScopeEntry => {
    const symbol = pick(SYMBOLS);
    return symbol === undefined ? { file: pick(files) } : { file: pick(files), symbol };
  };
  const scope = (max = 3) => Array.from({ length: 1 + Math.floor(r() * max) }, entry);
  /** Any claim a store may hold: Phase 1 rows have symbols with no mapper. */
  const stored = (max = 3): ScopedLike & { scope: ScopeEntry[] } => ({ scope: scope(max), mapper: pick(MAPPERS) });
  /** A request the hub accepts: symbols only with a mapper. */
  const request = (): { scope: ScopeEntry[]; mapper: string | null } => {
    const mapper = pick(MAPPERS);
    const s = scope();
    return { scope: mapper === null ? s.map((e) => ({ file: e.file })) : s, mapper };
  };
  return { entry, stored, request, pick };
}

const overlaps = (a: ScopedLike, b: ScopedLike) => overlappingEntries(a, b).length > 0;
const sharesFile = (a: ScopedLike, b: ScopedLike) => a.scope.some((x) => b.scope.some((y) => x.file === y.file));

describe('symbol-scope properties (seeded)', () => {
  const SEED = 0x5eed;

  it('overlap is symmetric, covers implies overlaps, and a mapper mismatch is file-level (contract functions)', () => {
    const g = generator(SEED);
    for (let i = 0; i < 20_000; i++) {
      const x = g.entry();
      const y = g.entry();
      expect(entriesOverlap(x, y), `${i}: ${JSON.stringify([x, y])}`).toBe(entriesOverlap(y, x));
      // @imports covers itself (a renewal) but never overlaps another @imports (§1.10 rule 3).
      if (entryCovers(x, y)) expect(entriesOverlap(x, y) || (x.symbol === IMPORTS && y.symbol === IMPORTS), `${i}: ${JSON.stringify([x, y])}`).toBe(true);

      const a = g.stored();
      const b = g.stored();
      const what = `${i}: ${JSON.stringify([a, b])}`;
      expect(overlaps(a, b), what).toBe(overlaps(b, a));
      if (!comparable(a, b)) expect(overlaps(a, b), what).toBe(sharesFile(a, b));
      const w = g.entry();
      const wm = g.pick(MAPPERS);
      if (claimCovers(a, w, wm) && !overlaps({ scope: [w], mapper: wm }, a)) {
        expect([w.symbol, comparable(a, { scope: [], mapper: wm })], `${i}: ${JSON.stringify([a, w, wm])}`).toEqual([IMPORTS, true]);
      }
    }
  });

  it("the hub's indexed overlap helpers give exactly the contract's overlappingEntries, for small and large scopes", () => {
    const g = generator(SEED + 3, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']);
    for (let i = 0; i < 4000; i++) {
      const a = g.stored(i % 4 === 0 ? 60 : i % 4 === 1 ? 12 : 3);
      const b = g.stored(i % 4 === 2 ? 60 : 4);
      const what = `${i}: ${JSON.stringify([a, b])}`;
      expect(overlapping(a, b), what).toEqual(overlappingEntries(a, b));
      expect(scopesOverlap(a, b), what).toBe(overlappingEntries(a, b).length > 0);
    }
  });

  it('the hub denies exactly what overlaps, in either order, and names the overlapping entries', () => {
    const { hub } = setup();
    const g = generator(SEED + 1);
    for (let i = 0; i < 300; i++) {
      const a = `a${i}/x`;
      const b = `b${i}/x`;
      const x = g.request();
      const y = g.request();
      const what = `${i}: ${JSON.stringify([x, y])}`;
      const place = (ns: string, req: { scope: ScopeEntry[]; mapper: string | null }) => ({ scope: req.scope.map((e) => ({ ...e, file: `${ns}/${e.file}` })), mapper: req.mapper });
      const ask = (ns: string, req: { scope: ScopeEntry[]; mapper: string | null }): ClaimRequest => {
        const { scope, mapper } = place(ns, req);
        return mapper ? { scope, mapper } : { scope };
      };
      const want = overlaps(x, y);

      // X first, then Y; then, on other files, Y first, then X.
      const held = hub.claim(P, a, ask(`r${i}/xy`, x));
      expect(held.status, what).toBe('granted');
      const second = hub.claim(P, b, ask(`r${i}/xy`, y));
      expect(second.status, what).toBe(want ? 'denied' : 'granted');
      if (want) expect(second.conflicts.map((c) => c.scope), what).toEqual([overlappingEntries(place(`r${i}/xy`, y), held.claim!)]);
      expect(hub.claim(P, b, ask(`r${i}/yx`, y)).status, what).toBe('granted');
      expect(hub.claim(P, a, ask(`r${i}/yx`, x)).status, what).toBe(want ? 'denied' : 'granted');

      // Covers implies overlaps: a request X's holder renews is one another agent is denied, unless all it names is @imports.
      const mine = hub.claim(P, a, ask(`r${i}/cover`, x)).claim!;
      const renewed = hub.claim(P, a, ask(`r${i}/cover`, y)).renewed;
      expect(renewed, what).toBe(y.scope.every((e) => claimCovers(mine, { ...e, file: `r${i}/cover/${e.file}` }, y.mapper)));
      if (renewed) {
        const other = hub.claim(P, b, ask(`r${i}/cover`, y));
        expect(other.status === 'denied' || y.scope.every((e) => e.symbol === IMPORTS), what).toBe(true);
      }
    }
  });

  it('a stored claim without a mapper conflicts with every request on its files', () => {
    const { hub, store, clock } = setup();
    const g = generator(SEED + 2);
    for (let i = 0; i < 300; i++) {
      const x = g.stored();
      const y = g.request();
      const ns = (e: ScopeEntry) => ({ ...e, file: `r${i}/${e.file}` });
      const t = clock.t;
      store.insertClaim({
        id: `C-${100_000 + i}`, project: P, holder: `a${i}/x`, task_id: null, scope: x.scope.map(ns), mode: 'exclusive', intent: 'stored', base_commit: null, status: 'active',
        created_at: t, granted_at: t, expires_at: t + 60_000, ttl_ms: 60_000, heartbeat_interval_ms: 15_000, ended_at: null, end_reason: null, landing_id: null, mapper: null,
      });
      const r = hub.claim(P, `b${i}/x`, { scope: y.scope.map(ns), ...(y.mapper ? { mapper: y.mapper } : {}) });
      expect(r.status, `${i}: ${JSON.stringify([x, y])}`).toBe(sharesFile(x, y) ? 'denied' : 'granted');
    }
  });
});

// ------------------------------------------------------- races

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function startHub() {
  const server = await startServer({ hub: new Hub({ store: new SqliteStore(':memory:') }), port: 0 });
  servers.push(server);
  return server;
}

async function api(base: string, method: string, route: string, body: unknown, agent?: string) {
  const res = await fetch(`${base}/v1/p/demo${route}`, {
    method,
    headers: { ...(agent ? { 'x-hub-agent': agent } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe('claim races on a contended symbol', () => {
  it('two concurrent claims on one symbol over HTTP: exactly one is granted, and a disjoint symbol is granted beside it', async () => {
    const s = await startHub();
    const [a, b, c] = await Promise.all([
      api(s.url, 'POST', '/claims', sym(['login'], { intent: 'a' }), A),
      api(s.url, 'POST', '/claims', sym(['login'], { intent: 'b' }), B),
      api(s.url, 'POST', '/claims', sym(['logout'], { intent: 'c' }), C),
    ]);
    expect([a.json.status, b.json.status].sort()).toEqual(['denied', 'granted']);
    expect(c.json.status).toBe('granted');
    const loser = a.json.status === 'denied' ? a.json : b.json;
    expect(loser.conflicts).toEqual([expect.objectContaining({ holder: a.json.status === 'granted' ? A : B, scope: [at('login')] })]);
  });

  it('thirty concurrent clients on one symbol over HTTP: exactly one is granted; on thirty symbols of the file, all are', async () => {
    const s = await startHub();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => api(s.url, 'POST', '/claims', sym(['Session.refresh']), `dev${i}/agent-${i}`)));
    expect(results.filter((r) => r.json.status === 'granted')).toHaveLength(1);
    expect(results.filter((r) => r.json.status === 'denied')).toHaveLength(29);
    const spread = await Promise.all(Array.from({ length: 30 }, (_, i) => api(s.url, 'POST', '/claims', sym([`Session.m${i}`]), `dev${i}/agent-${i}`)));
    expect(spread.map((r) => r.json.status)).toEqual(Array(30).fill('granted'));
    const { json } = await api(s.url, 'GET', '/claims', undefined);
    expect(json.claims).toHaveLength(31);
  });

  it('separate processes sharing one database, on one symbol: exactly one is granted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-symbol-race-'));
    try {
      const db = path.join(dir, 'hub.db');
      new SqliteStore(db).close(); // create the schema up front
      const startAt = Date.now() + 1500;
      const runs = Array.from(
        { length: 6 },
        (_, i) =>
          new Promise<{ agent: string; status: string }>((resolve, reject) => {
            const child = spawn(process.execPath, [path.join(here, 'fixtures', 'race-child.mjs'), db, `dev${i}/agent-${i}`, String(startAt), AUTH, '', 'login', M]);
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => (out += d));
            child.stderr.on('data', (d) => (err += d));
            child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`))));
          }),
      );
      const results = await Promise.all(runs);
      expect(results.filter((r) => r.status === 'granted')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'denied')).toHaveLength(5);
      const store = new SqliteStore(db);
      try {
        expect(store.claimsForFiles('race', [AUTH], ['active']).map((c: Claim) => [c.scope, c.mapper])).toEqual([[[at('login')], M]]);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
