/**
 * Plain-data entity types for the deterministic sim (design/08 "GameState is plain
 * data, no Pixi, no methods that decide outcomes"). All positional/velocity state is
 * Fp (fixed-point, design/06) and all angles are Brad (binary-radian). Systems are the
 * only code that mutates these; render/server only read.
 *
 * SPLIT 2026-09-05 (CLAUDE.md "500-line file convention"): this file reached 499 lines
 * and the next field to land on `PlayerActor` would have crossed the gate. It is a set
 * of independent type declarations with no shared private state, so it took form (1) —
 * sibling modules by domain — and this path stays alive as a re-export shell so no
 * caller outside `state/` had to change. Siblings may import each other (actors needs
 * teams and weapons); none of them may import this shell back.
 */
export * from './entities/teams';
export * from './entities/weapons';
export * from './entities/actors';
export * from './entities/projectiles';
export * from './entities/world';
