PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email_normalized TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE external_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, external_id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id),
  paddle_transaction_id TEXT NOT NULL UNIQUE,
  paddle_customer_id TEXT,
  pack_key TEXT NOT NULL,
  pricing_version TEXT NOT NULL,
  credit_grant INTEGER NOT NULL CHECK (credit_grant > 0),
  currency_code TEXT NOT NULL,
  amount TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,
  paddle_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_object_key TEXT,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE metering_customers (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  kong_customer_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE entitlement_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kong_entitlement_id TEXT NOT NULL UNIQUE,
  feature_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE credit_operations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('grant', 'usage', 'compensation', 'reversal')),
  external_idempotency_key TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL CHECK (credits > 0),
  status TEXT NOT NULL,
  external_operation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE credit_reservations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  job_id TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL CHECK (credits > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'consumed', 'released', 'reconciling')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE integration_outbox (
  id TEXT PRIMARY KEY,
  integration TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_object_key TEXT,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  pricing_version TEXT NOT NULL,
  reserved_credits INTEGER NOT NULL CHECK (reserved_credits > 0),
  reservation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  event_type TEXT NOT NULL,
  subject_id TEXT,
  metadata_object_key TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_account ON sessions(account_id, expires_at);
CREATE INDEX idx_purchases_account ON purchases(account_id, created_at);
CREATE INDEX idx_billing_events_status ON billing_events(status, received_at);
CREATE INDEX idx_credit_operations_account ON credit_operations(account_id, created_at);
CREATE INDEX idx_credit_reservations_account ON credit_reservations(account_id, status);
CREATE INDEX idx_outbox_pending ON integration_outbox(status, available_at);
CREATE INDEX idx_jobs_account ON jobs(account_id, created_at);
CREATE INDEX idx_jobs_status ON jobs(status, created_at);
