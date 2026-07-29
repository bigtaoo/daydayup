/**
 * Shared server config (ROADMAP 3.3). Kept OUT of ticket.ts so that module stays env-free
 * and purely testable — this is the one place that reads process.env for the ticket secret,
 * imported by BOTH the control plane (matchsvc, signs) and the data plane (index.ts,
 * verifies) so they agree on the secret.
 *
 * Posture: a real `DDU_TICKET_SECRET` → production signing. Unset → a shared, well-known
 * DEV secret so the online path works out of the box locally, with a loud warning; in that
 * dev mode the gameserver also still honours the legacy raw-param handshake for manual
 * testing. Setting a real secret makes a valid ticket mandatory.
 */
const DEV_SECRET = 'dev-insecure-secret-do-not-use-in-prod';

// PvP squad size (design/05/15's long-deferred "squads" reserved interface) and its
// derived helpers live in `client/src/game/pvpConfig.ts`, NOT here — `buildPvpEngineConfig`
// must independently derive the exact same per-seat `teamId` from nothing but
// `(owner, playerCount)` (no ticket to read: `BotClient.ts` calls it with only
// `seed`/`playerCount`), so this server and that client function share one formula via
// the `@dd/game/pvpConfig` alias (already used by `BotClient.ts`/`Matchmaker.ts`)
// instead of two hand-mirrored copies that could drift (design/06's own stated lesson).
export { SQUAD_SIZE, squadSizeForPlayerCount, teamIdForOwner } from '@dd/game/pvpConfig';

let warned = false;

export function ticketSecret(): { secret: string; isDev: boolean } {
  const env = process.env.DDU_TICKET_SECRET;
  if (env && env.length > 0) return { secret: env, isDev: false };
  if (!warned) {
    warned = true;
    console.warn(
      '[daydayup] DDU_TICKET_SECRET unset — using an insecure DEV ticket secret. ' +
        'Set DDU_TICKET_SECRET (same value on matchsvc + gameserver) for any real deployment.',
    );
  }
  return { secret: DEV_SECRET, isDev: true };
}
