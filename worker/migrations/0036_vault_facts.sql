-- Vault v2: replace the field-def/group/template registry from 0034 with a
-- single lightweight per-entry "quick facts" table. That registry required
-- building a whole taxonomy in Settings before an entry could hold anything
-- structured — real friction, and (per Mike's own report) never actually
-- used, since Vault only just went live. `vault_facts` is the opposite: a
-- plain label/value row added inline on the entry itself, no setup, no
-- reuse-across-entries concept at all.
--
-- Deliberately additive-only. The 0034 registry tables (vault_field_defs,
-- vault_field_groups, vault_group_fields, vault_templates,
-- vault_template_groups, vault_entry_groups, vault_field_values,
-- vault_categories) are left in place, empty and unused, rather than
-- dropped — after the entities-table recreation in 0034 silently lost 75
-- rows on remote D1 last time, this migration does not touch `entities` or
-- drop anything at all. Cheap to leave a few dead tables around; not cheap
-- to risk that again.
--
-- Everything else about a Vault entry (Notes, Files, Links, Tasks, Pinned)
-- is just the existing `entities` parent/child mechanism already proven by
-- Projects — no schema needed for any of that.

CREATE TABLE IF NOT EXISTS vault_facts (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  value      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vault_facts_entry ON vault_facts(entry_id);
