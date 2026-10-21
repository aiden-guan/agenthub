// packages/symbols/src/types.ts — frozen at Step 0. Lane S implements
// `export const symbols: Symbols` (and the same functions as named exports) in
// packages/symbols/src/index.ts. Keys follow SYMBOL_KEY_RE in @agenthub/contract.

export type LanguageId = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'rust' | 'java';

export type ItemKind =
  | 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'namespace' | 'struct' | 'trait' | 'impl'
  | 'method' | 'field' | 'constructor' | 'imports' | 'toplevel';

export interface Item {
  /** `login`, `Session`, `Session.refresh`, `default`, `@imports` or `@toplevel`. */
  key: string;
  kind: ItemKind;
  /** UTF-16 offsets (JS string indices), attached leading comments and decorators included. */
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  /** A container's own text has its members' spans blanked (its "shell"). Same-key siblings are concatenated in order. */
  text: string;
  /** Normalized signature (design §2.4.4); null for none (bodies, values, regions). */
  signature: string | null;
  members: Item[];
}

export interface Outline {
  language: LanguageId;
  /** Top-level items in source order (members nested). */
  items: Item[];
  /**
   * `none`; `contained` when every ERROR/MISSING node lies inside the body of
   * a named declaration (their keys are in `errorKeys`); `uncontained`
   * otherwise (a top-level ERROR, or an error inside @toplevel/@imports).
   */
  errors: 'none' | 'contained' | 'uncontained';
  errorKeys: string[];
}

export type FileLevelReason =
  | 'unsupported_language'
  | 'disabled'
  | 'excluded'
  | 'new_file'
  | 'deleted_file'
  | 'whole_file_write'
  | 'notebook'
  | 'binary'
  | 'too_large'
  | 'parse_error'
  | 'too_many_symbols'
  | 'edit_not_applicable'
  | 'grammar_unverified';

export interface SignatureChange {
  symbol: string;
  kind: 'signature' | 'removed' | 'renamed';
  before: string;
  after: string | null;
  renamed_to?: string;
}

export type SymbolDiff =
  | { fileLevel: true; reason: FileLevelReason; mapper: string }
  | { fileLevel: false; symbols: string[]; signatureChanges: SignatureChange[]; mapper: string };

export interface TextEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface Symbols {
  /** `sym1;vtsw0.3.1;wts0.27.0;<first 8 hex of the grammar manifest's sha256>`: bumps with any grammar or rule change. */
  readonly MAPPER_VERSION: string;
  languageFor(path: string): LanguageId | null;
  outline(source: string, language: LanguageId): Promise<Outline>;
  /** Mirrors the Edit tool: the first occurrence (exactly one required) or every occurrence with replace_all; null when it would fail. MultiEdit: apply in order. */
  applyEdit(before: string, edit: TextEdit): string | null;
  /** The keys a change from before to after touches (null = the file is absent on that side). */
  changedSymbols(path: string, before: string | null, after: string | null, o?: { maxSymbols?: number; exclude?: string[] }): Promise<SymbolDiff>;
  /** For each name: the keys of the items in `source` that use it as an identifier (never in comments or strings). null = unsupported. */
  referencesIn(path: string, source: string, names: string[]): Promise<Map<string, string[]> | null>;
  /** Every identifier used in `source` → the keys it occurs in: the value the content-addressed reference cache stores per blob. */
  identifierIndex(path: string, source: string): Promise<Record<string, string[]> | null>;
  /** Top-level keys of `source` that no entry in `held` overlaps: the "rest of the file is free" list in deny messages. */
  freeKeys(path: string, source: string, held: Array<{ symbol?: string }>): Promise<string[] | null>;
  /** The text of the import statements that name a module (for the impact import filter). */
  importsText(path: string, source: string): Promise<string | null>;
}
