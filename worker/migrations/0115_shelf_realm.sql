-- Shelf items follow the All · Personal · Work switch (Mike, 2026-10-12).
-- Existing items default to 'personal', the same default 0106 gave every
-- other table; each tile's ⋯ menu moves one between Personal and Work.
ALTER TABLE shelf_items ADD COLUMN realm TEXT NOT NULL DEFAULT 'personal';
