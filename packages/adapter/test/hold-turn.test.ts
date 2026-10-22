import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Landing } from '@agenthub/hub/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubClient } from '../src/client.js';
import { holdTurnReason } from '../src/format.js';
import { A, B, downUrl, fakeHub, git, hubCli, sessionEventInput, testEnv, type SessionEvent } from './helpers.js';
import { PROJECT, TEAM_CONFIG, TestLander, commit, makeLandingRepo, report, startLandingHub, type LandingHub, type LandingRepo } from './landing-hub.js';

// Step A6 (design §2.3.6, the settle row): the opt-in Stop-hook hold. With
// trunk's land.holdTurn on, a Stop while the agent has a live, non-parked
// landing that hasn't held it before (marker G/agenthub/held/<landing>), and
// stop_hook_active false, keeps the agent in its turn once with
// {"decision":"block"}; at most once per landing, never twice in a row. The
// real hub behind its real server; the lander's side is played over HTTP.

const HOLD_CONFIG = { ...TEAM_CONFIG, land: { ...TEAM_CONFIG.land, holdTurn: true } };
const quiet = { code: 0, stdout: '', stderr: '' };

let hub: LandingHub;
let repo: LandingRepo;
let lander: TestLander;

beforeEach(async () => {
  hub = await startLandingHub();
  lander = new TestLander(hub.url);
  await lander.takeLease();
});
afterEach(async () => {
  await hub.close();
  repo?.cleanup();
});

const hubClient = (agent: string) => new HubClient({ url: hub.url, project: PROJECT, agent, token: null, timeoutMs: 5000 });
const envFor = (agent: string, url = hub.url, extra: Record<string, string> = {}) => testEnv({ HUB_URL: url, HUB_PROJECT: PROJECT, HUB_AGENT: agent, ...extra });

/** A settle hook event for agent A in its clone, as Claude Code sends it; `active` is the Stop's stop_hook_active. */
function settle(event: SessionEvent, o: { session?: string; active?: boolean; agent?: string; url?: string; wt?: string; env?: Record<string, string> } = {}) {
  const wt = o.wt ?? repo.a;
  const input = JSON.parse(sessionEventInput(wt, event, o.session ?? 'sess-a'));
  if (o.active !== undefined) input.stop_hook_active = o.active;
  return hubCli(['hook', 'settle'], { cwd: wt, env: envFor(o.agent ?? A, o.url, o.env), input: JSON.stringify(input) });
}

const blockFor = (l: string, task: string | null, state: string) => ({
  code: 0,
  stdout: `${JSON.stringify({
    decision: 'block',
    reason: `Your landing ${l}${task ? ` for ${task}` : ''} is still in the queue (${state}). Call hub_wait {"landing_id":"${l}"} and stay until it lands or comes back, so you can fix it with the context you have now.`,
  })}\n`,
  stderr: '',
});

const heldDir = (wt = repo.a) => path.join(wt, '.git', 'agenthub', 'held');
const held = (wt = repo.a) => (existsSync(heldDir(wt)) ? readdirSync(heldDir(wt)).sort() : []);
/** The session's row marker: its last Stop was held. */
const inRow = (session: string, wt = repo.a) => existsSync(path.join(wt, '.git', 'agenthub', 'held-row', session));

/** A task taken by `agent`. */
async function task(agent: string, title: string): Promise<string> {
  const c = hubClient(agent);
  const t = await c.createTask({ title });
  await c.takeTask(t.id);
  return t.id;
}

/** Commit in `wt` and queue it as `agent` (POST /land {queue: true}); the landing's id. */
async function submit(agent: string, wt: string, file: string, taskId?: string): Promise<string> {
  const head = commit(wt, { [file]: `// ${file} changed by ${agent} at ${Math.random()}\n` });
  const res = await hubClient(agent).land({ queue: true, commit: head, files: [file], task_id: taskId, summary: `change ${file}` });
  return res.landing.id;
}

const base = () => git(repo.remote, 'rev-parse', 'main').trim();

/** Admit L, pick it and move it to `phase`. */
async function run(id: string, phase: 'merging' | 'checking'): Promise<number> {
  await lander.admit(id, { base_sha: base(), files: [] });
  const next = await lander.next();
  expect(next.landing?.id).toBe(id);
  const attempt = next.landing.attempt;
  await lander.advance(id, { attempt, to: 'running', phase: 'merging', deadline_ms: 600_000, trunk_base: base() });
  if (phase === 'checking') await lander.advance(id, { attempt, to: 'running', phase: 'checking', deadline_ms: 600_000 });
  return attempt;
}

describe('the Stop-hook hold (land.holdTurn)', () => {
  it('a Stop with a live landing and stop_hook_active false gives the block JSON exactly once', async () => {
    repo = makeLandingRepo(HOLD_CONFIG);
    const t = await task(A, 'Migrate login to OAuth2');
    const id = await submit(A, repo.a, 'src/users.ts', t);
    expect(id).toBe('L-1');

    expect(await settle('Stop')).toEqual(blockFor('L-1', t, 'waiting for admission'));
    expect(held()).toEqual(['L-1']);
    const marker = JSON.parse(readFileSync(path.join(heldDir(), 'L-1'), 'utf8'));
    expect(marker).toMatchObject({ landing: 'L-1', project: PROJECT, created_at: hub.hub.getLanding(PROJECT, 'L-1').created_at, session: 'sess-a' });

    // The Stop that ends the turn it was kept in: nothing, whatever stop_hook_active says.
    expect(await settle('Stop')).toEqual(quiet);
    // A second Stop for the same landing, in a later turn and another phase: nothing.
    expect(await settle('UserPromptSubmit')).toEqual(quiet);
    await run('L-1', 'checking');
    expect(await settle('Stop')).toEqual(quiet);
    expect(await settle('Stop', { session: 'sess-other' })).toEqual(quiet); // once per landing, not per session
    expect(held()).toEqual(['L-1']);
  });

  it('stop_hook_active true gives nothing, and leaves the hold for a later Stop', async () => {
    repo = makeLandingRepo(HOLD_CONFIG);
    await submit(A, repo.a, 'src/users.ts');
    await run('L-1', 'checking');

    expect(await settle('Stop', { active: true })).toEqual(quiet);
    expect(held()).toEqual([]);
    expect(await settle('Stop', { active: false })).toEqual(blockFor('L-1', null, 'checking'));
  });

  it('a second Stop for the same landing gives nothing', async () => {
    repo = makeLandingRepo(HOLD_CONFIG);
    const t = await task(A, 'Trim user names');
    await submit(A, repo.a, 'src/users.ts', t);
    await lander.admit('L-1', { base_sha: base(), files: ['src/users.ts'] });
    const position = hub.hub.getLanding(PROJECT, 'L-1').position;
    expect(position).toBe(1);

    expect(await settle('Stop')).toEqual(blockFor('L-1', t, 'queued, position 1'));
    for (let i = 0; i < 3; i++) {
      expect(await settle('UserPromptSubmit')).toEqual(quiet);
      expect(await settle('Stop')).toEqual(quiet);
    }
  });

  it('holdTurn false gives nothing, and only trunk\'s agenthub.json turns it on', async () => {
    repo = makeLandingRepo(TEAM_CONFIG); // no holdTurn: the default, false
    await submit(A, repo.a, 'src/users.ts');
    expect(await settle('Stop')).toEqual(quiet);

    // The branch's own copy says true, committed and in the worktree: trunk's copy decides, and it says nothing.
    commit(repo.a, { 'agenthub.json': `${JSON.stringify(HOLD_CONFIG, null, 2)}\n` });
    expect(await settle('Stop')).toEqual(quiet);
    expect(held()).toEqual([]);

    // Once trunk has it (fetched), the same landing holds.
    const other = path.join(repo.dir, 'trunk-wt');
    git(repo.dir, 'clone', '-q', repo.remote, other);
    commit(other, { 'agenthub.json': `${JSON.stringify(HOLD_CONFIG, null, 2)}\n` }, 'hold turns');
    git(other, 'push', '-q', 'origin', 'main');
    git(repo.a, 'fetch', '-q', 'origin');
    expect(await settle('Stop')).toEqual(blockFor('L-1', null, 'waiting for admission'));
  });

  it('a parked or terminal landing gives nothing, nor does another agent\'s live landing', async () => {
    repo = makeLandingRepo(HOLD_CONFIG);
    // L-1 parked: its checks passed and it waits for an approval.
    await submit(A, repo.a, 'migrations/0002.sql');
    const requirement = {
      kind: 'protected',
      digest: 'd'.repeat(64),
      paths: ['migrations/0002.sql'],
      rules: [{ paths: ['migrations/**'], approvers: ['maya', 'sam'], distinct: true }],
      candidate: null,
      candidate_ref: null,
      trunk_base: null,
    };
    await lander.admit('L-1', { base_sha: base(), files: ['migrations/0002.sql'], protected: ['migrations/0002.sql'], required: [requirement] });
    const next = await lander.next();
    const attempt = next.landing.attempt;
    await lander.advance('L-1', { attempt, to: 'running', phase: 'merging', deadline_ms: 600_000, trunk_base: base() });
    const check = { command_hash: '0'.repeat(12), exit_code: 0, signal: null, timed_out: false, duration_ms: 1000, log_tail: '', failed_tests: [], passes_on_trunk: true, reproduce: '' };
    const head = git(repo.a, 'rev-parse', 'HEAD').trim();
    await lander.advance('L-1', { attempt, to: 'needs_approval', required: [requirement], report: report({ check }), candidate: head, candidate_ref: `refs/agenthub/cand/00000000/L-1/${head.slice(0, 12)}` });
    expect(hub.hub.getLanding(PROJECT, 'L-1').status).toBe('needs_approval');
    expect(await settle('Stop')).toEqual(quiet);

    // L-2 failed, L-3 cancelled, L-4 landed.
    const t2 = await task(A, 'two');
    await submit(A, repo.a, 'src/two.ts', t2);
    await lander.failIt('L-2', { base: base(), trunkBase: base(), files: ['src/two.ts'], code: 'checks_failed', report: { message: 'L-2 came back.' } });
    const t3 = await task(A, 'three');
    await submit(A, repo.a, 'src/three.ts', t3);
    await hubClient(A).cancel('L-3', { reason: 'not needed' });
    const t4 = await task(A, 'four');
    await submit(A, repo.a, 'src/four.ts', t4);
    await lander.landIt('L-4', { base: base(), trunkBase: base(), candidate: git(repo.a, 'rev-parse', 'HEAD').trim(), files: ['src/four.ts'] });
    expect(['L-2', 'L-3', 'L-4'].map((id) => hub.hub.getLanding(PROJECT, id).status)).toEqual(['failed', 'cancelled', 'landed']);
    expect(await settle('Stop')).toEqual(quiet);

    // Another agent's live landing is not A's to wait for.
    await submit(B, repo.b, 'src/users.ts');
    expect(hub.hub.getLanding(PROJECT, 'L-5')).toMatchObject({ agent: B, status: 'submitted' });
    expect(await settle('Stop')).toEqual(quiet);
    expect(held()).toEqual([]);
    // B's own Stop holds B for it.
    expect(await settle('Stop', { agent: B, wt: repo.b, session: 'sess-b' })).toEqual(blockFor('L-5', null, 'waiting for admission'));
    expect(held(repo.b)).toEqual(['L-5']);
  });

  it('never twice in a row: with two live landings the running one holds first, the next Stop passes, then the other holds', async () => {
    repo = makeLandingRepo(HOLD_CONFIG);
    const t1 = await task(A, 'one');
    await submit(A, repo.a, 'src/one.ts', t1); // L-1, waits for admission
    const t2 = await task(A, 'two');
    await submit(A, repo.a, 'src/two.ts', t2); // L-2, running
    await run('L-2', 'checking');

    expect(await settle('Stop')).toEqual(blockFor('L-2', t2, 'checking'));
    // A host that doesn't set stop_hook_active: the Stop right after a hold passes all the same.
    expect(await settle('Stop', { active: false })).toEqual(quiet);
    expect(held()).toEqual(['L-2']);
    expect(await settle('Stop')).toEqual(blockFor('L-1', t1, 'waiting for admission'));
    expect(await settle('Stop')).toEqual(quiet);
    expect(await settle('Stop')).toEqual(quiet);
    expect(held()).toEqual(['L-1', 'L-2']);
  });

  it("a new prompt ends the row; each session has its own row; SubagentStop never holds", async () => {
    repo = makeLandingRepo(HOLD_CONFIG);
    await submit(A, repo.a, 'src/one.ts');
    await submit(A, repo.a, 'src/two.ts');
    expect(await settle('SubagentStop')).toEqual(quiet);
    expect(held()).toEqual([]);

    expect(await settle('Stop')).toEqual(blockFor('L-1', null, 'waiting for admission'));
    // Another session in the same checkout isn't in sess-a's row.
    await submit(A, repo.a, 'src/three.ts');
    expect(await settle('Stop', { session: 'sess-other' })).toEqual(blockFor('L-2', null, 'waiting for admission'));
    // The user's prompt starts a new turn: the next Stop may hold again (for a landing that hasn't held).
    expect(await settle('UserPromptSubmit')).toEqual(quiet);
    expect(await settle('Stop')).toEqual(blockFor('L-3', null, 'waiting for admission'));
    expect(held()).toEqual(['L-1', 'L-2', 'L-3']);
    // The session's end ends its row too.
    expect([inRow('sess-a'), inRow('sess-other')]).toEqual([true, true]);
    expect(await settle('SessionEnd')).toEqual(quiet);
    expect([inRow('sess-a'), inRow('sess-other')]).toEqual([false, true]);
  });

  it('a marker from another hub database (the same id, another landing) does not count; an unreachable hub holds nothing', async () => {
    repo = makeLandingRepo(HOLD_CONFIG);
    await submit(A, repo.a, 'src/users.ts');
    // L-1 of a database the hub no longer has (ids start over on a new one).
    mkdirSync(heldDir(), { recursive: true });
    writeFileSync(path.join(heldDir(), 'L-1'), JSON.stringify({ v: 1, landing: 'L-1', project: PROJECT, created_at: 1, session: 'old', at: 1 }));
    expect(await settle('Stop')).toEqual(blockFor('L-1', null, 'waiting for admission'));
    expect(JSON.parse(readFileSync(path.join(heldDir(), 'L-1'), 'utf8')).created_at).toBe(hub.hub.getLanding(PROJECT, 'L-1').created_at);

    await submit(A, repo.a, 'src/two.ts');
    expect(await settle('UserPromptSubmit')).toEqual(quiet); // a new turn: the row is over
    expect(await settle('Stop', { url: await downUrl() })).toEqual(quiet);
    // A hub that never answers: no hold, within the hold's own bound (not HUB_TIMEOUT_MS).
    const silent = await fakeHub(() => {});
    try {
      const started = Date.now();
      expect(await settle('Stop', { url: silent.url, env: { HUB_TIMEOUT_MS: '30000' } })).toEqual(quiet);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      await silent.close();
    }
    expect(held()).toEqual(['L-1']);
    expect(inRow('sess-a')).toBe(false);
    // Back on the hub, L-2 holds once.
    expect(await settle('Stop')).toEqual(blockFor('L-2', null, 'waiting for admission'));
  });
});

describe('holdTurnReason', () => {
  const landing = (o: Partial<Landing>): Landing => ({ id: 'L-7', task_id: 'T-3', status: 'running', phase: 'checking', position: null, in_doubt: false, ...o }) as Landing;

  it('names the landing, its task and where it is', () => {
    const say = (o: Partial<Landing>) => holdTurnReason(landing(o));
    expect(say({})).toBe(
      'Your landing L-7 for T-3 is still in the queue (checking). Call hub_wait {"landing_id":"L-7"} and stay until it lands or comes back, so you can fix it with the context you have now.',
    );
    expect(say({ phase: 'merging' })).toMatch(/^Your landing L-7 for T-3 is still in the queue \(merging\)\. /);
    expect(say({ phase: 'pushing', in_doubt: true })).toMatch(/\(pushing\)\. /);
    expect(say({ phase: null })).toMatch(/\(running\)\. /);
    expect(say({ status: 'queued', phase: null, position: 2 })).toMatch(/\(queued, position 2\)\. /);
    expect(say({ status: 'queued', phase: null, position: null })).toMatch(/\(queued\)\. /);
    expect(say({ status: 'submitted', phase: null, task_id: null })).toMatch(/^Your landing L-7 is still in the queue \(waiting for admission\)\. /);
  });
});
