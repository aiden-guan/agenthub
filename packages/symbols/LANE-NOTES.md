# Lane S (symbols) notes

No contract amendments and no dependency requests so far. One optional
amendment is described under S1 (unkeyable top-level names); nothing depends
on it.

## S1: runtime, grammar integrity, TS/TSX/JS outlines

Files: `src/runtime.ts`, `src/outline.ts`, `src/spec.ts`, `src/signatures.ts`,
`src/errors.ts`, `src/languages/{index,javascript,typescript}.ts`,
`src/index.ts`, `grammars.manifest.json`, `scripts/manifest.mjs`.

Decisions later steps and other lanes build on:

- **Integrity.** `grammars.manifest.json` pins the seven grammars and also
  web-tree-sitter's own runtime `.wasm` (`runtime` entry), each by package,
  version, file, size and sha256. The runtime file is verified and handed to
  `Parser.init({wasmBinary})`. If it fails the check, every language is
  disabled. If a grammar fails, only its language is. Each failure is logged
  once per process to stderr. `node packages/symbols/scripts/manifest.mjs`
  regenerates the manifest, and `--check` exits 1 if it is stale.
- **MAPPER_VERSION** is `sym1;vtsw0.3.1;wts0.27.0;` plus the first 8 hex of
  sha256 over the manifest's canonical JSON (`JSON.stringify(JSON.parse(file))`),
  so CRLF checkouts or a reindent don't change it. With the committed
  manifest it is `sym1;vtsw0.3.1;wts0.27.0;92c28097`. The test recomputes it
  rather than hard-coding it.
- **`outline()` on an unverified grammar** rejects with
  `SymbolsError` (exported from the package) with `reason: 'grammar_unverified'`.
  S3's `changedSymbols` turns that into `{fileLevel: true, reason: 'grammar_unverified'}`.
  For a language without a table yet (Python, Go, Rust and Java until S2),
  `outline()` rejects with a plain Error.
- **`Outline.items` may hold several items with one key.** That covers TS
  overloads, getter/setter pairs, a struct plus its impls (S2), and every run
  of `@imports` or `@toplevel` that a declaration separates from the next run.
  Adjacent imports merge into one `@imports` item, and adjacent other content
  into one `@toplevel` item. Consumers group by key. The spans of top-level
  items, plus whitespace, partition the file.
- **Lines** are 1-based and inclusive (`endLine` is the line of the last
  character).
- **A container's `text` is its shell.** It is the header up to and including
  the body's opening token, then each piece of content inside the body that
  belongs to no member, then the footer. Each piece is tagged `«key»` with the
  member before it (`«^»` for the start). The parts are joined by one space.
  Adding, removing or editing members, or changing the whitespace between
  them, leaves the shell unchanged. Any other change to the container changes
  it, and so does moving a piece across a member. S3 compares shells as they
  are.
- **Statements with several declarators** (`export const a = 1, b = 2;`) are
  split into adjacent spans. The first declarator's span starts at the
  statement and runs up to the next declarator; the last one's ends at the
  statement end. A later declarator's `text` starts with the statement header
  (`export const `), so a header change touches every key in the statement.
- **Unkeyable names.** String, computed and `#private` member names fold the
  member into its container's shell, as §1.10 says. At top level (TypeScript
  `declare module 'x' {}`, `declare global {}`) the declaration becomes
  `@toplevel` content. §1.10 says "the whole file at top level", but
  `Outline` can't mark a region as whole-file, and no `FileLevelReason`
  fits. `@toplevel` keeps the mapping invariant (the region is claimed as
  `@toplevel`), and it still conflicts with other `@toplevel` edits.
  *Optional amendment, if the integrator prefers file level:* add
  `'unkeyable_name'` to `FileLevelReason` in `symbols/src/types.ts`. S3 would
  then return it for edits touching such a region.
- **Signatures** start at the unwrapped declaration node, as §2.4 says ("from
  the node start"). So `export`/`declare` are not part of them (the §2.5
  example shows `function login(user: string): string`). Decorators and
  comments are dropped. The text is rebuilt from the tokens with a fixed
  spacing rule, so whitespace and comment changes can never alter a
  signature. A variable or field whose value is a function gets a signature up
  to that function's body (`const handler = async (req: Request): Promise<Response> =>`),
  because its parameters are API. Other untyped variables get null.
- **Errors.** An `ERROR` or `MISSING` node is contained when it is a
  descendant of a keyed declaration's body. For functions, methods, classes and
  namespaces that is field `body`; for variables and fields it is the
  initializer (`value`); for type aliases it is the `value`. The innermost key
  is recorded. Any other error makes the outline `uncontained`. `errorKeys`
  lists the keys of the contained errors even when another error is
  uncontained.
- **Performance, measured here** (Node 22, a generated 2000-line TS file, 401
  items). A cold first `outline` takes about 100 ms (module load, init and
  grammar about 60 ms). Warm, it takes about 30 ms: parse about 15 ms and
  extraction about 15 ms, most of the latter in signatures. That puts S4's
  warm budget (< 20 ms for a `changedSymbols`, which is two outlines) out of
  reach with two full parses. S3/S4 should reparse incrementally
  (`tree.edit` plus `parse(after, oldTree)`) and compute signatures only for
  changed keys.
