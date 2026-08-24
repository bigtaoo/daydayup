/** Dev/demo `?query=` overrides Game's constructor reads (see Game.ts field doc comments
 *  for what each one means). Pulled out as a pure parser — no `this`, easy to reason about
 *  independent of Game's constructor. `null` means "param absent — leave the default." */
export interface GameQueryParams {
  skinOverride: string | null;
  coop: boolean;
  online: boolean;
  arenaDemo: boolean;
  pvp: boolean;
  pvpSeats: number | null;
  matchBaseUrl: string | null;
  lagMs: number | null;
  loadoutOverride: string[] | null;
  perf: boolean;
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
    arenaDemo: params.get('arenaDemo') === '1', // dev toggle: synthetic local PvP arena
    pvp,
    pvpSeats: Number.isInteger(seats) && seats >= 2 && seats <= 8 ? seats : null,
    matchBaseUrl: params.get('mm'), // override the matchsvc origin (default localhost:8788)
    lagMs: Number.isFinite(lag) && lag > 0 ? lag : null, // dev: inject synthetic one-way latency (ms)
    loadoutOverride: wpn ? [wpn] : null, // dev toggle: start a run's loadout with exactly this weapon id
    perf: params.get('perf') === '1', // dev toggle: on-screen perf readout + GL draw-call probe (src/perf)
  };
}
