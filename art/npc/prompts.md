# Forger NPC prompt (archive)

`design/13`'s last open "NPCs are still open" gap — the Outpost/hub is otherwise fully
dressed (`hub_bg`, icons). This is the stationary Forger NPC that stands in the hub,
concept approved in-chat 2026-08-01 (blocky/industrial orb-core variant, tool-mount instead
of weapon-mount). Code plumbing for it already shipped in `Forge.ts` (`npcSprite`, key
`npc_forger`, corner-anchored bottom-right, hidden until the texture exists) — this prompt
is the only remaining piece.

Generated with **GPT Image 2**.

## `npc_forger` — stationary Outpost Forger

> 2D game character concept art, flat cel-shaded mobile game style, matching this game's
> locked hero art direction exactly: bold clean uniform black outlines, flat solid colour
> fills, simple soft cel shadows, minimal internal detail, strong readable silhouette.
> Deliberately FLAT — like a modern 2D mobile game sprite, NOT a 3D render, no realistic
> metal, no heavy gradients.
>
> The subject is a STATIONARY blocky/industrial floating robot-core, the "Forger" NPC who
> staffs the game's crafting outpost — same body-plan family as the game's hero orb-core
> (no legs, no arms, it hovers in place) but heavier and more angular/industrial than the
> hero's smooth sporty silhouette: a thicker, more block-like rounded body, single large
> expressive glowing eye/lens as its whole face, and a transparent crystal chamber in its
> belly filled with glowing crystal light. Instead of weapon modules, two TOOL attachments
> orbit it on the same glowing energy tethers the hero's weapons use, plugged into the same
> universal mount-socket design: a stone smith's HAMMER on one tether and a pair of
> crystal-tipped TONGS on the other, both clearly plugged into round mount-sockets identical
> in shape to the hero's weapon sockets (same lore, different tool). No weapons, no combat
> pose — calm, sturdy, at-rest stance, like it's standing over a forge waiting for the
> player.
>
> Palette: warm neutral stone/beige/gold (matching the hub background's palette), with a
> small warm ember-orange glow accent in the eye/belly crystal (justified as reflected
> forge-light) — explicitly NOT cyan/ice-blue, NOT any of the game's five reserved combat
> element hues (fire orange-red, ice cyan, lightning yellow-violet, poison green, physical
> white) as a DOMINANT colour; the ember accent is a small warm highlight only, the body
> stays in the stone/beige/gold family.
>
> Tilted 3/4 game camera view (slightly forward-leaning, not top-down), bright hopeful
> plucky mood not grim, plain neutral grey background, single character only, no text.

## Workflow reminder

Save the accepted generation as `art/npc/npc_forger_raw.png`, rejects as
`art/npc/npc_forger_alt.png` (same convention as every other `art/<category>` batch). After
judging: decode with `tools/png-pipeline/pngCodec.mjs`'s `decodePNG` to confirm real alpha,
then `node tools/png-pipeline/compress.mjs --long-axis=256 <file>` and drop the result into
`client/public/ui/npc_forger.png`. `Forge.ts`'s `npcSprite` already points at texture key
`npc_forger` via `getUiTexture()` — no code change needed once the file lands.
