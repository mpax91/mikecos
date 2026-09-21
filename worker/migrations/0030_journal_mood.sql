-- Adds a quick visual mood rating to the daily journal entry — a plain
-- 1-5 integer (1 = rough, 5 = great; NULL = not logged) rather than a
-- free-text field, so it can be picked with one tap and charted as a trend
-- strip without any parsing. journal_entries already exists (see
-- 0020_journal.sql) and holds nothing but this day's freeform content, so
-- a plain ALTER TABLE ADD COLUMN is safe here — same rule this app always
-- follows for entities (see 0005_jots.sql): never recreate an existing
-- table, only ever add columns to it.
ALTER TABLE journal_entries ADD COLUMN mood INTEGER;
