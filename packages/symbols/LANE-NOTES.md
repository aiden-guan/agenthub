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
