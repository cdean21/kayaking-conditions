CREATE TABLE IF NOT EXISTS tbl_recommendations (
  local_date TEXT PRIMARY KEY, site_id TEXT NOT NULL, activity TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', details_json TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recommendations_active ON tbl_recommendations(status, starts_at);
CREATE TABLE IF NOT EXISTS tbl_recommendation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, local_date TEXT NOT NULL, event_type TEXT NOT NULL, created_at TEXT NOT NULL, details_json TEXT NOT NULL, delivery_status TEXT NOT NULL DEFAULT 'pending', delivery_claimed_at TEXT, delivered_at TEXT, delivery_request_id TEXT, delivery_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_recommendation_events_pending ON tbl_recommendation_events(delivery_status, local_date, id);
