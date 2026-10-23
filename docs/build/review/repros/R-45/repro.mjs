// R-45: hub_wait {landing_id} / landing_status render another agent's failed
// landing as if the reader were its author ("your change", "Fix it, commit,
// and call land again: you keep your place", "Your claims are yours ...").
//
// Everything is in-process and offline: a real Hub (SQLite :memory:) behind the
// real server on 127.0.0.1:0, a local bare remote with two agent clones, each
// agent's real `hub mcp` server (createMcpServer from the built adapter) over
// an in-memory MCP transport, and the lander's side played over HTTP with the
// lander token (no AI resolver is involved at all).
//
// Exits 1 when the defect is present, 0 when it is not, 2 on a setup error.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { Hub, SqliteStore, startServer } = await imp('packages/hub/dist/index.js');
const { LANDER_LEASE_KEY } = await imp('packages/contract/dist/index.js');
const { HubClient } = await imp('packages/adapter/dist/client.js');
const { Feed } = await imp('packages/adapter/dist/feed.js');
const { createMcpServer } = await imp('packages/adapter/dist/mcp.js');
const { Client } = await imp('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const { InMemoryTransport } = await imp('node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');

const MAYA = 'maya/claude-1';
const SAM = 'sam/claude-1';
const PROJECT = 'demo';
const LANDER = 'lander/testbox-4242-a1b2';
const LANDER_TOKEN = 'lander-secret-for-repro';

// Isolate git (and the adapter's git calls) from this machine's config.
const CLEAN_ENV = {};
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('HUB_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PROJECT_DIR') CLEAN_ENV[k] = v;
Object.assign(CLEAN_ENV, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Repro',
  GIT_AUTHOR_EMAIL: 'repro@example.com',
  GIT_COMMITTER_NAME: 'Repro',
  GIT_COMMITTER_EMAIL: 'repro@example.com',
  HUB_CONFIG: '/nonexistent/agenthub/config.json',
});
for (const k of Object.keys(process.env)) if (k.startsWith('HUB_') || k.startsWith('GIT_')) delete process.env[k];
Object.assign(process.env, CLEAN_ENV);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: CLEAN_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'repro-r45-'));
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'init', '-q', '-b', 'main', seed);
  mkdirSync(path.join(seed, 'src'), { recursive: true });
  writeFileSync(path.join(seed, 'src', 'auth.ts'), 'export function login(user: string) {\n  return `session-${user}`;\n}\n');
  writeFileSync(path.join(seed, 'src', 'users.ts'), 'export const users = ["maya", "sam"];\n');
  writeFileSync(path.join(seed, 'check.mjs'), 'process.exit(0);\n');
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: PROJECT, land: { check: 'node check.mjs' } }, null, 2)}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const maya = path.join(dir, 'wt-maya');
  const sam = path.join(dir, 'wt-sam');
  git(dir, 'clone', '-q', remote, maya);
  git(dir, 'clone', '-q', remote, sam);
  git(maya, 'checkout', '-q', '-b', 'agent-maya');
  git(sam, 'checkout', '-q', '-b', 'agent-sam');
  return { dir, remote, maya, sam };
}

function commit(wt, files, message) {
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(wt, p)), { recursive: true });
    writeFileSync(path.join(wt, p), content);
  }
  git(wt, 'add', '--', ...Object.keys(files));
  git(wt, 'commit', '-q', '-m', message);
  return git(wt, 'rev-parse', 'HEAD').trim();
}

async function startHub(port = 0) {
  const hub = new Hub({ store: new SqliteStore(':memory:') });
  const server = await startServer({ hub, port, host: '127.0.0.1', sweepIntervalMs: 100, landerToken: LANDER_TOKEN });
  return { hub, server, url: server.url, port: server.port };
}

/**
 * fetch, retried on a stale keep-alive socket: after the hub restarts on the
 * same port, undici may first reuse a socket the old server closed.
 */
async function fetchRetry(url, init, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (i >= tries - 1 || err?.cause?.code !== 'UND_ERR_SOCKET') throw err;
    }
  }
}

/** Drain stale pooled sockets to the restarted hub before the adapter talks to it. */
async function warmUp(url) {
  for (let ok = 0, i = 0; ok < 4 && i < 40; i++) {
    try {
      const r = await fetch(`${url}/v1/p/${PROJECT}/events?wait_ms=0`);
      await r.arrayBuffer();
      ok++;
    } catch {
      ok = 0;
    }
  }
}

/** The lander's side over HTTP with the lander token. */
class Lander {
  constructor(url) {
    this.url = url;
    this.lease = null;
  }
  async call(method, p, body) {
    const res = await fetchRetry(`${this.url}/v1/p/${PROJECT}${p}`, {
      method,
      headers: { 'x-hub-agent': LANDER, 'x-hub-lander-token': LANDER_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`lander ${method} ${p}: HTTP ${res.status} ${JSON.stringify(data)}`);
    return data;
  }
  async takeLease() {
    const r = await this.call('POST', '/claims', { files: [LANDER_LEASE_KEY], queue: true, ttl_ms: 600_000, intent: 'lander on testbox' });
    const { epoch } = await (await fetchRetry(`${this.url}/v1/p/${PROJECT}/events?wait_ms=0`)).json();
    this.lease = { lease_claim_id: r.claim.id, epoch };
  }
  admit(id, body) {
    return this.call('POST', `/landings/${id}/admit`, { lease: this.lease, files: [], scope: null, mapper: null, protected: [], required: [], waits_for: null, warnings: [], ...body });
  }
  next() {
    return this.call('POST', '/lander/next', { lease: this.lease });
  }
  advance(id, body) {
    return this.call('POST', `/landings/${id}/advance`, { lease: this.lease, ...body });
  }
  /** Admit and pick L, take it to `checking`. */
  async start(id, { base, trunkBase, files }) {
    await this.admit(id, { base_sha: base, files });
    const next = await this.next();
    if (next.landing?.id !== id) throw new Error(`next picked ${next.landing?.id}, not ${id}`);
    const attempt = next.landing.attempt;
    await this.advance(id, { attempt, to: 'running', phase: 'merging', deadline_ms: 600_000, trunk_base: trunkBase });
    await this.advance(id, { attempt, to: 'running', phase: 'checking', deadline_ms: 600_000 });
    return attempt;
  }
  fail(id, attempt, code, rep) {
    return this.advance(id, { attempt, to: 'failed', code, report: report(rep) });
  }
}

function report(extra = {}) {
  return { message: '', resolved_by: 'clean', files_via: [], conflicts: [], check: null, resolver: null, next_steps: [], warnings: [], foreign_commits: [], timings: null, ...extra };
}

const checkReport = {
  command_hash: 'fc21ee81dccb',
  exit_code: 1,
  signal: null,
  timed_out: false,
  duration_ms: 161_000,
  log_tail: 'FAIL test/auth.test.ts > login > trims whitespace\n',
  failed_tests: ['test/auth.test.ts > login > trims whitespace'],
  passes_on_trunk: null,
  reproduce: '',
};

const conflictReport = [
  {
    file: 'src/auth.ts',
    kind: 'content',
    hunks: [{ start_line: 1, end_line: 3, symbols: ['login'], base: 'return `session-${user}`;', trunk: 'return `sess-${user}`;', yours: 'return `session-${user.trim()}`;' }],
    trunk_changes: [],
    tried: ['structural'],
    ai_eligible: false,
    explanation: null,
  },
];

const cleanups = [];
async function connect(url, agent, root) {
  const cfg = { url, agent, project: PROJECT, token: null, failClosed: false, timeoutMs: 5000, root, configFiles: [], projectSource: 'env', warnings: [] };
  const c = new HubClient(cfg);
  const feed = new Feed(c, { heartbeatMs: 1000 });
  feed.start();
  const server = createMcpServer({ cfg, client: c, feed, cwd: root, env: { ...CLEAN_ENV, HUB_URL: url, HUB_PROJECT: PROJECT } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: 'repro', version: '0' });
  await mcp.connect(clientSide);
  cleanups.push(async () => {
    feed.stop();
    await mcp.close();
  });
  const call = async (name, args = {}) => {
    const res = await mcp.callTool({ name, arguments: args });
    return { text: res.content.map((x) => x.text).join('\n'), isError: !!res.isError };
  };
  return { call, client: c };
}

async function task(url, agent, title) {
  const c = new HubClient({ url, project: PROJECT, agent, token: null, timeoutMs: 5000 });
  const t = await c.createTask({ title });
  await c.takeTask(t.id);
  return t.id;
}

// Phrases that only make sense when spoken to the landing's author.
const AUTHOR_ONLY = [
  /\byour change\b/i,
  /Fix it, commit, and call land again/,
  /you keep your place/i,
  /Landing again keeps your place/,
  /Your claims are yours/,
  /You keep your place/,
];
const authorPhrases = (text) => AUTHOR_ONLY.filter((re) => re.test(text)).map((re) => text.match(re)[0]);

const findings = [];
function judge(label, text) {
  const hits = authorPhrases(text);
  console.log(`\n=== ${label} ===\n${text}`);
  if (hits.length) {
    findings.push(`${label}: addressed as the author (${hits.map((h) => JSON.stringify(h)).join(', ')})`);
    console.log(`--> DEFECT: author-only phrases shown to a non-author: ${hits.map((h) => JSON.stringify(h)).join(', ')}`);
  } else console.log('--> ok: not addressed as the author');
}

let repo;
let h1;
let h2;
try {
  repo = makeRepo();
  const trunk0 = git(repo.maya, 'rev-parse', 'origin/main').trim();

  // ------------------------------------------------------------------ case 1: sam reads maya's send-backs
  h1 = await startHub();
  const lander = new Lander(h1.url);
  await lander.takeLease();
  const maya = await connect(h1.url, MAYA, repo.maya);
  const sam = await connect(h1.url, SAM, repo.sam);

  // maya: task, claim, commit, land -> L-1, the lander checks it.
  const tMaya = await task(h1.url, MAYA, 'Trim user names at login');
  await maya.client.claim({ files: ['src/auth.ts'], intent: 'trim user names', task_id: tMaya });
  commit(repo.maya, { 'src/auth.ts': 'export function login(user: string) {\n  return `session-${user.trim()}`;\n}\n' }, 'trim user names');
  const landMaya = await maya.call('land', { task_id: tMaya });
  if (landMaya.isError || !/L-1\b/.test(landMaya.text)) throw new Error(`maya's land: ${landMaya.text}`);
  const att1 = await lander.start('L-1', { base: trunk0, trunkBase: trunk0, files: ['src/auth.ts'] });

  // sam lands his own work while L-1 (maya's) is being checked: land names L-1.
  const tSam = await task(h1.url, SAM, 'Add lee to users');
  await sam.client.claim({ files: ['src/users.ts'], intent: 'add lee', task_id: tSam });
  commit(repo.sam, { 'src/users.ts': 'export const users = ["maya", "sam", "lee"];\n' }, 'add lee');
  const landSam = await sam.call('land', { task_id: tSam });
  console.log(`=== sam's land answer (names maya's running landing) ===\n${landSam.text}`);
  if (landSam.isError || !/L-2\b/.test(landSam.text)) throw new Error(`sam's land: ${landSam.text}`);
  const samPointedAtL1 = /L-1\b/.test(landSam.text);
  console.log(`--> sam's land answer names L-1: ${samPointedAtL1}`);

  // The lander sends maya's L-1 back: checks failed.
  await lander.fail('L-1', att1, 'checks_failed', { message: 'The checks failed.', check: checkReport });

  // Control: maya, the author, reads her own send-back (author text is right here).
  const mayaOwn = await maya.call('landing_status', { landing_id: 'L-1' });
  console.log(`\n=== control: maya (author) landing_status L-1 ===\n${mayaOwn.text}`);
  if (!/checks failed on your change/.test(mayaOwn.text)) throw new Error('setup: L-1 did not render as a checks send-back');

  // sam (not the author) follows the id his land answer gave him.
  judge('sam (non-author) landing_status {landing_id: "L-1"} [checks_failed, maya\'s]', (await sam.call('landing_status', { landing_id: 'L-1' })).text);
  judge('sam (non-author) hub_wait {landing_id: "L-1"} [checks_failed, maya\'s]', (await sam.call('hub_wait', { landing_id: 'L-1', timeout_s: 2 })).text);

  // Contrast: the cancelled brief does honour `yours`. sam cancels his L-2; maya reads it.
  await sam.call('land_cancel', { landing_id: 'L-2' });
  const cancelledForMaya = (await maya.call('landing_status', { landing_id: 'L-2' })).text;
  console.log(`\n=== contrast: maya reads sam's cancelled L-2 (this brief honours "yours") ===\n${cancelledForMaya}`);

  // maya lands again -> L-3, sent back with a conflict.
  commit(repo.maya, { 'src/auth.ts': 'export function login(user: string) {\n  return `session-${user.trim().toLowerCase()}`;\n}\n' }, 'lowercase too');
  const land3 = await maya.call('land', { task_id: tMaya });
  if (land3.isError || !/L-3\b/.test(land3.text)) throw new Error(`maya's second land: ${land3.text}`);
  const att3 = await lander.start('L-3', { base: trunk0, trunkBase: trunk0, files: ['src/auth.ts'] });
  await lander.fail('L-3', att3, 'conflict', { message: 'Conflicts in src/auth.ts.', resolved_by: 'none', conflicts: conflictReport });
  judge('sam (non-author) landing_status {landing_id: "L-3"} [conflict, maya\'s]', (await sam.call('landing_status', { landing_id: 'L-3' })).text);

  // maya lands again -> L-4, sent back by the claim gate (generic brief).
  commit(repo.maya, { 'src/auth.ts': 'export function login(user: string) {\n  return `sess-${user.trim().toLowerCase()}`;\n}\n' }, 'sess prefix');
  const land4 = await maya.call('land', { task_id: tMaya });
  if (land4.isError || !/L-4\b/.test(land4.text)) throw new Error(`maya's third land: ${land4.text}`);
  const att4 = await lander.start('L-4', { base: trunk0, trunkBase: trunk0, files: ['src/auth.ts'] });
  await lander.fail('L-4', att4, 'claim_conflict', { message: 'src/auth.ts is held by another agent.' });
  judge('sam (non-author) landing_status {landing_id: "L-4"} [claim_conflict, maya\'s]', (await sam.call('landing_status', { landing_id: 'L-4' })).text);

  for (const c of cleanups.splice(0)) await c();

  // ------------------------------------------------------------------ case 2: a hub database reset renumbers L-1
  // maya lands L-1 on hub A; the hub comes back on the same address with a
  // new database, where L-1 is sam's, and it fails. maya waits on "her" L-1.
  await h1.server.close();
  h1 = null;
  const repo2 = makeRepo();
  const trunk2 = git(repo2.maya, 'rev-parse', 'origin/main').trim();
  const hA = await startHub();
  // maya's MCP server stays up across the hub restart, as a real session's would.
  const mayaA = await connect(hA.url, MAYA, repo2.maya);
  const tA = await task(hA.url, MAYA, 'Trim user names at login');
  commit(repo2.maya, { 'src/auth.ts': 'export function login(user: string) {\n  return `session-${user.trim()}`;\n}\n' }, 'trim user names');
  const landA = await mayaA.call('land', { task_id: tA });
  console.log(`\n=== case 2: maya's land on the first database ===\n${landA.text}`);
  if (landA.isError || !/L-1\b/.test(landA.text)) throw new Error(`maya's land on hub A: ${landA.text}`);
  const portA = hA.port;
  await hA.server.close();

  h2 = await startHub(portA); // same URL, new database (new epoch)
  console.log(`(hub restarted on a new database: was ${hA.url}, now ${h2.url})`);
  await warmUp(h2.url);
  const lander2 = new Lander(h2.url);
  await lander2.takeLease();
  const sam2 = await connect(h2.url, SAM, repo2.sam);
  const tS = await task(h2.url, SAM, 'Add lee to users');
  commit(repo2.sam, { 'src/users.ts': 'export const users = ["maya", "sam", "lee"];\n' }, 'add lee');
  const landS = await sam2.call('land', { task_id: tS });
  if (landS.isError || !/L-1\b/.test(landS.text)) throw new Error(`sam's land on the new database: ${landS.text}`);
  const attS = await lander2.start('L-1', { base: trunk2, trunkBase: trunk2, files: ['src/users.ts'] });
  await lander2.fail('L-1', attS, 'checks_failed', { message: 'The checks failed.', check: checkReport });
  const l1 = await sam2.client.landing('L-1');
  console.log(`(on the new database L-1 is ${l1.agent}'s, status ${l1.status})`);
  judge('maya hub_wait {landing_id: "L-1"} after a hub database reset [L-1 is now sam\'s]', (await mayaA.call('hub_wait', { landing_id: 'L-1', timeout_s: 2 })).text);
  for (const c of cleanups.splice(0)) await c();
  await h2.server.close();
  h2 = null;
  rmSync(repo2.dir, { recursive: true, force: true });
} catch (err) {
  console.error("SETUP ERROR:", err?.stack ?? err, err?.cause);
  process.exitCode = 2;
} finally {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  if (h1) await h1.server.close().catch(() => {});
  if (h2) await h2.server.close().catch(() => {});
  if (repo) rmSync(repo.dir, { recursive: true, force: true });
}

if (process.exitCode !== 2) {
  console.log('\n================ RESULT ================');
  if (findings.length) {
    console.log(`DEFECT PRESENT (R-45): ${findings.length} renderings speak to a non-author as the author:`);
    for (const f of findings) console.log(`- ${f}`);
    process.exitCode = 1;
  } else {
    console.log('No defect: other agents\' send-backs are not addressed to the reader as the author.');
    process.exitCode = 0;
  }
}
// Feeds' long polls may keep the loop alive; leave with the computed code.
setTimeout(() => process.exit(process.exitCode), 200).unref();
