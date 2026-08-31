/** Dev/demo `?query=` overrides Game's constructor reads (see Game.ts field doc comments
 *  for what each one means). Pulled out as a pure parser — no `this`, easy to reason about
 *  independent of Game's constructor. `null` means "param absent — leave the default." */
import { resolveArenaId, type ArenaId } from './arenaCatalog';

export interface GameQueryParams {
  skinOverride: string | null;
  coop: boolean;
  online: boolean;
  arenaDemo: ArenaId | null;
  pvp: boolean;
  pvpSeats: number | null;
  matchBaseUrl: string | null;
  lagMs: number | null;
  loadoutOverride: string[] | null;
  perf: boolean;
  pickupDebug: boolean;
}

/** Game's constructor calls this instead of `parseGameQueryParams(location.search)`
 *  directly, guarding both globals it needs. `location` alone is not enough: the WeChat
 *  mini-game runtime injects a compat `location` (with an always-empty `.search`) for
 *  libraries that probe it, but has no `URLSearchParams` at all — constructing one
 *  throws a bare ReferenceError there. There is no `?query=` to parse on that platform
 *  anyway (see main.wechat.ts's boot comment), so `null` (skip the overrides) is the
 *  correct outcome, not a fallback. */
export function readGameQueryParams(): GameQueryParams | null {
  if (typeof location === 'undefined' || typeof URLSearchParams === 'undefined') return null;
  return parseGameQueryParams(location.search);
}

export function parseGameQueryParams(search: string): GameQueryParams {
  const params = new URLSearchParams(search);
  const seats = Number(params.get('seats'));
  const lag = Number(params.get('lag'));
  const wpn = params.get('wpn');
  const pvp = params.get('pvp') === '1'; // real matchmade PvP arena (design/15)
  return {
    skinOverride: params.get('skin'),
    coop: params.get('coop') === '1', // dev toggle: bring a local bot ally
    online: params.get('online') === '1' || pvp, // a PvP run always rides the online/CoopSession path
    // Dev toggle: boot an ArenaMap locally, no matchmaking. `?arenaDemo=1` keeps its
    // original meaning (the small synthetic fixture); `?arena=<id>` picks any catalog
    // map — the only way to walk the real 60-room launch map in ONE tab. An unknown id
    // resolves to null, i.e. the harness stays off rather than booting an empty arena.
    arenaDemo: resolveArenaId(params.get('arena')) ?? (params.get('arenaDemo') === '1' ? 'landing_basic' : null),
    pvp,
    pvpSeats: Number.isInteger(seats) && seats >= 2 && seats <= 8 ? seats : null,
    matchBaseUrl: params.get('mm'), // override the matchsvc origin (default localhost:8788)
    lagMs: Number.isFinite(lag) && lag > 0 ? lag : null, // dev: inject synthetic one-way latency (ms)
    // Dev toggle: stage exactly this weapon id. It reaches the run through resolveLoadout
    // like any crafted loadout, so the free slot still fills with the starter weapon of the
    // OTHER kind (ENGINE_VERSION 45) — `?wpn=<a gun>` spawns that gun + the saber.
    loadoutOverride: wpn ? [wpn] : null,
    perf: params.get('perf') === '1', // dev toggle: on-screen perf readout + GL draw-call probe (src/perf)
    // Dev toggle: on-screen collect-radius rings + per-drop distance readout, drawn from
    // GameState directly (scene/PickupDebugOverlay.ts) — the "unpickable drops" investigation's
    // instrument for telling "looks reachable" from "the sim agrees it's reachable".
    pickupDebug: params.get('pickupDebug') === '1',
  };
}
