CREATE TABLE IF NOT EXISTS tbl_forecast_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 checked_at TEXT NOT NULL,
 status TEXT NOT NULL,
 error TEXT,
 weather_json TEXT,
 marine_json TEXT
);
CREATE TABLE IF NOT EXISTS tbl_opportunities (
 opportunity_key TEXT PRIMARY KEY,
 site_id TEXT NOT NULL,
 activity TEXT NOT NULL,
 starts_at TEXT NOT NULL,
 ends_at TEXT NOT NULL,
 score INTEGER NOT NULL,
 status TEXT NOT NULL,
 details_json TEXT NOT NULL,
 first_seen_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tbl_alert_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 opportunity_key TEXT NOT NULL,
 event_type TEXT NOT NULL,
 created_at TEXT NOT NULL,
 details_json TEXT NOT NULL,
 delivery_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_events_time ON tbl_alert_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_time ON tbl_opportunities(starts_at);
