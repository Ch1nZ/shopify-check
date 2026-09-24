PRAGMA foreign_keys = ON;

CREATE TABLE account_recovery_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_account_recovery_tokens_account
  ON account_recovery_tokens(account_id, created_at);
CREATE INDEX idx_account_recovery_tokens_expiry
  ON account_recovery_tokens(expires_at, used_at);

CREATE TABLE conversion_events (
  id TEXT PRIMARY KEY,
  journey_hash TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  site TEXT NOT NULL CHECK (site IN ('main', 'self_check')),
  event_name TEXT NOT NULL,
  path_group TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX idx_conversion_events_name_time
  ON conversion_events(event_name, received_at);
CREATE INDEX idx_conversion_events_journey_time
  ON conversion_events(journey_hash, received_at);
