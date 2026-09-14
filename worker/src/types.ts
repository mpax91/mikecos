export type EntityType = 'project' | 'folder' | 'note' | 'task' | 'file' | 'link';
export type TaskStatus = 'open' | 'done';
export type ProjectStatus = 'active' | 'archived';

export interface Entity {
  id: string;
  type: EntityType;
  title: string;
  content: string | null;
  parent_id: string | null;
  is_top_level: number; // 0 | 1 (D1/SQLite boolean)
  status: string | null;
  position: number;
  pinned: number; // 0 | 1
  is_jot: number; // 0 | 1 — a Jot is stored as type='note' with this flag set, not a distinct type (see migrations/0005_jots.sql)
  due_date: string | null; // 'YYYY-MM-DD' — tasks only (see migrations/0006_planner.sql)
  due_time: string | null; // 'HH:MM' 24h, tasks only, meaningless without due_date (see migrations/0009_due_time.sql)
  due_position: number | null; // manual order among same-due_date tasks — Day view promote/demote (see migrations/0010_due_position.sql)
  last_touched: string | null;
  created_at: string;
  updated_at: string;
  search_text?: string | null; // plain-text mirror of `content`, for future search — not yet queried

  subtasks?: Entity[]; // attached in-memory for task children only, not a DB column
  media?: Entity[]; // attached in-memory for task children only (file/link attachments), not a DB column
  is_recurring?: boolean; // attached in-memory — true when this task is the live instance of an active recurring_task_definitions row (its current_task_id), not a DB column on entities itself. See markRecurring in index.ts.
}

export interface Link {
  id: string;
  from_id: string;
  to_id: string;
  link_type: string | null;
  created_at: string;
}

export interface FileMeta {
  r2_key: string;
  mime_type: string;
  size: number;
  filename: string;
}

export interface LinkMeta {
  url: string;
  preview_title?: string | null;
  preview_image?: string | null;
  preview_domain?: string | null;
}

// 'connector' is a freestanding line/arrow object (added migrations/0014 —
// see CanvasItemView / the connector-content comment in CanvasBoardPage.tsx
// on the frontend for the shape of its `content`), not a relationship
// between two other items stored elsewhere — it's just another item.
export type CanvasItemType = 'image' | 'text' | 'note' | 'connector';

export interface CanvasBoard {
  id: string;
  title: string;
  pinned: number; // 0 | 1 — pin-to-top on the boards list, same as Entity.pinned for Projects
  created_at: string;
  updated_at: string;
}

// `content` is stored as a JSON TEXT column (see migrations/0012_canvas_boards.sql
// for the per-type shape) — kept as a raw string here, same as Entity.content,
// and parsed/typed only where a handler actually needs to look inside it.
export interface CanvasItem {
  id: string;
  board_id: string;
  type: CanvasItemType;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  content: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

// No stored anchor/side — the line's actual endpoints are derived at
// render time from each item's current box (nearest-edge-midpoint), which
// is what makes the arrow "move with" its cards automatically.
export interface CanvasConnector {
  id: string;
  board_id: string;
  from_item_id: string;
  to_item_id: string;
  created_at: string;
}

// A parked item on the Jots page's "Shelf" — see migrations/0016_shelf_items.sql
// for the per-type `content` shapes. Deliberately flat/global (no board_id
// or parent_id): the Shelf is one drop zone for the whole app, not scoped
// to a project or board.
export type ShelfItemType = 'text' | 'image' | 'link' | 'file';

export interface ShelfItem {
  id: string;
  type: ShelfItemType;
  content: string;
  pinned: number; // 0 | 1 — pin-to-top, same as Entity.pinned
  created_at: string;
}

// See migrations/0017_contacts.sql for the reasoning behind this shape —
// multi-value fields and split month/day/year dates, kept off the Entity
// schema entirely.
export type ContactCircle = 'family' | 'friends' | 'neighbors' | 'community' | 'professional' | 'other';

export interface Contact {
  id: string;
  name: string;
  company: string | null;
  title: string | null;
  circle: ContactCircle;
  emails: string; // JSON string[]
  phones: string; // JSON string[]
  address: string | null;
  birthday_month: number | null;
  birthday_day: number | null;
  birthday_year: number | null;
  anniversary_month: number | null;
  anniversary_day: number | null;
  anniversary_year: number | null;
  pinned: number; // 0 | 1
  source: string;
  created_at: string;
  updated_at: string;
}

export type ContactNoteSourceType = 'quick_note' | 'jot' | 'note' | 'task';

export interface ContactNote {
  id: string;
  contact_id: string;
  text: string;
  source_type: ContactNoteSourceType;
  source_id: string | null;
  remind_at: string | null;
  remind_resolved: number; // 0 | 1
  created_at: string;
}

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ALLOWED_ORIGIN: string;
}
