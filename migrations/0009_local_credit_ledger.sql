PRAGMA foreign_keys = ON;

-- Kong/OpenMeter was evaluated during preview setup but is not part of the
-- production architecture. D1 is the authoritative credit ledger.
DROP TABLE IF EXISTS entitlement_bindings;
DROP TABLE IF EXISTS metering_customers;

CREATE TABLE checkout_intents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  pack_key TEXT NOT NULL CHECK (pack_key IN ('starter', 'builder', 'studio')),
  price_id TEXT NOT NULL,
  pricing_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'expired', 'cancelled')),
  expires_at TEXT NOT NULL,
  paddle_transaction_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_checkout_intents_account
  ON checkout_intents(account_id, status, created_at);
CREATE INDEX idx_checkout_intents_expiry
  ON checkout_intents(status, expires_at);

CREATE INDEX idx_credit_operations_status
  ON credit_operations(account_id, status, created_at);

CREATE UNIQUE INDEX idx_credit_reservations_idempotency
  ON credit_reservations(account_id, job_id);
