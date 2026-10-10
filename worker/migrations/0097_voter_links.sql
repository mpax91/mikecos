-- Voter Insight + durable personal<->voter links (Mike, 2026-10-10).
--
-- About half the roll will end up merged into Mike's personal contacts.
-- Before this, a voter-file "Replace" import (a new county cut) deleted
-- every voter_records row — including the ones merged into personal
-- contacts — so every merged person lost their voter data and came back as
-- a standalone duplicate. Fix: key each voter record by the statewide
-- voter id (NYSVOTERID, else the county VOTERID) and remember which
-- personal contact owns that voter. Replace re-attaches to that contact
-- instead of creating a duplicate.
--
-- All additive. voter_key is backfilled from raw_data (values may carry a
-- CSV formula escape: ="NY0000…").
ALTER TABLE voter_records ADD COLUMN voter_key TEXT;

UPDATE voter_records SET voter_key = COALESCE(
  NULLIF(TRIM(REPLACE(json_extract(raw_data, '$.NYSVOTERID'), '=', ''), '" '), ''),
  NULLIF(TRIM(REPLACE(json_extract(raw_data, '$.VOTERID'), '=', ''), '" '), '')
)
WHERE json_valid(raw_data);

CREATE INDEX idx_voter_records_key ON voter_records(voter_key);
-- The household lookup on every contact page scans by household_code.
CREATE INDEX idx_voter_records_household ON voter_records(household_code);

-- voter_key -> the contact that person is in MikeOS. Survives a Replace
-- import (which deletes voter_records). Written whenever a voter record
-- lands on a contact that isn't a bare voter-roll contact (merge, import
-- match) — and for voter-roll contacts Mike has annotated (notes,
-- connections, pinned, a circle), which Replace now keeps too.
CREATE TABLE contact_voter_links (
  voter_key TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_contact_voter_links_contact ON contact_voter_links(contact_id);

INSERT OR IGNORE INTO contact_voter_links (voter_key, contact_id, created_at)
SELECT vr.voter_key, vr.contact_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM voter_records vr JOIN contacts c ON c.id = vr.contact_id
WHERE vr.voter_key IS NOT NULL AND c.source != 'voter_file';

-- "Keep Mine" answers to the card's Voter File Differs check. One row per
-- contact + field; it only silences that field while the voter file still
-- says the same thing (voter_value) — a changed voter value asks again.
-- "Use Voter File" writes the value onto the contact and records 'use'.
CREATE TABLE contact_voter_reviews (
  contact_id TEXT NOT NULL,
  field TEXT NOT NULL,
  voter_value TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, field)
);
