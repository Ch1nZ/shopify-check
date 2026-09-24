PRAGMA foreign_keys = ON;

ALTER TABLE buyer_brief_runs ADD COLUMN research_route_key TEXT;
ALTER TABLE buyer_brief_runs ADD COLUMN research_model_id TEXT;
ALTER TABLE buyer_brief_runs ADD COLUMN research_reasoning_effort TEXT
  CHECK (research_reasoning_effort IS NULL OR research_reasoning_effort IN ('low', 'medium', 'high'));
ALTER TABLE buyer_brief_runs ADD COLUMN research_request_key TEXT;
ALTER TABLE buyer_brief_runs ADD COLUMN research_result_key TEXT;
ALTER TABLE buyer_brief_runs ADD COLUMN synthesis_request_key TEXT;
ALTER TABLE buyer_brief_runs ADD COLUMN research_provider_response_id TEXT;
ALTER TABLE buyer_brief_runs ADD COLUMN research_source_count INTEGER
  CHECK (research_source_count IS NULL OR research_source_count >= 0);
ALTER TABLE buyer_brief_runs ADD COLUMN research_search_requests INTEGER
  CHECK (research_search_requests IS NULL OR research_search_requests >= 0);
ALTER TABLE buyer_brief_runs ADD COLUMN understanding_key TEXT;
