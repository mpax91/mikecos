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

// Shared with createLink below, and with anywhere a stored LinkMeta.url is
// turned into an href — a link saved before this normalization existed (or
// entered without a scheme some other way) still needs to resolve as an
// external site rather than a path on the app itself.
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
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

  createLink: (parent_id: string, url: string, title?: string) => {
    // Without a scheme, an href like "espn.com" resolves as a path
    // relative to the app itself (opening MikeOS at /espn.com) instead of
    // the external site — normalize once here so every caller gets a real,
    // externally-openable URL regardless of whether it prompted the user
    // to include "https://" or not.
    const normalized = normalizeUrl(url);
    return request<Entity>('/api/entities', {
      method: 'POST',
      body: JSON.stringify({ type: 'link', parent_id, content: JSON.stringify({ url: normalized }), title: title || normalized }),
    });
  },

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
    patch: Partial<Pick<Entity, 'title' | 'content' | 'status' | 'parent_id' | 'position' | 'pinned' | 'last_touched'>>
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

  listNotes: () => request<Entity[]>('/api/notes'),

  createNote: (title?: string, content?: string | null) =>
    request<Entity>('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    }),

  /** Reparents an entity — used for "Move to Project" (parent_id: a
   * project/folder id) and its reverse, "Move to Notes" (parent_id: null). */
  moveEntity: (id: string, parent_id: string | null) =>
    request<Entity>(`/api/entities/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ parent_id }),
    }),

  // ---- Jots ----

  listJots: () => request<Entity[]>('/api/jots'),

  createJot: (content?: string | null) =>
    request<Entity>('/api/jots', {
      method: 'POST',
      body: JSON.stringify({ content: content ?? null }),
    }),

  /** Turns a Jot into a Note (parent_id may be null — standalone, like any
   * other Note) or a Task (parent_id required — MikeOS has no standalone
   * task concept yet). */
  convertEntity: (id: string, to: 'note' | 'task', parent_id: string | null) =>
    request<Entity>(`/api/entities/${id}/convert`, {
      method: 'POST',
      body: JSON.stringify({ to, parent_id }),
    }),

  /** Server-side link unfurl (og:title/og:image + bare domain fallback) for
   * the editor's "Insert link preview" button — a browser-side fetch would
   * hit CORS on nearly every real site. */
  fetchLinkPreview: (url: string) =>
    request<{ url: string; title: string | null; image: string | null; domain: string | null }>(
      `/api/link-preview?url=${encodeURIComponent(url)}`
    ),
};
