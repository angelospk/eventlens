-- Per-event settings. `auto_approve` is the per-night switch: when on, a photo goes
-- public the moment it is confirmed; when off, it waits for the manager.
CREATE TABLE IF NOT EXISTS events (
  event_date   TEXT PRIMARY KEY,
  title        TEXT,
  auto_approve INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Moderation is separate from upload `status`: a photo can be fully uploaded
-- (status='confirmed') and still not public. 'deleting' is a tombstone used to keep
-- R2 and D1 consistent when a delete fails halfway.
ALTER TABLE photos ADD COLUMN moderation TEXT NOT NULL DEFAULT 'pending';

-- Photos that predate moderation were already public on the wall; keep them visible
-- so this migration is not a silent blackout of past events.
UPDATE photos SET moderation = 'approved' WHERE status = 'confirmed';

-- Covers the public read path (event_date + status + moderation) and the manager list.
CREATE INDEX IF NOT EXISTS idx_photos_public ON photos(event_date, status, moderation);
