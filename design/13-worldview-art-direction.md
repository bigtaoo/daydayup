# Worldview & art direction

The game's **fiction and its visual identity** — the setting that makes the locked systems (`05` loop, `03` elements, `09` content) feel like one world, and the art rules that keep it readable on WeChat (`04`) and cheap to produce (`05` horizontal meta). Sibling to `12` (which owns the *pipeline* — how pixels load and animate); this doc owns *what the world is and what it looks like*, `12` owns *how the assets are built*.

## Worldview (locked)

- **Setting — the Blight (枯潮).** A spreading contamination is consuming the world, warping matter along **elemental lines** — fire / ice / lightning / poison. Each expresses as a different contaminated zone, which is why the run's floors are **elemental biomes** (`05`), the enemies are **element-corrupted creatures** (the `09` variants emberling/frostling/galvanist/ironclad), and `blightlord` is an advanced corruption.
- **Role — a reclaimer diver (回收者).** You descend into contaminated zones to pull out still-refinable **materials** (提纯枯晶) before the Blight claims them, then bank them and get out.
- **Tone — bright-but-eerie, hopeful not grim.** Post-contamination but stylized and plucky: you are *reclaiming*, diving a little deeper and getting a little stronger each run. This suits the name **DayDayUp (天天向上, "better every day")** and the casual WeChat audience — **not** horror, not grimdark.

### The fiction earns every locked rule

The setting was chosen because it makes each already-locked mechanic diegetic, not arbitrary:

| Locked rule (`05`/`09`) | In-world reason |
|-------------------------|-----------------|
| Weapons are ephemeral (wiped at run end) | Weapons found in a zone are **contaminated / unstable** — they work inside but decay the moment they leave |
| Only materials carry out | Materials = **stabilised, refined** crystal — the one thing safe to extract |
| Deeper floors → better materials | Deeper = **closer to the Blight source** → purer, more valuable crystal (and more dangerous) |
| Extraction rooms are checkpoints | **Decontamination gates** — passing one locks in what you've pulled out |
| Meta is horizontal (forge + cosmetics) | A safe **outpost / workshop** forges materials into loadout gear and skins |
| Elemental enemy variants + boss | Creatures corrupted by each element; the boss is a **Blight core / warden** |

## Visual direction (locked)

- **Style — flat-cel "半平涂".** Bold clean outlines + a limited saturated palette + strong readable silhouette. Deliberately **flatter than fully-rendered concept art**: cut-out skeletal parts (`12`) rotate every frame, so baked-in lighting/texture would break — keep shapes flat with soft cel shadows so limbs animate cleanly.
- **Concept trio validated the target (2026-07-23).** Three AI concepts — blight beast / reclaimer diver / extraction room — confirmed the worldview reads instantly (sealed extraction gate, loot crystals, blight veins) and the character brief lands (element-neutral hazard-suit salvager, mechanical off-hand claw). They are the **style target**; production assets follow the *flatten* rule above and the tilted-camera authoring rules (`12`/`01`).
- **Element = colour (hard gameplay rule, not taste).** A **closed five-colour language** drives all combat legibility: fire = orange-red, ice = cyan, lightning = yellow-violet, poison = green-violet, physical = neutral. It governs bullet trails, status auras (`07` render polish), enemy `tint` (`09`, render-only), and biome accents. Concrete hex values are a to-design.
- **Environment desaturated, hazards saturated.** Base stonework/terrain is low-chroma so the *interactive* bits — element FX, loot crystals, blight glow — pop. The poison biome's all-green ambient (seen in the concept room) must be **dialed down**, and poison should **not be the first biome**, or green poison FX/enemies camouflage against a green floor.
- **Biome identity = element theme + palette shift**, cheap to swap via `12`'s lazy per-biome bundles.
- **Player skins are cosmetic and silhouette-neutral** — characters carry no gameplay (`02`), so skins are pure flair and must never read as a power tell.

## Relationship to the other docs

- **`12`:** the pipeline that produces and animates these assets (skeletal editor, `.tao`, atlases, loading); this doc sets *what* it draws, `12` sets *how*.
- **`01`:** the tilted view + colour/glow the element language rides on.
- **`02`/`05`/`09`:** characters-are-skins, the biome/economy loop the fiction wraps, and the enemy `tint`/variant data the colour law drives.
- **`03`:** weapon looks inherit the element colour law and the flat-cel style.

## To design

- **Concrete palette:** per-element hex + per-biome background palettes (the five-colour law's actual values).
- **The other four biomes' looks** — only poison/blight is concepted; fire/ice/lightning + a neutral entry zone still need a visual pass, plus their difficulty/order (`05`), keeping poison off floor 1.
- **Outpost / hub + NPCs** — the meta home base's look (forge, skins), and any NPCs.
- **Shipping title** — is "DayDayUp" the final name or a codename? The Blight setting may suggest a title.
