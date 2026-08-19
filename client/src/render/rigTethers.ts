import type { Graphics } from 'pixi.js';
import type { BoneDef, ResolvedBoneTransform, WorldPose, WorldPositions } from './types';

// Split out of RigSkin.ts (2026-08-19, 500-line convention): the glowing energy tether every
// orbiting bone hangs off. Same category as `rigShading.ts` — a mark the rig DRAWS on top of
// its authored art rather than a bone sprite — and moved for the same reason: RigSkin was at
// 488 lines and the volume pass needed room for the module contact shades.
//
// design/13's "two weapon modules that orbit it on glowing energy tethers", design/12's "each
// of the two sockets orbits the core on a tether". Drawn, not authored, because the tether's
// length and angle are pure rig geometry: it spans a bone's pivot (the core's centre) to its
// tip (where that bone's module sprite sits), so it has to follow FK every frame. A bone opts
// in by declaring the `outerW`/`innerW` stroke widths the editor's own skeleton view already
// uses for a tubular bone (orb-core's socket_l/socket_r, boss-core's ring_a/ring_b); every
// other bone (shell/eye/belly, an enemy's single body bone) leaves them undefined and draws
// no tether.
const TETHER_COLOR = 0x8fe9ff;
/** Perpendicular sag of the tether's arc, as a fraction of its length — the concept
 *  turnaround draws it as a slack curve bowing away from the core, not a straight rod. */
const TETHER_SAG = 0.22;

/** Whether this rig has any tethered bone at all, i.e. whether to allocate the Graphics. */
export function hasTetheredBone(boneDefs: readonly BoneDef[]): boolean {
  return boneDefs.some((b) => b.outerW && b.innerW);
}

/**
 * Repaint the glowing tether of every orbiting bone: an arc from the bone's pivot on the core
 * out to the module sitting at its tip.
 *
 * Geometry is static in body space unless a clip actually moves those bones, so the endpoints
 * are signed and the rebuild skipped when nothing moved — a hovering idle costs one string
 * compare per frame, not two curve rebuilds. Returns the signature to remember; pass the
 * previous one back in as `lastSignature`.
 */
export function drawTethers(
  g: Graphics,
  boneDefs: readonly BoneDef[],
  worldPose: WorldPositions,
  transforms: Map<string, ResolvedBoneTransform>,
  lastSignature: string,
  tint: number,
): string {
  const arcs: Array<{ pose: WorldPose; outerW: number; innerW: number; alpha: number }> = [];
  let signature = '';
  for (const bone of boneDefs) {
    if (!bone.outerW || !bone.innerW) continue;
    const pose = worldPose.get(bone.id);
    if (!pose) continue;
    const alpha = transforms.get(bone.id)?.alpha ?? 1;
    arcs.push({ pose, outerW: bone.outerW, innerW: bone.innerW, alpha });
    signature += `${pose.sx.toFixed(1)},${pose.sy.toFixed(1)},${pose.ex.toFixed(1)},${pose.ey.toFixed(1)},${alpha.toFixed(2)};`;
  }
  if (signature === lastSignature) return signature;

  g.clear();
  for (const { pose, outerW, innerW, alpha } of arcs) {
    if (alpha <= 0) continue;
    const dx = pose.ex - pose.sx;
    const dy = pose.ey - pose.sy;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    // Control point: the midpoint pushed along the segment's normal, so the tether bows out
    // to one consistent side (down, in the rig's own y-down space) whichever way the bone
    // points — the whole rig mirrors as a unit, so the sag mirrors with it.
    const nx = -dy / len;
    const ny = dx / len;
    const bow = (ny >= 0 ? 1 : -1) * len * TETHER_SAG;
    const cx = pose.sx + dx / 2 + nx * bow;
    const cy = pose.sy + dy / 2 + ny * bow;
    // Two passes over the same curve: a wide soft halo, then the bright core line.
    g.moveTo(pose.sx, pose.sy).quadraticCurveTo(cx, cy, pose.ex, pose.ey)
      .stroke({ color: TETHER_COLOR, width: outerW, alpha: 0.3 * alpha, cap: 'round' });
    g.moveTo(pose.sx, pose.sy).quadraticCurveTo(cx, cy, pose.ex, pose.ey)
      .stroke({ color: TETHER_COLOR, width: innerW, alpha: 0.9 * alpha, cap: 'round' });
  }
  g.tint = tint;
  return signature;
}

/** The tether hue, exported so `RigSkin` can keep its untinted default in sync with the
 *  colour the strokes are actually drawn in. */
export { TETHER_COLOR };
