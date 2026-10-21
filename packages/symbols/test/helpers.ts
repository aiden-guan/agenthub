import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { Item, Outline } from '../src/types.js';

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(PACKAGE_DIR, 'test', 'fixtures');

export function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** A readable view of an item: its key, kind, lines, the first and last line of its exact span, and its signature. */
export interface View {
  key: string;
  kind: string;
  lines: string;
  head: string;
  tail: string;
  signature: string | null;
  members?: View[];
}

export function view(source: string, items: Item[]): View[] {
  return items.map((item) => {
    const span = source.slice(item.start, item.end);
    const lines = span.split('\n');
    const v: View = {
      key: item.key,
      kind: item.kind,
      lines: item.startLine === item.endLine ? `${item.startLine}` : `${item.startLine}-${item.endLine}`,
      head: lines[0] ?? '',
      tail: lines[lines.length - 1] ?? '',
      signature: item.signature,
    };
    if (item.members.length > 0) v.members = view(source, item.members);
    return v;
  });
}

export function keys(items: Item[]): string[] {
  return items.flatMap((i) => [i.key, ...keys(i.members)]);
}

export function find(items: Item[], key: string): Item {
  for (const item of items) {
    if (item.key === key) return item;
    const hit = item.members.length > 0 ? findOrNull(item.members, key) : null;
    if (hit) return hit;
  }
  throw new Error(`no item ${key}`);
}

function findOrNull(items: Item[], key: string): Item | null {
  try {
    return find(items, key);
  } catch {
    return null;
  }
}

/** Kinds whose text may be a shell rather than the exact span. */
const CONTAINER_KINDS = new Set(['class', 'namespace', 'impl', 'trait', 'interface', 'enum']);

/**
 * The structural guarantees every outline makes: items are in source order and
 * don't overlap; members lie inside their container and carry its key as a
 * prefix; lines (1-based, inclusive) match offsets; a non-container's text is
 * its exact span, or for a later declarator of a shared statement, that
 * statement's header followed by its span; and every non-whitespace character
 * of the file lies in a top-level item (declarations, `@imports` and
 * `@toplevel` partition the file up to whitespace).
 */
export function expectWellFormed(source: string, outline: Outline): void {
  const lineOf = (offset: number): number => source.slice(0, offset).split('\n').length;
  const check = (items: Item[], lo: number, hi: number, container: string | null): void => {
    let prev = lo;
    for (const item of items) {
      expect(item.start, `${item.key} starts after the previous item`).toBeGreaterThanOrEqual(prev);
      expect(item.end, `${item.key} is not empty`).toBeGreaterThan(item.start);
      expect(item.end, `${item.key} ends inside its container`).toBeLessThanOrEqual(hi);
      expect(item.startLine, `${item.key} startLine`).toBe(lineOf(item.start));
      expect(item.endLine, `${item.key} endLine`).toBe(lineOf(item.end - 1));
      if (container !== null) expect(item.key.startsWith(`${container}.`), `${item.key} is a member of ${container}`).toBe(true);
      if (!CONTAINER_KINDS.has(item.kind)) expect(item.text.endsWith(source.slice(item.start, item.end)), `${item.key} text`).toBe(true);
      check(item.members, item.start, item.end, item.key);
      prev = item.end;
    }
  };
  check(outline.items, 0, source.length, null);
  // Top level: the gaps between items are whitespace only.
  let prev = 0;
  for (const item of outline.items) {
    expect(source.slice(prev, item.start).trim(), `the gap before ${item.key}`).toBe('');
    prev = item.end;
  }
  expect(source.slice(prev).trim(), 'the gap at the end of the file').toBe('');
}
