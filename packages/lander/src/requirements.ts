// Approval requirements (design §1.4 "Approvals"): content digests over
// exactly what a human is shown, computed with gitops.approvalDigest, the one
// function the approvers' CLI and the tests use too. `protected` covers the
// agent's own change to protected paths (admission, and again at the
// attempt); `merged` covers merged content where trunk changed a protected
// file too (the attempt, bound to the candidate). The hub enforces them
// before `pushing`; the lander checks them only to decide whether to park.

import { humanOf, protectedMatches, type ProtectedRule } from '@agenthub/contract';
import { approvalDigest } from '@agenthub/gitops';
import type { ApprovalRequirement, ApprovalRule, LandingApproval } from '@agenthub/hub/protocol';
import type { GitPort } from './ports.js';

function ruleOf(r: ProtectedRule): ApprovalRule {
  return { paths: [...r.paths], approvers: r.approvers === null ? null : [...r.approvers], distinct: r.distinct };
}

/** The protected paths among `files`, sorted. */
export function protectedPaths(files: readonly string[], rules: readonly ProtectedRule[]): string[] {
  return [...new Set(protectedMatches(files, rules).flatMap((m) => m.paths))].sort();
}

/** One `protected` requirement per matched rule, over (path, blob(base:path), blob(head:path)) of the paths it covers. */
export async function protectedRequirements(git: Pick<GitPort, 'blobId'>, rules: readonly ProtectedRule[], files: readonly string[], base: string, head: string): Promise<ApprovalRequirement[]> {
  const out: ApprovalRequirement[] = [];
  for (const { rule, paths } of protectedMatches(files, rules)) {
    const entries = [];
    for (const p of paths) entries.push({ path: p, blobs: [await git.blobId(base, p), await git.blobId(head, p)] });
    out.push({ kind: 'protected', digest: approvalDigest('protected', entries), paths, rules: [ruleOf(rule)], candidate: null, candidate_ref: null, trunk_base: null });
  }
  return out;
}

/**
 * One `merged` requirement per matched rule, for the protected paths whose
 * merged blob (in tree `merged`) differs from the agent's (trunk changed them
 * too), over (path, blob(T0:path), blob(C:path)), bound to the candidate.
 */
export async function mergedRequirements(
  git: Pick<GitPort, 'blobId'>,
  rules: readonly ProtectedRule[],
  paths: readonly string[],
  o: { head: string; trunk: string; merged: string; candidate: string; candidateRef: string },
): Promise<ApprovalRequirement[]> {
  const changed: string[] = [];
  for (const p of paths) if ((await git.blobId(o.merged, p)) !== (await git.blobId(o.head, p))) changed.push(p);
  const out: ApprovalRequirement[] = [];
  for (const { rule, paths: covered } of protectedMatches(changed, rules)) {
    const entries = [];
    for (const p of covered) entries.push({ path: p, blobs: [await git.blobId(o.trunk, p), await git.blobId(o.merged, p)] });
    out.push({
      kind: 'merged',
      digest: approvalDigest('merged', entries),
      paths: covered,
      rules: [ruleOf(rule)],
      candidate: o.candidate,
      candidate_ref: o.candidateRef,
      trunk_base: o.trunk,
    });
  }
  return out;
}

/** A rule lets `approver` approve `agent`'s landing: it names them (or anyone) and, if distinct, they aren't the agent's human. */
export function allowedBy(rule: ApprovalRule, approver: string, agent: string): boolean {
  return (rule.approvers === null || rule.approvers.includes(approver)) && !(rule.distinct && approver === humanOf(agent));
}

/** Every rule of the requirement has an approval with its kind and digest from a human the rule allows (the hub's rule). */
export function satisfied(r: ApprovalRequirement, approvals: readonly LandingApproval[], agent: string): boolean {
  return r.rules.every((rule) => approvals.some((a) => a.kind === r.kind && a.digest === r.digest && allowedBy(rule, a.by, agent)));
}

export function missingApprovals(required: readonly ApprovalRequirement[], approvals: readonly LandingApproval[], agent: string): ApprovalRequirement[] {
  return required.filter((r) => !satisfied(r, approvals, agent));
}

/** Requirements without repeats (same kind and digest), in order. */
export function uniqueRequirements(rs: readonly ApprovalRequirement[]): ApprovalRequirement[] {
  const seen = new Set<string>();
  return rs.filter((r) => {
    const key = `${r.kind}\u0000${r.digest}\u0000${JSON.stringify(r.rules)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
