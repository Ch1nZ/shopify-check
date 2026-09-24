PRAGMA foreign_keys = ON;

ALTER TABLE collection_runs ADD COLUMN technical_check_key TEXT;

CREATE TABLE source_snapshots_v2 (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collection_runs(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('html', 'shopify_ajax', 'robots')),
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

INSERT INTO source_snapshots_v2
SELECT id, collection_id, source_kind, requested_url, final_url, http_status,
       content_type, object_key, sha256, captured_at
FROM source_snapshots;

DROP TABLE source_snapshots;
ALTER TABLE source_snapshots_v2 RENAME TO source_snapshots;
CREATE INDEX idx_source_snapshots_collection ON source_snapshots(collection_id, source_kind);

CREATE TABLE technical_checks (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL UNIQUE REFERENCES collection_runs(id),
  schema_version TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
  robots_http_status INTEGER,
  created_at TEXT NOT NULL
);
