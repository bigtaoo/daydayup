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
