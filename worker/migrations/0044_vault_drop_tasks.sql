-- Vault entries no longer have a Tasks section — see VaultPage.tsx's own
-- header comment ("reframed as reference rather than active work: no
-- status lifecycle") and the app's expiration/reminder system (0039), which
-- already covers the concrete renewal-tracking case a Vault task would
-- have been used for (a Vault attachment's expires_at auto-generates a
-- "Renew: ..." task in Today, 30 days out). Nothing left for a per-entry
-- to-do list to do.
--
-- Rather than deleting whatever tasks already exist under a Vault entry
-- outright, convert them to plain notes so nothing typed into one is lost —
-- a task's title becomes the note's title, and its description (if any;
-- TaskMeta = { description? }) becomes the note's body as a single
-- paragraph, in the same Tiptap doc shape every other note's content column
-- uses. due_date/due_time/due_position are meaningless on a note and get
-- cleared. Two passes: direct children of a vault_entry, then one level of
-- subtasks (now parented to a just-converted note) — deep enough for
-- anything that's realistically there.
UPDATE entities
SET
  type = 'note',
  is_jot = 0,
  status = NULL,
  content = CASE
    WHEN trim(coalesce(json_extract(content, '$.description'), '')) != ''
      THEN json_object('type', 'doc', 'content', json_array(json_object('type', 'paragraph', 'content', json_array(json_object('type', 'text', 'text', json_extract(content, '$.description'))))))
    ELSE json_object('type', 'doc', 'content', json_array())
  END,
  search_text = CASE WHEN trim(coalesce(json_extract(content, '$.description'), '')) != '' THEN json_extract(content, '$.description') ELSE NULL END,
  due_date = NULL,
  due_time = NULL,
  due_position = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE type = 'task'
  AND parent_id IN (SELECT id FROM entities WHERE type = 'vault_entry');

UPDATE entities
SET
  type = 'note',
  is_jot = 0,
  status = NULL,
  content = CASE
    WHEN trim(coalesce(json_extract(content, '$.description'), '')) != ''
      THEN json_object('type', 'doc', 'content', json_array(json_object('type', 'paragraph', 'content', json_array(json_object('type', 'text', 'text', json_extract(content, '$.description'))))))
    ELSE json_object('type', 'doc', 'content', json_array())
  END,
  search_text = CASE WHEN trim(coalesce(json_extract(content, '$.description'), '')) != '' THEN json_extract(content, '$.description') ELSE NULL END,
  due_date = NULL,
  due_time = NULL,
  due_position = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE type = 'task'
  AND parent_id IN (
    SELECT id FROM entities
    WHERE type = 'note' AND parent_id IN (SELECT id FROM entities WHERE type = 'vault_entry')
  );
