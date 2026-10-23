// R-42 reproduction: post-edit posts every signature change of a Write in one
// POST /symbol-changes; with more than MAX_POSTED_CHANGES (200) the hub answers
// 400 bad_request and records none of them.
//
// Setup: an in-process hub (real Hub + real server, in-memory SQLite, port 0),
// a temp git repo, and the built `hub` CLI's pre-edit / post-edit hooks played
// around a Write tool call exactly as Claude Code runs them.
//
//   control: Write of src/api/small.ts changing 150 exported signatures
//            -> expected (and observed) 150 in_progress symbol_changes rows
//   defect:  Write of src/api/client.ts changing 250 exported signatures
//            -> with the defect: 0 rows, 0 symbol.changed events
//
// Exits 1 when the defect is present (no change of the 250-signature Write is
// recorded), 0 when the hub records them (chunked posting, or a cap). Exits 2 on
// a setup failure. No network, no API key.
//
// Run: AGENTHUB_ROOT=/home/user/agenthub node repro.mjs

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { Hub, SqliteStore, startServer } = await imp('packages/hub/dist/index.js');
const { HubClient } = await imp('packages/adapter/dist/client.js');
const CLI = path.join(ROOT, 'packages/adapter/bin/hub.js');

const PROJECT = 'demo';
const AGENT = 'maya/claude-1';
const OTHER = 'sam/claude-1';

function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('HUB_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PROJECT_DIR' && k !== 'ANTHROPIC_API_KEY') env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    HUB_CONFIG: '/nonexistent/agenthub/config.json',
    ...extra,
  });
  return env;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: cleanEnv({}), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function run(args, { cwd, env, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** n exported functions; `changed` gives each one a second parameter (a signature change). */
function moduleText(n, changed) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`export function fn${i}(a: string${changed ? ', b = 0' : ''}): string {`, `  return a + ${i};`, '}', '');
  }
  return out.join('\n');
}

let calls = 0;
function payload(event, root, call) {
  return JSON.stringify({
    session_id: 'sess-maya',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: root,
    permission_mode: 'default',
    hook_event_name: event,
    tool_name: call.tool,
    tool_input: call.input,
    ...(event === 'PostToolUse' ? { tool_response: { filePath: call.input.file_path, success: true } } : {}),
    tool_use_id: call.id,
  });
}

/** One Write tool call by AGENT, as Claude Code runs it: PreToolUse, the write, PostToolUse. */
async function writeCall(root, env, file, content) {
  const abs = path.join(root, file);
  const call = { tool: 'Write', input: { file_path: abs, content }, id: `toolu_${++calls}` };
  const pre = await run(['hook', 'pre-edit'], { cwd: root, env, input: payload('PreToolUse', root, call) });
  if (pre.code !== 0) throw new Error(`pre-edit exited ${pre.code}: ${pre.stderr}`);
  const out = pre.stdout ? JSON.parse(pre.stdout) : null;
  if (out?.hookSpecificOutput?.permissionDecision === 'deny') throw new Error(`pre-edit denied: ${out.hookSpecificOutput.permissionDecisionReason}`);
  writeFileSync(abs, content);
  const post = await run(['hook', 'post-edit'], { cwd: root, env, input: payload('PostToolUse', root, call) });
  if (post.code !== 0) throw new Error(`post-edit exited ${post.code}: ${post.stderr}`);
  return post.stdout ? (JSON.parse(post.stdout).hookSpecificOutput?.additionalContext ?? null) : null;
}

const hub = new Hub({ store: new SqliteStore(':memory:') });
const server = await startServer({ hub, port: 0, sweepIntervalMs: 100 });
const dir = mkdtempSync(path.join(tmpdir(), 'agenthub-r42-'));
let exitCode = 2;
try {
  const root = path.join(dir, 'repo');
  mkdirSync(path.join(root, 'src', 'api'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', root);
  writeFileSync(path.join(root, 'src/api/small.ts'), moduleText(150, false));
  writeFileSync(path.join(root, 'src/api/client.ts'), moduleText(250, false));
  // Callers of client.ts's fn0..fn2 (so post-edit's who_uses has something to say, and the post error shows).
  writeFileSync(
    path.join(root, 'src/app.ts'),
    "import { fn0, fn1, fn2 } from './api/client.js';\n\nexport function main(x: string): string {\n  return fn0(x) + fn1(x) + fn2(x);\n}\n",
  );
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');

  const env = cleanEnv({ HUB_URL: server.url, HUB_PROJECT: PROJECT, HUB_AGENT: AGENT });
  const reader = new HubClient({ url: server.url, project: PROJECT, agent: OTHER, token: null, timeoutMs: 3000 });
  // Another agent holds the caller: it is the one who should be warned.
  await reader.claim({ files: ['src/app.ts'], intent: 'work on main' });

  const rowsFor = async (file) =>
    (await reader.symbolChanges({ statuses: ['in_progress', 'landed', 'withdrawn', 'superseded'] })).changes.filter((c) => c.agent === AGENT && c.file === file);
  const eventsFor = async (file) => (await reader.events(0, 0)).events.filter((e) => e.type === 'symbol.changed' && e.data?.file === file);

  // Control: 150 signature changes in one Write (under the hub's limit of 200).
  const smallPost = await writeCall(root, env, 'src/api/small.ts', moduleText(150, true));
  const smallRows = await rowsFor('src/api/small.ts');
  const smallEvents = await eventsFor('src/api/small.ts');
  console.log(`control  Write src/api/small.ts, 150 signature changes: rows=${smallRows.length} symbol.changed events=${smallEvents.length}`);
  console.log(`         post-edit context: ${JSON.stringify(smallPost)}`);

  // Direct check of the hub's limit, to name the cause.
  const direct = await fetch(`${server.url}/v1/p/${PROJECT}/symbol-changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-agent': 'probe/claude-1' },
    body: JSON.stringify({
      changes: Array.from({ length: 201 }, (_, i) => ({ file: 'src/probe.ts', symbol: `p${i}`, kind: 'signature', before: `function p${i}()`, after: `function p${i}(x)` })),
    }),
  });
  console.log(`hub      POST /symbol-changes with 201 changes: HTTP ${direct.status} ${await direct.text()}`);

  // The scenario: 250 signature changes in one Write.
  const bigPost = await writeCall(root, env, 'src/api/client.ts', moduleText(250, true));
  const bigRows = await rowsFor('src/api/client.ts');
  const bigEvents = await eventsFor('src/api/client.ts');
  console.log(`scenario Write src/api/client.ts, 250 signature changes: rows=${bigRows.length} symbol.changed events=${bigEvents.length}`);
  console.log(`         post-edit context: ${JSON.stringify(bigPost)}`);
  // sam holds src/app.ts (calls fn0..fn2): with nothing recorded, the hub has nothing to warn sam of.
  const samSees = (await reader.symbolChanges({})).changes.filter((c) => c.file === 'src/api/client.ts' && ['fn0', 'fn1', 'fn2'].includes(c.symbol));
  console.log(`         changes of fn0..fn2 (used by sam's claimed src/app.ts) visible to sam: ${samSees.length}`);

  if (smallRows.length !== 150) {
    console.log(`SETUP: the control Write recorded ${smallRows.length} rows, not 150; the rig does not reach the post path`);
    exitCode = 2;
  } else if (bigRows.length === 0 && bigEvents.length === 0) {
    console.log('DEFECT PRESENT (R-42): a Write with 250 signature changes records none of them; the single POST exceeded MAX_POSTED_CHANGES (200) and was refused whole.');
    exitCode = 1;
  } else {
    console.log(`OK: the 250-signature Write recorded ${bigRows.length} changes (${bigEvents.length} symbol.changed events).`);
    exitCode = 0;
  }
} catch (err) {
  console.error('SETUP FAILURE:', err);
  exitCode = 2;
} finally {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
