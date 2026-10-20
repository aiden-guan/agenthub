import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(cfg).toMatchObject({ project: 'team/app', url: 'http://team:2', agent: 'maya/claude-1', token: 'global-token', root });
    expect(cfg.configFiles).toEqual([global, path.join(root, 'agenthub.json'), path.join(root, '.hub.json')]);

    const env = loadConfig({ cwd: root, env: { HUB_CONFIG: global, HUB_AGENT: 'sam/codex-1', HUB_URL: 'http://env:3/', HUB_PROJECT: 'p' } });
    expect(env).toMatchObject({ agent: 'sam/codex-1', url: 'http://env:3', project: 'p' });
  });

  it('ignores an agent id that only the committed file provides', () => {
    const root = repo('team-only', { 'agenthub.json': { project: 'x', agent: 'maya/claude-1' } });
    expect(loadConfig({ cwd: root, env: noGlobal }).agent).toBeNull();
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
