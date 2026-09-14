-- Fixes a real production bug: a large import (12,109-row voter file) was
-- committed as one giant sequential request — no chunking, no batching,
-- nothing wrapping it atomically — and died partway through with no trace
-- (the import_batches summary row is written last, so a request that dies
-- mid-loop leaves real contacts in the database but zero record of the
-- import ever happening). Both columns below are additive ALTER TABLE ADD
-- COLUMN, safe on the existing table per this project's migration
-- convention.
--
-- `status` lets a batch be created up front (as 'in_progress') the moment
-- an import starts, rather than only appearing once every row is done —
-- so a dropped connection leaves a visible, inspectable 'in_progress' row
-- instead of silently vanishing. `total_rows` is the expected count, so
-- Settings can show real progress ("4,200 / 12,109") and tell a genuinely
-- finished import apart from one that stalled partway.
ALTER TABLE import_batches ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE import_batches ADD COLUMN total_rows INTEGER;
