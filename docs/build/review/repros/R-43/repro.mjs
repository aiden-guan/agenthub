#!/usr/bin/env node
// R-43 reproduction: queue-mode `land` sends every changed path in the
// advisory `files` (packages/adapter/src/land.ts: files = diffNames(base, head),
// unfiltered, then POST /land {files}). A path git allows but the hub's
// normalizeRepoPath refuses (a `c:` directory, a tab in a name) makes the hub
// answer 400 invalid_path, and landHubRefusedText tells the agent "This hub CLI
// and the hub are probably different versions: tell your human". Every retry
// gives the same answer, so the change can never land and the agent is given
// the wrong reason. The guard and the edit hook already leave such names out
// with unclaimableReason (REVIEW A1/H2); land doesn't.
//
// Design: §2.3.2 (land preflight: each refusal says exactly what to do; files
// are advisory, the lander recomputes them); REVIEW.md §2 "one unusual filename".
//
// No network, no API key: a local bare remote with a `land` section, an
// in-process hub on port 0 (SqliteStore ':memory:'), the built adapter's
// landWork (the engine behind the MCP `land` tool and `hub land`) over the real
// HTTP HubClient. No lander or resolver is needed: the defect is in the queue
// request itself.
//
// Exit 0: no defect. Exit 1: defect present. Exit 2: the harness itself broke.
//
//   AGENTHUB_ROOT=/home/user/agenthub node repro.mjs        (AGENTHUB_KEEP=1 keeps the temp dir)

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const imp = (p) => import(pathToFileURL(path.join(ROOT, 'packages', p)).href);

// A clean git environment for everything, including the adapter's own git calls (gitops.open isolated:false uses process.env).
for (const k of Object.keys(process.env)) if (/^(GIT_|HUB_|ANTHROPIC_|AGENTHUB_SYNC)/.test(k)) delete process.env[k];
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  HUB_CONFIG: '/nonexistent/agenthub/config.json',
  GIT_AUTHOR_NAME: 'Agent Human',
  GIT_AUTHOR_EMAIL: 'agent@example.com',
  GIT_COMMITTER_NAME: 'Agent Human',
  GIT_COMMITTER_EMAIL: 'agent@example.com',
});

const { Hub, SqliteStore, startServer, normalizeRepoPath } = await imp('hub/dist/index.js');
const { landWork } = await imp('adapter/dist/land.js');
const { HubClient } = await imp('adapter/dist/client.js');
const { unclaimableReason } = await imp('adapter/dist/git.js');

const P = 'acme/web';

function git(cwd, args, o = {}) {
  const r = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', input: '' });
  if (r.error) throw r.error;
  if (r.status !== 0 && !o.ok) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr}`);
  return o.ok ? r : r.stdout.trim();
}
const indent = (s) => s.split('\n').join('\n      ');

const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'repro-R-43-')));
const remote = path.join(dir, 'remote.git');
let front = null;
let hub = null;
let exitCode = 2;

try {
  // ---- the project remote: agenthub.json with a land section
  git(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = path.join(dir, 'seed');
  git(dir, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  writeFileSync(path.join(seed, 'check.mjs'), "console.log('ok');\n");
  writeFileSync(path.join(seed, 'agenthub.json'), `${JSON.stringify({ project: P, land: { check: 'node check.mjs', resolver: { enabled: false } } }, null, 2)}\n`);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-q', 'origin', 'main']);

  // ---- hub (in-process, HTTP on port 0)
  hub = new Hub({ store: new SqliteStore(':memory:'), leaseTtlMs: 60_000, heartbeatIntervalMs: 15_000 });
  front = await startServer({ hub, port: 0, host: '127.0.0.1', sweepIntervalMs: 100 });

  /** An agent's clone on its own branch with `files` committed on top of trunk; its land deps. */
  function agentWith(name, files) {
    const A = path.join(dir, name.replace('/', '-'));
    git(dir, ['clone', '-q', remote, A]);
    git(A, ['checkout', '-q', '-b', `${name.split('/')[0]}-work`]);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(A, rel)), { recursive: true });
      writeFileSync(path.join(A, rel), body);
    }
    git(A, ['add', '-A']);
    git(A, ['commit', '-q', '-m', `${name}: change`]);
    if (git(A, ['status', '--porcelain=v1']) !== '') throw new Error(`setup: ${name} worktree not clean`);
    const cfg = { url: front.url, agent: name, project: P, token: null, failClosed: false, timeoutMs: 10_000, root: A, configFiles: [], projectSource: 'file', warnings: [] };
    return { A, head: git(A, ['rev-parse', 'HEAD']), deps: { cfg, client: new HubClient(cfg), feed: null } };
  }

  // ---- 0. control: an ordinary change queues (the harness works)
  const ctl = agentWith('ctl/claude-1', { 'src/ok.md': 'ok\n' });
  const c0 = await landWork(ctl.deps, {});
  console.log(`[0 control: src/ok.md] error=${c0.error} landing=${c0.landing?.id ?? '-'} status=${c0.landing?.status ?? '-'}\n      ${indent(c0.text.split('\n')[0])}`);
  if (c0.error || !c0.landing || c0.landing.status !== 'submitted') throw new Error(`setup: the control land did not queue: ${c0.text}`);

  const cases = [
    { agent: 'maya/claude-1', bad: 'c:/notes.md', what: 'a `c:` directory', mine: 'src/maya.md' },
    { agent: 'sam/claude-1', bad: 'docs/a\tb.md', what: 'a tab in a file name', mine: 'src/sam.md' },
  ];
  const defects = [];
  for (const [i, c] of cases.entries()) {
    const ag = agentWith(c.agent, { [c.mine]: `${c.agent}\n`, [c.bad]: 'notes\n' });
    const tree = git(ag.A, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean);
    if (!tree.includes(c.bad)) throw new Error(`setup: git did not commit ${JSON.stringify(c.bad)} (tree: ${JSON.stringify(tree)})`);
    let hubSays = null;
    try {
      normalizeRepoPath(c.bad);
    } catch (err) {
      hubSays = `${err.code}: ${err.message}`;
    }
    console.log(`\n[${i + 1} ${c.agent} commits ${JSON.stringify(c.bad)} (${c.what}) with ${c.mine}]`);
    console.log(`      git committed it: yes; hub normalizeRepoPath: ${hubSays ?? 'accepts it'}; adapter unclaimableReason: ${unclaimableReason(c.bad) ?? 'null'}`);

    const attempts = [];
    for (let k = 1; k <= 2; k++) {
      const r = await landWork(ag.deps, {});
      attempts.push(r);
      console.log(`      land #${k}: error=${r.error} landing=${r.landing?.id ?? '-'}\n        ${r.text.split('\n').join('\n        ')}`);
    }
    const pushed = git(remote, ['for-each-ref', '--format=%(refname)', `refs/agenthub/land/${ag.head}`]) !== '';
    console.log(`      land ref refs/agenthub/land/${ag.head.slice(0, 10)}… on the remote: ${pushed ? 'pushed' : 'absent'}`);

    // What the fix would send: the same request without the name the hub refuses. The hub takes it.
    let filteredOk = 'not tried (land queued)';
    if (attempts.some((r) => r.error)) try {
      const res = hub.land(P, `${c.agent.split('/')[0]}/probe`, { queue: true, commit: ag.head, files: [c.mine], summary: 'probe' });
      filteredOk = res.landing.status;
    } catch (err) {
      filteredOk = `refused: ${err.code} ${err.message}`;
    }
    console.log(`      the same request without ${JSON.stringify(c.bad)} in files (sent straight to the hub): ${filteredOk}`);

    const bad = attempts.filter((r) => r.error && (/invalid_path/.test(r.text) || /probably different versions/.test(r.text)));
    if (bad.length) {
      const blames = bad.some((r) => /probably different versions/.test(r.text));
      defects.push(
        `${c.what} (${JSON.stringify(c.bad)}): land pushed the ref, the hub answered 400 invalid_path for the advisory files, and ` +
          `${blames ? 'the agent was told "This hub CLI and the hub are probably different versions: tell your human"' : 'the land was refused'}` +
          ` on ${bad.length} of ${attempts.length} attempts; nothing was queued (the hub takes the request once that name is left out: ${filteredOk})`,
      );
    } else if (attempts.every((r) => !r.error) && !attempts.some((r) => r.text.includes(c.bad) || r.text.includes(JSON.stringify(c.bad).slice(1, -1)))) {
      // Queued, but the left-out name is not mentioned: the agent is not told its file is invisible to coordination.
      defects.push(`${c.what} (${JSON.stringify(c.bad)}): land queued but did not name the path it left out of the advisory files`);
    }
  }

  if (defects.length) {
    console.log(`\nDEFECT R-43:\n  - ${defects.join('\n  - ')}`);
    exitCode = 1;
  } else {
    console.log('\nPASS: land queues (or refuses with an accurate reason) when the change includes a path the hub cannot name.');
    exitCode = 0;
  }
} catch (err) {
  console.error('harness error:', err?.stack ?? err);
  exitCode = 2;
} finally {
  await front?.close().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  try {
    hub?.store?.close?.();
  } catch {}
  if (process.env.AGENTHUB_KEEP === '1') console.log(`(kept ${dir})`);
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
