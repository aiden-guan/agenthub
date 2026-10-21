// applyEdit (design §1.10 "How edits map to keys"): the pre-edit hook knows the
// exact post-edit text, because the Edit tool is a deterministic string
// replacement that this reproduces. Where the tool would fail, this returns
// null (the hook then claims the file, `edit_not_applicable`).
//
// The tool's rules, mirrored:
// - old_string must occur; occurrences are counted left to right without
//   overlaps (the tool splits the file on old_string). Without replace_all
//   exactly one is allowed, and it is replaced; with replace_all every one is.
// - old_string equal to new_string is refused (a no-op edit).
// - An empty old_string only fills an empty or blank file (new_string goes
//   before what is there).
// - Deleting (an empty new_string) text that doesn't end with a newline, when
//   the file holds that text followed by a newline, deletes the newline too
//   (for replace_all: only the occurrences followed by one).
// - new_string is inserted literally (no `$&`-style patterns).
// - MultiEdit applies its edits in order, each to the result of the one
//   before; one failure fails them all (`applyEdits`).
//
// The tool's tolerance of curly versus straight quotes and of line endings is
// not mirrored: such an edit maps whole-file here, and the post-edit hook
// re-reads the file and maps what the tool actually wrote.

import type { TextEdit } from './types.js';

/** Non-overlapping occurrences of `needle` in `haystack`, counted from the left, stopping at 2. */
function occurrences(haystack: string, needle: string): number {
  const first = haystack.indexOf(needle);
  if (first === -1) return 0;
  return haystack.indexOf(needle, first + needle.length) === -1 ? 1 : 2;
}

/** The text after `edit`, as the Edit tool would write it; null when the tool would refuse it. */
export function applyEdit(before: string, edit: TextEdit): string | null {
  const from = edit.old_string;
  const to = edit.new_string;
  if (typeof from !== 'string' || typeof to !== 'string' || typeof before !== 'string') return null;
  if (from === to) return null;
  if (from === '') return before.trim() === '' ? to + before : null;
  const count = occurrences(before, from);
  if (count === 0) return null;
  const all = edit.replace_all === true;
  if (count > 1 && !all) return null;
  // Deleting a line's text takes its newline along.
  const search = to === '' && !from.endsWith('\n') && before.includes(`${from}\n`) ? `${from}\n` : from;
  if (all) return before.split(search).join(to);
  const at = before.indexOf(search);
  return before.slice(0, at) + to + before.slice(at + search.length);
}

/** MultiEdit: the edits applied in order, each to the result of the previous; null when any of them fails. */
export function applyEdits(before: string, edits: readonly TextEdit[]): string | null {
  let text: string | null = before;
  for (const edit of edits) {
    text = applyEdit(text, edit);
    if (text === null) return null;
  }
  return text;
}
