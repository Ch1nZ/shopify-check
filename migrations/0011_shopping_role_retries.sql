PRAGMA foreign_keys = ON;

ALTER TABLE shopping_model_calls ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (attempt_count BETWEEN 0 AND 3);
