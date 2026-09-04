/**
 * Split of the delivery seam (2026-09-05): the DURABLE half of the closed entitlement loop
 * — the `deliveries` table's reader and writer. `deliveryPump.ts` is the async half that
 * drains it; `delivery.ts` still owns the interface and the ledger-only opt-out.
 *
 * Everything here is synchronous, and that is the point rather than an implementation
 * detail. `EntitlementDelivery.grant` is called from inside `BillingService`'s
 * `BEGIN IMMEDIATE` and is `void`: it may not await, because an implementation that
 * returned before its work landed would break the exact guarantee design/19 §4 rests on.
 * So the grant this file provides does one `INSERT` into a fourth table in the SAME
 * database file — same transaction, same lock, same commit — and the HTTP call that
 * actually reaches `entitlements` happens strictly afterwards, from outside.
 *
 * WHAT THE ROW MEANS. Not "an entitlement was granted"; "an entitlement is OWED, and this
 * obligation survives a crash". After the COMMIT that promise is on disk, so the two
 * failures an outbox exists to rule out are ruled out: the process dying between the
 * payment and the grant (the row is still `pending` on restart) and the grant failing
 * after the money was taken (the row is still `pending`, and the pump keeps trying).
 *
 * WHY THIS AND NOT A TWO-PHASE COMMIT. Because the receiving side is already idempotent:
 * `entitlements` carries UNIQUE(account_id, sku) (design/19 §2, `db.ts`), so re-delivering
 * is a no-op rather than a double grant. At-least-once is therefore safe, and once
 * at-least-once is safe a coordinator buys nothing and costs a distributed protocol.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { EntitlementDelivery } from './delivery';

/** `pending` → `delivered` on a 2xx, or `pending` → `failed` on a deliberate refusal. */
export type DeliveryState = 'pending' | 'delivered' | 'failed';

/** One `deliveries` row, in this codebase's camelCase rather than SQL's snake_case. */
export interface DeliveryRecord {
  /** The ledger row's id — see the column comment in `billingDb.ts`. */
  id: string;
  accountId: string;
  /** The billsvc SKU (`bp.cannon`), not the namespaced entitlement sku. */
  sku: string;
  /** Raw, unparsed. Parsing is the PUMP's job so a corrupt row fails one delivery loudly
   * rather than throwing out of a plain table read (see `deliveryPump.ts`). */
  grantsJson: string;
  orderId: string;
  receiptId: string;
  state: DeliveryState;
  attempts: number;
  createdAt: number;
  deliveredAt: number | null;
}

interface DeliverySqlRow {
  id: string;
  account_id: string;
  sku: string;
  grants_json: string;
  order_id: string;
  receipt_id: string;
  state: string;
  attempts: number;
  created_at: number;
  delivered_at: number | null;
}

function toRecord(r: DeliverySqlRow): DeliveryRecord {
  return {
    id: r.id,
    accountId: r.account_id,
    sku: r.sku,
    grantsJson: r.grants_json,
    orderId: r.order_id,
    receiptId: r.receipt_id,
    state: r.state as DeliveryState,
    attempts: r.attempts,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  };
}

const COLUMNS =
  'id, account_id, sku, grants_json, order_id, receipt_id, state, attempts, created_at, delivered_at';

/**
 * The shipped `EntitlementDelivery`: one synchronous insert, inside the caller's
 * transaction, over the caller's own connection.
 *
 * `ON CONFLICT DO NOTHING` rather than a bare INSERT. Through `settle` a conflict is
 * unreachable — the ledger claim on this exact id was won two statements earlier, so a
 * duplicate would have been refused there first — but this seam is a public interface and
 * an implementation that throws on a redelivery would turn a harmless at-least-once retry
 * into a rolled-back settlement. Silently keeping the FIRST row is also the correct answer
 * on its own terms: it is the one the money was taken against, and a second row would
 * deliver the same SKU twice for one payment.
 *
 * A throw from here still rolls the whole settlement back, which is the contract
 * `delivery.ts` documents; nothing is caught.
 */
export function createOutboxDelivery(db: DatabaseSync): EntitlementDelivery {
  return {
    grant(request) {
      db.prepare(
        `INSERT INTO deliveries
           (id, account_id, sku, grants_json, order_id, receipt_id, state, attempts, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL)
         ON CONFLICT(id) DO NOTHING`,
      ).run(
        request.ledgerId,
        request.accountId,
        request.sku,
        JSON.stringify(request.grants),
        request.orderId,
        request.receiptId,
        request.ts,
      );
    },
  };
}

/**
 * The pump's only read: oldest owed delivery first. Ordered by `created_at` then `id` so a
 * batch is deterministic even when two settlements share a millisecond — the pump reports
 * per-row outcomes and a test that could not name which row it just saw would be pinning
 * the clock rather than the behaviour.
 *
 * Deliberately NOT filtered by `attempts`. A row that keeps failing retryably is retried
 * forever: the money moved, so abandoning it loses a purchase, and a peer that comes back
 * heals every stuck row on the next sweep. `attempts` is the operator's signal, not a
 * budget.
 */
export function pendingDeliveries(db: DatabaseSync, limit: number): DeliveryRecord[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM deliveries WHERE state = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?`)
    .all(limit) as unknown as DeliverySqlRow[];
  return rows.map(toRecord);
}

/** One delivery by id — the audit read, and how a test asks what the pump did. */
export function deliveryById(db: DatabaseSync, id: string): DeliveryRecord | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM deliveries WHERE id = ?`).get(id) as DeliverySqlRow | undefined;
  return row ? toRecord(row) : null;
}

/**
 * Count one attempt, BEFORE it is made rather than after it fails. A crash mid-attempt then
 * still leaves a trace, which is the case where the count is worth the most: a row whose
 * `attempts` climbs while nothing is ever logged is a peer that accepts the connection and
 * never answers.
 */
export function countAttempt(db: DatabaseSync, id: string): void {
  db.prepare('UPDATE deliveries SET attempts = attempts + 1 WHERE id = ?').run(id);
}

/**
 * Terminal success. Guarded on `state = 'pending'` so a delivery that raced (two pumps, or
 * a pump overlapping an operator's manual fix) cannot rewrite a settled row's timestamp —
 * the same claim-shape the rest of this plane uses instead of a look-before-write.
 */
export function markDelivered(db: DatabaseSync, id: string, ts: number): void {
  db.prepare(`UPDATE deliveries SET state = 'delivered', delivered_at = ? WHERE id = ? AND state = 'pending'`).run(
    ts,
    id,
  );
}

/**
 * Terminal refusal — the control plane said no on purpose (a 4xx), so repeating the call
 * verbatim cannot change the answer. `delivered_at` stays NULL: nothing was delivered, and
 * a column that means "when this landed" must not be used to mean "when we gave up".
 *
 * This state is the loud one. A `failed` row is money taken with nothing granted, and the
 * only way out of it is a human — which is exactly what design/19 §7's reconciliation
 * sweep is for, and why the pump logs an error rather than a warning when it writes one.
 */
export function markFailed(db: DatabaseSync, id: string): void {
  db.prepare(`UPDATE deliveries SET state = 'failed' WHERE id = ? AND state = 'pending'`).run(id);
}
