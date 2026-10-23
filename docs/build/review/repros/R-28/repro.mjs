// R-28: the hub's pushing gate (enterPushing) dedupes requirements by kind+digest,
// so a second protected rule over the same paths (same digest, different rules)
// is dropped and the hub accepts `pushing` with only the first rule satisfied.
//
// Requirements are computed with the real code paths: contract.parseTeamSections
// (strict, as the lander does) and lander/requirements.protectedRequirements
// (with gitops.approvalDigest). The hub runs in-process on an in-memory SQLite
// store. No network, no API key.
//
// Exit 1 when the defect is present (the hub accepts pushing while a rule it
// still lists as pending is unmet), 0 when the hub refuses with approval_missing.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { Hub, SqliteStore } = await imp('packages/hub/dist/index.js');
const { parseTeamSections } = await imp('packages/contract/dist/index.js');
const { protectedRequirements, missingApprovals } = await imp('packages/lander/dist/requirements.js');

const P = 'acme/web';
const LANDER = 'lander/box-1-abcd';
const L_AUTH = { lander: true, approver: null };
const AGENT = 'maya/claude-1';
const T0 = 'b'.repeat(40);
const H = 'a'.repeat(40);
const C = 'c'.repeat(40);
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
// A GitPort stand-in: distinct, deterministic blob ids per (rev, path).
const git = { blobId: async (rev, p) => sha1(`${rev}:${p}`) };

async function scenario(name, config, file, approver) {
  const { sections } = parseTeamSections(config, { strict: true });
  const rules = sections.land.protected;
  const required = await protectedRequirements(git, rules, [file], T0, H);
  const out = { name, ok: true, notes: [] };
  const log = (s) => out.notes.push(s);
  log(`requirements: ${required.map((r) => `${r.kind} ${r.digest.slice(0, 12)} approvers=${JSON.stringify(r.rules[0].approvers)} distinct=${r.rules[0].distinct}`).join(' | ')}`);
  if (required.length < 2 || required[0].digest !== required[1].digest) {
    log('precondition not met: expected two requirements with the same digest');
    out.ok = null;
    return out;
  }
  const digest = required[0].digest;

  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  const lease = hub.claim(P, LANDER, { files: ['.git/agenthub/lander'], mode: 'exclusive', queue: true, ttl_ms: 60_000, intent: 'lander' }, L_AUTH);
  const auth = { lease_claim_id: lease.claim.id, epoch: hub.epoch };
  const land = hub.land(P, AGENT, { queue: true, commit: H, summary: 'protected change', files: [file] });
  const id = land.landing.id;
  hub.admitLanding(P, LANDER, id, { lease: auth, base_sha: T0, files: [file], scope: null, mapper: null, protected: [file], required, waits_for: null, warnings: [] }, L_AUTH);
  log(`after admit: status=${hub.getLanding(P, id).status} pending=${hub.getLanding(P, id).approval.length}`);
  hub.approveLanding(P, id, { kind: 'protected', digest, note: 'ok' }, { lander: false, approver });
  const after = hub.getLanding(P, id);
  log(`after ${approver} approves: status=${after.status} hub still lists pending: ${JSON.stringify(after.approval.map((r) => r.rules[0].approvers))}`);
  const landerMissing = missingApprovals(required, after.approvals, after.agent);
  log(`lander's own missingApprovals (control): ${landerMissing.length} missing ${JSON.stringify(landerMissing.map((r) => r.rules[0].approvers))}`);

  const next = hub.nextLanding(P, LANDER, { lease: auth }, L_AUTH);
  if (next.landing?.id !== id) { log(`next did not hand out ${id}: ${JSON.stringify(next.landing?.status)}`); out.ok = null; return out; }
  hub.advanceLanding(P, LANDER, id, { lease: auth, attempt: next.landing.attempt ?? 1, to: 'running', phase: 'merging', trunk_base: T0, deadline_ms: 600_000 }, L_AUTH);
  try {
    const r = hub.advanceLanding(P, LANDER, id, {
      lease: auth, attempt: next.landing.attempt ?? 1, to: 'running', phase: 'pushing', candidate: C,
      candidate_ref: `refs/agenthub/cand/x/${id}/${C.slice(0, 12)}`, trunk_base: T0, tree: 'e'.repeat(40), required,
    }, L_AUTH);
    log(`DEFECT: hub accepted pushing (${r.landing.status}/${r.landing.phase}) although ${after.approval.length} requirement(s) it lists as pending are unmet`);
    out.ok = false;
  } catch (e) {
    if (e.code === 'approval_missing') {
      log(`hub refused pushing: ${e.code} (${(e.details?.missing ?? []).length} missing)`);
    } else {
      log(`unexpected error: ${e.code} ${e.message}`);
      out.ok = null;
    }
  }
  return out;
}

const results = [
  // ALWAYS_PROTECTED (approvers: any, first in the list) plus a team rule naming a lead for agenthub.json.
  await scenario('agenthub.json: ALWAYS_PROTECTED + team rule {approvers:[lead]}', {
    land: { check: 'true', protected: [{ paths: ['agenthub.json'], approvers: ['lead'], distinct: true }] },
  }, 'agenthub.json', 'sam'),
  // Two team rules over migrations/**: the owners, and a DBA who must be distinct.
  await scenario('migrations/**: {approvers:[maya,sam]} + {approvers:[dba], distinct}', {
    land: { check: 'true', protected: [
      { paths: ['migrations/**'], approvers: ['maya', 'sam'], distinct: false },
      { paths: ['migrations/**'], approvers: ['dba'], distinct: true },
    ] },
  }, 'migrations/0042.sql', 'sam'),
];

let defect = false, inconclusive = false;
for (const r of results) {
  console.log(`\n== ${r.name}`);
  for (const n of r.notes) console.log('  ' + n);
  console.log(`  => ${r.ok === false ? 'DEFECT PRESENT' : r.ok === null ? 'INCONCLUSIVE' : 'ok (gate enforced)'}`);
  if (r.ok === false) defect = true;
  if (r.ok === null) inconclusive = true;
}
console.log(`\nAGENTHUB_ROOT=${ROOT}: ${defect ? 'R-28 reproduced' : inconclusive ? 'inconclusive' : 'R-28 not present'}`);
process.exit(defect ? 1 : inconclusive ? 2 : 0);
