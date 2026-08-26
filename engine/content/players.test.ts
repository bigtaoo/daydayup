/**
 * `PLAYER_BASE`'s three radii and the relationships between them — the content half of
 * ENGINE_VERSION 43's `footprintRadius`/`solidRadius` split (live report: *"角色走到墙角的
 * 时候，太靠墙了，感觉陷进去了"*).
 *
 * These are deliberately RELATIONSHIP assertions, not a restatement of three literals.
 * The bug they guard is not "someone typed the wrong number", it is "the rendered body
 * grew wider than the clearance the sim stops it at, and nothing noticed" — which is
 * exactly how the original report happened: the 7 px feet circle was authored before the
 * real 32 px-wide rig art existed, and stayed correct-looking in the source the whole
 * time. `client/src/render/rigComposition.test.ts` closes the loop from the other side,
 * against the actual shipped rig bundles.
 */
import { describe, it, expect } from 'vitest';
import { PLAYER_BASE, resolveLoadout } from '@dd/engine/content/players';
import { BLASTER_SIM, SABER_SIM, WEAPON_SIM_BY_ID } from '@dd/engine/content/weapons';
import { BLUEPRINT_CATALOG } from '@dd/engine/content/blueprints';
import { pxToFp } from '@dd/engine/content/convert';

describe('PLAYER_BASE radii (ENGINE_VERSION 43)', () => {
  it('the solid clearance IS the body radius — a hugged wall lands tangent to the silhouette', () => {
    // The rendered body is exactly `radius` x 2 wide (design/12's rig normalization), so
    // any clearance below `radius` puts part of the silhouette inside the wall's own art.
    expect(PLAYER_BASE.solidRadius).toBe(PLAYER_BASE.radius);
    expect(PLAYER_BASE.solidRadius).toBeGreaterThanOrEqual(PLAYER_BASE.radius);
  });

  it('the feet circle stayed where it was — actor↔actor crowding is unchanged from v42', () => {
    // The whole point of the split: fixing the wall read must not silently re-tune how
    // tightly a crowd of bodies packs, which is what raising `footprintRadius` would do.
    expect(PLAYER_BASE.footprintRadius).toBe(pxToFp(7));
    expect(PLAYER_BASE.footprintRadius).toBeLessThan(PLAYER_BASE.radius); // still the depth cue
  });

  it('the two are genuinely different values — the split is not a no-op rename', () => {
    expect(PLAYER_BASE.solidRadius).toBeGreaterThan(PLAYER_BASE.footprintRadius);
  });

  it('the clearance still fits through level 1\'s narrowest authored gap (a 2-grid door)', () => {
    // Every `world/dungeons/ember/` door passage is 2 grid = 64 px wide. A player is
    // 2 x solidRadius wide against wall geometry, so this is the real navigational
    // ceiling on the clearance — raising it past a grid cell would wedge the level shut.
    const doorWidth = pxToFp(64);
    expect((PLAYER_BASE.solidRadius * 2) as number).toBeLessThan(doorWidth as number);
  });
});

/**
 * `resolveLoadout` — the rule that keeps the SWAP verb alive (live report: *"角色可以同时
 * 持有一把近战武器和一把枪，并且在ui上我标注的位置可以进行切换"*, with a screenshot showing
 * one weapon and no swap chip).
 *
 * The bug these guard is not "the swap code is missing" — every layer of it shipped
 * (Button.SWAP_WEAPON, ApplyInputSystem.swap, HudView.weaponSlotChip). It is that the
 * loadout resolution could hand a run a ONE-weapon array, at which point the whole verb
 * silently disappears (the HUD chip hides itself when `weapons.length <= 1`). So the
 * assertions are about the invariant — two slots, one of each kind — not about literals.
 */
describe('resolveLoadout — a run always carries a gun and a melee weapon', () => {
  // `WeaponSimSpec.name` IS the weapon id (weapons.ts sets `name: spec.id`) — the sim
  // spec carries no separate `id` field.
  const kinds = (list?: readonly string[]) => resolveLoadout(list).map((w) => w.kind);
  const ids = (list?: readonly string[]) => resolveLoadout(list).map((w) => w.name);

  it('the fixture ids this suite leans on really are the kinds it assumes', () => {
    // A premise, not a restatement: if `repeater` ever became melee, half the
    // expectations below would still pass while asserting nothing about kind-filling.
    expect(WEAPON_SIM_BY_ID.repeater!.kind).toBe('ranged');
    expect(WEAPON_SIM_BY_ID.flamer!.kind).toBe('ranged');
    expect(WEAPON_SIM_BY_ID.emberblade!.kind).toBe('melee');
    expect(WEAPON_SIM_BY_ID.ghost).toBeUndefined();
  });

  it('the default table itself holds exactly one weapon per kind (what the fill-by-kind rule leans on)', () => {
    expect(PLAYER_BASE.startWeapons).toHaveLength(PLAYER_BASE.weaponSlots);
    expect(new Set(PLAYER_BASE.startWeapons.map((w) => w.kind)).size).toBe(PLAYER_BASE.startWeapons.length);
  });

  it('nothing staged — absent, empty, or all-unknown — spawns the starter gun + melee pair', () => {
    for (const input of [undefined, [], ['ghost'], ['ghost', 'phantom']]) {
      expect(ids(input)).toEqual(PLAYER_BASE.startWeapons.map((w) => w.name));
    }
  });

  it('one crafted GUN keeps it active and fills the free slot with the default melee', () => {
    expect(ids(['repeater'])).toEqual(['repeater', SABER_SIM.name]);
    expect(kinds(['repeater'])).toEqual(['ranged', 'melee']);
  });

  it('one crafted MELEE keeps it active and fills the free slot with the default gun', () => {
    expect(ids(['emberblade'])).toEqual(['emberblade', BLASTER_SIM.name]);
    expect(kinds(['emberblade'])).toEqual(['melee', 'ranged']);
  });

  it('an unknown id next to a real one is dropped, and the freed slot still fills by kind', () => {
    expect(ids(['ghost', 'repeater'])).toEqual(['repeater', SABER_SIM.name]);
  });

  it('two staged weapons are honoured verbatim — no default is inserted, nothing crafted is discarded', () => {
    expect(ids(['repeater', 'emberblade'])).toEqual(['repeater', 'emberblade']);
    // Same kind twice is an explicit choice: it stands, rather than one being evicted
    // for a default. This is the ONE input that legitimately carries no melee weapon.
    expect(ids(['repeater', 'flamer'])).toEqual(['repeater', 'flamer']);
  });

  it('never exceeds weaponSlots, whatever it is handed', () => {
    for (const input of [undefined, [], ['repeater'], ['repeater', 'flamer', 'cannon'], ['emberblade', 'ghost', 'saber']]) {
      expect(resolveLoadout(input).length).toBeLessThanOrEqual(PLAYER_BASE.weaponSlots);
    }
  });

  it('every resolved slot is a real sim spec — the array the HUD counts can never hold a hole', () => {
    for (const input of [undefined, [], ['ghost'], ['repeater'], ['emberblade']]) {
      for (const w of resolveLoadout(input)) {
        expect(w).toBeDefined();
        expect(w.kind === 'ranged' || w.kind === 'melee').toBe(true);
      }
    }
  });
});

/**
 * The class-level gate the per-case assertions above can't give: sweep the AUTHORED
 * content instead of a fixture list (CLAUDE-memory convention — enumerate a sweep's
 * subjects from the data the pipeline actually ships). A blueprint added later with a
 * kind nothing in `startWeapons` covers, or a `startWeapons` edited to two of one kind,
 * breaks the "always a gun AND a melee weapon" invariant for the exact loadout a player
 * can build in the forge — and no hand-written case list would notice.
 */
describe('resolveLoadout swept over every craftable blueprint', () => {
  const CRAFTABLE = Object.entries(BLUEPRINT_CATALOG);

  it('the sweep has real subjects (a silent empty catalog would make every case below vacuous)', () => {
    expect(CRAFTABLE.length).toBeGreaterThan(10);
  });

  it('each blueprint staged ALONE still spawns one gun and one melee weapon', () => {
    const offenders: string[] = [];
    for (const [id, bp] of CRAFTABLE) {
      const resolved = resolveLoadout([id]);
      const kinds = new Set(resolved.map((w) => w.kind));
      // Staged weapon first (you spawn holding what you crafted), both kinds covered.
      if (resolved.length !== PLAYER_BASE.weaponSlots) offenders.push(`${id}: ${resolved.length} slots`);
      else if (resolved[0]!.name !== bp.weaponId) offenders.push(`${id}: crafted weapon not active`);
      else if (kinds.size !== 2) offenders.push(`${id}: only ${[...kinds].join('/')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('every blueprint PAIR resolves to exactly two real weapons, and never drops a crafted one', () => {
    // Every ordered pair would be ~700 cases; a diagonal sweep over the catalog covers
    // every id in both positions at O(n) instead, including the same-kind pairings the
    // per-case tests above only sample once.
    const offenders: string[] = [];
    for (let i = 0; i < CRAFTABLE.length; i++) {
      const a = CRAFTABLE[i]![0];
      const b = CRAFTABLE[(i + 1) % CRAFTABLE.length]![0];
      const resolved = resolveLoadout([a, b]);
      if (resolved.length !== PLAYER_BASE.weaponSlots) offenders.push(`${a}+${b}: ${resolved.length} slots`);
      // Both staged ids survive: a default is never inserted at a crafted weapon's expense.
      else if (resolved[0]!.name !== BLUEPRINT_CATALOG[a]!.weaponId || resolved[1]!.name !== BLUEPRINT_CATALOG[b]!.weaponId) {
        offenders.push(`${a}+${b}: got ${resolved.map((w) => w.name).join('+')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
