// S1: the grammar runtime and its integrity checks (design §2.4 "Integrity"),
// MAPPER_VERSION and languageFor.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs script without type declarations
import { buildManifest, formatManifest, GRAMMAR_FILES, MANIFEST_PATH } from '../scripts/manifest.mjs';
import { languageFor, MAPPER_VERSION, outline, symbols, SymbolsError } from '../src/index.js';
import { outlineWith } from '../src/outline.js';
import { GrammarRuntime, MANIFEST, type GrammarManifest, type ManifestEntry } from '../src/runtime.js';
import type { LanguageId } from '../src/types.js';
import { PACKAGE_DIR } from './helpers.js';

const LANGS: LanguageId[] = ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java'];
const require = createRequire(path.join(PACKAGE_DIR, 'package.json'));
const installed = (entry: ManifestEntry): string => require.resolve(`${entry.package}/${entry.file}`);

const tmp = mkdtempSync(path.join(tmpdir(), 'agenthub-symbols-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A copy of every manifest file under `dir`, so a test can damage one; returns the runtime's `locate`. */
function copyAll(dir: string): (entry: ManifestEntry) => string {
  const entries = [MANIFEST.runtime, ...Object.values(MANIFEST.grammars)];
  for (const entry of entries) {
    const to = path.join(dir, entry.package, entry.file);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(installed(entry), to);
  }
  return (entry) => path.join(dir, entry.package, entry.file);
}

function flipByte(file: string, at = 0.5): void {
  const bytes = readFileSync(file);
  const i = Math.floor(bytes.length * at);
  bytes[i] = bytes[i]! ^ 0x01;
  writeFileSync(file, bytes);
}

describe('grammars.manifest.json', () => {
  it('matches the installed files byte for byte (scripts/manifest.mjs would write it unchanged)', () => {
    const committed = readFileSync(MANIFEST_PATH, 'utf8');
    expect(formatManifest(buildManifest())).toBe(committed);
    expect(JSON.parse(committed)).toEqual(MANIFEST);
  });

  it('pins every language, each with its package, version, file, size and sha256', () => {
    expect(Object.keys(MANIFEST.grammars).sort()).toEqual([...LANGS].sort());
    expect(Object.keys(GRAMMAR_FILES).sort()).toEqual([...LANGS].sort());
    for (const lang of LANGS) {
      const entry = MANIFEST.grammars[lang];
      expect(entry.package).toBe('@vscode/tree-sitter-wasm');
      expect(entry.version).toBe('0.3.1');
      expect(entry.file).toBe(`wasm/tree-sitter-${lang}.wasm`);
      const bytes = readFileSync(installed(entry));
      expect(entry.size).toBe(bytes.length);
      expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(MANIFEST.runtime).toMatchObject({ package: 'web-tree-sitter', version: '0.27.0', file: 'web-tree-sitter.wasm' });
  });

  it('--check passes on the committed manifest', () => {
    const out = execFileSync(process.execPath, [path.join(PACKAGE_DIR, 'scripts', 'manifest.mjs'), '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/matches/);
  });
});

describe('MAPPER_VERSION', () => {
  it('is the rule version, the two package versions and the first 8 hex of the manifest hash', () => {
    const canonical = JSON.stringify(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
    const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
    expect(MAPPER_VERSION).toBe(`sym1;vtsw0.3.1;wts0.27.0;${hash}`);
    expect(symbols.MAPPER_VERSION).toBe(MAPPER_VERSION);
  });
});

describe('the grammar runtime', () => {
  it('loads each language once and caches it', async () => {
    const rt = new GrammarRuntime();
    const a = await rt.load('typescript');
    expect(a).not.toBeNull();
    expect(await rt.load('typescript')).toBe(a);
    expect(rt.status('typescript')).toBe('ready');
    expect(rt.status('java')).toBe('unloaded');
    const all = await Promise.all(LANGS.map((l) => rt.load(l)));
    expect(all.every((g) => g !== null)).toBe(true);
  });

  it('a flipped byte disables that language only (grammar_unverified), logged once', async () => {
    const dir = path.join(tmp, 'flipped');
    const locate = copyAll(dir);
    flipByte(locate(MANIFEST.grammars.typescript));
    const warnings: string[] = [];
    const rt = new GrammarRuntime({ locate, warn: (m) => warnings.push(m) });

    expect(await rt.load('typescript')).toBeNull();
    expect(rt.status('typescript')).toBe('unverified');
    expect(await rt.load('typescript')).toBeNull();
    const err = await outlineWith(rt, 'function f() {}', 'typescript').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SymbolsError);
    expect((err as SymbolsError).reason).toBe('grammar_unverified');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/tree-sitter-typescript\.wasm/);
    expect(warnings[0]).toMatch(/grammar_unverified/);

    // The other languages, the TSX grammar included, still load and parse.
    expect(await rt.load('tsx')).not.toBeNull();
    const js = await outlineWith(rt, 'function f() {}', 'javascript');
    expect(js.items.map((i) => i.key)).toEqual(['f']);
    expect(warnings).toHaveLength(1);
  });

  it('a truncated or missing grammar is unverified too', async () => {
    const dir = path.join(tmp, 'truncated');
    const locate = copyAll(dir);
    truncateSync(locate(MANIFEST.grammars.javascript), MANIFEST.grammars.javascript.size - 1);
    rmSync(locate(MANIFEST.grammars.go));
    const warnings: string[] = [];
    const rt = new GrammarRuntime({ locate, warn: (m) => warnings.push(m) });
    expect(await rt.load('javascript')).toBeNull();
    expect(await rt.load('go')).toBeNull();
    expect(rt.status('go')).toBe('unverified');
    expect(await rt.load('typescript')).not.toBeNull();
    expect(warnings).toHaveLength(2);
  });

  it('a manifest that disagrees with the files disables the language', async () => {
    const manifest: GrammarManifest = structuredClone(MANIFEST);
    manifest.grammars.tsx.sha256 = '0'.repeat(64);
    const rt = new GrammarRuntime({ manifest, warn: () => {} });
    expect(await rt.load('tsx')).toBeNull();
    expect(await rt.load('typescript')).not.toBeNull();
  });

  it('loads in a fresh process from the built package', () => {
    const dist = pathToFileURL(path.join(PACKAGE_DIR, 'dist', 'index.js')).href;
    const script = `const m = await import(${JSON.stringify(dist)});
const o = await m.outline('export function login() {}\\nclass S { m() {} }\\n', 'typescript');
console.log(JSON.stringify({ keys: o.items.flatMap((i) => [i.key, ...i.members.map((x) => x.key)]), mapper: m.MAPPER_VERSION }));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({ keys: ['login', 'S', 'S.m'], mapper: MAPPER_VERSION });
  });

  it('a flipped byte in the web-tree-sitter runtime disables every language (checked in a fresh process, since the runtime initialises once per process)', () => {
    const dir = path.join(tmp, 'runtime-flipped');
    const locate = copyAll(dir);
    flipByte(locate(MANIFEST.runtime));
    const runtimeJs = pathToFileURL(path.join(PACKAGE_DIR, 'dist', 'runtime.js')).href;
    const script = `const { GrammarRuntime } = await import(${JSON.stringify(runtimeJs)});
const warnings = [];
const rt = new GrammarRuntime({ locate: (e) => ${JSON.stringify(dir)} + '/' + e.package + '/' + e.file, warn: (m) => warnings.push(m) });
const loaded = await Promise.all(['typescript', 'python'].map((l) => rt.load(l)));
console.log(JSON.stringify({ loaded: loaded.map((g) => g !== null), status: rt.status('typescript'), warnings }));`;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })) as { loaded: boolean[]; status: string; warnings: string[] };
    expect(out.loaded).toEqual([false, false]);
    expect(out.status).toBe('unverified');
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/web-tree-sitter\.wasm/);
  });
});

describe('languageFor', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['a.mts', 'typescript'],
    ['a.cts', 'typescript'],
    ['types/x.d.ts', 'typescript'],
    ['App.tsx', 'tsx'],
    ['a.js', 'javascript'],
    ['a.mjs', 'javascript'],
    ['a.cjs', 'javascript'],
    ['a.jsx', 'javascript'],
    ['pkg/mod.py', 'python'],
    ['stubs.pyi', 'python'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['src/Main.java', 'java'],
    ['A.TS', 'typescript'],
    ['win\\path\\file.go', 'go'],
  ])('%s is %s', (file, lang) => {
    expect(languageFor(file)).toBe(lang);
  });

  it.each(['README.md', 'Makefile', 'a.ts.orig', '.ts', 'x.json', 'notebook.ipynb', 'a.c', 'dir.ts/file', 'tsx'])('%s is unsupported', (file) => {
    expect(languageFor(file)).toBeNull();
  });
});

describe('outline', () => {
  it('rejects a language it has no table for yet with a plain error', async () => {
    await expect(outline('x = 1', 'nope' as LanguageId)).rejects.toThrow(/nope/);
  });
});
