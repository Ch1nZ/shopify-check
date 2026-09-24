PRAGMA foreign_keys = ON;

-- Owner-only trial product list. Not used by public conversion events.
CREATE TABLE owner_product_attempts (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id),
  job_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('preview', 'diagnostic')),
  billing_kind TEXT NOT NULL CHECK (billing_kind IN ('none', 'free_check', 'paid')),
  product_url TEXT NOT NULL,
  shop_domain TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_owner_product_attempts_created
  ON owner_product_attempts(created_at);
CREATE INDEX idx_owner_product_attempts_shop
  ON owner_product_attempts(shop_domain, created_at);
CREATE INDEX idx_owner_product_attempts_account
  ON owner_product_attempts(account_id, created_at);
CREATE INDEX idx_owner_product_attempts_job
  ON owner_product_attempts(job_id);
