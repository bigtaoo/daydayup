/**
 * Placement tuning constants shared by every ./dungeon/place*.ts file (split out
 * of dungeon.ts, CLAUDE.md "500-line file convention", form ①). Module-internal
 * (an "internal, unexported module constant" per dungeon.test.ts's own comments
 * on these values) — not re-exported through ../dungeon.ts's barrel, exactly as
 * before the split.
 */

/** How wide a door's passage is, in grid units — matches `world/rooms/ember.ts`'s
 * existing `DOOR` constant (the visual scale every hand-authored piece was built
 * against). */
export const DOOR_WIDTH_GRID = 4;
/** How far a door's center must stay from a room's own top/bottom edge, so a
 * carved gap never lands in (or beside) the corner a room's north/south wall
 * claims. A generic layout margin — this module does not need to know any
 * particular content piece's own wall-authoring convention. */
export const DOOR_EDGE_MARGIN_GRID = 1.5;
/** "~5 positions per wall" (design/05) — evenly-spaced candidate anchors a door's
 * center is drawn from, so placement is never wall-centered but also never
 * unbounded-arbitrary at generation time. */
export const DOOR_ANCHOR_COUNT = 5;
/** How far inside a room, off its entry door, the force-regroup landing point /
 * a mid-floor room's default spawn sits. */
export const ENTRANCE_INSET_GRID = 1.5;
/** Vertical gap between two stacked fork siblings (module doc "fully-realized
 * branching") — keeps their AABBs from touching/overlapping; same order of
 * magnitude as `DOOR_EDGE_MARGIN_GRID`, just a distinct constant since it governs
 * room-to-room spacing, not a door-to-wall-edge margin. */
export const BRANCH_GAP_GRID = 2;
