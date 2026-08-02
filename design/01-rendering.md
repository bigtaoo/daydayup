# Rendering & depth architecture

Goal: a fixed tilted view (not pure top-down; slightly forward-leaning, like Soul Knight) that produces playable spatial relationships with 2D techniques.

## View

- **Tilted (3/4) view:** walls, pillars, and characters show a small "front face" instead of a pure top face, so height and volume read. This is the basis of the 3D feel.
- The camera has a fixed angle and never rotates; it may pan to follow the player.
- **Small-room zoom-to-fit** (legibility fix, 2026-08-02): a room smaller than the
  viewport is scaled up (contain-fit against the tighter axis, capped at 1.8x so a
  tiny/degenerate room doesn't blow sprites into blocks) instead of sitting centred in
  a sea of black canvas backdrop — `FxController.updateCamera` (`client/src/game/fx/FxController.ts`).
  A room/arena that already covers the viewport at 1x is untouched (zoom floors at 1,
  never shrinks). `CommandBuilder` divides the screen-space mouse aim point by this
  same zoom before converting it to world space, or a zoomed room would aim wrong.

## Coordinates & height model

Every entity has two Y values:

- **Ground coordinates `gx, gy`** — used for depth sorting, shadows, and collision.
- **Height `z`** — visual lift for flying bullets / elevated cosmetics (render only). Actors stay grounded (`z=0`) — there is no jump, and `z` never gates gameplay (`07`).

Render transform: `screen.x = gx`, `screen.y = gy - z`. A large part of the 3D feel comes from objects being able to leave the ground.

## Depth sorting (Y-sort)

- The entity layer sets `sortableChildren = true`; each frame we set `entity.zIndex = entity.gy`.
- Lower on screen (larger gy) draws later → occludes objects above it. A character walking behind a pillar is hidden; in front, it hides the pillar.

## Shadows

- When lifted, a soft shadow is drawn at the **ground coordinates** (`shadow.gy = gy`, unaffected by z).
- The shadow shrinks, fades, and offsets slightly as `z` grows → reinforces the sense of height. This is the cheapest "3D cheat".

## Layers (bottom to top)

| Layer | Contents | Sorting |
|-------|----------|---------|
| ground | floor, ground decals | fixed |
| shadow | all cast shadows | fixed (below entities) |
| entities | characters / enemies / pillars / bullets | **Y-sort (zIndex = gy)** |
| fx | muzzle flashes, explosions, deflect flashes, per-element bullet trails (additive blend) | overlay |
| ui | HP, weapon, crosshair | topmost |

> The lighting layer (lightmap) is later inserted between entities and fx, composited with multiply blend. See the roadmap.

## Per-weapon local z-order

A weapon is attached to one of the character's orbiting weapon sockets (`02`/`13`) and rendered separately, and must switch front/back by facing:

- Facing up (dy < 0): weapon renders **behind** the body (weapon.zIndex = -1 inside the actor container).
- Facing down / sideways: weapon renders **in front** (weapon.zIndex = +1).
- The actor container itself has `sortableChildren = true`, with body.zIndex = 0.

Otherwise you get the "gun floating on the chest while facing away" artifact.

## Limits of fake 3D (honest note)

2D sorting is per-object, not per-pixel. The following cases break and must be avoided or accepted as approximations:

- One large sprite partially in front of and partially behind a tall object (crossing a thick pillar) → judged wholly front or back, artifact at the seam. Mitigation: split tall objects into segments, tune anchors carefully.
- Complex multi-layer occlusion → sorting rules must be refined.
- Continuous slopes / height transitions → approximation only.

For this game's scale (rooms, pillars, crates, enemies) these are largely avoidable. If true continuous 3D occlusion is needed → fall back to a Three.js orthographic camera (see the re-evaluation trigger in 00, Decision 1).

## Fidelity roadmap (by priority)

1. **[verified in demo]** Tilted view + Y-sort + height/shadow + additive-blend FX.
2. Dynamic lighting: normal maps + point lights + lightmap (multiply composite). **Still blocked on real art**, but the blocking condition has shifted: real (AI-placeholder) character/enemy/weapon atlases have since landed (`12`/`13`, Phase 5.3) — the actual remaining gate is normal-map *authoring*, which needs the placeholder atlases replaced with final art first (or a flat+normal-map re-author pass over the placeholders), not the atlases' mere existence. Do not start until that art-production pass lands.
3. **[shipped 2026-07-26]** Post-processing: bloom-lite (`BlurFilter` on the additive `fx` layer — a cheap approximation, not real multi-pass bloom), custom `VignetteFilter`/`ChromaticAberrationFilter` (`game/fx/filters.ts`, hand-written GLSL, no third-party filter package), hit-stop (brief sim-tick freeze, offline-only) + screen-shake (decaying trauma, `game/Game.ts`).
4. **[shipped 2026-07-26]** Particle system: `game/fx/Particles.ts` — muzzle flames + shell casings (on `bullet_fired`), explosion debris (on enemy `death`), ambient drifting dust. Graphics-only (no textures), same events-queue-driven render-only discipline as the rest of this doc.
5. Custom shaders: dissolve on death, outline, energy shield, heat-haze distortion. **Not started** — dissolve/outline read best against a real sprite silhouette (`12`), so this likely wants to follow milestone 2, not jump ahead of it.
