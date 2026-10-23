#!/usr/bin/env node
// Reproduction for review finding R-35: the lander's git isolation
// (packages/gitops/src/run.ts ISOLATION_ENV / ISOLATION_CONFIG) sets
// GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1, but git's global
// attributes file (core.attributesFile's default: $XDG_CONFIG_HOME/git/attributes,
// else $HOME/.config/git/attributes) and the system one (/etc/gitattributes,
// disabled only by GIT_ATTR_NOSYSTEM) are still read. `--attr-source=<T0>`
// replaces only the in-tree .gitattributes. So `merge=union` from the lander
// user's home silently resolves conflicts trunk's attributes would send back
// (design §2.2.2 "No global or system config is ever read", I4, §2.2.6).
//
// Part A: gitops.mergeTrees on an isolated bare mirror, exactly as the
//         pipeline calls it (attrSource = T0), with merge=union in
//           A1 $XDG_CONFIG_HOME/git/attributes
//           A2 $HOME/.config/git/attributes (no XDG_CONFIG_HOME)
//           A3 /etc/gitattributes (in a private mount namespace with /etc
//              overlaid, so the real /etc is never touched; skipped when
//              unshare/overlayfs is not available)
//         and A4 `git check-attr` through the isolated Git (eol,
//         working-tree-encoding for check checkouts).
// Part B: end to end, the real Lander from packages/lander/dist against an
//         in-process hub on port 0 and a local bare remote: two agents change
//         the same CHANGELOG.md line. Control (no home attributes): the second
//         landing fails {conflict}. With `CHANGELOG.md merge=union` in the
//         lander user's $XDG_CONFIG_HOME/git/attributes: it lands, union-merged.
//
// Exit 0: no defect (every case conflicts as trunk's attributes say).
// Exit 1: defect present. Exit 2: the setup itself is broken (controls failed).
// No network, no API key, no resolver (the AI stage is off: resolver null).
//
// Usage: AGENTHUB_ROOT=/home/user/agenthub node repro.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const SELF = fileURLToPath(import.meta.url);
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const gitops = await imp('packages/gitops/dist/index.js');

// ---------------------------------------------------------------- child mode (A3, inside the namespace)
if (process.argv[2] === '--child-system') {
  const [, , , mirror, B, T, O] = process.argv;
  const g = gitops.open(mirror, { isolated: true, bare: true });
  const r = await gitops.mergeTrees(g, T, O, { base: B, attrSource: T });
  const attr = await g.run([`--attr-source=${T}`, 'check-attr', 'merge', '--', 'CHANGELOG.md']);
  process.stdout.write(JSON.stringify({ clean: r.clean, conflicts: r.conflicts.map((c) => c.path), checkAttr: attr.stdout.trim(), etc: readFileSync('/etc/gitattributes', 'utf8').trim() }));
  process.exit(0);
}

const results = [];
let defect = false;
let broken = false;
const log = (...a) => console.log(...a);

const T0 = realpathSync(mkdtempSync(path.join(tmpdir(), 'r35-')));
const SETUP_HOME = path.join(T0, 'setup-home');
mkdirSync(SETUP_HOME);
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
let tick = 0;

/** git for the script's own setup: fully isolated from every config and attributes file. */
function sh(cwd, args, extra = {}, input) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_') && k !== 'XDG_CONFIG_HOME') env[k] = v;
  const t = `${BASE_TIME + 60 * ++tick} +0000`;
  Object.assign(env, {
    HOME: SETUP_HOME,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Setup Human',
    GIT_AUTHOR_EMAIL: 'setup@example.com',
    GIT_COMMITTER_NAME: 'Setup Human',
    GIT_COMMITTER_EMAIL: 'setup@example.com',
    GIT_AUTHOR_DATE: t,
    GIT_COMMITTER_DATE: t,
    ...extra,
  });
  const r = spawnSync('git', ['-c', 'core.attributesFile=/dev/null', ...args], { cwd, env, encoding: 'utf8', input });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function write(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    const p = path.join(dir, f);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, c);
  }
}

function commit(dir, msg, files) {
  write(dir, files);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', msg]);
  return sh(dir, ['rev-parse', 'HEAD']).trim();
}

/** The lander process's view of the user's home: a fresh empty HOME, optionally an XDG dir. */
function landerHome(name, { xdg = null, homeAttrs = null } = {}) {
  const home = path.join(T0, `${name}-home`);
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  if (xdg !== null) {
    const x = path.join(T0, `${name}-xdg`);
    mkdirSync(path.join(x, 'git'), { recursive: true });
    writeFileSync(path.join(x, 'git', 'attributes'), xdg);
    process.env.XDG_CONFIG_HOME = x;
  }
  if (homeAttrs !== null) {
    mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
    writeFileSync(path.join(home, '.config', 'git', 'attributes'), homeAttrs);
  }
  return home;
}

const CHANGELOG0 = '# Changelog\n\n- entry 0\n';
const CHANGELOG_TRUNK = '# Changelog\n\n- trunk entry\n';
const CHANGELOG_INCOMING = '# Changelog\n\n- incoming entry\n';
const UNION = 'CHANGELOG.md merge=union\n';

try {
  // ============================================================ Part A: gitops.mergeTrees, isolated
  log('== Part A: gitops.mergeTrees on an isolated bare mirror (attrSource = trunk) ==');
  const work = path.join(T0, 'a-work');
  mkdirSync(work);
  sh(work, ['init', '-q', '-b', 'main']);
  const B = commit(work, 'base', { 'CHANGELOG.md': CHANGELOG0, 'README.md': '# demo\n' });
  const T = commit(work, 'trunk', { 'CHANGELOG.md': CHANGELOG_TRUNK });
  sh(work, ['checkout', '-q', '-b', 'incoming', B]);
  const O = commit(work, 'incoming', { 'CHANGELOG.md': CHANGELOG_INCOMING });
  const mirror = path.join(T0, 'a-mirror.git');
  sh(T0, ['clone', '-q', '--bare', work, mirror]);
  // Trunk (and the incoming side) carry no .gitattributes at all: trunk's attributes say nothing about merge.
  const trunkAttrs = spawnSync('git', ['--git-dir', mirror, 'cat-file', '-e', `${T}:.gitattributes`]).status;
  log(`trunk T=${T.slice(0, 12)} has .gitattributes: ${trunkAttrs === 0}`);

  const merge = async () => {
    const g = gitops.open(mirror, { isolated: true, bare: true });
    const r = await gitops.mergeTrees(g, T, O, { base: B, attrSource: T });
    let merged = null;
    if (r.clean) merged = (await g.run(['show', `${r.tree}:CHANGELOG.md`])).stdout;
    return { clean: r.clean, conflicts: r.conflicts.map((c) => `${c.path}:${c.kind}`), merged };
  };

  // A0 control
  landerHome('a0');
  const a0 = await merge();
  log(`A0 control (no home attributes): clean=${a0.clean} conflicts=${JSON.stringify(a0.conflicts)}`);
  if (a0.clean || !a0.conflicts.includes('CHANGELOG.md:content')) {
    broken = true;
    log('   SETUP BROKEN: the control merge should conflict on CHANGELOG.md');
  }

  // A1 $XDG_CONFIG_HOME/git/attributes
  landerHome('a1', { xdg: UNION });
  const a1 = await merge();
  log(`A1 ${process.env.XDG_CONFIG_HOME}/git/attributes = ${JSON.stringify(UNION)}: clean=${a1.clean} conflicts=${JSON.stringify(a1.conflicts)}`);
  if (a1.clean) log(`   merged CHANGELOG.md (union of both sides): ${JSON.stringify(a1.merged)}`);
  results.push({ case: 'A1 xdg attributes', defect: a1.clean });

  // A2 $HOME/.config/git/attributes, XDG_CONFIG_HOME unset
  const h2 = landerHome('a2', { homeAttrs: UNION });
  const a2 = await merge();
  log(`A2 ${h2}/.config/git/attributes (XDG_CONFIG_HOME unset): clean=${a2.clean} conflicts=${JSON.stringify(a2.conflicts)}`);
  results.push({ case: 'A2 $HOME/.config attributes', defect: a2.clean });

  // A3 /etc/gitattributes, in a private mount namespace (the real /etc is never written)
  landerHome('a3');
  const ns = path.join(T0, 'ns');
  mkdirSync(ns);
  const script = [
    'set -e',
    `mount -t tmpfs r35 '${ns}'`,
    `mkdir '${ns}/u' '${ns}/w'`,
    `mount -t overlay overlay -o 'lowerdir=/etc,upperdir=${ns}/u,workdir=${ns}/w' /etc`,
    `printf '* merge=union\\n' > /etc/gitattributes`,
    `exec '${process.execPath}' '${SELF}' --child-system '${mirror}' ${B} ${T} ${O}`,
  ].join('\n');
  const probe = spawnSync('unshare', ['-m', '--propagation', 'private', 'sh', '-c', script], { encoding: 'utf8', env: process.env });
  if (probe.status === 0 && probe.stdout.trim().startsWith('{')) {
    const a3 = JSON.parse(probe.stdout);
    log(`A3 /etc/gitattributes = "* merge=union" (namespaced): clean=${a3.clean} conflicts=${JSON.stringify(a3.conflicts)}; isolated check-attr: ${a3.checkAttr}`);
    results.push({ case: 'A3 /etc/gitattributes', defect: a3.clean });
  } else {
    log(`A3 skipped (no private mount namespace here: ${(probe.stderr || probe.error?.message || '').trim().split('\n')[0]}); GIT_ATTR_NOSYSTEM is not in ISOLATION_ENV, so /etc/gitattributes is read`);
  }
  if (existsSync('/etc/gitattributes')) log('   note: the real /etc/gitattributes exists on this machine');

  // A4 check-attr through the isolated Git: eol / working-tree-encoding for check checkouts come from home too
  landerHome('a4', { xdg: 'CHANGELOG.md merge=union eol=crlf working-tree-encoding=UTF-16\n' });
  {
    const g = gitops.open(mirror, { isolated: true, bare: true });
    const r = await g.run([`--attr-source=${T}`, 'check-attr', 'merge', 'eol', 'working-tree-encoding', '--', 'CHANGELOG.md']);
    const set = r.stdout.trim().split('\n').filter((l) => !/: unspecified$/.test(l));
    log(`A4 isolated \`git --attr-source=T check-attr\` sees, from $XDG_CONFIG_HOME only:\n   ${set.join('\n   ') || '(nothing)'}`);
    results.push({ case: 'A4 check-attr from home', defect: set.length > 0 });
  }

  // ============================================================ Part B: the real lander, end to end
  log('\n== Part B: real Lander (dist) + in-process hub on port 0 + local bare remote ==');
  const { Hub, SqliteStore, startServer } = await imp('packages/hub/dist/index.js');
  const { ChecksRunner } = await imp('packages/lander/dist/checks.js');
  const { landerId } = await imp('packages/lander/dist/config.js');
  const { openGitPort } = await imp('packages/lander/dist/git-port.js');
  const { HubClient } = await imp('packages/lander/dist/hub-client.js');
  const { initWorkdir } = await imp('packages/lander/dist/init.js');
  const { Lander } = await imp('packages/lander/dist/lander.js');
  const P = 'acme/web';
  // The check fails on any conflict marker in a tracked file (a union merge leaves none).
  const CHECK_MJS = [
    "import { execFileSync } from 'node:child_process';",
    "import { readFileSync } from 'node:fs';",
    "const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\\0').filter(Boolean);",
    "const bad = files.filter((f) => /^(<{7}|={7}|>{7})/m.test(readFileSync(f, 'utf8')));",
    "if (bad.length) { console.log('conflict markers in ' + bad.join(', ')); process.exit(1); }",
    "console.log('ok');",
    '',
  ].join('\n');

  async function e2e(name, homeOpts) {
    const dir = path.join(T0, `b-${name}`);
    mkdirSync(dir);
    landerHome(`b-${name}`, homeOpts);
    const remote = path.join(dir, 'remote.git');
    sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
    sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
    const seed = path.join(dir, 'seed');
    mkdirSync(seed);
    sh(seed, ['init', '-q', '-b', 'main']);
    const agenthubJson = `${JSON.stringify({ project: P, land: { check: 'node check.mjs' } }, null, 2)}\n`;
    const seedTip = commit(seed, 'seed', { 'README.md': '# demo\n', 'CHANGELOG.md': CHANGELOG0, 'check.mjs': CHECK_MJS, 'agenthub.json': agenthubJson });
    sh(seed, ['remote', 'add', 'origin', remote]);
    sh(seed, ['push', '-q', 'origin', 'main']);

    const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
    const front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });
    const workdir = path.join(dir, 'lander');
    const lines = [];
    try {
      await initWorkdir({ dir: workdir, remote, log: (l) => lines.push(l) });
      const mirrorDir = path.join(workdir, 'mirror.git');
      const agent = landerId('lander/test');
      const git = openGitPort({ mirror: mirrorDir, remote: 'origin', env: { PATH: process.env.PATH } });
      const lander = new Lander({
        hub: new HubClient({ url: front.url, project: P, agent, landerToken: null }),
        git,
        checks: new ChecksRunner({ workdir, mirror: mirrorDir, env: { ...process.env }, killGraceMs: 2_000 }),
        resolver: null,
        log: (l) => lines.push(l),
        agent,
        project: P,
        committer: { name: 'agenthub lander', email: 'lander@localhost' },
        drivers: [],
        trunk: 'main',
        leaseTtlMs: 10_000,
        timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
        workdir,
        host: 'repro',
      });
      const clone = (who) => {
        const c = path.join(dir, `clone-${who}`);
        sh(dir, ['clone', '-q', remote, c]);
        return c;
      };
      const land = (c, agentId, summary) => {
        const H = sh(c, ['rev-parse', 'HEAD']).trim();
        sh(c, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
        sh(c, ['fetch', '-q', 'origin', 'main']);
        const files = sh(c, ['diff', '--name-only', `origin/main...${H}`]).split('\n').filter(Boolean);
        return hub.land(P, agentId, { queue: true, commit: H, files, summary }).landing;
      };
      const a = clone('maya');
      const b = clone('sam');
      commit(a, 'a: changelog', { 'CHANGELOG.md': CHANGELOG_TRUNK });
      commit(b, 'b: changelog', { 'CHANGELOG.md': CHANGELOG_INCOMING });
      const La = land(a, 'maya/claude-1', 'trunk entry');
      await lander.run({ once: true });
      const la = hub.getLanding(P, La.id);
      const Lb = land(b, 'sam/claude-1', 'incoming entry');
      await lander.run({ once: true });
      const lb = hub.getLanding(P, Lb.id);
      const trunkLog = sh(remote, ['log', '--format=%h %s', `${seedTip}..main`]).trim();
      const trunkChangelog = sh(remote, ['show', 'main:CHANGELOG.md']);
      return { la, lb, trunkLog, trunkChangelog, lines };
    } finally {
      await front.close();
      await new Promise((r) => setTimeout(r, 50));
      hub.store.close?.();
    }
  }

  const ctl = await e2e('control', {});
  log(`B0 control (no home attributes): first=${ctl.la.status}, second=${ctl.lb.status}${ctl.lb.failure ? ` {${ctl.lb.failure.code}}` : ''}`);
  if (ctl.la.status !== 'landed' || ctl.lb.status !== 'failed' || ctl.lb.failure?.code !== 'conflict') {
    broken = true;
    log('   SETUP BROKEN: expected the first to land and the second to fail {conflict}');
    log(`   lander log tail:\n     ${ctl.lines.slice(-15).join('\n     ')}`);
  }

  const bad = await e2e('xdg-union', { xdg: UNION });
  log(`B1 lander user's $XDG_CONFIG_HOME/git/attributes = ${JSON.stringify(UNION)}: first=${bad.la.status}, second=${bad.lb.status}${bad.lb.failure ? ` {${bad.lb.failure.code}}` : ''}, resolved_by=${bad.lb.report?.resolved_by ?? '-'}`);
  log(`   trunk now:\n     ${bad.trunkLog.split('\n').join('\n     ')}`);
  log(`   trunk CHANGELOG.md: ${JSON.stringify(bad.trunkChangelog)}`);
  results.push({ case: 'B1 lander e2e (xdg union)', defect: bad.lb.status === 'landed' });
} catch (err) {
  broken = true;
  console.error('ERROR', err?.stack ?? err);
} finally {
  rmSync(T0, { recursive: true, force: true });
}

log('\n== Summary ==');
for (const r of results) log(`${r.defect ? 'DEFECT' : 'ok    '}  ${r.case}`);
defect = results.some((r) => r.defect);
if (broken) {
  log('setup broken: exit 2');
  process.exit(2);
}
if (defect) {
  log('R-35 REPRODUCED: merge attributes reached the lander from the user\'s home / system attributes files, not only from trunk');
  process.exit(1);
}
log('R-35 not reproduced: every merge followed trunk\'s attributes only');
process.exit(0);
