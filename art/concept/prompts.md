# Concept-art prompts (archive)

Prompts that produced the **accepted** art direction (orb-core + universal-mount weapons + crystal-mirror enemies), locked 2026-07-23. Art direction itself lives in `design/13-worldview-art-direction.md`; this file is the reusable prompt source so we can re-generate / iterate later.

Generated with **GPT Image 2** (natural-language prompts — no tag-soup, no separate negative-prompt field; bake exclusions into prose).

## Locked art direction, in one paragraph (paste as context)

Flat cel-shaded 2D mobile-game art: bold clean uniform outlines, flat solid colour fills, simple soft cel shadows, minimal internal detail, strong silhouette that reads at app-icon size. Deliberately FLAT — like a sticker / modern 2D sprite, NOT a 3D render, no realistic metal, no heavy gradients. Bright, hopeful, plucky — not grim, not horror. Tilted 3/4 game camera (slightly forward-leaning, not top-down). The hero is a small floating spherical robot-core (no arms, no legs) with one big expressive eye, a transparent belly chamber that fills with glowing crystal, and two weapon modules that orbit it on glowing energy tethers. Weapons plug into a **universal mount socket** (identical base, only the business end differs). Element = colour, dual-channel (colour + a small icon badge): fire = orange-red / ice = cyan / lightning = yellow-dominant violet / poison = green-dominant / physical = neutral white.

## Flatness benchmark

The **weapon sheet** and **melee** outputs are the target flatness. If GPT renders too much (metal gloss, gradients, texture), append:
`Think flat 2D vector illustration, like a sticker, not a rendered 3D model.`

---

## 1. Hero — orb-core turnaround (front/back + palette)

> Character concept sheet, a small floating spherical robot-core, the hero of a mobile roguelite. NO legs, NO arms, NO humanoid body — it hovers. The body is one clean rounded orb with a single large expressive glowing eye/lens as its whole "face", cute and plucky. A transparent crystal chamber in its belly is half-filled with glowing cyan crystal light (its collected purified material). Two small modular weapon-pods float and orbit around the core like satellites, held by glowing energy tethers, each pointing outward ready to aim. Semi-translucent faceted crystal accents, clean polished light — bright, hopeful, NOT grim. Art style: flat cel-shading, bold clean black outlines, limited saturated palette, big readable silhouette, minimal internal detail. Deliberately FLAT — like a modern 2D mobile game sprite, NOT a painterly 3D render. Simple soft cel shadows only. Tilted 3/4 game camera view. Plain neutral grey background. Turnaround: front view + back view.

Knobs: eye = `single large eye` (chosen, round pupil) vs `glowing visor screen` vs `two round eyes`. Belly colour = element to feature. Modules = `weapon-pods` (chosen, reads "reclaimer machine") vs `orbiting crystal shards` (more "living crystal").

## 2. Weapon-compat — ranged (barrel plugs into the universal socket)

> 2D game character concept art, flat cel-shaded mobile game style. A small cute floating spherical robot-core: one rounded cream-white and gold armored orb with a single large glowing cyan eye, small blue crystal spikes on top, and a transparent chamber in its belly half-filled with glowing cyan crystals. It hovers, no legs, no arms. Two identical compact mount-sockets orbit the core, held by thin glowing cyan energy tethers — these sockets are universal weapon mounts. In this image, a RANGED WEAPON is slotted into each mount: a short crystal-tech gun barrel extends forward out of the socket, muzzle glowing cyan, firing a small cyan energy bolt. Clearly show that the barrel plugs INTO the socket (the socket is the mount, the barrel is the swappable part). Art style: bold clean uniform outlines, flat solid color fills, simple soft cel shadows, very limited palette (cream, cyan, gold, dark grey). Deliberately FLAT — NOT 3D rendered, no realistic metal, no heavy gradients, minimal panel-line detail. Reads at tiny icon size. Bright, hopeful, cute. Tilted 3/4 game camera view, plain neutral grey background. Include one small inset close-up of a single mount-socket with the gun barrel plugged in.

## 3. Weapon-compat — melee (same socket, crystal blade + swing = deflect arc)

> 2D game character concept art, flat cel-shaded mobile game style. The SAME small cute floating spherical robot-core (rounded cream-white and gold orb, single glowing cyan eye, blue crystal spikes on top, belly chamber half-filled with glowing cyan crystals, hovering, no legs, no arms). Two identical compact mount-sockets orbit the core on thin glowing cyan energy tethers — the SAME universal weapon mounts. In this image, a MELEE WEAPON is slotted into each mount: a faceted glowing ORANGE-RED crystal blade extends out of the socket instead of a gun. Clearly show the blade plugs INTO the same socket. One blade is mid-swing: draw a wide glowing arc trail showing the blade sweeping in a sector around the core, and one small enemy bullet being deflected away along that arc. Art style: bold clean uniform outlines, flat solid color fills, simple soft cel shadows, limited palette (cream, cyan, gold, orange-red for the blade). Deliberately FLAT — NOT 3D rendered, no realistic metal, no heavy gradients, minimal panel-line detail. Reads at tiny icon size. Bright, hopeful, cute. Tilted 3/4 game camera view, plain neutral grey background. Include one small inset close-up of a single mount-socket with the crystal blade plugged in.

Validated: (1) same socket across ranged & melee = universal mount confirmed; (2) melee arc trail + deflected bullet = "swing sector IS the deflect sector" reads; (3) tether length = melee reach (emergent).

## 4. Weapon sheet — Frame × Element, one socket, colour+icon dual channel

> 2D game weapon icon sheet, flat cel-shaded mobile game style, matching a cute crystal-robot game. A neat grid of 8 modular weapons on a plain neutral grey background. Every weapon shares the SAME universal mount base: a round cream-white and gold socket connector at its back end (the part that plugs into the robot's orbiting mount), so they are clearly interchangeable attachments — only the front "business end" differs. Each weapon is made of glowing faceted crystal set in clean white-and-gold tech housing. Show a mix of ranged and melee: small pistol barrel (cyan); wide shotgun muzzle (neutral white); long thin laser/beam emitter (yellow-violet); multi-barrel bullet-pattern emitter (green-violet); straight crystal sword blade (orange-red); heavy crystal hammer head (cyan); long crystal spear tip (yellow-violet); curved crystal saber (green-violet). Each weapon's crystal glows in its element color: orange-red = fire, cyan = ice, yellow-violet = lightning, green-violet = poison, neutral white = physical. Art style: bold clean uniform outlines, flat solid color fills, simple soft cel shadows, minimal internal detail — deliberately FLAT like modern 2D mobile game item icons, NOT 3D rendered, no realistic metal, no heavy gradients. Reads at tiny icon size. Bright, clean, plucky. Tidy grid layout, plain grey background.

Notes: 8-in-one can串味 / socket-drift — if messy, split into a 4-ranged sheet + a 4-melee sheet. **Fix for next gen:** the poison entry came out rainbow — force `green-dominant`. Element ICON badges (flame/snowflake/bolt/skull/gem) emerged and are now a **locked** legibility channel — keep them.

## 5. Enemies — corrupted-crystal mirror, 5 element variants

> 2D game enemy concept sheet, flat cel-shaded mobile game style, matching a cute crystal-robot game. A family of small crystal monsters that are the CORRUPTED MIRROR of the player's clean robot orb. Where the hero is a smooth cream-and-gold tech shell with a friendly round eye and crystals neatly sealed inside, these enemies are made of raw, jagged, wild-growing faceted crystal over a cracked rocky core, with a single angry glowing eye and sharp crystal shards bursting from their back. Semi-translucent glowing crystal, geometric and sharp — beautiful-dangerous, mischievous, NOT gory, NOT horror. Show the SAME base creature (a squat single-eyed crystal blob-critter with back shards) in 5 element color variants: fire = orange-red glowing crystal; ice = cyan glowing crystal; lightning = yellow-dominant electric-violet glowing crystal; poison = green-dominant toxic glowing crystal; physical = neutral grey-white crystal. Each variant carries a tiny matching element icon/tell (flame / snowflake / bolt / skull) so it reads at a glance, just like the weapons. Art style: bold clean uniform outlines, flat solid color fills, simple soft cel shadows, minimal internal detail — deliberately FLAT, NOT 3D rendered, no realistic rock texture, no heavy gradients. Reads at tiny icon size. Bright, plucky, menacing-but-appealing. Tilted 3/4 game camera view, plain neutral grey background. Neat row layout, 5 creatures in a row.

Notes: element system + icon badges validated. Mirror-to-hero link is soft — optionally add `... with fragments of cracked cream-and-gold shell embedded in the crystal, like a corrupted version of the hero orb`. Slightly over-rendered (lava texture, gloss) — flatten one notch in production.

## To generate next

- **Boss — a giant failed core** (closes the hero↔boss mirror): `a huge crystal warden, a giant floating cracked-crystal core with orbiting shard rings, single huge angry eye, same crystal DNA as the hero orb but corrupted and overgrown`.
- **Other enemy body forms**: `a taller crystal brute with two heavy crystal fists`; a floating ranged crystal wisp.
- **The 3 launch characters** as distinct themed orb-cores (e.g. a Sun-Wukong core), theme on the orb only.
- **Biome establishing shots**: fire / ice / lightning + a neutral entry zone (desaturated environment, saturated hazards; poison not floor 1).

## Retired

The three originals in this folder (`5fe18b84…`, `85e22acf…`, `b488d349…` — reclaimer diver / extraction room / blight beast) are the **rejected** first direction. Kept for reference only; see the "Art-first" note in `design/13`.
