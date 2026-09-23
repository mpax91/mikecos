-- CreditKarma reports the average of two bureau scores (TransUnion and
-- Equifax) rather than a single number, which is why the historical
-- creditkarma column has values like 832.5. Two changes:
--
-- 1. Credit scores are always whole numbers — round every existing
--    creditkarma value to the nearest integer (SQLite's ROUND() rounds
--    .5 away from zero, matching "832.5 -> 833"). CreditSesame,
--    Discover/Fico, and CreditWise were already all whole numbers
--    historically, so they don't need this.
-- 2. Add creditkarma_transunion / creditkarma_equifax so the "add this
--    month" form can capture CreditKarma's two underlying bureau scores
--    going forward instead of one pre-averaged number — the server
--    computes creditkarma = round(avg(transunion, equifax)) from these
--    on write. Nullable and historical-import rows leave them NULL; the
--    single creditkarma column remains the source of truth every other
--    calculation (entryAverage, the trend chart, etc.) reads from.
UPDATE credit_score_entries SET creditkarma = ROUND(creditkarma) WHERE creditkarma IS NOT NULL;

ALTER TABLE credit_score_entries ADD COLUMN creditkarma_transunion REAL;
ALTER TABLE credit_score_entries ADD COLUMN creditkarma_equifax REAL;
