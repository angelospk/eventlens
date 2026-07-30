-- A small copy of each photograph, made on the phone at upload time and stored beside the
-- original. The gallery shows hundreds of these instead of hundreds of full frames: a page
-- that cost a visitor tens of megabytes now costs a couple.
--
-- The thumbnail's key is derived from the original's (`<id>.webp` -> `<id>_t.webp`), so
-- there is nothing extra to store but the fact that one exists. Photographs uploaded before
-- this migration have none, and the reader falls back to the full frame for those.
ALTER TABLE photos ADD COLUMN has_thumb INTEGER NOT NULL DEFAULT 0;
