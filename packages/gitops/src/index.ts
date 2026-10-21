// Step 0 stub: every function throws until lane L implements @agenthub/gitops
// here (design §6.5 L1). The interface is frozen in ./types.ts.

import type { GitOps } from './types.js';

export type * from './types.js';

function notImplemented(): never {
  throw new Error('not implemented');
}

export const open: GitOps['open'] = notImplemented;
export const features: GitOps['features'] = notImplemented;
export const revParse: GitOps['revParse'] = notImplemented;
export const isAncestor: GitOps['isAncestor'] = notImplemented;
export const mergeBase: GitOps['mergeBase'] = notImplemented;
export const diffNames: GitOps['diffNames'] = notImplemented;
export const showBlob: GitOps['showBlob'] = notImplemented;
export const blobId: GitOps['blobId'] = notImplemented;
export const mergeTrees: GitOps['mergeTrees'] = notImplemented;
export const spliceTree: GitOps['spliceTree'] = notImplemented;
export const commitTree: GitOps['commitTree'] = notImplemented;
export const landedBase: GitOps['landedBase'] = notImplemented;
export const trunkTrailers: GitOps['trunkTrailers'] = notImplemented;
export const findLandingCommit: GitOps['findLandingCommit'] = notImplemented;
export const sanitizeMessageText: GitOps['sanitizeMessageText'] = notImplemented;
export const replay: GitOps['replay'] = notImplemented;
export const forecastConflicts: GitOps['forecastConflicts'] = notImplemented;
export const stashCreate: GitOps['stashCreate'] = notImplemented;
export const pushTrunk: GitOps['pushTrunk'] = notImplemented;
export const pushRef: GitOps['pushRef'] = notImplemented;
export const lsRemote: GitOps['lsRemote'] = notImplemented;
export const approvalDigest: GitOps['approvalDigest'] = notImplemented;

export const gitops: GitOps = {
  open,
  features,
  revParse,
  isAncestor,
  mergeBase,
  diffNames,
  showBlob,
  blobId,
  mergeTrees,
  spliceTree,
  commitTree,
  landedBase,
  trunkTrailers,
  findLandingCommit,
  sanitizeMessageText,
  replay,
  forecastConflicts,
  stashCreate,
  pushTrunk,
  pushRef,
  lsRemote,
  approvalDigest,
};
