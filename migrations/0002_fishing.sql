-- Future catch logs and preferences; species metadata is defined in fishing.js.
CREATE TABLE IF NOT EXISTS tbl_fishing_trips (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 site_id TEXT NOT NULL,
 started_at TEXT NOT NULL,
 ended_at TEXT,
 notes TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tbl_catches (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 trip_id INTEGER NOT NULL REFERENCES tbl_fishing_trips(id),
 species_id TEXT NOT NULL,
 caught_at TEXT NOT NULL,
 disposition TEXT NOT NULL CHECK (disposition IN ('kept','released')),
 length_cm REAL,
 method TEXT,
 notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_catches_trip ON tbl_catches(trip_id);
CREATE TABLE IF NOT EXISTS tbl_fishing_preferences (
 preference_key TEXT PRIMARY KEY,
 value_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
