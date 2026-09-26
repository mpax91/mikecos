import type { CloudFileEntry, CloudProviderAdapter, CloudQuota, CloudSearchHit, TokenSet } from './types';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';

// Dropbox addresses everything by PATH, not a stable folder id (unlike the
// other three providers) — "" is the root, "/Photos/2024" is a subfolder.
// So here, and only here, `folderId`/`id` in the shared CloudFileEntry
// shape is actually a lowercased path, not an opaque provider id. The
// router treats it as opaque either way, which is exactly the point of
// going through this adapter interface at all.

interface DropboxEntry {
  '.tag': 'folder' | 'file';
  name: string;
  path_lower: string;
  path_display?: string;
  size?: number;
  client_modified?: string;
  server_modified?: string;
}

function toEntry(e: DropboxEntry): CloudFileEntry {
  return {
    id: e.path_lower,
    name: e.name,
    type: e['.tag'],
    sizeBytes: e['.tag'] === 'file' ? e.size ?? null : null,
    modifiedAt: e.server_modified ?? e.client_modified ?? null,
    mimeType: null, // Dropbox's list_folder doesn't return one; not worth a second call per entry
    webUrl: null, // Dropbox only returns a shareable web link via a separate create-link call — v1 skips it, downloads go through our own proxy instead
  };
}

async function tokenRequest(env: { clientId: string; clientSecret: string }, params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, ...params }),
  });
  if (!res.ok) throw new Error(`Dropbox token request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    scope: json.scope,
  };
}

export function makeDropboxAdapter(clientId: string, clientSecret: string): CloudProviderAdapter {
  return {
    id: 'dropbox',
    label: 'Dropbox',

    getAuthUrl(state, redirectUri) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        token_access_type: 'offline', // required to get a refresh_token
        state,
      });
      return `${AUTH_URL}?${params}`;
    },

    async exchangeCode(code, redirectUri) {
      const tokens = await tokenRequest({ clientId, clientSecret }, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      let accountEmail: string | null = null;
      try {
        const res = await fetch(`${API_BASE}/users/get_current_account`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
        if (res.ok) accountEmail = ((await res.json()) as { email?: string }).email ?? null;
      } catch {
        // best-effort
      }
      return { ...tokens, accountEmail };
    },

    async refreshAccessToken(refreshToken) {
      return tokenRequest({ clientId, clientSecret }, { grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async listFolder(accessToken, folderId) {
      const res = await fetch(`${API_BASE}/files/list_folder`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderId ?? '' }),
      });
      if (!res.ok) throw new Error(`Dropbox list failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { entries: DropboxEntry[] };
      return json.entries.map(toEntry).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
    },

    async getQuota(accessToken) {
      const res = await fetch(`${API_BASE}/users/get_space_usage`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Dropbox quota failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { used: number; allocation: { allocated?: number } };
      return { usedBytes: json.used, totalBytes: json.allocation.allocated ?? null };
    },

    async search(accessToken, query) {
      const res = await fetch(`${API_BASE}/files/search_v2`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, options: { max_results: 50 } }),
      });
      if (!res.ok) throw new Error(`Dropbox search failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { matches: { metadata: { metadata: DropboxEntry } }[] };
      const hits: CloudSearchHit[] = json.matches.map(({ metadata: { metadata: e } }) => {
        const entry = toEntry(e);
        const display = e.path_display ?? e.path_lower;
        const path = display.slice(0, display.length - e.name.length).replace(/\/$/, '') || '/';
        return { ...entry, path };
      });
      return hits;
    },

    async downloadFile(accessToken, fileId) {
      const res = await fetch(`${CONTENT_BASE}/files/download`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Dropbox-API-Arg': JSON.stringify({ path: fileId }) },
      });
      if (!res.ok) throw new Error(`Dropbox download failed: ${res.status}`);
      return res;
    },
  };
}
