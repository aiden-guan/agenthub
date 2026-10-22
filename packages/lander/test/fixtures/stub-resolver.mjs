#!/usr/bin/env node
// The stub resolver (design §5 "The stub resolver", §2.6 "Command protocol"):
// a stand-in for `hub-lander resolve-anthropic` that speaks the frozen
// resolver protocol (src/resolver-protocol.ts): ResolverInput as JSON on
// stdin, ResolverOutput as JSON on stdout. Nothing leaves the machine and no
// key is needed.
//
//   node stub-resolver.mjs [config.json]
//
// The config comes from the argument, else from $AGENTHUB_RESOLVER_STUB (the
// lander passes that one on only under NODE_ENV=test). Its "mode":
// - fixture: config.files[<path>] lists the hunk texts in id order (or maps
//   ids to texts); a path it doesn't list is declined;
// - union: each hunk becomes trunk's side, then the incoming lines trunk's
//   side doesn't have already (no duplicate lines);
// - markers: each hunk's text is its whole conflict region of `merged`,
//   markers included (the gates must refuse it);
// - decline: cannot_resolve;
// - broken: union plus one line the test repositories' check.mjs fails on
//   (valid output that passes the gates and fails the checks);
// - slow: waits config.delayMs (default 10 min), then answers as union;
// - exit: exits with config.code (default 3) without answering;
// - garbage: prints something that isn't JSON.
// config.explanation replaces the explanation; config.extra is merged into the output.
//
// Every call appends the file's path to <config>.calls (the call counter),
// writes the input to <config>.last.json, and writes what the environment held
// to <config>.env.json (variable names, HOME, and a sha256 of
// ANTHROPIC_API_KEY when there is one, never the key itself).
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const configPath = process.argv[2] || process.env.AGENTHUB_RESOLVER_STUB;
if (!configPath) {
  process.stderr.write('stub-resolver: no config (pass it as the first argument or in AGENTHUB_RESOLVER_STUB)\n');
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(`${configPath}.calls`, `${input.file.path}\n`);
writeFileSync(`${configPath}.last.json`, JSON.stringify(input, null, 2));
const key = process.env.ANTHROPIC_API_KEY;
writeFileSync(
  `${configPath}.env.json`,
  JSON.stringify({ names: Object.keys(process.env).sort(), HOME: process.env.HOME ?? null, anthropicKeySha256: key ? createHash('sha256').update(key).digest('hex') : null }),
);

const answer = (output) => {
  process.stdout.write(`${JSON.stringify({ ...output, ...(config.extra ?? {}) })}\n`);
  process.exit(0);
};
const usage = { model: input.model, input_tokens: 0, output_tokens: 0 };

const lines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

/** Trunk's lines, then the incoming ones trunk's side doesn't have; ends with a newline when either side does. */
function union(trunk, incoming) {
  const ours = lines(trunk);
  const all = [...ours, ...lines(incoming).filter((l) => !ours.includes(l))];
  if (all.length === 0) return '';
  return `${all.join('\n')}${trunk.endsWith('\n') || incoming.endsWith('\n') ? '\n' : ''}`;
}

const unionOutput = () => ({
  status: 'resolved',
  hunks: input.file.hunks.map((h) => ({ id: h.id, text: union(h.trunk, h.incoming) })),
  explanation: config.explanation ?? "stub resolver: kept trunk's lines, then added the incoming lines trunk did not have.",
  usage,
});

switch (config.mode) {
  case 'fixture': {
    const texts = config.files?.[input.file.path];
    if (!texts) answer({ status: 'cannot_resolve', explanation: `stub resolver: no fixture for ${input.file.path}.`, usage });
    const text = (id) => (Array.isArray(texts) ? texts[id] : texts[String(id)]);
    answer({
      status: 'resolved',
      hunks: input.file.hunks.filter((h) => text(h.id) !== undefined).map((h) => ({ id: h.id, text: text(h.id) })),
      explanation: config.explanation ?? 'stub resolver: the fixture texts.',
      usage,
    });
    break;
  }
  case 'union':
    answer(unionOutput());
    break;
  case 'markers': {
    const merged = input.file.merged.split('\n');
    answer({
      status: 'resolved',
      hunks: input.file.hunks.map((h) => ({ id: h.id, text: `${merged.slice(h.start_line - 1, h.end_line).join('\n')}\n` })),
      explanation: config.explanation ?? 'stub resolver: left the markers in.',
      usage,
    });
    break;
  }
  case 'decline':
    answer({ status: 'cannot_resolve', explanation: config.explanation ?? 'stub resolver: declined.', usage });
    break;
  case 'broken': {
    const out = unionOutput();
    const bad = `// ${'FAIL'}! (stub resolver, broken mode)\n`;
    out.hunks = out.hunks.map((h) => ({ id: h.id, text: `${h.text}${h.text === '' || h.text.endsWith('\n') ? '' : '\n'}${bad}` }));
    answer(out);
    break;
  }
  case 'slow':
    await new Promise((r) => setTimeout(r, config.delayMs ?? 600_000));
    answer(unionOutput());
    break;
  case 'exit':
    process.stderr.write('stub resolver: exiting without an answer\n');
    process.exit(config.code ?? 3);
    break;
  case 'garbage':
    process.stdout.write('this is not JSON\n');
    process.exit(0);
    break;
  default:
    process.stderr.write(`stub-resolver: unknown mode ${JSON.stringify(config.mode)}\n`);
    process.exit(2);
}
