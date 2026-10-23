#!/usr/bin/env node
// R-15 reproduction: a `failed {lander_error}` send-back counts against
// keepPlaceRetries, so infrastructure failures cost the agent its queue place.
//
// Design §4.5 ("Disk full, git crash, a lander bug"): `failed {lander_error}` is
// "not caused by your change ... This kind of retry keeps the place without
// counting against keepPlaceRetries". §1.4 T1: a re-land inherits queue_seq
// while retry <= keep_place_retries (default 2). The hub's queueLanding
// (packages/hub/src/landings.ts, the retry chain) sets retry = failed.retry + 1
// for every failure code, so lander_error send-backs use up the place-keeping
// retries exactly like genuine ones.
//
// Everything is local: an in-process Hub (SQLite :memory:) served over HTTP on
// 127.0.0.1:0 with a lander token; the lander side is the lander's own
// HubClient (lander/dist/hub-client.js) holding the real lander lease and
// sending the same `advance {to: failed, code, report}` that the pipeline's
// Attempt.fail sends (and the `pause {config_invalid}` that Lander.step sends
// after three lander_errors in a row); the agents are plain HTTP clients with
// their x-hub-agent ids. Default policy (no lander trunk report):
// keep_place_retries = 2. No network, no API key, no git, no AI resolver.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// Exit 1: the defect is present (a chain whose genuine send-backs are within
// keepPlaceRetries still lost its place to a landing queued after it).
// Exit 0: it is not. Exit 2: the harness broke (the control, three genuine
// send-backs, did not behave as T1 specifies, or a request failed).

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, 'packages', rel)).href);

for (const k of Object.keys(process.env)) if (k.startsWith('HUB_') || k.startsWith('ANTHROPIC_')) delete process.env[k];

const { Hub, SqliteStore, startServer } = await imp('hub/dist/index.js');
const { HubClient: LanderHubClient } = await imp('lander/dist/hub-client.js');
const { LANDER_LEASE_KEY } = await imp('contract/dist/index.js');
const { failureReport } = await imp('lander/dist/messages.js');

const P = 'acme/web';
const MAYA = 'maya/claude-1';
const SAM = 'sam/claude-1';
const LANDER_ID = 'lander/build1-4821-9f3c';
const LANDER_TOKEN = 'r15-lander-token-0123456789abcdef';
const HUMAN = 'lee';
const KEEP = 2; // the default keep_place_retries (design §0.3 #16)
const MAX_LANDER_ERRORS = 3; // packages/lander/src/lander.ts
const HEX = '0123456789abcdef';

class HarnessError extends Error {}

/** The report the lander's Attempt.fail sends (lander/dist/messages.js failureReport, default config). */
function report(code, landing) {
  const s = { landingId: landing.id, taskId: landing.task_id, trunk: 'main', retry: landing.retry, keepPlaceRetries: KEEP, sendbackGraceMin: 30 };
  const parts = code === 'lander_error' ? { warnings: ['lander error: ENOSPC: no space left on device, write'] } : {};
  return failureReport(code, s, parts);
}

async function call(base, agent, method, route, body, extraHeaders = {}) {
  const headers = { 'x-hub-agent': agent, ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/v1/p/${encodeURIComponent(P)}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HarnessError(`${agent} ${method} ${route} -> HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/**
 * One chain: maya's landing (queue_seq 1) is ahead of sam's (queue_seq 2). The
 * lander sends maya's landing back once per entry of `codes`; after each
 * send-back maya lands the task again. Returns what the hub did.
 */
async function runChain(name, codes) {
  const hub = new Hub({ store: new SqliteStore(':memory:') });
  const server = await startServer({ hub, host: '127.0.0.1', port: 0, landerToken: LANDER_TOKEN, allowUnauthenticatedApprovals: true, sweepIntervalMs: 60_000 });
  const base = server.url;
  try {
    const lander = new LanderHubClient({ url: base, project: P, agent: LANDER_ID, landerToken: LANDER_TOKEN });
    const leaseClaim = await lander.claim({ files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 3_600_000, intent: 'lander on build1' });
    if (leaseClaim.status !== 'granted' && leaseClaim.status !== 'active') {
      if (!leaseClaim.claim || leaseClaim.claim.status !== 'active') throw new HarnessError(`lease not granted: ${JSON.stringify(leaseClaim)}`);
    }
    const { epoch } = await lander.events({ waitMs: 0 });
    const lease = { lease_claim_id: leaseClaim.claim.id, epoch };
    const admit = async (l, files) => {
      const r = await lander.admit(l.id, { lease, base_sha: 'e'.repeat(40), files, scope: null, mapper: null, protected: [], required: [], waits_for: null, warnings: [] });
      if (r.landing.status !== 'queued') throw new HarnessError(`${l.id} not queued after admit: ${r.landing.status}`);
      return r.landing;
    };

    // maya's task and first landing.
    const tm = (await call(base, MAYA, 'POST', '/tasks', { title: 'refactor login' })).task;
    await call(base, MAYA, 'POST', `/tasks/${tm.id}/take`, {});
    await call(base, MAYA, 'POST', '/claims', { files: ['src/a.ts'] });
    let n = 0;
    const mayaLand = () => call(base, MAYA, 'POST', '/land', { task_id: tm.id, commit: HEX[n++].repeat(40), queue: true, files: ['src/a.ts'] });
    let landed = await mayaLand();
    let cur = landed.landing;
    await admit(cur, ['src/a.ts']);

    // sam queues behind her.
    const ts = (await call(base, SAM, 'POST', '/tasks', { title: 'billing page' })).task;
    await call(base, SAM, 'POST', `/tasks/${ts.id}/take`, {});
    await call(base, SAM, 'POST', '/claims', { files: ['src/b.ts'] });
    const samLanding = (await call(base, SAM, 'POST', '/land', { task_id: ts.id, commit: 'f'.repeat(40), queue: true, files: ['src/b.ts'] })).landing;
    await admit(samLanding, ['src/b.ts']);

    const steps = [{ id: cur.id, retry: cur.retry, queue_seq: cur.queue_seq, after: null }];
    let consecutiveLanderErrors = 0;
    let paused = false;
    let overtakenAt = null;
    for (const code of codes) {
      const next = await lander.next({ lease });
      if (!next.landing) throw new HarnessError(`${name}: next returned nothing`);
      if (next.landing.id !== cur.id) {
        // sam got ahead before the chain finished: note it and stop.
        overtakenAt = { expected: cur.id, got: next.landing.id };
        break;
      }
      const rep = report(code, next.landing);
      const adv = await lander.advance(cur.id, { lease, attempt: next.landing.attempt, to: 'failed', code, report: rep });
      if (adv.landing.status !== 'failed' || adv.landing.failure?.code !== code) throw new HarnessError(`${name}: advance failed ${code} gave ${JSON.stringify(adv.landing.failure)}`);
      // What Lander.step does: three lander_errors in a row pause the project.
      if (code === 'lander_error') {
        if (++consecutiveLanderErrors >= MAX_LANDER_ERRORS) {
          consecutiveLanderErrors = 0;
          await lander.pause({ lease, reason: 'config_invalid', detail: `lander workdir unusable: ${MAX_LANDER_ERRORS} attempts in a row failed with a lander error; look at the lander's log` });
          paused = true;
        }
      } else consecutiveLanderErrors = 0;
      landed = await mayaLand();
      cur = landed.landing;
      await admit(cur, ['src/a.ts']);
      steps.push({ id: cur.id, retry: cur.retry, queue_seq: cur.queue_seq, after: code, told: rep.next_steps.join(' '), note: landed.note });
    }
    if (paused) {
      // The human fixes the disk and resumes landing.
      await call(base, 'human/' + HUMAN, 'POST', '/lander/resume', {}, { 'x-hub-approver': HUMAN });
    }
    let firstNext = null;
    if (!overtakenAt) {
      const next = await lander.next({ lease });
      firstNext = next.landing?.id ?? null;
    }
    return { name, codes, maya: cur, sam: { id: samLanding.id, queue_seq: samLanding.queue_seq }, steps, paused, overtakenAt, firstNext };
  } finally {
    await server.close();
  }
}

function genuine(codes) {
  return codes.filter((c) => c !== 'lander_error').length;
}

function show(r) {
  console.log(`\n== ${r.name}: send-backs ${r.codes.join(', ')} (genuine: ${genuine(r.codes)}, keepPlaceRetries ${KEEP})`);
  console.log(`   sam's ${r.sam.id}: queue_seq ${r.sam.queue_seq}`);
  for (const s of r.steps) {
    console.log(`   maya ${s.id}: retry ${s.retry}, queue_seq ${s.queue_seq}${s.after ? ` (re-land after ${s.after})` : ' (first land)'}`);
    if (s.after === 'lander_error') console.log(`      lander told maya: ${s.told}`);
    if (s.note) console.log(`      hub land note: ${(s.note.match(/It is retry[^.]*\.[^.]*\./) ?? [s.note])[0]}`);
  }
  if (r.paused) console.log('   (the lander paused config_invalid after 3 lander_errors in a row; the human resumed)');
  if (r.overtakenAt) console.log(`   next handed out ${r.overtakenAt.got} instead of maya's ${r.overtakenAt.expected}`);
  else console.log(`   lander next -> ${r.firstNext} (${r.firstNext === r.maya.id ? "maya's" : r.firstNext === r.sam.id ? "sam's" : '?'})`);
}

const mayaFirst = (r) => !r.overtakenAt && r.firstNext === r.maya.id;
const samFirst = (r) => r.overtakenAt?.got === r.sam.id || r.firstNext === r.sam.id;

try {
  // Control (T1, matches packages/hub/test/landings.queue.test.ts "retry chain"):
  // three genuine send-backs: retries 1 and 2 keep queue_seq 1, retry 3 goes behind sam.
  const control = await runChain('control: three genuine send-backs', ['checks_failed', 'checks_failed', 'checks_failed']);
  show(control);
  const cs = control.steps;
  const controlOk = cs[1].queue_seq === cs[0].queue_seq && cs[2].queue_seq === cs[0].queue_seq && cs[3].queue_seq > control.sam.queue_seq && cs[3].retry === 3 && samFirst(control);
  if (!controlOk) {
    console.error('\nHARNESS: the control did not behave as T1 specifies (keep for 2 genuine retries, then the back).');
    process.exit(2);
  }

  // The design (§4.5) keeps the place for these three: at most 2 genuine send-backs each.
  const cases = [
    await runChain('A: three lander_errors (disk full, git crash, lander bug)', ['lander_error', 'lander_error', 'lander_error']),
    await runChain('B: checks_failed, then two lander_errors', ['checks_failed', 'lander_error', 'lander_error']),
    await runChain('C: one lander_error, then two checks_failed', ['lander_error', 'checks_failed', 'checks_failed']),
  ];
  const broken = [];
  for (const r of cases) {
    show(r);
    if (genuine(r.codes) > KEEP) throw new HarnessError('case beyond keepPlaceRetries');
    const lastSeq = r.steps[r.steps.length - 1].queue_seq;
    const firstSeq = r.steps[0].queue_seq;
    if (!mayaFirst(r) || lastSeq !== firstSeq) {
      broken.push(`${r.name}: maya's ${r.maya.id} has retry ${r.maya.retry} and queue_seq ${lastSeq} (was ${firstSeq}); the lander takes sam's ${r.sam.id} (queue_seq ${r.sam.queue_seq}) first`);
    }
  }
  if (broken.length > 0) {
    console.log('\nDEFECT PRESENT: lander_error send-backs count against keepPlaceRetries (design §4.5 says they must not):');
    for (const b of broken) console.log(` - ${b}`);
    process.exit(1);
  }
  console.log('\nOK: lander_error send-backs keep the place without counting against keepPlaceRetries.');
  process.exit(0);
} catch (err) {
  console.error(`\nHARNESS: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
}
