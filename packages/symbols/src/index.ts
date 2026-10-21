// @agenthub/symbols: tree-sitter outlines, symbol diffs and references for
// agenthub's function-level claims and impact warnings (design §1.10, §2.4,
// §2.5). The interface is frozen in ./types.ts.
//
// S1: MAPPER_VERSION, languageFor and outline (TypeScript, TSX, JavaScript).
// S2: outline for Python, Go, Rust and Java.
// S3: applyEdit (and applyEdits for MultiEdit) and changedSymbols.
// The rest is implemented by step S4 and throws until then.

import { changedSymbolsWith } from './diff.js';
import { applyEdit as applyTextEdit, applyEdits } from './edit.js';
import { languageFor as languageOf } from './languages/index.js';
import { outlineWith } from './outline.js';
import { defaultRuntime, MAPPER_VERSION } from './runtime.js';
import type { Symbols } from './types.js';

export type * from './types.js';
export { SymbolsError } from './errors.js';
export { MAPPER_VERSION, applyEdits };

function notImplemented(): never {
  throw new Error('not implemented');
}

export const languageFor: Symbols['languageFor'] = languageOf;
export const outline: Symbols['outline'] = (source, language) => outlineWith(defaultRuntime, source, language);
export const applyEdit: Symbols['applyEdit'] = applyTextEdit;
export const changedSymbols: Symbols['changedSymbols'] = (path, before, after, o) => changedSymbolsWith(defaultRuntime, path, before, after, o);
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
