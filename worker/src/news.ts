// RSS 2.0 / Atom parser for the News feature. Cloudflare Workers has no
// DOMParser, so — same constraint V1's worker.js RSS engine worked under —
// this is a small regex-based tag extractor rather than a real XML parser.
// It's deliberately forgiving: real-world feeds are inconsistent about
// namespacing, CDATA, entity-encoding, and which of RSS/Atom/media-RSS
// fields they populate, so every extraction here has a fallback chain
// rather than assuming one "correct" feed shape.

export interface ParsedFeedItem {
  guid: string; // item guid/id if present, otherwise a hash of link+title — always non-empty, used as the article cache's dedupe key
  url: string;
  title: string;
  description: string | null; // plain text, tags stripped, truncated to a preview length
  imageUrl: string | null;
  publishedAt: string | null; // ISO 8601, or null if unparseable/absent
}

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  items: ParsedFeedItem[];
}

export class FeedParseError extends Error {}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#8217': '’', '#8216': '‘', '#8220': '“', '#8221': '”', '#8211': '–', '#8212': '—',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
      if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return ENTITIES[code] ?? m;
    });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// Extracts the first `<tag ...>...</tag>` (or self-closing `<tag ... />`)
// contents/attrs from a block, tolerating an optional namespace prefix
// (media:content, content:encoded, dc:date, etc.) and CDATA.
function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${name}>`, 'i'));
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function attr(xml: string, tagName: string, attrName: string): string | null {
  const tagMatch = xml.match(new RegExp(`<(?:[\\w-]+:)?${tagName}\\b[^>]*>`, 'i'));
  if (!tagMatch) return null;
  const m = tagMatch[0].match(new RegExp(`${attrName}=["']([^"']*)["']`, 'i'));
  return m ? decodeEntities(m[1]) : null;
}

function firstImgSrc(html: string): string | null {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/** Parses either an RSS 2.0 or an Atom feed from raw XML text. Throws
 * FeedParseError if neither `<item>` (RSS) nor `<entry>` (Atom) blocks are
 * found at all, so the caller can show "doesn't look like a feed" rather
 * than silently returning zero articles for a bad URL. */
export async function parseFeed(xml: string): Promise<ParsedFeed> {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);

  const channelBlock = xml.match(/<channel[\s>]([\s\S]*?)<\/channel>/i)?.[0] ?? xml;
  const feedTitle = stripTags(tag(channelBlock, 'title') ?? '') || 'Untitled Feed';
  const siteUrlRaw = isAtom
    ? attr(channelBlock, 'link', 'href') ?? tag(channelBlock, 'link')
    : tag(channelBlock, 'link');
  const siteUrl = siteUrlRaw ? decodeEntities(siteUrlRaw.trim()) : null;

  const itemBlocks = isAtom
    ? [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)].map((m) => m[0])
    : [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)].map((m) => m[0]);

  if (itemBlocks.length === 0 && !/<rss[\s>]|<feed[\s>]/i.test(xml)) {
    throw new FeedParseError("Doesn't look like an RSS or Atom feed.");
  }

  const items: ParsedFeedItem[] = [];
  for (const block of itemBlocks) {
    const title = stripTags(tag(block, 'title') ?? '') || '(untitled)';

    let url: string | null;
    if (isAtom) {
      // Atom entries can have several <link> elements (alternate, self,
      // ...) — prefer rel="alternate" or the first link with no rel.
      const linkMatches = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
      const alt = linkMatches.find((m) => /rel=["']alternate["']/i.test(m[1]) || !/rel=/i.test(m[1]));
      url = alt ? alt[1].match(/href=["']([^"']*)["']/i)?.[1] ?? null : linkMatches[0]?.[1].match(/href=["']([^"']*)["']/i)?.[1] ?? null;
    } else {
      url = tag(block, 'link');
    }
    if (!url) continue; // an item we can't link to isn't worth showing
    url = decodeEntities(url.trim());

    const rawGuid = tag(block, 'guid') ?? tag(block, 'id') ?? null;
    const guid = rawGuid ? decodeEntities(rawGuid.trim()) : await sha1Hex(`${url}|${title}`);

    const descriptionRaw =
      tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content:encoded') ?? tag(block, 'content') ?? '';
    const descriptionText = stripTags(descriptionRaw);
    const description = descriptionText ? truncate(descriptionText, 280) : null;

    const imageUrl =
      attr(block, 'media:content', 'url') ??
      attr(block, 'media:thumbnail', 'url') ??
      (/^image\//i.test(attr(block, 'enclosure', 'type') ?? '') ? attr(block, 'enclosure', 'url') : null) ??
      firstImgSrc(descriptionRaw) ??
      firstImgSrc(tag(block, 'content:encoded') ?? tag(block, 'content') ?? '');

    const publishedAt = parseDate(
      tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated') ?? tag(block, 'dc:date')
    );

    items.push({ guid, url, title, description, imageUrl, publishedAt });
  }

  return { title: feedTitle, siteUrl, items };
}
