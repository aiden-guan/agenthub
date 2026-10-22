// The conflict regions of `git merge-file -p --diff3` output (design §2.6,
// §2.2.6 step 4), with their offsets: the resolver numbers them and splices
// its answers in (resolver.ts), and the fix-it report names the declarations
// each one lies in (symbols.ts).

/** One numbered conflict region of `git merge-file -p --diff3` output. */
export interface ConflictRegion {
  id: number;
  /** Offsets in the merged text: from the start of the opening marker line to the end of the closing one. */
  start: number;
  end: number;
  /** Lines of the merged text, 1-based, marker lines included. */
  start_line: number;
  end_line: number;
  trunk: string;
  base: string;
  incoming: string;
  /** The closing marker line's line end ('' at the end of a file without a final newline). */
  eol: string;
}

/**
 * The conflict regions of diff3 output whose markers are `markerSize` long
 * (`<<<<<<< trunk`, `||||||| base`, `=======`, `>>>>>>> incoming`), numbered
 * 0..n-1 in file order. Each side keeps its lines' own line ends.
 */
export function conflictRegions(merged: string, markerSize: number): ConflictRegion[] {
  const [lt, bar, eq, gt] = ['<', '|', '=', '>'].map((c) => c.repeat(markerSize)) as [string, string, string, string];
  const isMarker = (line: string, m: string) => line === m || line.startsWith(`${m} `);
  const out: ConflictRegion[] = [];
  let side: 'trunk' | 'base' | 'incoming' | null = null;
  let open = { start: 0, start_line: 0, trunk: [] as string[], base: [] as string[], incoming: [] as string[] };
  let offset = 0;
  let lineNo = 0;
  for (const m of merged.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const full = m[0];
    lineNo++;
    const at = offset;
    offset += full.length;
    const eol = full.endsWith('\r\n') ? '\r\n' : full.endsWith('\n') ? '\n' : '';
    const line = full.slice(0, full.length - eol.length);
    if (side === null) {
      if (isMarker(line, lt)) {
        side = 'trunk';
        open = { start: at, start_line: lineNo, trunk: [], base: [], incoming: [] };
      }
      continue;
    }
    if (side === 'trunk' && isMarker(line, bar)) side = 'base';
    else if (side !== 'incoming' && line === eq) side = 'incoming';
    else if (side === 'incoming' && isMarker(line, gt)) {
      out.push({ id: out.length, start: open.start, end: offset, start_line: open.start_line, end_line: lineNo, trunk: open.trunk.join(''), base: open.base.join(''), incoming: open.incoming.join(''), eol });
      side = null;
    } else open[side].push(full);
  }
  return out;
}

/**
 * The merged text with region i replaced by texts[i], and every byte outside
 * the regions exactly as it was (design §2.6 gate 3). A non-empty text gets
 * the region's own line end if it lacks one, so the next line stays a line.
 */
export function spliceRegions(merged: string, regions: readonly ConflictRegion[], texts: readonly string[]): string {
  let out = '';
  let at = 0;
  regions.forEach((r, i) => {
    let t = texts[i] ?? '';
    if (t !== '' && r.eol !== '' && !t.endsWith('\n')) t += r.eol;
    out += merged.slice(at, r.start) + t;
    at = r.end;
  });
  return out + merged.slice(at);
}

/**
 * The file as one side has it inside the regions (git's merge text outside
 * them): every region replaced by its `side` text, and where each one went.
 */
export function sideView(merged: string, regions: readonly ConflictRegion[], side: 'trunk' | 'base' | 'incoming'): { text: string; spans: Array<{ start: number; end: number }> } {
  let text = '';
  let at = 0;
  const spans: Array<{ start: number; end: number }> = [];
  for (const r of regions) {
    text += merged.slice(at, r.start);
    const start = text.length;
    text += r[side];
    spans.push({ start, end: text.length });
    at = r.end;
  }
  return { text: text + merged.slice(at), spans };
}
