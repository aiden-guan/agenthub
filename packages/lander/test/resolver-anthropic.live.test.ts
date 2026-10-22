import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTeamSections } from '@agenthub/contract';
import type { Landing } from '@agenthub/hub/protocol';
import { openGitPort } from '../src/git-port.js';
import { HubCallError } from '../src/ports.js';
import { AiResolver } from '../src/resolver.js';
import { EPOCH, IDENT_ENV, PROJECT, Repo, bareMirror, sh, tmp } from './helpers.js';

// design §5.6: the one test that talks to the Anthropic API. It runs only
// with AGENTHUB_LIVE_AI=1 and ANTHROPIC_API_KEY set, never in CI: it resolves
// a known two-function conflict through the built-in `hub-lander
// resolve-anthropic` (the built bin, so `npm run build` first) and asserts
// that the output passes every gate.

const LIVE = process.env.AGENTHUB_LIVE_AI === '1' && !!process.env.ANTHROPIC_API_KEY;
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'hub-lander.js');

describe.skipIf(!LIVE)('resolve-anthropic against the real API (opt-in: AGENTHUB_LIVE_AI=1)', () => {
  it(
    'resolves a two-function conflict; the result passes the gates and keeps both intents',
    async () => {
      expect(existsSync(path.join(path.dirname(BIN), '..', 'dist', 'cli.js'))).toBe(true);
      const t = tmp('resolver-live-');
      try {
        const repo = Repo.init(path.join(t.dir, 'repo'));
        const base = 'export function greet(name: string): string {\n  return "Hello " + name;\n}\n\nexport function bye(name: string): string {\n  return "Bye " + name;\n}\n';
        const B = repo.commit('base', { 'src/greet.ts': base });
        // Trunk renamed the parameter; the incoming change adds punctuation in the same lines.
        const T0 = repo.commit('trunk: rename name to who', { 'src/greet.ts': base.replaceAll('name', 'who') });
        repo.checkout('-b', 'feature', B);
        const H = repo.commit('incoming: punctuation', { 'src/greet.ts': base.replace('"Hello " + name', '"Hello, " + name + "!"').replace('"Bye " + name', '"Bye, " + name + "."') });
        const mirror = bareMirror(repo, path.join(t.dir, 'mirror.git'));
        const git = openGitPort({ mirror, remote: 'origin', env: IDENT_ENV });
        const merge = await git.mergeTrees(T0, H, { base: B, attrSource: T0 });
        expect(merge.conflicts.map((c) => c.path)).toEqual(['src/greet.ts']);
        const land = parseTeamSections({ land: { check: 'true' } }, { strict: true }).sections.land!;
        const resolver = new AiResolver({
          git,
          hub: {
            landing: async (id) => {
              throw new HubCallError('not_found', 404, id);
            },
            tasks: async () => [],
            decisions: async () => [],
            getClaim: async (id) => {
              throw new HubCallError('not_found', 404, id);
            },
          },
          project: PROJECT,
          command: null,
          builtinArgv: [process.execPath, BIN, 'resolve-anthropic'],
          apiKey: process.env.ANTHROPIC_API_KEY!,
          maxPerHour: 5,
          scratchDir: t.dir,
        });
        const landing = { id: 'L-1', agent: 'maya/claude-1', task_id: null, summary: 'Greetings end with punctuation.', hold_ids: [], approvals: [], candidate: null, candidate_ref: null } as unknown as Landing;
        const r = await resolver.resolve({
          landing,
          conflicts: merge.conflicts,
          tree: merge.tree,
          base: B,
          trunk: T0,
          head: H,
          config: { ...land.resolver, enabled: true },
          protectedRules: land.protected,
          distinct: true,
          epoch: EPOCH,
          reuse: { candidate: null, candidateRef: null, approved: [] },
        });
        expect(r.warnings).toEqual([]);
        expect(r.report.outcome).toBe('resolved');
        expect(r.resolved).toEqual(['src/greet.ts']);
        expect(r.report.input_tokens).toBeGreaterThan(0);
        const out = sh(mirror, ['cat-file', 'blob', `${r.tree}:src/greet.ts`]);
        expect(out).toContain('who');
        expect(out).toMatch(/Hello, /);
      } finally {
        t.cleanup();
      }
    },
    240_000,
  );
});
