// Split out of Actor.ts (2026-09-02, 500-line convention, form ① — a content table with its
// own rationale, the same shape as `skinRegistry`'s BODY_FILL or `theme.ts`): how far off the
// ground an actor's BODY is drawn, which is two independent numbers with two independent
// derivations and a great deal of measured reasoning behind each. Nothing here decides
// gameplay — both are render-only height (design/01 "Actors stay grounded... `z` never gates
// gameplay"); `z` itself comes from the engine and is 0 for every actor.

// How far (× body radius) to lift the sprite so the ground anchor sits at the feet.
// Bigger → more of the body rises above the anchor → more it can overlap a pillar.
// Applies to the Graphics PLACEHOLDER only: a real rig already encodes its own hover
// height in its body bone's length (orb-core's `shell` is 46 authoring-px of "floats
// this far above the ground point", design/12/13's "it floats, there is no walk cycle"),
// and RigSkin draws that bone's art on its tip — lifting it a second time here would
// double-count and leave the body visibly detached from its own shadow.
export const BODY_LIFT_R = 0.7;

/**
 * Idle hover, in world px of render-only height (`Entity.visualZ`), per body archetype
 * (2026-08-18 depth pass, user report *"希望能再强化一下立体效果"*).
 *
 * design/13's hero and its floating enemy forms do not walk — "it floats, there is no walk
 * cycle" — and their rigs' `idle` clips already bob the ART (orb-core's shell/eye/belly all
 * translate -6 authoring px, `public/skins/orb-core/animation.json`). What that clip
 * *cannot* do is move the SHADOW, because a clip only knows about bones: the body rose and
 * its shadow stayed exactly as wide and as dark as when it was on the floor, which reads as
 * a sprite sliding up and down a flat backdrop rather than a body leaving the ground. This
 * lifts the whole entity instead, so `Entity.applyTransform` shrinks, fades and slides the
 * shadow with it. The two stack deliberately: the clip animates the body's own parts, this
 * animates the body's height.
 *
 * `base` is a constant lift (a floater rests off the floor), `amp` the swing around it —
 * both kept small, since the camera zooms ~4x in a room and these are world px. A grounded
 * archetype (critter-core, brute-core) gets no entry and never leaves the floor.
 */
export const HOVER: Readonly<Record<string, { base: number; amp: number; periodMs: number }>> = {
  char_vanguard: { base: 8, amp: 2, periodMs: 2400 },
  char_skirmisher: { base: 8, amp: 2, periodMs: 2100 },
  char_juggernaut: { base: 7, amp: 1, periodMs: 2900 },
  'floater-core': { base: 8.5, amp: 1.5, periodMs: 2000 },
  'boss-core': { base: 8, amp: 2, periodMs: 3200 },
};
// Roughly doubled 2026-08-19 (volume pass, measured). At base 3.5 the height-driven shadow
// OFFSET is `3.5 * SHADOW_SLANT` = (1.5, 0.8) world px — under one screen pixel at a normal
// zoom, so the cue this table exists to produce was arithmetically invisible however carefully
// it was tuned. At base 6 / peak 9.5 it was (2.5, 1.3) to (4.0, 2.1), which at this camera's
// ~4x room zoom is 10-16 screen px of separation between a body and its own shadow. Deliberately
// not raised further: past ~10 px the character stops reading as hovering and starts reading as
// flying, so the rest of the readability comes from `SHADOW_LIFT_FALLOFF` instead.
//
// **Retuned again 2026-08-21 — the 2026-08-19 pass only quoted its base-to-peak half.**
// `visualZ = base + amp * sin(t)` swings across its FULL `[base - amp, base + amp]` range, and
// the TROUGH of that swing was never checked against the "under one screen pixel" floor the
// table exists to clear. Measured (`char_vanguard`, unchanged base=6/amp=3.5): the trough sat
// at 2.5, an offset of `2.5 x SHADOW_SLANT` = (1.05, 0.55) world px — the Y axis is UNDER one
// screen pixel even at the game's maximum room-zoom (1x, `FxController`'s `Math.max(1, ...)`
// floor, reachable on a small viewport framing a large room), and the X axis clears it by only
// 5%. Two archetypes also broke the OTHER bound at their peak: `floater-core` (8+4=12) and
// `boss-core` (7+4=11) both exceeded the ~10 px "still hovering, not flying" ceiling the 08-19
// pass itself set two paragraphs up.
//
// Every entry below now keeps its WHOLE swing inside `[6, 10]` world px — trough at least 6
// (Y offset >= 1.32 screen px at zoom 1, a real margin rather than a near-miss; X >= 2.52),
// peak at most 10 (the existing ceiling, never raised). `char_juggernaut` sits in the narrower
// `[6, 8]` sub-band (steadier, "heavier" than the other two hero forms, same relative shape its
// old base/amp already had); `floater-core` sits in `[7, 10]` (rests visibly higher even at its
// lowest, matching its "already airborne" flavor). Periods are untouched — this is a range fix,
// not a speed one. `Actor.test.ts`'s hover coverage now samples the whole cycle rather than
// asserting only the half that used to be safe.
