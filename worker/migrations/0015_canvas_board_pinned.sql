-- Pin-to-top for boards, matching the same feature on Projects. Additive
-- ALTER on an existing table (see 0014_canvas_item_title.sql's comment on
-- why this app never drops a table). Defaults to 0/unpinned so every
-- existing board keeps its current place in the list.
ALTER TABLE canvas_boards ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
