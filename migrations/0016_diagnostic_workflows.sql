PRAGMA foreign_keys = ON;

CREATE TABLE diagnostic_workflows (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  input_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  step_attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TEXT,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX diagnostic_workflows_recovery ON diagnostic_workflows(status, next_run_at, lease_until);

CREATE TABLE diagnostic_checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  parent_id TEXT,
  checkpoint_type TEXT NOT NULL,
  checkpoint BLOB NOT NULL,
  metadata_type TEXT NOT NULL,
  metadata BLOB NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);
CREATE TABLE diagnostic_checkpoint_writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

ALTER TABLE shopping_model_calls ADD COLUMN model_call_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shopping_model_calls ADD COLUMN reserved_model_call_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE shopping_model_calls ADD COLUMN accounted_cost_usd_micros INTEGER;
ALTER TABLE buyer_brief_runs ADD COLUMN model_call_count INTEGER NOT NULL DEFAULT 2;

ALTER TABLE shopping_model_calls ADD COLUMN retry_not_before TEXT;
