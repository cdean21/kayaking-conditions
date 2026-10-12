-- Retain official warning feed check provenance and fail-closed status.
CREATE TABLE IF NOT EXISTS tbl_official_marine_checks (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 checked_at TEXT NOT NULL,
 status TEXT NOT NULL,
 details_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_official_marine_checks_time ON tbl_official_marine_checks(checked_at);
