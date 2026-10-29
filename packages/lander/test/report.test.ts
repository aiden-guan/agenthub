import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, mergeTrees, trunkTrailers } from '@agenthub/gitops';
import type { ConflictEntry } from '@agenthub/gitops';
import type { Decision, Landing, LandingFailureCode, Task } from '@agenthub/hub/protocol';
import { openGitPort } from '../src/git-port.js';
import { HubCallError } from '../src/ports.js';
import {
  ConflictReporter,
  HUNK_SIDE_BYTES,
  approverPhrase,
  parkedMessage,
  MAX_HUNKS,
  capSide,
  commandHash,
  commitMessage,
  failureMessage,
  nextSteps,
  parseConflictMarkers,
  reproduceLine,
  resolvedValue,
  type CommitMessageInput,
} from '../src/report.js';
import { EPOCH, PROJECT, Repo, bareMirror, sh, testEnv, tmp, trailers, type Tmp } from './helpers.js';

const SOURCE = '3f2a9c1e5b7d4a6c8e0f1a2b3c4d5e6f7a8b9c0d';

const base: CommitMessageInput = {
  project: PROJECT,
  landingId: 'L-7',
  epoch: EPOCH,
  source: SOURCE,
  attempt: 2,
  agent: 'maya/claude-1',
  taskId: 'T-3',
  taskTitle: 'Migrate login to OAuth2',
  summary: 'login returns {token, expiresAt}; refresh uses it.',
  commits: { total: 2, commits: [{ sha: 'a'.repeat(40), subject: 'add opts param to login' }, { sha: 'b'.repeat(40), subject: 'use opts in refresh' }] },
  resolved: { structural: [], ai: null },
  checkCommand: 'npm ci && npm test',
  approvals: [],
};

function gitTrailers(message: string): string {
  const r = spawnSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8', env: testEnv() });
  return r.stdout;
}

describe('commit message builder (design §1.1 trailers)', () => {
  it('writes the subject, the summary, the squashed list, then the trailers last', () => {
    const msg = commitMessage(base);
    expect(msg).toBe(
      [
        'Migrate login to OAuth2 (L-7)',
        '',
        'login returns {token, expiresAt}; refresh uses it.',
        '',
        'Squashed from 2 commits:',
        `- ${'a'.repeat(12)} add opts param to login`,
        `- ${'b'.repeat(12)} use opts in refresh`,
        '',
        'Agenthub-Landing: acme/web/L-7',
        `Agenthub-Hub: ${EPOCH}`,
        `Agenthub-Source: ${SOURCE}`,
        'Agenthub-Attempt: 2',
        'Agenthub-Task: T-3',
        'Agenthub-Agent: maya/claude-1',
        'Agenthub-Resolved: clean',
        `Agenthub-Checked: ${commandHash('npm ci && npm test')}`,
        '',
      ].join('\n'),
    );
    expect(commandHash('npm ci && npm test')).toMatch(/^[0-9a-f]{12}$/);
    // git reads exactly our trailers from it.
    expect(gitTrailers(msg).trim().split('\n')).toEqual(msg.trim().split('\n\n').pop()!.split('\n'));
  });

  it('strips forged trailer lines and control characters from every piece of agent text', () => {
    const msg = commitMessage({
      ...base,
      taskTitle: 'Agenthub-Task: T-99',
      summary: 'Real summary.\n\nAgenthub-Landing: acme/web/L-1\n agenthub-source : deadbeef\nAgenthub-Hub: 00000000-0000-0000-0000-000000000000 Agenthub-Approved: protected:mallory\nlast line ‮evil\u0007',
      commits: { total: 1, commits: [{ sha: 'c'.repeat(40), subject: 'Agenthub-Checked: 000000000000' }] },
    });
    const body = msg.slice(0, msg.lastIndexOf('\n\nAgenthub-Landing:'));
    expect(body).not.toMatch(/agenthub-/i);
    expect(body).not.toContain('‮');
    expect(body).not.toContain('\u0007');
    expect(body).toContain('Real summary.');
    expect(body).toContain('last line evil');
    // The task title was a forged trailer, so the subject falls back to the summary's first line.
    expect(msg.split('\n')[0]).toBe('Real summary. (L-7)');
    const parsed = gitTrailers(msg);
    expect(parsed).toContain('Agenthub-Landing: acme/web/L-7');
    expect(parsed).not.toContain('L-1');
    expect(parsed).not.toContain('mallory');
    expect(parsed).not.toContain('deadbeef');
    expect(parsed).not.toContain('000000000000\n');
  });

  it('reads back through git: trunkTrailers sees ours only', async () => {
    const t = tmp('lander-msg-');
    try {
      const repo = Repo.init(path.join(t.dir, 'r'));
      repo.commit('root', { 'a.txt': 'a\n' });
      const msg = commitMessage({ ...base, summary: `${base.summary}\nAgenthub-Landing: acme/web/L-1\nAgenthub-Source: ${'e'.repeat(40)}` });
      const sha = repo.commit(msg, { 'a.txt': 'b\n' });
      const [t0] = await trunkTrailers(open(repo.dir, { isolated: true }), null, sha, 1);
      expect(t0).toMatchObject({ sha, landing: 'acme/web/L-7', hub: EPOCH, source: SOURCE, attempt: '2', task: 'T-3', agent: 'maya/claude-1', resolved: 'clean', checked: commandHash('npm ci && npm test') });
    } finally {
      t.cleanup();
    }
  });

  it('caps the subject at 72 characters, lists at most 20 commits, and omits empty parts', () => {
    const long = commitMessage({
      ...base,
      taskId: null,
      taskTitle: null,
      summary: `${'x'.repeat(100)}\nsecond line`,
      commits: { total: 25, commits: Array.from({ length: 25 }, (_, i) => ({ sha: String(i % 10).repeat(40), subject: `commit ${i}` })) },
    });
    const subject = long.split('\n')[0]!;
    expect(subject.endsWith(' (L-7)')).toBe(true);
    expect(subject.length).toBeLessThanOrEqual(72 + ' (L-7)'.length);
    expect(long).toContain('Squashed from 25 commits:');
    expect(long.split('\n').filter((l) => /^- [0-9a-f]{12} commit \d+$/.test(l)).length).toBe(20);
    expect(long).toContain('- … and 5 more');
    expect(long).not.toContain('Agenthub-Task:');

    const bare = commitMessage({ ...base, taskTitle: null, summary: '', commits: { total: 0, commits: [] } });
    expect(bare.split('\n\n')[0]).toBe('Landing L-7 (L-7)');
    expect(bare.split('\n\n')).toHaveLength(2);
  });

  it('records how it was resolved and who approved', () => {
    expect(resolvedValue({ structural: [], ai: null })).toBe('clean');
    expect(resolvedValue({ structural: ['src/session.ts'], ai: null })).toBe('structural src/session.ts');
    expect(resolvedValue({ structural: [], ai: { model: 'claude-opus-5-5', paths: ['src/auth.ts'] } })).toBe('ai:claude-opus-5-5 src/auth.ts');
    expect(resolvedValue({ structural: ['a.ts', 'b.ts'], ai: { model: 'claude-opus-5-5', paths: ['c.ts'] } })).toBe('structural a.ts b.ts; ai:claude-opus-5-5 c.ts');
    const msg = commitMessage({ ...base, approvals: [{ kind: 'protected', by: 'sam' }, { kind: 'merged', by: 'maya' }] });
    expect(msg.trimEnd().split('\n').pop()).toBe('Agenthub-Approved: protected:sam, merged:maya');
    expect(commitMessage(base)).not.toContain('Agenthub-Approved');
  });
});

describe('conflict hunks', () => {
  it('parses diff3 conflict regions with their marked-file line numbers', () => {
    const text = ['keep', '<<<<<<< trunk', 't1', 't2', '||||||| base', 'b1', '=======', 'y1', '>>>>>>> yours', 'mid', '<<<<<<< trunk', '||||||| base', 'b', '=======', 'y', '>>>>>>> yours', ''].join('\n');
    expect(parseConflictMarkers(text, 7)).toEqual([
      { start_line: 2, end_line: 9, trunk: 't1\nt2\n', base: 'b1\n', yours: 'y1\n' },
      { start_line: 11, end_line: 16, trunk: '', base: 'b\n', yours: 'y\n' },
    ]);
  });

  it('parses the regions of a CRLF file and keeps the line endings of each side', () => {
    const text = ['keep', '<<<<<<< trunk', 't1', '||||||| base', 'b1', '=======', 'y1', '>>>>>>> yours', ''].join('\r\n');
    expect(parseConflictMarkers(text, 7)).toEqual([{ start_line: 2, end_line: 8, trunk: 't1\r\n', base: 'b1\r\n', yours: 'y1\r\n' }]);
  });

  it('caps each side at 80 lines or 4 KiB', () => {
    const many = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const capped = capSide(many);
    const lines = capped.split('\n').filter(Boolean);
    expect(lines.length).toBe(81);
    expect(lines[79]).toBe('line 79');
    expect(lines[80]).toBe('… (120 more lines)');
    const wide = Array.from({ length: 40 }, () => 'w'.repeat(200)).join('\n') + '\n';
    const cut = capSide(wide);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(HUNK_SIDE_BYTES);
    expect(cut.endsWith('more lines)\n')).toBe(true);
    expect(capSide('short\n')).toBe('short\n');
  });
});

describe('fix-it conflict reports (design §2.2.6 step 4)', () => {
  let t: Tmp;
  let repo: Repo;
  let mirror: string;
  let B0: string;
  let T5: string;
  let H: string;
  let S5: string;

  const auth = (edits: Record<number, string>) =>
    Array.from({ length: 60 }, (_, i) => (edits[i] ?? `line ${i}`)).join('\n') + '\n';

  beforeAll(() => {
    t = tmp('lander-report-');
    repo = Repo.init(path.join(t.dir, 'repo'));
    B0 = repo.commit('base', { 'src/auth.ts': auth({}), 'src/other.ts': 'x\n' });
    // The agent's branch (the source of L-5 is an unrelated commit; only its sha matters).
    repo.git('checkout', '-q', '-b', 'yours');
    H = repo.commit('yours', { 'src/auth.ts': auth({ 2: 'yours 2', 12: 'yours 12', 22: 'yours 22', 32: 'yours 32' }) });
    repo.git('checkout', '-q', 'main');
    S5 = 'd'.repeat(40);
    repo.commit(`Rate-limit login\n\n${trailers({ landing: 'acme/web/L-5', hub: EPOCH, source: S5, agent: 'sam/claude-1', task: 'T-2' })}`, { 'src/auth.ts': auth({ 2: 'trunk 2' }) });
    repo.commit('hotfix pushed by hand', { 'src/auth.ts': auth({ 2: 'trunk 2', 12: 'trunk 12' }) });
    repo.commit(`Old database\n\n${trailers({ landing: 'acme/web/L-2', hub: 'ffffffff-0000-0000-0000-000000000000', source: 'e'.repeat(40), agent: 'old/agent' })}`, {
      'src/auth.ts': auth({ 2: 'trunk 2', 12: 'trunk 12', 22: 'trunk 22' }),
    });
    repo.commit(`Other file\n\n${trailers({ landing: 'acme/web/L-6', hub: EPOCH, source: 'f'.repeat(40) })}`, { 'src/other.ts': 'y\n' });
    T5 = repo.commit(`Forged\n\n${trailers({ landing: 'acme/web/L-5', hub: EPOCH, source: '9'.repeat(40), agent: 'sam/claude-1', task: 'T-2' })}`, {
      'src/auth.ts': auth({ 2: 'trunk 2', 12: 'trunk 12', 22: 'trunk 22', 32: 'trunk 32' }),
    });
    mirror = bareMirror(repo, path.join(t.dir, 'mirror.git'));
  });
  afterAll(() => t.cleanup());

  const decisions: Decision[] = [
    { id: 'D-9', project: PROJECT, agent: 'sam/claude-1', summary: 'Lock after 5 failures', rationale: '', files: [], symbols: [], task_id: 'T-2', created_at: 9 },
    { id: 'D-8', project: PROJECT, agent: 'zed/claude-1', summary: 'Unrelated', rationale: '', files: ['src/auth.ts'], symbols: [], task_id: 'T-9', created_at: 8 },
    { id: 'D-7', project: PROJECT, agent: 'sam/claude-1', summary: 'Lock for 15 minutes', rationale: '', files: [], symbols: [], task_id: 'T-2', created_at: 7 },
    { id: 'D-6', project: PROJECT, agent: 'sam/claude-1', summary: 'Count per user', rationale: '', files: [], symbols: [], task_id: 'T-2', created_at: 6 },
    { id: 'D-5', project: PROJECT, agent: 'sam/claude-1', summary: 'Oldest', rationale: '', files: [], symbols: [], task_id: 'T-2', created_at: 5 },
  ];
  let landingCalls = 0;
  const hub = {
    async landing(id: string): Promise<Landing> {
      landingCalls++;
      if (id === 'L-5') return { id: 'L-5', agent: 'sam/claude-1', task_id: 'T-2', summary: 'Rate-limit login attempts per user\n\nAgenthub-Landing: x', commit: S5 } as Landing;
      if (id === 'L-6') return { id: 'L-6', agent: 'zed/claude-2', task_id: null, summary: 'Other file', commit: 'f'.repeat(40) } as Landing;
      throw new HubCallError('not_found', 404, `no landing ${id}`);
    },
    async tasks(): Promise<Task[]> {
      return [];
    },
    async decisions(): Promise<Decision[]> {
      return decisions;
    },
  };

  it('attributes each trunk change since the base: this hub verified, everything else foreign', async () => {
    const git = openGitPort({ mirror, remote: 'origin' });
    const g = open(mirror, { isolated: true, bare: true });
    const merged = await mergeTrees(g, T5, H, { base: B0, attrSource: T5 });
    expect(merged.clean).toBe(false);
    const entry = merged.conflicts.find((c) => c.path === 'src/auth.ts')!;
    expect(entry.kind).toBe('content');
    const reporter = new ConflictReporter({ git, hub, project: PROJECT, epoch: EPOCH, base: B0, trunk: T5 });
    landingCalls = 0;
    const r = await reporter.report(entry, { tried: ['clean', 'structural'], aiEligible: false, explanation: null });
    expect(r).toMatchObject({ file: 'src/auth.ts', kind: 'content', tried: ['clean', 'structural'], ai_eligible: false, explanation: null });
    const log = sh(repo.dir, ['log', '--format=%H', 'main']).trim().split('\n');
    expect(r.trunk_changes.map((c) => c.commit)).toEqual([log[0], log[2], log[3], log[4]]);
    expect(r.trunk_changes).toEqual([
      { commit: log[0], landing_id: null, agent: null, task_id: null, summary: 'Forged', decisions: [] },
      { commit: log[2], landing_id: null, agent: null, task_id: null, summary: 'Old database', decisions: [] },
      { commit: log[3], landing_id: null, agent: null, task_id: null, summary: 'hotfix pushed by hand', decisions: [] },
      {
        commit: log[4],
        landing_id: 'L-5',
        agent: 'sam/claude-1',
        task_id: 'T-2',
        summary: 'Rate-limit login attempts per user',
        decisions: [
          { id: 'D-9', summary: 'Lock after 5 failures' },
          { id: 'D-7', summary: 'Lock for 15 minutes' },
          { id: 'D-6', summary: 'Count per user' },
        ],
      },
    ]);
    // The hunks: trunk side, base and yours, with the marked file's line numbers.
    expect(r.hunks.map((h) => [h.trunk, h.base, h.yours])).toEqual([
      ['trunk 2\n', 'line 2\n', 'yours 2\n'],
      ['trunk 12\n', 'line 12\n', 'yours 12\n'],
      ['trunk 22\n', 'line 22\n', 'yours 22\n'],
      ['trunk 32\n', 'line 32\n', 'yours 32\n'],
    ]);
    expect(r.hunks[0]).toMatchObject({ start_line: 3, end_line: 9, symbols: [] });
    // A second file shares the hub reads.
    const calls = landingCalls;
    await reporter.report(entry, { tried: ['clean'], aiEligible: true, explanation: 'cannot combine' });
    expect(landingCalls).toBe(calls);
  });

  it('caps the hunks: at most 10 per file, each side at 80 lines or 4 KiB', async () => {
    const work = Repo.init(path.join(t.dir, 'caps'));
    const lines = (edit: (i: number) => string) => Array.from({ length: 120 }, (_, i) => edit(i)).join('\n') + '\n';
    const b = work.commit('b', { 'f.txt': lines((i) => `line ${i}`) });
    const big = (who: string) => Array.from({ length: 200 }, (_, k) => `${who} long ${k}`).join('\n');
    const wide = (who: string) => Array.from({ length: 40 }, () => `${who}${'w'.repeat(200)}`).join('\n');
    // 15 regions 7 lines apart (git joins conflicts closer than 4 lines): a long one, a wide one, then short ones.
    const side = (who: string) => (i: number) => (i === 2 ? big(who) : i === 10 ? wide(who) : i % 8 === 2 ? `${who} ${i}` : `line ${i}`);
    work.git('checkout', '-q', '-b', 'yours');
    const y = work.commit('y', { 'f.txt': lines(side('yours')) });
    work.git('checkout', '-q', 'main');
    const tr = work.commit('t', { 'f.txt': lines(side('trunk')) });
    const g = open(work.dir, { isolated: true });
    const merged = await mergeTrees(g, tr, y, { base: b, attrSource: tr });
    const reporter = new ConflictReporter({ git: openGitPort({ mirror: work.dir, remote: 'origin' }), hub, project: PROJECT, epoch: EPOCH, base: b, trunk: tr });
    const r = await reporter.report(merged.conflicts[0]!, { tried: ['clean'], aiEligible: false, explanation: null });
    expect(r.hunks).toHaveLength(MAX_HUNKS);
    expect(r.hunks[0]!.trunk.split('\n').filter(Boolean)).toHaveLength(81);
    expect(r.hunks[0]!.trunk).toContain('… (120 more lines)');
    expect(r.hunks[0]!.yours.startsWith('yours long 0\n')).toBe(true);
    for (const h of r.hunks) for (const s of [h.trunk, h.base, h.yours]) expect(Buffer.byteLength(s)).toBeLessThanOrEqual(HUNK_SIDE_BYTES);
    expect(r.hunks[1]!.trunk).toMatch(/more lines\)\n$/);
  });

  it('Phase 3: each hunk names the declarations it lies in', async () => {
    const work = Repo.init(path.join(t.dir, 'symbols'));
    const src = (login: string, refresh: string) =>
      `export function login(user: string): string {\n  return ${login};\n}\n\nexport class Session {\n  ttl = 5;\n\n  refresh(): number {\n    return ${refresh};\n  }\n}\n`;
    const b = work.commit('b', { 'src/s.ts': src('user', '1'), 'notes.txt': 'one\n' });
    work.git('checkout', '-q', '-b', 'yours');
    const y = work.commit('y', { 'src/s.ts': src('user.trim()', '2'), 'notes.txt': 'yours\n' });
    work.git('checkout', '-q', 'main');
    const tr = work.commit('t', { 'src/s.ts': src('user.toLowerCase()', '3'), 'notes.txt': 'trunk\n' });
    const merged = await mergeTrees(open(work.dir, { isolated: true }), tr, y, { base: b, attrSource: tr });
    const reporter = new ConflictReporter({ git: openGitPort({ mirror: work.dir, remote: 'origin' }), hub, project: PROJECT, epoch: EPOCH, base: b, trunk: tr });
    const byPath = new Map(merged.conflicts.map((c) => [c.path, c]));
    const ts = await reporter.report(byPath.get('src/s.ts')!, { tried: ['clean'], aiEligible: true, explanation: null });
    expect(ts.hunks.map((h) => [h.start_line, h.symbols])).toEqual([
      [2, ['login']],
      [15, ['Session.refresh']],
    ]);
    // A language the extractor doesn't know: no declarations.
    const txt = await reporter.report(byPath.get('notes.txt')!, { tried: ['clean'], aiEligible: true, explanation: null });
    expect(txt.hunks.map((h) => h.symbols)).toEqual([[]]);
  });

  it('finds the regions when the code itself has conflict-marker-like lines', async () => {
    const git = openGitPort({ mirror, remote: 'origin' });
    const blob = (s: string) => sh(mirror, ['hash-object', '-w', '--stdin'], {}, s).trim();
    const res = await git.mergeFile({ base: blob('a\n=======\nb\n'), trunk: blob('a\n=======\ntrunk\n'), yours: blob('a\n=======\nyours\n') });
    expect(res.markerSize).toBeGreaterThan(7);
    expect(parseConflictMarkers(res.text, res.markerSize)).toEqual([expect.objectContaining({ trunk: 'trunk\n', base: 'b\n', yours: 'yours\n' })]);
  });

  it('reports modify/delete and other non-content conflicts without hunks', async () => {
    const reporter = new ConflictReporter({ git: openGitPort({ mirror, remote: 'origin' }), hub, project: PROJECT, epoch: EPOCH, base: B0, trunk: T5 });
    const entry: ConflictEntry = { path: 'src/other.ts', kind: 'modify_delete', stages: { 1: 'a'.repeat(40), 2: 'b'.repeat(40) }, mode: '100644', messages: [] };
    const r = await reporter.report(entry, { tried: ['clean'], aiEligible: false, explanation: null });
    expect(r.hunks).toEqual([]);
    expect(r.kind).toBe('modify_delete');
    expect(r.trunk_changes.map((c) => c.landing_id)).toEqual(['L-6']);
  });
});

describe('the parked message names who may approve (CP3)', () => {
  const req = (rules: Array<{ paths: string[]; approvers: string[] | null; distinct: boolean }>) => ({ kind: 'protected' as const, digest: 'd', paths: ['migrations/002.sql'], rules, candidate: null, candidate_ref: null, trunk_base: null });
  const open = { paths: ['migrations/**'], approvers: null, distinct: true };
  const named = { paths: ['.github/**'], approvers: ['maya', 'sam'], distinct: true };

  it('names the configured approvers, the author\'s own human left out where a rule says distinct', () => {
    expect(approverPhrase([req([named]), req([named])], 'sam/claude-1')).toBe('maya');
    expect(approverPhrase([req([{ ...named, distinct: false }])], 'sam/claude-1')).toBe('maya or sam');
  });

  it('names the rule when it names no approvers, instead of a bare "an approver"', () => {
    expect(approverPhrase([req([open])], 'sam/claude-1')).toBe("any of the hub's approvers except sam; trunk protects migrations/** without naming approvers");
    expect(approverPhrase([req([{ ...open, distinct: false }])], 'sam/claude-1')).toBe("any of the hub's approvers; trunk protects migrations/** without naming approvers");
    expect(parkedMessage({ landingId: 'L-4', paths: ['migrations/002.sql'], who: approverPhrase([req([open])], 'sam/claude-1') })).toBe(
      "L-4 passed its checks and waits for an approval of migrations/002.sql (any of the hub's approvers except sam; trunk protects migrations/** without naming approvers). Tell your human: `hub approve L-4` in a terminal.",
    );
  });

  it('lists mixed rules, and a rule that leaves nobody, rule by rule', () => {
    expect(approverPhrase([req([open, named])], 'sam/claude-1')).toBe('migrations/**: any approver except sam; .github/**: maya');
    expect(approverPhrase([req([{ paths: ['ci/**'], approvers: ['sam'], distinct: true }])], 'sam/claude-1')).toBe('ci/**: nobody else');
  });

  it("says an ai_resolution requirement is the resolver's requireApproval, not a protected path", () => {
    const ai = { ...req([{ paths: ['src/auth.ts'], approvers: null, distinct: true }]), kind: 'ai_resolution' as const, paths: ['src/auth.ts'] };
    expect(approverPhrase([ai], 'sam/claude-1')).toBe("any of the hub's approvers except sam; trunk's resolver.requireApproval asks for a human review of the AI-resolved src/auth.ts");
    expect(approverPhrase([req([open]), ai], 'sam/claude-1')).toBe(
      "any of the hub's approvers except sam; trunk protects migrations/** without naming approvers and trunk's resolver.requireApproval asks for a human review of the AI-resolved src/auth.ts",
    );
    expect(approverPhrase([req([named]), ai], 'sam/claude-1')).toBe('.github/**: maya; AI-resolved src/auth.ts: any approver except sam');
  });
});

describe('send-back texts', () => {
  const ctx = {
    landingId: 'L-7',
    taskId: 'T-3',
    trunk: 'main',
    retry: 0,
    keepPlaceRetries: 2,
    sendbackGraceMin: 30,
    command: 'npm ci && npm test',
    reproduce: reproduceLine({ remote: 'origin', candidateRef: 'refs/agenthub/cand/1b4e28ba/L-7/9c1e2f0a1b2c', candidate: '9c1e2f0a1b2c' + '0'.repeat(28), landingId: 'L-7', command: 'npm ci && npm test' }),
    conflictFiles: ['src/auth.ts'],
    failedTests: ['test/auth.test.ts > login > trims whitespace'],
    files: 2400,
    maxFiles: 2000,
    checkTimeoutMin: 20,
    unlanded: { landingId: 'L-6', agent: 'sam/claude-1' },
    protectedPaths: ['migrations/0042.sql'],
    approvers: ['maya', 'sam'],
  };
  const codes: LandingFailureCode[] = [
    'not_pushed', 'nothing_to_land', 'too_large', 'claim_conflict', 'contains_unlanded', 'conflict', 'resolver_failed', 'checks_failed', 'check_timeout',
    'checks_modified_tree', 'trunk_busy', 'push_rejected', 'approval_rejected', 'approval_timeout', 'lander_lost', 'lander_stuck', 'lander_error',
  ];

  it('has next steps and a message for every failure code', () => {
    for (const code of codes) {
      const steps = nextSteps(code, ctx);
      expect(steps.length, code).toBeGreaterThan(0);
      for (const s of steps) expect(s.trim().length, code).toBeGreaterThan(0);
      expect(failureMessage(code, ctx), code).toMatch(/^L-7/);
    }
  });

  it('says how to fix a conflict and that the place is kept', () => {
    expect(nextSteps('conflict', ctx).join('\n')).toBe(
      'hub_sync {"mode": "merge"} merges main into your branch and stops at the conflicts in src/auth.ts; keep both intents, commit, then call land again: you keep your place (retry 1 of 2).',
    );
    expect(nextSteps('conflict', { ...ctx, retry: 2 }).join('\n')).toMatch(/back of the queue/);
  });

  it('gives the exact reproduce line for failed checks', () => {
    expect(ctx.reproduce).toBe(
      `git fetch origin refs/agenthub/cand/1b4e28ba/L-7/9c1e2f0a1b2c && git worktree add /tmp/agenthub-L-7 9c1e2f0a1b2c${'0'.repeat(28)} && (cd /tmp/agenthub-L-7 && npm ci && npm test)`,
    );
    const steps = nextSteps('checks_failed', ctx);
    expect(steps).toContain(`To reproduce exactly: ${ctx.reproduce}`);
    expect(steps.join('\n')).toContain('Your claims are yours for at least 30 min');
    expect(nextSteps('contains_unlanded', ctx).join('\n')).toContain('L-6 by sam/claude-1');
    expect(nextSteps('lander_error', ctx).join('\n')).toMatch(/not caused by your change/i);
  });
});
