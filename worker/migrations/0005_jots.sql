-- Add Jots — top-level, temporary-by-design capture items (Keep-style),
-- sharing the same Tiptap `content` shape as notes so attachments/link-
-- previews render identically and "turn into note" is a pure flag change
-- with no content transformation needed.
--
-- IMPORTANT: this migration intentionally does NOT widen the entities.type
-- CHECK constraint (the original version of this migration did, via the
-- standard SQLite "recreate table" pattern — CREATE new table, copy rows,
-- DROP TABLE, RENAME). That pattern is SQLite-documented and works
-- correctly under plain local SQLite, but on this Cloudflare D1 database it
-- was confirmed (twice, reproducibly, against real production data) to
-- silently delete every row with a non-null parent_id — and even wrapping
-- the whole thing in PRAGMA foreign_keys=OFF/ON (which this migration's
-- original version already did) did not prevent it. See the 2026-09-06
-- incident writeup. Do not reintroduce a DROP TABLE on `entities` (or any
-- table it or `links` references) without exhaustively proving safety on a
-- disposable scratch D1 database first — and even then, prefer avoiding it.
--
-- Instead, Jots are stored as ordinary type='note' rows with a marker
-- column, which only needs a plain, unconditionally-safe ADD COLUMN.
ALTER TABLE entities ADD COLUMN is_jot INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_entities_is_jot ON entities(is_jot);
