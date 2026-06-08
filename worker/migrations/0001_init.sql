CREATE TABLE IF NOT EXISTS photos (
  id            TEXT PRIMARY KEY,
  r2_key        TEXT NOT NULL,
  public_url    TEXT NOT NULL,
  event_date    TEXT NOT NULL,
  original_name TEXT,
  width         INTEGER,
  height        INTEGER,
  bytes         INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending → confirmed (set by /meta)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_event_date ON photos(event_date);
CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(status);
