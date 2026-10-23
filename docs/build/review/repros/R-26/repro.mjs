// R-26 reproduction: constructor signature changes never reach callers, and
// who_uses reports no callers for a constructor.
//
// Run: AGENTHUB_ROOT=/home/user/agenthub node repro.mjs
//
// Builds a temp repository with two worktrees (agent A, agent B), an
// in-process hub on port 0 (in-memory SQLite), and drives:
//   - A's post-edit: changedSymbols() on a constructor edit, POST /symbol-changes
//   - B's side: relevant() (feed notice / hub_wait), currentImpacts() (impacts
//     tool), editImpacts() (pre-edit note) against B's claim on the caller
//   - A's who_uses on the constructor key
// for TypeScript (`Session.constructor`), Python (`Session.__init__`) and Java
// (`Session.constructor`). A method change (`Session.refresh`) on the same
// files is the control: it must be found, which shows the setup is right.
//
// Exit 0: every constructor change reaches its caller (defect fixed).
// Exit 1: at least one constructor change misses its caller (defect present).
// Exit 2: the control failed or the harness broke (not a verdict).
// No network, no API key.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.AGENTHUB_ROOT || '/home/user/agenthub';
const dist = (pkg, file) => pathToFileURL(path.join(ROOT, 'packages', pkg, 'dist', file)).href;

const { Hub, SqliteStore, startServer } = await import(dist('hub', 'index.js'));
const { HubClient } = await import(dist('adapter', 'client.js'));
const impact = await import(dist('adapter', 'impact.js'));
const { changedSymbols, MAPPER_VERSION } = await import(dist('symbols', 'index.js'));

const PROJECT = 'demo';
const A = 'maya/claude-1';
const B = 'sam/claude-1';

const work = mkdtempSync(path.join(tmpdir(), 'r26-'));
const main = path.join(work, 'main');
const wtA = path.join(work, 'a');
const wtB = path.join(work, 'b');

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });

// ---------------------------------------------------------------- fixture

const FILES = {
  // TypeScript: Session (constructor + refresh), and another class whose own
  // `constructor` declaration is the only other place the word occurs.
  'src/session.ts': [
    'export class Session {',
    '  user: string;',
    '  constructor(user: string) {',
    '    this.user = user;',
    '  }',
    '  refresh(): string {',
    '    return this.user;',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/cache.ts': ['export class Cache {', '  size: number;', '  constructor(size: number) {', '    this.size = size;', '  }', '}', ''].join('\n'),
  'src/routes.ts': [
    "import { Session } from './session.js';",
    '',
    'export function handleLogin(user: string): string {',
    '  const s = new Session(user);',
    '  return s.refresh();',
    '}',
    '',
  ].join('\n'),
  // Python: Session.__init__ and a caller that writes Session(user).
  'py/session.py': ['class Session:', '    def __init__(self, user):', '        self.user = user', '', '    def refresh(self):', '        return self.user', ''].join('\n'),
  'py/routes.py': ['from session import Session', '', '', 'def handle_login(user):', '    s = Session(user)', '    return s.refresh()', ''].join('\n'),
  // Java: Session.constructor and a caller in the same package.
  'java/Session.java': [
    'public class Session {',
    '    private String user;',
    '    public Session(String user) {',
    '        this.user = user;',
    '    }',
    '    public String refresh() {',
    '        return user;',
    '    }',
    '}',
    '',
  ].join('\n'),
  'java/Routes.java': [
    'public class Routes {',
    '    public static String handleLogin(String user) {',
    '        Session s = new Session(user);',
    '        return s.refresh();',
    '    }',
    '}',
    '',
  ].join('\n'),
};

// A's edits: each constructor gains a parameter; each refresh gains one (the control).
const EDITS = {
  'src/session.ts': [
    ['constructor(user: string) {', 'constructor(user: string, ttl: number) {'],
    ['refresh(): string {', 'refresh(ttl?: number): string {'],
  ],
  'py/session.py': [
    ['def __init__(self, user):', 'def __init__(self, user, ttl):'],
    ['def refresh(self):', 'def refresh(self, ttl=None):'],
  ],
  'java/Session.java': [
    ['public Session(String user) {', 'public Session(String user, int ttl) {'],
    ['public String refresh() {', 'public String refresh(int ttl) {'],
  ],
};

// What B holds (the callers), and the caller key each change should reach.
const CASES = [
  { lang: 'TypeScript', decl: 'src/session.ts', ctor: 'Session.constructor', caller: 'src/routes.ts', callerKey: 'handleLogin' },
  { lang: 'Python', decl: 'py/session.py', ctor: 'Session.__init__', caller: 'py/routes.py', callerKey: 'handle_login' },
  { lang: 'Java', decl: 'java/Session.java', ctor: 'Session.constructor', caller: 'java/Routes.java', callerKey: 'Routes.handleLogin' },
];

let hubServer;
let exitCode = 2;
try {
  mkdirSync(main);
  git(main, 'init', '-q');
  for (const [f, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(main, f)), { recursive: true });
    writeFileSync(path.join(main, f), text);
  }
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'base');
  git(main, 'worktree', 'add', '-q', '-b', 'a', wtA);
  git(main, 'worktree', 'add', '-q', '-b', 'b', wtB);

  // ---------------------------------------------------------------- hub
  const hub = new Hub({ store: new SqliteStore(':memory:') });
  hubServer = await startServer({ hub, port: 0, host: '127.0.0.1' });
  const cfgOf = (agent, root) => ({ url: hubServer.url, agent, project: PROJECT, token: null, failClosed: false, timeoutMs: 5000, root, configFiles: [], projectSource: 'env', warnings: [] });
  const clientA = new HubClient(cfgOf(A, wtA));
  const clientB = new HubClient(cfgOf(B, wtB));

  // B claims the three callers at symbol level.
  const claimB = await clientB.claim({ scope: CASES.map((c) => ({ file: c.caller, symbol: c.callerKey })), mapper: MAPPER_VERSION, intent: 'login flow' });
  if (claimB.status !== 'granted') throw new Error(`B's claim was not granted: ${JSON.stringify(claimB)}`);
  // A claims what it edits (as its pre-edit hook would).
  const claimA = await clientA.claim({ files: CASES.map((c) => c.decl), intent: 'session ttl' });
  if (claimA.status !== 'granted') throw new Error(`A's claim was not granted: ${JSON.stringify(claimA)}`);

  // ---------------------------------------------------------------- A edits and posts (post-edit)
  for (const [file, edits] of Object.entries(EDITS)) {
    const before = readFileSync(path.join(wtA, file), 'utf8');
    let after = before;
    for (const [o, n] of edits) {
      if (!after.includes(o)) throw new Error(`fixture: ${o} not in ${file}`);
      after = after.replace(o, n);
    }
    writeFileSync(path.join(wtA, file), after);
    const diff = await changedSymbols(file, before, after);
    if (diff.fileLevel) throw new Error(`changedSymbols(${file}) went file-level: ${diff.reason}`);
    await clientA.postSymbolChanges({ changes: diff.signatureChanges.map((c) => ({ file, ...c })) });
  }

  const listing = await clientB.symbolChanges();
  const changes = listing.changes;
  const changeOf = (file, symbol) => changes.find((c) => c.file === file && c.symbol === symbol);
  const claimsB = await clientB.claims({ holder: B });
  const routesText = (c) => readFileSync(path.join(wtB, c.caller), 'utf8');

  // The impacts tool / digest view for B.
  const current = await impact.currentImpacts(wtB, B, PROJECT, clientB);
  const inCurrent = (ch) => current.impacts.some((i) => i.change.id === ch.id);

  const rows = [];
  let ctorMisses = 0;
  let controlFails = 0;
  for (const c of CASES) {
    for (const [symbol, isCtor] of [
      [c.ctor, true],
      ['Session.refresh', false],
    ]) {
      const ch = changeOf(c.decl, symbol);
      if (!ch) {
        rows.push({ lang: c.lang, symbol, error: `no hub row for ${c.decl}#${symbol}; rows: ${changes.map((x) => `${x.file}#${x.symbol}`).join(', ')}` });
        if (isCtor) ctorMisses++;
        else controlFails++;
        continue;
      }
      const rel = await impact.relevant(ch, B, { root: wtB, claims: claimsB });
      const pre = await impact.editImpacts({ file: c.caller, text: routesText(c), keys: [c.callerKey], me: B, changes: [ch], acks: new Map() });
      // who_uses as the MCP tool / `hub uses` / post-edit call it; a throw is recorded (the post-edit hook swallows it).
      let who;
      let whoError = null;
      try {
        who = await impact.whoUses(wtA, { file: c.decl, symbol }, { me: A, claims: () => clientA.claims() });
      } catch (err) {
        whoError = String(err?.message ?? err);
        who = { name: null, sites: [], free: [], candidates: null };
      }
      const whoHit = who.sites.some((s) => s.file === c.caller && s.key === c.callerKey);
      const whoFreeOrHeld = who.sites.find((s) => s.file === c.caller && s.key === c.callerKey);
      const row = {
        lang: c.lang,
        change: `${c.decl}#${symbol}`,
        hub_name: ch.name,
        relevant: rel ? rel.sites.map((s) => `${s.file}#${s.keys.join(',')}`).join(' ') : null,
        impacts_tool: inCurrent(ch),
        pre_edit_note: pre.length ? pre.map((p) => p.keys.join(',')).join(' ') : null,
        who_uses_name: who.name,
        who_uses_sites: who.sites.map((s) => `${s.file}#${s.key}${s.holders.length ? ` (held by ${s.holders.map((h) => h.holder).join(',')})` : ''}`),
        who_uses_free: who.free.map((s) => `${s.file}#${s.key}`),
        who_uses_candidates: who.candidates,
        who_uses_threw: whoError,
        caller_held_by_B_reported: !!whoFreeOrHeld?.holders.some((h) => h.holder === B),
      };
      rows.push(row);
      const found = !!rel && row.impacts_tool && !!pre.length && whoHit;
      if (isCtor && !found) ctorMisses++;
      if (!isCtor && !found) controlFails++;
    }
  }

  for (const r of rows) console.log(JSON.stringify(r));
  console.log('');
  if (controlFails) {
    console.log(`HARNESS: ${controlFails} control (Session.refresh) case(s) did not reach the caller: setup problem, no verdict.`);
    exitCode = 2;
  } else if (ctorMisses) {
    console.log(`DEFECT PRESENT (R-26): ${ctorMisses}/${CASES.length} constructor change(s) never reach their caller.`);
    console.log('  The hub records name = last key segment (constructor / __init__); relevant(), the impacts tool, the pre-edit note');
    console.log('  and who_uses all match that name, which callers never spell (they write new Session(...) / Session(...)).');
    console.log('  The method change Session.refresh on the same files reaches the same callers (control passed).');
    exitCode = 1;
  } else {
    console.log('OK: every constructor change reaches its caller (defect not present).');
    exitCode = 0;
  }
} catch (err) {
  console.error('HARNESS ERROR:', err?.stack ?? err);
  exitCode = 2;
} finally {
  try {
    await hubServer?.close();
  } catch {}
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
