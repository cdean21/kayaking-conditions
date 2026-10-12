CREATE TABLE IF NOT EXISTS tbl_bom_snapshots (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT NOT NULL
);
