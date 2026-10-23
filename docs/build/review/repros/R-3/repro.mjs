// Repro for R-3: a landing whose landed signature changes don't fit in the
// hub's 1 MB request body limit stays in `pushing` forever after its trunk push.
//
// landedSymbolChanges (packages/lander/src/symbols.ts) caps the list at 1000
// changes but never its bytes; every change carries before/after signatures of
// up to 500 characters each. The advance{to: landed} the lander sends after
// P10's trunk push (pipeline.ts landed()) and the resolve{outcome: landed} of
// every in-doubt resolution (recovery.ts) then exceed MAX_BODY_BYTES
// (packages/hub/src/server.ts, 1_000_000). The hub refuses the body with 413
// too_large, which hubWrite treats as a plain (non-retryable) refusal: steps()
// returns in_doubt, next hands the landing back with resolve: true, and
// resolveInDoubt recomputes exactly the same oversized list. The running slot
// is never freed, so nothing else lands while this lander runs.
//
// World: a local bare remote, an in-process hub served by its real
// startServer on 127.0.0.1:0, and the real lander (Lander + HubClient +
// GitPort + ChecksRunner) from the built packages, run continuously in-process.
// No network, no API key, no AI resolver (resolver: null).
//
// Exit codes: 1 = defect present; 0 = the landing reached a terminal state
// (defect fixed); 2 = the scenario couldn't be set up (not a verdict).
//
// Run:
//   AGENTHUB_ROOT=/home/user/agenthub node \
//     /tmp/claude-0/-home-user-agenthub/8b8b52f8-98ca-5efe-ba8a-d267c5f2c650/scratchpad/work-p23/review/repro-R-3/repro.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.AGENTHUB_ROOT ?? '/home/user/agenthub';
const dist = (pkg, file) => path.join(ROOT, 'packages', pkg, 'dist', file);
const { Hub, SqliteStore, startServer } = await import(dist('hub', 'index.js'));
const { Lander } = await import(dist('lander', 'lander.js'));
const { HubClient } = await import(dist('lander', 'hub-client.js'));
const { openGitPort } = await import(dist('lander', 'git-port.js'));
const { ChecksRunner } = await import(dist('lander', 'checks.js'));
const { initWorkdir } = await import(dist('lander', 'init.js'));
const { landerId } = await import(dist('lander', 'config.js'));

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const N_FUNCS = Number(process.env.R3_FUNCS ?? 1000); // = LANDED_MAX_SYMBOLS = MAX_SYMBOL_CHANGES (R3_FUNCS=400: a control run whose body fits)
const N_PARAMS = 42; // normalized signatures of ~510 chars, reported cut to 500
/** How long the lander is watched at most; the verdict comes as soon as ROUNDS landed reports were refused (or both landings finished). */
const OBSERVE_MS = Number(process.env.R3_OBSERVE_MS ?? 90_000);
const ROUNDS = 4;

const tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'repro-R3-')));
const KEEP = process.env.R3_KEEP === '1';
let tick = 0;
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_')) env[k] = v;
  const t = `${1767225600 + 60 * ++tick} +0000`;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', GIT_AUTHOR_NAME: 'Maya Agent', GIT_AUTHOR_EMAIL: 'maya@example.com', GIT_COMMITTER_NAME: 'Maya Agent', GIT_COMMITTER_EMAIL: 'maya@example.com', GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
}
function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commitFiles(dir, message, files) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const START = Date.now();
const TERMINAL = ['landed', 'failed', 'cancelled', 'superseded'];
async function waitFor(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

// --- the source: 1000 exported functions, each with a long parameter list
const fn = (i, firstType) =>
  `export function f${String(i).padStart(4, '0')}(${Array.from({ length: N_PARAMS }, (_, k) => `p${k}: ${k === 0 ? firstType : 'Alpha'}`).join(', ')}): Alpha {\n  return p0 as unknown as Alpha;\n}\n`;
const HEAD = 'export type Alpha = string;\nexport type Beta = number;\n\n';
const API_BEFORE = HEAD + Array.from({ length: N_FUNCS }, (_, i) => fn(i, 'Alpha')).join('\n');
const API_AFTER = HEAD + Array.from({ length: N_FUNCS }, (_, i) => fn(i, 'Beta')).join('\n'); // every signature changes

let hub, front, lander, bg;
const logs = [];
const calls = []; // every advance/resolve the lander sent: {id, kind, bytes, changes, error}
let verdict = 2;
try {
  // --- remote, seeded trunk
  const remote = path.join(tmpDir, 'remote.git');
  sh(tmpDir, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(remote, 'config', 'receive.denyNonFastForwards', 'true');
  const seed = path.join(tmpDir, 'seed');
  mkdirSync(seed);
  sh(seed, 'init', '-q', '-b', 'main');
  commitFiles(seed, 'seed', {
    'agenthub.json': `${JSON.stringify({ project: P, land: { check: 'node check.mjs' } }, null, 2)}\n`,
    'check.mjs': "console.log('ok');\n",
    'README.md': '# demo\n',
    'src/api.ts': API_BEFORE,
    'src/other.ts': 'export const other = 1;\n',
  });
  sh(seed, 'remote', 'add', 'origin', remote);
  sh(seed, 'push', '-q', 'origin', 'main');
  const T0 = sh(remote, 'rev-parse', 'main');

  // --- hub (real HTTP server, loopback, port 0)
  hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });

  // --- lander (real HubClient over HTTP, real git port and checks runner)
  const workdir = path.join(tmpDir, 'lander');
  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const agent = landerId('lander/repro');
  const client = new HubClient({ url: front.url, project: P, agent });
  const record = (kind) => async (id, req) => {
    const entry = { id, kind, what: kind === 'advance' ? req.to : req.outcome, bytes: Buffer.byteLength(JSON.stringify(req)), changes: req.symbol_changes?.length ?? 0, error: null };
    calls.push(entry);
    try {
      return await client[kind](id, req);
    } catch (err) {
      entry.error = `${err.code ?? err.name}${err.status ? ` ${err.status}` : ''}: ${err.message}`;
      throw err;
    }
  };
  const hubPort = new Proxy(client, {
    get(t, p) {
      if (p === 'advance' || p === 'resolve') return record(p);
      if (p === 'next' && process.env.R3_DEBUG) {
        return async (req) => {
          const r = await client.next(req);
          console.log(`  [next +${Date.now() - START}ms] landing=${r.landing?.id ?? null} resolve=${r.resolve ?? false}`);
          return r;
        };
      }
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('HUB_') || k.startsWith('ANTHROPIC_')) delete env[k];
  lander = new Lander({
    hub: hubPort,
    git: openGitPort({ mirror, remote: 'origin', env: { PATH: process.env.PATH ?? '' } }),
    checks: new ChecksRunner({ workdir, mirror, env, killGraceMs: 2_000 }),
    resolver: null,
    log: (line) => {
      logs.push(line);
      if (process.env.R3_DEBUG) console.log(`  [lander +${Date.now() - START}ms] ${line.split('\n')[0].slice(0, 200)}`);
    },
    agent,
    project: P,
    committer: LANDER,
    drivers: [],
    trunk: 'main',
    leaseTtlMs: 10_000,
    timings: { pollTrunkMs: 200, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 2_000 },
    workdir,
    host: 'repro',
  });

  // --- maya changes every signature in src/api.ts and lands it
  const maya = path.join(tmpDir, 'maya');
  sh(tmpDir, 'clone', '-q', remote, maya);
  const H = commitFiles(maya, 'retype the first parameter of every API function', { 'src/api.ts': API_AFTER });
  sh(maya, 'push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`);
  const L1 = hub.land(P, 'maya/claude-1', { queue: true, commit: H, files: ['src/api.ts'], summary: 'retype the API' }).landing;

  // --- the lander runs continuously, as `hub-lander run` does
  bg = lander.run();
  const pushed = await waitFor(() => sh(remote, 'rev-parse', 'main') !== T0, 120_000);
  const C = sh(remote, 'rev-parse', 'main');
  if (!pushed || sh(remote, 'show', `${C}:src/api.ts`) !== API_AFTER.trim()) {
    console.log('SETUP: the landing never reached trunk; lander log tail:\n' + logs.slice(-20).join('\n'));
    throw new Error('setup');
  }
  console.log(`trunk moved ${T0.slice(0, 12)} -> ${C.slice(0, 12)} (maya's change is on trunk); ${L1.id} hub state: ${JSON.stringify(pick(hub.getLanding(P, L1.id)))}`);

  // --- sam lands a one-line change to another file, queued behind it
  const sam = path.join(tmpDir, 'sam');
  sh(tmpDir, 'clone', '-q', remote, sam);
  const H2 = commitFiles(sam, 'bump other', { 'src/other.ts': 'export const other = 2;\n' });
  sh(sam, 'push', '-q', 'origin', `${H2}:refs/agenthub/land/${H2}`);
  const L2 = hub.land(P, 'sam/claude-1', { queue: true, commit: H2, files: ['src/other.ts'], summary: 'bump other' }).landing;

  // --- watch: does L1 reach a terminal state and L2 land, or are landed reports refused round after round?
  const t0 = Date.now();
  const refusedRounds = () => calls.filter((c) => c.id === L1.id && c.what === 'landed' && c.error && /too_large/.test(c.error)).length;
  await waitFor(() => (TERMINAL.includes(hub.getLanding(P, L1.id).status) && hub.getLanding(P, L2.id).status === 'landed') || refusedRounds() >= ROUNDS, OBSERVE_MS);
  const elapsed = Date.now() - t0;

  // the author tries to cancel it
  let cancel;
  try {
    cancel = `ok: ${hub.cancelLanding(P, 'maya/claude-1', L1.id, {}).landing.status}`;
  } catch (err) {
    cancel = `${err.code} (${err.status})`;
  }

  const l1 = hub.getLanding(P, L1.id);
  const l2 = hub.getLanding(P, L2.id);
  const landedCalls = calls.filter((c) => c.id === L1.id && c.what === 'landed');
  const refused = landedCalls.filter((c) => c.error && /too_large/.test(c.error));

  console.log('\nlanded reports the lander sent for', L1.id + ':');
  for (const c of landedCalls) console.log(`  ${c.kind}{${c.what}}  ${c.changes} symbol_changes  ${c.bytes} bytes  -> ${c.error ?? 'ok'}`);
  console.log(`\nafter ${elapsed} ms of the lander running:`);
  console.log(`  ${L1.id} (on trunk as ${C.slice(0, 12)}): ${JSON.stringify(pick(l1))}`);
  console.log(`  ${L2.id} (queued behind it):          ${JSON.stringify(pick(l2))}`);
  console.log(`  cancel ${L1.id} by its author: ${cancel}`);
  console.log('  lander log (last lines):');
  for (const l of logs.filter((x) => x.includes(L1.id)).slice(-4)) console.log(`    ${l.slice(0, 220)}`);

  const stuck = l1.status === 'running' && l1.phase === 'pushing';
  if (stuck && refused.length >= ROUNDS && refused.length === landedCalls.length && l2.status !== 'landed') {
    console.log(
      `\nDEFECT PRESENT: ${L1.id} is on trunk but stays running/pushing; all ${landedCalls.length} landed reports ` +
        `(${Math.min(...refused.map((c) => c.bytes))}+ bytes) were refused 413 too_large, and ${L2.id} can't land behind it.`,
    );
    verdict = 1;
  } else if (TERMINAL.includes(l1.status) && l2.status === 'landed') {
    console.log(`\nOK: ${L1.id} reached ${l1.status} and ${L2.id} landed: the defect is not present.`);
    verdict = 0;
  } else {
    console.log('\nINCONCLUSIVE: neither the defect pattern nor a clean finish (see above).');
    verdict = stuck ? 1 : 2;
  }

  // --- extra (not part of the verdict): does a restart of the lander recover it?
  lander.stop();
  await bg;
  bg = null;
  if (verdict === 1) try {
    const before = calls.length;
    const restarted = new Lander({ ...lander.ctx, hub: hubPort, git: lander.ctx.git, checks: lander.ctx.checks, resolver: null, log: (line) => logs.push(line), agent: landerId('lander/repro'), project: P, committer: LANDER, drivers: [], trunk: 'main', leaseTtlMs: 10_000, timings: lander.ctx.timings, workdir, host: 'repro' });
    await restarted.run({ once: true });
    const r1 = hub.getLanding(P, L1.id);
    const newCalls = calls.slice(before).filter((c) => c.id === L1.id && c.what === 'landed');
    console.log(
      `\n[info] after restarting the lander (new lease -> startup resolveInDoubt, then the startup trunk report): ${L1.id} is ${r1.status}` +
        `${r1.reconciled ? ' (reconciled from the trunk report, T16, with no symbol changes recorded)' : ''}; resolve{landed} on restart: ${newCalls.map((c) => c.error ?? 'ok').join(', ') || 'none'}`,
    );
  } catch (err) {
    console.log(`[info] restart check failed: ${err.message}`);
  }
} catch (err) {
  if (err.message !== 'setup') console.error(err);
  verdict = 2;
} finally {
  if (bg) {
    lander.stop();
    await bg.catch(() => undefined);
  }
  await front?.close().catch(() => undefined);
  await sleep(50);
  hub?.store?.close?.();
  if (!KEEP) rmSync(tmpDir, { recursive: true, force: true });
  else console.log(`kept ${tmpDir}`);
}
process.exit(verdict);

function pick(l) {
  return { status: l.status, phase: l.phase, in_doubt: l.in_doubt, trunk_sha: l.trunk_sha?.slice(0, 12) ?? null, failure: l.failure?.code ?? null };
}
