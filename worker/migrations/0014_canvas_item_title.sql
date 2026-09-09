-- Optional per-item title for organization on a board ("Boards" feature).
-- Additive ALTER on an existing table — always safe, unlike the DROP-TABLE
-- landmine that rules out ever recreating `entities` itself (see
-- 0011_task_completions.sql). Nullable and defaults to NULL: a title is
-- explicitly optional, most items won't have one.
ALTER TABLE canvas_items ADD COLUMN title TEXT;
