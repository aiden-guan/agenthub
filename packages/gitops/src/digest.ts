// The approval digest (design §1.4 "Approvals"). The lander, the approvers'
// CLI (`hub approve`) and the tests all compute it with this one function.

import { createHash } from 'node:crypto';

const BLOBS_PER_KIND = { protected: 2, merged: 2, ai_resolution: 4 } as const;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * sha256 hex over the sorted lines `kind NUL path NUL a NUL b [NUL c NUL d]`,
 * each ending in a newline:
 * - protected: base and head blobs of each protected path the change touches;
 * - merged: trunk_base and candidate blobs;
 * - ai_resolution: base, ours, theirs and result blobs.
 * A missing blob (the path is absent on that side) is the empty string. Lines
 * sort by their UTF-8 bytes, so the entries' order doesn't matter.
 */
export function approvalDigest(kind: 'protected' | 'merged' | 'ai_resolution', entries: Array<{ path: string; blobs: Array<string | null> }>): string {
  if (!Object.hasOwn(BLOBS_PER_KIND, kind)) throw new Error(`gitops: bad approval kind ${JSON.stringify(kind)}`);
  const n = BLOBS_PER_KIND[kind];
  const lines = entries.map((e) => {
    if (!e.path || e.path.includes('\0')) throw new Error(`gitops: bad path ${JSON.stringify(e.path)} in an approval digest`);
    if (e.blobs.length !== n) throw new Error(`gitops: a ${kind} digest entry takes ${n} blobs, got ${e.blobs.length} for ${e.path}`);
    for (const b of e.blobs) if (b !== null && !OBJECT_ID_RE.test(b)) throw new Error(`gitops: ${JSON.stringify(b)} is not an object id (${e.path})`);
    return Buffer.from([kind, e.path, ...e.blobs.map((b) => b ?? '')].join('\0') + '\n', 'utf8');
  });
  lines.sort(Buffer.compare);
  const h = createHash('sha256');
  for (const l of lines) h.update(l);
  return h.digest('hex');
}
