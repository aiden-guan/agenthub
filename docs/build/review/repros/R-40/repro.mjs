// Repro for R-40: blobs are decoded lossily as UTF-8 before symbol mapping, so
// a change between two different non-UTF-8 bytes is invisible to the mapper.
//
// The lander reads both sides with gitops.showBlob (git cat-file stdout,
// Buffer.concat(out).toString('utf8') in gitops/src/run.ts), the adapter's
// guard and land read them with Buffer.toString('utf8') (symbol-scope.ts
// mapChanges). Every invalid byte becomes U+FFFD, and changedSymbols' only
// binary test is a NUL in the first 8 KiB (symbols/src/diff.ts binary()). So in
// a Latin-1 Java file, 'café' (0xE9) -> 'cafè' (0xE8) inside hello() decodes to
// the same text on both sides. With another declaration (bye) also changed, the
// mapping is symbol-level and names only Greeting.bye.
//
// Scenario (design §4.2 #5, §1.10):
//   1. maya/claude-1 (A) holds an exclusive claim on Greeting.java#Greeting.hello.
//   2. sam/claude-1 (B, Bash, no edit hooks) changes hello (é -> è) and bye.
//   3. The pre-commit guard (adapter guard(), real, against the in-process hub)
//      maps the staged change; B lands (advisory scope from the adapter's
//      diffScope, as land.ts does); the real lander admits the landing with its
//      authoritative mapping (admissionScope) under claimGate: fail and lands it.
//   Correct: hello is in every scope, so the guard blocks, `land` is refused
//   with claim_conflict, and the lander fails admission with claim_conflict.
//   Defect: hello is in none of them; B's edit of hello lands over A's live claim.
//
// Control: the identical edit in a UTF-8 file (é/è are then valid multi-byte
// sequences and survive decoding). It must be gated at every step, or the rig
// is broken. In the control, after `land` is (correctly) refused, the landing
// is resubmitted with an understated advisory scope (bye only, as a hookless or
// stale adapter might send) so the lander's own gate is exercised too.
//
// Everything is local: a bare remote, an in-process hub (startServer on port 0,
// loopback, SQLite :memory:), a real lander run with run({once: true}). No
// resolver, no network, no API key.
//
// Run:
//   AGENTHUB_ROOT=/home/user/agenthub node \
//     /tmp/claude-0/-home-user-agenthub/8b8b52f8-98ca-5efe-ba8a-d267c5f2c650/scratchpad/work-p23/review/repro-R-40/repro.mjs
//
// Exit 0: no defect (the Latin-1 edit of hello is gated like the UTF-8 one).
// Exit 1: defect present. Exit 2: the UTF-8 control was not gated (rig broken).

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT ?? '/home/user/agenthub';
const dist = (pkg, file) => pathToFileURL(path.join(ROOT, 'packages', pkg, 'dist', file)).href;

const { Hub, SqliteStore, startServer } = await import(dist('hub', 'index.js'));
const { ChecksRunner } = await import(dist('lander', 'checks.js'));
const { landerId } = await import(dist('lander', 'config.js'));
const { detectDrivers } = await import(dist('lander', 'drivers.js'));
const { openGitPort } = await import(dist('lander', 'git-port.js'));
const { HubClient } = await import(dist('lander', 'hub-client.js'));
const { initWorkdir } = await import(dist('lander', 'init.js'));
const { Lander } = await import(dist('lander', 'lander.js'));
const { admissionScope, DEFAULT_SYMBOLS } = await import(dist('lander', 'symbols.js'));
const { changedSymbols, MAPPER_VERSION } = await import(dist('symbols', 'index.js'));
const { diffScope, stagedScope } = await import(dist('adapter', 'symbol-scope.js'));
const { guard } = await import(dist('adapter', 'guard.js'));

const P = 'acme/web';
const A = 'maya/claude-1';
const B = 'sam/claude-1';
const FILE = 'Greeting.java';
const HELLO = 'Greeting.hello';
const BYE = 'Greeting.bye';
const LANDER = { name: 'agenthub lander', email: 'lander@localhost' };
const BASE_TIME = Date.UTC(2026, 0, 1) / 1000;
const VERBOSE = process.env.VERBOSE === '1';
const SYMBOLS = { enabled: true, exclude: [], maxSymbolsPerEdit: 12 };

const BEFORE = 'class Greeting {\n  String hello() { return "café"; }\n  String bye() { return "bye"; }\n}\n';
const AFTER = 'class Greeting {\n  String hello() { return "cafè"; }\n  String bye() { return "ciao"; }\n}\n';

function testEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && !k.startsWith('HUB_') && !k.startsWith('ANTHROPIC_') && !k.startsWith('CLAUDE')) env[k] = v;
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Seed Human',
    GIT_AUTHOR_EMAIL: 'seed@example.com',
    GIT_COMMITTER_NAME: LANDER.name,
    GIT_COMMITTER_EMAIL: LANDER.email,
    GIT_AUTHOR_DATE: `${BASE_TIME} +0000`,
    GIT_COMMITTER_DATE: `${BASE_TIME} +0000`,
  });
  Object.assign(env, extra);
  return env;
}
// The adapter and the lander spawn git with process.env: keep it hermetic too.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_') || k.startsWith('HUB_') || k.startsWith('ANTHROPIC_')) delete process.env[k];
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });

function sh(cwd, args, extra = {}, input) {
  const r = spawnSync('git', args, { cwd, env: testEnv(extra), encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}
function shBuf(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: testEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

const CHECK_MJS = `import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\\0').filter(Boolean);
console.log('checked ' + files.length + ' files: ok');
`;

async function scenario(encoding) {
  const enc = (s) => Buffer.from(s, encoding);
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), `repro-R40-${encoding}-`)));
  const remote = path.join(dir, 'remote.git');
  const workdir = path.join(dir, 'lander');
  const logs = [];
  const out = { encoding };
  let front;
  let hub;
  try {
    sh(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
    const seed = path.join(dir, 'seed');
    mkdirSync(seed);
    sh(seed, ['init', '-q', '-b', 'main']);
    writeFileSync(path.join(seed, FILE), enc(BEFORE));
    writeFileSync(path.join(seed, 'check.mjs'), CHECK_MJS);
    writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: P, land: { check: 'node check.mjs' } }, null, 2)}\n`);
    sh(seed, ['add', '-A']);
    sh(seed, ['commit', '-q', '-m', 'seed']);
    sh(seed, ['remote', 'add', 'origin', remote]);
    sh(seed, ['push', '-q', 'origin', 'main']);
    const base = sh(seed, ['rev-parse', 'HEAD']).trim();

    hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
    front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });

    // 1. A holds Greeting.hello.
    const claim = hub.claim(P, A, { scope: [{ file: FILE, symbol: HELLO }], mapper: MAPPER_VERSION, intent: 'rework hello', ttl_ms: 3_600_000 });
    out.claimStatus = claim.status ?? claim.claim?.status;
    const claimId = claim.claim?.id ?? claim.id;

    // 2. B edits hello and bye with a shell tool (no edit hooks) and stages it.
    const bdir = path.join(dir, 'clone-sam');
    sh(dir, ['clone', '-q', remote, bdir]);
    writeFileSync(path.join(bdir, FILE), enc(AFTER));
    sh(bdir, ['add', FILE]);
    out.bytesOfHelloDiffer = !enc(BEFORE.split('\n')[1]).equals(enc(AFTER.split('\n')[1]));
    out.decodedHelloEqual = enc(BEFORE.split('\n')[1]).toString('utf8') === enc(AFTER.split('\n')[1]).toString('utf8');

    // The mapper itself, on the sides as the callers decode them.
    const d = await changedSymbols(FILE, enc(BEFORE).toString('utf8'), enc(AFTER).toString('utf8'), { maxSymbols: 40 });
    out.changedSymbols = d.fileLevel ? `file-level (${d.reason})` : d.symbols;

    // 3a. The pre-commit guard's scope, and the real guard against the hub.
    const staged = await stagedScope(bdir, { merging: [], symbols: SYMBOLS });
    out.guardScope = staged.scope.map((e) => (e.symbol ? `${e.file}#${e.symbol}` : e.file));
    const g = await guard({
      cwd: bdir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        HUB_CONFIG: path.join(dir, 'no-global-config.json'),
        HUB_URL: front.url,
        HUB_AGENT: B,
        HUB_PROJECT: P,
      },
    });
    out.guardExit = g.exitCode;
    out.guardStderr = g.stderr.trim();

    // B commits anyway (Bash agents can --no-verify; the lander must still catch it).
    sh(bdir, ['commit', '-q', '--no-verify', '-m', 'hello accent, bye in Italian'], { GIT_AUTHOR_NAME: 'sam agent', GIT_AUTHOR_EMAIL: 'sam@example.com' });
    const H = sh(bdir, ['rev-parse', 'HEAD']).trim();

    // 3b. land: the advisory scope, as land.ts computes it (diffScope), then queue.
    const adv = await diffScope(bdir, base, H, { symbols: SYMBOLS, wantMapper: true });
    const advScope = adv.scope.filter((e) => e.symbol !== undefined);
    out.landScope = adv.scope.map((e) => (e.symbol ? `${e.file}#${e.symbol}` : e.file));
    sh(bdir, ['push', '-q', 'origin', `${H}:refs/agenthub/land/${H}`]);
    const files = sh(bdir, ['diff', '--name-only', `${base}..${H}`]).split('\n').filter(Boolean);
    let landing = null;
    try {
      landing = hub.land(P, B, { queue: true, commit: H, files, ...(advScope.length ? { scope: advScope } : {}), mapper: adv.mapper }).landing;
      out.landRequest = 'accepted';
    } catch (err) {
      out.landRequest = `refused: ${err.code ?? ''} ${err.message.split('\n')[0]}`;
    }
    if (!landing) {
      // Control path: the advisory gate worked. Exercise the lander's authoritative gate with an understated
      // advisory scope (bye only), as a hookless or stale adapter would send.
      landing = hub.land(P, B, { queue: true, commit: H, files, scope: [{ file: FILE, symbol: BYE }], mapper: MAPPER_VERSION }).landing;
      out.resubmittedUnderstated = true;
    }

    // 3c. The lander's authoritative mapping, directly (what admission computes) ...
    await initWorkdir({ dir: workdir, remote });
    const mirror = path.join(workdir, 'mirror.git');
    const git = openGitPort({ mirror, remote: 'origin', env: { PATH: process.env.PATH ?? '' } });
    const lander = new Lander({
      hub: new HubClient({ url: front.url, project: P, agent: landerId('lander/test'), landerToken: null }),
      git,
      checks: new ChecksRunner({ workdir, mirror, env: { ...process.env }, killGraceMs: 2_000 }),
      resolver: null,
      log: (line) => {
        logs.push(line);
        if (VERBOSE) console.log(`    [lander] ${line}`);
      },
      agent: landerId('lander/test'),
      project: P,
      committer: LANDER,
      drivers: await detectDrivers({ PATH: process.env.PATH ?? '' }),
      trunk: 'main',
      leaseTtlMs: 10_000,
      timings: { pollTrunkMs: 100, remoteBackoffMs: 200, pushRetryMs: [50, 100], hubRetryMs: [50, 100, 200], stopResolveMs: 5_000 },
      workdir,
      host: 'test',
    });
    // ... and the real admission + landing.
    await lander.run({ once: true });
    const adm = await admissionScope(git, { files: [FILE], base, head: H, config: DEFAULT_SYMBOLS });
    out.admissionScope = adm.scope ? adm.scope.map((e) => (e.symbol ? `${e.file}#${e.symbol}` : e.file)) : `whole files (${FILE})`;

    const l = hub.getLanding(P, landing.id);
    out.landing = `${l.id}: ${l.status}${l.failure ? ` {${l.failure.code}}` : ''}`;
    out.landingStatus = l.status;
    out.landingFailure = l.failure?.code ?? null;
    out.landingHolds = l.scope ? l.scope.map((e) => (e.symbol ? `${e.file}#${e.symbol}` : e.file)) : l.files;
    out.claimAfter = hub.getClaim(P, claimId).status;

    // What trunk now holds in hello.
    sh(seed, ['fetch', '-q', 'origin', 'main']);
    const trunkBlob = shBuf(seed, ['show', `origin/main:${FILE}`]);
    out.trunkHasBsHello = trunkBlob.equals(enc(AFTER));
    out.adminLog = logs.filter((x) => /admitted|failed admission|landed/.test(x)).slice(0, 4);
  } finally {
    await front?.close();
    await new Promise((r) => setTimeout(r, 50));
    hub?.store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

function show(r) {
  console.log(`\n== ${r.encoding === 'latin1' ? 'Latin-1 (ISO-8859-1) Greeting.java' : 'control: UTF-8 Greeting.java'}`);
  console.log(`  A's claim on ${FILE}#${HELLO}: ${r.claimStatus}`);
  console.log(`  hello's bytes differ: ${r.bytesOfHelloDiffer}; hello's UTF-8-decoded text equal: ${r.decodedHelloEqual}`);
  console.log(`  changedSymbols(decoded sides): ${JSON.stringify(r.changedSymbols)}`);
  console.log(`  guard's staged scope: ${JSON.stringify(r.guardScope)}`);
  console.log(`  hub guard (pre-commit) exit: ${r.guardExit}${r.guardStderr ? `\n    ${r.guardStderr.split('\n').slice(0, 2).join('\n    ')}` : ''}`);
  console.log(`  land's advisory scope: ${JSON.stringify(r.landScope)}`);
  console.log(`  POST /land {queue}: ${r.landRequest}${r.resubmittedUnderstated ? '  -> resubmitted with advisory scope [bye] to test the lander' : ''}`);
  console.log(`  lander admissionScope: ${JSON.stringify(r.admissionScope)}`);
  console.log(`  landing: ${r.landing}; its holds: ${JSON.stringify(r.landingHolds)}`);
  for (const x of r.adminLog) console.log(`    [lander] ${x}`);
  console.log(`  A's claim afterwards: ${r.claimAfter}; trunk now has B's hello: ${r.trunkHasBsHello}`);
}

const control = await scenario('utf8');
show(control);
const controlGated =
  control.guardExit === 1 &&
  control.landRequest.startsWith('refused') &&
  control.landingStatus === 'failed' &&
  control.landingFailure === 'claim_conflict' &&
  !control.trunkHasBsHello;
if (!controlGated) {
  console.error('\nINCONCLUSIVE: the UTF-8 control was not gated at every step; the rig is broken.');
  process.exit(2);
}

const latin = await scenario('latin1');
show(latin);

const misses = [];
if (Array.isArray(latin.changedSymbols) && !latin.changedSymbols.includes(HELLO)) misses.push('changedSymbols omits Greeting.hello');
if (!latin.guardScope.some((e) => e === FILE || e === `${FILE}#${HELLO}`)) misses.push('guard scope omits hello');
if (latin.guardExit === 0) misses.push('pre-commit guard let the commit through');
if (latin.landRequest === 'accepted') misses.push('land request accepted (advisory gate missed)');
if (typeof latin.admissionScope !== 'string' && !latin.admissionScope.some((e) => e === FILE || e === `${FILE}#${HELLO}`)) misses.push('lander admission scope omits hello');
if (latin.landingStatus === 'landed') misses.push('landing landed over the live claim (claimGate: fail)');
if (latin.trunkHasBsHello && latin.claimAfter === 'active') misses.push("trunk has B's hello while A's claim is active");

console.log('');
if (misses.length > 0) {
  console.error(`DEFECT PRESENT (R-40): with a Latin-1 source, B's unclaimed edit of ${HELLO} is invisible to the mapping:\n  - ${misses.join('\n  - ')}`);
  process.exit(1);
}
console.log("No defect: the Latin-1 edit of hello is gated like the UTF-8 one.");
process.exit(0);
