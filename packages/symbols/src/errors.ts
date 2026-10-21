import type { FileLevelReason } from './types.js';

/** Why a file can't be mapped below file level, as an error: `outline()` rejects with it, `changedSymbols()` reports its reason. */
export class SymbolsError extends Error {
  constructor(
    readonly reason: FileLevelReason,
    message: string,
  ) {
    super(message);
    this.name = 'SymbolsError';
  }
}
