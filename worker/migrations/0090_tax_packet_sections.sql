-- Tax Packet notes are composed from per-account sections (one per live
-- statements folder), rendered into one auto-updated note per tax year.
ALTER TABLE statement_tax_packets ADD COLUMN sections_json TEXT;
ALTER TABLE statement_tax_packets ADD COLUMN children_json TEXT; -- managed note/link ids
