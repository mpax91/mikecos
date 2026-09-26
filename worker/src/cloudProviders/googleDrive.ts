import type { CloudFileEntry, CloudProviderAdapter, CloudQuota, CloudSearchHit, TokenSet } from './types';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/drive/v3';
// drive.readonly is deliberately the only Drive scope requested — v1 is
// browse/download/search, never write, so there's no reason to ask Mike to
// grant more than that in the consent screen.
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Native Google Docs/Sheets/Slides have no raw file bytes — they need the
// separate /export endpoint with a target mime type. Not implemented in
// v1 (see downloadFile below); this set lets the router give Mike a clear
// message instead of a confusing fetch failure.
const GOOGLE_NATIVE_MIME_PREFIX = 'application/vnd.google-apps.';

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

function toEntry(f: DriveFile): CloudFileEntry {
  return {
    id: f.id,
    name: f.name,
    type: f.mimeType === FOLDER_MIME ? 'folder' : 'file',
    sizeBytes: f.size ? Number(f.size) : null,
    modifiedAt: f.modifiedTime ?? null,
    mimeType: f.mimeType,
    webUrl: f.webViewLink ?? null,
  };
}

async function tokenRequest(env: { clientId: string; clientSecret: string }, params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, ...params }),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + json.expires_in * 1000).toISOString(),
    scope: json.scope,
  };
}

export function makeGoogleDriveAdapter(clientId: string, clientSecret: string): CloudProviderAdapter {
  return {
    id: 'google_drive',
    label: 'Google Drive',

    getAuthUrl(state, redirectUri) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline', // required to get a refresh_token at all
        prompt: 'consent', // forces re-issuing a refresh_token even for an account that's connected before (e.g. reconnecting after a revoke)
        state,
      });
      return `${AUTH_URL}?${params}`;
    },

    async exchangeCode(code, redirectUri) {
      const tokens = await tokenRequest(
        { clientId, clientSecret },
        { grant_type: 'authorization_code', code, redirect_uri: redirectUri }
      );
      let accountEmail: string | null = null;
      try {
        const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
        if (res.ok) accountEmail = ((await res.json()) as { email?: string }).email ?? null;
      } catch {
        // best-effort — a connected account with no email label is still usable
      }
      return { ...tokens, accountEmail };
    },

    async refreshAccessToken(refreshToken) {
      return tokenRequest({ clientId, clientSecret }, { grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async listFolder(accessToken, folderId) {
      const q = encodeURIComponent(`'${folderId ?? 'root'}' in parents and trashed = false`);
      const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime,webViewLink)');
      const res = await fetch(`${API_BASE}/files?q=${q}&fields=${fields}&pageSize=1000&orderBy=folder,name`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Google Drive list failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { files: DriveFile[] };
      return json.files.map(toEntry);
    },

    async getQuota(accessToken) {
      const res = await fetch(`${API_BASE}/about?fields=${encodeURIComponent('storageQuota(usage,limit)')}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Google Drive quota failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { storageQuota: { usage?: string; limit?: string } };
      return {
        usedBytes: json.storageQuota.usage ? Number(json.storageQuota.usage) : 0,
        totalBytes: json.storageQuota.limit ? Number(json.storageQuota.limit) : null, // absent = unlimited (common on Workspace)
      };
    },

    async search(accessToken, query) {
      const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const q = encodeURIComponent(`name contains '${escaped}' and trashed = false`);
      const fields = encodeURIComponent('files(id,name,mimeType,size,modifiedTime,webViewLink,parents)');
      const res = await fetch(`${API_BASE}/files?q=${q}&fields=${fields}&pageSize=50`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Google Drive search failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { files: DriveFile[] };
      const hits: CloudSearchHit[] = json.files.map((f) => ({ ...toEntry(f), path: null }));
      return hits;
    },

    async downloadFile(accessToken, fileId) {
      // Look the file up first so a native Google Doc/Sheet/Slide gets a
      // clear message instead of Drive's opaque "no content" error on the
      // raw ?alt=media endpoint (which only serves files that actually
      // have bytes — a native doc doesn't).
      const meta = await fetch(`${API_BASE}/files/${fileId}?fields=mimeType,name`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (meta.ok) {
        const { mimeType } = (await meta.json()) as { mimeType: string };
        if (mimeType.startsWith(GOOGLE_NATIVE_MIME_PREFIX)) {
          throw new Error('This is a native Google Doc/Sheet/Slide — open it in Drive instead of downloading (export isn’t supported here yet).');
        }
      }
      const res = await fetch(`${API_BASE}/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Google Drive download failed: ${res.status}`);
      return res;
    },
  };
}
