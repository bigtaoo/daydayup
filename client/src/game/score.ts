/**
 * The run's score table.
 *
 * Host-side, not simulated: score is a presentation number the render layer accumulates
 * from engine events (EventReactor) and shows on the result screen (RunOutcome). The
 * engine neither knows nor cares about it, which is why this is not engine content —
 * changing these values can never desync a replay.
 */
export const SCORE = { kill: 5, material: 10, waveClear: 40, victory: 200 } as const;
