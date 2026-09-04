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
}

export interface ProjectListItem extends Entity {
  child_count: number;
}

export interface EntityDetail {
  entity: Entity;
  breadcrumb: Entity[];
  children: Entity[];
}
