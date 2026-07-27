// Pure facing decision (design/12 "Facing model (twin-stick 360° aim)"), split
// out of RigSkin so it's testable without touching Pixi: L/R mirror by the aim
// vector's horizontal sign, front/back hemisphere swap by its vertical sign
// (y-down screen space — aiming toward the bottom/camera is "front").
export interface FacingState {
  flipX: 1 | -1;
  showBack: boolean;
}

export function facingFromAim(rad: number): FacingState {
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  return {
    flipX: dx < 0 ? -1 : 1,
    showBack: dy < 0,
  };
}
