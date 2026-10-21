// Which language a path is (design §2.4 "Languages"), and each language's table.

import type { LanguageSpec } from '../spec.js';
import type { LanguageId } from '../types.js';
import { go } from './go.js';
import { java } from './java.js';
import { javascript } from './javascript.js';
import { python } from './python.js';
import { rust } from './rust.js';
import { tsx, typescript } from './typescript.js';

const EXTENSIONS: Readonly<Record<string, LanguageId>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
};

/** The language of a file by its extension (case-insensitive), or null: everything else is file-level. */
export function languageFor(path: string): LanguageId | null {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXTENSIONS[base.slice(dot + 1).toLowerCase()] ?? null;
}

/** The outline table per language. */
export const SPECS: Partial<Record<LanguageId, LanguageSpec>> = { typescript, tsx, javascript, python, go, rust, java };
