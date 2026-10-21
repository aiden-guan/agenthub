// TypeScript and TSX: the TS/TSX/JS table of design §2.4 (see javascript.ts),
// on the TypeScript and TSX grammars.

import type { LanguageSpec } from '../spec.js';
import { ecmascript } from './javascript.js';

export const typescript: LanguageSpec = ecmascript('typescript');
export const tsx: LanguageSpec = ecmascript('tsx');
