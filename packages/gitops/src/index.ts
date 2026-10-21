// @agenthub/gitops: git plumbing for the lander and the adapter (design §6.5
// L1). The interface is frozen in ./types.ts; everything here runs real git
// through node:child_process, with no npm dependencies.

import { approvalDigest } from './digest.js';
import { commitTree, forecastConflicts, mergeTrees, spliceTree } from './merge.js';
import { lsRemote, pushRef, pushTrunk } from './push.js';
import { blobId, diffNames, features, isAncestor, mergeBase, revParse, showBlob } from './queries.js';
import { replay, stashCreate } from './replay.js';
import { open } from './run.js';
import { findLandingCommit, landedBase, sanitizeMessageText, trunkTrailers } from './trailers.js';
import type { GitOps } from './types.js';

export type * from './types.js';
export type { MergeMessage, MergeTreesResult, ParsedMergeTree } from './merge.js';
export { GitError } from './run.js';
export { classifyPush, porcelainLines } from './push.js';
export { conflictedNames, conflictsOf, parseMergeTree, spliceOids } from './merge.js';
export { TRAILER_KEYS } from './trailers.js';

export {
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
