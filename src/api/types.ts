export type EntityType = 'project' | 'folder' | 'note' | 'task' | 'file' | 'link';

export interface FileMeta {
  r2_key: string;
  mime_type: string;
  size: number;
  filename: string;
}

export interface LinkMeta {
  url: string;
}

/** Tasks store their extra detail (everything beyond title/status) as
 * JSON in the shared `content` column — same pattern notes and files use
 * it for, just a different shape. */
export interface TaskMeta {
  description?: string;
  due_date?: string | null; // 'YYYY-MM-DD'
}

export interface Entity {
  id: string;
  type: EntityType;
  title: string;
  content: string | null;
  parent_id: string | null;
  is_top_level: number;
  status: string | null;
  position: number;
  pinned: number;
  last_touched: string | null;
  created_at: string;
  updated_at: string;
  /** Only present on task entities returned as children of another entity —
   * one level of the task's own child tasks, attached by the API so the
   * project view can render subtasks nested under their parent. */
  subtasks?: Entity[];
}

export interface ProjectListItem extends Entity {
  child_count: number;
  pinned_count: number;
  folder_count: number;
  note_count: number;
  open_task_count: number;
}

export interface EntityDetail {
  entity: Entity;
  breadcrumb: Entity[];
  children: Entity[];
}
