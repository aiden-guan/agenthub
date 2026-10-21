// Which language a path is (design §2.4 "Languages"), and each language's
// table. A table is loaded on first use, so a hook process that maps one file
// loads one table (design §2.4 "Performance": the cold path).

import type { LanguageSpec } from '../spec.js';
import type { LanguageId } from '../types.js';

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

const LOADERS: Readonly<Record<LanguageId, () => Promise<LanguageSpec>>> = {
  typescript: async () => (await import('./typescript.js')).typescript,
  tsx: async () => (await import('./typescript.js')).tsx,
  javascript: async () => (await import('./javascript.js')).javascript,
  python: async () => (await import('./python.js')).python,
  go: async () => (await import('./go.js')).go,
  rust: async () => (await import('./rust.js')).rust,
  java: async () => (await import('./java.js')).java,
};

const loading = new Map<LanguageId, Promise<LanguageSpec>>();
const loaded = new Map<LanguageId, LanguageSpec>();

/** The outline table of `language`, loaded once. Rejects for a language without one. */
export function loadSpec(language: LanguageId): Promise<LanguageSpec> {
  let spec = loading.get(language);
  if (!spec) {
    const load = Object.hasOwn(LOADERS, language) ? LOADERS[language] : undefined;
    if (!load) return Promise.reject(new Error(`@agenthub/symbols: no outline table for language ${String(language)}`));
    spec = load().then((s) => {
      loaded.set(language, s);
      return s;
    });
    loading.set(language, spec);
  }
  return spec;
}

/** The outline table of `language` once `loadSpec` has loaded it, else undefined. */
export function loadedSpec(language: LanguageId): LanguageSpec | undefined {
  return loaded.get(language);
}
