import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANDER_LEASE_KEY } from '@agenthub/contract';
import { describe, expect, it } from 'vitest';
import { NO_AUTH, SqliteStore, type LandingAdmitRequest } from '../src/index.js';
import { A, B, LANDER, LANDER_AUTH, P, STANDBY, errorOf, report, setup, sha, takeLease } from './landing-setup.js';

// H3 (design §1.5): the lander lease is an ordinary claim on the reserved key,
// granted only with lander credentials, and every lander write is fenced by
// (lease claim id, hub epoch) after the expiry pre-step. When the lease ends,
// its running landing is requeued (T9 lander_lost) or left in doubt (T10).

const here = path.dirname(fileURLToPath(import.meta.url));

function codeOf(fn: () => unknown): [string, number] {
  const err = errorOf(fn);
  return [err.code, err.status];
}

/** A takes a task, claims `files` and queues `commit` for it; returns the landing id. */
function submit(hub: ReturnType<typeof setup>['hub'], files: string[], commit = sha('1')): string {
  const task = hub.createTask(P, A, { title: `work on ${files[0]}` });
  hub.takeTask(P, A, task.id);
  hub.claim(P, A, { files });
  return hub.land(P, A, { task_id: task.id, commit, queue: true, files }).landing.id;
}

function admitRequest(lease: { lease_claim_id: string; epoch: string }, files: string[]): LandingAdmitRequest {
  return { lease, base_sha: sha('0'), files, scope: null, mapper: null, protected: [], required: [], waits_for: null, warnings: [] };
}

describe('the lander lease (design §1.5)', () => {
  it('claims on the reserved key need lander credentials, and a lander may claim exactly the lease key, exclusive', () => {
    const { hub } = setup();
    const noCredentials = errorOf(() => hub.claim(P, LANDER, { files: [LANDER_LEASE_KEY] }));
    expect([noCredentials.code, noCredentials.status]).toEqual(['forbidden', 403]);
    expect(noCredentials.message).toContain('lander');
    expect(codeOf(() => hub.claim(P, A, { files: ['.git/agenthub/other'] }))).toEqual(['forbidden', 403]);
    expect(codeOf(() => hub.claim(P, LANDER, { files: [LANDER_LEASE_KEY, 'src/a.ts'] }, LANDER_AUTH))).toEqual(['forbidden', 403]);
    expect(codeOf(() => hub.claim(P, LANDER, { files: [LANDER_LEASE_KEY], mode: 'shared' }, LANDER_AUTH))).toEqual(['forbidden', 403]);
    expect(codeOf(() => hub.claim(P, LANDER, { files: [LANDER_LEASE_KEY], mode: 'auto' }, LANDER_AUTH))).toEqual(['forbidden', 403]);
    expect(codeOf(() => hub.claim(P, LANDER, { scope: [{ file: LANDER_LEASE_KEY, symbol: 'x' }], mapper: 'm1' }, LANDER_AUTH))).toEqual(['forbidden', 403]);
    expect(codeOf(() => hub.claim(P, LANDER, { files: ['.git/agenthub/other'] }, LANDER_AUTH))).toEqual(['forbidden', 403]);
    expect(hub.listClaims(P)).toEqual([]);

    const lease = takeLease(hub);
    expect(lease.status).toBe('granted');
    expect(lease.claim).toMatchObject({ holder: LANDER, status: 'active', mode: 'exclusive', scope: [{ file: LANDER_LEASE_KEY }], landing_id: null, ttl_ms: 60_000 });
    // Asking again renews it, as any claim.
    expect(hub.claim(P, LANDER, { files: [LANDER_LEASE_KEY] }, LANDER_AUTH)).toMatchObject({ status: 'granted', renewed: true, claim: { id: lease.claim.id } });
    // Other files are claimed as before.
    expect(hub.claim(P, A, { files: ['src/a.ts'] }).status).toBe('granted');
  });

  it('a second lander process is a standby: queued on the lease, not a lander until the lease ends, then promoted', () => {
    const { hub } = setup();
    const first = takeLease(hub);
    const second = takeLease(hub, STANDBY);
    expect([first.status, second.status]).toEqual(['granted', 'queued']);
    expect(hub.status(P, null).lander).toEqual({ holder: LANDER, claim_id: first.claim.id, expires_at: first.claim.expires_at, standby: [STANDBY] });
    expect(codeOf(() => hub.nextLanding(P, STANDBY, { lease: second.lease }, LANDER_AUTH))).toEqual(['not_lander', 409]);

    hub.release(P, LANDER, { claim_id: first.claim.id });
    expect(hub.getClaim(P, second.claim.id).status).toBe('active');
    expect(hub.nextLanding(P, STANDBY, { lease: second.lease }, LANDER_AUTH)).toMatchObject({ landing: null, resolve: false });
    expect(codeOf(() => hub.nextLanding(P, LANDER, { lease: first.lease }, LANDER_AUTH))).toEqual(['not_lander', 409]);
    expect(hub.status(P, null).lander).toMatchObject({ holder: STANDBY, claim_id: second.claim.id, standby: [] });
  });

  it("not_lander: a lapsed lease is never honoured, even before the sweeper runs; nor another holder's lease, a claim that isn't the lease, or another database's epoch", () => {
    const { hub, store, advance } = setup();
    const { lease } = takeLease(hub, LANDER, 1000);
    expect(hub.nextLanding(P, LANDER, { lease }, LANDER_AUTH)).toMatchObject({ landing: null, resolve: false, control: { paused: null } });
    expect(codeOf(() => hub.nextLanding(P, STANDBY, { lease }, LANDER_AUTH))).toEqual(['not_lander', 409]);
    expect(codeOf(() => hub.nextLanding(P, LANDER, { lease: { ...lease, epoch: '00000000-0000-4000-8000-000000000000' } }, LANDER_AUTH))).toEqual(['not_lander', 409]);
    const other = hub.claim(P, A, { files: ['src/x.ts'] }).claim!;
    expect(codeOf(() => hub.nextLanding(P, LANDER, { lease: { lease_claim_id: other.id, epoch: hub.epoch } }, LANDER_AUTH))).toEqual(['not_lander', 409]);
    expect(codeOf(() => hub.nextLanding(P, LANDER, { lease: { lease_claim_id: 'C-99', epoch: hub.epoch } }, LANDER_AUTH))).toEqual(['not_lander', 409]);

    advance(1000);
    // No sweep ran: the store still has the lease as active, but its time is up.
    expect(store.getClaim(P, lease.lease_claim_id)!.status).toBe('active');
    const lapsed = errorOf(() => hub.nextLanding(P, LANDER, { lease }, LANDER_AUTH));
    expect([lapsed.code, lapsed.status]).toEqual(['not_lander', 409]);
    expect(lapsed.message).toContain(lease.lease_claim_id);
    // Claiming again gives a new lease under a new id; the old one stays dead.
    const again = takeLease(hub, LANDER, 1000);
    expect(again.claim.id).not.toBe(lease.lease_claim_id);
    expect(hub.nextLanding(P, LANDER, { lease: again.lease }, LANDER_AUTH).landing).toBeNull();
    expect(codeOf(() => hub.nextLanding(P, LANDER, { lease }, LANDER_AUTH))).toEqual(['not_lander', 409]);
    expect(codeOf(() => hub.nextLanding(P, LANDER, { lease: { lease_claim_id: 5 } } as never, LANDER_AUTH))).toEqual(['bad_request', 400]);
  });

  it('every lander write needs lander credentials (403 forbidden)', () => {
    const { hub } = setup();
    const { lease } = takeLease(hub);
    const id = submit(hub, ['a.ts']);
    const calls: Array<() => unknown> = [
      () => hub.nextLanding(P, LANDER, { lease }),
      () => hub.admitLanding(P, LANDER, id, admitRequest(lease, ['a.ts'])),
      () => hub.advanceLanding(P, LANDER, id, { lease, attempt: 0, to: 'failed', code: 'not_pushed', report: report() }),
      () => hub.resolveLanding(P, LANDER, id, { lease, outcome: 'requeue', trunk_sha: sha('d') }),
      () => hub.reportTrunk(P, LANDER, { lease, from: null, to: sha('a'), commits: [], rewritten: false, policy: { keep_place_retries: 2, sendback_grace_min: 30, approval_timeout_hours: 24, claim_gate: 'fail' } }),
      () => hub.pauseLander(P, LANDER, { lease, reason: 'config_invalid', detail: 'x' }, NO_AUTH),
    ];
    for (const call of calls) expect(codeOf(call)).toEqual(['forbidden', 403]);
    expect(hub.getLanding(P, id).status).toBe('submitted');
  });

  it('endClaim runs the lease-end hook on release and on expiry: the running landing is requeued in its place (lander_lost), and fails past 3', () => {
    const { hub, events, advance } = setup();
    const id = submit(hub, ['a.ts']);
    let lease = takeLease(hub, LANDER, 1000);
    hub.admitLanding(P, LANDER, id, admitRequest(lease.lease, ['a.ts']), LANDER_AUTH);
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(hub.nextLanding(P, LANDER, { lease: lease.lease }, LANDER_AUTH).landing).toMatchObject({ id, attempt, lease_claim_id: lease.claim.id });
      const before = events.length;
      if (attempt % 2 === 1) {
        hub.release(P, LANDER, { claim_id: lease.claim.id });
        expect(events.slice(before).map((e) => [e.type, e.data.claim_id ?? e.data.reason])).toEqual([
          ['claim.released', lease.claim.id],
          ['landing.updated', 'requeued:lander_lost'],
        ]);
      } else {
        advance(1000);
        hub.sweep();
        expect(events[before].type).toBe('claim.expired');
      }
      const landing = hub.getLanding(P, id);
      if (attempt < 4) {
        expect(landing).toMatchObject({ status: 'queued', queue_seq: 1, lander: null, lease_claim_id: null, phase: null, retries: { lander_lost: attempt } });
        lease = takeLease(hub, LANDER, 1000);
      } else {
        expect(landing).toMatchObject({ status: 'failed', failure: { code: 'lander_lost' }, retries: { lander_lost: 4 } });
        expect(events.slice(before).map((e) => e.type)).toEqual(['claim.expired', 'claim.granted', 'task.updated', 'landing.failed']);
        expect(hub.listTasks(P)[0]).toMatchObject({ status: 'in_progress', owner: A });
      }
    }
    expect(events.filter((e) => e.type === 'landing.updated' && e.data.reason === 'requeued:lander_lost').map((e) => e.actor)).toEqual([null, null, null]);
  });

  it('a queue-mode land may not name reserved paths', () => {
    const { hub } = setup();
    expect(codeOf(() => hub.land(P, A, { commit: sha('1'), queue: true, files: [LANDER_LEASE_KEY] }))).toEqual(['forbidden', 403]);
    expect(codeOf(() => hub.land(P, B, { commit: sha('2'), queue: true, scope: [{ file: '.git/agenthub/x' }] }))).toEqual(['forbidden', 403]);
    expect(hub.status(P, null).queue).toEqual([]);
  });

  it('two OS processes racing the lease claim on one database file give exactly one active claim', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-lease-race-'));
    try {
      const db = path.join(dir, 'hub.db');
      new SqliteStore(db).close(); // the schema up front
      const startAt = Date.now() + 1500;
      const runs = [0, 1].map(
        (i) =>
          new Promise<{ agent: string; status: string; claim_id: string }>((resolve, reject) => {
            const child = spawn(process.execPath, [path.join(here, 'fixtures', 'race-child.mjs'), db, `lander/host${i}-${4000 + i}-ab0${i}`, String(startAt), LANDER_LEASE_KEY, 'lander']);
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => (out += d));
            child.stderr.on('data', (d) => (err += d));
            child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`))));
          }),
      );
      const results = await Promise.all(runs);
      expect(results.map((r) => r.status).sort()).toEqual(['granted', 'queued']);
      const store = new SqliteStore(db);
      try {
        const active = store.claimsForFiles('race', [LANDER_LEASE_KEY], ['active']);
        expect(active.map((c) => c.id)).toEqual([results.find((r) => r.status === 'granted')!.claim_id]);
        expect(store.claimsForFiles('race', [LANDER_LEASE_KEY], ['queued'])).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
