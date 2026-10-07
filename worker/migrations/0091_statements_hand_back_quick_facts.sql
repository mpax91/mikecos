-- Quick Facts are Mike's (evergreen, hand-curated). Statements no longer
-- manages any: facts it created become ordinary facts (keeping Mike's
-- edits), and the auto Tax Packet total (a changing number) is removed —
-- it lives in the Tax Items note now.
UPDATE vault_facts SET managed_key = NULL WHERE managed_key LIKE 'ny529:%';
DELETE FROM vault_facts WHERE managed_key LIKE 'tax:%';
