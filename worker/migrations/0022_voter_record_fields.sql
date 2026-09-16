-- voter_records originally only pulled a handful of fields (party, age,
-- household_members, voting_history) out of Bedford's voter file, leaving
-- everything else to sit unlabeled in raw_data. Mike separately built the
-- Bedford Voter Intelligence app against this exact same county export and
-- it has a much richer, correctly-labeled breakdown — comparing a real
-- contact (Lisa Spano) side by side against that app is what surfaced this:
-- her birthday, full street address (with house number), gender,
-- registration date, phone, polling place, and several vendor-modeled
-- political fields (Causeway Tag, a calculated swing score, household
-- party lean, GOP targeting matrix) were all sitting in raw_data the whole
-- time, just never promoted to real columns. Two of the existing fields
-- were actively wrong, not just incomplete: household_members was
-- capturing the HOUSEHOLDPARTY column's value (an affiliation string, e.g.
-- "Republican/Other") because "household" matched too loosely — see
-- worker/src/index.ts's parseVoterCsv comment for the full column-mapping
-- story. household_party below is the correct home for that data;
-- household_members is left as-is (nothing currently writes to it — the
-- real per-person household lookup, matching everyone who shares a
-- household_code, is deferred rather than built now).
--
-- All ADDITIVE, all nullable — ALTER TABLE ADD COLUMN on an existing table
-- is safe without a backfill of its own (existing rows just get NULL,
-- exactly like any other optional field), same as every other additive
-- migration in this app. A separate one-time backfill pass (see
-- POST /api/contacts/voter-fields/backfill-chunk) re-parses each already-
-- imported voter contact's still-intact raw_data with this corrected
-- mapping to fill these in without requiring Mike to re-import the file.
ALTER TABLE voter_records ADD COLUMN gender TEXT;
ALTER TABLE voter_records ADD COLUMN registered_date TEXT;
ALTER TABLE voter_records ADD COLUMN phone TEXT;
ALTER TABLE voter_records ADD COLUMN polling_place TEXT;
-- Vendor-modeled political fields — confirmed to be genuine columns in the
-- raw file itself (not something the other app computed separately), so
-- these are straight pass-throughs, not calculations MikeOS needs to
-- replicate. gop_matrix only captures the generic-ballot matrix code
-- (NY_GOP_GENERICMATRIX) — the other app's own UI doesn't surface the
-- legislative-ballot variant either, so that one stays in raw_data only.
ALTER TABLE voter_records ADD COLUMN causeway_tag TEXT;
ALTER TABLE voter_records ADD COLUMN calculated_party TEXT;
ALTER TABLE voter_records ADD COLUMN household_party TEXT;
-- The real per-row household data this file has: a shared code to match
-- against other voters at the same address, not a names list. Captured now
-- (even though nothing displays it yet) so building the real household
-- cross-reference later doesn't need a re-import to get this value.
ALTER TABLE voter_records ADD COLUMN household_code TEXT;
-- Congressional / State Senate / Assembly / Legislative district codes —
-- not shown in the other app's own UI, but Mike asked for these
-- specifically given his Bedford Bee local-politics reporting.
ALTER TABLE voter_records ADD COLUMN cd TEXT;
ALTER TABLE voter_records ADD COLUMN sd TEXT;
ALTER TABLE voter_records ADD COLUMN ad TEXT;
ALTER TABLE voter_records ADD COLUMN ld TEXT;
ALTER TABLE voter_records ADD COLUMN gop_matrix TEXT;
