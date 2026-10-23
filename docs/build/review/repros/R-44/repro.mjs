// Repro for R-44: after the hub comes back on a new database (new epoch), the
// feed of a long-running `hub mcp` forgets the old events and claims
// (Feed.resetHistory) but keeps `noticed`, `suppressed` and `mine`, all keyed
// by the bare landing id. Landing ids start again at L-1 on the new database
// (design §4.5), so:
//   - trunk.moved for ANOTHER agent's new L-1 is skipped as "its own" because
//     `mine` still has the old L-1 (feed.ts: `!(id && this.mine.has(id))`);
//   - the agent's own new L-2 coming back is not announced because `noticed`
//     still has `failed:L-2` from the old database (feed.ts once()).
//
// The script runs a real Hub (SqliteStore ':memory:') behind the real server on
// a local port, plays the lander over HTTP with the lander token (no git, no
// network, no API key), and follows maya with two Feeds:
//   - `veteran`: started on the first database and lived through the reset
//     (the `hub mcp` session the finding is about);
//   - `fresh`: started on the second database (control: what the notices are
//     when no stale state is carried over).
// Both see exactly the same events on the second database. The defect is
// present iff `fresh` gets a notice that `veteran` does not.
//
// Exit code: 1 when the defect is present, 0 when the veteran feed gives the
// same landing notices as the fresh one, 2 on a setup error.
//
// Run:
//   AGENTHUB_ROOT=/home/user/agenthub node \
//     /tmp/claude-0/-home-user-agenthub/8b8b52f8-98ca-5efe-ba8a-d267c5f2c650/scratchpad/work-p23/review/repro-R-44/repro.mjs

import path from 'node:path';

const ROOT = process.env.AGENTHUB_ROOT ?? '/home/user/agenthub';
const { Hub, SqliteStore, startServer } = await import(path.join(ROOT, 'packages/hub/dist/index.js'));
const { HubClient } = await import(path.join(ROOT, 'packages/adapter/dist/client.js'));
const { Feed } = await import(path.join(ROOT, 'packages/adapter/dist/feed.js'));
const { LANDER_LEASE_KEY } = await import(path.join(ROOT, 'packages/contract/dist/index.js'));

const PROJECT = 'demo';
const MAYA = 'maya/claude-1';
const SAM = 'sam/claude-1';
const LANDER = 'lander/testbox-4242-a1b2';
const LANDER_TOKEN = 'lander-secret-for-tests';
const sha = (c) => c.repeat(40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, what, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function hubOn(port) {
  const hub = new Hub({ store: new SqliteStore(':memory:') });
  const srv = await startServer({ hub, port, sweepIntervalMs: 50, landerToken: LANDER_TOKEN });
  return { hub, srv };
}

const cfgFor = (url, agent) => ({ url, agent, project: PROJECT, token: null, failClosed: false, timeoutMs: 3000, root: null, configFiles: [], projectSource: 'env', warnings: [] });

function report(extra = {}) {
  return { message: '', resolved_by: 'clean', files_via: [], conflicts: [], check: null, resolver: null, next_steps: [], warnings: [], foreign_commits: [], timings: null, ...extra };
}

/** The lander's side over HTTP (as packages/adapter/test/landing-hub.ts TestLander does). */
class Lander {
  constructor(url) {
    this.url = url;
    this.lease = null;
  }
  async call(method, p, body) {
    const res = await fetch(`${this.url}/v1/p/${PROJECT}${p}`, {
      method,
      headers: { 'x-hub-agent': LANDER, 'x-hub-lander-token': LANDER_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`lander ${method} ${p}: HTTP ${res.status} ${JSON.stringify(data)}`);
    return data;
  }
  async takeLease() {
    const r = await this.call('POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 600_000, intent: 'lander on testbox' });
    const { epoch } = await (await fetch(`${this.url}/v1/p/${PROJECT}/events?wait_ms=0`)).json();
    this.lease = { lease_claim_id: r.claim.id, epoch };
    return epoch;
  }
  admit(id, body) {
    return this.call('POST', `/landings/${id}/admit`, { lease: this.lease, files: [], scope: null, mapper: null, protected: [], required: [], waits_for: null, warnings: [], ...body });
  }
  async landIt(id, { base, candidate, files }) {
    await this.admit(id, { base_sha: base, files });
    const next = await this.call('POST', '/lander/next', { lease: this.lease });
    if (next.landing?.id !== id) throw new Error(`next picked ${next.landing?.id}, not ${id}`);
    const attempt = next.landing.attempt;
    const adv = (b) => this.call('POST', `/landings/${id}/advance`, { lease: this.lease, attempt, ...b });
    await adv({ to: 'running', phase: 'merging', deadline_ms: 600_000, trunk_base: base });
    await adv({ to: 'running', phase: 'checking', deadline_ms: 600_000 });
    await adv({ to: 'running', phase: 'pushing', candidate, candidate_ref: `refs/agenthub/cand/00000000/${id}/${candidate.slice(0, 12)}`, trunk_base: base, tree: candidate, required: [] });
    await adv({ to: 'landed', trunk_sha: candidate, base_sha: base, files, report: report({ message: `${id} landed.` }), also_landed: [], symbol_changes: [] });
  }
  async failIt(id, { base, files, code }) {
    await this.admit(id, { base_sha: base, files });
    const next = await this.call('POST', '/lander/next', { lease: this.lease });
    if (next.landing?.id !== id) throw new Error(`next picked ${next.landing?.id}, not ${id}`);
    const attempt = next.landing.attempt;
    const adv = (b) => this.call('POST', `/landings/${id}/advance`, { lease: this.lease, attempt, ...b });
    await adv({ to: 'running', phase: 'merging', deadline_ms: 600_000, trunk_base: base });
    await adv({ to: 'failed', code, report: report({ message: 'The checks failed.' }) });
  }
}

const cleanups = [];
async function cleanup() {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {
      /* best effort */
    }
  }
}

function startFeed(url, name) {
  const logs = [];
  const feed = new Feed(new HubClient(cfgFor(url, MAYA)), { info: { client: 'mcp' }, log: (m) => logs.push(`[${name}] ${m}`) });
  feed.start();
  cleanups.push(() => feed.stop());
  return { feed, logs, got: [] };
}

/** Drain a feed's notices into its `got` list after its background notice jobs finish. */
async function drain(f) {
  await f.feed.settled();
  f.got.push(...f.feed.takeNotices());
}

async function main() {
  // ---------------------------------------------------------------- database 1
  const first = await hubOn(0);
  const port = first.srv.port;
  const url = first.srv.url;
  console.log(`hub on ${url}, database 1 epoch ${first.hub.epoch}`);
  const lander1 = new Lander(url);
  await lander1.takeLease();
  const maya1 = new HubClient(cfgFor(url, MAYA));

  const veteran = startFeed(url, 'veteran');
  await until(() => veteran.feed.connected, 'the veteran feed to connect');

  // maya's L-1 lands on database 1.
  const q1 = await maya1.land({ queue: true, commit: sha('1'), branch: 'agent-a', summary: 'users list', files: ['src/users.ts'] });
  if (q1.landing.id !== 'L-1') throw new Error(`expected L-1, got ${q1.landing.id}`);
  await lander1.landIt('L-1', { base: sha('0'), candidate: sha('2'), files: ['src/users.ts'] });
  // maya's L-2 comes back on database 1.
  const q2 = await maya1.land({ queue: true, commit: sha('3'), branch: 'agent-a2', summary: 'more users', files: ['src/users.ts'] });
  if (q2.landing.id !== 'L-2') throw new Error(`expected L-2, got ${q2.landing.id}`);
  await lander1.failIt('L-2', { base: sha('2'), files: ['src/users.ts'], code: 'checks_failed' });

  await until(async () => (await veteran.feed.waitFor(0, (e) => e.type === 'landing.failed', 0)).events.length > 0, 'veteran to see landing.failed on db 1');
  await drain(veteran);
  console.log('database 1 notices (veteran):');
  for (const n of veteran.got) console.log(`  - ${n}`);
  const db1Notices = veteran.got.splice(0);
  if (!db1Notices.some((n) => n.startsWith('L-1 landed on main')) || !db1Notices.some((n) => n.startsWith('L-2 came back (checks_failed)'))) {
    throw new Error('setup: the veteran feed did not announce L-1 landed and L-2 came back on database 1');
  }

  // ---------------------------------------------------------------- database 2, same port
  await first.srv.close();
  await sleep(100);
  const second = await hubOn(port);
  cleanups.push(() => second.srv.close());
  console.log(`hub back on ${second.srv.url}, database 2 epoch ${second.hub.epoch}`);
  if (second.hub.epoch === first.hub.epoch) throw new Error('setup: the second database has the same epoch');

  await until(() => veteran.feed.restarts === 1 && veteran.feed.epoch === second.hub.epoch, 'veteran to see the new epoch and reset');
  await until(() => veteran.feed.connected, 'veteran to reconnect');
  await drain(veteran); // the reset notice, if any (no claims were held, so none)
  veteran.got.splice(0);

  const fresh = startFeed(second.srv.url, 'fresh');
  await until(() => fresh.feed.connected, 'the fresh feed to connect');

  const lander2 = new Lander(second.srv.url);
  await lander2.takeLease();
  const maya2 = new HubClient(cfgFor(second.srv.url, MAYA));
  const sam2 = new HubClient(cfgFor(second.srv.url, SAM));

  // sam queues L-1 on database 2, touching src/auth.ts (its landing holds the file).
  const s1 = await sam2.land({ queue: true, commit: sha('4'), branch: 'agent-b', summary: 'auth prefix', files: ['src/auth.ts'] });
  if (s1.landing.id !== 'L-1') throw new Error(`expected sam's landing to be L-1 on db 2, got ${s1.landing.id}`);
  // maya claims src/auth.ts: queued behind sam's landing hold, granted when it lands.
  const c = await maya2.claim({ files: ['src/auth.ts'], intent: 'maya edits auth', queue: true });
  console.log(`maya's claim on db 2: ${c.claim.id} ${c.status}`);
  await until(async () => (await veteran.feed.waitFor(0, (e) => e.type === 'claim.queued' || e.type === 'claim.granted', 0)).events.length > 0, 'veteran to see maya claim');
  await until(async () => (await fresh.feed.waitFor(0, (e) => e.type === 'claim.queued' || e.type === 'claim.granted', 0)).events.length > 0, 'fresh to see maya claim');

  // sam's L-1 lands: trunk.moved {landing_id: L-1, files: [src/auth.ts]}.
  await lander2.landIt('L-1', { base: sha('5'), candidate: sha('6'), files: ['src/auth.ts'] });
  await until(async () => (await veteran.feed.waitFor(0, (e) => e.type === 'trunk.moved', 0)).events.length > 0, 'veteran to see trunk.moved');
  await until(async () => (await fresh.feed.waitFor(0, (e) => e.type === 'trunk.moved', 0)).events.length > 0, 'fresh to see trunk.moved');
  await drain(veteran);
  await drain(fresh);

  // maya's new L-2 on database 2 comes back.
  const m2 = await maya2.land({ queue: true, commit: sha('7'), branch: 'agent-a', summary: 'auth trim', files: ['src/users.ts'] });
  if (m2.landing.id !== 'L-2') throw new Error(`expected maya's landing to be L-2 on db 2, got ${m2.landing.id}`);
  await lander2.failIt('L-2', { base: sha('6'), files: ['src/users.ts'], code: 'checks_failed' });
  await until(async () => (await veteran.feed.waitFor(0, (e) => e.type === 'landing.failed', 0)).events.length > 0, 'veteran to see landing.failed on db 2');
  await until(async () => (await fresh.feed.waitFor(0, (e) => e.type === 'landing.failed', 0)).events.length > 0, 'fresh to see landing.failed on db 2');
  await sleep(200);
  await drain(veteran);
  await drain(fresh);

  console.log('database 2 notices, fresh feed (control):');
  for (const n of fresh.got) console.log(`  - ${n}`);
  console.log('database 2 notices, veteran feed (lived through the reset):');
  for (const n of veteran.got) console.log(`  - ${n}`);

  const trunkNotice = (n) => n.startsWith('trunk moved: L-1 changed src/auth.ts, which you hold');
  const failedNotice = (n) => n.startsWith('L-2 came back (checks_failed)');
  if (!fresh.got.some(trunkNotice) || !fresh.got.some(failedNotice)) {
    throw new Error('setup: the control (fresh) feed did not give the expected notices, so the scenario did not run as intended');
  }
  const problems = [];
  if (!veteran.got.some(trunkNotice)) problems.push("trunk.moved for sam's new L-1 under src/auth.ts (held by maya) was skipped as maya's own (mine still has the old L-1)");
  if (!veteran.got.some(failedNotice)) problems.push("maya's new L-2 came back with no notice (noticed still has failed:L-2 from database 1)");
  const internals = { mine: [...veteran.feed.mine], noticed: [...veteran.feed.noticed].filter((k) => !k.startsWith('trunk:')), suppressed: [...veteran.feed.suppressed] };
  console.log(`veteran feed internals after the reset: ${JSON.stringify(internals)}`);
  if (problems.length) {
    console.log('\nDEFECT PRESENT (R-44):');
    for (const p of problems) console.log(`  - ${p}`);
    return 1;
  }
  console.log('\nno defect: the feed that lived through the reset gives the same landing notices as a fresh one');
  return 0;
}

let code = 2;
try {
  code = await main();
} catch (err) {
  console.error(`setup error: ${err.stack ?? err}`);
  code = 2;
} finally {
  await cleanup();
}
process.exit(code);
