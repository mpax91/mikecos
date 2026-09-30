-- Add optional price + source tracking to Bar items. Both are nullable —
-- Mike doesn't always know/remember what a bottle cost or where it came
-- from, especially for older stock, so neither is required to add an item.
-- "source" covers both a store name (freeform, like category) and the
-- non-store case of "someone gave me this" — the UI offers "Gift" as one
-- of the suggested values rather than adding a separate boolean column,
-- since a gift is just a source like any other and this keeps the one
-- text field doing both jobs.
ALTER TABLE bar_items ADD COLUMN price REAL;
ALTER TABLE bar_items ADD COLUMN source TEXT;
