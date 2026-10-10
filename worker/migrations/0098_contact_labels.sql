-- Contact labels (Mike, 2026-10-10): the user's own Google Contacts labels
-- ("Bedford Bee", "Legion", "Origin", …), kept as a JSON string array —
-- several per contact is normal. Before this the importer only used labels
-- to guess one of the six fixed circles and discarded the rest, so most
-- contacts showed "Other". Re-importing the Google CSV (merge) fills these
-- in; system labels ("* myContacts", "* starred") are dropped on import.
ALTER TABLE contacts ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
