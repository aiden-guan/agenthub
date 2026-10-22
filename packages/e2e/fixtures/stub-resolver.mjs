#!/usr/bin/env node
// The end-to-end suite's stand-in for the AI resolver (design §5 "The stub
// resolver", §2.6 "Command protocol"). The lander runs it as its
// --resolver-command, once per conflicted file: ResolverInput as JSON on stdin
// (packages/lander/src/resolver-protocol.ts, frozen), ResolverOutput as JSON
// on stdout. Nothing leaves the machine and no key is needed.
//
//   node stub-resolver.mjs [config.json]
//
// The config comes from the argument, else from $AGENTHUB_RESOLVER_STUB (the
// lander may not pass its environment on to the resolver). Its "mode":
// - union: each hunk becomes trunk's side, then the incoming lines trunk's
//   side doesn't have already (no duplicate lines);
// - decline: cannot_resolve.
// Every call appends the file's path to "<config>.calls" (the call counter).
import { appendFileSync, readFileSync } from 'node:fs';

const configPath = process.argv[2] || process.env.AGENTHUB_RESOLVER_STUB;
if (!configPath) {
  process.stderr.write('stub-resolver: no config (pass it as the first argument or in AGENTHUB_RESOLVER_STUB)\n');
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(`${configPath}.calls`, `${input.file.path}\n`);

const answer = (output) => {
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(0);
};

const lines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** Trunk's lines, then the incoming ones trunk's side doesn't have; ends with a newline when either side does. */
function union(trunk, incoming) {
  const ours = lines(trunk);
  const all = [...ours, ...lines(incoming).filter((l) => !ours.includes(l))];
  if (all.length === 0) return '';
  return `${all.join('\n')}${trunk.endsWith('\n') || incoming.endsWith('\n') ? '\n' : ''}`;
}

switch (config.mode) {
  case 'union':
    answer({
      status: 'resolved',
      hunks: input.file.hunks.map((h) => ({ id: h.id, text: union(h.trunk, h.incoming) })),
      explanation: 'stub resolver: kept trunk\'s lines, then added the incoming lines trunk did not have.',
      usage: { model: input.model, input_tokens: 0, output_tokens: 0 },
    });
    break;
  case 'decline':
    answer({ status: 'cannot_resolve', explanation: 'stub resolver: declined.' });
    break;
  default:
    process.stderr.write(`stub-resolver: unknown mode ${JSON.stringify(config.mode)}\n`);
    process.exit(2);
}
