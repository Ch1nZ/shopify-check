ALTER TABLE shopping_turns ADD COLUMN query_revision_count INTEGER NOT NULL DEFAULT 0
  CHECK (query_revision_count BETWEEN 0 AND 2);
