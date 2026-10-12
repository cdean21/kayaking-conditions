ALTER TABLE tbl_alert_events
ADD COLUMN delivery_claimed_at TEXT;

ALTER TABLE tbl_alert_events
ADD COLUMN delivery_error TEXT;

ALTER TABLE tbl_alert_events
ADD COLUMN pushover_request_id TEXT;
