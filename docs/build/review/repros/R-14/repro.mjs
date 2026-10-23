#!/usr/bin/env node
// R-14 reproduction: a merge conflict in many files (or in a few files with
// many hunks) makes a fix-it report the hub refuses (over 512 KiB of JSON:
// 400 bad_request; over 1 MB of body: 413 too_large). The lander's
// `advance {failed, conflict}` throws, the generic catch in Attempt.run turns
// it into `failed {lander_error}` with no conflicts and a brief that tells the
// agent the change did not cause it and to land again. The re-landings hit the
// same wall, and step() counts each lander_error toward MAX_LANDER_ERRORS, so
// the third in a row pauses the whole project with config_invalid
// "lander workdir unusable".
//
// Everything is local: a bare remote (non-fast-forwards denied, an update hook
// that lets only the lander's committer move main), agent clones, an
// in-process hub served over HTTP on 127.0.0.1:0, and a real lander
// (HubClient, GitPort, ChecksRunner) run in-process. The AI resolver is off
// (resolver: null). No network, no API key.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// Exit 1: the defect is present. Exit 0: it is not (every conflict came back
// as `conflict` with its files, and no pause). Exit 2: the harness broke (the
// small control conflict did not come back as `conflict`).

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.env.AGENTHUB_ROOT || '/home/user/agenthub');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, 'packages', rel)).href);

for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') || k.startsWith('HUB_') || k.startsWith('ANTHROPIC_')) delete process.env[k];
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' });

const { Hub, SqliteStore, startServer } = await imp('hub/dist/index.js');
const { Lander } = await imp('lander/dist/lander.js');
const { ChecksRunner } = await imp('lander/dist/checks.js');
const { landerId } = await imp('lander/dist/config.js');
const { detectDrivers } = await imp('lander/dist/drivers.js');
const { openGitPort } = await imp('lander/dist/git-port.js');
const { HubClient: LanderHubClient } = await imp('lander/dist/hub-client.js');
const { initWorkdir } = await imp('lander/dist/init.js');

const P = 'acme/web';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;

let tick = 0;
function gitEnv(who = 'maya') {
  const t = `${BASE_TIME + 60 * ++tick} +0000`;
  const name = `${who} agent`;
  const email = `${who}@example.com`;
  return { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: t, GIT_COMMITTER_DATE: t };
}
function sh(cwd, args, who) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(who), encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const HOOK = `#!/bin/sh
ref="$1"; new="$3"
case "$ref" in
  refs/heads/main)
    case "$new" in 0000000000000000000000000000000000000000) echo "trunk can't be deleted" >&2; exit 1;; esac
    who=$(git log -1 --format='%cn <%ce>' "$new")
    if [ "$who" != "${LANDER.name} <${LANDER.email}>" ]; then echo "only the lander may update main (committer: $who)" >&2; exit 1; fi;;
esac
exit 0
`;

function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
}

/** A fresh world: remote seeded with `seedFiles`, a hub on 127.0.0.1:0, a lander holding the lease, two agent clones. */
async function world(name, seedFiles) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `r14-${name}-`)));
  const remote = path.join(dir, 'remote.git');
  const workdir = path.join(dir, 'lander');
  const landerLogs = [];
  const advances = [];
  sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  sh(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  const seed = path.join(dir, 'seed');
  sh(dir, ['init', '-q', '-b', 'main', seed]);
  writeFiles(seed, {
    'agenthub.json': `${JSON.stringify({ project: P, land: { check: 'node check.mjs' } }, null, 2)}\n`,
    'check.mjs': "console.log('checks ok');\n",
    ...seedFiles,
  });
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-q', '-m', 'seed']);
  sh(seed, ['remote', 'add', 'origin', remote]);
  sh(seed, ['push', '-q', 'origin', 'main']);
  writeFileSync(path.join(remote, 'hooks', 'update'), HOOK);
  chmodSync(path.join(remote, 'hooks', 'update'), 0o755);

  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  const front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });

  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const agent = landerId('lander/r14');
  const PATH = process.env.PATH ?? '';
  const client = new LanderHubClient({ url: front.url, project: P, agent, landerToken: null });
  // Watch every advance the lander sends: what it tried to write, and what the hub said.
  const advance = client.advance.bind(client);
  client.advance = async (id, req) => {
    const rec = { id, to: req.to, code: req.code ?? null, reportChars: req.report ? JSON.stringify(req.report).length : 0, conflicts: req.report?.conflicts?.length ?? 0, refused: null };
    advances.push(rec);
    try {
      return await advance(id, req);
    } catch (err) {
      rec.refused = `${err.status ?? '?'} ${err.code ?? ''}: ${err.message}`;
      throw err;
    }
  };
  const lander = new Lander({
    hub: client,
    git: openGitPort({ mirror, remote: 'origin', env: { PATH } }),
    checks: new ChecksRunner({ workdir, mirror, env: { ...process.env }, killGraceMs: 2_000 }),
    resolver: null,
    log: (l) => landerLogs.push(l),
    agent,
    project: P,
    committer: LANDER,
    drivers: await detectDrivers({ PATH }),
    trunk: 'main',
    leaseTtlMs: 10_000,
    timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
    workdir,
    host: 'r14',
  });
  if (!(await lander.ensureLease())) throw new Error('the lander did not get the lease');

  const clone = (who) => {
    const c = path.join(dir, who);
    sh(dir, ['clone', '-q', remote, c], who);
    return c;
  };
  const agents = { maya: { id: 'maya/claude-1', dir: clone('maya') }, sam: { id: 'sam/claude-1', dir: clone('sam') } };

  return {
    dir,
    hub,
    lander,
    advances,
    landerLogs,
    agents,
    task(who, title) {
      const t = hub.createTask(P, agents[who].id, { title });
      hub.takeTask(P, agents[who].id, t.id);
      return t.id;
    },
    commit(who, files, msg) {
      writeFiles(agents[who].dir, files);
      sh(agents[who].dir, ['add', '-A'], who);
      sh(agents[who].dir, ['commit', '-q', '-m', msg], who);
      return sh(agents[who].dir, ['rev-parse', 'HEAD'], who).trim();
    },
    /** What `hub_land` does: push the land ref, then POST /land. */
    land(who, o) {
      const H = sh(agents[who].dir, ['rev-parse', 'HEAD'], who).trim();
      sh(agents[who].dir, ['push', '-q', '-f', 'origin', `${H}:refs/agenthub/land/${H}`], who);
      return hub.land(P, agents[who].id, { queue: true, commit: H, files: o.files, task_id: o.task_id, summary: o.summary }).landing;
    },
    /** One admission round and one attempt. */
    async once() {
      await lander.admitRound();
      return lander.step();
    },
    landing: (id) => hub.getLanding(P, id),
    control: () => hub.landerStatus(P).control,
    inbox: (who) => hub.inbox(P, agents[who].id, { peek: true, limit: 50 }),
    trunk: () => sh(remote, ['rev-parse', 'main']).trim(),
    async close() {
      try {
        await lander.lease.release();
      } catch {}
      await front.close().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
      try {
        hub.store?.close?.();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const lineOf = (tag, i, pad) => `export const v${i} = '${tag}-${'x'.repeat(pad)}';\n`;

/** Whole-file rewrites: N files of `lines` lines; one conflict hunk per file. */
function wideFiles(n, lines, tag) {
  const out = {};
  for (let f = 0; f < n; f++) out[`src/m${f}.ts`] = Array.from({ length: lines }, (_, i) => lineOf(tag, i, 60)).join('');
  return out;
}

/** N files, each with 10 separate conflicting regions of 60 lines (each side over 4 KiB, so capped). */
function deepFiles(n, tag) {
  const out = {};
  for (let f = 0; f < n; f++) {
    let t = '';
    for (let k = 0; k < 10; k++) {
      for (let s = 0; s < 6; s++) t += `// section ${k} separator line ${s}: unchanged on every side\n`;
      for (let i = 0; i < 60; i++) t += `export const r${k}_${i} = '${tag}-${'y'.repeat(50)}';\n`;
    }
    t += '// end of file\n';
    out[`src/d${f}.ts`] = t;
  }
  return out;
}

const brief = (l) => ({
  status: l.status,
  code: l.failure?.code ?? null,
  summary: l.failure?.summary ?? null,
  conflicts: l.report?.conflicts?.length ?? null,
  conflictFiles: (l.report?.conflicts ?? []).map((c) => c.file).slice(0, 3),
  message: l.report?.message ?? null,
  next_steps: l.report?.next_steps ?? [],
  warnings: l.report?.warnings ?? [],
  retry_of: l.retry_of,
});

/**
 * maya lands a rewrite of the files; sam's rewrite of the same files from the
 * same base conflicts in all of them. With `relands`, sam lands the same
 * commit again that many times ("land again; this kind of retry keeps your
 * place"), and an unrelated landing by maya is queued afterwards.
 */
async function runCase(name, mk, o = {}) {
  const res = { name, steps: [], landings: [] };
  const log = (s) => res.steps.push(s);
  let w = null;
  try {
    const seed = mk('base');
    const files = Object.keys(seed);
    w = await world(name, seed);
    const ta = w.task('maya', `maya rewrites ${files.length} modules`);
    w.commit('maya', mk('maya'), 'maya: rewrite');
    const La = w.land('maya', { files, task_id: ta, summary: 'maya rewrites the modules' });
    await w.once();
    const la = w.landing(La.id);
    res.maya = la.status;
    log(`${La.id} (maya, ${files.length} files): ${la.status}`);
    if (la.status !== 'landed') throw new Error(`maya's landing did not land: ${JSON.stringify(brief(la))}\n${w.landerLogs.slice(-15).join('\n')}`);

    const tb = w.task('sam', `sam rewrites ${files.length} modules`);
    w.commit('sam', mk('sam'), 'sam: rewrite');
    for (let i = 0; i <= (o.relands ?? 0); i++) {
      const before = w.advances.length;
      const Lb = w.land('sam', { files, task_id: tb, summary: 'sam rewrites the modules' });
      const out = await w.once();
      const l = w.landing(Lb.id);
      const b = brief(l);
      const tried = w.advances.slice(before).filter((a) => a.to === 'failed');
      res.landings.push({ id: Lb.id, step: out.kind, ...b, tried });
      log(
        `${Lb.id} (sam${b.retry_of ? `, retry of ${b.retry_of}` : ''}): ${b.status} ${b.code}; conflicts in the stored report: ${b.conflicts}` +
          `${b.conflictFiles.length ? ` (${b.conflictFiles.join(', ')}${b.conflicts > 3 ? ', ...' : ''})` : ''}`,
      );
      for (const t of tried) log(`    lander sent advance {failed, ${t.code}}: report ${t.reportChars} chars of JSON, ${t.conflicts} conflict reports -> ${t.refused ? `REFUSED (${t.refused})` : 'accepted'}`);
      log(`    failure summary: ${JSON.stringify(b.summary)}`);
      log(`    report message: ${JSON.stringify(b.message)}`);
      log(`    next_steps: ${JSON.stringify(b.next_steps)}`);
      if (b.warnings.length) log(`    warnings: ${JSON.stringify(b.warnings)}`);
      const c = w.control();
      log(`    lander control after this attempt: ${c.paused ? `PAUSED (${c.paused.reason}: ${c.paused.detail})` : 'running'}`);
    }
    const msgs = (w.inbox('sam').messages ?? []).filter((m) => m.from?.startsWith?.('lander/'));
    if (msgs.length) log(`  sam's direct message from the lander: ${JSON.stringify(msgs[msgs.length - 1].body ?? msgs[msgs.length - 1].text ?? msgs[msgs.length - 1])}`);

    if (o.relands) {
      // An unrelated landing, by another agent, queued after the pause.
      const tc = w.task('maya', 'maya adds a README');
      w.commit('maya', { 'README.md': '# demo\n' }, 'maya: readme');
      const Lc = w.land('maya', { files: ['README.md'], task_id: tc, summary: 'readme' });
      const out = await w.once();
      const lc = w.landing(Lc.id);
      res.unrelated = { id: Lc.id, status: lc.status, step: out.kind };
      log(`${Lc.id} (maya, an unrelated README, conflicts with nothing): after the next pass ${lc.status} (step ${out.kind})`);
    }
    res.control = w.control();
  } catch (err) {
    res.error = err?.stack ?? String(err);
    res.landerLogs = w?.landerLogs.slice(-20) ?? [];
  } finally {
    await w?.close().catch(() => undefined);
  }
  return res;
}

console.log(`R-14 reproduction against ${ROOT}\n`);
const cases = [
  // Control: three files in conflict: the normal send-back.
  ['control-3-files', (tag) => wideFiles(3, 40, tag), {}],
  // The finding's scenario: 60 modules of about 3 KB, one hunk each; then two re-landings.
  ['wide-60-files', (tag) => wideFiles(60, 40, tag), { relands: 2 }],
  // A handful of files with many hunks: 5 files x 10 hunks x 3 sides of about 4 KiB.
  ['deep-5-files', (tag) => deepFiles(5, tag), {}],
  // 9 such files: the body is over the server's 1 MB limit (413).
  ['deep-9-files', (tag) => deepFiles(9, tag), {}],
];
const results = {};
for (const [name, mk, o] of cases) {
  const r = await runCase(name, mk, o);
  results[name] = r;
  console.log(`== ${name}`);
  for (const s of r.steps) console.log(`  ${s}`);
  if (r.error) console.log(`  HARNESS ERROR: ${r.error}\n  lander log tail:\n    ${(r.landerLogs ?? []).join('\n    ')}`);
  console.log('');
}

const ctl = results['control-3-files'];
const ctlOk = !ctl.error && ctl.landings[0]?.code === 'conflict' && ctl.landings[0]?.conflicts === 3 && !ctl.control?.paused;
console.log(`control (3 files): came back as conflict with 3 file reports, no pause: ${ctlOk ? 'yes' : 'NO'}`);

let defect = false;
for (const name of ['wide-60-files', 'deep-5-files', 'deep-9-files']) {
  const r = results[name];
  if (r.error) continue;
  const first = r.landings[0];
  const lost = first.code !== 'conflict' || first.conflicts === 0;
  defect ||= lost;
  console.log(`${name}: first send-back is ${first.code} with ${first.conflicts} conflict reports${first.tried[0]?.refused ? ` (the conflict report of ${first.tried[0].reportChars} chars was refused: ${first.tried[0].refused})` : ''}${lost ? ' -> DEFECT' : ''}`);
}
const wide = results['wide-60-files'];
if (!wide.error) {
  const allLanderError = wide.landings.length === 3 && wide.landings.every((l) => l.code === 'lander_error');
  const paused = wide.control?.paused?.reason === 'config_invalid';
  defect ||= paused;
  console.log(
    `wide-60-files: 3 consecutive landings of the same change came back lander_error: ${allLanderError}; ` +
      `project paused afterwards: ${paused ? `yes (${wide.control.paused.reason}: ${wide.control.paused.detail})` : 'no'}; ` +
      `an unrelated landing queued afterwards: ${wide.unrelated?.status}`,
  );
}

if (!ctlOk || Object.values(results).some((r) => r.error)) {
  console.log('\nHARNESS: the control case or a run did not behave as expected; see above.');
  if (!defect) process.exit(2);
}
if (defect) {
  console.log('\nDEFECT PRESENT: a conflict in many files (or many hunks) comes back as lander_error with no conflicts, telling the agent it is not its change; three re-landings pause the project for everyone.');
  process.exit(1);
}
console.log('\nno defect: every conflict came back as conflict with its file reports, and the project was not paused.');
process.exit(0);
