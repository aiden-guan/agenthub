// R-7 reproduction: one submitted landing whose admit request the hub refuses (400 invalid_path, 403 forbidden,
// 413 too_large) aborts the lander's whole admission round. Rounds walk the submitted landings in queue_seq order, so
// the same landing fails first every round and every landing submitted after it stays `submitted` for good.
//
// World per case (no network, no API key, no resolver needed): a local bare remote seeded with agenthub.json (land
// section on, symbols on by default); a real hub (Hub + SqliteStore ':memory:') served by @agenthub/hub's own
// startServer on 127.0.0.1:0; a real lander (Lander over its real HubClient, GitPort and ChecksRunner, mirror made by
// initWorkdir), all imported from ${AGENTHUB_ROOT}/packages/*/dist. Agents push their land ref and POST /land over HTTP
// as any client may (the `files` in POST /land are advisory, design §1.4 T1).
//
// Each case: landing A (maya) is the odd one, landing B (sam) is an ordinary one-file change submitted after it.
// The lander then runs three admission rounds (Lander.admitRound, what the admission loop runs on every
// landing.created event or every 15 s).
//
//   control      A changes an ordinary path                       -> harness check: both must end queued
//   tab          A adds `src/odd<TAB>name.ts` (git allows it)      -> hub: 400 invalid_path
//   drive        A adds `c:/notes.md`                              -> hub: 400 invalid_path ("is absolute")
//   bidi         A adds `src/<U+202E>gnp.ts`                       -> hub: 400 invalid_path
//   reserved     A's tree holds `.git/agenthub/x` (git mktree)     -> hub: 403 forbidden (needs a host without fsck)
//   codemod      A changes 1200 files x 10 functions (< maxFiles)  -> admit body > 1 MB -> 413 too_large
//                (the hub stops reading the oversize body, so the round after a 413 may instead die on the reset
//                kept-alive socket: "hub ... is unreachable (read ECONNRESET)"; it ends the round the same way)
//
// Exit 1 when the defect is present in any case: after three rounds B is still `submitted` (the queue behind A is
// wedged) or A is still `submitted` (nothing turned the refused admit into an outcome for that landing; design
// §2.2.4: each submitted landing ends queued or failed). Exit 0 when every case ends with A queued or failed and B
// queued. Exit 2 on a harness error (the control case doesn't admit both).
//
// Run: AGENTHUB_ROOT=/home/user/agenthub node repro.mjs        (AGENTHUB_ROOT defaults to /home/user/agenthub)
//      R7_CASES=tab,drive node repro.mjs                       (a subset; R7_KEEP=1 keeps the temp dirs)

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const dist = (pkg, file) => pathToFileURL(path.join(ROOT, 'packages', pkg, 'dist', file)).href;

// Isolate git (and the lander) from the developer's config; no Anthropic key reaches anything.
for (const k of Object.keys(process.env)) if (k.startsWith('HUB_') || k.startsWith('GIT_') || k.startsWith('ANTHROPIC_')) delete process.env[k];
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' });

const { Hub, SqliteStore, startServer } = await import(dist('hub', 'index.js'));
const { Lander } = await import(dist('lander', 'lander.js'));
const { HubClient } = await import(dist('lander', 'hub-client.js'));
const { openGitPort } = await import(dist('lander', 'git-port.js'));
const { ChecksRunner } = await import(dist('lander', 'checks.js'));
const { initWorkdir } = await import(dist('lander', 'init.js'));
const { landerId } = await import(dist('lander', 'config.js'));

const TMP = process.env.R7_TMP || path.join(path.dirname(fileURLToPath(import.meta.url)), 'runs');
mkdirSync(TMP, { recursive: true });

const P = 'demo';
const LANDER_IDENT = { name: 'agenthub lander', email: 'lander@localhost' };
const MAYA = 'maya/claude-1';
const SAM = 'sam/claude-1';
const ROUNDS = 3;

function git(cwd, args, o = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    input: o.input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_AUTHOR_NAME: o.who ?? 'Seed', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: o.who ?? 'Seed', GIT_COMMITTER_EMAIL: 'a@example.com' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}
function writeFiles(dir, files) {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c);
  }
}
function commitAll(dir, files, msg, who) {
  writeFiles(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg], { who });
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

// The codemod: 1200 TypeScript modules with 10 functions each on trunk; the change edits every function body.
const CODEMOD_FILES = 1200;
const codemodPath = (i) => `packages/web/src/generated/records/module-${String(i).padStart(4, '0')}.ts`;
const codemodSource = (v) =>
  Array.from({ length: 10 }, (_, j) => `export function transformRecord${String(j).padStart(2, '0')}(input: number): number {\n  return input + ${v};\n}\n`).join('\n');

const BASE_FILES = {
  'README.md': '# demo\n',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 1;\n',
};

async function makeWorld(name, { codemod = false } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(TMP, `r7-${name}-`)));
  const remote = path.join(dir, 'remote.git');
  git(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = path.join(dir, 'seed');
  git(dir, ['init', '-q', '-b', 'main', seed]);
  const files = { ...BASE_FILES, 'agenthub.json': `${JSON.stringify({ project: P, land: { check: 'true' } }, null, 2)}\n` };
  if (codemod) for (let i = 0; i < CODEMOD_FILES; i++) files[codemodPath(i)] = codemodSource(1);
  commitAll(seed, files, 'seed');
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-q', 'origin', 'main']);

  const hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  const front = await startServer({ hub, port: 0, host: '127.0.0.1' });
  const workdir = path.join(dir, 'lander');
  await initWorkdir({ dir: workdir, remote });
  const mirror = path.join(workdir, 'mirror.git');
  const logs = [];
  const admitBodies = [];
  const agent = landerId('lander/r7');
  const client = new HubClient({ url: front.url, project: P, agent, landerToken: null });
  // Only watches: records the size of each admit request body the lander sends (what readJson measures).
  const watched = new Proxy(client, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (k === 'admit') return (id, req) => (admitBodies.push({ id, bytes: Buffer.byteLength(JSON.stringify(req)) }), v.call(t, id, req));
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const lander = new Lander({
    hub: watched,
    git: openGitPort({ mirror, remote: 'origin' }),
    checks: new ChecksRunner({ workdir, mirror, env: { ...process.env }, killGraceMs: 2_000 }),
    resolver: null,
    log: (line) => logs.push(line),
    agent,
    project: P,
    committer: LANDER_IDENT,
    trunk: 'main',
    leaseTtlMs: 30_000,
    timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 2_000 },
    workdir,
    host: 'r7',
  });
  let n = 0;
  const clone = (who) => {
    const c = path.join(dir, `clone-${++n}`);
    git(dir, ['clone', '-q', remote, c]);
    return c;
  };
  /** POST /v1/p/demo/land over HTTP as `agent` (any client may; `files` are advisory). */
  const land = async (who, body) => {
    const res = await fetch(`${front.url}/v1/p/${encodeURIComponent(P)}/land`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-agent': who }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) return { status: res.status, error: data.error };
    return { status: res.status, landing: data.landing };
  };
  const close = async () => {
    await lander.lease.release().catch(() => undefined);
    await front.close();
    await new Promise((r) => setTimeout(r, 50));
    hub.store.close?.();
    if (!process.env.R7_KEEP) rmSync(dir, { recursive: true, force: true });
    else console.log(`  kept ${dir}`);
  };
  return { dir, remote, hub, front, lander, logs, admitBodies, clone, land, close };
}

/** A tree whose root holds `.git/agenthub/x` next to trunk's files (git add refuses it; git mktree doesn't). */
function reservedCommit(c) {
  const blob = git(c, ['hash-object', '-w', '--stdin'], { input: 'crafted\n' }).trim();
  const agenthub = git(c, ['mktree'], { input: `100644 blob ${blob}\tx\n` }).trim();
  const dotgit = git(c, ['mktree'], { input: `040000 tree ${agenthub}\tagenthub\n` }).trim();
  const head = git(c, ['ls-tree', 'HEAD']);
  const root = git(c, ['mktree'], { input: `${head}040000 tree ${dotgit}\t.git\n` }).trim();
  const H = git(c, ['commit-tree', root, '-p', 'HEAD', '-m', 'crafted reserved path'], { who: 'maya' }).trim();
  return H;
}

const CASES = {
  control: { odd: { 'src/plain-name.ts': 'export const plain = 1;\n' }, advisory: [] },
  tab: { odd: { 'src/odd\tname.ts': 'export const odd = 1;\n' }, advisory: [] },
  drive: { odd: { 'c:/notes.md': 'hello\n', 'src/a.ts': 'export const a = 2;\n' }, advisory: ['src/a.ts'] },
  bidi: { odd: { 'src/\u202Egnp.ts': 'export const rlo = 1;\n' }, advisory: [] },
  reserved: { crafted: true, advisory: [] },
  codemod: { codemod: true, advisory: [] },
};

async function runCase(name) {
  const spec = CASES[name];
  console.log(`\n=== ${name} ===`);
  const w = await makeWorld(name, { codemod: !!spec.codemod });
  try {
    // A: maya's odd landing.
    const a = w.clone();
    let H;
    if (spec.crafted) H = reservedCommit(a);
    else if (spec.codemod) {
      const files = {};
      for (let i = 0; i < CODEMOD_FILES; i++) files[codemodPath(i)] = codemodSource(2);
      H = commitAll(a, files, 'codemod: bump every transform', 'maya');
    } else H = commitAll(a, spec.odd, `maya: ${name}`, 'maya');
    git(a, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
    const changed = git(a, ['diff', '--name-only', '-z', `origin/main`, H]).split('\0').filter(Boolean);
    console.log(`A's commit changes ${changed.length} path(s)${changed.length <= 3 ? `: ${changed.map((p) => JSON.stringify(p)).join(', ')}` : ''}`);
    if (!spec.codemod && name !== 'control') {
      const full = await w.land(MAYA, { queue: true, commit: H, files: changed, summary: name });
      console.log(`POST /land listing every changed path: ${full.error ? `${full.status} ${full.error.code} (${full.error.message})` : full.landing.status}`);
    }
    const La = await w.land(MAYA, { queue: true, commit: H, files: spec.advisory, summary: name });
    if (!La.landing) throw new Error(`harness: T1 refused A: ${JSON.stringify(La)}`);
    console.log(`POST /land with advisory files ${JSON.stringify(spec.advisory)}: ${La.landing.id} ${La.landing.status} (queue_seq ${La.landing.queue_seq})`);

    // B: sam's ordinary landing, submitted after A.
    const b = w.clone();
    const Hb = commitAll(b, { 'src/b.ts': 'export const b = 2;\n' }, 'sam: b', 'sam');
    git(b, ['push', '-q', 'origin', `${Hb}:refs/agenthub/land/${Hb}`]);
    const Lb = await w.land(SAM, { queue: true, commit: Hb, files: ['src/b.ts'], summary: 'b' });
    if (!Lb.landing) throw new Error(`harness: T1 refused B: ${JSON.stringify(Lb)}`);
    console.log(`B: ${Lb.landing.id} ${Lb.landing.status} (queue_seq ${Lb.landing.queue_seq})`);

    if (!(await w.lander.ensureLease())) throw new Error('harness: the lander got no lease');
    for (let i = 1; i <= ROUNDS; i++) {
      const before = w.logs.length;
      const n = await w.lander.admitRound();
      const lines = w.logs.slice(before).filter((l) => /admi/.test(l));
      console.log(`round ${i}: admitRound -> ${n}; lander log: ${lines.length ? lines.map((l) => JSON.stringify(l.length > 220 ? `${l.slice(0, 220)}...` : l)).join(' | ') : '(nothing)'}`);
    }
    const sa = w.hub.getLanding(P, La.landing.id);
    const sb = w.hub.getLanding(P, Lb.landing.id);
    const aBodies = w.admitBodies.filter((x) => x.id === sa.id).map((x) => x.bytes);
    console.log(`admit bodies sent for A (bytes): ${aBodies.join(', ') || '(none)'}`);
    console.log(`after ${ROUNDS} rounds: A ${sa.id} ${sa.status}${sa.failure ? ` {${sa.failure.code}}` : ''}; B ${sb.id} ${sb.status}${sb.failure ? ` {${sb.failure.code}}` : ''}`);
    const wedged = sb.status === 'submitted';
    const stuck = sa.status === 'submitted';
    if (wedged) console.log(`DEFECT: B is still submitted: admission never reached it (A, queue_seq ${sa.queue_seq}, ends every round)`);
    if (stuck) console.log(`DEFECT: A is still submitted with no failure: the refused admit became no outcome for that landing`);
    return { name, wedged, stuck, a: sa.status, b: sb.status };
  } finally {
    await w.close();
  }
}

const wanted = (process.env.R7_CASES || Object.keys(CASES).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
if (!wanted.includes('control')) wanted.unshift('control');
const results = [];
try {
  for (const name of wanted) {
    if (!CASES[name]) throw new Error(`no case ${name}`);
    results.push(await runCase(name));
  }
} catch (err) {
  console.error(`harness error: ${err.stack ?? err}`);
  process.exit(2);
}
const control = results.find((r) => r.name === 'control');
if (control.a !== 'queued' || control.b !== 'queued') {
  console.error(`harness error: the control case didn't admit both landings (A ${control.a}, B ${control.b})`);
  process.exit(2);
}
console.log('\nsummary:');
for (const r of results) console.log(`  ${r.name.padEnd(9)} A ${r.a.padEnd(10)} B ${r.b.padEnd(10)} ${r.wedged || r.stuck ? 'DEFECT' : 'ok'}`);
const defect = results.some((r) => r.wedged || r.stuck);
console.log(defect ? '\nR-7 REPRODUCED: a landing whose admit the hub refuses ends every admission round, and the landings behind it stay submitted' : '\nR-7 not present');
process.exit(defect ? 1 : 0);
