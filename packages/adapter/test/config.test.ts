import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { toRepoPath } from '../src/git.js';

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

  it('maps paths to repo-relative claim keys, including files that do not exist yet', () => {
    const root = repo('paths', {});
    expect(toRepoPath(path.join(root, 'src', 'new', 'file.ts'), root, root)).toBe('src/new/file.ts');
    expect(toRepoPath('src/a.ts', root, root)).toBe('src/a.ts');
    expect(toRepoPath('../outside.ts', root, root)).toBeNull();
    expect(toRepoPath(path.join(root, '.git', 'config'), root, root)).toBeNull();
  });
});
