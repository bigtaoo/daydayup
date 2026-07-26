import type { BoneDef, WorldPose, WorldPositions, ResolvedBoneTransform, AnimationClip } from '../core/types';

// ── RigDef ────────────────────────────────────────────────────────────────────
// Data shape for one skeleton definition. Unlike funny's original tool (a single
// hardcoded 11-bone humanoid `Skeleton` static class), a `RigDef` is plain data —
// the editor can hold as many of these as a project needs (orb-core today; a
// crystal-critter or boss-core rig later is just another RigDef, no code change).

export interface RigDef {
  id:    string;
  label: string;
  /** Authored rest-pose bones. `rla` is derived at construction time — omit it here. */
  bones: Omit<BoneDef, 'rla'>[];
  /** Render order, back-to-front (bone ids, excludes 'root'). */
  drawOrder: readonly string[];
  /** Bones shown as timeline rows (excludes 'root'). Usually all bones but root. */
  timelineBones: readonly string[];
  /** Fallback shadow ellipse half-size when an attachment point doesn't specify one. */
  defaultShadow: { w: number; h: number };
}

// ── Rig ───────────────────────────────────────────────────────────────────────
// An instantiated skeleton: rest-pose bone table + the pure FK/height math that
// used to live on the static `Skeleton` class. `computeFK` is unchanged from the
// ported original — it always walked a generic bone-def array, so becoming an
// instance method (fed by whichever RigDef was constructed) required no logic
// changes, only moving the data from module-statics to constructor input.

export class Rig {
  readonly id: string;
  readonly label: string;
  readonly boneMap: ReadonlyMap<string, BoneDef>;
  readonly boneDefs: readonly BoneDef[];
  readonly drawOrder: readonly string[];
  readonly selectableBones: readonly string[];
  readonly timelineBones: readonly string[];
  readonly defaultShadow: { w: number; h: number };

  constructor(def: RigDef) {
    this.id = def.id;
    this.label = def.label;

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
    this.selectableBones = boneDefs.filter(b => b.id !== 'root').map(b => b.id);
    this.timelineBones = def.timelineBones;
    this.defaultShadow = def.defaultShadow;
  }

  /** Forward kinematics: compute world poses for every bone.
   *  Pure function — no side effects.
   *  @param transforms  Per-bone resolved transforms; rotation field drives FK. */
  computeFK(
    rootX: number,
    rootY: number,
    transforms: Map<string, ResolvedBoneTransform>,
    lengthScales?: ReadonlyMap<string, number>,
  ): WorldPositions {
    const result = new Map<string, WorldPose>();
    result.set('root', { sx: rootX, sy: rootY, ex: rootX, ey: rootY, wa: 0 });

    for (const bone of this.boneDefs) {
      if (bone.id === 'root') continue;
      const p = result.get(bone.parent!)!;
      const delta = transforms.get(bone.id)?.rotation ?? 0;
      const wa = p.wa + bone.rla + delta;
      const rad = (wa * Math.PI) / 180;
      const sx = p.ex, sy = p.ey;
      const len = bone.len * (lengthScales?.get(bone.id) ?? 1);
      const ex = sx + Math.cos(rad) * len;
      const ey = sy + Math.sin(rad) * len;
      result.set(bone.id, { sx, sy, ex, ey, wa });
    }

    return result;
  }

  /**
   * Natural bounding-box height (animator px) of the figure: the vertical extent
   * (maxY − minY) of every FK joint point, unioned over the rest pose AND every
   * keyframe of every clip. This is H_nat — the export bake divides the target
   * screen height into it to get the global bake factor. Returns 0 when there are
   * no clips (signals "unknown").
   */
  computeNaturalHeight(
    clips: Iterable<AnimationClip>,
    lengthScales?: ReadonlyMap<string, number>,
  ): number {
    let minY = Infinity, maxY = -Infinity;
    const scan = (transforms: Map<string, ResolvedBoneTransform>): void => {
      const wp = this.computeFK(0, 0, transforms, lengthScales);
      for (const p of wp.values()) {
        if (p.sy < minY) minY = p.sy;
        if (p.sy > maxY) maxY = p.sy;
        if (p.ey < minY) minY = p.ey;
        if (p.ey > maxY) maxY = p.ey;
      }
    };

    scan(new Map());   // rest pose (empty transforms)
    for (const clip of clips) {
      for (const kf of clip.keyframes) {
        const tf = new Map<string, ResolvedBoneTransform>();
        // FK only reads .rotation; the rest are filled with identity defaults.
        kf.bones.forEach((bkf, id) => tf.set(id, {
          rotation:   bkf.rotation ?? 0,
          scaleX:     1, scaleY: 1,
          translateX: 0, translateY: 0,
          alpha:      1,
        }));
        scan(tf);
      }
    }

    return (Number.isFinite(minY) && maxY > minY) ? maxY - minY : 0;
  }
}
