-- Adds light, auto-detected typing to Quick Facts so Rollups can filter by
-- year (dates) or match numeric amounts (currency) instead of only raw
-- substring text. Nothing is asked of Mike up front — no type picker, no
-- schema to define — a fact's value_type/value_norm are just computed
-- server-side from what he typed (see detectFactValue in vault.ts) whenever
-- a fact is created or its value is edited. Existing facts stay untyped
-- (both columns NULL) until next touched; that's fine, it only means older
-- entries won't show up in a year filter until re-saved.
ALTER TABLE vault_facts ADD COLUMN value_type TEXT;
ALTER TABLE vault_facts ADD COLUMN value_norm TEXT;
