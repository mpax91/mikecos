-- Groundwork for future full-text search: a plain-text mirror of each
-- entity's rich content, kept in sync on every content save so a later
-- search feature has clean data to index without a historical backfill.
-- Nullable and unused by any query yet — this migration only adds the column.

ALTER TABLE entities ADD COLUMN search_text TEXT;
