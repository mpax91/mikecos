import type { Entity, EntityDetail, EntityType, ProjectListItem } from './types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8787';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<ProjectListItem[]>('/api/projects'),

  createProject: (title: string, description: string) =>
    request<Entity>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ title, description }),
    }),

  getEntity: (id: string) => request<EntityDetail>(`/api/entities/${id}`),

  createEntity: (params: {
    type: Exclude<EntityType, 'project' | 'file'>;
    title?: string;
    content?: string | null;
    parent_id: string;
    status?: string | null;
  }) =>
    request<Entity>('/api/entities', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  createLink: (parent_id: string, url: string, title?: string) =>
    request<Entity>('/api/entities', {
      method: 'POST',
      body: JSON.stringify({ type: 'link', parent_id, content: JSON.stringify({ url }), title: title || url }),
    }),

  uploadFile: async (file: File, parent_id?: string): Promise<Entity> => {
    const form = new FormData();
    form.append('file', file);
    if (parent_id) form.append('parent_id', parent_id);
    const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json();
  },

  /** Inline upload for note attachments — returns the file's URL/metadata
   * without creating a folder-level entity. */
  uploadInline: async (file: File): Promise<{ url: string; filename: string; mime_type: string; size: number; r2_key: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    // The worker returns a path relative to itself (e.g. "/api/files/xyz");
    // resolve it against API_BASE here so embedding it directly in an <img>/
    // <iframe> src or a download link works regardless of what origin the
    // app itself is served from.
    return { ...data, url: `${API_BASE}${data.url}` };
  },

  fileUrl: (key: string, download = false) => `${API_BASE}/api/files/${key}${download ? '?download=1' : ''}`,

  deleteFileKey: (key: string) => request<{ ok: true }>(`/api/files/${key}`, { method: 'DELETE' }),

  updateEntity: (
    id: string,
    patch: Partial<Pick<Entity, 'title' | 'content' | 'status' | 'parent_id' | 'position' | 'pinned'>>
  ) =>
    request<Entity>(`/api/entities/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteEntity: (id: string) =>
    request<{ ok: true }>(`/api/entities/${id}`, { method: 'DELETE' }),

  reorder: (parent_id: string | null, ordered_ids: string[]) =>
    request<{ ok: true }>('/api/entities/reorder', {
      method: 'POST',
      body: JSON.stringify({ parent_id, ordered_ids }),
    }),

  setPinned: (id: string, pinned: boolean) =>
    request<Entity>(`/api/entities/${id}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    }),
};
