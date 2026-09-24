PRAGMA foreign_keys = ON;

ALTER TABLE shopping_sessions ADD COLUMN execution_mode TEXT CHECK (
  execution_mode IS NULL OR execution_mode IN ('fixture', 'live')
);

ALTER TABLE shopping_model_calls ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'live' CHECK (
  execution_mode IN ('fixture', 'live')
);

CREATE INDEX idx_shopping_sessions_execution_mode
  ON shopping_sessions(execution_mode, status, updated_at);
