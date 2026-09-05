/**
 * entities/ split (CLAUDE.md 500-line convention, form (1) — independent type
 * modules): faction and team identity, and the single hostility predicate every
 * targeting/damage system routes through.
 */

export type Faction = 'player' | 'enemy';

/** `takeDamage`'s attacker-identity parameter (design/07) is normally a `Faction` —
 * but zone/hazard-tile damage (design/15, ROADMAP 4.2d) has no attacker on the other
 * side at all (unlike a DoT, whose `src` is always "the opposite faction", 07's
 * existing precedent), so it needs its own literal instead of a fake team. */
export type DamageSrc = Faction | 'environment';

/** Match outcome (design/08). Player ids are indices into state.players. */
export type Winner = number | 'enemies' | null;

// ── Team / hostility model (design/15, ROADMAP 4.2a) ───────────────────────────
// `Faction` says "player-controlled vs AI-controlled" — a rendering/event-label
// axis that never had more than two members and still doesn't. It is NOT the
// same question as "who can I damage": PvE never needed a second axis because
// every player was implicitly one team fighting AI, but PvP needs players
// hostile to OTHER players while staying allied with squadmates. `teamId` is
// that second, independent axis.
//
// `teamId` is deliberately NOT derived from seat `owner` (state/commands.ts) —
// existing co-op defaults every seat to a SHARED team (GameState.buildSeat:
// `seat.teamId ?? 0`), so allies never damage each other, exactly as today. A
// PvP arena build (ROADMAP 4.2c, not yet built) assigns each seat its own
// distinct teamId instead; a future squad build assigns the same teamId to
// several seats. Neither needs another schema change — only what a config
// passes in.

/** Anything carrying a team identity — every `Actor` and every `Projectile`
 * (frozen from its owner at fire time, WeaponFireSystem). */
export type Teamed = { teamId: number };

/** Reserved teamId for every enemy (AI never picks a config-supplied team) —
 * guaranteed to never equal a player's teamId (always >= 0), so AI is hostile
 * to every player team by construction and never hostile to other AI. */
export const ENEMY_TEAM_ID = -1;

/**
 * The single predicate that replaces every `faction === 'player' ? enemies :
 * players`-shaped ternary in combat/targeting code (HitResolveSystem,
 * DeflectSystem, ProjectileStepSystem, combat.ts — design/15 called these out
 * by name). Two actors/projectiles are hostile iff their teams differ; same
 * team (squadmates, or two AI) never damage/target each other.
 */
export function isHostile(a: Teamed, b: Teamed): boolean {
  return a.teamId !== b.teamId;
}
