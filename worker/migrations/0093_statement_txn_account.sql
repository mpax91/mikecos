-- Multi-account statements (Ally Bank's combined statement covers checking
-- + savings): each transaction row records which account it belongs to
-- (last 4 digits). NULL for single-account templates (529, ADT).
ALTER TABLE statement_transactions ADD COLUMN account TEXT;
