import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_URL, loadConfig } from '../src/config.js';
import { stagedPaths, toRepoPath } from '../src/git.js';
import { git } from './helpers.js';

// realpath: on macOS the temp dir lives behind the /var -> /private/var symlink
const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'agenthub-config-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function repo(name: string, files: Record<string, unknown>): string {
  const root = path.join(dir, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const [f, v] of Object.entries(files)) writeFileSync(path.join(root, f), JSON.stringify(v));
  return root;
}

const noGlobal = { HUB_CONFIG: path.join(dir, 'none.json') };

describe('config', () => {
  it('layers global < committed agenthub.json < local .hub.json < env, and never takes identity or secrets from the committed file', () => {
    const global = path.join(dir, 'global.json');
    writeFileSync(global, JSON.stringify({ url: 'http://global:1', token: 'global-token' }));
    const root = repo('layers', {
      'agenthub.json': { project: 'team/app', url: 'http://team:2', agent: 'evil/agent', token: 'leaked' },
      '.hub.json': { agent: 'maya/claude-1' },
    });
    const cfg = loadConfig({ cwd: path.join(root, 'src'), env: { HUB_CONFIG: global } });
    // The global token is for http://global:1, not for the hub the committed file names.
    expect(cfg).toMatchObject({ project: 'team/app', url: 'http://team:2', agent: 'maya/claude-1', token: null, root });
    expect(cfg.configFiles).toEqual([global, path.join(root, 'agenthub.json'), path.join(root, '.hub.json')]);

    const env = loadConfig({ cwd: root, env: { HUB_CONFIG: global, HUB_AGENT: 'sam/codex-1', HUB_URL: 'http://env:3/', HUB_PROJECT: 'p' } });
    expect(env).toMatchObject({ agent: 'sam/codex-1', url: 'http://env:3', project: 'p' });
  });

  it('ignores an agent id that only the committed file provides', () => {
    const root = repo('team-only', { 'agenthub.json': { project: 'x', agent: 'maya/claude-1' } });
    expect(loadConfig({ cwd: root, env: noGlobal }).agent).toBeNull();
  });

  it('takes nothing from a "__proto__" key in a config file (the committed one cannot smuggle in an identity or token that way)', () => {
    const root = repo('proto', {});
    writeFileSync(path.join(root, 'agenthub.json'), '{"project":"demo","__proto__":{"agent":"maya/claude-1","token":"committed-token","url":"http://evil:1"}}');
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ project: 'demo', agent: null, token: null, url: DEFAULT_URL });
    writeFileSync(path.join(root, '.hub.json'), '{"__proto__":{"failClosed":"yes"},"agent":"sam/claude-1"}');
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ agent: 'sam/claude-1', token: null, failClosed: false });
  });

  it('sends a token set together with a url (in one file, or HUB_TOKEN with HUB_URL) only to that hub', () => {
    const global = path.join(dir, 'global-company.json');
    writeFileSync(global, JSON.stringify({ url: 'https://hub.company', token: 'COMPANY-SECRET' }));
    const root = repo('other-hub', { 'agenthub.json': { project: 'oss/proj', url: 'http://oss-hub:7077' }, '.hub.json': { agent: 'maya/claude-1' } });
    const cfg = loadConfig({ cwd: root, env: { HUB_CONFIG: global } });
    expect(cfg).toMatchObject({ url: 'http://oss-hub:7077', token: null });
    expect(cfg.warnings).toEqual([cfg.tokenWithheld]);
    expect(cfg.tokenWithheld).toMatch(
      /^the hub token in .*global-company\.json is not sent to http:\/\/oss-hub:7077: it is for https:\/\/hub\.company\. If http:\/\/oss-hub:7077 is your team's hub, put its token in this worktree's \.hub\.json\.$/,
    );
    expect(loadConfig({ cwd: root, env: { HUB_CONFIG: global, HUB_URL: 'http://oss-hub:7077' } })).toMatchObject({ token: null });
    expect(loadConfig({ cwd: root, env: { HUB_CONFIG: global, HUB_URL: 'http://oss-hub:7077', HUB_TOKEN: 'OSS' } })).toMatchObject({ token: 'OSS', warnings: [] });
    // The same hub, however it is spelled.
    writeFileSync(path.join(root, 'agenthub.json'), JSON.stringify({ project: 'oss/proj', url: 'https://Hub.Company:443/' }));
    expect(loadConfig({ cwd: root, env: { HUB_CONFIG: global } })).toMatchObject({ token: 'COMPANY-SECRET', warnings: [] });
  });

  it('sends a token set without a url only to a hub this machine chose, not to one that only a changed agenthub.json names', () => {
    const root = path.join(dir, 'pr-branch');
    mkdirSync(root);
    git(root, 'init', '-q');
    git(root, 'config', 'agenthub.url', 'https://hub.company'); // recorded by hub init
    writeFileSync(path.join(root, '.hub.json'), JSON.stringify({ agent: 'maya/claude-1', token: 'LOCAL-SECRET' }));
    const team = (url: string) => writeFileSync(path.join(root, 'agenthub.json'), JSON.stringify({ project: 'co/app', url }));
    team('https://hub.company');
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ url: 'https://hub.company', token: 'LOCAL-SECRET', warnings: [] });
    // HUB_TOKEN without HUB_URL is not for a hub only the repository names: this worktree's own token goes instead.
    expect(loadConfig({ cwd: root, env: { ...noGlobal, HUB_TOKEN: 'ENV-SECRET' } })).toMatchObject({ token: 'LOCAL-SECRET', warnings: [] });

    team('http://attacker:8080'); // a checked-out branch points the committed file at another hub
    const cfg = loadConfig({ cwd: root, env: noGlobal });
    expect(cfg).toMatchObject({ url: 'http://attacker:8080', token: null });
    expect(cfg.warnings).toEqual([cfg.tokenWithheld]);
    expect(cfg.tokenWithheld).toBe(
      "the hub token in this worktree's .hub.json is not sent to http://attacker:8080: only the committed agenthub.json names that hub, " +
        "but the repository's git config (agenthub.url) names https://hub.company. If http://attacker:8080 is your team's hub now, run `hub init --url http://attacker:8080` here.",
    );
    expect(loadConfig({ cwd: root, env: { ...noGlobal, HUB_TOKEN: 'ENV-SECRET' } })).toMatchObject({ token: null, tokenWithheld: expect.stringMatching(/^HUB_TOKEN is not sent/) });
    // Chosen on this machine: the token goes there.
    expect(loadConfig({ cwd: root, env: { ...noGlobal, HUB_URL: 'http://attacker:8080' } })).toMatchObject({ token: 'LOCAL-SECRET', warnings: [] });
    git(root, 'config', 'agenthub.url', 'http://attacker:8080'); // hub init --url http://attacker:8080
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ token: 'LOCAL-SECRET', warnings: [] });
    // No agenthub.json url at all: the default hub, or the one recorded for the repository.
    rmSync(path.join(root, 'agenthub.json'));
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ url: 'http://attacker:8080', token: 'LOCAL-SECRET', warnings: [] });
  });

  it('treats a .hub.json that git tracks like agenthub.json: no agent or token from it, and no token set on this machine for a hub only it names', () => {
    const root = path.join(dir, 'tracked-local');
    mkdirSync(root);
    git(root, 'init', '-q');
    git(root, 'config', 'agenthub.url', 'https://hub.company'); // recorded by hub init
    writeFileSync(path.join(root, 'agenthub.json'), JSON.stringify({ project: 'co/app', url: 'https://hub.company' }));
    // A branch committed a .hub.json; checking it out replaced this worktree's own (git overwrites an ignored file).
    writeFileSync(path.join(root, '.hub.json'), JSON.stringify({ agent: 'maya/claude-1', token: 'committed', url: 'http://attacker:8080' }));
    git(root, 'add', '-f', '.hub.json');
    const urlless = path.join(dir, 'global-urlless.json');
    writeFileSync(urlless, JSON.stringify({ token: 'GLOBAL-SECRET' }));
    for (const env of [{ ...noGlobal, HUB_TOKEN: 'ENV-SECRET' }, { HUB_CONFIG: urlless }]) {
      const cfg = loadConfig({ cwd: root, env });
      expect(cfg).toMatchObject({ url: 'http://attacker:8080', agent: null, token: null });
      expect(cfg.warnings).toEqual([
        expect.stringMatching(/\.hub\.json is tracked by git, so it is shared like agenthub\.json, not this worktree's own: an agent or token in it is ignored.*git rm --cached \.hub\.json/),
        expect.stringMatching(/is not sent to http:\/\/attacker:8080: .*, and only the \.hub\.json that git tracks names this one\./),
      ]);
    }
    // The hub this machine chose still gets its token; the identity still doesn't come from the file.
    writeFileSync(path.join(root, '.hub.json'), JSON.stringify({ agent: 'maya/claude-1', url: 'https://hub.company' }));
    expect(loadConfig({ cwd: root, env: { ...noGlobal, HUB_TOKEN: 'ENV-SECRET', HUB_URL: 'https://hub.company' } })).toMatchObject({ agent: null, token: 'ENV-SECRET' });
    // Out of git, it is this worktree's own again.
    git(root, 'rm', '-q', '--cached', '-f', '.hub.json');
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ agent: 'maya/claude-1', warnings: [] });
  });

  it('treats a .hub.json that opens a tracked file of another name (a committed .Hub.json where case does not matter) as tracked', () => {
    const root = path.join(dir, 'tracked-alias');
    mkdirSync(root);
    git(root, 'init', '-q');
    git(root, 'config', 'agenthub.url', 'https://hub.company');
    writeFileSync(path.join(root, 'agenthub.json'), JSON.stringify({ project: 'co/app', url: 'https://hub.company' }));
    const ignoresCase = existsSync(path.join(root, 'AGENTHUB.JSON'));
    // A branch commits .Hub.json; on macOS or Windows checking it out replaces this worktree's .hub.json, which then
    // opens it. Where case matters, a hard link stands in for that.
    writeFileSync(path.join(root, '.Hub.json'), JSON.stringify({ agent: 'maya/claude-1', url: 'http://attacker:8080' }));
    if (!ignoresCase) linkSync(path.join(root, '.Hub.json'), path.join(root, '.hub.json'));
    git(root, 'add', '-f', '.Hub.json');
    expect(git(root, 'ls-files', '--', '.hub.json').trim()).toBe(''); // git itself goes by the exact name
    const cfg = loadConfig({ cwd: root, env: { ...noGlobal, HUB_TOKEN: 'ENV-SECRET' } });
    expect(cfg).toMatchObject({ url: 'http://attacker:8080', agent: null, token: null });
    expect(cfg.warnings).toEqual([expect.stringMatching(/\.hub\.json is tracked by git/), cfg.tokenWithheld]);
    if (!ignoresCase) {
      // A .hub.json of this worktree's own beside a tracked .Hub.json is still its own.
      rmSync(path.join(root, '.hub.json'));
      writeFileSync(path.join(root, '.hub.json'), JSON.stringify({ agent: 'sam/claude-1' }));
      expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ agent: 'sam/claude-1', warnings: [] });
    }
  });

  it("keeps this worktree's .hub.json its own when a committed symlink points at it", () => {
    const root = path.join(dir, 'tracked-symlink');
    mkdirSync(root);
    git(root, 'init', '-q');
    writeFileSync(path.join(root, '.hub.json'), JSON.stringify({ agent: 'sam/claude-1' }));
    symlinkSync('.hub.json', path.join(root, 'local-config.json'));
    git(root, 'add', 'local-config.json'); // git tracks the link itself, not what it points at
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ agent: 'sam/claude-1', warnings: [] });
  });

  it('sends HUB_TOKEN without HUB_URL, or a global token without a url, only to a hub this machine names, not to one only the repository names (even after hub init recorded it)', () => {
    const root = path.join(dir, 'oss-clone');
    mkdirSync(root);
    git(root, 'init', '-q');
    git(root, 'config', 'agenthub.url', 'http://oss-hub:7077'); // a plain hub init, copied from the repository's own agenthub.json
    writeFileSync(path.join(root, 'agenthub.json'), JSON.stringify({ project: 'oss/proj', url: 'http://oss-hub:7077' }));
    writeFileSync(path.join(root, '.hub.json'), JSON.stringify({ agent: 'maya/claude-1' }));
    const fromEnv = loadConfig({ cwd: root, env: { ...noGlobal, HUB_TOKEN: 'COMPANY-SECRET' } });
    expect(fromEnv).toMatchObject({ url: 'http://oss-hub:7077', token: null });
    expect(fromEnv.warnings).toEqual([fromEnv.tokenWithheld]);
    expect(fromEnv.tokenWithheld).toBe(
      'HUB_TOKEN is not sent to http://oss-hub:7077: set without HUB_URL, it goes only to a hub this machine names, and only the committed agenthub.json names this one. ' +
        'If it is that hub\'s token, also set HUB_URL=http://oss-hub:7077.',
    );
    const urlless = path.join(dir, 'global-token-only.json');
    writeFileSync(urlless, JSON.stringify({ token: 'COMPANY-SECRET' }));
    expect(loadConfig({ cwd: root, env: { HUB_CONFIG: urlless } }).tokenWithheld).toBe(
      `the hub token in ${urlless} is not sent to http://oss-hub:7077: with no "url" beside it, it goes only to a hub this machine names, and only the committed agenthub.json names this one. ` +
        'If it is that hub\'s token, add "url": "http://oss-hub:7077" beside it.',
    );
    rmSync(path.join(root, 'agenthub.json')); // a branch without it: the url hub init recorded
    expect(loadConfig({ cwd: root, env: { ...noGlobal, HUB_TOKEN: 'COMPANY-SECRET' } })).toMatchObject({
      url: 'http://oss-hub:7077',
      token: null,
      tokenWithheld: expect.stringMatching(/and only the repository's git config \(agenthub\.url\) names this one/),
    });

    // Named on this machine, or set in this worktree's own .hub.json: sent.
    expect(loadConfig({ cwd: root, env: { ...noGlobal, HUB_TOKEN: 'OSS', HUB_URL: 'http://oss-hub:7077' } })).toMatchObject({ token: 'OSS', warnings: [] });
    writeFileSync(urlless, JSON.stringify({ token: 'OSS', url: 'http://oss-hub:7077' }));
    expect(loadConfig({ cwd: root, env: { HUB_CONFIG: urlless } })).toMatchObject({ token: 'OSS', warnings: [] });
    writeFileSync(path.join(root, '.hub.json'), JSON.stringify({ agent: 'maya/claude-1', token: 'OSS-LOCAL' }));
    expect(loadConfig({ cwd: root, env: { ...noGlobal, HUB_TOKEN: 'COMPANY-SECRET' } })).toMatchObject({ token: 'OSS-LOCAL', warnings: [] });
    // The default hub is this machine's.
    git(root, 'config', '--unset', 'agenthub.url');
    expect(loadConfig({ cwd: root, env: { ...noGlobal, HUB_TOKEN: 'LOCALHOST' } })).toMatchObject({ url: DEFAULT_URL, token: 'LOCALHOST', warnings: [] });
  });

  it("sends a .hub.json token without a url to the hub origin's default branch names: a setup from before hub init recorded hubs, or a team that moved its hub", () => {
    const upstream = path.join(dir, 'upstream');
    mkdirSync(upstream);
    git(upstream, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(upstream, 'agenthub.json'), JSON.stringify({ project: 'co/app', url: 'https://hub.company' }));
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'agenthub setup');
    const root = path.join(dir, 'upstream-clone');
    git(dir, 'clone', '-q', upstream, root);
    writeFileSync(path.join(root, '.hub.json'), JSON.stringify({ agent: 'maya/claude-1', token: 'LOCAL-SECRET' }));
    // Nothing recorded in the git config: an older hub init.
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ url: 'https://hub.company', token: 'LOCAL-SECRET', warnings: [] });

    writeFileSync(path.join(root, 'agenthub.json'), JSON.stringify({ project: 'co/app', url: 'http://attacker:8080' })); // a pull request's branch
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({
      token: null,
      tokenWithheld: expect.stringMatching(/only the committed agenthub\.json names that hub, but the agenthub\.json on origin's default branch names https:\/\/hub\.company\./),
    });
    git(root, 'config', 'agenthub.url', 'https://hub.company');
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ token: null });

    // The team moves its hub on the default branch; this clone fetches it.
    writeFileSync(path.join(upstream, 'agenthub.json'), JSON.stringify({ project: 'co/app', url: 'https://hub2.company' }));
    git(upstream, 'commit', '-q', '-am', 'move the hub');
    git(root, 'checkout', '-q', '--', 'agenthub.json');
    git(root, 'pull', '-q', '--ff-only');
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ url: 'https://hub2.company', token: 'LOCAL-SECRET', warnings: [] });
  });

  it('rejects malformed agent ids', () => {
    const root = repo('bad', {});
    expect(() => loadConfig({ cwd: root, env: { ...noGlobal, HUB_AGENT: 'just-a-name' } })).toThrow(/human\/agent/);
  });

  it('accepts only a whole HUB_TIMEOUT_MS in range, so a bad value is a config error rather than every request "timing out"', () => {
    const root = repo('timeout', {});
    const timeout = (v: string | undefined) => loadConfig({ cwd: root, env: { ...noGlobal, HUB_TIMEOUT_MS: v } }).timeoutMs;
    expect(timeout(undefined)).toBe(4000);
    expect(timeout('')).toBe(4000);
    expect(timeout('1500')).toBe(1500);
    expect(timeout(' 600000 ')).toBe(600000);
    for (const bad of ['-1', '0', '2500.5', '1e10', 'Infinity', '2147483648', '4294967296', 'abc', '99']) {
      expect(() => timeout(bad), bad).toThrow(/HUB_TIMEOUT_MS/);
    }
  });

  it('parses HUB_FAIL_CLOSED strictly: a value it does not recognise is an error, not a silent "off"', () => {
    const root = repo('fail-closed', { 'agenthub.json': { project: 'x', failClosed: true } });
    const failClosed = (v: string | undefined) => loadConfig({ cwd: root, env: { ...noGlobal, HUB_FAIL_CLOSED: v } }).failClosed;
    expect(failClosed(undefined)).toBe(true); // the team file's setting
    expect(failClosed('')).toBe(true);
    for (const on of ['1', 'TRUE', ' yes ', 'on', '1 ']) expect(failClosed(on), on).toBe(true);
    for (const off of ['0', 'false', 'No', 'OFF']) expect(failClosed(off), off).toBe(false);
    for (const bad of ['y', 'enabled', 'required']) expect(() => failClosed(bad), bad).toThrow(/HUB_FAIL_CLOSED/);
  });

  it('rejects config files whose values have the wrong type, instead of misreading them', () => {
    let n = 0;
    const load = (files: Record<string, unknown>) => () => loadConfig({ cwd: repo(`types-${n++}`, files), env: noGlobal });
    expect(load({ '.hub.json': { failClosed: 'false' } })).toThrow(/"failClosed" must be true or false/);
    expect(load({ 'agenthub.json': { project: 'x', url: 123 } })).toThrow(/"url" must be a string/);
    expect(load({ '.hub.json': [{ agent: 'sam/claude-1' }] })).toThrow(/must contain a JSON object/);
    expect(load({ 'agenthub.json': { project: 'x', url: 'not a url' } })).toThrow(/hub URL/);
    expect(load({ '.hub.json': { agent: 'sam/claude-1', failClosed: false } })()).toMatchObject({ agent: 'sam/claude-1', failClosed: false });
  });

  it('maps paths to repo-relative claim keys, including files that do not exist yet', () => {
    const root = repo('paths', {});
    expect(toRepoPath(path.join(root, 'src', 'new', 'file.ts'), root, root)).toBe('src/new/file.ts');
    expect(toRepoPath('src/a.ts', root, root)).toBe('src/a.ts');
    expect(toRepoPath('../outside.ts', root, root)).toBeNull();
    expect(toRepoPath(path.join(root, '.git', 'config'), root, root)).toBeNull();
  });

  it("keeps names that only start with two dots ('..env', '...', '..data/x') inside the repository", () => {
    const root = repo('dots', {});
    expect(toRepoPath(path.join(root, '..env'), root, root)).toBe('..env');
    expect(toRepoPath(path.join(root, '...'), root, root)).toBe('...');
    expect(toRepoPath(path.join(root, '..data', 'x.ts'), root, root)).toBe('..data/x.ts');
    expect(toRepoPath('..', root, root)).toBeNull();
    expect(toRepoPath(path.join('..', 'x.ts'), root, root)).toBeNull();
    expect(toRepoPath(path.join(root, 'src', '..', '..', 'x.ts'), root, root)).toBeNull();
  });

  it('turns claim keys and staged paths into NFC, whatever form the name has on disk or in the request', () => {
    const root = path.join(dir, 'unicode');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    git(root, 'init', '-q');
    const nfd = 'cafe\u0301.ts';
    const nfc = 'caf\u00e9.ts';
    writeFileSync(path.join(root, 'src', nfd), 'export {};\n');
    expect(toRepoPath(path.join(root, 'src', nfc), root, root)).toBe(`src/${nfc}`);
    expect(toRepoPath(path.join(root, 'src', nfd), root, root)).toBe(`src/${nfc}`);
    expect(toRepoPath(path.join(root, 'new', nfd), root, root)).toBe(`new/${nfc}`); // not on disk yet
    git(root, '-c', 'core.precomposeunicode=false', 'add', '-A');
    expect(stagedPaths(root)).toEqual([`src/${nfc}`]);
  });

  it('falls back to the project and hub URL hub init recorded for the repository when this checkout has no agenthub.json', () => {
    const root = path.join(dir, 'recorded');
    mkdirSync(root);
    git(root, 'init', '-q');
    git(root, 'config', 'agenthub.project', 'team/app');
    git(root, 'config', 'agenthub.url', 'http://team:9');
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ project: 'team/app', url: 'http://team:9', projectSource: 'recorded' });
    writeFileSync(path.join(root, 'agenthub.json'), JSON.stringify({ project: 'other' })); // the checkout's own file wins
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ project: 'other', url: DEFAULT_URL, projectSource: 'file' });
    rmSync(path.join(root, 'agenthub.json'));
    git(root, 'config', '--unset', 'agenthub.project');
    expect(loadConfig({ cwd: root, env: noGlobal })).toMatchObject({ project: 'recorded', projectSource: 'derived' });
    expect(loadConfig({ cwd: root, env: { ...noGlobal, HUB_PROJECT: 'p' } })).toMatchObject({ project: 'p', projectSource: 'env' });
  });

  it("warns when HUB_AGENT overrides the identity in this checkout's .hub.json (env still wins)", () => {
    const root = repo('override', { '.hub.json': { agent: 'sam/claude-1' } });
    const cfg = loadConfig({ cwd: root, env: { ...noGlobal, HUB_AGENT: 'maya/claude-1' } });
    expect(cfg.agent).toBe('maya/claude-1');
    expect(cfg.warnings).toEqual([expect.stringMatching(/^HUB_AGENT=maya\/claude-1 overrides sam\/claude-1 from .*\.hub\.json/)]);
    expect(loadConfig({ cwd: root, env: { ...noGlobal, HUB_AGENT: 'sam/claude-1' } }).warnings).toEqual([]);
    expect(loadConfig({ cwd: root, env: noGlobal }).warnings).toEqual([]);
    const global = path.join(dir, 'global-agent.json');
    writeFileSync(global, JSON.stringify({ agent: 'lee/claude-1' })); // a default for every checkout: overriding it is normal
    expect(loadConfig({ cwd: repo('override-global', {}), env: { HUB_CONFIG: global, HUB_AGENT: 'maya/claude-1' } }).warnings).toEqual([]);
  });
});
