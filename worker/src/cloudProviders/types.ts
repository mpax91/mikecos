/** The one shape every Cloud Storage provider adapter implements — see
 * googleDrive.ts / oneDrive.ts / dropbox.ts / box.ts. cloud.ts (the router)
 * only ever talks to this interface, never to a provider's own API shape
 * directly, so the frontend explorer component can render any connected
 * account identically regardless of which provider it is. */

export type CloudProviderId = 'google_drive' | 'onedrive' | 'dropbox' | 'box';

export interface TokenSet {
  accessToken: string;
  /** Null when the provider didn't (re-)issue one on this exchange — Box in
   * particular only issues a fresh refresh token on *refresh* calls, not on
   * the initial code exchange in some app configurations. */
  refreshToken: string | null;
  expiresAt: string; // ISO
  scope?: string;
}

export interface CloudFileEntry {
  /** Provider-native id. Opaque to everything outside the adapter — for
   * Dropbox this is actually a lowercased path (Dropbox addresses by path,
   * not a stable folder id, for anything below the root), for the other
   * three it's a real object id. */
  id: string;
  name: string;
  type: 'folder' | 'file';
  sizeBytes: number | null; // null for folders
  modifiedAt: string | null; // ISO
  mimeType: string | null;
  /** The provider's own "open in their web UI" link — used for View,
   * since Mike is generally already signed into each provider in his
   * regular browser and this sidesteps building a file previewer per
   * mime type. Null when the provider doesn't return one for this item. */
  webUrl: string | null;
}

export interface CloudSearchHit extends CloudFileEntry {
  /** Human-readable path/breadcrumb, when the provider's search response
   * includes enough to build one — shown under the result so a same-named
   * file from two different folders is distinguishable. */
  path: string | null;
}

export interface CloudQuota {
  usedBytes: number;
  /** Null means unlimited or simply not reported (some Workspace/Business
   * plans don't expose a ceiling) — the UI shows a used-only figure then,
   * not a 0-width progress bar. */
  totalBytes: number | null;
}

export interface CloudProviderAdapter {
  id: CloudProviderId;
  label: string; // "Google Drive", "OneDrive", ...

  /** Builds the URL to send the browser to for the consent screen. `state`
   * must be echoed back verbatim by the provider on the callback. */
  getAuthUrl(state: string, redirectUri: string): string;

  /** Exchanges an authorization code for tokens, and best-effort fetches
   * the account's own email/login for display — a provider that can't
   * supply one cheaply returns null rather than spending an extra call. */
  exchangeCode(code: string, redirectUri: string): Promise<TokenSet & { accountEmail: string | null }>;

  refreshAccessToken(refreshToken: string): Promise<TokenSet>;

  /** Lists one folder's direct children. `folderId === null` means the
   * account's root. */
  listFolder(accessToken: string, folderId: string | null): Promise<CloudFileEntry[]>;

  getQuota(accessToken: string): Promise<CloudQuota>;

  search(accessToken: string, query: string): Promise<CloudSearchHit[]>;

  /** Performs the authenticated fetch for a file's raw bytes and returns
   * the provider's own Response so the router can stream it straight
   * through to the browser without ever buffering the whole file in the
   * Worker. Throws a plain Error with a message safe to show Mike directly
   * if the provider can't serve raw bytes for this item (e.g. a native
   * Google Doc/Sheet that needs an /export call this adapter doesn't yet
   * support). */
  downloadFile(accessToken: string, fileId: string): Promise<Response>;
}
