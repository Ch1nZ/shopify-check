PRAGMA foreign_keys = ON;

CREATE TABLE collection_runs (
  id TEXT PRIMARY KEY,
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial', 'blocked')),
  product_record_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collection_runs(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('html', 'shopify_ajax')),
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE product_records (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL UNIQUE REFERENCES collection_runs(id),
  schema_version TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  title_state TEXT NOT NULL,
  price_state TEXT NOT NULL,
  currency_state TEXT NOT NULL,
  availability_state TEXT NOT NULL,
  variant_count INTEGER NOT NULL CHECK (variant_count >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE technical_findings (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collection_runs(id),
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  message TEXT NOT NULL,
  evidence_paths_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_source_snapshots_collection ON source_snapshots(collection_id, source_kind);
CREATE INDEX idx_findings_collection ON technical_findings(collection_id, severity);
