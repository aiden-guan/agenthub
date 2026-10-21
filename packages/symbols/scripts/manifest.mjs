#!/usr/bin/env node
// Regenerates packages/symbols/grammars.manifest.json from the installed
// packages (design §2.4 "Integrity"): the package, version, file, size and
// sha256 of each grammar `.wasm`, plus the web-tree-sitter runtime `.wasm`.
//
//   node packages/symbols/scripts/manifest.mjs           write the manifest
//   node packages/symbols/scripts/manifest.mjs --check   exit 1 if it is stale
//
// The loader (src/runtime.ts) refuses any file whose size or sha256 differs
// from the committed manifest, and MAPPER_VERSION carries the manifest's hash,
// so regenerating the manifest after a grammar upgrade also bumps the mapper.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(PACKAGE_DIR, 'grammars.manifest.json');

export const RUNTIME_PACKAGE = 'web-tree-sitter';
export const RUNTIME_FILE = 'web-tree-sitter.wasm';
export const GRAMMAR_PACKAGE = '@vscode/tree-sitter-wasm';
/** Language id → grammar file inside GRAMMAR_PACKAGE. */
export const GRAMMAR_FILES = {
  typescript: 'wasm/tree-sitter-typescript.wasm',
  tsx: 'wasm/tree-sitter-tsx.wasm',
  javascript: 'wasm/tree-sitter-javascript.wasm',
  python: 'wasm/tree-sitter-python.wasm',
  go: 'wasm/tree-sitter-go.wasm',
  rust: 'wasm/tree-sitter-rust.wasm',
  java: 'wasm/tree-sitter-java.wasm',
};

const require = createRequire(path.join(PACKAGE_DIR, 'package.json'));

/** The installed version of a package (found next to a file it exports, since web-tree-sitter doesn't export its package.json). */
function installedVersion(pkg, exportedFile) {
  let dir = path.dirname(require.resolve(`${pkg}/${exportedFile}`));
  for (;;) {
    try {
      const json = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (json.name === pkg) return json.version;
    } catch {
      // keep looking upwards
    }
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`cannot find the package.json of ${pkg}`);
    dir = up;
  }
}

function entry(pkg, file, version) {
  const bytes = readFileSync(require.resolve(`${pkg}/${file}`));
  return { package: pkg, version, file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The manifest the installed packages call for. */
export function buildManifest() {
  const grammarVersion = installedVersion(GRAMMAR_PACKAGE, GRAMMAR_FILES.typescript);
  const runtimeVersion = installedVersion(RUNTIME_PACKAGE, RUNTIME_FILE);
  const grammars = {};
  for (const [lang, file] of Object.entries(GRAMMAR_FILES)) grammars[lang] = entry(GRAMMAR_PACKAGE, file, grammarVersion);
  return { runtime: entry(RUNTIME_PACKAGE, RUNTIME_FILE, runtimeVersion), grammars };
}

export function formatManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const text = formatManifest(buildManifest());
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(MANIFEST_PATH, 'utf8');
    } catch {
      // missing counts as stale
    }
    if (current !== text) {
      process.stderr.write(`${path.relative(process.cwd(), MANIFEST_PATH)} does not match the installed grammars; run node ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}\n`);
      process.exit(1);
    }
    process.stdout.write('grammars.manifest.json matches the installed grammars\n');
  } else {
    writeFileSync(MANIFEST_PATH, text);
    process.stdout.write(`wrote ${MANIFEST_PATH}\n`);
  }
}
