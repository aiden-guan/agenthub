// Text helpers the outline engine and the language tables share. Offsets are
// UTF-16 code units (JS string indices), as everywhere in this package.

/** The offset where each line starts (the first is 0). */
export function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** No line break between `a` (an end) and `b` (a start). */
export function sameLine(src: string, a: number, b: number): boolean {
  return src[a - 1] !== '\n' && !src.slice(a, b).includes('\n');
}

/** A blank line between `a` (an end) and `b` (a start). */
export function blankLineBetween(src: string, a: number, b: number): boolean {
  const gap = (src[a - 1] === '\n' ? '\n' : '') + src.slice(a, b);
  return /\n[^\S\n]*\n/.test(gap);
}

/** `end` moved back over whitespace, but not before `floor`. */
export function trimEnd(src: string, floor: number, end: number): number {
  let e = end;
  while (e > floor && /\s/.test(src[e - 1]!)) e--;
  return e;
}
