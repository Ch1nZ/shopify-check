import { DurableObject } from "cloudflare:workers";

import type {
  CreditAdmissionResult,
  CreditReservationRequest,
  CreditReservationSnapshot,
} from "@mclab/contracts";

type StoredReservation = {
  reservation_id: string;
  credits: number;
  status: CreditReservationSnapshot["status"];
};

export class CreditAdmission extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS reservations (
          reservation_id TEXT PRIMARY KEY,
          credits INTEGER NOT NULL CHECK (credits > 0),
          status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
        INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
      `);
    });
  }

  async reserve(input: CreditReservationRequest): Promise<CreditAdmissionResult> {
    validateReservationRequest(input);

    const existing = this.ctx.storage.sql
      .exec<StoredReservation>(
        "SELECT reservation_id, credits, status FROM reservations WHERE reservation_id = ?",
        input.reservationId,
      )
      .toArray()[0];

    const openReservedCredits = this.openReservedCredits();

    if (existing) {
      if (existing.credits !== input.credits) {
        throw new Error("Reservation replay used a different credit amount.");
      }

      return {
        admitted: existing.status !== "released",
        availableBefore: Math.max(0, input.observedBalance - openReservedCredits),
        openReservedCredits,
        reason: "idempotent_replay",
      };
    }

    const availableBefore = Math.max(0, input.observedBalance - openReservedCredits);
    if (availableBefore < input.credits) {
      return {
        admitted: false,
        availableBefore,
        openReservedCredits,
        reason: "insufficient_credits",
      };
    }

    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO reservations (reservation_id, credits, status, created_at, updated_at)
       VALUES (?, ?, 'reserved', ?, ?)`,
      input.reservationId,
      input.credits,
      timestamp,
      timestamp,
    );

    return {
      admitted: true,
      availableBefore,
      openReservedCredits,
      reason: "admitted",
    };
  }

  async consume(reservationId: string): Promise<void> {
    this.transition(reservationId, "consumed");
  }

  async release(reservationId: string): Promise<void> {
    this.transition(reservationId, "released");
  }

  async snapshot(): Promise<CreditReservationSnapshot[]> {
    return this.ctx.storage.sql
      .exec<StoredReservation>(
        "SELECT reservation_id, credits, status FROM reservations ORDER BY created_at, reservation_id",
      )
      .toArray()
      .map((row) => ({
        reservationId: row.reservation_id,
        credits: row.credits,
        status: row.status,
      }));
  }

  private openReservedCredits(): number {
    return this.ctx.storage.sql
      .exec<{ total: number }>(
        "SELECT COALESCE(SUM(credits), 0) AS total FROM reservations WHERE status = 'reserved'",
      )
      .one().total;
  }

  private transition(
    reservationId: string,
    target: CreditReservationSnapshot["status"],
  ): void {
    if (!reservationId) {
      throw new Error("Reservation ID is required.");
    }

    const existing = this.ctx.storage.sql
      .exec<StoredReservation>(
        "SELECT reservation_id, credits, status FROM reservations WHERE reservation_id = ?",
        reservationId,
      )
      .toArray()[0];

    if (!existing) {
      throw new Error("Reservation does not exist.");
    }
    if (existing.status === target) {
      return;
    }
    if (existing.status !== "reserved") {
      throw new Error(`Cannot transition ${existing.status} reservation to ${target}.`);
    }

    this.ctx.storage.sql.exec(
      "UPDATE reservations SET status = ?, updated_at = ? WHERE reservation_id = ?",
      target,
      new Date().toISOString(),
      reservationId,
    );
  }
}

function validateReservationRequest(input: CreditReservationRequest): void {
  if (!input.reservationId) {
    throw new Error("Reservation ID is required.");
  }
  if (!Number.isSafeInteger(input.observedBalance) || input.observedBalance < 0) {
    throw new Error("Observed balance must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(input.credits) || input.credits <= 0) {
    throw new Error("Credits must be a positive integer.");
  }
}
