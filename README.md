[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mahgal/mend-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mahgal/mend-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and they get them wrong in characteristic ways: a unified diff
with wrong line numbers, a SEARCH/REPLACE block whose old text drifted a few spaces,
a V4A patch, a text-editor tool call as JSON. mend reads all four to one written
specification, finds the lines each edit names even when the model drifted their
whitespace or indentation, and changes every file or none — then prints what it
changed, or why it failed.

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122). Referral code: `6d6dq8sh`.

## Usage

Node 22, standard library only, nothing to install:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is absent or
  is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`
  or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it,
  and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Formats

**Unified diffs.** Sections start at `diff --git` or at a `---`/`+++` pair; hunks are
applied by content, not by their line numbers — each hunk takes the occurrence
nearest to its (possibly wrong) old start, adjusted for earlier hunks. Creations,
deletions and renames are all supported, as are `\ No newline at end of file`
markers and CRLF files.

**SEARCH/REPLACE blocks.** A path line, `<<<<<<< SEARCH`, old lines, `=======`, new
lines, `>>>>>>> REPLACE`. Empty old lines create the file; otherwise the old lines
must occur exactly once at their tier.

**V4A patches.** `*** Begin Patch` … `*** End Patch`, with `*** Add File:`,
`*** Delete File:` and `*** Update File:` sections. Update chunks are found with a
cursor and an optional `@@` anchor, so repeated blocks are disambiguated in order,
and `*** End of File` anchors a chunk to the end of the file.

**JSON edits.** One JSON array of edit objects, or JSON Lines with one edit object
per line: `create` (writes `file_text` byte for byte), `str_replace` (exact, exactly
once, CRLF-aware) and `insert` (by line number).

## Matching

An edit's old lines are found at the first of three tiers at which they occur at
least once:

- **tier 0:** every line equal;
- **tier 1:** every line equal once trailing spaces and tabs are removed;
- **tier 2:** every line equal once leading and trailing spaces and tabs are removed.

At tier 2, new lines are re-indented to the file's indentation, and context lines
are always written as the file's own matched lines, never the patch's.

## Exit codes and output

- **Exit 2**, one line, nothing written: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>` (the 1-based patch line that could not be
  read). A usage error wins over everything; a parse error is reported before any
  file is looked at.
- **Exit 1**, nothing written: one line `error: <code> <path>` per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), in the patch's order,
  then `failed: <k> of <n> edits`. A failed edit changes nothing, later edits still
  run, and when any edit failed no file is written.
- **Exit 0**: one line per changed path, in byte order — `A <path>`, `D <path>`,
  `M <path>`, or `R <old> -> <new>` for a move — then `ok: <n> files`
  (`ok: 1 file` when n is 1). A patch that changes nothing prints only
  `ok: 0 files`.

## Examples

```sh
# Apply a unified diff, a SEARCH/REPLACE patch, a V4A patch, or JSON edits.
node main.ts fix.patch
node main.ts --format=search-replace edit.txt
cat patch.json | node main.ts

# Dry run: same output and exit code, nothing written.
node main.ts --check fix.patch

# Exact matching only.
node main.ts --strict fix.patch
```

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner, kept as it is. When `MAKEFUN_ENV_URL` is
  set, `main.ts` hands the trial over to it.
- `check.ts` — runs `main.ts` on the kit's public practice set:
  `node check.ts <practice.json>`.
- `SPEC.md` is not shipped here; the specification it implements is the one in the
  competition kit (`starter/SPEC.md`).

## Tests

- Kit practice set: **100 of 100 passed** (practice score 1000).
- A self-written edge suite of **194 cases** covering the specification sentence by
  sentence (invocation, output, paths, format detection, the three matching tiers,
  each format's parse errors and failure codes, ordering and atomicity):
  **194 of 194 passed**.
- A mock trial env confirms the `MAKEFUN_ENV_URL` hand-over posts correct results.

## License

MIT. See `LICENSE`.
