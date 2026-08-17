/**
 * A deterministic PvE bot that can actually play a level start-to-finish: clear a
 * room, walk through the door to the next one, and confirm the portal at the
 * checkpoint. It exists for the level simulator (`levelSim.ts`) — the thing that
 * turns "is floor 1 room 1 survivable?" from a question you answer by playing into
 * one you answer by running a sweep.
 *
 * It is a strictly bigger job than the two bots already in `client/src/game/
 * controllers/` (`AllyController`, `PvpBotController`, both single-purpose "engage
 * the nearest hostile, else idle/regroup" seats — see `ai/engage.ts`): those never
 * have to navigate a room graph or press a portal button, because a human is always
 * the one driving the run forward. That extra half is why this lives here in `sim/`
 * rather than beside them: nothing shipped needs a bot that plays the game FOR the
 * player. It still produces nothing but a normal `PlayerCommand` per tick (design/08
 * "render only produces input"), so the engine cannot tell it from a human seat.
 *
 * Skill profile (`BOT_PROFILES`) is a first-class knob, not a detail: a balance
 * number that only holds for a perfect kiter is not a balance number. `careful`
 * holds the range an enemy's own `engageRangeFp` cannot reach and backs off when
 * crowded; `aggressive` walks into the mob's face like a new player does. Reading
 * both rows of the report is how you tell "this room is hard" from "this room is
 * impossible".
 *
 * Deliberately NOT a pure function of state (unlike `PvpBotController`, which has
 * to be — `server/src/BotClient.ts` recomputes it from confirmed state): this one
 * keeps a little memory (which room it thinks it is in, a stuck-timer) because the
 * engine's own room state is genuinely ambiguous while standing in a door passage.
 * A run is still fully reproducible, since that memory only ever advances from
 * state the engine already decided.
 */
import { Button, makeCommand, quantizeMove, FP_SCALE, type Brad, type GameState, type PlayerCommand } from '@dd/engine';
import { checkpointReached, totalFloorCount } from '../../src/game/match/floorCount';
import { bfsPath, capstoneRoomId, doorCentre, pointInRect, rectCentre, roomIdAt, roomRect, roomRuntime, type Vec } from './pveNav';

const g = (grid: number): number => grid * FP_SCALE;

export interface BotProfile {
  /** Distance the bot tries to hold from its target while shooting. */
  standoffFp: number;
  /** Dead zone around `standoffFp` — stops a bot oscillating one tick in, one out. */
  hysteresisFp: number;
  /** Opens fire once the target is this close (its gun's own reach is unlimited;
   *  this is the bot's discipline, not the weapon's). */
  fireRangeFp: number;
  /** Break off toward a heal pickup below this fraction of total effective HP. */
  healSeekFrac: number;
  /**
   * Wait in a cleared room for the shield pool to refill before opening the next
   * one (config.ts `SHIELD_REGEN_DELAY`/`SHIELD_REGEN_INTERVAL`). This is the single
   * biggest difference between careful and reckless play in a room-by-room game, and
   * it has to be modelled or the sim cannot see the effect of any regen tuning at
   * all: a bot that walks straight on always fights at whatever HP the last room
   * left it with.
   */
  restsBetweenRooms: boolean;
}

/**
 * `careful` sits just outside `DEFAULT_ENEMY_ENGAGE_RANGE_FP` (5.6 grid — the range
 * a mob stops and shoots from, content/enemies.ts), so a competent player's spacing
 * is represented, not just a brawl. `aggressive` closes to the same 4-grid spacing
 * `ai/engage.ts`'s shipped `KEEP_DIST_FP` uses for the co-op ally, i.e. what the
 * game's own existing bot considers normal.
 */
export const BOT_PROFILES: Record<'careful' | 'aggressive', BotProfile> = {
  careful: { standoffFp: g(7.5), hysteresisFp: g(1), fireRangeFp: g(11), healSeekFrac: 0.7, restsBetweenRooms: true },
  aggressive: { standoffFp: g(4), hysteresisFp: g(1), fireRangeFp: g(11), healSeekFrac: 0.5, restsBetweenRooms: false },
};

/** Enemies further than this are somebody else's problem — keeps the bot from
 *  trying to shoot through a wall at a neighbouring room's garrison. */
const ENGAGE_SCAN_FP = g(14);
const HEAL_SCAN_FP = g(12);
const WAYPOINT_REACHED_FP = g(1);
/** Stuck = intended to move but covered less than this over `STUCK_WINDOW` ticks. */
const STUCK_WINDOW = 24;
const STUCK_EPSILON_FP = g(0.4);
const UNSTICK_TICKS = 20;
/** Upper bound on one between-rooms breather (~20s) — see `shouldRest`. */
const REST_CAP_TICKS = 600;
/** No kill in this long while engaged (~4s) → start circling (see `orbiting`). */
const STALL_KILL_TIMEOUT = 120;

/** The bot's own view of its seat, in the one coordinate vocabulary this file uses
 *  (`x`/`y` Fp, like every rect/waypoint here) instead of the actor's `gx`/`gy`. */
interface Self extends Vec {
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
}

export class PveBotController {
  /** Last room the bot was unambiguously inside — a door passage belongs to no room
   *  rect, so `roomIdAt` goes undefined mid-crossing and this carries it across. */
  private currentRoom: string | undefined;
  private stuckSince = 0;
  private restedTicks = 0;
  private lastAliveCount = -1;
  private lastKillTick = 0;
  private lastPos: Vec = { x: 0, y: 0 };
  private unstickUntil = -1;
  private unstickSign = 1;

  constructor(private readonly profile: BotProfile = BOT_PROFILES.careful) {}

  build(s: GameState, owner: number, tick: number): PlayerCommand {
    const me = s.players[owner];
    if (!me || !me.alive || me.downed) return this.idle(owner, tick);

    const self: Self = { x: me.gx, y: me.gy, hp: me.hp, maxHp: me.maxHp, shield: me.shield, maxShield: me.maxShield };
    const here = roomIdAt(s, self.x, self.y);
    if (here !== undefined) this.currentRoom = here;

    // Checkpoint: walk into the capstone room and confirm the portal. Descend while
    // floors remain, extract on the last one (ExtractionSystem ignores DESCEND there).
    if (checkpointReached(s)) {
      const capstone = capstoneRoomId(s);
      const rect = capstone === undefined ? undefined : roomRect(s, capstone);
      if (rect && pointInRect(self.x, self.y, rect)) {
        const last = s.floorIndex >= totalFloorCount(s) - 1;
        return makeCommand({
          owner,
          tick,
          moveBrad: 0 as Brad,
          moveMag: 0,
          buttons: last ? Button.CONFIRM_EXTRACT : Button.CONFIRM_DESCEND,
        });
      }
      return this.travel(s, self, owner, tick, capstone);
    }

    const target = this.nearestEnemy(s, self, here);
    if (target) {
      this.restedTicks = 0;
      return this.fight(s, self, owner, tick, target);
    }
    // Nothing left to fight here: top the shield off before opening the next room,
    // unless there is a heal on the floor worth walking to first (`fight` handles
    // that case; here the room is quiet, so seek it directly).
    const heal = this.healToSeek(s, self);
    if (heal) return this.withUnstick(owner, tick, self, quantizeMove(heal.x - self.x, heal.y - self.y), 0);
    if (this.shouldRest(self)) {
      this.restedTicks++;
      return this.idle(owner, tick);
    }
    this.restedTicks = 0;
    return this.travel(s, self, owner, tick, this.nextObjectiveRoom(s));
  }

  // ── Combat ───────────────────────────────────────────────────────────────────

  private fight(s: GameState, me: Self, owner: number, tick: number, target: Vec): PlayerCommand {
    const heal = this.healToSeek(s, me);
    const dx = target.x - me.x;
    const dy = target.y - me.y;
    const dist = Math.hypot(dx, dy);
    const buttons = dist <= this.profile.fireRangeFp ? Button.FIRE : 0;

    // A heal on the floor outranks spacing discipline — it is the only in-run
    // sustain there is (design/05 power ramp), and walking over it is free damage
    // avoided later.
    const move = heal
      ? quantizeMove(heal.x - me.x, heal.y - me.y)
      : this.orbiting(s, tick)
        ? quantizeMove(-dy, dx) // perpendicular: circle the target to clear the shot
        : this.spacingMove(dx, dy, dist);
    return this.withUnstick(owner, tick, me, move, buttons);
  }

  /**
   * Is the bot circling its target instead of holding spacing? A mob standing behind
   * a pillar or a decor block soaks every bullet in the wall between them, and a
   * purely radial mover will happily keep shooting that wall until the run times out
   * (the sim caught this too: 2-3 of 8 runs per profile stalled indefinitely in the
   * `blocks2`/`pillars4` rooms). A player sidesteps to clear the shot, so the bot
   * does: if nothing has died for `STALL_KILL_TIMEOUT` ticks while it has a target,
   * strafe perpendicular in bursts until something gives.
   */
  private orbiting(s: GameState, tick: number): boolean {
    const alive = s.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
    if (alive !== this.lastAliveCount) {
      this.lastAliveCount = alive;
      this.lastKillTick = tick;
      return false;
    }
    return tick - this.lastKillTick > STALL_KILL_TIMEOUT;
  }

  /** Hold `standoffFp`: close when outside the band, back off when inside it. */
  private spacingMove(dx: number, dy: number, dist: number): { moveBrad: Brad; moveMag: number } {
    const { standoffFp, hysteresisFp } = this.profile;
    if (dist > standoffFp + hysteresisFp) return quantizeMove(dx, dy);
    if (dist < standoffFp - hysteresisFp) return quantizeMove(-dx, -dy);
    return { moveBrad: 0 as Brad, moveMag: 0 };
  }

  /**
   * Nearest live enemy worth engaging. Restricted to the bot's OWN room whenever it
   * is unambiguously inside one: a room's walls block bullets, and without this
   * filter the bot happily settles into a standoff with a mob it cannot hit through
   * a wall in the next room and never advances again (the sim caught exactly that —
   * 7 of 8 careful runs stalled forever after clearing the entrance room). While
   * standing in a door passage (`room === undefined`) it falls back to a plain radius
   * scan, which is also the correct behaviour there — both rooms are open to it.
   */
  private nearestEnemy(s: GameState, me: Vec, room: string | undefined): Vec | null {
    let best = ENGAGE_SCAN_FP * ENGAGE_SCAN_FP;
    let found: Vec | null = null;
    for (const e of s.enemies) {
      if (!e.alive) continue;
      if (room !== undefined && e.roomId !== room) continue;
      const dx = e.gx - me.x;
      const dy = e.gy - me.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        found = { x: e.gx, y: e.gy };
      }
    }
    return found;
  }

  private healToSeek(s: GameState, me: Self): Vec | null {
    const frac = (me.hp + me.shield) / Math.max(1, me.maxHp + me.maxShield);
    if (frac > this.profile.healSeekFrac) return null;
    let best = HEAL_SCAN_FP * HEAL_SCAN_FP;
    let found: Vec | null = null;
    for (const item of s.pickups) {
      if (!item.alive || item.kind !== 'heal') continue;
      const dx = item.gx - me.x;
      const dy = item.gy - me.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        found = { x: item.gx, y: item.gy };
      }
    }
    return found;
  }

  /**
   * Stand still in a quiet room while the shield refills. Capped at `REST_CAP_TICKS`
   * so a character with no shield pool at all (juggernaut, maxShield 0) or a run
   * whose regen is somehow blocked can never wedge the sim on an infinite rest —
   * the cap is a safety net, not a tactic.
   */
  private shouldRest(me: Self): boolean {
    if (!this.profile.restsBetweenRooms) return false;
    if (this.restedTicks >= REST_CAP_TICKS) return false;
    return me.shield < me.maxShield;
  }

  // ── Navigation ───────────────────────────────────────────────────────────────

  /** The room worth walking to next: the nearest one still holding live enemies or
   *  never activated at all, else the capstone (so a fully-cleared floor still
   *  converges on the portal). */
  private nextObjectiveRoom(s: GameState): string | undefined {
    const from = this.currentRoom;
    if (from === undefined) return undefined;
    const path = bfsPath(s, from, (id) => {
      if (id === from) return false; // never "arrive" where we already are
      const rt = roomRuntime(s, id);
      return rt !== undefined && (!rt.activated || rt.hasLiveEnemy);
    });
    return path?.[path.length - 1] ?? capstoneRoomId(s);
  }

  /** Walk toward `goal` one door at a time: aim at the shared passage until we are
   *  standing in it, then at the next room's centre so we actually cross. */
  private travel(s: GameState, me: Self, owner: number, tick: number, goal: string | undefined): PlayerCommand {
    const from = this.currentRoom;
    if (goal === undefined || from === undefined) return this.idle(owner, tick);
    const path = from === goal ? [from] : bfsPath(s, from, (id) => id === goal);
    if (!path) return this.idle(owner, tick);

    let waypoint: Vec | undefined;
    if (path.length >= 2) {
      const gate = doorCentre(s, path[0]!, path[1]!);
      const nextRect = roomRect(s, path[1]!);
      const atGate = gate !== undefined && Math.hypot(gate.x - me.x, gate.y - me.y) <= WAYPOINT_REACHED_FP;
      waypoint = atGate && nextRect ? rectCentre(nextRect) : gate;
    } else {
      const rect = roomRect(s, path[0]!);
      waypoint = rect ? rectCentre(rect) : undefined;
    }
    if (!waypoint) return this.idle(owner, tick);

    const move = quantizeMove(waypoint.x - me.x, waypoint.y - me.y);
    return this.withUnstick(owner, tick, me, move, 0);
  }

  // ── Stuck handling ───────────────────────────────────────────────────────────

  /**
   * The AI in this game walks in straight lines (`AIDecideSystem.chaseAndEngage`'s
   * own doc comment: "a mob can stall against a concave wall") and so does this
   * bot. A pillar or a doorway lip would otherwise pin it there for the whole run
   * and report as a fake "survived forever" result, so: if it wanted to move but
   * hasn't, strafe perpendicular for a fixed burst. Direction alternates off the
   * tick the stall was detected — deterministic, no PRNG (design/06).
   */
  private withUnstick(owner: number, tick: number, me: Vec, move: { moveBrad: Brad; moveMag: number }, buttons: number): PlayerCommand {
    const moved = Math.hypot(me.x - this.lastPos.x, me.y - this.lastPos.y);
    if (move.moveMag > 0 && moved < STUCK_EPSILON_FP / STUCK_WINDOW) this.stuckSince++;
    else this.stuckSince = 0;
    this.lastPos = { x: me.x, y: me.y };

    if (this.stuckSince >= STUCK_WINDOW && tick > this.unstickUntil) {
      this.unstickUntil = tick + UNSTICK_TICKS;
      this.unstickSign = -this.unstickSign;
      this.stuckSince = 0;
    }
    if (tick <= this.unstickUntil && move.moveMag > 0) {
      // Rotate the intended direction a quarter turn (brad is a 16-bit circle).
      const turned = ((move.moveBrad + this.unstickSign * 16384 + 65536) % 65536) as Brad;
      return makeCommand({ owner, tick, moveBrad: turned, moveMag: move.moveMag, buttons });
    }
    return makeCommand({ owner, tick, moveBrad: move.moveBrad, moveMag: move.moveMag, buttons });
  }

  private idle(owner: number, tick: number): PlayerCommand {
    return makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });
  }
}
