// R-9 reproduction: `hub approve` (decideCommand -> fetchAndShow) passes the
// shas and refs a hub returns straight into git argv. A value starting with '-'
// becomes a git option. Exits 1 when the defect is present, 0 when not.
//
// Payloads are deliberately harmless and stay in this script's own temp dir:
//  A. base_sha "--output=<tmp>/A.out" on a protected requirement: `git diff`
//     writes the diff to that file.
//  B. trunk_base "--output=<tmp>/B.out" on a merged requirement: same, via
//     the merged-content diff.
//  C. candidate_ref "--hub-supplied-option" on a merged requirement: `git fetch`
//     parses it as an option ("unknown option"), showing hub text reaches
//     fetch's option parser (where --upload-pack would run a command; not
//     exercised here).
// No network, no API key: a local bare remote and an in-process fake hub on
// 127.0.0.1:0. The Terminal passed is a fake TTY whose answer is "" (cancel),
// so nothing would ever be approved.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const here = path.dirname(fileURLToPath(import.meta.url));
const { decideCommand } = await import(pathToFileURL(path.join(ROOT, 'packages/adapter/dist/approve.js')).href);
const { HubClient } = await import(pathToFileURL(path.join(ROOT, 'packages/adapter/dist/client.js')).href);

const tmp = mkdtempSync(path.join(here, 'run-'));
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
  }).trim();

// --- repository: a local bare remote, and the approver's checkout of it.
const remote = path.join(tmp, 'remote.git');
const work = path.join(tmp, 'work');
git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
git(tmp, 'init', '-q', '-b', 'main', work);
git(work, 'remote', 'add', 'origin', remote);
mkdirSync(path.join(work, 'migrations'));
writeFileSync(path.join(work, 'migrations/1.sql'), 'create table t (id int);\n');
git(work, 'add', '.');
git(work, 'commit', '-q', '-m', 'base');
const A = git(work, 'rev-parse', 'HEAD');
writeFileSync(path.join(work, 'migrations/1.sql'), 'create table t (id int);\n-- ATTACKER-CONTROLLED-LINE\n');
git(work, 'commit', '-q', '-am', 'change');
const B = git(work, 'rev-parse', 'HEAD');
git(work, 'push', '-q', 'origin', `${B}:refs/agenthub/land/${B}`, `${A}:refs/heads/main`);
git(work, 'reset', '-q', '--hard', A);

// --- fake hub: serves whatever landing the current case sets.
let current = null;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/p/demo/landings/L-1' && current) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ landing: current }));
  } else {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'no' } }));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

const cfg = { url, agent: null, project: 'demo', token: null, failClosed: false, timeoutMs: 5000, root: work, configFiles: [], projectSource: 'env', warnings: [] };
const client = new HubClient(cfg);
const term = { isTTY: true, out: '', write(t) { this.out += t; }, ask: async () => '' };
const env = { HUB_APPROVER: 'maya', HUB_APPROVER_TOKEN: 'not-a-real-token', HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, 'cfg') };

const req = (kind, extra = {}) => ({
  kind,
  digest: '0'.repeat(64),
  paths: ['migrations/1.sql'],
  rules: [{ paths: ['migrations/**'], approvers: null, distinct: true }],
  candidate: null,
  candidate_ref: null,
  trunk_base: null,
  ...extra,
});
const landing = (approval, extra = {}) => ({
  id: 'L-1', project: 'demo', agent: 'lee/agent-1', status: 'needs_approval', commit: B, base_sha: A,
  task_id: null, branch: 'feature', trunk_base: null, candidate: null, candidate_ref: null, approval, approvals: [],
  files: ['migrations/1.sql'], protected: ['migrations/1.sql'], created_at: Date.now(), updated_at: Date.now(), ...extra,
});

const findings = [];
async function run(name, l) {
  current = l;
  term.out = '';
  let r;
  try {
    r = await decideCommand(cfg, client, 'L-1', { decision: 'approve', env, term });
  } catch (err) {
    r = { exitCode: -1, stdout: '', stderr: `threw: ${err.message}` };
  }
  console.log(`--- ${name}: exit ${r.exitCode}\n    stderr: ${r.stderr.trim().slice(0, 300)}`);
  return r;
}

// A. protected requirement, base_sha is an option.
const outA = path.join(tmp, 'A.out');
await run('A protected, base_sha=--output=<file>', landing([req('protected')], { base_sha: `--output=${outA}` }));
if (existsSync(outA)) {
  const body = readFileSync(outA, 'utf8');
  findings.push(`A: git diff wrote ${outA} (${body.length} bytes${body.includes('ATTACKER-CONTROLLED-LINE') ? ', including the attacker commit line' : ''})`);
}

// B. merged requirement, trunk_base is an option.
const outB = path.join(tmp, 'B.out');
await run('B merged, trunk_base=--output=<file>', landing([req('merged', { candidate: B, trunk_base: `--output=${outB}`, candidate_ref: null })]));
if (existsSync(outB)) findings.push(`B: git diff wrote ${outB} (${readFileSync(outB, 'utf8').length} bytes)`);

// C. merged requirement, candidate_ref is an option to git fetch.
const rC = await run('C merged, candidate_ref=--hub-supplied-option', landing([req('merged', { candidate: B, trunk_base: A, candidate_ref: '--hub-supplied-option' })]));
if (/unknown option/i.test(rC.stderr)) findings.push('C: git fetch parsed the hub-supplied candidate_ref as an option ("unknown option")');

server.close();
rmSync(tmp, { recursive: true, force: true });
if (findings.length) {
  console.log(`\nDEFECT PRESENT (R-9): hub-supplied values reach git argv as options:\n  ${findings.join('\n  ')}`);
  process.exit(1);
}
console.log('\nno defect: hub-supplied values did not become git options');
process.exit(0);
