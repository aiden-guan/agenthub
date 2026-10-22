import { afterEach, describe, expect, it } from 'vitest';
import { LANDER_LEASE_KEY } from '@agenthub/contract';
import { Hub, SqliteStore, startServer, type RunningServer } from '@agenthub/hub';
import { HubClient } from '../src/hub-client.js';
import { Lease } from '../src/lease.js';
import { systemClock, type Clock, type HubPort } from '../src/ports.js';
import { override } from './helpers.js';
import { waitFor } from './scenario.js';

// The lander lease (design §1.5, §2.2.3): a claim on LANDER_LEASE_KEY with
// queue: true; a second process stands by, heartbeating its queued claim and
// long-polling for the grant; self-fencing reads both clocks.

const P = 'acme/web';
let front: RunningServer | null = null;
const leases: Lease[] = [];

afterEach(async () => {
  for (const l of leases.splice(0)) l.abandon();
  await front?.close();
  front = null;
});

function lease(agent: string, o: { clock?: Clock; ttlMs?: number } = {}): Lease {
  const l = new Lease({ hub: new HubClient({ url: front!.url, project: P, agent }), clock: o.clock ?? systemClock, agent, ttlMs: o.ttlMs ?? 1_000, intent: `lander on ${agent}`, log: () => {}, retryMs: 50 });
  leases.push(l);
  return l;
}

describe('Lease', () => {
  it('one active lander, one standby that heartbeats its place and is promoted when the active one releases', async () => {
    const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000 });
    front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 50 });
    const one = lease('lander/box-1-aaaa');
    const two = lease('lander/box-2-bbbb');
    expect(await one.acquire()).toBe(true);
    expect(one.auth()).toEqual({ lease_claim_id: one.claim, epoch: hub.epoch });
    const waiting = two.acquire();
    await waitFor(() => two.standby, 'the second lander to stand by');
    const claims = hub.listClaims(P).filter((c) => c.scope[0]?.file === LANDER_LEASE_KEY);
    expect(claims.map((c) => [c.holder, c.status])).toEqual([
      ['lander/box-1-aaaa', 'active'],
      ['lander/box-2-bbbb', 'queued'],
    ]);
    // The standby's queued claim outlives its ttl: it heartbeats.
    await new Promise((r) => setTimeout(r, 1_300));
    expect(hub.getClaim(P, claims[1]!.id).status).toBe('queued');
    expect(two.held).toBe(false);
    await one.release();
    expect(await waiting).toBe(true);
    expect(two.held).toBe(true);
    expect(two.claim).toBe(claims[1]!.id);
    expect(hub.landerStatus(P).lease?.holder).toBe('lander/box-2-bbbb');
  });

  it('a lease that lapses is lost: its signal aborts, and claiming again gives a new claim', async () => {
    const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000 });
    front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 50 });
    const l = lease('lander/box-1-cccc', { ttlMs: 400 });
    expect(await l.acquire()).toBe(true);
    const first = l.claim!;
    const signal = l.signal;
    // Ended at the hub behind the lander's back (as an expiry does).
    hub.store.updateClaim(P, first, { expires_at: hub.now() - 1 });
    await waitFor(() => signal.aborted, 'the lease to be lost', 5_000);
    expect(l.held).toBe(false);
    expect(() => l.auth()).toThrow();
    expect(await l.acquire()).toBe(true);
    expect(l.claim).not.toBe(first);
  });

  it('self-fencing: fresh only while the last acknowledgement is younger than ttl/3 on both clocks', async () => {
    const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000 });
    front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 200 });
    const t = { wall: 1_000_000, mono: 5_000 };
    const clock: Clock = { now: () => t.wall, monotonic: () => t.mono, sleep: systemClock.sleep };
    const l = lease('lander/box-1-dddd', { clock, ttlMs: 60_000 });
    expect(await l.acquire()).toBe(true);
    expect(l.fresh()).toBe(true);
    t.mono += 20_001;
    expect(l.fresh()).toBe(false);
    t.mono -= 20_001;
    t.wall += 20_001;
    expect(l.fresh()).toBe(false);
    // A heartbeat acknowledgement makes it fresh again.
    expect(await l.renew()).toBe(true);
    expect(l.fresh()).toBe(true);
  });

  it('self-fencing dates an acknowledgement from when its heartbeat was sent, not from when the answer came', async () => {
    const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000 });
    front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 200 });
    const t = { wall: 1_000_000, mono: 5_000 };
    const advance = (ms: number): void => {
      t.wall += ms;
      t.mono += ms;
    };
    const clock: Clock = { now: () => t.wall, monotonic: () => t.mono, sleep: systemClock.sleep };
    const agent = 'lander/box-1-eeee';
    const client = new HubClient({ url: front.url, project: P, agent });
    // Every heartbeat answer takes `delay` to come back.
    let delay = 15_000;
    const slow = override<HubPort>(client, {
      async heartbeat(req) {
        const r = await client.heartbeat(req);
        advance(delay);
        return r;
      },
    });
    const l = new Lease({ hub: slow, clock, agent, ttlMs: 60_000, intent: 'lander on box-1', log: () => {}, retryMs: 50 });
    leases.push(l);
    expect(await l.acquire()).toBe(true);
    advance(10_000);
    // Sent at +10 s, answered at +25 s: the hub renewed the lease at most at +10 s, so it is 15 s old (limit 20 s).
    expect(await l.renew()).toBe(true);
    expect(l.fresh()).toBe(true);
    advance(6_000);
    // 21 s after the request was sent (only 6 s after the answer): not fresh.
    expect(l.fresh()).toBe(false);
    // An answer that took longer than ttl/3 is no fresh acknowledgement at all.
    delay = 25_000;
    expect(await l.renew()).toBe(false);
    expect(l.fresh()).toBe(false);
    expect(l.held).toBe(true);
  });
});
