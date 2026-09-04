# MikeOS — V1.0 build spec

## What this ships

A live, deployed PWA with exactly one functional section: **Projects**. Everything else (Today, Inbox, Someday, Planning, Search) does not exist yet — no nav items, no placeholders, no "coming soon." The nav bar contains only "Projects" plus the app title/search-adjacent chrome described below.

This is not a stripped-down toy. It is the real foundation — the entity/linking data model is built to support every future module (daily plan, inbox/triage, CRM, RSS, calendar) without a schema rewrite. We are only building one *view* on top of that model today.

---

## Core data model (build this first, it's the foundation everything else stands on)

Single flexible entity table, not one table per type. This is the decision that makes future modules (Today, CRM, etc.) additive instead of migrations.

```
entities
  id            uuid, primary key
  type          text        -- 'project' | 'folder' | 'note' | 'task'
  title         text
  content       json/text   -- rich text doc (Tiptap JSON) for notes; null for folders
  parent_id     uuid, nullable, fk -> entities.id   -- for nesting
  is_top_level  boolean     -- true only for Projects (gets the "rich home" treatment)
  status        text, nullable   -- for tasks: open/done; for projects: active/archived
  position      integer     -- manual ordering within a parent
  last_touched  at          -- timestamp, updated on real edits only (not views)
                              -- powers Daily Revisit later; capture it now even if unused yet
  created_at    timestamp
  updated_at    timestamp

links
  id            uuid, primary key
  from_id       uuid, fk -> entities.id
  to_id         uuid, fk -> entities.id
  link_type     text, nullable   -- optional label, e.g. 'related', 'blocks' — keep loose for now
```

Notes:
- A **project** is just an entity with `type = 'project'` and `is_top_level = true`. A **folder** is `type = 'folder'`, nested under a project or another folder via `parent_id`. Tasks and notes can live at any depth, mixed with sub-folders, per `parent_id`.
- `last_touched` should update whenever content actually changes (edit, status change, re-file) — not on mere view/open. This is unused in V1.0's UI but must be captured now; retrofitting it later means back-filling history we won't have.
- Don't build a separate `projects` or `tasks` table. Every future module (Today view, Inbox, CRM contacts, RSS articles) is another `type` value in the same `entities` table, linked the same way.

---

## Projects section — functional scope

**Top-level Projects view** (`/projects`)
- List of all top-level projects: name, one-line description snippet, count of direct children.
- "+ New project" — opens a create form: name, description. No layout picker (List/Board/Calendar) in V1.0 — list only. No status field in V1.0 — add later if needed.

**Inside a project / folder** (`/projects/:id`, recursive)
- Breadcrumb trail at the top, always visible: `Job Search / Toyota / David`. Every crumb is a clickable link back up the tree.
- Only the top-level project gets a "header" treatment (title + description shown prominently). Nested folders just show their name and contents — no extra chrome.
- Contents area shows sub-folders grouped first, then notes/tasks below — mixed types allowed at one level, but visually separated by type so it reads as orderly, not a jumbled list (per Mike's explicit requirement).
- "+ New" button/menu inside any folder: New folder / New note / New task. Creates as a child of the current folder.
- Drag-and-drop reordering within a level (`position` field). Drag-to-reparent (moving into a different folder) is nice-to-have, not required for V1.0 — a "Move to..." action is an acceptable substitute if drag-to-reparent proves complex.

**Note editor**
- Tiptap, configured minimally: bold, italic, strikethrough, headings, bullet/ordered lists, blockquote, task list (checkboxes), table extension, mention extension (even though there's nothing to @mention yet — wire the extension in now, it's cheap, and it avoids a migration later).
- Formatting toolbar hidden by default, appears on focus/selection (Google Keep pattern) — not a permanent toolbar.
- Autosave on change (debounced), no explicit "save" button.

**Tasks**
- A task is a checkbox line — either its own entity (`type = 'task'`) sitting in a folder, or embedded as a checklist item inside a note's Tiptap content. Build support for the standalone entity version in V1.0 (simpler, matches the data model above); checklist-inside-notes comes free from the Tiptap task-list extension and needs no separate backend work.

---

## Visual design system (applies to all V1.0 screens)

**Palette — "Quiet study"**
- Page/paper background: `#FBF8F3`
- Sidebar background: `#F3EEE2`
- Border/hairline: `#E4DDCE`
- Ink (primary text): `#2E2A22`
- Muted text: `#8A7B5E`
- Placeholder text: `#B0A489`
- Accent (primary — buttons, active states, badges): deep green `#2F4A3C`, cream-on-green text `#EFE7D6`
- Accent (secondary — badges, due/age indicators): burnt orange `#B8632F`
- Post-it yellow (scratch pad only, not used elsewhere): `#F6DE7C`, border `#E0C458`

**Typography**
- Sans-serif for all UI chrome, labels, buttons, nav — sentence case for content, **Title Case for chrome labels only** (tab names, section headers, greeting text).
- Serif (e.g. Georgia or similar) reserved for exactly one moment: the app wordmark and any large date/greeting heading. Never use serif for body text, buttons, or dense UI.
- Two weights only: regular and medium/500. Nothing heavier.

**Layout**
- Left vertical sidebar (~150px), fixed: app name (serif), search field, nav list below. Currently only "Projects" appears in nav.
- Active nav item: solid accent-green background, cream text.
- Top of main content area: pinned tabs (Evernote-style) — a "+" affordance to open new tabs is expected UI even if only one tab (Projects) is meaningful right now.
- Generous whitespace by default; tighten only where content density genuinely requires it (task lists, nav).
- Cards: white background, 0.5px border in `--border`, 8–12px radius. No shadows, no gradients.
- Badges (e.g. counts): filled pill, accent-orange background, white text.

**What NOT to build yet:** weather/greeting widget, scratch pad, Daily Revisit, Today view, Inbox, Someday, search functionality, calendar sync. These were designed and mocked up in an earlier planning conversation and remain the target for later phases — don't build their UI shells into V1.0's nav or homepage, since Mike explicitly wants nothing visible except what's real.

---

## Tech stack

- **Frontend:** React PWA (installable, offline-capable shell at minimum — full offline data sync can come later)
- **Editor:** Tiptap (ProseMirror-based), extensions: StarterKit, TaskList/TaskItem, Table, Mention
- **Backend:** Cloudflare Worker (API layer) + Cloudflare D1 (SQLite-based relational DB) — matches the `entities` + `links` schema above
- **Hosting:** Cloudflare Pages (frontend) + Worker (API), custom domain optional at this stage
- **Repo:** GitHub, connected to Cloudflare Pages for CI/deploy on push

---

## Explicitly out of scope for V1.0 (future phases, already designed, not forgotten)

- Today / daily plan (fixed-day view, rollover-as-decision, hybrid ordering)
- Inbox + Triage flow, capture-anywhere quick-add
- Someday/Maybe + universal Daily Revisit (staleness engine across all entity types)
- Week/month/quarter/year planning view
- Google Calendar 2-way sync
- Full-text search
- CRM, RSS reader, health dashboard
- Recurring task engine

All of these are compatible with the `entities`/`links` schema above — they are new `type` values and new views, not schema rewrites.
