PRAGMA foreign_keys = ON;

CREATE TABLE buyer_brief_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  collection_id TEXT NOT NULL REFERENCES collection_runs(id),
  route_key TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('low', 'medium', 'high')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  request_key TEXT NOT NULL UNIQUE,
  result_key TEXT,
  prompt_sha256 TEXT NOT NULL,
  provider_response_id TEXT,
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens >= 0),
  cost_usd_micros INTEGER CHECK (cost_usd_micros >= 0),
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_buyer_brief_runs_collection
  ON buyer_brief_runs(collection_id, created_at);
