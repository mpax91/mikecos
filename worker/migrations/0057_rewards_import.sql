-- Rewards: a stable key for the quarterly research-and-import workflow.
-- Mike's plan is to run the actual "what does each card earn right now"
-- research as a separate Claude project once a quarter (issuer terms
-- barely fit in an app's UI to hand-maintain, and definitely don't fit a
-- schedule Mike would keep up manually) and have it hand MikeOS a JSON
-- file to ingest — see POST /api/rewards/import in worker/src/rewards.ts.
-- import_key is what ties an imported card back to the right existing row
-- across quarters (e.g. "chase-amazon-prime-visa") — a plain identity
-- string the research project assigns once and reuses every quarter,
-- independent of `nickname`, which Mike is free to rename. Cards Mike adds
-- by hand in the editor simply have no import_key and are never touched by
-- an import.
ALTER TABLE rewards_cards ADD COLUMN import_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rewards_cards_import_key ON rewards_cards(import_key) WHERE import_key IS NOT NULL;
