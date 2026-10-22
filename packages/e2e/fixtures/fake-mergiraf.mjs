#!/usr/bin/env node
// A stand-in for Mergiraf (design §5 "The fake structural driver"). The suite
// puts a one-line `mergiraf` shell wrapper first on the lander's PATH, so the
// lander detects it as its structural driver. It answers
// `languages --gitattributes` with *.ts and *.js, and implements
// `merge --git %O %A %B … -p %P` for exactly one shape: both sides appended
// different text to the base (two new functions at the end of a file), which
// it merges as base + ours' addition + theirs' addition. Anything else exits 1
// (still conflicted), so a same-line conflict goes on to the AI stage. With
// FAKE_MERGIRAF_LOG set it appends each path it was asked to merge.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'languages') {
  if (args.includes('--gitattributes')) process.stdout.write('*.ts merge=mergiraf\n*.js merge=mergiraf\n');
  process.exit(0);
}
if (cmd !== 'merge') process.exit(2);
const at = args.indexOf('--git');
const [O, A, B] = args.slice(at + 1, at + 4);
const p = args[args.indexOf('-p') + 1] ?? '?';
if (process.env.FAKE_MERGIRAF_LOG) appendFileSync(process.env.FAKE_MERGIRAF_LOG, `${p}\n`);
const base = readFileSync(O, 'utf8');
const ours = readFileSync(A, 'utf8');
const theirs = readFileSync(B, 'utf8');
if (!ours.startsWith(base) || !theirs.startsWith(base)) process.exit(1);
const mine = ours.slice(base.length);
const other = theirs.slice(base.length);
if (!mine || !other || mine === other) process.exit(1);
writeFileSync(A, `${base}${mine}${mine.endsWith('\n') ? '' : '\n'}${other}`);
process.exit(0);
