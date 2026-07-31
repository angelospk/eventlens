-- The index /days reads.
--
-- idx_photos_public starts with event_date, so a query that constrains only status and
-- moderation cannot use it and has to walk the whole thing. A partial index over just the
-- visible photographs is small — it holds nothing about pending, hidden or deleting rows —
-- and answers "which nights have photographs, and how many" straight from the index.
CREATE INDEX IF NOT EXISTS idx_photos_visible_by_date
  ON photos(event_date)
  WHERE status = 'confirmed' AND moderation = 'approved';
