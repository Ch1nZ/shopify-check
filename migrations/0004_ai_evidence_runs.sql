PRAGMA foreign_keys = ON;

ALTER TABLE collection_runs ADD COLUMN evidence_pack_key TEXT;

CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collection_runs(id),
  mode TEXT NOT NULL CHECK (mode IN ('fixture', 'live')),
  route_key TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_order_json TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('low', 'medium', 'high')),
  target_market TEXT NOT NULL,
  registry_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'fixture_completed', 'completed', 'incomplete', 'failed_validation')),
  evidence_pack_key TEXT NOT NULL,
  request_key TEXT,
  response_key TEXT,
  result_key TEXT,
  prompt_sha256 TEXT NOT NULL,
  provider_response_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd_micros INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_ai_runs_collection ON ai_runs(collection_id, created_at);
CREATE INDEX idx_ai_runs_status ON ai_runs(status, created_at);
