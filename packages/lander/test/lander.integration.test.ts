import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTeamSections } from '@agenthub/contract';
import { approvalDigest } from '@agenthub/gitops';
import { HubError } from '@agenthub/hub';
import type { Faults } from '../src/ports.js';
import { commandHash } from '../src/report.js';
import { sh } from './helpers.js';
import { approver, CHECK, P, Scenario, waitFor } from './scenario.js';

// design §5.3: a real local bare remote (receive.denyNonFastForwards and an
// update hook admitting only the lander's identity on trunk), a real hub on
// port 0, and the real lander over HTTP, run --once or in the background,
// with `node check.mjs` gated by signal files. The AI rows belong to L5.

const T = 60_000;

let s: Scenario | null = null;
afterEach(async () => {
  await s?.close();
  s = null;
});

async function scenario(o: Parameters<typeof Scenario.create>[0] = {}): Promise<Scenario> {
  s = await Scenario.create(o);
  return s;
}

describe('hub-lander against a real hub and a real remote (design §5.3)', () => {
  it(
    'happy path: one squash commit with all trailers; refs, holds and task cleaned up; events in order',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const task = sc.task(a, 'Add a greeting');
      const seedTip = sc.trunk();
      const H = a.commit('add greet()', { 'src/greet.ts': 'export function greet(): string {\n  return "hi";\n}\n' });
      const L = sc.land(a, { task_id: task, summary: 'adds greet()\nAgenthub-Landing: acme/web/L-99' });
      expect(L.status).toBe('submitted');
      expect(sc.hub.listClaims(P).some((c) => c.landing_id === L.id)).toBe(true);

      await sc.once();

      const done = sc.landing(L.id);
      expect(done.status).toBe('landed');
      const commits = sc.firstParents(seedTip);
      expect(commits).toHaveLength(1);
      const C = commits[0]!;
      expect(done.trunk_sha).toBe(C);
      expect(sc.rev(`${C}^1`)).toBe(seedTip);
      const tr = sc.trailers(C);
      expect(tr).toMatchObject({
        'Agenthub-Landing': `${P}/${L.id}`,
        'Agenthub-Hub': sc.hub.epoch,
        'Agenthub-Source': H,
        'Agenthub-Attempt': '1',
        'Agenthub-Task': task,
        'Agenthub-Agent': a.agent,
        'Agenthub-Resolved': 'clean',
        'Agenthub-Checked': commandHash(CHECK),
      });
      // The agent's forged trailer line was stripped from the summary.
      expect(sc.message(C)).not.toContain('L-99');
      expect(sc.message(C)).toMatch(/^Add a greeting \(L-1\)\n\nadds greet\(\)\n/);
      expect(sc.show(C, 'src/greet.ts')).toContain('greet');
      // The land ref went with the trunk push; the staged candidate was deleted.
      expect(sc.agenthubRefs()).toEqual([]);
      // Holds released, task done.
      expect(sc.hub.listClaims(P).filter((c) => c.landing_id === L.id)).toEqual([]);
      expect(sc.hub.listTasks(P).find((t) => t.id === task)?.status).toBe('done');
      // Events in order.
      const mine = sc.events.filter((e) => e.data.landing_id === L.id || e.type === 'trunk.moved').map((e) => (e.type === 'landing.updated' ? `updated:${e.data.reason}:${e.data.phase ?? ''}` : e.type));
      const order = ['landing.created', 'updated:admitted:', 'updated:picked:merging', 'updated:phase:checking', 'updated:phase:pushing', 'landing.landed', 'trunk.moved'];
      expect(mine.filter((m) => order.includes(m))).toEqual(order);
      const moved = sc.events.find((e) => e.type === 'trunk.moved')!;
      expect(moved.data).toMatchObject({ from: seedTip, to: C, landing_id: L.id, foreign: false });
      expect(done.report?.resolved_by).toBe('clean');
      expect(done.report?.check?.exit_code).toBe(0);
    },
    T,
  );

  it(
    'FIFO with two clones: both land in queue order, the second merged onto the first',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      const seedTip = sc.trunk();
      const Ha = a.commit('a: bump a', { 'src/a.ts': 'export const a = 2;\n' });
      const Hb = b.commit('b: bump b', { 'src/b.ts': 'export const b = 2;\n' });
      const La = sc.land(a, { summary: 'bump a' });
      const Lb = sc.land(b, { summary: 'bump b' });
      expect(La.queue_seq! < Lb.queue_seq!).toBe(true);
      await sc.once();
      expect(sc.landing(La.id).status).toBe('landed');
      expect(sc.landing(Lb.id).status).toBe('queued');
      await sc.once();
      expect(sc.landing(Lb.id).status).toBe('landed');
      const [Ca, Cb] = sc.firstParents(seedTip);
      expect(sc.firstParents(seedTip)).toHaveLength(2);
      expect(sc.trailers(Ca!)['Agenthub-Source']).toBe(Ha);
      expect(sc.trailers(Cb!)['Agenthub-Source']).toBe(Hb);
      expect(sc.rev(`${Cb}^1`)).toBe(Ca);
      expect(sc.show(Cb!, 'src/a.ts')).toBe('export const a = 2;\n');
      expect(sc.show(Cb!, 'src/b.ts')).toBe('export const b = 2;\n');
      expect(sc.landing(Lb.id).trunk_base).toBe(Ca);
    },
    T,
  );

  it(
    'structural: plain merge-tree conflicts, the fake Mergiraf resolves it, other files are byte-identical to the plain merge',
    async () => {
      const sc = await scenario({ fakeMergiraf: true });
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      const seedTip = sc.trunk();
      const session = sc.show(seedTip, 'src/session.ts')!;
      a.commit('a: refresh', { 'src/session.ts': `${session}\nexport function refresh(): number {\n  return 2;\n}\n`, 'src/a.ts': 'export const a = 3;\n' });
      const Hb = b.commit('b: revoke', { 'src/session.ts': `${session}\nexport function revoke(): number {\n  return 3;\n}\n`, 'src/b.ts': 'export const b = 3;\n' });
      // B lands once A's hold on src/session.ts is gone (file-level holds in Phase 2).
      const La = sc.land(a, { summary: 'refresh' });
      await sc.once();
      expect(sc.landing(La.id).status).toBe('landed');
      const Ca = sc.trunk();
      const Lb = sc.land(b, { summary: 'revoke' });
      await sc.once();
      const done = sc.landing(Lb.id);
      expect(done.status).toBe('landed');
      expect(done.report?.resolved_by).toBe('structural');
      expect(done.report?.files_via).toEqual([{ file: 'src/session.ts', via: 'structural' }]);
      const Cb = done.trunk_sha!;
      expect(sc.trailers(Cb)['Agenthub-Resolved']).toBe('structural src/session.ts');
      const merged = sc.show(Cb, 'src/session.ts')!;
      expect(merged).toContain('function refresh');
      expect(merged).toContain('function revoke');
      // The plain merge, for comparison: it conflicts on src/session.ts only.
      const plain = sc.remoteGit('merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${seedTip}`, Ca, Hb);
      expect(plain.code).toBe(1);
      const [plainTree, ...conflicted] = plain.stdout.split('\n').filter(Boolean);
      expect(conflicted).toEqual(['src/session.ts']);
      for (const f of ['src/a.ts', 'src/b.ts', 'README.md', 'agenthub.json', 'migrations/001.sql', 'check.mjs']) {
        expect(sc.blob(plainTree!, f)).toBe(sc.blob(Cb, f));
      }
      expect(sc.firstParents(seedTip)).toEqual([Ca, Cb]);
    },
    T,
  );

  it(
    'checks failed: checks_failed with log_tail, failed_tests, passes_on_trunk, a staged candidate for reproduce, and a direct message',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      a.commit('a: ok', { 'src/a.ts': 'export const a = 5;\n' });
      sc.land(a, { summary: 'fine' });
      await sc.once(); // T0 is now a commit this hub landed under the same check command
      const task = sc.task(b, 'Break it');
      b.commit('b: broken', { 'src/bad.ts': `// ${'FAIL'}!\nexport const bad = 1;\n` });
      const L = sc.land(b, { task_id: task, summary: 'breaks the checks' });
      const trunkBefore = sc.trunk();
      await sc.once();

      const failed = sc.landing(L.id);
      expect(failed.status).toBe('failed');
      expect(failed.failure?.code).toBe('checks_failed');
      const check = failed.report!.check!;
      expect(check.exit_code).toBe(1);
      expect(check.log_tail).toContain('src/bad.ts');
      expect(check.failed_tests).toEqual(['src/bad.ts > checks > has no failure marker']);
      expect(check.passes_on_trunk).toBe(true);
      expect(check.command_hash).toBe(commandHash(CHECK));
      // reproduce names the staged candidate, which is on the remote.
      const m = /^git fetch origin (\S+) && git worktree add \/tmp\/agenthub-L-2 ([0-9a-f]{40}) && \(cd \/tmp\/agenthub-L-2 && node check\.mjs\)$/.exec(check.reproduce);
      expect(m).not.toBeNull();
      const [, ref, C] = m!;
      expect(ref).toBe(`refs/agenthub/cand/${sc.hub.epoch.replace(/-/g, '').slice(0, 8)}/L-2/${C!.slice(0, 12)}`);
      expect(sc.remoteRef(ref!)).toBe(C);
      expect(sc.rev(`${C}^1`)).toBe(trunkBefore);
      expect(sc.trunk()).toBe(trunkBefore);
      expect(failed.report!.message).toContain('checks_failed');
      expect(failed.report!.next_steps.join('\n')).toContain(check.reproduce);
      // Send-back effects: the task is back with the agent, and the lander told the agent.
      expect(sc.hub.listTasks(P).find((t) => t.id === task)?.status).toBe('in_progress');
      const inbox = sc.hub.inbox(P, b.agent, { peek: true }).messages;
      expect(inbox.some((msg) => msg.from.startsWith('lander/') && msg.body.includes('L-2') && msg.body.includes('checks_failed'))).toBe(true);
    },
    T,
  );

  it(
    'protected, approved while queued: the approval asked at admission, granted, then landed without parking',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const seedTip = sc.trunk();
      const H = a.commit('a: migration', { 'migrations/002.sql': 'create table tags (id int);\n' });
      const L = sc.land(a, { summary: 'adds tags' });
      await sc.admit();
      const queued = sc.landing(L.id);
      expect(queued.status).toBe('queued');
      expect(queued.protected).toEqual(['migrations/002.sql']);
      expect(queued.approval).toHaveLength(1);
      const req = queued.approval[0]!;
      expect(req).toMatchObject({ kind: 'protected', paths: ['migrations/002.sql'], rules: [{ paths: ['migrations/**'], approvers: null, distinct: true }] });
      expect(req.digest).toBe(approvalDigest('protected', [{ path: 'migrations/002.sql', blobs: [null, sc.blob(H, 'migrations/002.sql')] }]));
      expect(sc.events.some((e) => e.type === 'landing.needs_approval' && e.data.landing_id === L.id && e.data.parked === false)).toBe(true);
      // maya's own approval is refused by distinct; sam approves.
      expect(() => sc.hub.approveLanding(P, L.id, { kind: 'protected', digest: req.digest }, approver('maya'))).toThrow(HubError);
      sc.hub.approveLanding(P, L.id, { kind: 'protected', digest: req.digest, note: 'looks right' }, approver('sam'));
      await sc.once();
      const done = sc.landing(L.id);
      expect(done.status).toBe('landed');
      expect(sc.events.some((e) => e.type === 'landing.needs_approval' && e.data.landing_id === L.id && e.data.parked === true)).toBe(false);
      expect(sc.trailers(done.trunk_sha!)['Agenthub-Approved']).toBe('protected:sam');
      expect(sc.firstParents(seedTip)).toEqual([done.trunk_sha]);
    },
    T,
  );

  it(
    'protected, parked: checks pass first, it parks with candidate_checked, the next landing runs meanwhile, and approval lands it without re-running the checks',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      const seedTip = sc.trunk();
      a.commit('a: migration', { 'migrations/003.sql': 'create table likes (id int);\n' });
      const L1 = sc.land(a, { summary: 'adds likes' });
      b.commit('b: broken', { 'src/bad.ts': `// ${'FAIL'}!\n` });
      const L2 = sc.land(b, { summary: 'broken' });
      await sc.once();
      const parked = sc.landing(L1.id);
      expect(parked.status).toBe('needs_approval');
      expect(parked.candidate_checked).toBe(true);
      expect(parked.candidate).toMatch(/^[0-9a-f]{40}$/);
      expect(sc.remoteRef(parked.candidate_ref!)).toBe(parked.candidate);
      expect(sc.checkRuns(L1.id)).toHaveLength(1);
      expect(sc.events.some((e) => e.type === 'landing.needs_approval' && e.data.landing_id === L1.id && e.data.parked === true)).toBe(true);
      expect(sc.hub.inbox(P, a.agent, { peek: true }).messages.some((m) => m.body.includes(`hub approve ${L1.id}`))).toBe(true);
      // The slot was freed: the next landing ran (and came back) meanwhile.
      await sc.once();
      expect(sc.landing(L2.id).failure?.code).toBe('checks_failed');
      expect(sc.trunk()).toBe(seedTip);
      sc.hub.approveLanding(P, L1.id, { kind: 'protected', digest: parked.approval[0]!.digest }, approver('sam'));
      expect(sc.landing(L1.id).status).toBe('queued');
      await sc.once();
      const done = sc.landing(L1.id);
      expect(done.status).toBe('landed');
      expect(done.trunk_sha).toBe(parked.candidate);
      expect(sc.checkRuns(L1.id)).toHaveLength(1);
      expect(done.report?.check?.exit_code).toBe(0);
      expect(sc.firstParents(seedTip)).toEqual([parked.candidate]);
    },
    T,
  );

  it(
    'merged protected: trunk changed the same migration, so a merged requirement binds the candidate; the old digest is approval_stale',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const seedTip = sc.trunk();
      const original = sc.show(seedTip, 'migrations/001.sql')!;
      const H = a.commit('a: users.email', { 'migrations/001.sql': original.replace('create table users (id int);', 'create table users (id int, email text);') });
      const L = sc.land(a, { summary: 'users.email' });
      await sc.admit();
      sc.hub.approveLanding(P, L.id, { kind: 'protected', digest: sc.landing(L.id).approval[0]!.digest }, approver('sam'));
      const T1 = sc.foreignPush({ 'migrations/001.sql': original.replace('create table posts (id int);', 'create table posts (id int, title text);') });
      await sc.once();
      const parked = sc.landing(L.id);
      expect(parked.status).toBe('needs_approval');
      expect(parked.approval).toHaveLength(1);
      const merged = parked.approval[0]!;
      const C = parked.candidate!;
      expect(merged).toMatchObject({ kind: 'merged', paths: ['migrations/001.sql'], candidate: C, trunk_base: T1 });
      expect(merged.digest).toBe(approvalDigest('merged', [{ path: 'migrations/001.sql', blobs: [sc.blob(T1, 'migrations/001.sql'), sc.blob(C, 'migrations/001.sql')] }]));
      // A digest over the agent's own content, not the merged content, is stale.
      const old = approvalDigest('merged', [{ path: 'migrations/001.sql', blobs: [sc.blob(T1, 'migrations/001.sql'), sc.blob(H, 'migrations/001.sql')] }]);
      let err: unknown;
      try {
        sc.hub.approveLanding(P, L.id, { kind: 'merged', digest: old }, approver('sam'));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(HubError);
      expect((err as HubError).code).toBe('approval_stale');
      sc.hub.approveLanding(P, L.id, { kind: 'merged', digest: merged.digest }, approver('sam'));
      await sc.once();
      const done = sc.landing(L.id);
      expect(done.status).toBe('landed');
      expect(done.trunk_sha).toBe(C);
      expect(sc.show(C, 'migrations/001.sql')).toContain('email text');
      expect(sc.show(C, 'migrations/001.sql')).toContain('title text');
      expect(sc.checkRuns(L.id)).toHaveLength(1);
    },
    T,
  );

  it(
    "claim gate: a commit touching another agent's claimed file fails admission with claim_conflict naming the claim",
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      const claim = sc.hub.claim(P, b.agent, { files: ['src/x.ts'], intent: 'reworking x' });
      expect(claim.status).toBe('granted');
      // An edit that never went through the edit hooks (HUB_GUARD=off): the advisory files name nothing.
      a.commit('a: touch x', { 'src/x.ts': 'export const x = 2;\n' });
      const L = sc.land(a, { summary: 'x', files: [] });
      expect(L.status).toBe('submitted');
      await sc.once();
      const failed = sc.landing(L.id);
      expect(failed.status).toBe('failed');
      expect(failed.failure?.code).toBe('claim_conflict');
      expect(failed.failure?.summary).toContain(b.agent);
      expect(failed.files).toEqual(['src/x.ts']);
      expect(sc.hub.inbox(P, a.agent, { peek: true }).messages.some((m) => m.body.includes('claim_conflict'))).toBe(true);
      expect(sc.agenthubRefs()).toEqual([`refs/agenthub/land/${failed.commit}`]);
    },
    T,
  );

  it(
    'trunk moves mid-check: the trunk watch kills the check, attempt 2 lands on the new tip, and the foreign commit is reported',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      a.commit('a: change', { 'src/a.ts': 'export const a = 7;\n' });
      writeFileSync(path.join(sc.gate, 'block'), '');
      const L = sc.land(a, { summary: 'a = 7' });
      sc.background();
      await waitFor(() => existsSync(path.join(sc.gate, 'started')), 'the check to start');
      const F = sc.foreignPush({ 'docs/notes.md': 'pushed by hand\n' });
      await waitFor(() => sc.landing(L.id).status === 'landed', 'the landing to land');
      await sc.stop();
      const done = sc.landing(L.id);
      expect(done.attempt).toBe(2);
      expect(done.retries.trunk_moved).toBe(1);
      expect(sc.rev(`${done.trunk_sha}^1`)).toBe(F);
      expect(sc.show(done.trunk_sha!, 'docs/notes.md')).toBe('pushed by hand\n');
      expect(sc.checkRuns(L.id)).toHaveLength(2);
      expect(sc.events.some((e) => e.type === 'landing.updated' && e.data.landing_id === L.id && e.data.reason === 'requeued:trunk_moved')).toBe(true);
      expect(sc.events.some((e) => e.type === 'trunk.moved' && e.data.to === F && e.data.foreign === true)).toBe(true);
      expect(done.report?.foreign_commits).toEqual([F]);
    },
    T,
  );

  it(
    'trunk moves between check and push: the CAS push is stale, the landing is requeued (T12) and lands on the new tip',
    async () => {
      let reached!: () => void;
      let release!: () => void;
      const atPush = new Promise<void>((r) => (reached = r));
      const go = new Promise<void>((r) => (release = r));
      let held = false;
      const faults: Faults = {
        async at(point) {
          if (point === 'after-pushing-ack' && !held) {
            held = true;
            reached();
            await go;
          }
        },
      };
      const sc = await scenario({ faults });
      const a = sc.clone('maya/claude-1');
      a.commit('a: change', { 'src/a.ts': 'export const a = 8;\n' });
      const L = sc.land(a, { summary: 'a = 8' });
      sc.background();
      await atPush;
      const first = sc.landing(L.id);
      expect(first.phase).toBe('pushing');
      const F = sc.foreignPush({ 'docs/hotfix.md': 'hotfix\n' });
      release();
      await waitFor(() => sc.landing(L.id).status === 'landed', 'the landing to land');
      await sc.stop();
      const done = sc.landing(L.id);
      expect(done.retries.trunk_moved).toBe(1);
      expect(done.attempt).toBe(2);
      expect(done.trunk_sha).not.toBe(first.candidate);
      expect(sc.rev(`${done.trunk_sha}^1`)).toBe(F);
      expect(sc.firstParents(first.trunk_base!)).toEqual([F, done.trunk_sha]);
      expect(sc.checkRuns(L.id)).toHaveLength(2);
    },
    T,
  );

  it(
    'unknown push outcome, then run --once ends: the shutdown resolution pushes the same candidate onto the same base (§2.2.3, §2.2.7 step 3)',
    async () => {
      // The remote goes away once pushing is acknowledged, so no push try gets an answer; it is back when the attempt gives up.
      const at = { remote: '', away: null as string | null };
      const faults: Faults = {
        at(point) {
          if (point === 'after-pushing-ack' && at.away === null) {
            at.away = `${at.remote}.away`;
            renameSync(at.remote, at.away);
          }
        },
      };
      const onLog = (line: string): void => {
        if (line.includes('stays in pushing') && at.away && !existsSync(at.remote)) renameSync(at.away, at.remote);
      };
      const sc = await scenario({ faults, onLog });
      at.remote = sc.remote;
      const a = sc.clone('maya/claude-1');
      const seedTip = sc.trunk();
      a.commit('a: change', { 'src/a.ts': 'export const a = 28;\n' });
      const L = sc.land(a, { summary: 'a = 28' });
      await sc.once();
      expect(sc.logs.some((l) => l.includes(`resolving ${L.id} (in pushing) before stopping`))).toBe(true);
      const done = sc.landing(L.id);
      expect(done.status).toBe('landed');
      expect(done.attempt).toBe(1);
      expect(done.retries.trunk_moved).toBe(0);
      expect(done.trunk_sha).toBe(done.candidate);
      expect(sc.rev(`${done.trunk_sha}^1`)).toBe(seedTip);
      expect(sc.firstParents(seedTip)).toEqual([done.trunk_sha]);
      expect(sc.checkRuns(L.id)).toHaveLength(1);
      expect(sc.agenthubRefs()).toEqual([]);
    },
    T,
  );

  it(
    'trunk rewritten: a force-rewound trunk pauses landing (trunk_rewritten), nothing starts, and resume --accept-trunk continues',
    async () => {
      let rewind: (() => void) | null = null;
      // Someone rewinds trunk on the remote itself, around every rule, just as L-2's attempt starts.
      const faults: Faults = {
        at(point, id) {
          if (point === 'after-next' && id === 'L-2' && rewind) {
            rewind();
            rewind = null;
          }
        },
      };
      const sc = await scenario({ faults });
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      const seedTip = sc.trunk();
      a.commit('a: first', { 'src/a.ts': 'export const a = 9;\n' });
      sc.land(a, { summary: 'first' });
      await sc.once();
      b.commit('b: second', { 'src/b.ts': 'export const b = 9;\n' });
      const L2 = sc.land(b, { summary: 'second' });
      rewind = () => sc.remoteGit('update-ref', 'refs/heads/main', seedTip);
      await sc.once();
      const control = sc.hub.landerStatus(P).control;
      expect(control.paused?.reason).toBe('trunk_rewritten');
      expect(sc.landing(L2.id).status).toBe('queued');
      expect(sc.events.some((e) => e.type === 'landing.updated' && e.data.landing_id === L2.id && e.data.reason === 'requeued:trunk_rewritten')).toBe(true);
      expect(sc.events.some((e) => e.type === 'lander.paused' && e.data.reason === 'trunk_rewritten')).toBe(true);
      // Nothing starts while paused, standby or not.
      await sc.once();
      expect(sc.landing(L2.id).status).toBe('queued');
      expect(sc.landing(L2.id).attempt).toBe(1);
      expect(sc.trunk()).toBe(seedTip);
      sc.hub.resumeLander(P, { accept_trunk: seedTip }, approver('sam'));
      await sc.once();
      const done = sc.landing(L2.id);
      expect(done.status).toBe('landed');
      expect(sc.rev(`${done.trunk_sha}^1`)).toBe(seedTip);
      expect(sc.hub.landerStatus(P).control.paused).toBeNull();
    },
    T,
  );

  it(
    'push_rejected: the update hook refuses, landing pauses and the landing stays in pushing; after the fix and resume the same candidate is pushed',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const seedTip = sc.trunk();
      a.commit('a: change', { 'src/a.ts': 'export const a = 10;\n' });
      const L = sc.land(a, { summary: 'a = 10' });
      writeFileSync(path.join(sc.remote, 'refuse-trunk'), '');
      await sc.once();
      const stuck = sc.landing(L.id);
      expect(stuck.status).toBe('running');
      expect(stuck.phase).toBe('pushing');
      expect(sc.hub.landerStatus(P).control.paused?.reason).toBe('push_rejected');
      expect(sc.trunk()).toBe(seedTip);
      const C = stuck.candidate!;
      expect(sc.remoteRef(stuck.candidate_ref!)).toBe(C);
      // The refused push reached the remote once (a refusal is not retried).
      expect(sc.trunkUpdateTries()).toBe(1);
      // While paused no trunk push is even tried, though next hands the landing back.
      await sc.once();
      await sc.once();
      expect(sc.landing(L.id).phase).toBe('pushing');
      expect(sc.trunkUpdateTries()).toBe(1);
      expect(sc.trunk()).toBe(seedTip);
      rmSync(path.join(sc.remote, 'refuse-trunk'));
      sc.hub.resumeLander(P, {}, approver('sam'));
      await sc.once();
      const done = sc.landing(L.id);
      expect(done.status).toBe('landed');
      expect(done.trunk_sha).toBe(C);
      expect(sc.trunk()).toBe(C);
      expect(sc.trunkUpdateTries()).toBe(2);
      expect(sc.checkRuns(L.id)).toHaveLength(1);
      expect(sc.agenthubRefs()).toEqual([]);
    },
    T,
  );

  it(
    'no-op: a change already on trunk lands with resolved_by none and no new commit',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      a.commit('a: same change', { 'src/a.ts': 'export const a = 11;\n' });
      const F = sc.foreignPush({ 'src/a.ts': 'export const a = 11;\n' }, 'the same change, pushed by hand');
      const L = sc.land(a, { summary: 'a = 11', files: ['src/a.ts'] });
      await sc.once();
      const done = sc.landing(L.id);
      expect(done.status).toBe('landed');
      expect(done.report?.resolved_by).toBe('none');
      expect(done.trunk_sha).toBe(F);
      expect(sc.trunk()).toBe(F);
      expect(sc.agenthubRefs()).toEqual([]);
      expect(sc.checkRuns(L.id)).toHaveLength(0);
    },
    T,
  );

  it(
    'no-op: the landed commit itself is already on trunk (pushed by hand): landed as that commit, nothing new',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const H = a.commit('a: change', { 'src/a.ts': 'export const a = 21;\n' });
      // A human with a bypass of the host rule pushes H itself to trunk.
      sh(a.dir, ['push', '-q', 'origin', `${H}:refs/heads/main`]);
      const L = sc.land(a, { summary: 'already there', files: ['src/a.ts'] });
      await sc.once();
      const done = sc.landing(L.id);
      expect(done.status).toBe('landed');
      expect(done.report?.resolved_by).toBe('none');
      expect(done.trunk_sha).toBe(H);
      expect(sc.trunk()).toBe(H);
      expect(sc.agenthubRefs()).toEqual([]);
      expect(sc.checkRuns(L.id)).toHaveLength(0);
    },
    T,
  );

  it(
    'land ref overwritten after admission: the attempt checks the tip again and fails not_pushed (§4.1 #15)',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const seedTip = sc.trunk();
      const H = a.commit('a: change', { 'src/a.ts': 'export const a = 23;\n' });
      const L = sc.land(a, { summary: 'a = 23' });
      await sc.admit();
      expect(sc.landing(L.id).status).toBe('queued');
      // Someone points the land ref at other content on the remote itself.
      const other = a.commit('a: other', { 'src/a.ts': 'export const a = 99;\n' });
      sh(a.dir, ['push', '-q', 'origin', `${other}:refs/scratch/other`]);
      expect(sc.remoteGit('update-ref', `refs/agenthub/land/${H}`, other).code).toBe(0);
      await sc.once();
      const failed = sc.landing(L.id);
      expect(failed.status).toBe('failed');
      expect(failed.failure?.code).toBe('not_pushed');
      expect(failed.report?.warnings.join('\n')).toContain(`not at the landed commit ${H.slice(0, 12)}`);
      expect(sc.trunk()).toBe(seedTip);
      expect(sc.checkRuns(L.id)).toHaveLength(0);
    },
    T,
  );

  it(
    'stacked: waits_for holds the second landing until the first lands; then only the work after it is applied',
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const seedTip = sc.trunk();
      const t1 = sc.task(a, 'Add a migration');
      const t2 = sc.task(a, 'Add a feature');
      const H = a.commit('a: migration', { 'migrations/010.sql': 'create table feature (id int);\n' });
      const L1 = sc.land(a, { task_id: t1, summary: 'migration' });
      const H4 = a.commit('a: feature', { 'src/feature.ts': 'export const feature = true;\n' });
      const L2 = sc.land(a, { task_id: t2, summary: 'feature', files: ['src/feature.ts'] });
      await sc.once(); // admits both; L-1 runs and parks for approval
      expect(sc.landing(L1.id).status).toBe('needs_approval');
      const admitted = sc.landing(L2.id);
      expect(admitted.waits_for).toBe(L1.id);
      expect(admitted.status).toBe('queued');
      // Holds cover the whole change from its landed base (§2.2.4 step 3), L-1's file included;
      // the approval it asks for covers only the work after L-1, whose own approval covers the migration.
      expect(admitted.files).toEqual(['migrations/010.sql', 'src/feature.ts']);
      expect(admitted.protected).toEqual(['migrations/010.sql']);
      expect(admitted.approval).toEqual([]);
      await sc.once(); // nothing eligible: L-2 waits for L-1
      expect(sc.landing(L2.id).status).toBe('queued');
      expect(sc.landing(L2.id).attempt).toBe(0);
      sc.hub.approveLanding(P, L1.id, { kind: 'protected', digest: sc.landing(L1.id).approval[0]!.digest }, approver('sam'));
      await sc.once();
      expect(sc.landing(L1.id).status).toBe('landed');
      await sc.once();
      const done = sc.landing(L2.id);
      expect(done.status).toBe('landed');
      expect(done.base_sha).toBe(H);
      expect(done.files).toEqual(['src/feature.ts']);
      const [C1, C2] = sc.firstParents(seedTip);
      expect(sc.trailers(C2!)['Agenthub-Source']).toBe(H4);
      expect(sc.remoteGit('diff-tree', '-r', '--name-only', '--no-commit-id', C1!, C2!).stdout.trim()).toBe('src/feature.ts');
    },
    T,
  );

  it(
    "stacked on a branch that merged trunk by hand: admission holds and asks approval for the agent's own work only, not trunk's",
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      const original = sc.show(sc.trunk(), 'migrations/001.sql')!;
      a.commit('a: one', { 'src/a.ts': 'export const a = 31;\n' });
      const L1 = sc.land(a, { summary: 'one' });
      await sc.admit();
      expect(sc.landing(L1.id).status).toBe('queued');
      // Trunk moves outside the queue (a protected file and src/x.ts), and sam claims src/x.ts.
      sc.foreignPush({ 'migrations/001.sql': original.replace('create table posts (id int);', 'create table posts (id int, t text);'), 'src/x.ts': 'export const x = 5;\n' });
      expect(sc.hub.claim(P, b.agent, { files: ['src/x.ts'], intent: 'x work' }).status).toBe('granted');
      // maya merges trunk into her branch by hand and keeps working on top of L-1.
      a.git('fetch', '-q', 'origin', 'main');
      a.git('merge', '-q', '--no-edit', 'origin/main');
      a.commit('a: feature', { 'src/feature.ts': 'export const f = 1;\n' });
      const L2 = sc.land(a, { summary: 'feature', files: ['src/feature.ts'] });
      await sc.admit();
      const l2 = sc.landing(L2.id);
      expect(l2.status).toBe('queued');
      expect(l2.waits_for).toBe(L1.id);
      // diffNames(landedBase(T, H), H): maya's own files (L-1's and the new one), never trunk's migrations/001.sql or src/x.ts.
      expect(l2.files).toEqual(['src/a.ts', 'src/feature.ts']);
      expect(l2.protected).toEqual([]);
      expect(l2.approval).toEqual([]);
      expect(sc.hub.listClaims(P).find((c) => c.holder === b.agent && c.scope.some((e) => e.file === 'src/x.ts'))?.status).toBe('active');
    },
    T,
  );

  it(
    "contains_unlanded: a branch containing another agent's failed landing fails admission",
    async () => {
      const sc = await scenario();
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      const Ha = a.commit('a: broken', { 'src/bad.ts': `// ${'FAIL'}!\n` });
      const L1 = sc.land(a, { summary: 'broken' });
      await sc.once();
      expect(sc.landing(L1.id).failure?.code).toBe('checks_failed');
      // B builds on A's unlanded commit.
      b.git('fetch', '-q', 'origin', `refs/agenthub/land/${Ha}`);
      b.git('reset', '-q', '--hard', Ha);
      b.commit('b: on top', { 'src/b.ts': 'export const b = 12;\n' });
      // (Its advisory files are its own: maya's send-back leases still cover src/bad.ts.)
      const L2 = sc.land(b, { summary: 'on top of maya', files: ['src/b.ts'] });
      await sc.once();
      const failed = sc.landing(L2.id);
      expect(failed.failure?.code).toBe('contains_unlanded');
      expect(failed.report?.message).toContain(L1.id);
      expect(sc.hub.inbox(P, b.agent, { peek: true }).messages.some((m) => m.body.includes('contains_unlanded') && m.body.includes(L1.id))).toBe(true);
    },
    T,
  );

  it(
    "config invalid on trunk: a strict parse error pauses landing (config_invalid) and admits nothing; the lenient parse still reads it",
    async () => {
      const sc = await scenario();
      // The lander starts on a valid trunk (its startup report pauses nothing), then the typo lands on trunk by hand.
      await sc.lander.ensureLease();
      expect(sc.hub.landerStatus(P).control.paused).toBeNull();
      const bad = JSON.parse(sc.agenthubJson()) as { land: Record<string, unknown> };
      bad.land.chekc = 'typo';
      sc.foreignPush({ 'agenthub.json': `${JSON.stringify(bad, null, 2)}\n` }, 'a typo in agenthub.json');
      const a = sc.clone('maya/claude-1');
      a.commit('a: change', { 'src/a.ts': 'export const a = 13;\n' });
      const L = sc.land(a, { summary: 'a = 13' });
      // Admission reads trunk's config itself (§2.2.4 step 2): invalid → pause, admit nothing.
      try {
        expect(await sc.lander.admitRound()).toBe(0);
      } finally {
        await sc.lander.lease.release();
      }
      const control = sc.hub.landerStatus(P).control;
      expect(control.paused?.reason).toBe('config_invalid');
      expect(control.paused?.detail).toContain('land.chekc');
      expect(sc.logs.some((l) => l.startsWith('admission: ') && l.includes('land.chekc') && l.includes('config_invalid'))).toBe(true);
      expect(sc.landing(L.id).status).toBe('submitted');
      // A whole run --once (startup report, admission, next) changes nothing while it is paused.
      await sc.once();
      expect(sc.hub.landerStatus(P).control.paused?.reason).toBe('config_invalid');
      expect(sc.landing(L.id).status).toBe('submitted');
      // What hooks, the digest and the guard use: lenient, so edits keep working, and the problem is reported.
      const lenient = parseTeamSections(bad, { strict: false });
      expect(lenient.sections.land?.check).toBe(CHECK);
      expect(lenient.problems.join('\n')).toContain('land.chekc');
    },
    T,
  );

  it(
    'not_lander: a lease lost during the checks kills the check and pushes nothing; the lander claims again and attempt 2 lands',
    async () => {
      const sc = await scenario({ leaseTtlMs: 1_500 });
      const a = sc.clone('maya/claude-1');
      const seedTip = sc.trunk();
      a.commit('a: change', { 'src/a.ts': 'export const a = 14;\n' });
      writeFileSync(path.join(sc.gate, 'block'), '');
      const L = sc.land(a, { summary: 'a = 14' });
      sc.background();
      await waitFor(() => existsSync(path.join(sc.gate, 'started')), 'the check to start');
      const first = sc.lander.lease.claim!;
      // The hub ends the lease behind the lander's back (as a lapse would): T9 lander_lost.
      sc.hub.store.updateClaim(P, first, { expires_at: sc.hub.now() - 1 });
      await waitFor(() => sc.landing(L.id).status === 'landed', 'the landing to land');
      await sc.stop();
      const done = sc.landing(L.id);
      expect(done.retries.lander_lost).toBe(1);
      expect(done.attempt).toBe(2);
      expect(done.lease_claim_id).not.toBe(first);
      expect(sc.firstParents(seedTip)).toEqual([done.trunk_sha]);
      expect(sc.trailers(done.trunk_sha!)['Agenthub-Attempt']).toBe('2');
      expect(sc.checkRuns(L.id)).toHaveLength(2);
      expect(sc.logs.some((l) => l.includes('lost the lander lease'))).toBe(true);
      // The blocked check was killed, not left running: nothing of it is in the run directory any more.
      expect(existsSync(path.join(sc.workdir, 'runs', `${L.id}.1`))).toBe(false);
    },
    T,
  );
});
