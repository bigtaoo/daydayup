/**
 * The review queue (design/19-server-platform.md §7, ROADMAP 8.5) — the one place this
 * server tells a human that something needs looking at. Free functions over the billing
 * `DatabaseSync`, CLAUDE.md's first split form.
 *
 * FILES RATHER THAN ACTS. design/19 §7 states the principle for the daily grant audit and
 * points at where it already holds: `design/15-pvp-arena.md`'s checkpoint quorum, which runs
 * no consensus check at all below a quorum of real seats and severs a seat only on a
 * CONSECUTIVE run of mismatches, never on one stray report. The same rule, applied to money:
 *
 *     WITH NO EVIDENCE, SKIP — NEVER CONVICT.
 *
 * Concretely, and these are constraints on the whole module rather than commentary: nothing
 * here revokes an entitlement, nothing here changes an order, nothing here is reachable from
 * a request handler that could be driven by a player, and a finding is a row a person reads
 * — not an action taken on their behalf. `EntitlementService.revoke` exists and is
 * deliberately called by nothing in this server.
 *
 * TWO PRODUCERS, ONE TABLE, and they share it because they are the same question — "a human
 * has to look at this account":
 *
 *   'grant-anomaly'                too many non-`purchase` entitlement grants for one account
 *                                  in one UTC day (`grantAudit.ts`).
 *   'money-taken-nothing-granted'  a settled purchase the control plane refused outright, or
 *                                  one whose outbox row can never be read (`deliveryPump.ts`).
 *                                  The only class in Phase 8 where money moved and the player
 *                                  got nothing, and before this table it existed ONLY as a
 *                                  `console.error` — which has no owner, no second reader and
 *                                  no memory across a restart.
 *
 * IDEMPOTENCY IS THE PRODUCER'S KEY, NOT A GENERATED ID. `reviewId` below mints it, and the
 * insert is `ON CONFLICT DO NOTHING`. An audit re-run over the same day must not file a
 * second copy — an audit an operator is afraid to re-run stops being run — and a delivery
 * that is already terminal must not re-file every time a sweep passes it.
 */
import type { DatabaseSync } from 'node:sqlite';

export const REVIEW_KINDS = ['grant-anomaly', 'money-taken-nothing-granted'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type ReviewState = 'open' | 'reviewed';

export interface ReviewEntry {
  id: string;
  kind: ReviewKind;
  accountId: string;
  /** `YYYY-MM-DD` (UTC) for the daily audit; `null` for a delivery, which is an event. */
  dayKey: string | null;
  summary: string;
  /** Parsed `evidence_json`. `null` when the stored text does not parse — see `toEntry`. */
  evidence: unknown;
  state: ReviewState;
  createdAt: number;
  reviewedAt: number | null;
  note: string | null;
}

export interface FileReviewInput {
  kind: ReviewKind;
  accountId: string;
  dayKey?: string | null;
  summary: string;
  /** Anything JSON-serialisable. Stored as text; this table is read at a `sqlite3` prompt. */
  evidence: unknown;
  ts: number;
}

/**
 * The idempotency key. Shaped `<kind>:<subject>` so the table sorts and greps by kind, and
 * so a human reading an id can tell which producer wrote it without a join.
 *
 * The daily audit's subject is `(accountId, dayKey)` — design/19 §7's stated key — and the
 * delivery's is the delivery id, which is already the ledger row's own claimed id
 * (`billingDb.ts`), so it inherits the strongest key in the plane rather than minting a
 * weaker one.
 */
export function reviewId(kind: ReviewKind, subject: string): string {
  return `${kind}:${subject}`;
}

/** `grant-anomaly:<accountId>:<dayKey>`. */
export function grantAnomalyId(accountId: string, dayKey: string): string {
  return reviewId('grant-anomaly', `${accountId}:${dayKey}`);
}

/** `money-taken-nothing-granted:<deliveryId>`. */
export function moneyTakenId(deliveryId: string): string {
  return reviewId('money-taken-nothing-granted', deliveryId);
}

/**
 * File one finding, keyed by `id`. Returns `true` when a row actually landed and `false`
 * when this exact finding was already on the queue.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert, and the difference matters: the FIRST
 * filing is the record. Re-running the audit must not move `created_at` (which is how long
 * this has been waiting), must not reset a `reviewed` row back to `open`, and must not
 * overwrite the note a human wrote on it.
 */
export function fileReview(db: DatabaseSync, id: string, input: FileReviewInput): boolean {
  const res = db
    .prepare(
      `INSERT INTO review_queue
         (id, kind, account_id, day_key, summary, evidence_json, state, created_at, reviewed_at, note)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(id, input.kind, input.accountId, input.dayKey ?? null, input.summary, JSON.stringify(input.evidence), input.ts);
  return Number(res.changes) === 1;
}

interface ReviewSqlRow {
  id: string;
  kind: string;
  account_id: string;
  day_key: string | null;
  summary: string;
  evidence_json: string;
  state: string;
  created_at: number;
  reviewed_at: number | null;
  note: string | null;
}

function toEntry(r: ReviewSqlRow): ReviewEntry {
  let evidence: unknown = null;
  try {
    evidence = JSON.parse(r.evidence_json);
  } catch {
    // A hand-edited row. `null` rather than a throw: this table is explicitly meant to be
    // corrected at a `sqlite3` prompt (design/19 §8 declines to build an admin service), so
    // a typo in one row must not make the whole queue unreadable. The raw text is still in
    // the column for whoever is looking.
    evidence = null;
  }
  return {
    id: r.id,
    kind: r.kind as ReviewKind,
    accountId: r.account_id,
    dayKey: r.day_key,
    summary: r.summary,
    evidence,
    state: r.state as ReviewState,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    note: r.note,
  };
}

const COLUMNS =
  'id, kind, account_id, day_key, summary, evidence_json, state, created_at, reviewed_at, note';

/** Everything still waiting, oldest first — the queue, in the order it should be worked. */
export function openReviews(db: DatabaseSync, limit = 200): ReviewEntry[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM review_queue WHERE state = 'open' ORDER BY created_at ASC, id ASC LIMIT ?`)
    .all(limit) as unknown as ReviewSqlRow[];
  return rows.map(toEntry);
}

/** One entry by id. */
export function reviewById(db: DatabaseSync, id: string): ReviewEntry | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM review_queue WHERE id = ?`).get(id) as ReviewSqlRow | undefined;
  return row ? toEntry(row) : null;
}

/**
 * Close one entry. Guarded on `state = 'open'` for the same reason every other terminal
 * write in this plane is: a second close must not rewrite the first one's timestamp or note.
 * Returns whether this call is the one that closed it.
 */
export function markReviewed(db: DatabaseSync, id: string, ts: number, note?: string): boolean {
  const res = db
    .prepare(`UPDATE review_queue SET state = 'reviewed', reviewed_at = ?, note = ? WHERE id = ? AND state = 'open'`)
    .run(ts, note ?? null, id);
  return Number(res.changes) === 1;
}
