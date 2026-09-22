/** Recognizes a handful of service families by hostname so a Vault Links
 * row can show a meaningful icon/color (Drive, an AI project) instead of a
 * generic globe — same idea as EntityCard's PDF/DOC file icons, just keyed
 * off URL host instead of MIME type. Unknown hosts fall back to 'generic'
 * rather than guessing. */
export type LinkFamily = 'drive' | 'ai' | 'generic';

const DRIVE_HOSTS = ['drive.google.com', 'docs.google.com', 'sheets.google.com', 'slides.google.com'];
const AI_HOSTS = ['chatgpt.com', 'chat.openai.com', 'claude.ai'];

export function linkFamily(url: string): LinkFamily {
  try {
    const hostname = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
    if (DRIVE_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))) return 'drive';
    if (AI_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))) return 'ai';
    return 'generic';
  } catch {
    return 'generic';
  }
}

export function linkFamilyLabel(family: LinkFamily): string {
  if (family === 'drive') return 'Google Drive';
  if (family === 'ai') return 'AI project';
  return '';
}
