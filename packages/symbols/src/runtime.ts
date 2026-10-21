// The tree-sitter runtime (design §2.4 "Packages", "Integrity", "Performance").
//
// - Grammars come from @vscode/tree-sitter-wasm, loaded as bytes through
//   createRequire (no install scripts, no network).
// - Every file (each grammar, and web-tree-sitter's own runtime .wasm) is
//   checked against grammars.manifest.json (size and sha256) before it is
//   loaded. A mismatch disables that language, or every language for the
//   runtime file, and is logged once: such files are mapped whole-file
//   (`grammar_unverified`).
// - Parser.init runs once per process; each language gets one Language and one
//   Parser, created on first use and cached.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';
import type { LanguageId } from './types.js';

export interface ManifestEntry {
  package: string;
  version: string;
  /** Path inside the package. */
  file: string;
  size: number;
  sha256: string;
}

export interface GrammarManifest {
  runtime: ManifestEntry;
  grammars: Record<LanguageId, ManifestEntry>;
}

const MANIFEST_TEXT = readFileSync(new URL('../grammars.manifest.json', import.meta.url), 'utf8');

/** The committed manifest (packages/symbols/grammars.manifest.json; regenerate it with scripts/manifest.mjs). */
export const MANIFEST: GrammarManifest = JSON.parse(MANIFEST_TEXT) as GrammarManifest;

/** sha256 of the manifest's canonical JSON (its parsed value, re-serialized), so line endings or indentation don't change it. */
export const MANIFEST_SHA256 = sha256(JSON.stringify(MANIFEST));

/** Rule version, grammar and runtime package versions, and the grammar manifest's hash: bumps with any rule or grammar change. */
export const MAPPER_VERSION = `sym1;vtsw0.3.1;wts0.27.0;${MANIFEST_SHA256.slice(0, 8)}`;

export type GrammarStatus = 'unloaded' | 'ready' | 'unverified';

export interface Grammar {
  language: LanguageId;
  parser: Parser;
}

export interface RuntimeOptions {
  /** The manifest to verify against (default: the committed one). */
  manifest?: GrammarManifest;
  /** Where an entry's file is (default: resolved in the installed package). */
  locate?: (entry: ManifestEntry) => string;
  /** Where the one-time integrity warnings go (default: stderr). */
  warn?: (message: string) => void;
}

const require = createRequire(import.meta.url);

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Parser.init loads one WASM runtime per process, whichever GrammarRuntime asks first. */
let parserInit: Promise<void> | null = null;

export class GrammarRuntime {
  private readonly manifest: GrammarManifest;
  private readonly locate: (entry: ManifestEntry) => string;
  private readonly warn: (message: string) => void;
  private runtimeReady: Promise<boolean> | null = null;
  private readonly grammars = new Map<LanguageId, Promise<Grammar | null>>();
  private readonly states = new Map<LanguageId, GrammarStatus>();
  private readonly warned = new Set<string>();

  constructor(opts: RuntimeOptions = {}) {
    this.manifest = opts.manifest ?? MANIFEST;
    this.locate = opts.locate ?? ((entry) => require.resolve(`${entry.package}/${entry.file}`));
    this.warn = opts.warn ?? ((message) => process.stderr.write(`${message}\n`));
  }

  status(language: LanguageId): GrammarStatus {
    return this.states.get(language) ?? 'unloaded';
  }

  /** The verified grammar for `language`, or null when it (or the runtime) failed the integrity check. Loaded once. */
  load(language: LanguageId): Promise<Grammar | null> {
    let grammar = this.grammars.get(language);
    if (!grammar) {
      grammar = this.loadOnce(language);
      this.grammars.set(language, grammar);
    }
    return grammar;
  }

  private async loadOnce(language: LanguageId): Promise<Grammar | null> {
    const entry = this.manifest.grammars[language];
    if (!entry) throw new Error(`@agenthub/symbols: no grammar for language ${String(language)}`);
    const consequence = `${language} files are claimed whole-file (grammar_unverified)`;
    const bytes = (await this.ensureRuntime()) ? this.verified(entry, consequence) : null;
    if (!bytes) {
      this.states.set(language, 'unverified');
      return null;
    }
    try {
      const parser = new Parser();
      parser.setLanguage(await Language.load(bytes));
      this.states.set(language, 'ready');
      return { language, parser };
    } catch (err) {
      this.warnOnce(entry.file, `agenthub symbols: cannot load ${entry.package}/${entry.file} (${message(err)}); ${consequence}`);
      this.states.set(language, 'unverified');
      return null;
    }
  }

  private ensureRuntime(): Promise<boolean> {
    this.runtimeReady ??= (async () => {
      const bytes = this.verified(this.manifest.runtime, 'every language is claimed whole-file (grammar_unverified)');
      if (!bytes) return false;
      parserInit ??= Parser.init({ wasmBinary: bytes });
      try {
        await parserInit;
        return true;
      } catch (err) {
        parserInit = null;
        this.warnOnce(this.manifest.runtime.file, `agenthub symbols: cannot start ${this.manifest.runtime.package} (${message(err)}); every language is claimed whole-file (grammar_unverified)`);
        return false;
      }
    })();
    return this.runtimeReady;
  }

  /** The file's bytes when its size and sha256 match the manifest; otherwise null, logged once. */
  private verified(entry: ManifestEntry, consequence: string): Uint8Array | null {
    const name = `${entry.package}/${entry.file}`;
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.locate(entry));
    } catch (err) {
      this.warnOnce(entry.file, `agenthub symbols: cannot read ${name} (${message(err)}); ${consequence}`);
      return null;
    }
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
      this.warnOnce(entry.file, `agenthub symbols: ${name} does not match grammars.manifest.json (expected ${entry.size} bytes with sha256 ${entry.sha256.slice(0, 12)}…); ${consequence}`);
      return null;
    }
    return bytes;
  }

  private warnOnce(key: string, text: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(text);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The process-wide runtime behind `outline` and the other exported functions. */
export const defaultRuntime = new GrammarRuntime();
