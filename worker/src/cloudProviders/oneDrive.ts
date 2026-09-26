import type { CloudFileEntry, CloudProviderAdapter, CloudQuota, CloudSearchHit, TokenSet } from './types';

const AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const API_BASE = 'https://graph.microsoft.com/v1.0';
// Files.Read (not Files.ReadWrite) + offline_access for a refresh token +
// User.Read to label the account by its real email — v1 is read-only.
const SCOPES = 'offline_access Files.Read User.Read';

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  webUrl?: string;
}

function toEntry(item: DriveItem): CloudFileEntry {
  return {
    id: item.id,
    name: item.name,
    type: item.folder ? 'folder' : 'file',
    sizeBytes: typeof item.size === 'number' ? item.size : null,
    modifiedAt: item.lastModifiedDateTime ?? null,
    mimeType: item.file?.mimeType ?? null,
    webUrl: item.webUrl ?? null,
  };
}

async function tokenRequest(env: { clientId: string; clientSecret: string }, params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, scope: SCOPES, ...params }),
  });
  if (!res.ok) throw new Error(`OneDrive token request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    scope: json.scope,
  };
}

export function makeOneDriveAdapter(clientId: string, clientSecret: string): CloudProviderAdapter {
  return {
    id: 'onedrive',
    label: 'OneDrive',

    getAuthUrl(state, redirectUri) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope: SCOPES,
        state,
      });
      return `${AUTH_URL}?${params}`;
    },

    async exchangeCode(code, redirectUri) {
      const tokens = await tokenRequest({ clientId, clientSecret }, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      let accountEmail: string | null = null;
      try {
        const res = await fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
        if (res.ok) {
          const me = (await res.json()) as { mail?: string; userPrincipalName?: string };
          accountEmail = me.mail ?? me.userPrincipalName ?? null;
        }
      } catch {
        // best-effort
      }
      return { ...tokens, accountEmail };
    },

    async refreshAccessToken(refreshToken) {
      return tokenRequest({ clientId, clientSecret }, { grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async listFolder(accessToken, folderId) {
      const path = folderId ? `/me/drive/items/${folderId}/children` : '/me/drive/root/children';
      const fields = 'id,name,size,lastModifiedDateTime,file,folder,webUrl';
      const res = await fetch(`${API_BASE}${path}?$select=${fields}&$top=999`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`OneDrive list failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { value: DriveItem[] };
      return json.value.map(toEntry);
    },

    async getQuota(accessToken) {
      const res = await fetch(`${API_BASE}/me/drive?$select=quota`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`OneDrive quota failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { quota: { used?: number; total?: number } };
      return {
        usedBytes: json.quota.used ?? 0,
        totalBytes: typeof json.quota.total === 'number' && json.quota.total > 0 ? json.quota.total : null,
      };
    },

    async search(accessToken, query) {
      const res = await fetch(`${API_BASE}/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=50`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`OneDrive search failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { value: (DriveItem & { parentReference?: { path?: string } })[] };
      const hits: CloudSearchHit[] = json.value.map((item) => ({
        ...toEntry(item),
        // parentReference.path looks like "/drive/root:/Folder/Sub" — trim the Graph-internal prefix down to a readable breadcrumb
        path: item.parentReference?.path?.replace(/^\/drive\/root:?/, '') || null,
      }));
      return hits;
    },

    async downloadFile(accessToken, fileId) {
      const res = await fetch(`${API_BASE}/me/drive/items/${fileId}/content`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: 'follow', // Graph 302s to a pre-signed download URL
      });
      if (!res.ok) throw new Error(`OneDrive download failed: ${res.status}`);
      return res;
    },
  };
}
