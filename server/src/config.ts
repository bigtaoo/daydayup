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
