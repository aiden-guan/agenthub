// Repro for R-41: while a contained parse error that swallows a neighbour
// persists in a worktree, edits to the swallowed neighbour's text map to the
// swallowing declaration alone, so the pre-edit claim names only that key and
// is granted over another agent's claim on the neighbour.
//
// Design §4.2 #3: "Only errors contained in one named declaration's body on each
// side are tolerated, and that declaration is claimed ... A swallowed neighbour
// disappears from the outline, so its key is claimed as removed." §1.10: a
// contained error claims that declaration's key. The "claimed as removed"
// defence works only for the edit that introduces the error. Once the error is
// in the file, the neighbour is absent from the outline on both sides of every
// later edit, and changedSymbols (diff.ts diffSides) attributes a change in its
// text to the swallowing key only (it lies inside that key's span).
//
// What the script does (everything local: a temp git repo with three
// worktrees, an in-process Hub on a temp SQLite file served by the real HTTP
// server on 127.0.0.1:0 with an injectable clock, and the built `hub` CLI's
// real PreToolUse/PostToolUse hooks, exactly as Claude Code runs them; no
// lander, no resolver, no network, no API key). For Go (src/x.go: a, b) and
// Python (src/x.py: a, b, c):
//  1. A (maya/claude-1, wt-a) Edits func a so it loses a closing token (Go: the
//     `}` of `if x {`; Python: the `)` of `x = (1,)`). Its pre-edit hook is
//     granted [a, b] (Go) / [a, b, c] (Python): the transition defence works.
//     The edit is applied and post-edit runs; the file stays broken.
//  2. A's leases lapse (the hub clock moves past the lease TTL, as when A's
//     session ended without heartbeats): A holds nothing; wt-a stays broken.
//  3. B (sam/claude-1, wt-b, clean tree) Edits the swallowed function (Go b,
//     Python c): granted [b] / [c].
//  4. Control: C (lee/claude-1, wt-c, clean tree) Edits the same function: its
//     hook is denied (B holds it). The rig gates edits of that code.
//  5. Defect check: A Edits the same function's body in its broken wt-a.
//     Correct: denied (B holds that function), or at least claimed at file
//     level. Defect: granted with the claim [a] only; the edit is applied and A
//     and B now both edit B's function, each under a granted claim.
//
// Exit 1 exactly when step 5 is granted in any language (the defect); 0 when
// it is denied in every language; 2 when the setup does not behave as the
// scenario needs (a control fails).
//
// Run:
//   AGENTHUB_ROOT=/home/user/agenthub node \
//     /tmp/claude-0/-home-user-agenthub/8b8b52f8-98ca-5efe-ba8a-d267c5f2c650/scratchpad/work-p23/review/repro-R-41/repro.mjs

import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT ?? '/home/user/agenthub';
const dist = (pkg, file) => pathToFileURL(path.join(ROOT, 'packages', pkg, 'dist', file)).href;
const { Hub, SqliteStore, startServer } = await import(dist('hub', 'index.js'));
const { changedSymbols, outline } = await import(dist('symbols', 'index.js'));
const CLI = path.join(ROOT, 'packages/adapter/bin/hub.js');

const P = 'demo';
const A = 'maya/claude-1';
const B = 'sam/claude-1';
const C = 'lee/claude-1';
const LEASE_TTL_MS = 120_000;

// ----------------------------------------------------------------- the cases
const CASES = [
  {
    lang: 'go',
    file: 'src/x.go',
    clean: 'package p\n\nfunc a() {\n\tif x {\n\t\treturn\n\t}\n}\n\nfunc b() int {\n\treturn 2\n}\n',
    // A's edit that introduces the contained error: drop the `}` closing `if x {`.
    breakEdit: { old_string: '\t\treturn\n\t}\n}', new_string: '\t\treturn\n}' },
    victim: 'b',
    // B's edit of the victim (clean tree), C's (clean tree), and A's (broken tree).
    bEdit: { old_string: 'return 2', new_string: 'return 20' },
    cEdit: { old_string: 'return 2', new_string: 'return 21' },
    aEdit: { old_string: 'return 2', new_string: 'return 22' },
  },
  {
    lang: 'python',
    file: 'src/x.py',
    clean: 'def a():\n    x = (1,)\n\ndef b():\n    return 2\n\ndef c():\n    return 3\n',
    // Drop the `)` of `x = (1,)`: def a's body swallows b and c.
    breakEdit: { old_string: 'x = (1,)', new_string: 'x = (1,' },
    victim: 'c',
    bEdit: { old_string: 'return 3', new_string: 'return 30' },
    cEdit: { old_string: 'return 3', new_string: 'return 31' },
    aEdit: { old_string: 'return 3', new_string: 'return 33' },
  },
];

const tmp = mkdtempSync(path.join(os.tmpdir(), 'repro-R41-'));
let server;
const cleanup = async () => {
  try {
    await server?.close();
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
};

// ----------------------------------------------------------------- environment
function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('HUB_') && !k.startsWith('GIT_') && k !== 'CLAUDE_PROJECT_DIR') env[k] = v;
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Repro',
    GIT_AUTHOR_EMAIL: 'repro@example.com',
    GIT_COMMITTER_NAME: 'Repro',
    GIT_COMMITTER_EMAIL: 'repro@example.com',
    HUB_CONFIG: '/nonexistent/agenthub/config.json',
    ANTHROPIC_API_KEY: '',
  });
  return Object.assign(env, extra);
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: baseEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ----------------------------------------------------------------- the repo
const main = path.join(tmp, 'sample');
mkdirSync(path.join(main, 'src'), { recursive: true });
git(tmp, 'init', '-q', '-b', 'main', main);
for (const c of CASES) writeFileSync(path.join(main, c.file), c.clean);
writeFileSync(path.join(main, 'README.md'), '# sample\n');
git(main, 'add', '-A');
git(main, 'commit', '-q', '-m', 'initial');
const WT = { [A]: path.join(tmp, 'wt-a'), [B]: path.join(tmp, 'wt-b'), [C]: path.join(tmp, 'wt-c') };
git(main, 'worktree', 'add', '-q', WT[A], '-b', 'agent-a');
git(main, 'worktree', 'add', '-q', WT[B], '-b', 'agent-b');
git(main, 'worktree', 'add', '-q', WT[C], '-b', 'agent-c');

// ----------------------------------------------------------------- the hub (clock we can move)
let skew = 0;
const hub = new Hub({ store: new SqliteStore(path.join(tmp, 'hub.db')), now: () => Date.now() + skew, leaseTtlMs: LEASE_TTL_MS, heartbeatIntervalMs: 15_000 });
server = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 3_600_000 });
const url = `http://127.0.0.1:${server.port}`;

function call(method, route, agent, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: `/v1/p/${P}${route}`,
        agent: false,
        headers: { 'x-hub-agent': agent, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {}
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function ok(method, route, agent, body) {
  const r = await call(method, route, agent, body);
  if (r.status >= 300) throw new Error(`${method} ${route} as ${agent} -> ${r.status} ${r.text.slice(0, 400)}`);
  return r.json;
}

// The built CLI's hooks, as Claude Code runs them.
function hubHook(name, agent, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'hook', name], {
      cwd: WT[agent],
      env: baseEnv({ HUB_URL: url, HUB_PROJECT: P, HUB_AGENT: agent, HUB_TIMEOUT_MS: '5000' }),
    });
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
let callNo = 0;
function hookInput(event, agent, file, edit, toolUseId, extra = {}) {
  const wt = WT[agent];
  return JSON.stringify({
    session_id: `repro-session-${agent.replace(/\W/g, '-')}`,
    transcript_path: '/tmp/transcript.jsonl',
    cwd: wt,
    permission_mode: 'default',
    hook_event_name: event,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(wt, file), old_string: edit.old_string, new_string: edit.new_string, replace_all: false },
    tool_use_id: toolUseId,
    ...extra,
  });
}
/** An Edit tool call: pre-edit hook; if allowed, the edit itself (exactly what Edit does) and post-edit. */
async function editCall(agent, file, edit) {
  const toolUseId = `toolu_R41_${++callNo}`;
  const pre = await hubHook('pre-edit', agent, hookInput('PreToolUse', agent, file, edit, toolUseId));
  let out = null;
  try {
    out = pre.stdout.trim() ? JSON.parse(pre.stdout) : null;
  } catch {}
  const decision = out?.hookSpecificOutput?.permissionDecision ?? 'allow';
  const reason = out?.hookSpecificOutput?.permissionDecisionReason ?? out?.systemMessage ?? '';
  if (decision !== 'deny') {
    const abs = path.join(WT[agent], file);
    const text = readFileSync(abs, 'utf8');
    const i = text.indexOf(edit.old_string);
    if (i < 0 || text.indexOf(edit.old_string, i + 1) >= 0) throw new Error(`edit not applicable in ${abs}`);
    writeFileSync(abs, text.slice(0, i) + edit.new_string + text.slice(i + edit.old_string.length));
    const post = await hubHook(
      'post-edit',
      agent,
      hookInput('PostToolUse', agent, file, edit, toolUseId, { tool_response: { filePath: abs, success: true } }),
    );
    if (post.code !== 0) console.log(`  (post-edit exit ${post.code}: ${post.stderr.trim().slice(0, 300)})`);
  }
  return { decision, reason, stderr: pre.stderr };
}

const live = async (file, holder) => {
  const s = await ok('GET', `/claims?file=${encodeURIComponent(file)}`, A);
  return (s.claims ?? []).filter((c) => (c.status === 'active' || c.status === 'queued') && (!holder || c.holder === holder));
};
const keysOf = (claims, file) => [...new Set(claims.flatMap((c) => c.scope.filter((e) => e.file === file).map((e) => e.symbol ?? '<whole file>')))];
const show = (claims) => claims.map((c) => `${c.id} ${c.holder} ${c.status} [${c.scope.map((e) => e.file + (e.symbol ? '#' + e.symbol : '')).join(', ')}]`);
const outlineLine = async (text, lang) => {
  const o = await outline(text, lang);
  return `errors=${o.errors} errorKeys=${JSON.stringify(o.errorKeys)} items=[${o.items.map((i) => i.key).join(', ')}]`;
};

let setupBroken = false;
let defect = false;
try {
  for (const k of CASES) {
    console.log(`\n================ ${k.lang}: ${k.file} (victim: ${k.victim})`);
    console.log(`clean outline:  ${await outlineLine(k.clean, k.lang)}`);

    // 1. A introduces the contained error through its edit hook.
    const r1 = await editCall(A, k.file, k.breakEdit);
    const aKeys1 = keysOf(await live(k.file, A), k.file);
    const brokenText = readFileSync(path.join(WT[A], k.file), 'utf8');
    console.log(`[1] A's Edit breaking a: ${r1.decision}; A now holds ${JSON.stringify(aKeys1)}`);
    console.log(`    wt-a outline: ${await outlineLine(brokenText, k.lang)}`);
    if (r1.decision === 'deny' || !aKeys1.includes(k.victim)) {
      console.log(`    SETUP: expected the introducing edit to be granted with ${k.victim} claimed as removed (§4.2 #3).${r1.reason ? ' ' + r1.reason : ''}`);
      setupBroken = true;
      continue;
    }

    // 2. A's leases lapse; wt-a stays broken.
    skew += LEASE_TTL_MS + 5_000;
    await ok('POST', '/claims/check', C, { files: [k.file] }).catch(() => null); // any hub write runs the expiry
    const aLeft = await live(k.file, A);
    console.log(`[2] hub clock +${LEASE_TTL_MS + 5_000} ms: A's leases lapsed; A holds ${JSON.stringify(keysOf(aLeft, k.file))}`);
    if (aLeft.length) {
      console.log('    SETUP: A still holds claims after the lease TTL.');
      setupBroken = true;
      continue;
    }

    // 3. B claims the victim from its clean tree.
    const r3 = await editCall(B, k.file, k.bEdit);
    const bKeys = keysOf(await live(k.file, B), k.file);
    console.log(`[3] B's Edit of ${k.victim} (clean wt-b): ${r3.decision}; B holds ${JSON.stringify(bKeys)}`);
    if (r3.decision === 'deny' || JSON.stringify(bKeys) !== JSON.stringify([k.victim])) {
      console.log(`    SETUP: expected B granted [${k.victim}]. ${r3.reason}`);
      setupBroken = true;
      continue;
    }

    // 4. Control: C's edit of the victim from a clean tree is denied.
    const r4 = await editCall(C, k.file, k.cEdit);
    console.log(`[4] control: C's Edit of ${k.victim} (clean wt-c): ${r4.decision}`);
    if (r4.decision !== 'deny') {
      console.log(`    SETUP: C should be denied, B holds ${k.victim}.`);
      setupBroken = true;
      continue;
    }
    console.log(`    reason: ${r4.reason.split('\n')[0].slice(0, 220)}`);

    // 5. The defect check: A's edit of the victim's body in its broken tree.
    const before = readFileSync(path.join(WT[A], k.file), 'utf8');
    const simulated = before.replace(k.aEdit.old_string, k.aEdit.new_string);
    const mapped = await changedSymbols(k.file, before, simulated);
    console.log(`[5] A's Edit of ${k.victim}'s body (${JSON.stringify(k.aEdit.old_string)} -> ${JSON.stringify(k.aEdit.new_string)}) in broken wt-a`);
    console.log(`    changedSymbols(before, after): ${mapped.fileLevel ? `file-level (${mapped.reason})` : JSON.stringify(mapped.symbols)}`);
    const r5 = await editCall(A, k.file, k.aEdit);
    const aKeys5 = keysOf(await live(k.file, A), k.file);
    console.log(`    pre-edit hook: ${r5.decision}; A now holds ${JSON.stringify(aKeys5)}`);
    if (r5.decision === 'deny') {
      console.log(`    reason: ${r5.reason.split('\n')[0].slice(0, 220)}`);
      console.log(`    OK: A's edit of ${k.victim} is gated by B's claim.`);
    } else {
      defect = true;
      const victimText = (t) => {
        const m = t.indexOf(k.victim === 'b' ? (k.lang === 'go' ? 'func b()' : 'def b()') : 'def c()');
        return t.slice(m).split('\n').slice(0, 2).join(' | ');
      };
      console.log(`    claims on ${k.file} now: ${show(await live(k.file)).join('; ')}`);
      console.log(`    wt-a ${k.victim} is now: ${victimText(readFileSync(path.join(WT[A], k.file), 'utf8'))}`);
      console.log(`    wt-b ${k.victim} is now: ${victimText(readFileSync(path.join(WT[B], k.file), 'utf8'))}`);
      console.log(
        `    DEFECT (R-41): A's edit of ${k.victim}'s code is granted under the claim [a] alone, although ${B} holds ${k.file}#${k.victim}: ` +
          `while a's contained error persists, ${k.victim} is absent from both outlines, so it is never "claimed as removed" (§4.2 #3).`,
      );
      // For the record: what the guard maps at commit (HEAD is the clean file, so the removal shows again).
      const head = git(WT[A], 'show', `HEAD:${k.file}`);
      const atCommit = await changedSymbols(k.file, head + '\n', readFileSync(path.join(WT[A], k.file), 'utf8'));
      console.log(`    [info] HEAD -> wt-a at commit maps to ${atCommit.fileLevel ? `file-level (${atCommit.reason})` : JSON.stringify(atCommit.symbols)} (the guard and admission, from a clean base, still see ${k.victim})`);
    }
  }
} catch (err) {
  console.error(err);
  setupBroken = true;
} finally {
  await cleanup();
}

if (defect) {
  console.log('\nRESULT: defect present (exit 1).');
  process.exit(1);
}
if (setupBroken) {
  console.log('\nRESULT: setup did not behave as the scenario needs (exit 2).');
  process.exit(2);
}
console.log('\nRESULT: no defect: edits of a swallowed neighbour are gated by its holder (exit 0).');
process.exit(0);
