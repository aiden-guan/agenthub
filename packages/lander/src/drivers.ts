// Structural merge drivers for stage 2 of the merge ladder (design §2.2.6,
// §1.2 `drivers`): Mergiraf is auto-detected on PATH; Weave, or any other
// driver, is configured explicitly as {command, patterns}, because nothing
// about its CLI is verified here.

import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import type { StructuralDriver } from '@agenthub/gitops';

/** The attribute name the generated info/attributes uses (`*.ts merge=agenthub-structural`). */
export const STRUCTURAL_DRIVER_NAME = 'agenthub-structural';
/** Mergiraf's git driver line, from its documentation (R3: unverified here; doctor self-tests it). */
export const MERGIRAF_ARGS = 'merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L';

/** The first executable `name` on `PATH`, or null. */
export function which(name: string, PATH = process.env.PATH ?? ''): string | null {
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

function shq(s: string): string {
  return /^[A-Za-z0-9_./=:@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Mergiraf on PATH, as a driver: the patterns come from
 * `mergiraf languages --gitattributes`. None when it isn't installed, or
 * lists no patterns.
 */
export async function detectDrivers(o: { PATH?: string; log?: (line: string) => void } = {}): Promise<StructuralDriver[]> {
  const PATH = o.PATH ?? process.env.PATH ?? '';
  const bin = which('mergiraf', PATH);
  if (!bin) return [];
  const text = await new Promise<string>((resolve) => {
    execFile(bin, ['languages', '--gitattributes'], { env: { ...process.env, PATH }, timeout: 10_000, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? '' : stdout));
  });
  const patterns = [...new Set(text.split('\n').map((l) => l.trim().split(/\s+/)[0] ?? '').filter((p) => p.length > 0 && !p.startsWith('#') && /^[^\s"!]+$/.test(p)))];
  if (patterns.length === 0) {
    o.log?.(`found ${bin}, but \`mergiraf languages --gitattributes\` listed no patterns: no structural merging`);
    return [];
  }
  o.log?.(`structural merging with ${bin} for ${patterns.length} pattern${patterns.length === 1 ? '' : 's'}`);
  return [{ name: STRUCTURAL_DRIVER_NAME, command: `${shq(bin)} ${MERGIRAF_ARGS}`, patterns }];
}
