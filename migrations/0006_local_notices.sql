CREATE TABLE IF NOT EXISTS tbl_local_notice_snapshots (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 fetched_at TEXT NOT NULL,
 payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_local_notice_snapshots_fetched ON tbl_local_notice_snapshots(fetched_at);
