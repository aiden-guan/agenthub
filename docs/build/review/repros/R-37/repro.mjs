#!/usr/bin/env node
// R-37 reproduction: the lander's mirror.git is never garbage-collected.
//
// World: a local bare remote seeded with agenthub.json, an in-process hub
// served on 127.0.0.1:0 by @agenthub/hub's own startServer, `hub-lander init`
// (initWorkdir) making <workdir>/mirror.git, and the real Lander over its real
// HubClient, GitPort and ChecksRunner (all imported from
// ${AGENTHUB_ROOT}/packages/*/dist). No network, no API key, no AI resolver.
//
// Part A (mechanism, real lander): land several commits through `run --once`,
// one of them big enough (>100 objects) that its land-ref fetch is kept as a
// pack. Measure mirror.git's loose objects and packs after each attempt; then
// run the lander's GC (lease grant + Lander.gc) and show that the agents'
// source commits, whose land refs are gone, are unreachable yet still stored.
//
// Part B (months of operation, compressed): age every object 30 days (past the
// default 2-week prune grace), add unreachable loose objects and fetched-style
// packs until the mirror is past git's own auto-gc thresholds (gc.auto=6700
// loose objects, gc.autoPackLimit=50 packs), and run the lander's GC pass
// again. A lander that maintains its mirror (`git gc --auto` / `git
// maintenance run`) consolidates and prunes here; this one leaves it as is.
//
// Control: the same mirror state copied and given one plain `git gc --auto`
// (default prune grace) falls back under both thresholds, so the oracle flips
// under the proposed fix.
//
// Exit 1 when the defect is present (after the lander's GC pass the mirror is
// still over git's auto-gc thresholds with only old unreachable garbage), 0
// when it is not, 2 on a setup error.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.REPRO_KEEP === '1';

const GC_AUTO = 6700; // git's default gc.auto
const GC_AUTO_PACK_LIMIT = 50; // git's default gc.autoPackLimit
const P = 'acme/web';
const LANDER_ID = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

function gitEnv(extra = {}) {
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
    ...extra,
  };
}

function sh(cwd, args, o = {}) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(o.env), encoding: 'utf8', input: o.input, maxBuffer: 256 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !o.any) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

/** git count-objects -v of a bare repository, as numbers. */
function countObjects(gitDir) {
  const out = sh(gitDir, ['--git-dir', gitDir, 'count-objects', '-v']);
  const o = {};
  for (const line of out.split('\n')) {
    const m = /^([a-z-]+): (\d+)$/.exec(line.trim());
    if (m) o[m[1]] = Number(m[2]);
  }
  return { loose: o.count ?? 0, looseKiB: o.size ?? 0, packs: o.packs ?? 0, inPack: o['in-pack'] ?? 0, packKiB: o['size-pack'] ?? 0, garbage: o.garbage ?? 0 };
}

const fmt = (c) => `${c.loose} loose (${c.looseKiB} KiB), ${c.packs} packs (${c.inPack} objects, ${c.packKiB} KiB)`;

/** Every file under objects/ (loose objects and packs) gets an mtime `days` days ago. */
function ageObjects(gitDir, days) {
  const t = Date.now() / 1000 - days * 86400;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else utimesSync(p, t, t);
    }
  };
  walk(path.join(gitDir, 'objects'));
}

/** Waits for a detached `git gc --auto` (gc.pid) to finish, so a fix that backgrounds gc is measured fairly. */
async function waitForGc(gitDir, ms = 60_000) {
  const end = Date.now() + ms;
  while (existsSync(path.join(gitDir, 'gc.pid')) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
}

async function main() {
  const { Hub, SqliteStore, startServer } = await imp('packages/hub/dist/index.js');
  const { ChecksRunner } = await imp('packages/lander/dist/checks.js');
  const { landerId } = await imp('packages/lander/dist/config.js');
  const { detectDrivers } = await imp('packages/lander/dist/drivers.js');
  const { openGitPort } = await imp('packages/lander/dist/git-port.js');
  const { HubClient } = await imp('packages/lander/dist/hub-client.js');
  const { initWorkdir } = await imp('packages/lander/dist/init.js');
  const { Lander } = await imp('packages/lander/dist/lander.js');

  const base = path.join(HERE, 'work');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'r37-'));
  const remote = path.join(dir, 'remote.git');
  const seed = path.join(dir, 'seed');
  const workdir = path.join(dir, 'lander');
  const mirror = path.join(workdir, 'mirror.git');

  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  const front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
  const logs = [];
  let exit = 2;
  try {
    // ---- the remote, seeded
    sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
    mkdirSync(seed);
    sh(seed, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(seed, 'README.md'), '# demo\n');
    mkdirSync(path.join(seed, 'src'));
    writeFileSync(path.join(seed, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(seed, 'check.mjs'), "console.log('ok');\n");
    writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: P, land: { check: 'node check.mjs' } }, null, 2)}\n`);
    sh(seed, ['add', '-A']);
    sh(seed, ['commit', '-q', '-m', 'seed'], { env: { GIT_AUTHOR_DATE: `${BASE_TIME} +0000`, GIT_COMMITTER_DATE: `${BASE_TIME} +0000` } });
    sh(seed, ['remote', 'add', 'origin', remote]);
    sh(seed, ['push', '-q', 'origin', 'main']);

    // ---- the lander: init (mirror.git) and the real Lander over HTTP
    await initWorkdir({ dir: workdir, remote });
    const agent = landerId('lander/r37');
    const lander = new Lander({
      hub: new HubClient({ url: front.url, project: P, agent, landerToken: null }),
      git: openGitPort({ mirror, remote: 'origin', env: { PATH: process.env.PATH ?? '' } }),
      checks: new ChecksRunner({ workdir, mirror, env: { ...process.env }, killGraceMs: 2_000 }),
      resolver: null,
      log: (l) => logs.push(l),
      agent,
      project: P,
      committer: LANDER_ID,
      drivers: await detectDrivers({ PATH: process.env.PATH ?? '' }),
      trunk: 'main',
      leaseTtlMs: 10_000,
      timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
      workdir,
      host: 'repro',
    });
    const gcPass = async () => {
      // A lease grant runs startup recovery and GC (§2.2.7); then the hourly pass itself.
      await lander.ensureLease();
      try {
        await lander.gc();
      } finally {
        await lander.lease.release();
      }
      await waitForGc(mirror);
    };

    // ---- Part A: real attempts
    console.log(`AGENTHUB_ROOT=${ROOT}`);
    console.log(`git ${sh(dir, ['--version']).trim().replace(/^git version /, '')}`);
    const c0 = countObjects(mirror);
    console.log(`\nPart A: real landings through the lander`);
    console.log(`  mirror after init:            ${fmt(c0)}`);

    const agentDir = path.join(dir, 'agent');
    sh(dir, ['clone', '-q', remote, agentDir]);
    const sources = [];
    const N = 6;
    let prev = c0;
    for (let i = 1; i <= N; i++) {
      sh(agentDir, ['fetch', '-q', 'origin', 'main']);
      sh(agentDir, ['checkout', '-q', '-B', `w${i}`, 'origin/main']);
      const files = [];
      // Landing 3 is a big one: >100 new objects, so its land-ref fetch is kept as a pack (fetch.unpackLimit=100).
      const nFiles = i === 3 ? 150 : 3;
      for (let k = 0; k < nFiles; k++) {
        const f = path.join('src', `l${i}`, `f${k}.ts`);
        mkdirSync(path.join(agentDir, path.dirname(f)), { recursive: true });
        writeFileSync(path.join(agentDir, f), `export const v${i}_${k} = ${i * 1000 + k}; // ${'x'.repeat(40)}\n`);
        files.push(f);
      }
      sh(agentDir, ['add', '-A']);
      const t = `${BASE_TIME + 3600 * i} +0000`;
      sh(agentDir, ['commit', '-q', '-m', `landing ${i}`], { env: { GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t } });
      const H = sh(agentDir, ['rev-parse', 'HEAD']).trim();
      sources.push(H);
      sh(agentDir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
      const L = hub.land(P, 'maya/claude-1', { queue: true, commit: H, files, summary: `landing ${i}` }).landing;
      await lander.run({ once: true });
      const done = hub.getLanding(P, L.id);
      if (done.status !== 'landed') throw new Error(`setup: ${L.id} ended ${done.status} (${JSON.stringify(done.failure)}); lander log:\n${logs.join('\n')}`);
      const c = countObjects(mirror);
      console.log(`  after ${L.id} landed (${String(nFiles).padStart(3)} files): ${fmt(c)}   (+${c.loose - prev.loose} loose, +${c.packs - prev.packs} packs)`);
      prev = c;
    }

    await gcPass();
    const cA = countObjects(mirror);
    const refsLeft = sh(mirror, ['--git-dir', mirror, 'for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean);
    const unreachable = sh(mirror, ['--git-dir', mirror, 'fsck', '--unreachable', '--no-reflogs', '--no-progress'], { any: true })
      .split('\n')
      .filter((l) => l.startsWith('unreachable '));
    const stillStored = sources.filter((H) => spawnSync('git', ['--git-dir', mirror, 'cat-file', '-e', `${H}^{commit}`], { env: gitEnv() }).status === 0);
    const reachableSources = sources.filter((H) => sh(mirror, ['--git-dir', mirror, 'for-each-ref', '--contains', H, '--format=%(refname)'], { any: true }).trim() !== '');
    console.log(`  after the lander's GC pass:   ${fmt(cA)}`);
    console.log(`  mirror refs left: ${refsLeft.join(', ') || '(none)'}`);
    console.log(`  agents' source commits still stored: ${stillStored.length}/${sources.length}, reachable from any mirror ref: ${reachableSources.length}`);
    console.log(`  unreachable objects in the mirror after GC (git fsck --unreachable): ${unreachable.length}`);
    const gcLines = logs.filter((l) => /^gc/.test(l));
    if (gcLines.length) console.log(`  lander gc log: ${gcLines.join(' | ')}`);

    // ---- Part B: the same mirror after months
    console.log(`\nPart B: months of attempts and fetches, compressed (all garbage aged 30 days, past the 2-week prune grace)`);
    const filler = path.join(dir, 'filler.git');
    sh(dir, ['init', '-q', '--bare', filler]);
    // Unreachable loose objects, as merge-tree trees, spliced/structural blobs and candidate commits leave them.
    const LOOSE = 12_000;
    const blobsIn = path.join(dir, 'blobs');
    mkdirSync(blobsIn);
    const names = [];
    for (let i = 0; i < LOOSE; i++) {
      const f = path.join(blobsIn, `b${i}`);
      writeFileSync(f, `// attempt artefact ${i}\nexport const t${i} = ${i};\n`);
      names.push(f);
    }
    sh(mirror, ['--git-dir', mirror, 'hash-object', '-w', '--stdin-paths'], { input: `${names.join('\n')}\n` });
    // Packs, as larger land-ref fetches leave them: one small pack each, never consolidated.
    const PACKS = 60;
    for (let i = 0; i < PACKS; i++) {
      const ids = [];
      const list = [];
      for (let k = 0; k < 3; k++) {
        const f = path.join(blobsIn, `p${i}-${k}`);
        writeFileSync(f, `// fetched ${i}.${k}\n`);
        list.push(f);
      }
      ids.push(...sh(filler, ['--git-dir', filler, 'hash-object', '-w', '--stdin-paths'], { input: `${list.join('\n')}\n` }).split('\n').filter(Boolean));
      sh(filler, ['--git-dir', filler, 'pack-objects', '-q', path.join(mirror, 'objects', 'pack', 'pack')], { input: `${ids.join('\n')}\n` });
    }
    ageObjects(mirror, 30);
    const in17 = existsSync(path.join(mirror, 'objects', '17')) ? readdirSync(path.join(mirror, 'objects', '17')).length : 0;
    const cB0 = countObjects(mirror);
    console.log(`  mirror before the GC pass:    ${fmt(cB0)}   (objects/17 holds ${in17}; gc --auto fires above ${Math.ceil(GC_AUTO / 256)})`);
    if (cB0.loose <= GC_AUTO || cB0.packs <= GC_AUTO_PACK_LIMIT || in17 <= Math.ceil(GC_AUTO / 256)) throw new Error('setup: the mirror is not past the auto-gc thresholds');

    // Control: what one `git gc --auto` with git's defaults does to this very state.
    const control = path.join(dir, 'control.git');
    cpSync(mirror, control, { recursive: true, preserveTimestamps: true });
    sh(control, ['--git-dir', control, '-c', 'gc.autoDetach=false', 'gc', '--auto', '--quiet']);
    const cCtl = countObjects(control);

    await gcPass();
    const cB = countObjects(mirror);
    console.log(`  after the lander's GC pass:   ${fmt(cB)}`);
    console.log(`  control (git gc --auto, defaults, on a copy of the same state): ${fmt(cCtl)}`);

    const ranMaintenance = cB.loose < cB0.loose || cB.packs < cB0.packs;
    const overLoose = cB.loose > GC_AUTO;
    const overPacks = cB.packs > GC_AUTO_PACK_LIMIT;
    const fixable = cCtl.loose <= GC_AUTO && cCtl.packs <= GC_AUTO_PACK_LIMIT;
    console.log('');
    console.log(`  lander GC touched mirror objects: ${ranMaintenance}`);
    console.log(`  still over gc.auto (${GC_AUTO} loose): ${overLoose}; still over gc.autoPackLimit (${GC_AUTO_PACK_LIMIT} packs): ${overPacks}`);
    console.log(`  a default git gc --auto clears both: ${fixable}`);
    if (!fixable) throw new Error('setup: the control gc did not clear the state, so the oracle would not flip under a fix');

    const defect = (overLoose || overPacks) && stillStored.length === sources.length && reachableSources.length === 0;
    if (defect) {
      console.log(`\nDEFECT PRESENT (R-37): the lander's GC pass leaves mirror.git's objects alone. ${cB.loose} loose objects and ${cB.packs} packs remain, every one of them unreachable garbage older than git's prune grace; the agents' source commits of landings whose land refs are gone stay stored. Every lander git call runs with -c gc.auto=0 and nothing runs git gc / repack / maintenance.`);
      exit = 1;
    } else {
      console.log(`\nno defect: the lander's GC pass maintains the mirror (loose ${cB0.loose} -> ${cB.loose}, packs ${cB0.packs} -> ${cB.packs}).`);
      exit = 0;
    }
  } finally {
    await front.close().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    hub.store.close?.();
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
    else console.log(`(kept ${dir})`);
  }
  return exit;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`repro setup error: ${err?.stack ?? err}`);
    process.exit(2);
  },
);
