// R-25 reproduction: DocCache evicts a document that withDocs is still about to
// re-add (`cache.add(b); cache.add(a)`), so the document stays cached with a
// tree that is deleted on the next setImmediate. Later lookups on that exact
// text then fail (referencesIn / identifierIndex throw, relevantAll swallows the
// error and reports no impact) or run on a deleted tree (changedSymbols with it
// as base).
//
// Usage: AGENTHUB_ROOT=/path/to/agenthub node repro.mjs
// Exits 1 when the defect is present, 0 when it is not.
//
// Each scenario runs in its own child process so that one scenario's cache (and
// any WASM memory damage) never affects another. No network, no API key.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const SELF = fileURLToPath(import.meta.url);
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 3; i++) await tick();
};

/** A small TS file that uses `login` inside `useLogin<i>`. */
function small(i, extra = '') {
  return `import { login } from './auth.js';\n\nexport function useLogin${i}(user: string): string {\n  return login(user) + ${i};\n}\n${extra}`;
}

/** A large TS file (~`chars` UTF-16 units) that uses `login` in its first function. */
function large(tag, chars, extra = '') {
  let s = `import { login } from './auth.js';\n\nexport function first${tag}(user: string): string {\n  return login(user);\n}\n${extra}`;
  let i = 0;
  while (s.length < chars) {
    s += `export function f${tag}_${i}(a: number, b: number): number { return a * ${i} + b; }\n`;
    i++;
  }
  return s;
}

function show(v) {
  if (v instanceof Map) return JSON.stringify([...v]);
  return JSON.stringify(v);
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: `${err?.constructor?.name}: ${err?.message}` };
  }
}

// ---------------------------------------------------------------- scenario: count

// The finding's scenario: a feed has run referencesIn on 8 claimed files F0..F7
// (cache [F0..F7], F0 least recently used); `land`'s diffScope then runs
// changedSymbols('src/f0.ts', base0, F0) whose head text is F0.
async function scenarioCount() {
  const sym = await imp('packages/symbols/dist/index.js');
  const files = Array.from({ length: 8 }, (_, i) => ({ path: `src/f${i}.ts`, text: small(i) }));
  // identifierIndex first, so the referencesIn loop leaves the cache [F0..F7] with F0 least recently used.
  const expectedIdx = show(await sym.identifierIndex(files[0].path, files[0].text));
  const expected = [];
  for (const f of files) expected.push(show(await sym.referencesIn(f.path, f.text, ['login'])));
  console.log(`  baseline referencesIn(src/f0.ts, F0, ['login']) = ${expected[0]}`);

  const base0 = small(0, `\nexport function helper(): number {\n  return 1;\n}\n`);
  const diff = await sym.changedSymbols('src/f0.ts', base0, files[0].text);
  console.log(`  changedSymbols(src/f0.ts, base0, F0) = ${show(diff)}`);
  await settle(); // the evicted tree is deleted on setImmediate

  let failures = 0;
  const r1 = await attempt(() => sym.referencesIn('src/f0.ts', files[0].text, ['login']));
  const bad1 = !r1.ok || show(r1.value) !== expected[0];
  console.log(`  after: referencesIn(src/f0.ts, F0) -> ${r1.ok ? show(r1.value) : `THROWS ${r1.error}`}${bad1 ? '   <-- DEFECT' : ''}`);
  if (bad1) failures++;

  const r2 = await attempt(() => sym.identifierIndex('src/f0.ts', files[0].text));
  const bad2 = !r2.ok || show(r2.value) !== expectedIdx;
  console.log(`  after: identifierIndex(src/f0.ts, F0) -> ${r2.ok ? 'ok' : `THROWS ${r2.error}`}${bad2 ? '   <-- DEFECT' : ''}`);
  if (bad2) failures++;

  // Persistence: map 7 other files (enough to push F0 out of an 8-entry LRU if
  // the failed uses did not keep re-adding it as most recently used).
  for (const f of files.slice(1)) await sym.referencesIn(f.path, f.text, ['login']);
  await settle();
  const r3 = await attempt(() => sym.referencesIn('src/f0.ts', files[0].text, ['login']));
  const bad3 = !r3.ok || show(r3.value) !== expected[0];
  console.log(`  after mapping 7 other files: referencesIn(src/f0.ts, F0) -> ${r3.ok ? show(r3.value) : `THROWS ${r3.error}`}${bad3 ? '   <-- DEFECT (still cached broken)' : ''}`);
  if (bad3) failures++;

  // A fresh text (one character different) is unaffected: it is the cached Doc, not the file.
  const other = await attempt(() => sym.referencesIn('src/f0.ts', files[0].text + ' ', ['login']));
  console.log(`  control: referencesIn(src/f0.ts, F0 + ' ') -> ${other.ok ? show(other.value) : `THROWS ${other.error}`}`);
  return failures;
}

// ---------------------------------------------------------------- scenario: relevantAll

// The consumer: the adapter's relevantAll (feed, hub_wait, who_uses path) on
// the agent's claimed file swallows the throw and reports no impact.
async function scenarioRelevance() {
  const sym = await imp('packages/symbols/dist/index.js');
  const { relevantAll } = await imp('packages/adapter/dist/impact.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'r25-'));
  try {
    mkdirSync(path.join(dir, 'src'));
    const files = Array.from({ length: 8 }, (_, i) => ({ path: `src/f${i}.ts`, text: small(i) }));
    for (const f of files) writeFileSync(path.join(dir, f.path), f.text);
    const now = Date.now();
    const claims = files.map((f, i) => ({
      id: `c${i}`, holder: 'me', status: 'active', landing_id: null, mapper: sym.MAPPER_VERSION,
      scope: [{ file: f.path, symbol: `useLogin${i}` }], created_at: now, updated_at: now,
    }));
    const change = {
      id: 'sc1', agent: 'other', file: 'src/auth.ts', symbol: 'login', name: 'login', status: 'landed',
      before: 'login(user: string): string', after: 'login(user: string, otp: string): string', created_at: now, updated_at: now,
    };
    const ctx = { root: dir, claims };
    const before = await relevantAll([change], 'me', ctx);
    const sitesBefore = before[0]?.sites.map((s) => s.file) ?? [];
    console.log(`  baseline relevantAll(login landed) sites = ${JSON.stringify(sitesBefore)}`);

    // `land` -> diffScope -> changedSymbols(src/f0.ts, base0, F0), F0 = current bytes.
    const base0 = small(0, `\nexport function helper(): number {\n  return 1;\n}\n`);
    await sym.changedSymbols('src/f0.ts', base0, files[0].text);
    await settle();

    const after = await relevantAll([change], 'me', ctx);
    const sitesAfter = after[0]?.sites.map((s) => s.file) ?? [];
    const missing = sitesBefore.filter((f) => !sitesAfter.includes(f));
    console.log(`  after changedSymbols: relevantAll sites = ${JSON.stringify(sitesAfter)}${missing.length ? `   <-- DEFECT: ${missing.join(', ')} silently dropped` : ''}`);
    return missing.length ? 1 : 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- scenario: base

// The broken Doc used as a diff base. F0 has three functions; base0 differs
// from it inside alpha only. After the defect, F0's Doc (tree deleted) stays
// cached because the feed keeps using it; base0 and the other files are evicted
// meanwhile, which frees the subtrees F0's tree shared with base0's. Then a
// body-only edit of useLogin0 (no signature change) is diffed with F0 as base:
// parseDoc copies the deleted tree (address 0) as its incremental base, and
// signatureOf(base) walks Node objects of the deleted tree.
const BASE_F0 = small(0, `\nexport function alpha(x: number): number {\n  return x + 1;\n}\n\nexport function beta(y: string): string {\n  return y;\n}\n`);
const BASE_NEXT = BASE_F0.replace('return login(user) + 0;', 'return login(user) + 7;');

async function scenarioBase() {
  const sym = await imp('packages/symbols/dist/index.js');
  const files = [BASE_F0, ...Array.from({ length: 7 }, (_, i) => small(i + 1))];
  for (let i = 0; i < 8; i++) await sym.referencesIn(`src/f${i}.ts`, files[i], ['login']);
  const base0 = BASE_F0.replace('return x + 1;', 'return x + 2;');
  await sym.changedSymbols('src/f0.ts', base0, BASE_F0); // the defect: F0's Doc is re-added with a doomed tree
  await settle();

  // Probe the cached Doc of F0 directly (dist internals, for the trace only).
  const { docCache } = await imp('packages/symbols/dist/document.js');
  const { defaultRuntime } = await imp('packages/symbols/dist/runtime.js');
  const cached = docCache(defaultRuntime).get('typescript', BASE_F0);
  const addr = cached ? cached.tree[0] : null;
  console.log(`  cached Doc of F0: ${cached ? `present, tree address = ${addr}${addr === 0 ? ' (deleted)' : ''}` : 'absent'}`);

  // Other files get mapped; the feed keeps touching F0 (each failed use re-adds it).
  for (let i = 0; i < 12; i++) {
    await sym.referencesIn(`src/z${i}.ts`, small(100 + i), ['login']);
    if (i % 3 === 0) await sym.referencesIn('src/f0.ts', BASE_F0, ['login']).catch(() => {});
    await tick();
  }
  await sym.referencesIn('src/f0.ts', BASE_F0, ['login']).catch(() => {});
  await settle();
  const still = docCache(defaultRuntime).get('typescript', BASE_F0);
  console.log(`  later: cached Doc of F0 is ${still === cached ? 'the same Doc object' : 'a different Doc'} (tree address ${still?.tree[0]}); base0 cached: ${docCache(defaultRuntime).get('typescript', base0) !== null}`);

  const r = await attempt(() => sym.changedSymbols('src/f0.ts', BASE_F0, BASE_NEXT));
  console.log(`  changedSymbols(src/f0.ts, F0 -> body-only edit of useLogin0) with the broken Doc as base -> ${r.ok ? show(r.value) : `THROWS ${r.error}`}`);
  return { brokenCached: cached !== null && addr === 0 && still === cached, result: r.ok ? show(r.value) : `THROWS ${r.error}` };
}

// The same diff in a clean process: the answer the broken one should give.
async function scenarioBaseExpected() {
  const sym = await imp('packages/symbols/dist/index.js');
  const r = await attempt(() => sym.changedSymbols('src/f0.ts', BASE_F0, BASE_NEXT));
  return { result: r.ok ? show(r.value) : `THROWS ${r.error}` };
}

// ---------------------------------------------------------------- scenario: chars

// The char limit: three large documents. Cache [A, C] (A least recently used),
// then changedSymbols(path, B, A): add(B) evicts A by size, add(A) re-adds it.
async function scenarioChars() {
  const sym = await imp('packages/symbols/dist/index.js');
  const A = large('A', 750_000);
  const C = large('C', 750_000);
  const B = large('A', 750_000, `\nexport function helperA(): number {\n  return 1;\n}\n`);
  const expected = show(await sym.referencesIn('src/a.ts', A, ['login']));
  await sym.referencesIn('src/c.ts', C, ['login']);
  console.log(`  sizes A=${A.length} B=${B.length} C=${C.length} (limit 2097152 chars); baseline referencesIn(A) = ${expected}`);
  await sym.changedSymbols('src/a.ts', B, A);
  await settle();
  const r = await attempt(() => sym.referencesIn('src/a.ts', A, ['login']));
  const bad = !r.ok || show(r.value) !== expected;
  console.log(`  after changedSymbols(B -> A): referencesIn(src/a.ts, A) -> ${r.ok ? show(r.value) : `THROWS ${r.error}`}${bad ? '   <-- DEFECT' : ''}`);
  return bad ? 1 : 0;
}

// ---------------------------------------------------------------- driver

const scenarios = { count: scenarioCount, relevance: scenarioRelevance, base: scenarioBase, chars: scenarioChars, baseExpected: scenarioBaseExpected };

if (process.argv[2]) {
  const name = process.argv[2];
  const out = await scenarios[name]();
  console.log(`RESULT ${JSON.stringify(out)}`);
  process.exit(0);
}

console.log(`AGENTHUB_ROOT=${ROOT}`);
let defects = 0;
let baseExpected = null;
for (const name of ['count', 'relevance', 'chars', 'baseExpected', 'base']) {
  console.log(`\n[${name}]`);
  const p = spawnSync(process.execPath, [SELF, name], { encoding: 'utf8', env: process.env, timeout: 120_000 });
  process.stdout.write(p.stdout);
  if (p.stderr) process.stdout.write(p.stderr.split('\n').map((l) => `  stderr: ${l}`).join('\n') + '\n');
  const line = p.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) {
    console.log(`  child exited ${p.status} signal ${p.signal} without a result   <-- DEFECT (crash)`);
    defects++;
    continue;
  }
  const res = JSON.parse(line.slice(7));
  if (name === 'baseExpected') {
    baseExpected = res.result;
    console.log(`  clean-process answer: ${baseExpected}`);
  } else if (name === 'base') {
    const wrong = res.result !== baseExpected;
    if (res.brokenCached || wrong) {
      console.log(`  -> DEFECT: ${res.brokenCached ? 'a Doc whose tree is deleted (address 0) is still cached' : ''}${wrong ? '; the diff on it differs from the clean answer (read of freed tree memory)' : '; the diff happened to match the clean answer this run (freed memory not reused)'}`);
      defects++;
    }
  } else if (res > 0) defects++;
}

console.log(`\n${defects ? `DEFECT PRESENT (${defects} scenario(s) failed)` : 'no defect'}`);
process.exit(defects ? 1 : 0);
