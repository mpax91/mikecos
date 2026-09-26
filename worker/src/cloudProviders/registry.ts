import type { Env } from '../types';
import { makeGoogleDriveAdapter } from './googleDrive';
import { makeOneDriveAdapter } from './oneDrive';
import { makeDropboxAdapter } from './dropbox';
import { makeBoxAdapter } from './box';
import type { CloudProviderAdapter, CloudProviderId } from './types';

export const PROVIDER_LABELS: Record<CloudProviderId, string> = {
  google_drive: 'Google Drive',
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  box: 'Box',
};

interface CredentialPair {
  clientId?: string;
  clientSecret?: string;
}

function credentials(env: Env, provider: CloudProviderId): CredentialPair {
  switch (provider) {
    case 'google_drive':
      return { clientId: env.GOOGLE_DRIVE_CLIENT_ID, clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET };
    case 'onedrive':
      return { clientId: env.ONEDRIVE_CLIENT_ID, clientSecret: env.ONEDRIVE_CLIENT_SECRET };
    case 'dropbox':
      return { clientId: env.DROPBOX_CLIENT_ID, clientSecret: env.DROPBOX_CLIENT_SECRET };
    case 'box':
      return { clientId: env.BOX_CLIENT_ID, clientSecret: env.BOX_CLIENT_SECRET };
  }
}

/** Whether this provider's OAuth client id/secret pair has been set as
 * Worker secrets yet — drives the "Connect" vs. "Set up required" state in
 * Settings → Cloud Storage, so a provider Mike hasn't registered an app
 * for yet fails with a clear, actionable message instead of a 500. */
export function isConfigured(env: Env, provider: CloudProviderId): boolean {
  const { clientId, clientSecret } = credentials(env, provider);
  return Boolean(clientId && clientSecret);
}

/** Builds the adapter for a provider, throwing the same friendly
 * not-configured message `isConfigured` is meant to let callers pre-empt. */
export function getAdapter(env: Env, provider: CloudProviderId): CloudProviderAdapter {
  const { clientId, clientSecret } = credentials(env, provider);
  if (!clientId || !clientSecret) {
    throw new Error(
      `${PROVIDER_LABELS[provider]} isn't set up yet — it needs an OAuth app registered in ${PROVIDER_LABELS[provider]}'s developer console first.`
    );
  }
  switch (provider) {
    case 'google_drive':
      return makeGoogleDriveAdapter(clientId, clientSecret);
    case 'onedrive':
      return makeOneDriveAdapter(clientId, clientSecret);
    case 'dropbox':
      return makeDropboxAdapter(clientId, clientSecret);
    case 'box':
      return makeBoxAdapter(clientId, clientSecret);
  }
}

export const ALL_PROVIDERS: CloudProviderId[] = ['google_drive', 'onedrive', 'dropbox', 'box'];
