/**
 * `ENGINE_VERSION` — bumped whenever a change to the deterministic core could make
 * an old recorded input stream diverge (system reorder, fp/brad/table change, new
 * PRNG draw site). design/08: `ReplayInputSource` refuses a mismatched version —
 * fail loud, never replay garbage.
 *
 * The full per-bump history (why v2 through v42 each bump, and the handful of
 * changes that shipped WITHOUT a bump because they were additive/inert for every
 * existing config) lives in ./ENGINE_VERSION_HISTORY.md, not here — it's ~500
 * lines of prose, not code, so a `.ts` doc-comment was never the right place for
 * it (CLAUDE.md "500-line file convention": this was a documentation-placement
 * problem, not one the split-priority list's forms actually address). Originally
 * split out of config.ts as a same-shape `.ts` file (form ①, independent data
 * module); moved to Markdown the same day once that file itself hit 505 lines.
 */
export const ENGINE_VERSION = 42;
