CREATE TABLE hosted_feedback (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('incorrect_result','unclear','technical_problem','suggestion')),
  message TEXT NOT NULL,
  email TEXT,
  task_id TEXT,
  product_url TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','resolved')),
  notification_status TEXT NOT NULL DEFAULT 'pending' CHECK(notification_status IN ('pending','sent','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX hosted_feedback_created ON hosted_feedback(created_at DESC);
