PRAGMA foreign_keys = ON;

CREATE TABLE shopping_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id),
  collection_id TEXT NOT NULL REFERENCES collection_runs(id),
  protocol_version TEXT NOT NULL,
  protocol_id TEXT NOT NULL,
  protocol_revision TEXT NOT NULL,
  controller_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'protocol_ready', 'queued', 'running', 'completed', 'incomplete',
    'budget_exhausted', 'failed_validation', 'cancelled'
  )),
  target_market TEXT NOT NULL,
  buyer_brief_key TEXT NOT NULL UNIQUE,
  buyer_brief_sha256 TEXT NOT NULL,
  protocol_key TEXT NOT NULL UNIQUE,
  protocol_sha256 TEXT NOT NULL,
  model_policy_key TEXT NOT NULL UNIQUE,
  model_policy_sha256 TEXT NOT NULL,
  target_identity_key TEXT NOT NULL UNIQUE,
  target_identity_sha256 TEXT NOT NULL,
  minimum_turns INTEGER NOT NULL CHECK (minimum_turns BETWEEN 2 AND 8),
  maximum_turns INTEGER NOT NULL CHECK (maximum_turns BETWEEN 2 AND 8),
  current_turn INTEGER NOT NULL DEFAULT 0 CHECK (current_turn BETWEEN 0 AND 8),
  completed_turns INTEGER NOT NULL DEFAULT 0 CHECK (completed_turns BETWEEN 0 AND 8),
  max_model_calls INTEGER NOT NULL CHECK (max_model_calls > 0),
  max_search_requests INTEGER NOT NULL CHECK (max_search_requests >= 0),
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens > 0),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  max_cost_usd_micros INTEGER NOT NULL CHECK (max_cost_usd_micros > 0),
  used_model_calls INTEGER NOT NULL DEFAULT 0 CHECK (used_model_calls >= 0),
  used_search_requests INTEGER NOT NULL DEFAULT 0 CHECK (used_search_requests >= 0),
  used_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (used_input_tokens >= 0),
  used_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (used_output_tokens >= 0),
  used_cost_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK (used_cost_usd_micros >= 0),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  CHECK (minimum_turns <= maximum_turns),
  CHECK (completed_turns <= current_turn),
  CHECK (current_turn <= maximum_turns)
);

CREATE TABLE shopping_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES shopping_sessions(id),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  stage TEXT NOT NULL CHECK (stage IN (
    'discovery', 'refinement', 'shortlist', 'comparison', 'decision', 'caveat_check'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'planned', 'query_generating', 'query_auditing', 'observer_queued',
    'observer_running', 'classifying', 'completed', 'incomplete', 'failed_validation'
  )),
  query_origin TEXT NOT NULL CHECK (query_origin IN (
    'protocol_generated', 'merchant_configured', 'merchant_written'
  )),
  controller_context_key TEXT NOT NULL UNIQUE,
  controller_context_sha256 TEXT NOT NULL,
  query_key TEXT,
  query_sha256 TEXT,
  observer_response_key TEXT,
  observer_response_sha256 TEXT,
  answer_shape TEXT CHECK (answer_shape IN (
    'no_concrete_options', 'single_option', 'shortlist',
    'large_candidate_set', 'comparison', 'decision'
  )),
  source_count INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (session_id, ordinal)
);

CREATE TABLE shopping_model_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES shopping_sessions(id),
  turn_id TEXT REFERENCES shopping_turns(id),
  role TEXT NOT NULL CHECK (role IN (
    'query_generator', 'query_auditor', 'shopping_observer', 'result_classifier'
  )),
  route_key TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider_order_json TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('low', 'medium', 'high')),
  search_enabled INTEGER NOT NULL CHECK (search_enabled IN (0, 1)),
  search_engine TEXT,
  max_search_requests INTEGER NOT NULL CHECK (max_search_requests >= 0),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  max_retries INTEGER NOT NULL CHECK (max_retries = 0),
  provider_fallback_allowed INTEGER NOT NULL CHECK (provider_fallback_allowed = 0),
  status TEXT NOT NULL CHECK (status IN (
    'reserved', 'queued', 'running', 'completed', 'incomplete',
    'failed_validation', 'budget_rejected'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_key TEXT,
  response_key TEXT,
  result_key TEXT,
  provider_response_id TEXT,
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens >= 0),
  search_requests INTEGER CHECK (search_requests >= 0),
  cost_usd_micros INTEGER CHECK (cost_usd_micros >= 0),
  latency_ms INTEGER CHECK (latency_ms >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE shopping_sources (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES shopping_sessions(id),
  turn_id TEXT NOT NULL REFERENCES shopping_turns(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  canonical_url TEXT NOT NULL,
  displayed_url TEXT,
  title TEXT,
  source_domain TEXT NOT NULL,
  provider_source_id TEXT,
  captured_key TEXT NOT NULL UNIQUE,
  captured_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (turn_id, ordinal)
);

CREATE TABLE shopping_candidate_observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES shopping_sessions(id),
  turn_id TEXT NOT NULL REFERENCES shopping_turns(id),
  normalized_name TEXT NOT NULL,
  displayed_name TEXT NOT NULL,
  merchant_domain TEXT,
  product_url TEXT,
  first_position INTEGER CHECK (first_position > 0),
  mentioned INTEGER NOT NULL CHECK (mentioned IN (0, 1)),
  compared INTEGER NOT NULL CHECK (compared IN (0, 1)),
  recommended INTEGER NOT NULL CHECK (recommended IN (0, 1)),
  final_choice INTEGER NOT NULL CHECK (final_choice IN (0, 1)),
  observation_key TEXT NOT NULL UNIQUE,
  observation_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Target evaluation is deliberately separate from controller context and
-- generic candidate observations. Application code must never join this table
-- when generating the next buyer question.
CREATE TABLE shopping_target_observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES shopping_sessions(id),
  turn_id TEXT NOT NULL REFERENCES shopping_turns(id),
  retrievability TEXT NOT NULL CHECK (retrievability IN (
    'not_observed', 'not_retrieved', 'retrieved'
  )),
  candidate_set TEXT NOT NULL CHECK (candidate_set IN (
    'not_observed', 'absent', 'included'
  )),
  comparison TEXT NOT NULL CHECK (comparison IN (
    'not_observed', 'not_compared', 'retained', 'rejected'
  )),
  recommendation TEXT NOT NULL CHECK (recommendation IN (
    'not_observed', 'not_recommended', 'recommended', 'final_choice'
  )),
  deterministic_match_key TEXT NOT NULL UNIQUE,
  semantic_evaluation_key TEXT,
  semantic_model_call_id TEXT REFERENCES shopping_model_calls(id),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, turn_id)
);

CREATE TABLE shopping_session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES shopping_sessions(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  event_sha256 TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE INDEX idx_shopping_sessions_account ON shopping_sessions(account_id, created_at);
CREATE INDEX idx_shopping_sessions_status ON shopping_sessions(status, updated_at);
CREATE INDEX idx_shopping_turns_session ON shopping_turns(session_id, ordinal);
CREATE INDEX idx_shopping_model_calls_session ON shopping_model_calls(session_id, role, created_at);
CREATE INDEX idx_shopping_model_calls_status ON shopping_model_calls(status, created_at);
CREATE INDEX idx_shopping_sources_turn ON shopping_sources(turn_id, ordinal);
CREATE INDEX idx_shopping_candidates_turn ON shopping_candidate_observations(turn_id, first_position);
CREATE INDEX idx_shopping_target_session ON shopping_target_observations(session_id, turn_id);
CREATE INDEX idx_shopping_events_session ON shopping_session_events(session_id, sequence);
