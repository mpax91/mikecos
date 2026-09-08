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

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ALLOWED_ORIGIN: string;
}
