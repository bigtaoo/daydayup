# Project instructions for Claude Code

## "结束任务" (end task) command

When the user says **"结束任务"**, run this exact sequence, in this exact order:

1. **Update docs and memory first** — design/NN docs, `ROADMAP.md`, README status boxes
   for whatever the task actually shipped, plus the persistent memory system, so both
   describe the final shipped state, not a mid-task snapshot.
2. **Merge the code to `main`** — if the session's work happened on a branch/worktree,
   bring it onto `main` now (cherry-pick or merge, whichever is clean; run the full
   test suite + `tsc --noEmit` after).
3. **Clean up worktree and branch** — once step 2 is confirmed merged (verify with a
   real content diff against `main`, not just `git log`, since a cherry-pick produces
   a new commit SHA even after the content is fully merged), remove the now-redundant
   worktree and delete the branch.
4. **Commit last** — the final commit should capture the fully-merged, fully-cleaned-up
   state, not an intermediate one.

If any step finds nothing to do (e.g. no unmerged branch exists), skip it silently
rather than asking. Treat "结束任务" as a distinct trigger phrase from an ordinary
"commit this" or "merge this" request — it means run the full four-step sequence, not
just whichever single step the wording most resembles.

## Code organization: 500-line file convention

Source files (excluding tests and generated output) should stay at or under 500 lines.
This is a **baseline-drift gate, not a hard cap** — files already over the limit are
tracked as backlog, not blocked on — but design new files to stay under it, and shrink
known offenders over time rather than let them grow further.

When a file does need to be split, pick a form in this priority order — a linear
inheritance chain is the fallback, never the default, and this order applies to new code
too, not just to splitting up something that already got too big:

1. **Independent function modules (preferred).** If the file is really a set of
   independent functions, or an if/else dispatch chain with no shared private state
   (a content table, a router, a batch of pure helpers), split by operation/domain into
   sibling files of free functions. Zero inheritance, zero ceremony.
2. **Independent classes + composition (default for a single class that's grown too
   big).** First count the cross-boundary `this.foo()` calls across the proposed split.
   A short, countable list (rule of thumb: fewer than ~10) means composition works: each
   concern becomes its own class whose constructor takes a typed `deps` object (hand-written
   injection, matching the existing style in this repo — **do not** reach for an IoC
   container such as InversifyJS/tsyringe; that solves "how do I wire up the whole app",
   not "how do I split one class"). Where one side only needs a handful of the other's
   methods, narrow that dependency to a small interface declaring just those methods
   rather than depending on the whole concrete class. A genuine **two-way** dependency (A
   calls B *and* B calls A) is a sign the boundary is drawn wrong — merge the two into one
   class, or extract a shared lower layer both depend on; don't reach for inheritance just
   to route around it.
3. **Linear inheritance chain (fallback only).** Only when ②'s cross-call list can't be
   enumerated — most methods reach across the proposed split — fall back to
   `class B extends A {}` as a mechanical, behavior-preserving split. This has a real
   cost: fields shared across the chain have to widen from `private` to `protected`,
   chain order becomes an implicit constraint, and it does nothing to stop the top-most
   (largest) layer from growing again on its own. Treat it as deferring the problem, not
   solving it.

Practical rules once a file is split:

- Sibling files may import each other or be imported by the assembly shell that
  re-exports them — never the other way around (the shell importing a sibling that
  imports the shell back is a cycle).
- Give each split-out file a one-line header comment naming the split and its
  responsibility.
- If anything outside the module imports the original path, keep that path alive as a
  thin re-export shell (`export * from './xxx/yyy'`) so the split is invisible to callers.

**Enforcement**: `build/checkFileLength.mjs`, driven by each workspace's
`scripts/file-length-baseline.json`. It's a drift check, not a blanket gate — it fails
only if (a) a file *not* already in the baseline crosses 500 lines, or (b) a file already
in the baseline grows past its recorded line count. Run it via `npm run check:filelength`
inside a workspace, or `npm run check:filelength --workspaces --if-present` from the repo
root (also folded into the root `check` script, after `typecheck` and before `test`).
Shrinking a baselined file back under the limit doesn't require touching the JSON — the
script reports it as a non-blocking notice — but delete the stale entry when you do.

This mirrors the convention adopted in the sibling project `funny`
(`claudedocs/server.md` / `claudedocs/client-modules.md`, "单文件 500 行收敛"), scaled
down for this repo's smaller codebase.

## Language policy

- All code, code comments, and documentation in this repository must be written
  in English — no exceptions for design docs, READMEs, or inline comments.
- Commit messages must be written in English.
- The only non-English content allowed anywhere in the repo is translation/localization
  data itself (i18n locale files, e.g. `zh.json`) — content whose entire purpose is to
  hold a non-English translation. English is the source-of-truth locale that all other
  locales key off of / translate from.
- This applies to new content going forward; it does not retroactively require
  rewriting existing non-English comments unless you're already touching that file.
