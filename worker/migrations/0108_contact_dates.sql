-- Other dates on a contact beyond birthday/anniversary (Google Contacts
-- "Event N" custom labels, Apple X-ABDATE, or added by hand on the card):
-- "Wedding", "Passed Away", "Gotcha Day"... Shown on Today like birthdays;
-- Family-labeled contacts also get a 7-day heads-up (contactDates.ts).
CREATE TABLE IF NOT EXISTS contact_dates (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  label TEXT NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  year INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_dates_contact ON contact_dates(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_dates_md ON contact_dates(month, day);
