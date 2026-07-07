// Global constants. Tuning values live here.
export const CONFIG = {
  playerSpeed: 3.2, // px / frame @60fps baseline
  playerRadius: 16,
  playerMaxHp: 6,

  gravity: 0.9, // jump gravity (z axis)
  jumpVelocity: 13,

  bulletSpeed: 5.5,
  bulletRadius: 5,
  bulletLifetime: 180, // frames

  enemyFireInterval: 90, // frames
  enemyHp: 3,

  colors: {
    ground: 0x161a24,
    gridLine: 0x1f2532,
    player: 0x4fd1c5,
    playerFront: 0xe6fffa,
    enemy: 0xf56565,
    pillar: 0x3b4252,
    pillarTop: 0x4c566a,
    shadow: 0x000000,
    bulletEnemy: 0xf6ad55,
    bulletPlayer: 0x63b3ed,
    gun: 0xcbd5e0,
    sword: 0xe2e8f0,
    swordGlow: 0x90cdf4,
    blockArc: 0x63b3ed,
    muzzle: 0xffe08a,
  },
} as const;
