PRAGMA foreign_keys = ON;

ALTER TABLE shopping_model_calls ADD COLUMN claim_token TEXT;
ALTER TABLE shopping_model_calls ADD COLUMN claimed_at TEXT;

CREATE UNIQUE INDEX idx_shopping_model_calls_claim_token
  ON shopping_model_calls(claim_token)
  WHERE claim_token IS NOT NULL;
