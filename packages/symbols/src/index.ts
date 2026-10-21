// @agenthub/symbols: tree-sitter outlines, symbol diffs and references for
// agenthub's function-level claims and impact warnings (design §1.10, §2.4,
// §2.5). The interface is frozen in ./types.ts.
//
// S1: MAPPER_VERSION, languageFor and outline (TypeScript, TSX, JavaScript).
// The rest is implemented by steps S2–S4 and throws until then.

import { languageFor as languageOf } from './languages/index.js';
import { outlineWith } from './outline.js';
import { defaultRuntime, MANIFEST_SHA256 } from './runtime.js';
import type { Symbols } from './types.js';

export type * from './types.js';
export { SymbolsError } from './errors.js';

/** Rule version, grammar and runtime package versions, and the grammar manifest's hash: bumps with any rule or grammar change. */
export const MAPPER_VERSION = `sym1;vtsw0.3.1;wts0.27.0;${MANIFEST_SHA256.slice(0, 8)}`;

function notImplemented(): never {
  throw new Error('not implemented');
}

export const languageFor: Symbols['languageFor'] = languageOf;
export const outline: Symbols['outline'] = (source, language) => outlineWith(defaultRuntime, source, language);
export const applyEdit: Symbols['applyEdit'] = notImplemented;
export const changedSymbols: Symbols['changedSymbols'] = notImplemented;
export const referencesIn: Symbols['referencesIn'] = notImplemented;
export const identifierIndex: Symbols['identifierIndex'] = notImplemented;
export const freeKeys: Symbols['freeKeys'] = notImplemented;
export const importsText: Symbols['importsText'] = notImplemented;

export const symbols: Symbols = {
  MAPPER_VERSION,
  languageFor,
  outline,
  applyEdit,
  changedSymbols,
  referencesIn,
  identifierIndex,
  freeKeys,
  importsText,
};
