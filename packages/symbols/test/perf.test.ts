// S4: performance (design §2.4 "Performance"), logged, not gating. For a
// generated 2000-line TypeScript file:
// - cold: a fresh process imports the built package and maps one edit, the
//   pre-edit hook's work (init, one grammar, two parses). Budget: p95 < 150 ms;
// - warm: changedSymbols in a process that has mapped before. Budget: < 20 ms.
//   It is measured on an editing session (each edit's `before` is the previous
//   `after`, as the long-running `hub mcp` process would see them), and, for
//   comparison, on edits of a file the process hasn't seen.
// Between two warm calls the test yields to the event loop, as a process that
// maps on request does (I/O in between); the document cache deletes evicted
// trees then. The numbers are printed; only the results are asserted. Set
// CI_SLOW to skip.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { changedSymbols, outline } from '../src/index.js';
import { PACKAGE_DIR } from './helpers.js';

const COLD_RUNS = 20;
const WARM_RUNS = 60;

/** A TypeScript file of about `lines` lines: imports, then functions, interfaces, classes, constants, aliases and enums in turn. */
function generateTs(lines = 2000): string {
  const out = ["import { readFile } from 'node:fs/promises';", "import type { Config } from './config';", "import * as path from 'node:path';", ''];
  for (let i = 0; out.length < lines; i++) {
    switch (i % 5) {
      case 0:
        out.push(
          `/** Computes value ${i}. */`,
          `export function fn${i}(a: number, b: string, opts?: { deep: boolean }): Promise<number> {`,
          `  const x = a * ${i};`,
          '  if (opts?.deep) {',
          '    return Promise.resolve(x + b.length);',
          '  }',
          '  return Promise.resolve(x);',
          '}',
          '',
        );
        break;
      case 1:
        out.push(`export interface Shape${i} {`, '  id: string;', '  size: number;', '  tags?: string[];', '}', '');
        break;
      case 2:
        out.push(
          `export class Service${i} {`,
          `  private ttl = ${i};`,
          '',
          '  constructor(private readonly cfg: Config) {}',
          '',
          '  async refresh(force: boolean): Promise<void> {',
          '    if (force) this.ttl = 0;',
          "    await readFile(path.join('a', 'b'));",
          '  }',
          '',
          '  close(): void {',
          '    this.ttl = -1;',
          '  }',
          '}',
          '',
        );
        break;
      case 3:
        out.push(`export const LIMIT_${i}: number = ${i};`, `const handler${i} = async (req: Request): Promise<Response> => {`, `  return new Response(String(req.url) + ${i});`, '};', '');
        break;
      default:
        out.push(`export type Pair${i}<T> = [T, T] | { left: T; right: T };`, `export enum Mode${i} {`, "  A = 'a',", "  B = 'b',", '}', '');
    }
  }
  return `${out.join('\n')}\n`;
}

/** A body edit of fn<k*5> (k counts from 0): `a * n` becomes `a * n + 1`, and back. */
function bodyEdit(src: string, k: number): string {
  const plain = `const x = a * ${k * 5};`;
  const edited = `const x = a * ${k * 5} + 1;`;
  if (src.includes(plain)) return src.replace(plain, edited);
  if (src.includes(edited)) return src.replace(edited, plain);
  throw new Error(`no fn${k * 5}`);
}

const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function median(xs: number[]): number {
  return percentile(xs, 50);
}

const ms = (x: number): string => `${x.toFixed(1)} ms`;
const verdict = (x: number, budget: number): string => (x < budget ? `within the ${budget} ms budget` : `OVER the ${budget} ms budget`);
/** Other test files run in parallel with this one under `npm test`: the load says how much they may have slowed it (run the file alone for clean numbers). */
const load = (): string => `load average ${loadavg()[0]!.toFixed(1)} on ${availableParallelism()} cores`;

const tmp = mkdtempSync(path.join(tmpdir(), 'agenthub-symbols-perf-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SOURCE = generateTs();

describe.skipIf(Boolean(process.env.CI_SLOW))('performance (logged, not gating)', () => {
  it('the generated file has 2000 lines, parses cleanly, and one body edit maps to one key', async () => {
    expect(SOURCE.split('\n').length).toBeGreaterThanOrEqual(2000);
    const o = await outline(SOURCE, 'typescript');
    expect(o.errors).toBe('none');
    expect(o.items.length).toBeGreaterThan(300);
    const d = await changedSymbols('src/big.ts', SOURCE, bodyEdit(SOURCE, 10));
    expect(d).toMatchObject({ fileLevel: false, symbols: ['fn50'], signatureChanges: [] });
  });

  it(`cold: a fresh process imports the package and maps one edit (p95 of ${COLD_RUNS} runs; budget 150 ms)`, () => {
    const file = path.join(tmp, 'big.ts');
    writeFileSync(file, SOURCE);
    const dist = pathToFileURL(path.join(PACKAGE_DIR, 'dist', 'index.js')).href;
    // Timed inside the process from the import on: what a pre-edit hook adds. Node's own start-up is not
    // counted, nor is loading node:crypto (for the grammar checksums): the hook's fetch to the hub loads it anyway.
    const script = `import { readFileSync } from 'node:fs';
await import('node:crypto');
const before = readFileSync(${JSON.stringify(file)}, 'utf8');
const after = before.replace('const x = a * 50;', 'const x = a * 50 + 1;');
const t0 = performance.now();
const m = await import(${JSON.stringify(dist)});
const t1 = performance.now();
const d = await m.changedSymbols('src/big.ts', before, after);
const t2 = performance.now();
console.log(JSON.stringify({ import: t1 - t0, map: t2 - t1, total: t2 - t0, symbols: d.symbols }));`;
    const runs: Array<{ import: number; map: number; total: number; symbols: string[] }> = [];
    for (let i = 0; i < COLD_RUNS; i++) {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      runs.push(JSON.parse(out) as (typeof runs)[number]);
    }
    for (const r of runs) expect(r.symbols).toEqual(['fn50']);
    const p95 = percentile(
      runs.map((r) => r.total),
      95,
    );
    console.log(
      `[symbols perf] cold changedSymbols, 2000-line TS file, ${COLD_RUNS} fresh processes: p95 ${ms(p95)} (${verdict(p95, 150)}); median ${ms(median(runs.map((r) => r.total)))} = import ${ms(median(runs.map((r) => r.import)))} + init, grammar and two parses ${ms(median(runs.map((r) => r.map)))} (${load()})`,
    );
  }, 120_000);

  it(`warm: changedSymbols in a process that has mapped before (median and p95 of ${WARM_RUNS}; budget 20 ms)`, async () => {
    // Warm up: the grammar, the JIT.
    for (let k = 0; k < 10; k++) await changedSymbols('src/warmup.ts', `${SOURCE}// ${k}\n`, bodyEdit(`${SOURCE}// ${k}\n`, k + 1));

    // An editing session: each edit starts from the text the previous one produced.
    const session: number[] = [];
    let text = SOURCE;
    for (let k = 0; k < WARM_RUNS; k++) {
      const next = bodyEdit(text, k % 45);
      await nextTask();
      const t0 = performance.now();
      const d = await changedSymbols('src/big.ts', text, next);
      session.push(performance.now() - t0);
      expect(d).toMatchObject({ fileLevel: false, symbols: [`fn${(k % 45) * 5}`] });
      text = next;
    }

    // Each edit of a version of the file the process hasn't seen.
    const unseen: number[] = [];
    for (let k = 0; k < WARM_RUNS / 2; k++) {
      const before = `${SOURCE}// unseen ${k}\n`;
      const after = bodyEdit(before, (k % 44) + 1);
      await nextTask();
      const t0 = performance.now();
      const d = await changedSymbols('src/big.ts', before, after);
      unseen.push(performance.now() - t0);
      expect(d).toMatchObject({ fileLevel: false, symbols: [`fn${((k % 44) + 1) * 5}`] });
    }

    console.log(
      `[symbols perf] warm changedSymbols, 2000-line TS file, editing session: median ${ms(median(session))} (${verdict(median(session), 20)}), p95 ${ms(percentile(session, 95))}; ` +
        `a version not seen before: median ${ms(median(unseen))}, p95 ${ms(percentile(unseen, 95))} (${load()})`,
    );
  }, 120_000);
});
