PRAGMA foreign_keys = ON;

CREATE TABLE account_signup_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_account_signup_tokens_account
  ON account_signup_tokens(account_id, created_at);
CREATE INDEX idx_account_signup_tokens_email
  ON account_signup_tokens(email_normalized, created_at);
CREATE INDEX idx_account_signup_tokens_expiry
  ON account_signup_tokens(expires_at, used_at);

CREATE TABLE free_check_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  email_normalized TEXT NOT NULL UNIQUE,
  credit_operation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_free_check_grants_account
  ON free_check_grants(account_id, created_at);
CREATE INDEX idx_free_check_grants_created
  ON free_check_grants(created_at);

CREATE TABLE free_check_admissions (
  reservation_id TEXT PRIMARY KEY REFERENCES credit_reservations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  job_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_free_check_admissions_account
  ON free_check_admissions(account_id, created_at);
