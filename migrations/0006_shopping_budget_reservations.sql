PRAGMA foreign_keys = ON;

ALTER TABLE shopping_sessions ADD COLUMN reserved_model_calls INTEGER NOT NULL DEFAULT 0 CHECK (reserved_model_calls >= 0);
ALTER TABLE shopping_sessions ADD COLUMN reserved_search_requests INTEGER NOT NULL DEFAULT 0 CHECK (reserved_search_requests >= 0);
ALTER TABLE shopping_sessions ADD COLUMN reserved_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_input_tokens >= 0);
ALTER TABLE shopping_sessions ADD COLUMN reserved_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_output_tokens >= 0);
ALTER TABLE shopping_sessions ADD COLUMN reserved_cost_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost_usd_micros >= 0);

ALTER TABLE shopping_model_calls ADD COLUMN reserved_search_requests INTEGER NOT NULL DEFAULT 0 CHECK (reserved_search_requests >= 0);
ALTER TABLE shopping_model_calls ADD COLUMN reserved_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_input_tokens >= 0);
ALTER TABLE shopping_model_calls ADD COLUMN reserved_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_output_tokens >= 0);
ALTER TABLE shopping_model_calls ADD COLUMN reserved_cost_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost_usd_micros >= 0);
