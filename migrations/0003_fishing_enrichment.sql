-- Reserved for storing manually verified local tide predictions with provenance.
-- Never populate with Open-Meteo sea_level_height_msl as official tide values.
CREATE TABLE IF NOT EXISTS tbl_verified_tides (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reference_station TEXT NOT NULL,
 event_at TEXT NOT NULL,
 event_type TEXT NOT NULL CHECK(event_type IN ('high','low')),
 height_m REAL,
 datum TEXT,
 source_name TEXT NOT NULL,
 source_url TEXT NOT NULL,
 source_year INTEGER NOT NULL,
 recorded_at TEXT NOT NULL,
 UNIQUE(reference_station,event_at,source_name)
);
CREATE INDEX IF NOT EXISTS idx_verified_tides_event ON tbl_verified_tides(event_at);
