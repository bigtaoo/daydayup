import type { BoneDef, WorldPose, WorldPositions, ResolvedBoneTransform } from './types';

// Ported from tools/animator/src/skeleton/Rig.ts — computeFK only (the editor's
// computeNaturalHeight is an authoring-time bake concern, not needed at runtime).

export interface RigDef {
  id: string;
  label: string;
  bones: Omit<BoneDef, 'rla'>[];
  drawOrder: readonly string[];
}

export class Rig {
  readonly id: string;
  readonly boneMap: ReadonlyMap<string, BoneDef>;
  readonly boneDefs: readonly BoneDef[];
  readonly drawOrder: readonly string[];

  constructor(def: RigDef) {
    this.id = def.id;

    const boneMap = new Map<string, BoneDef>();
    const boneDefs: BoneDef[] = def.bones.map(raw => {
      const parentRwa = raw.parent ? (boneMap.get(raw.parent)?.rwa ?? 0) : 0;
      const bone: BoneDef = { ...raw, rla: raw.rwa - (raw.parent ? parentRwa : 0) };
      boneMap.set(bone.id, bone);
      return bone;
    });

    this.boneMap = boneMap;
    this.boneDefs = boneDefs;
    this.drawOrder = def.drawOrder;
  }

  /** Forward kinematics: compute world poses for every bone. Pure function. */
  computeFK(
    rootX: number,
    rootY: number,
    transforms: Map<string, ResolvedBoneTransform>,
  ): WorldPositions {
    // NOTE: deliberately a fresh Map per call, not a reused scratch buffer — a Rig
    // instance is shared across every actor on this body archetype AND a single
    // caller may legitimately hold two results at once to compare them (e.g.
    // Rig.test.ts computes a rest pose and a transformed pose back to back and
    // diffs both) — a shared buffer would silently corrupt the earlier result the
    // moment a second call runs. Bone counts are tiny (5-6 for orb-core, 1 for
    // critter-core), so this allocation was never the real cost here anyway.
    const result = new Map<string, WorldPose>();
    result.set('root', { sx: rootX, sy: rootY, ex: rootX, ey: rootY, wa: 0 });

    for (const bone of this.boneDefs) {
      if (bone.id === 'root') continue;
      const p = result.get(bone.parent!)!;
      const delta = transforms.get(bone.id)?.rotation ?? 0;
      const wa = p.wa + bone.rla + delta;
      const rad = (wa * Math.PI) / 180;
      const sx = p.ex, sy = p.ey;
      const ex = sx + Math.cos(rad) * bone.len;
      const ey = sy + Math.sin(rad) * bone.len;
      result.set(bone.id, { sx, sy, ex, ey, wa });
    }

    return result;
  }
}
