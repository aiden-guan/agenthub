# @agenthub/gitops: lane L notes

## L1 (done)

Every function of the frozen `GitOps` interface (`src/types.ts`) is implemented in `src/*.ts` and exported from `src/index.ts`, both as named exports and as `gitops`. No npm dependencies. Verified against git 2.43.0 on the build machine (`merge-tree --write-tree -z --merge-base` and `--attr-source` both work there).

### Contract amendment requests

None required. One optional, additive request for the integrator:

- `MergeResult` (`packages/gitops/src/types.ts`) could gain `structural: string[]`: the paths whose stage-2 (structural driver) blob was spliced in. `mergeTrees` already returns it (`MergeTreesResult extends MergeResult`, exported from `@agenthub/gitops`), and the lander needs it for `resolved_by: structural` and the per-file `via`. Until then, L3 reads it through the named export's wider type; a fake `GitPort` can return it too.
  - **Integrator, CP1a: APPLIED** as a required field, `structural: string[]`, on the frozen `MergeResult`. `GitOps.mergeTrees` callers see it through the frozen interface; fakes must return it (`[]` without drivers). `MergeTreesResult` still compiles unchanged and can be dropped by lane L at leisure.

### Additive exports (not in the frozen interface)

- `GitError` (`args`, `code`, `stdout`, `stderr`, `timedOut`): what `Git.run` rejects with.
- `MergeTreesResult`, `parseMergeTree`, `conflictsOf`, `conflictedNames`, `spliceOids` (splice blobs already in the object database).
- `classifyPush`, `porcelainLines`, `TRAILER_KEYS`.

### Behaviour other lanes rely on

- **Isolated `open`** drops every inherited `GIT_*` variable, then applies the caller's `env`, then the isolation env (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `HUB_GUARD=off`), which nothing can override. Isolation's `-c core.hooksPath=/dev/null -c gc.auto=0 -c merge.conflictStyle=diff3` come after any `with()` config, so they can't be overridden either. Pass the committer identity (and, in tests, fixed dates) through `open(dir, {isolated: true, env})`. An isolated `fetch` always gets `--no-write-fetch-head`.
- **Non-isolated `open`** (the adapter) keeps the user's environment, `GIT_INDEX_FILE` and `GIT_DIR` included (so the guard works inside git hooks).
- Both modes set `LC_ALL=C`, because gitops parses git's messages.
- With `timeoutMs`, git runs in its own process group, and the whole group is killed at the deadline (`GitError.timedOut`).
- A local ref-lock error (`Unable to create '….lock'`) is retried 3 times with jitter.
- Credentials in URLs are redacted from `GitError` messages and push `detail`s.
- **`mergeTrees`** with `drivers` needs a bare repository (it writes `info/attributes`) and throws otherwise. On a bare mirror it truncates a leftover `info/attributes` before stage 1, and merges on one mirror are serialized within the process.
- **`ConflictKind`** comes from git's message types: `CONFLICT (binary)` → `binary` (git also reports `contents` for it), `modify/delete` → `modify_delete`, any `rename/*` → `rename`, `distinct modes` (a file against a symlink) → `mode`, `contents` → `content`, anything else → `other`. `mode` on an entry is stage 2's, else 3's, else 1's.
- **`landedBase`** throws when trunk and tip share no history. Sources that aren't commits in the repository are skipped.
- **`trunkTrailers`** with `limit` returns the newest `limit` commits, oldest first. A trailer key given twice with different values reads as `null`. `findLandingCommit` has no limit (git greps for the source sha first).
- **`sanitizeMessageText`** turns CR, CRLF, U+2028/2029 and NEL into `\n` before filtering lines, so a hidden line break can't smuggle a trailer through. It removes C0/C1 controls (except tab and newline), bidi controls and zero-width characters, and caps at `max` UTF-16 units, the trailing `…` included.
- **`replay`** throws on a root commit. A merge commit anywhere in the list returns `{kind: 'merges'}` before anything is written.
- **`stashCreate`** runs `git stash create` on a temporary copy of the index, because git refreshes and rewrites the index it works on (verified: a racy index changes). The real index stays byte-identical.
- **`pushTrunk`** throws, before any push, on a non-full sha, `C^1 != expected`, `expected` not an ancestor, a remote that starts with `-`, or a trunk name that isn't a plain branch. Its outcome is read from the trunk ref's porcelain status line; an atomic failure is classified by the ref that caused it. Deleting a land ref that is already gone succeeds (git only warns).
- **`pushRef`** accepts only `<prefix>land/…` and `<prefix>cand/…`, where `prefix` is `refs/…/`. The refspec has no `+` and no `--force`. Deleting a missing ref returns `ok`.
- **`lsRemote`** matches the ref name exactly (`ls-remote` itself matches by suffix).
- **`approvalDigest`**: a missing blob is the empty string. Lines are `kind\0path\0blob…\n`, sorted by UTF-8 bytes. `protected` and `merged` take exactly 2 blobs, `ai_resolution` takes 4, and every blob is a full object id or null.

## L2 additions (additive exports, not in the frozen interface)

- `mergeFile(g, {trunk, base, yours}, labels?)`: `git merge-file -p --diff3 -L trunk -L base -L yours` over three blob ids (null = absent, merged as empty), from temporary files; writes nothing to the repository. Returns `{text, conflicts, markerSize}`. The markers are one longer than the longest run of `<`, `=`, `>` or `|` at the start of any input line (at least 7), so the regions can always be parsed back. Blobs are decoded as UTF-8.
- `pathHistory(g, from, to, path, limit)`: first-parent commits in `from..to` (null = all) that changed `path` against their first parent, newest first, at most `limit`, each with its `subject` and the same trailer fields as `trunkTrailers`. The path is literal (`GIT_LITERAL_PATHSPECS`). Tests: `test/history.test.ts`.
