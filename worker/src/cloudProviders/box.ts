import type { CloudFileEntry, CloudProviderAdapter, CloudQuota, CloudSearchHit, TokenSet } from './types';

const AUTH_URL = 'https://account.box.com/api/oauth2/authorize';
const TOKEN_URL = 'https://api.box.com/oauth2/token';
const API_BASE = 'https://api.box.com/2.0';
const ROOT_ID = '0'; // Box's own convention for "the account's root folder"

interface BoxItem {
  id: string;
  type: 'file' | 'folder';
  name: string;
  size?: number;
  modified_at?: string;
}

function toEntry(item: BoxItem): CloudFileEntry {
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    sizeBytes: item.type === 'file' ? item.size ?? null : null,
    modifiedAt: item.modified_at ?? null,
    mimeType: null, // Box's item listing doesn't return one
    webUrl: `https://app.box.com/${item.type === 'folder' ? 'folder' : 'file'}/${item.id}`,
  };
}

async function tokenRequest(env: { clientId: string; clientSecret: string }, params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, ...params }),
  });
  if (!res.ok) throw new Error(`Box token request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return {
    accessToken: json.access_token,
    // Box rotates refresh tokens on every use (including every refresh
    // call) and invalidates the previous one — the router MUST persist
    // this new value every single time or the account silently breaks the
    // next time its token needs refreshing.
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
  };
}

export function makeBoxAdapter(clientId: string, clientSecret: string): CloudProviderAdapter {
  return {
    id: 'box',
    label: 'Box',

    getAuthUrl(state, redirectUri) {
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state });
      return `${AUTH_URL}?${params}`;
    },

    async exchangeCode(code, redirectUri) {
      const tokens = await tokenRequest({ clientId, clientSecret }, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      let accountEmail: string | null = null;
      try {
        const res = await fetch(`${API_BASE}/users/me?fields=login`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
        if (res.ok) accountEmail = ((await res.json()) as { login?: string }).login ?? null;
      } catch {
        // best-effort
      }
      return { ...tokens, accountEmail };
    },

    async refreshAccessToken(refreshToken) {
      return tokenRequest({ clientId, clientSecret }, { grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async listFolder(accessToken, folderId) {
      const fields = 'id,type,name,size,modified_at';
      const res = await fetch(`${API_BASE}/folders/${folderId ?? ROOT_ID}/items?fields=${fields}&limit=1000`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Box list failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { entries: BoxItem[] };
      return json.entries.map(toEntry);
    },

    async getQuota(accessToken) {
      const res = await fetch(`${API_BASE}/users/me?fields=space_amount,space_used`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`Box quota failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { space_amount?: number; space_used?: number };
      return {
        usedBytes: json.space_used ?? 0,
        totalBytes: typeof json.space_amount === 'number' && json.space_amount > 0 ? json.space_amount : null,
      };
    },

    async search(accessToken, query) {
      const fields = 'id,type,name,size,modified_at,path_collection';
      const res = await fetch(`${API_BASE}/search?query=${encodeURIComponent(query)}&fields=${fields}&limit=50`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Box search failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { entries: (BoxItem & { path_collection?: { entries: { name: string }[] } })[] };
      const hits: CloudSearchHit[] = json.entries.map((item) => ({
        ...toEntry(item),
        path: item.path_collection?.entries.length ? '/' + item.path_collection.entries.map((p) => p.name).join('/') : null,
      }));
      return hits;
    },

    async downloadFile(accessToken, fileId) {
      const res = await fetch(`${API_BASE}/files/${fileId}/content`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: 'follow', // Box 302s to a pre-signed download URL
      });
      if (!res.ok) throw new Error(`Box download failed: ${res.status}`);
      return res;
    },
  };
}
