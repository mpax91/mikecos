-- Calls & Texts: when the newest phone backup landed in Drive (upload time
-- of the newest calls/sms file), so MikeOS can warn when the backup app
-- stops sending (2026-10-11). worker/src/comms/ingest.ts.
ALTER TABLE comm_settings ADD COLUMN latest_backup_at TEXT;
