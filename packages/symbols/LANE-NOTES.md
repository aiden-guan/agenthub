# Lane S (symbols) notes

No contract amendments and no dependency requests so far. One optional
amendment is described under S1 (unkeyable top-level names); nothing depends
on it.

**Integrator, CP1a: the optional `unkeyable_name` amendment is NOT applied.**
No code would return the new reason, and the `@toplevel` mapping keeps the
§1.10 mapping invariant (the region is claimed, and it conflicts with every
whole-file and `@toplevel` claim). It still departs from §1.10's literal
"the whole file at top level"; that is to be settled at CP3a, when S1-S3 are
the gate. If the whole-file reading is wanted then, the reason gets added and
S3 returns it in the same change.

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

## S2: Python, Go, Rust and Java outlines

Files: `src/languages/{python,go,rust,java}.ts`, plus small engine additions in
`src/outline.ts`, `src/spec.ts`, `src/signatures.ts` and a new `src/text.ts`
(text helpers moved out of outline.ts so tables can use them). No contract
amendments and no dependency requests.

Engine additions (tables opt in; TS/TSX/JS outlines are unchanged):

- **`Decl.region`**: a declaration's body for error containment can be "the
  children of node N from offset F on". Python needs it: tree-sitter puts an
  error in a body's first statement between the header's `:` and the
  (then empty) `block`, as a child of the definition.
- **`Decl.members.from`** and **`LanguageSpec.transparent`**: a container can
  be scanned from an offset, with some node types seen through. A Python class
  is scanned from its `:` (or a comment on the header's line) with `block`
  transparent, because tree-sitter puts the comments right after the `:`
  before the block. So a comment above the first method attaches to it, and
  adding a commented first method leaves the class shell alone.
- **`splitSpecs`** (spec.ts) splits a statement that declares several names:
  Go `const (...)`/`var (...)`/`type (...)` groups and Java `int a = 1, b = 2;`.
  Unlike S1's TypeScript declarators (each runs up to the next declarator),
  each spec but the last ends at its last non-whitespace character, and a
  later spec starts at its own attached leading comments. A trailing or
  detached comment inside a group stays with the spec before it. A later
  spec's text starts with the header (`const ( `, `private static final int `).
- **Comment spans end at their last non-whitespace character.** The Rust
  grammar ends a line comment after its newline.
- **Signature spacing:** each token now carries its node type and its parent's
  type, and `LanguageSpec.space` can override the common rule (Go `[]T`,
  `map[K]V`, `func (r) M()` versus `func(x)`; Rust `pub(crate)`, `&'a [u8]`,
  `&mut [u8]`, `?Sized`; Java `public <T>`, `T... xs`, `<? extends T>`; Python
  `f(x=1)` versus `f(x: int = 1)`). One common-rule fix: a word followed by a
  string literal keeps its space (`default ""`, TypeScript `x is "a"`, a Go
  struct tag). It only changes signatures that were missing that space.

Decisions per language (the design's tables, with these readings):

- **Python.** Decorated definitions unwrap with the decorators in the span.
  Module and class assignments are keyed only for one plain-name target.
  Chained (`X = Y = 1`), tuple, attribute, subscript and augmented
  assignments are `@toplevel` (or shell), like TS destructuring. Nested
  classes are keyed `Outer.Inner` (containers). The design lists only methods
  and assignments as class members, but a nested class is too common to leave
  in the shell. `__init__` keeps its name (`C.__init__`) with kind
  `constructor`. Function and class signatures stop before the header's `:`.
  A lambda value gets `f = lambda x, y`.
- **Go.** No containers. Methods are top-level items keyed
  `<Receiver>.<name>` (`Session.Refresh`, kind `method`). A receiver that isn't
  a plain type name after stripping `*`, parentheses and type arguments
  (`*pkg.T`) makes the method `@toplevel`. A spec with several names
  (`var a, b = 1, 2`) makes its whole declaration `@toplevel`, like TS
  destructuring. `package_clause` (with its doc comment) is `@imports`. Type
  specs are `struct`, `interface` or `type`, with signatures in full after the
  `type` keyword.
- **Rust.** `impl` is keyed by its type, with type arguments *and* a reference
  stripped (`impl Trait for &'a Foo` is `Foo`). A path type (`crate::Foo`) or
  a tuple is `@toplevel`. A struct and its impls share the key `Session`
  (kinds `struct`, `impl`, `impl`). Impl members include associated types
  (`type_item`) besides fns and consts, since they implement the trait's.
  Trait members are fns, signatures, consts and associated types. A bodiless
  `mod a;` is `@toplevel`, the literal reading of "mod_item with a body". A
  refinement could key it, or make it `@imports`. A macro is kind `function`
  with a null signature. Raw identifiers (`r#type`) fail SYMBOL_KEY_RE, so
  they are `@toplevel`.
- **Java.** Annotations sit in `modifiers`, so they are inside the span. They
  are left out of signatures, like decorators. Interfaces and annotation types
  are containers, so their signature is up to the body, not the full text the
  design gives for (TS) interfaces. Their members carry their own signatures.
  An enum's members are the declarations after its constants. The constants
  are part of its shell. Its signature is the header plus the constants
  without their class bodies (`enum Role { ADMIN("a"), USER("u") }`). A record's
  compact constructor is `R.constructor`.
- **Errors, as tree-sitter places them** (tested):
  - Python: a body error is contained, even in the first statement.
  - Go: an unclosed brace makes the function swallow the next one. That is
    contained in the function, and the swallowed key disappears (§4.2 #3).
  - Rust: an unclosed brace and a broken header are uncontained.
  - Java: everything sits in a class body, so a broken method header is
    contained in its class. Only a broken top-level header is uncontained.

Measured here (Node 22, warm `outline` of a ~2000-line file): Python 25 ms,
Go 18 ms, Rust 25 ms, Java 29 ms, TypeScript 25 ms. Random-edit fuzzing of all
seven fixtures (28,000 edits, scratch script, not committed) found no outline
that breaks the structural guarantees `expectWellFormed` checks.

## S3: edit mapping (applyEdit, changedSymbols)

Files: `src/edit.ts` (`applyEdit`, and `applyEdits` for MultiEdit), `src/diff.ts`
(`changedSymbols`), with small additions to `src/outline.ts` (an optional
`ItemDetail` map: which items are containers, and each declaration's body
span), `src/runtime.ts` (`MAPPER_VERSION` now lives here so `diff.ts` can use
it; `index.ts` re-exports it, unchanged), `src/signatures.ts` (`truncate`
exported) and `src/index.ts`. No contract amendments and no dependency
requests.

For lane A (pre-edit, post-edit, guard) and lane L (admission, landed changes):

- **`applyEdit`** mirrors the Edit tool: old_string must occur, counted left to
  right without overlaps (the tool splits on it); exactly one occurrence
  without `replace_all`, every one with it; `old_string === new_string` fails;
  an empty old_string only fills an empty or blank file; new_string is
  literal (no `$&`). One quirk of the tool is mirrored too: deleting text that
  doesn't end with a newline (empty new_string), when the file holds it
  followed by one, deletes that newline as well. Not mirrored: the tool's
  curly-quote and line-ending tolerance. Such an edit returns null here, so the
  hook claims the file (`edit_not_applicable`), and post-edit re-reads and maps
  what was actually written.
- **`applyEdits(before, edits)`** (MultiEdit) is a named export of the package,
  not part of the frozen `Symbols` interface: the edits in order, each on the
  result of the one before, null if any fails.
- **Fallback order:** `unsupported_language`, `excluded` (contract
  `matchesAny(path, exclude)`, the path as given: repo-relative, forward
  slashes), then the null sides (`new_file`, `deleted_file`), `too_large` (over
  1 MiB in UTF-8 bytes on either side), `binary` (a NUL among the first 8192
  characters of either side), `grammar_unverified`, `parse_error`.
  `disabled`, `whole_file_write` and `notebook` are the callers' to return.
  Identical sides, both null included, give an empty symbol-level diff.
  Errors other than `SymbolsError` (a parser failure) propagate: treat a throw
  as file level.
- **Changed keys** are the union of the design's rules, with moves detected at
  *every* level, not only the top. Inside a pair of matched containers the
  member keys are aligned by LCS too, otherwise reordering two methods would
  claim nothing but `@toplevel` while their text moved. Each run of a
  container's own text between two members (a computed member, a stray
  statement) takes part in that alignment as an element of the container's.
  Every matched pair is compared by its exact span text, and a container by
  its shell. Shells are compared as S1 builds them.
- **A key whose container is also claimed is dropped** (`Session` covers
  `Session.refresh`, by `entryCovers`, and conflicts with every claim on it).
  So a class rename is 2 keys (`Session`, `Store`), not 2 × (1 + members).
- **`errorKeys` of both sides are claimed**, a pre-existing contained error
  included (§2.4 step 4).
- **`@toplevel`** is returned for a whitespace-only change even when neither
  side has a `@toplevel` item.
- **`maxSymbols`** defaults to 12; `Infinity` disables the limit. Keys are listed
  in source order: `before`'s, then those only `after` has.
- **The LCS** matches the common prefix and suffix directly, then aligns the
  middle by dynamic programming up to 4M cells. Beyond that (thousands of items
  between two far-apart edits in a huge file), the middle counts as moved: all
  claimed, so in practice `too_many_symbols`.
- **`signatureChanges`.** A key's signature is its items' signatures joined with
  `\n` (TS overloads; a Rust struct and its impls, which share the key). The
  joined texts are compared whole, and each reported text is cut to 500
  characters (an ellipsis last), as the hub's `SymbolChangeInput` requires.
  `renamed` compares the declaration *body* (the table's body node: a function
  body, an initializer, a class body, a Python definition after its `:`),
  whitespace collapsed. So a rename that also changes the parameters is still a
  rename, with the new signature as `after`. A key with no body is never a
  rename candidate. The members of a renamed class are reported as renamed too
  (`Session.refresh` → `Store.refresh`) when their bodies are unique.
- **The property test** (`test/mapping-property.test.ts`) checks the §1.10
  invariant in an alignment-free form: on each side, blank out the returned
  keys' spans (a container's covering its members) and the gap whitespace
  (between top-level items, and between a container's members); the remaining
  text must be identical. A fixed alignment (common prefix and suffix) would
  blame a declaration the edit merely shifted. The generator inserts, deletes
  and replaces lines (from the fixture and per-language snippets), moves runs
  of lines and whole declarations (top level or members), and edits a few
  characters, starting from the fixture or from an already edited version. It
  runs 500 seeded edits per fixture in CI (about 10 s). It also passed at 5,000
  per fixture (35,000 edits, about half of them symbol-level), and it fails when
  move detection, the member recursion or the `@toplevel` rule is disabled.
  The own-text runs are covered by a unit test in `diff.test.ts`, since random
  edits rarely produce that shape. `SYMBOLS_PROPERTY_SEED=<n>` replays a case,
  and `SYMBOLS_PROPERTY_EDITS=<n>` changes the count.
- **Performance, measured here** (Node 22, a generated 2000-line TS file, one
  body edit): a cold first `changedSymbols` (import, init, grammar, two
  outlines) takes about 390 ms, and a warm one 75 ms median (90 ms p95). Of
  the warm time, the diff itself (`diffSides`) is about 2 ms. The rest is two
  full outlines (parse about 10–25 ms each, plus extraction, mostly
  signatures). S4's budgets (< 150 ms p95 cold, < 20 ms warm) need what S1's
  notes propose: an incremental reparse of `after` from `before`'s tree, and
  signatures computed only for the keys that changed. `diffSides(b, a, max)`
  takes already-outlined sides, so S4 can feed it whatever outlines it caches.

## S4: signatures, references, performance

Files: `src/signatures.ts` (`signatureOf`, and `signatureChanges` moved here
from `diff.ts`), `src/references.ts` (new: `referencesIn`, `identifierIndex`,
`freeKeys`, `importsText`), `src/document.ts` (new: parsed documents,
incremental reparsing, the document cache), with changes to `src/outline.ts`
(lazy signatures, `ExtractOptions`, carrying top-level items over),
`src/diff.ts` (works on documents), `src/languages/index.ts` (tables load on
first use), `src/runtime.ts` (the grammar is hashed while the runtime WASM
compiles; manifest lookups use `Object.hasOwn`) and `src/index.ts`. Tests:
`signatures.test.ts`, `references.test.ts`, `incremental.test.ts`,
`perf.test.ts`, and `random-edits.ts` (the seeded edit generator, moved out of
`mapping-property.test.ts` and shared). No contract amendments and no
dependency requests. Nothing in the frozen `types.ts` changed meaning; the
notes below are how the implementation reads its doc comments.

For lane A (pre-edit deny messages, post-edit, `relevant()`, `who_uses`,
`callers_free`, the refcache) and lane H:

- **`referencesIn(path, source, names)`** returns a Map holding **only the
  names that are used**, in the order of `names`. So `refs.size > 0` is "some
  reference", which is how §2.5's `relevant()` reads it; use
  `refs.get(name) ?? []`. Each value lists keys once, in order of first use.
  A name is matched against identifier tokens exactly (`login`, not
  `Session.login`; pass the change's `name`, its last segment).
- **What counts:** identifier tokens (`identifier`, `property_identifier`,
  `type_identifier`, `field_identifier`, the shorthand property and field
  names; Python attribute names are `identifier`s). Comments and string text
  never count. Code inside a string does: a template substitution, an f-string
  interpolation. So do JSX tag and attribute names and the tokens of Rust macro
  calls. Go package qualifiers in types (`auth.Session`'s `auth`) don't
  (`package_identifier`), while `auth.Login(...)`'s `auth` does.
- **Attribution:** the innermost item: a member (`Router.handle`), a
  container's own text (`Router`, e.g. `extends Base`), a top-level key,
  `@imports` or `@toplevel`. A **declaration's own name is not a use**: in each
  item, the first identifier spelled like the last segment of its key, before
  its body, is skipped. A recursive call still counts. So `who_uses` needn't
  drop the declaring key itself, but sites in `@imports` are just the import of
  the name: `who_uses` probably wants to leave those out of `callers_free`.
- **`identifierIndex(path, source)`** returns a **null-prototype object**
  (`constructor`, `__proto__`, `toString` are ordinary identifier names). It
  serializes as plain JSON; after `JSON.parse`, look names up with
  `Object.hasOwn(index, name)`, never `index[name] ?? []`, or `toString` finds
  the prototype's. It agrees with `referencesIn` for every name (tested).
- **`freeKeys(path, source, held)`**: top-level keys only, once each, in source
  order, `@imports` and `@toplevel` included (`@imports` stays free even when
  `@imports` is held: they never overlap). `held` entries are taken as entries
  of this file, compared with `entriesOverlap`, so the **caller does the mapper
  gating**: pass `{}` (no `symbol`) for a whole-file claim and for any claim
  whose mapper is not comparable with ours. A held member makes its container
  non-free. Returns null when the file can't be mapped at symbol level
  (unsupported, unverified grammar, binary, over 1 MiB, or an uncontained parse
  error: then any edit is file level anyway).
- **`importsText(path, source)`**: one statement per line, in source order,
  comments removed and whitespace collapsed; `''` with none. It includes
  imports anywhere in the file (a Python import inside a function, a Rust `use`
  in a function or module), TS/JS re-exports (`export ... from`), `require('x')`
  and `import('x')` calls, Rust `extern crate` and bodiless `mod x;`. It
  excludes Go's `package` clause and Java's `package` declaration.
- **Import-filter gaps worth knowing (advisory warnings, so false negatives
  only):** a Java class in the same package needs no import, and Rust can call
  `crate::auth::login()` without a `use`. Lane A may want to treat Java (and
  Rust paths) like Go: the same directory passes the filter.
- **Constructors:** a change to `Session.constructor` (TS, Java) or
  `Session.__init__` (Python) has `name` `constructor`/`__init__`, which callers
  never spell (`new Session(...)`, `Session(...)`). If lane H (which derives
  `SymbolChange.name`) or lane A wants those to reach callers, match the
  container's name for constructor keys.
- **null** from `referencesIn` and `identifierIndex`: unsupported language,
  unverified grammar, binary, or over 1 MiB. A file with a parse error still
  gets its identifiers (names are advisory).

Performance (design §2.4), for lanes A and L:

- **Lazy signatures.** Computing every signature was about two thirds of an
  outline. Documents leave `Item.signature` null and compute a signature on
  demand from the tree; `signatureChanges` asks only for keys whose text
  differs (same text, same tokens, same signature). `outline()` still returns
  every signature.
- **Incremental reparsing.** The side of a diff that isn't cached is parsed
  from the other side's tree (`tree.edit` of a copy with the common prefix and
  suffix, then `parse(text, old)`). An incremental parse that reports a syntax
  error is redone from scratch: error recovery can depend on history (Java
  differed in 7 of 294 such trees when measured), while error-free trees were
  always identical. `incremental.test.ts` checks the tree and the full outline
  (signatures included) against a fresh parse along chains of seeded edits
  (300 per fixture in CI; it also passed at 4,000 per fixture).
- **Carried-over items.** An incremental parse keeps the subtrees outside the
  edit, with the same node ids. A top-level node with the same id as in the
  base document gets the base's classification, and its items are moved to
  their new offsets when the item's span text is identical (so its attached
  comments are too). A moved item's signature is found again in the new tree
  by node type and range. Python's indentation scanner rarely lets top-level
  subtrees be reused, so Python gets little of this (it is just slower there).
- **The document cache.** Per runtime, the 8 most recent documents (at most
  2M UTF-16 units of text together), trees included, keyed by language and
  exact text. Each edit's `before` is usually the previous edit's `after`, so a
  process that maps a sequence of edits parses each text once, incrementally.
  `referencesIn`, `identifierIndex`, `freeKeys` and `importsText` use it too
  (a deny message's `freeKeys` right after `changedSymbols` costs nothing).
  Evicted trees are deleted on `setImmediate` (off the caller's path), at most
  8 waiting. Every use of a document is synchronous after the grammar await, so
  nothing is evicted mid-use.
- **The cold path:** only the needed language table is loaded (the other five
  cost 5–8 ms to import), and the grammar file is hashed while the runtime WASM
  compiles.
- **Measured here** (Node 22, 4 cores, `npx vitest run
  packages/symbols/test/perf.test.ts`, the file alone): cold (a fresh process
  importing the built package and mapping one body edit of a generated
  2000-line TS file) p95 132–136 ms, median 106–113 ms (import 21 ms, the rest
  init, grammar and two parses), budget p95 < 150 ms. Warm, an editing session
  (each `before` the previous `after`): median 2.1 ms, p95 4–5 ms, budget
  < 20 ms. Warm, a version of the file the process hasn't seen (one full parse
  is 15 ms of it): median 18.6–19.6 ms. Before S4: cold p95 244 ms, median
  186 ms; warm 51 ms. Under `npm test` other files run in parallel and the cold
  numbers rise (p95 about 190 ms with the hub's race tests running); the log
  line prints the load average. The cold script preloads `node:crypto`: the
  hook's own `fetch` to the hub loads it anyway (16 crypto modules after one
  `fetch`), so it isn't a cost symbols adds; without the preload, add about
  7 ms.
- For the hook, the remaining cold cost is mostly WASM: the first parse of a
  2000-line file runs in baseline-compiled code (30 ms, against 15 ms warm),
  and module import, runtime init and grammar load take about 40 ms together.
  If that matters, §7.2's long-running mapping server would make every call
  warm.

## Integrator, CP2 (with CP3a)

No new commits on `p23/symbols` in this stage: S1–S4 were merged at CP1a, so CP3a's "S1–S3 merged" holds. No requests queued; nothing applied.

**Ruling deferred from CP1a, settled now: unkeyable top-level names stay `@toplevel`; the optional `unkeyable_name` amendment is not applied.** §1.10's "the whole file at top level" is read as the conservative intent, and `@toplevel` meets it where it matters: the region is claimed (the mapping invariant holds, property-tested in S3), and it conflicts with every whole-file and `@toplevel` claim. Treating it as the whole file would also block agents editing unrelated declarations of the file, which costs parallelism without protecting anything: claims are coordination, and the merge ladder and the checks are the gate (§4.2). If CP3's e2e or dogfood shows otherwise, the amendment is additive (`FileLevelReason` gains `'unkeyable_name'`) and S3 returns it in the same change.

## Integrator, CP3

No new commits on `p23/symbols` in this stage (S4 has been in since CP1a). No requests; nothing applied.

- **Open for lane S (from H6's notes): long signatures.** `signatureChanges` compares signatures whole but reports them cut to 500 characters. A change past the 499th character therefore reaches the hub with `before == after`, and the hub withdraws the open row (or records no landed one). A fix belongs here: for example, cut both sides around their first difference. README Limits states it meanwhile.
- **For a new language:** the adapter's `symbol-scope.ts` keeps the seven languages' extensions as a fast filter (A3). A language added here is claimed whole-file until it is added there too.
- **The `unkeyable_name` ruling stands.** Neither the CP3 e2e nor the demo's Part 3 showed a case for it.
