#!/usr/bin/env node
// Reproduction of review finding R-5: quadratic outline / signature work in
// @agenthub/symbols blocks the event loop on modest files, so the lander loses
// its lease while admitting a landing (and re-admits it, and stalls again),
// and the pre-edit hook's mapping runs past its 30 s timeout.
//
// Uses only the built packages under ${AGENTHUB_ROOT}/packages/*/dist (and the
// lander's committed bin shim). No network, no API key: a local bare remote,
// an in-process hub on 127.0.0.1 port 0, the real `hub-lander run` CLI as a
// child process.
//
// Exit 1 when the defect is present, 0 when it is not, 2 when the rig broke.
//
//   node repro-R-5.mjs
//   AGENTHUB_ROOT=/path/to/fixed/checkout node repro-R-5.mjs
//
// Knobs (all optional):
//   REPRO_LEASE_TTL_MS  the lander's --lease-ttl-ms (default: not passed, so the
//                       CLI default of 60000 ms applies). e.g. 10000 for a quicker run.
//   REPRO_CYCLES        stop part B after this many lease losses (default 2) or once
//                       the big landing is admitted, whichever comes first.
//   REPRO_SKIP_LANDER=1 / REPRO_SKIP_HOOK=1  skip part B / part C.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.env.AGENTHUB_ROOT ?? '/home/user/agenthub';
const dist = (pkg, file = 'index.js') => path.join(ROOT, 'packages', pkg, 'dist', file);
for (const f of [dist('symbols'), dist('hub'), dist('adapter', 'symbol-scope.js'), path.join(ROOT, 'packages/lander/dist/cli.js')]) {
  if (!existsSync(f)) {
    console.error(`missing build output ${f}: run npm run build in ${ROOT}`);
    process.exit(2);
  }
}
const S = await import(dist('symbols'));
const MAX_FILE_BYTES = S.MAX_FILE_BYTES ?? 1024 * 1024;

const LEASE_TTL_FLAG = process.env.REPRO_LEASE_TTL_MS ? Number(process.env.REPRO_LEASE_TTL_MS) : null;
const LEASE_TTL = LEASE_TTL_FLAG ?? 60_000; // the lander's default (packages/lander/src/config.ts)
const CYCLES = Math.max(1, Number(process.env.REPRO_CYCLES ?? 2));
const HOOK_TIMEOUT_MS = 30_000; // `hub init` writes { timeout: 30, onFailure: 'block' } for pre-edit

const ms = (t) => `${Math.round(t)} ms`;
const now = () => performance.now();
const findings = [];
let broken = false;

// --------------------------------------------------------------------------- part A: the four code paths

const fns = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');

/** TS: one line, `let x = 1;` followed by n comments (scanScope -> leadsNext per comment, each scanning all later comments). */
const tsSameLineComments = (n) => `let x = 1; ${'/**/ '.repeat(n)}\nfunction f() {}\n`;
const tsOwnLineComments = (n) => `let x = 1;\n${'/**/\n'.repeat(n)}\nfunction f() {}\n`;
const bodyEdit = (src) => src.replace('function f() {}', 'function f() { return 1; }');

const CASES = [
  {
    id: 'A1',
    what: 'same-line comments, changedSymbols with a one-line body edit (outline.ts scanScope/leadsNext)',
    sizes: [4000, 8000],
    run: (n) => S.changedSymbols('src/a.ts', tsSameLineComments(n), bodyEdit(tsSameLineComments(n))),
    control: (n) => S.changedSymbols('src/a.ts', tsOwnLineComments(n), bodyEdit(tsOwnLineComments(n))),
    controlWhat: 'the same comments one per line',
    bytes: (n) => tsSameLineComments(n).length,
    check: (r) => !r.fileLevel && r.symbols.join() === 'f',
  },
  {
    id: 'A2',
    what: 'Java enum with n constant bodies, outline (signatures.ts signatureText: one root walk per enumSignature range)',
    sizes: [1500, 3000],
    run: (n) => S.outline(`enum E {\n${fns(n, (i) => `  C${i} { },\n`)}  ;\n  void m() {}\n}\n`, 'java'),
    control: (n) => S.outline(`enum E {\n${fns(n, (i) => `  C${i},\n`)}  ;\n  void m() {}\n}\n`, 'java'),
    controlWhat: 'the same constants without bodies',
    bytes: (n) => `enum E {\n${fns(n, (i) => `  C${i} { },\n`)}  ;\n  void m() {}\n}\n`.length,
    check: (o) => o.errors === 'none',
  },
  {
    id: 'A3a',
    what: 'TS `export const a0: number = 0, a1 ...` (n declarators in one statement), outline (each signature walks the whole statement)',
    sizes: [1500, 3000],
    run: (n) => S.outline(`export const ${fns(n, (i) => `a${i}: number = ${i}${i < n - 1 ? ',\n  ' : ';\n'}`)}`, 'typescript'),
    control: (n) => S.outline(fns(n, (i) => `export const a${i}: number = ${i};\n`), 'typescript'),
    controlWhat: 'n separate statements',
    bytes: (n) => `export const ${fns(n, (i) => `a${i}: number = ${i}${i < n - 1 ? ',\n  ' : ';\n'}`)}`.length,
    check: (o) => o.items.length === 3000 || o.items.length === 1500,
  },
  {
    id: 'A3b',
    what: 'Go `const ( A0 int = 0 ... )` (n typed specs in one group), outline',
    sizes: [1500, 3000],
    run: (n) => S.outline(`package p\nconst (\n${fns(n, (i) => `\tA${i} int = ${i}\n`)})\n`, 'go'),
    control: (n) => S.outline(`package p\n${fns(n, (i) => `const A${i} int = ${i}\n`)}`, 'go'),
    controlWhat: 'n separate const declarations',
    bytes: (n) => `package p\nconst (\n${fns(n, (i) => `\tA${i} int = ${i}\n`)})\n`.length,
    check: (o) => o.errors === 'none',
  },
  {
    id: 'A3c',
    what: 'Java `int f0 = 0, f1 = 1, ...;` (n declarators in one field), outline',
    sizes: [1500, 3000],
    run: (n) => S.outline(`class K {\n  int ${fns(n, (i) => `f${i} = ${i}${i < n - 1 ? ',\n    ' : ';\n'}`)}}\n`, 'java'),
    control: (n) => S.outline(`class K {\n${fns(n, (i) => `  int f${i} = ${i};\n`)}}\n`, 'java'),
    controlWhat: 'n separate fields',
    bytes: (n) => `class K {\n  int ${fns(n, (i) => `f${i} = ${i}${i < n - 1 ? ',\n    ' : ';\n'}`)}}\n`.length,
    check: (o) => o.errors === 'none',
  },
  {
    id: 'A4',
    what: 'n functions each with a contained syntax error, outline (classifyErrors: errorKeys.includes per error)',
    sizes: [20000, 40000],
    run: (n) => S.outline(fns(n, (i) => `function f${i}(){ ) }\n`), 'typescript'),
    control: (n) => S.outline(fns(n, (i) => `function f${i}(){ ; }\n`), 'typescript'),
    controlWhat: 'the same functions without the errors',
    bytes: (n) => fns(n, (i) => `function f${i}(){ ) }\n`).length,
    check: (o) => o.errors === 'contained',
  },
];

async function timed(fn) {
  const t = now();
  const r = await fn();
  return { t: now() - t, r };
}

async function partA() {
  console.log('== part A: the four code paths, at n and 2n, against a linear control at 2n');
  // Load each grammar first, so the first case doesn't pay for it.
  await S.outline('let a = 1;', 'typescript');
  await S.outline('class A {}', 'java');
  await S.outline('package p\n', 'go');
  const calib = {};
  for (const c of CASES) {
    const [n1, n2] = c.sizes;
    const a = await timed(() => c.run(n1));
    const b = await timed(() => c.run(n2));
    const k = await timed(() => c.control(n2));
    if (!c.check(b.r)) {
      console.log(`  ${c.id}: unexpected result shape ${JSON.stringify(b.r).slice(0, 200)}`);
      broken = true;
    }
    const ratio = b.t / Math.max(a.t, 1);
    const vsControl = b.t / Math.max(k.t, 1);
    // Quadratic: doubling n roughly quadruples the time, and the time is far beyond the linear control's.
    const bad = ratio >= 2.8 && b.t >= 1000 && vsControl >= 3;
    console.log(
      `  ${c.id} ${bad ? 'QUADRATIC' : 'ok       '} n=${n1}: ${ms(a.t)}; n=${n2} (${(c.bytes(n2) / 1024).toFixed(0)} KiB): ${ms(b.t)}` +
        ` (x${ratio.toFixed(1)} for 2x n); control (${c.controlWhat}) ${ms(k.t)}\n      ${c.what}`,
    );
    if (bad) findings.push(`${c.id}: ${c.what}: n=${n1} ${ms(a.t)} -> n=${n2} ${ms(b.t)} (x${ratio.toFixed(1)}), control ${ms(k.t)}`);
    calib[c.id] = { n: n2, t: b.t };
  }
  return calib;
}

// --------------------------------------------------------------------------- shared: a quadratic fit to pick sizes

/** n for which A1's changedSymbols should take about `target` ms, if it scales as n^2; capped below the 1 MiB fallback. */
function sizeFor(calib, target) {
  const { n, t } = calib.A1;
  const cap = Math.floor((MAX_FILE_BYTES - 64) / 5);
  const want = Math.ceil(n * Math.sqrt(target / Math.max(t, 1)));
  return Math.min(Math.max(want, n), cap);
}

// --------------------------------------------------------------------------- git helpers

const GIT_ENV = (() => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_')) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Maya Agent',
    GIT_AUTHOR_EMAIL: 'maya@example.com',
    GIT_COMMITTER_NAME: 'Maya Agent',
    GIT_COMMITTER_EMAIL: 'maya@example.com',
  };
})();

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, files) {
  for (const [f, content] of Object.entries(files)) {
    const p = path.join(dir, f);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

const sleep = (t) => new Promise((r) => setTimeout(r, t));

// --------------------------------------------------------------------------- part B: the lander loses its lease

async function partB(calib) {
  const target = LEASE_TTL * 1.6;
  const n = sizeFor(calib, target);
  const BIG = tsSameLineComments(n);
  const bytes = Buffer.byteLength(BIG);
  console.log(`\n== part B: hub-lander run (lease ttl ${LEASE_TTL} ms${LEASE_TTL_FLAG ? ', --lease-ttl-ms' : ', the default'}) admits a one-line change to a ${(bytes / 1024).toFixed(0)} KiB file`);
  console.log(`   (src/big.ts: \`let x = 1; \` + n=${n} \`/**/ \` on one line; A1's fit predicts ~${ms(calib.A1.t * (n / calib.A1.n) ** 2)} of mapping)`);
  if (bytes >= MAX_FILE_BYTES) console.log('   (capped at the 1 MiB fallback: the fit predicts nothing near the ttl)');

  const { Hub, SqliteStore, startServer } = await import(dist('hub'));
  const P = 'acme/web';
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'repro-R-5-')));
  const remote = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  const workdir = path.join(tmp, 'lander');
  const home = path.join(tmp, 'home');
  mkdirSync(home);
  let child = null;
  let front = null;
  let hub = null;
  const lines = [];
  try {
    git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
    git(tmp, 'init', '-q', '-b', 'main', seed);
    write(seed, {
      'agenthub.json': `${JSON.stringify({ project: P, land: { check: 'node check.mjs' } }, null, 2)}\n`,
      // A landing that adds slow.flag has checks that take a few seconds (so it is running while another is admitted).
      'check.mjs': "import { existsSync } from 'node:fs';\nif (existsSync('slow.flag')) await new Promise((r) => setTimeout(r, 6000));\nprocess.exit(0);\n",
      'src/small.ts': 'export function g(): number {\n  return 1;\n}\n',
      'src/big.ts': BIG,
    });
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', 'origin', 'main');

    hub = new Hub({ store: new SqliteStore(':memory:') });
    const events = [];
    hub.subscribe((e) => events.push({ at: now(), e }));
    front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 200 });

    /** An agent's commit on top of trunk, pushed to its land ref and queued. */
    let clones = 0;
    const land = (agent, file, edit, summary, extra = {}) => {
      const dir = path.join(tmp, `clone-${++clones}`);
      git(tmp, 'clone', '-q', remote, dir);
      const before = git(dir, 'show', `HEAD:${file}`);
      write(dir, { [file]: edit(`${before}\n`), ...extra });
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', summary);
      const H = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`);
      return hub.land(P, agent, { queue: true, commit: H, files: [file, ...Object.keys(extra)], summary }).landing;
    };

    const bin = path.join(ROOT, 'packages/lander/bin/hub-lander.js');
    const env = { ...GIT_ENV, HOME: home };
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    delete env.GIT_COMMITTER_NAME;
    delete env.GIT_COMMITTER_EMAIL;
    const init = spawnSync(process.execPath, [bin, 'init', '--remote', remote, '--dir', workdir], { env, encoding: 'utf8' });
    if (init.status !== 0) throw new Error(`hub-lander init exited ${init.status}: ${init.stderr}`);
    const args = [bin, 'run', '--hub', front.url, '--project', P, '--dir', workdir, ...(LEASE_TTL_FLAG ? ['--lease-ttl-ms', String(LEASE_TTL_FLAG)] : [])];
    const t0 = now();
    child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (buf) => {
      for (const l of buf.toString().split('\n')) if (l.trim()) lines.push({ at: now(), l });
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const stamp = (at) => `t+${((at - t0) / 1000).toFixed(1)}s`;

    const waitFor = async (cond, what, limit) => {
      const end = now() + limit;
      while (now() < end) {
        if (cond()) return true;
        if (child.exitCode !== null) throw new Error(`hub-lander exited ${child.exitCode} while waiting for ${what}`);
        await sleep(100);
      }
      return cond();
    };
    const status = (id) => hub.getLanding(P, id).status;
    const isLease = (c) => c.holder.startsWith('lander/');
    const leases = () => hub.listClaims(P, { include_ended: true }).filter(isLease);

    // Control: a change to a small file is admitted and lands, so the rig and the lander work.
    const L1 = land('sam/claude-1', 'src/small.ts', (s) => s.replace('return 1;', 'return 2;'), 'small change');
    if (!(await waitFor(() => status(L1.id) === 'landed', 'the control landing', 60_000))) throw new Error(`control landing ${L1.id} is ${status(L1.id)}, not landed`);
    const lease1 = leases().find((c) => c.status === 'active');
    console.log(`  ${stamp(now())} control ${L1.id} (src/small.ts) landed; the lander holds lease ${lease1?.id}`);

    // A bystander: zed's landing with slow checks, running when the big one is submitted.
    const L3 = land('zed/claude-1', 'src/small.ts', (s) => s.replace('return 2;', 'return 3;'), 'zed: slow checks', { 'slow.flag': 'x\n' });
    if (!(await waitFor(() => status(L3.id) === 'running', 'the bystander to run', 30_000))) throw new Error(`bystander ${L3.id} is ${status(L3.id)}, not running`);
    console.log(`  ${stamp(now())} bystander ${L3.id} (zed, src/small.ts) is running its checks`);

    // The landing under test: maya's one-line body edit of f in src/big.ts.
    const L2 = land('maya/claude-1', 'src/big.ts', bodyEdit, 'f returns 1');
    const tSubmit = now();
    console.log(`  ${stamp(tSubmit)} submitted ${L2.id} (maya, src/big.ts, a one-line edit of f)`);

    const limit = Math.max(3 * target, LEASE_TTL * 3) + 60_000;
    let lost = 0;
    let lostWhileSubmitted = 0;
    let lastLease = lease1?.id;
    const seen = new Set();
    let admittedAt = null;
    const said = new Set();
    while (now() - tSubmit < limit && lost < CYCLES) {
      await sleep(200);
      if (child.exitCode !== null) throw new Error(`hub-lander exited ${child.exitCode}`);
      for (const { at, e } of events) {
        if (e.type === 'landing.updated' && e.data?.landing_id === L3.id && /requeued/.test(String(e.data?.reason)) && !said.has(e.seq)) {
          said.add(e.seq);
          console.log(`  ${stamp(at)} hub: bystander ${L3.id} ${e.data.reason} (retries now ${JSON.stringify(hub.getLanding(P, L3.id).retries)})`);
        }
        if (e.type !== 'claim.expired' || !String(e.data?.holder ?? '').startsWith('lander/') || seen.has(e.data.claim_id)) continue;
        seen.add(e.data.claim_id);
        lost += 1;
        if (admittedAt === null) lostWhileSubmitted += 1;
        console.log(`  ${stamp(at)} hub: lease ${e.data.claim_id} expired (${e.data.reason}), ${ms(at - tSubmit)} after ${L2.id} was submitted; ${L2.id} is ${status(L2.id)}`);
      }
      const active = leases().find((c) => c.status === 'active');
      if (active && active.id !== lastLease) {
        lastLease = active.id;
        console.log(`  ${stamp(now())} the lander holds a new lease ${active.id}; ${L2.id} is ${status(L2.id)}`);
      }
      if (status(L2.id) !== 'submitted' && admittedAt === null) {
        admittedAt = now();
        console.log(`  ${stamp(admittedAt)} ${L2.id} admitted (${status(L2.id)}) ${ms(admittedAt - tSubmit)} after it was submitted`);
        break;
      }
    }
    const final = status(L2.id);
    const by = hub.getLanding(P, L3.id);
    console.log(`  ${stamp(now())} done watching: ${lost} lease loss(es); ${L2.id} is ${final}; bystander ${L3.id} is ${by.status}, retries ${JSON.stringify(by.retries)}`);
    const tail = lines.filter((x) => x.at >= tSubmit && /lease|admi|L-\d|heartbeat|unreachable/i.test(x.l)).slice(0, 16);
    if (tail.length) console.log(`  lander log since ${L2.id} was submitted:\n${tail.map((x) => `    ${stamp(x.at)} ${x.l}`).join('\n')}`);
    if (lostWhileSubmitted > 0) {
      findings.push(
        `B: hub-lander (lease ttl ${LEASE_TTL} ms) lost its lease while admitting a one-line change to a ${(bytes / 1024).toFixed(0)} KiB TypeScript file` +
          ` (${admittedAt === null ? `still submitted after ${ms(now() - tSubmit)}` : `admitted only after ${ms(admittedAt - tSubmit)}`});` +
          ` bystander ${L3.id}: retries ${JSON.stringify(by.retries)}`,
      );
    } else if (admittedAt === null) {
      console.log(`  rig: neither a lease loss nor an admission of ${L2.id} within ${ms(limit)}`);
      broken = true;
    }
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await front?.close().catch(() => undefined);
    await sleep(50);
    hub?.store?.close?.();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------- part C: the pre-edit hook's mapping

async function partC(calib) {
  const n = sizeFor(calib, HOOK_TIMEOUT_MS * 1.5);
  const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'repro-R-5-hook-')));
  try {
    // A different file from part B's (distinct text: no cached document), with one more trailing declaration.
    const src = `${tsSameLineComments(n)}export function h(): number {\n  return 0;\n}\n`;
    const abs = path.join(tmp, 'src/c.ts');
    write(tmp, { 'src/c.ts': src });
    console.log(`\n== part C: the pre-edit hook's editScope (adapter) on an Edit of a ${(Buffer.byteLength(src) / 1024).toFixed(0)} KiB file (hook timeout ${HOOK_TIMEOUT_MS / 1000} s, onFailure: block)`);
    const { editScope } = await import(dist('adapter', 'symbol-scope.js'));
    const { t, r } = await timed(() =>
      editScope({
        tool: 'Edit',
        input: { file_path: abs, old_string: 'function f() {}', new_string: 'function f() { return 1; }' },
        abs,
        file: 'src/c.ts',
        config: { enabled: true, exclude: [], maxSymbolsPerEdit: 12 },
      }),
    );
    console.log(`  editScope took ${ms(t)} -> ${JSON.stringify({ symbols: r.symbols, reason: r.reason })}`);
    if (t > HOOK_TIMEOUT_MS) findings.push(`C: the pre-edit hook's editScope took ${ms(t)} (> the ${HOOK_TIMEOUT_MS / 1000} s hook timeout, onFailure: block, so the Edit is denied)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------- main

try {
  console.log(`AGENTHUB_ROOT=${ROOT}`);
  const calib = await partA();
  if (process.env.REPRO_SKIP_LANDER !== '1') await partB(calib);
  if (process.env.REPRO_SKIP_HOOK !== '1') await partC(calib);
} catch (err) {
  console.error(`rig error: ${err?.stack ?? err}`);
  broken = true;
}

console.log('');
if (findings.length > 0) {
  console.log(`DEFECT PRESENT (R-5):\n${findings.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
if (broken) {
  console.log('INCONCLUSIVE: the rig did not behave as expected (see above)');
  process.exit(2);
}
console.log('not reproduced: every case scales linearly, the lease survived and the hook stayed within its timeout');
process.exit(0);
