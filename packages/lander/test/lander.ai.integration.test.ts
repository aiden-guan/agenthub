import { afterEach, describe, expect, it } from 'vitest';
import { approvalDigest } from '@agenthub/gitops';
import { HubError } from '@agenthub/hub';
import type { Landing } from '@agenthub/hub/protocol';
import { approver, P, Scenario, type Clone } from './scenario.js';

// The AI rows of design §5.3 (the rest are in lander.integration.test.ts): a
// real bare remote, a real hub on port 0, the real lander over HTTP with the
// AI resolver run as `--resolver-command "node stub-resolver.mjs <config>"`
// (design §5 "The stub resolver"). Two agents change the same line of
// src/a.ts from the same base: maya's lands first, so sam's conflicts.

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

interface Conflicted {
  sc: Scenario;
  a: Clone;
  b: Clone;
  seedTip: string;
  /** maya's landing, on trunk as Ca. */
  La: Landing;
  Ca: string;
  /** sam's commit and landing, whose src/a.ts conflicts with Ca's. */
  Hb: string;
  Lb: Landing;
}

/**
 * maya lands `a = 2`; sam, from the same base, submits `a = 3` (nothing run
 * for it yet). With `context`, the file is first given that many lines above
 * the contested one (pushed outside the queue before the clones are made).
 */
async function conflicted(o: Parameters<typeof Scenario.create>[0], context = 0): Promise<Conflicted> {
  const sc = await scenario(o);
  const lines = Array.from({ length: context }, (_, i) => `// context line ${i + 1}\n`).join('');
  if (context > 0) sc.foreignPush({ 'src/a.ts': `${lines}export const a = 1;\n` });
  const a = sc.clone('maya/claude-1');
  const b = sc.clone('sam/claude-1');
  const seedTip = sc.trunk();
  const taskA = sc.task(a, 'Set a to 2');
  a.commit('a: a = 2', { 'src/a.ts': `${lines}export const a = 2;\n` });
  const La = sc.land(a, { task_id: taskA, summary: 'a is 2 now' });
  await sc.once();
  expect(sc.landing(La.id).status).toBe('landed');
  const Ca = sc.trunk();
  const taskB = sc.task(b, 'Set a to 3');
  const Hb = b.commit('b: a = 3', { 'src/a.ts': `${lines}export const a = 3;\n` });
  const Lb = sc.land(b, { task_id: taskB, summary: 'a is 3 now' });
  return { sc, a, b, seedTip, La, Ca, Hb, Lb };
}

function landerMessages(sc: Scenario, agent: string): string[] {
  return sc.hub
    .inbox(P, agent, { peek: true })
    .messages.filter((m) => m.from.startsWith('lander/'))
    .map((m) => m.body);
}

describe('hub-lander with the AI resolver (design §5.3, the AI rows)', () => {
  it(
    'AI success: the stub resolves the conflict; landed resolved_by ai with the trailer, and both authors are told',
    async () => {
      const { sc, a, b, La, Ca, Lb } = await conflicted({ resolver: { stub: { mode: 'union' } } });
      await sc.once();
      const done = sc.landing(Lb.id);
      expect(done.status).toBe('landed');
      expect(done.report?.resolved_by).toBe('ai');
      expect(done.report?.files_via).toEqual([{ file: 'src/a.ts', via: 'ai' }]);
      expect(done.report?.resolver).toMatchObject({ model: 'claude-opus-5-5', outcome: 'resolved', files: ['src/a.ts'], novel_lines: 0 });
      const C = done.trunk_sha!;
      expect(sc.rev(`${C}^1`)).toBe(Ca);
      expect(sc.trailers(C)['Agenthub-Resolved']).toBe('ai:claude-opus-5-5 src/a.ts');
      expect(sc.show(C, 'src/a.ts')).toBe('export const a = 2;\nexport const a = 3;\n');
      expect(sc.checkRuns(Lb.id)).toHaveLength(1);
      // One call, with both sides' intents as data.
      expect(sc.resolverCalls()).toEqual(['src/a.ts']);
      const input = sc.resolverInput();
      expect(input.incoming).toMatchObject({ landing_id: Lb.id, agent: b.agent, task_title: 'Set a to 3', summary: 'a is 3 now' });
      expect(input.trunk).toEqual([expect.objectContaining({ landing_id: La.id, agent: a.agent, task_title: 'Set a to 2', summary: 'a is 2 now' })]);
      expect(input.file.hunks).toHaveLength(1);
      // Messages to both sides (design §2.2.9, §3.4 step 5).
      for (const agent of [a.agent, b.agent]) {
        const told = landerMessages(sc, agent).filter((m) => m.includes('AI-resolved conflict in src/a.ts'));
        expect(told, agent).toHaveLength(1);
        expect(told[0]).toContain(`between ${La.id} and ${Lb.id}`);
        expect(told[0]).toContain(`git show ${C.slice(0, 12)} -- src/a.ts`);
      }
      expect(sc.agenthubRefs()).toEqual([]);
    },
    T,
  );

  it(
    'AI rejected: output the gates refuse (conflict markers left in) fails it with resolver_failed; nothing reaches trunk',
    async () => {
      const { sc, b, Ca, Lb } = await conflicted({ resolver: { stub: { mode: 'markers' } } });
      await sc.once();
      const failed = sc.landing(Lb.id);
      expect(failed.status).toBe('failed');
      expect(failed.failure?.code).toBe('resolver_failed');
      expect(failed.report?.resolver?.outcome).toBe('rejected_output');
      expect(failed.report?.conflicts).toEqual([expect.objectContaining({ file: 'src/a.ts', kind: 'content', tried: ['clean', 'ai'], ai_eligible: true })]);
      expect(failed.report?.warnings.join('\n')).toMatch(/src\/a\.ts.*rejected.*conflict-marker line/);
      expect(sc.trunk()).toBe(Ca);
      expect(sc.checkRuns(Lb.id)).toEqual([]);
      expect(landerMessages(sc, b.agent).some((m) => m.includes(Lb.id) && m.includes('resolver_failed'))).toBe(true);
    },
    T,
  );

  it(
    'AI broken: a resolution that passes the gates but fails the checks is resolver_failed, with the check report and the proposal kept',
    async () => {
      // Context lines give the file room for the extra line under the whole-file size gate (2 × max(ours, theirs)).
      const { sc, Ca, Lb } = await conflicted({ resolver: { stub: { mode: 'broken' } } }, 8);
      await sc.once();
      const failed = sc.landing(Lb.id);
      expect(failed.failure?.code).toBe('resolver_failed');
      expect(failed.report?.check?.exit_code).toBe(1);
      expect(failed.report?.check?.log_tail).toContain('src/a.ts');
      expect(failed.report?.files_via).toEqual([{ file: 'src/a.ts', via: 'ai' }]);
      expect(failed.report?.resolver?.explanations['src/a.ts']).toContain(`// ${'FAIL'}!`);
      expect(sc.checkRuns(Lb.id)).toHaveLength(1);
      expect(sc.trunk()).toBe(Ca);
    },
    T,
  );

  it(
    'AI declined: cannot_resolve fails it with conflict, the resolver’s explanation in the fix-it report',
    async () => {
      const { sc, Ca, Lb } = await conflicted({ resolver: { stub: { mode: 'decline', explanation: 'Both sides set a; which value wins is a product call.' } } });
      await sc.once();
      const failed = sc.landing(Lb.id);
      expect(failed.failure?.code).toBe('conflict');
      expect(failed.report?.resolver?.outcome).toBe('cannot_resolve');
      expect(failed.report?.conflicts).toEqual([
        expect.objectContaining({ file: 'src/a.ts', kind: 'content', tried: ['clean', 'ai'], ai_eligible: true, explanation: 'Both sides set a; which value wins is a product call.' }),
      ]);
      expect(failed.report?.conflicts[0]?.hunks).toHaveLength(1);
      expect(sc.trunk()).toBe(Ca);
      expect(sc.resolverCalls()).toEqual(['src/a.ts']);
    },
    T,
  );

  it.each([false, true])(
    'AI keeps trunk’s side of every hunk, and nothing else of the change is left (requireApproval %s): resolver_failed, never a no-op landing',
    async (requireApproval) => {
      // The model's answer passes every gate, but with it the merged tree is trunk's: sam's change would be thrown away.
      const explanation = 'Trunk already sets a; kept its value.';
      const { sc, b, Ca, Lb } = await conflicted({ resolver: { stub: { mode: 'fixture', files: { 'src/a.ts': ['export const a = 2;\n'] }, explanation } }, land: { resolver: { enabled: true, requireApproval } } });
      await sc.once();
      const failed = sc.landing(Lb.id);
      expect(failed.status).toBe('failed');
      expect(failed.failure?.code).toBe('resolver_failed');
      expect(failed.report?.resolver).toMatchObject({ outcome: 'rejected_output', files: ['src/a.ts'] });
      expect(failed.report?.files_via).toEqual([]);
      expect(failed.report?.conflicts).toEqual([expect.objectContaining({ file: 'src/a.ts', kind: 'content', tried: ['clean', 'ai'], ai_eligible: true, explanation })]);
      expect(failed.report?.warnings.join('\n')).toMatch(/src\/a\.ts: the AI resolver's output was rejected: it keeps main's version of every conflicted file.*nothing of it would land/);
      expect(sc.trunk()).toBe(Ca);
      expect(sc.resolverCalls()).toEqual(['src/a.ts']);
      expect(sc.checkRuns(Lb.id)).toEqual([]);
      expect(sc.events.some((e) => e.type === 'landing.needs_approval' && e.data.landing_id === Lb.id)).toBe(false);
      const told = landerMessages(sc, b.agent);
      expect(told.some((m) => m.includes(Lb.id) && m.includes('resolver_failed'))).toBe(true);
      expect(told.some((m) => m.includes('already on'))).toBe(false);
    },
    T,
  );

  it(
    'AI keeps trunk’s side of the conflicted file while the change’s other file lands: landed with the trailer, and both authors are told',
    async () => {
      const sc = await scenario({ resolver: { stub: { mode: 'fixture', files: { 'src/a.ts': ['export const a = 2;\n'] } } } });
      const a = sc.clone('maya/claude-1');
      const b = sc.clone('sam/claude-1');
      a.commit('a: a = 2', { 'src/a.ts': 'export const a = 2;\n' });
      sc.land(a, { summary: 'a is 2 now' });
      await sc.once();
      const Ca = sc.trunk();
      b.commit('b: a = 3, b = 2', { 'src/a.ts': 'export const a = 3;\n', 'src/b.ts': 'export const b = 2;\n' });
      const Lb = sc.land(b, { summary: 'a is 3 now, b is 2' });
      await sc.once();
      const done = sc.landing(Lb.id);
      expect(done.status).toBe('landed');
      expect(done.report?.resolved_by).toBe('ai');
      const C = done.trunk_sha!;
      expect(C).not.toBe(Ca);
      expect(sc.rev(`${C}^1`)).toBe(Ca);
      expect(sc.show(C, 'src/a.ts')).toBe('export const a = 2;\n');
      expect(sc.show(C, 'src/b.ts')).toBe('export const b = 2;\n');
      expect(sc.trailers(C)['Agenthub-Resolved']).toBe('ai:claude-opus-5-5 src/a.ts');
      expect(sc.checkRuns(Lb.id)).toHaveLength(1);
      for (const agent of [a.agent, b.agent]) expect(landerMessages(sc, agent).filter((m) => m.includes('AI-resolved conflict in src/a.ts')), agent).toHaveLength(1);
    },
    T,
  );

  it(
    'requireApproval: parks with an ai_resolution digest over the five blobs; approval lands the checked candidate without calling the stub again',
    async () => {
      const { sc, seedTip, Ca, Hb, Lb } = await conflicted({ resolver: { stub: { mode: 'union' } }, land: { resolver: { enabled: true, requireApproval: true } } });
      await sc.once();
      const parked = sc.landing(Lb.id);
      expect(parked.status).toBe('needs_approval');
      expect(parked.candidate_checked).toBe(true);
      const C = parked.candidate!;
      expect(sc.remoteRef(parked.candidate_ref!)).toBe(C);
      expect(parked.approval).toHaveLength(1);
      const req = parked.approval[0]!;
      expect(req).toMatchObject({ kind: 'ai_resolution', paths: ['src/a.ts'], rules: [{ paths: ['src/a.ts'], approvers: null, distinct: true }], candidate: C, trunk_base: Ca });
      expect(req.digest).toBe(
        approvalDigest('ai_resolution', [{ path: 'src/a.ts', blobs: [sc.blob(seedTip, 'src/a.ts'), sc.blob(Ca, 'src/a.ts'), sc.blob(Hb, 'src/a.ts'), sc.blob(C, 'src/a.ts')] }]),
      );
      expect(sc.events.some((e) => e.type === 'landing.needs_approval' && e.data.landing_id === Lb.id && e.data.parked === true)).toBe(true);
      expect(sc.resolverCalls()).toHaveLength(1);
      expect(sc.checkRuns(Lb.id)).toHaveLength(1);
      // distinct: sam's own human can't approve sam's landing; maya can.
      expect(() => sc.hub.approveLanding(P, Lb.id, { kind: 'ai_resolution', digest: req.digest }, approver('sam'))).toThrow(HubError);
      sc.hub.approveLanding(P, Lb.id, { kind: 'ai_resolution', digest: req.digest, note: 'both values are fine' }, approver('maya'));
      expect(sc.landing(Lb.id).status).toBe('queued');
      await sc.once();
      const done = sc.landing(Lb.id);
      expect(done.status).toBe('landed');
      expect(done.trunk_sha).toBe(C);
      expect(done.report?.resolved_by).toBe('ai');
      // The approved resolution was reused (byte-identical stages): no second call, and the parked checks stand.
      expect(sc.resolverCalls()).toHaveLength(1);
      expect(sc.checkRuns(Lb.id)).toHaveLength(1);
      expect(sc.firstParents(Ca)).toEqual([C]);
    },
    T,
  );

  it(
    'requireApproval: a foreign trunk commit touching the file in between forces a fresh resolution and a second approval',
    async () => {
      const { sc, Lb } = await conflicted({ resolver: { stub: { mode: 'union' } }, land: { resolver: { enabled: true, requireApproval: true } } });
      await sc.once();
      const first = sc.landing(Lb.id).approval[0]!;
      expect(first.kind).toBe('ai_resolution');
      // Someone with a bypass of the host rule pushes another change to src/a.ts; then maya approves the first resolution.
      const T1 = sc.foreignPush({ 'src/a.ts': 'export const a = 2;\nexport const extra = 1;\n' });
      sc.hub.approveLanding(P, Lb.id, { kind: 'ai_resolution', digest: first.digest }, approver('maya'));
      await sc.once();
      const again = sc.landing(Lb.id);
      expect(again.status).toBe('needs_approval');
      expect(sc.resolverCalls()).toHaveLength(2);
      const second = again.approval[0]!;
      expect(second).toMatchObject({ kind: 'ai_resolution', trunk_base: T1, candidate: again.candidate });
      expect(second.digest).not.toBe(first.digest);
      // The first approval covers the content it showed only.
      let err: unknown;
      try {
        sc.hub.approveLanding(P, Lb.id, { kind: 'ai_resolution', digest: first.digest }, approver('maya'));
      } catch (e) {
        err = e;
      }
      expect((err as HubError).code).toBe('approval_stale');
      sc.hub.approveLanding(P, Lb.id, { kind: 'ai_resolution', digest: second.digest }, approver('maya'));
      await sc.once();
      const done = sc.landing(Lb.id);
      expect(done.status).toBe('landed');
      expect(done.trunk_sha).toBe(again.candidate);
      expect(sc.show(done.trunk_sha!, 'src/a.ts')).toBe('export const a = 2;\nexport const extra = 1;\nexport const a = 3;\n');
      expect(sc.resolverCalls()).toHaveLength(2);
      expect(done.approvals.map((x) => x.digest)).toEqual([first.digest, second.digest]);
    },
    T,
  );
});
