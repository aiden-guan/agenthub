import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ID_RE, PROJECT_RE } from '@agenthub/hub/protocol';
import {
  AGENT_ID_PATTERN,
  ConfigError,
  PROJECT_PATTERN,
  defaultWorkdir,
  landerId,
  landerSecrets,
  loadLanderConfig,
  parseLanderArgs,
  withTrunkDefaults,
} from '../src/config.js';
import { tmp, type Tmp } from './helpers.js';

const KEY = 'sk-ant-api03-TESTKEY-0123456789abcdefghijklmnop';

describe('lander config (design §1.2 lander-local configuration)', () => {
  let t: Tmp;
  let dir: string;
  beforeEach(() => {
    t = tmp('lander-config-');
    dir = path.join(t.dir, 'work');
    mkdirSync(dir);
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    t.cleanup();
  });

  function landerJson(value: unknown, mode = 0o600): string {
    const file = path.join(dir, 'lander.json');
    writeFileSync(file, JSON.stringify(value));
    chmodSync(file, mode);
    return file;
  }

  it('refuses a group- or world-readable lander.json (0644), and still drops the key from the environment', () => {
    landerJson({ landerToken: 'lt-secret' }, 0o644);
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: KEY, PATH: '/usr/bin' };
    expect(() => loadLanderConfig({ flags: { dir }, env, hostname: 'build1' })).toThrow(ConfigError);
    expect(() => loadLanderConfig({ flags: { dir }, env, hostname: 'build1' })).toThrow(/lander\.json.*chmod 600/);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    for (const mode of [0o640, 0o604, 0o620]) {
      landerJson({}, mode);
      expect(() => loadLanderConfig({ flags: { dir }, env: {}, hostname: 'build1' }), mode.toString(8)).toThrow(ConfigError);
    }
  });

  it('reads ANTHROPIC_API_KEY into memory and deletes it from process.env', () => {
    landerJson({ landerToken: 'lt-secret' });
    process.env.ANTHROPIC_API_KEY = KEY;
    const cfg = loadLanderConfig({ flags: { dir }, hostname: 'build1' });
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect('ANTHROPIC_API_KEY' in process.env).toBe(false);
    expect(cfg.anthropicApiKey).toBe(KEY);
    // Secrets are held but never printed: not enumerable, so JSON and spreads leave them out.
    const printed = JSON.stringify(cfg);
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain('lt-secret');
    expect(cfg.landerToken).toBe('lt-secret');
    expect(landerSecrets(cfg)).toEqual(expect.arrayContaining([KEY, 'lt-secret']));
  });

  it('drops the hub tokens from the environment too, after reading them', () => {
    const env: NodeJS.ProcessEnv = { HUB_TOKEN: 'bearer-1', HUB_LANDER_TOKEN: 'lander-1', HUB_URL: 'http://127.0.0.1:7077', HUB_PROJECT: 'acme/web' };
    const cfg = loadLanderConfig({ flags: { dir }, env, hostname: 'build1' });
    expect(cfg.token).toBe('bearer-1');
    expect(cfg.landerToken).toBe('lander-1');
    expect(env.HUB_TOKEN).toBeUndefined();
    expect(env.HUB_LANDER_TOKEN).toBeUndefined();
    expect(env.HUB_URL).toBe('http://127.0.0.1:7077');
  });

  it('never takes the API key from a file', () => {
    landerJson({ anthropicApiKey: KEY });
    expect(() => loadLanderConfig({ flags: { dir }, env: {}, hostname: 'h' })).toThrow(/environment/);
    landerJson({ ANTHROPIC_API_KEY: KEY });
    expect(() => loadLanderConfig({ flags: { dir }, env: {}, hostname: 'h' })).toThrow(/environment/);
  });

  it('refuses unknown keys and bad values in lander.json, naming them', () => {
    landerJson({ passEnv: ['NPM_TOKEN'], checkwrapper: 'docker' });
    expect(() => loadLanderConfig({ flags: { dir }, env: {}, hostname: 'h' })).toThrow(/checkwrapper/);
    landerJson({ leaseTtlMs: 'soon' });
    expect(() => loadLanderConfig({ flags: { dir }, env: {}, hostname: 'h' })).toThrow(/leaseTtlMs/);
    landerJson({ passEnv: ['NPM_TOKEN', 'not a name'] });
    expect(() => loadLanderConfig({ flags: { dir }, env: {}, hostname: 'h' })).toThrow(/passEnv/);
    writeFileSync(path.join(dir, 'lander.json'), '{ not json');
    expect(() => loadLanderConfig({ flags: { dir }, env: {}, hostname: 'h' })).toThrow(/lander\.json/);
  });

  it('has the documented defaults without a lander.json', () => {
    const cfg = loadLanderConfig({ flags: { dir }, env: {}, hostname: 'build1' });
    expect(cfg).toMatchObject({
      dir,
      hub: null,
      project: null,
      idPrefix: 'lander/build1',
      remoteUrl: null,
      committer: { name: 'agenthub lander', email: 'lander@localhost' },
      drivers: null,
      resolverCommand: null,
      resolverMaxPerHour: 20,
      passEnv: [],
      checkWrapper: null,
      leaseTtlMs: 60_000,
      pollTrunkMs: 15_000,
    });
    expect(cfg.token).toBeNull();
    expect(cfg.landerToken).toBeNull();
    expect(cfg.anthropicApiKey).toBeNull();
  });

  it('takes flags over the environment over lander.json', () => {
    landerJson({
      hub: 'http://file:1',
      project: 'file/proj',
      idPrefix: 'lander/from-file',
      leaseTtlMs: 30_000,
      committer: 'Release Bot <bot@example.com>',
      passEnv: ['NPM_TOKEN'],
      checkWrapper: 'docker run --rm -v {wt}:/w -w /w node:22 sh -c',
      drivers: [{ name: 'weave', command: 'weave merge %O %A %B', patterns: ['*.ts'] }],
      resolverMaxPerHour: 5,
    });
    const env = { HUB_URL: 'http://env:2', HUB_PROJECT: 'env/proj', HUB_LANDER_ID: 'lander/from-env' };
    const fromFile = loadLanderConfig({ flags: { dir }, env: {}, hostname: 'h' });
    expect(fromFile).toMatchObject({ hub: 'http://file:1', project: 'file/proj', idPrefix: 'lander/from-file', leaseTtlMs: 30_000, resolverMaxPerHour: 5 });
    expect(fromFile.committer).toEqual({ name: 'Release Bot', email: 'bot@example.com' });
    expect(fromFile.drivers).toEqual([{ name: 'weave', command: 'weave merge %O %A %B', patterns: ['*.ts'] }]);
    expect(fromFile.checkWrapper).toBe('docker run --rm -v {wt}:/w -w /w node:22 sh -c');
    expect(fromFile.passEnv).toEqual(['NPM_TOKEN']);

    const fromEnv = loadLanderConfig({ flags: { dir }, env: { ...env }, hostname: 'h' });
    expect(fromEnv).toMatchObject({ hub: 'http://env:2', project: 'env/proj', idPrefix: 'lander/from-env' });

    const { flags } = parseLanderArgs(['run', '--hub', 'http://flag:3', '--project', 'flag/proj', '--id-prefix', 'lander/from-flag', '--lease-ttl-ms', '1000', '--dir', dir]);
    const fromFlags = loadLanderConfig({ flags, env: { ...env }, hostname: 'h' });
    expect(fromFlags).toMatchObject({ hub: 'http://flag:3', project: 'flag/proj', idPrefix: 'lander/from-flag', leaseTtlMs: 1000 });
  });

  it('defaults the workdir to ~/.agenthub/lander/<project>, and needs --dir or a project', () => {
    expect(defaultWorkdir('acme/web', '/home/u')).toBe('/home/u/.agenthub/lander/acme_web');
    const cfg = loadLanderConfig({ flags: { project: 'acme/web' }, env: {}, home: t.dir, hostname: 'h' });
    expect(cfg.dir).toBe(path.join(t.dir, '.agenthub', 'lander', 'acme_web'));
    expect(() => loadLanderConfig({ flags: {}, env: {}, home: t.dir, hostname: 'h' })).toThrow(/--dir/);
  });

  it('validates the hub URL, the project and the id prefix', () => {
    expect(() => loadLanderConfig({ flags: { dir, hub: 'ftp://x' }, env: {}, hostname: 'h' })).toThrow(/hub/);
    expect(() => loadLanderConfig({ flags: { dir, hub: 'http://u:secret@hub:1' }, env: {}, hostname: 'h' })).toThrow(/credentials/);
    expect(() => loadLanderConfig({ flags: { dir, project: '-bad' }, env: {}, hostname: 'h' })).toThrow(/project/);
    expect(() => loadLanderConfig({ flags: { dir, idPrefix: 'maya/claude-1' }, env: {}, hostname: 'h' })).toThrow(/lander\//);
    expect(() => loadLanderConfig({ flags: { dir, idPrefix: 'lander/a b' }, env: {}, hostname: 'h' })).toThrow(/id prefix/);
  });

  it('makes per-process lander ids that are valid agent ids', () => {
    expect(landerId('lander/build1', 48213, '9f3c')).toBe('lander/build1-48213-9f3c');
    expect(landerId('lander/build1')).toMatch(/^lander\/build1-\d+-[0-9a-f]{4}$/);
    const long = landerId(`lander/${'h'.repeat(80)}`, 4_194_304, 'abcd');
    expect(long).toMatch(AGENT_ID_RE);
    expect(long.endsWith('-4194304-abcd')).toBe(true);
    // An odd host name still gives a valid id prefix.
    const cfg = loadLanderConfig({ flags: { dir }, env: {}, hostname: 'My Laptop.local!' });
    expect(cfg.idPrefix).toMatch(/^lander\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(landerId(cfg.idPrefix, 1, '0000')).toMatch(AGENT_ID_RE);
  });

  it('parses the hub-lander command line (design §6.3.6), refusing what it does not know', () => {
    const r = parseLanderArgs([
      'run', '--once', '--hub', 'http://127.0.0.1:7077', '--resolver-command', 'node stub.mjs',
      '--driver', 'mergiraf=mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L@*.ts,*.tsx',
      '--driver', 'weave=weave %O %A %B@*.py',
      '--check-wrapper', 'docker run --rm -v {wt}:/w -w /w node:22 sh -c', '--poll-trunk-ms=500',
    ]);
    expect(r.command).toBe('run');
    expect(r.flags).toMatchObject({ once: true, hub: 'http://127.0.0.1:7077', resolverCommand: 'node stub.mjs', pollTrunkMs: 500 });
    expect(r.flags.drivers).toEqual([
      { name: 'mergiraf', command: 'mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L', patterns: ['*.ts', '*.tsx'] },
      { name: 'weave', command: 'weave %O %A %B', patterns: ['*.py'] },
    ]);
    expect(parseLanderArgs(['init', '--remote', '/srv/remote.git', '--dir', dir]).flags).toMatchObject({ remote: '/srv/remote.git', dir });
    expect(() => parseLanderArgs(['run', '--frobnicate'])).toThrow(ConfigError);
    expect(() => parseLanderArgs(['run', '--lease-ttl-ms', '2m'])).toThrow(/lease-ttl-ms/);
    expect(() => parseLanderArgs(['run', '--lease-ttl-ms', '50'])).toThrow(/lease-ttl-ms/);
    expect(() => parseLanderArgs(['run', '--driver', 'no-patterns'])).toThrow(/--driver/);
    expect(() => parseLanderArgs(['run', '--driver', 'bad name=x@*.ts'])).toThrow(/--driver/);
    expect(() => parseLanderArgs(['init', '--once'])).toThrow(/--once/);
    expect(() => parseLanderArgs(['explode'])).toThrow(/explode/);
  });

  it('takes the hub and project from trunk agenthub.json when nothing else set them', () => {
    const cfg = loadLanderConfig({ flags: { dir }, env: {}, hostname: 'h' });
    const filled = withTrunkDefaults(cfg, { project: 'acme/web', url: 'http://hub.internal:7077' });
    expect(filled).toMatchObject({ hub: 'http://hub.internal:7077', project: 'acme/web' });
    // Secrets survive the copy, still hidden.
    expect(filled.anthropicApiKey).toBe(cfg.anthropicApiKey);
    expect(Object.keys(filled)).not.toContain('landerToken');
    const set = loadLanderConfig({ flags: { dir, hub: 'http://mine:1', project: 'mine/p' }, env: {}, hostname: 'h' });
    expect(withTrunkDefaults(set, { project: 'acme/web', url: 'http://hub.internal:7077' })).toMatchObject({ hub: 'http://mine:1', project: 'mine/p' });
  });

  it('keeps its copies of the protocol patterns in step with the hub', () => {
    expect(AGENT_ID_PATTERN.source).toBe(AGENT_ID_RE.source);
    expect(PROJECT_PATTERN.source).toBe(PROJECT_RE.source);
  });
});
