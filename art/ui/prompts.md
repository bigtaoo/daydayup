# UI icon prompts (archive)

Prompts for the remaining button icons (2026-08 pass — LoginScreen/PauseMenu/PartyScreen/
Forge, closing out the icon gap the 2026-08-01 Main Menu/Forge pass left open). Generated
with **GPT Image 2**. Style matches the 6 already-shipped icons (`icon_play`/`icon_squad`/
`icon_account`/`icon_settings`/`icon_result_extract`/`icon_result_wiped`) — bold black
outline, flat cel-shaded badge shape, a glowing bright cyan-white "purified crystal" light
as the signature accent (this is the game's neutral UI-glow convention, distinct from the
five reserved combat-element hues in `design/13`).

## Locked icon style, in one paragraph (paste as context)

Flat cel-shaded 2D mobile-game UI icon, bold clean black outline, simple flat colour fills
with soft cel shading, a glowing bright cyan-white crystal light accent (the game's
"purified crystal" motif — NOT any combat element colour), badge/icon scale (reads clearly
at 32-48px on a dark background), deliberately FLAT like a modern mobile game icon, NOT
painterly, NOT 3D rendered, no gradients beyond a simple two-tone cel shadow, no text or
letters anywhere in the image, plain transparent background, centered composition with
even padding on all sides, a SINGLE icon only (not a sheet or grid).

## Reuse decisions (no new art needed)

Several buttons intentionally reuse an existing icon rather than getting a new one —
cheap, and the semantic overlap is real:
- `icon_account` → LoginScreen's LOGIN button (same "enter your account" action as
  MainMenu's LOGIN/account entry).
- `icon_settings` → PauseMenu's SETTINGS button (identical action to MainMenu's).
- `icon_play` → PauseMenu's RESUME, PartyScreen's START MATCHING, Forge's START RUN — all
  three are "go/begin" actions in different contexts; one glyph reads fine in all three.

## New icons to generate

### 1. `icon_register` — LoginScreen REGISTER
> A hexagonal badge (same silhouette shape as the shipped `icon_account` eye badge),
> containing a small simplified crystal-core creature silhouette (a round smooth shell,
> single eye) with a glowing cyan-white "+" plus symbol floating beside it, signifying
> creating a brand new account/character slot.

### 2. `icon_password` — LoginScreen CHANGE PASSWORD
> A padlock shape built from the same white-and-silver tech material as the shipped
> `icon_settings` gear, with a glowing cyan-white crystal shard as the keyhole, small
> rivets/panel-lines for detail.

### 3. `icon_logout` — LoginScreen LOG OUT
> A simple rounded doorway/archway shape in white-and-silver tech material, with a glowing
> cyan-white arrow pointing OUT through the doorway, signifying leaving/exiting.

### 4. `icon_back` — shared BACK button (LoginScreen, PartyScreen)
> A simple rounded left-pointing chevron/arrow icon, white-and-silver tech material with a
> thin glowing cyan-white outline trim, generic back-navigation glyph, no other elements.

### 5. `icon_quit` — PauseMenu QUIT TO FORGE
> A small stone anvil silhouette (matching the "forge/outpost" theme already established
> by `hub_bg`'s warm stone palette) with a glowing cyan-white crystal spark/ember hovering
> just above it, signifying returning to the forge outpost.

### 6. `icon_party_create` — PartyScreen CREATE PARTY
> Three small round crystal-core creatures floating together in a loose triangle (same
> trio pose as the shipped `icon_squad`), with a small glowing cyan-white "+" plus badge
> overlapping the group, signifying starting a brand new squad.

### 7. `icon_party_join` — PartyScreen JOIN WITH CODE
> Two small round crystal-core creatures connected by a glowing cyan-white energy
> tether/link between them (the same tether visual language the hero's orbiting weapon
> modules use), signifying linking up with an existing squad via a code.

### 8. `icon_party_leave` — PartyScreen LEAVE PARTY
> A single small round crystal-core creature (same style as `icon_squad`'s trio, just one)
> with a glowing cyan-white arrow pointing away from it toward the edge of the frame,
> signifying leaving/exiting a group.

### 9. `icon_clear` — Forge CLEAR LOADOUT
> An empty rounded socket/mount shape (the universal weapon-mount socket from the game's
> established weapon lore — a simple round connector ring, no weapon plugged in), with a
> faint glowing cyan-white "reset" swirl/arrow beside it, signifying clearing an equipped
> loadout back to empty.

## Workflow reminder

Save accepted generations as `art/ui/<name>_raw.png`, rejects as `art/ui/<name>_alt.png`
(matching `art/weapon`'s and the earlier `art/ui` batch's naming). After judging: decode
with `tools/png-pipeline/pngCodec.mjs`'s `decodePNG` to confirm real alpha (don't trust an
image viewer's compositing), then `node tools/png-pipeline/compress.mjs --long-axis=256
<file>` and drop the result into `client/public/ui/<name>.png`. `render/uiSkins.ts`'s
`UI_ASSETS` table already has all 9 keys wired — no code change needed once the file lands
at the expected path.
