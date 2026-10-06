-- Promos get a real Sport (nullable = usable on any sport, e.g. a bonus
-- bet), so the Workspace promos box can show and filter by it instead of
-- the sport living as the first word of the free-text description.
ALTER TABLE bet_promos ADD COLUMN sport TEXT;

-- Backfill: pull a leading sport token out of existing descriptions
-- ("NHL ATG" -> sport NHL, description "ATG"; "MLB" -> sport MLB, "").
UPDATE bet_promos SET sport = 'NCAAF', description = TRIM(SUBSTR(description, 6)) WHERE sport IS NULL AND (UPPER(description) = 'NCAAF' OR UPPER(description) LIKE 'NCAAF %');
UPDATE bet_promos SET sport = 'NCAAB', description = TRIM(SUBSTR(description, 6)) WHERE sport IS NULL AND (UPPER(description) = 'NCAAB' OR UPPER(description) LIKE 'NCAAB %');
UPDATE bet_promos SET sport = 'NFL', description = TRIM(SUBSTR(description, 4)) WHERE sport IS NULL AND (UPPER(description) = 'NFL' OR UPPER(description) LIKE 'NFL %');
UPDATE bet_promos SET sport = 'NBA', description = TRIM(SUBSTR(description, 4)) WHERE sport IS NULL AND (UPPER(description) = 'NBA' OR UPPER(description) LIKE 'NBA %');
UPDATE bet_promos SET sport = 'MLB', description = TRIM(SUBSTR(description, 4)) WHERE sport IS NULL AND (UPPER(description) = 'MLB' OR UPPER(description) LIKE 'MLB %');
UPDATE bet_promos SET sport = 'NHL', description = TRIM(SUBSTR(description, 4)) WHERE sport IS NULL AND (UPPER(description) = 'NHL' OR UPPER(description) LIKE 'NHL %');

-- "-" was being typed to mean "no requirement"; store that as NULL.
UPDATE bet_promos SET legs = NULL WHERE TRIM(legs) IN ('', '-', '—', '–');
UPDATE bet_promos SET odds = NULL WHERE TRIM(odds) IN ('', '-', '—', '–');
UPDATE bet_promos SET amount = NULL WHERE TRIM(amount) IN ('', '-', '—', '–');
