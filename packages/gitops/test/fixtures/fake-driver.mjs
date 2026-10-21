#!/usr/bin/env node
// A stand-in structural merge driver for the merge-ladder tests. git runs it as
//   node fake-driver.mjs <log> %O %A %B %P
// It appends %P to <log> (so a test can see when and where it ran), then
// writes a line union into %A (ours, then the lines theirs added that ours
// lacks) followed by a marker line, and exits 0: it "resolves" everything,
// including files git already merged cleanly, which is exactly what the
// ladder must never let it change.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [log, basePath, oursPath, theirsPath, name] = process.argv.slice(2);
appendFileSync(log, `${name}\n`);
const lines = (p) => readFileSync(p, 'utf8').split('\n').filter((l, i, all) => i < all.length - 1 || l !== '');
const base = new Set(lines(basePath));
const ours = lines(oursPath);
const have = new Set(ours);
const added = lines(theirsPath).filter((l) => !base.has(l) && !have.has(l));
writeFileSync(oursPath, [...ours, ...added, '// merged by fake-driver', ''].join('\n'));
process.exit(0);
