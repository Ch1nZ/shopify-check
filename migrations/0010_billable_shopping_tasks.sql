PRAGMA foreign_keys = ON;

-- A customer task owns one controlled-shopping session and one credit
-- reservation. Qualification sessions keep these columns NULL and remain
-- non-billable.
ALTER TABLE shopping_sessions ADD COLUMN job_id TEXT REFERENCES jobs(id);
ALTER TABLE shopping_sessions ADD COLUMN credit_reservation_id TEXT REFERENCES credit_reservations(id);
ALTER TABLE shopping_sessions ADD COLUMN billing_status TEXT CHECK (
  billing_status IN ('reserved', 'consumed', 'released')
);

CREATE UNIQUE INDEX idx_shopping_sessions_job
  ON shopping_sessions(job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX idx_shopping_sessions_credit_reservation
  ON shopping_sessions(credit_reservation_id) WHERE credit_reservation_id IS NOT NULL;
