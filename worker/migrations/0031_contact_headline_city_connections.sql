-- Three additions to Contacts, inspired by a look at "Thanks Bud"
-- (heythanksbud.com): a quick one-line headline, a city (for a client-side
-- "what time is it for them" display — see src/utils/timezones.ts, no
-- server-side geocoding needed), and connections between contacts. All
-- additive to the existing `contacts` table (see 0005_jots.sql's comment
-- for why this table is never recreated) plus one brand-new table.
ALTER TABLE contacts ADD COLUMN headline TEXT;
ALTER TABLE contacts ADD COLUMN city TEXT;

-- One row per connection, stored in the direction it was created
-- (contact_id -> related) — GET /api/contacts/:id reads both directions
-- (WHERE contact_id = ? OR WHERE related_contact_id = ?) so a connection
-- only has to be entered once to show up on both people's cards.
-- related_name is always populated as a snapshot — the connection still
-- reads sensibly ("Spouse: Jane Doe") even if related_contact_id is NULL
-- (a Google Contacts "Relationship" pointing at someone who isn't a saved
-- contact) or the related contact is later deleted.
CREATE TABLE contact_connections (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  related_contact_id TEXT, -- NULL when the related person has no contact record of their own
  related_name TEXT NOT NULL,
  label TEXT NOT NULL, -- 'Spouse', 'Kid', 'Coworker', 'Household member', ...
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'import' (Google Contacts "Relation" columns)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_contact_connections_contact ON contact_connections(contact_id);
CREATE INDEX idx_contact_connections_related ON contact_connections(related_contact_id);
