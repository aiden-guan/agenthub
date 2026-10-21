// Step 0 stub: everything throws until lane S implements @agenthub/symbols
// here (design §6.5 S1–S4). The interface is frozen in ./types.ts.

import type { Symbols } from './types.js';

export type * from './types.js';

function notImplemented(): never {
  throw new Error('not implemented');
}

export const languageFor: Symbols['languageFor'] = notImplemented;
export const outline: Symbols['outline'] = notImplemented;
export const applyEdit: Symbols['applyEdit'] = notImplemented;
export const changedSymbols: Symbols['changedSymbols'] = notImplemented;
export const referencesIn: Symbols['referencesIn'] = notImplemented;
export const identifierIndex: Symbols['identifierIndex'] = notImplemented;
export const freeKeys: Symbols['freeKeys'] = notImplemented;
export const importsText: Symbols['importsText'] = notImplemented;

export const symbols: Symbols = {
  get MAPPER_VERSION(): string {
    return notImplemented();
  },
  languageFor,
  outline,
  applyEdit,
  changedSymbols,
  referencesIn,
  identifierIndex,
  freeKeys,
  importsText,
};
