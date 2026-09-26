/** A small, self-contained MIME decoder for Inbox's "peek" body — the
 * previous version just returned BODY.PEEK[1]'s raw bytes verbatim, which
 * is the *encoded* form (base64/quoted-printable) whenever a sender's
 * message part actually uses one, producing exactly the garbled block Mike
 * saw on a Google security-alert email. This walks the real MIME tree
 * (multipart/alternative, multipart/mixed, nesting), picks a text/plain
 * part when one exists, decodes it properly, and otherwise falls back to a
 * text/html part converted to plain text. Not a full RFC 2045/2047
 * implementation — good enough for reading real mail, not for perfectly
 * round-tripping every edge case (uncommon charsets, deeply nested
 * multipart/related image parts, etc). */

interface MimePart {
  contentType: string;
  params: Record<string, string>;
  transferEncoding: string;
  rawBody: string;
}

function parseHeaders(block: string): { headers: Map<string, string>; contentType: string; params: Record<string, string>; transferEncoding: string } {
  const headers = new Map<string, string>();
  const lines = block.split(/\r?\n/);
  const folded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && folded.length > 0) {
      folded[folded.length - 1] += ' ' + line.trim();
    } else if (line.trim()) {
      folded.push(line);
    }
  }
  for (const line of folded) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) headers.set(m[1].toLowerCase(), m[2]);
  }

  const ctRaw = headers.get('content-type') ?? 'text/plain; charset=us-ascii';
  const [contentTypeRaw, ...paramParts] = ctRaw.split(';');
  const contentType = contentTypeRaw.trim().toLowerCase() || 'text/plain';
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const m = part.match(/^\s*([\w-]+)\s*=\s*"?([^";]*)"?/);
    if (m) params[m[1].toLowerCase()] = m[2];
  }
  const transferEncoding = (headers.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase();
  return { headers, contentType, params, transferEncoding };
}

function splitHeaderBody(raw: string): { headerBlock: string; body: string } {
  const idx = raw.search(/\r?\n\r?\n/);
  if (idx === -1) return { headerBlock: raw, body: '' };
  const sepMatch = raw.slice(idx).match(/^\r?\n\r?\n/)!;
  return { headerBlock: raw.slice(0, idx), body: raw.slice(idx + sepMatch[0].length) };
}

/** Recursively walks a MIME message/part, returning every leaf (non-
 * multipart) part it finds, in document order. */
function collectLeafParts(raw: string): MimePart[] {
  const { headerBlock, body } = splitHeaderBody(raw);
  const { contentType, params, transferEncoding } = parseHeaders(headerBlock);

  if (contentType.startsWith('multipart/') && params.boundary) {
    const boundary = params.boundary;
    const delimiter = `--${boundary}`;
    const segments = body.split(delimiter);
    const parts: MimePart[] = [];
    // First segment is preamble (ignored), last is usually "--\r\n" epilogue.
    for (const seg of segments.slice(1, -1)) {
      const cleaned = seg.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      if (!cleaned.trim() || cleaned.trim() === '--') continue;
      parts.push(...collectLeafParts(cleaned));
    }
    return parts;
  }

  return [{ contentType, params, transferEncoding, rawBody: body }];
}

function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function quotedPrintableToBytes(qp: string): Uint8Array {
  // Soft line breaks ("=\r\n" / "=\n") are join points, not literal text.
  const joined = qp.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return new Uint8Array(bytes);
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    // Unrecognized/uncommon charset label — utf-8 is the best available
    // fallback rather than failing the whole peek.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Decodes one part's body per its Content-Transfer-Encoding + charset.
 * base64 and quoted-printable are both ASCII-safe encodings of the
 * original bytes (that's the whole point of them), so the JS string we
 * already have — decoded off the wire as UTF-8 — reproduces them exactly;
 * only the bytes *underneath* the encoding need the part's real charset. */
function decodePart(part: MimePart): string {
  const charset = part.params.charset || 'utf-8';
  if (part.transferEncoding === 'base64') return decodeCharset(base64ToBytes(part.rawBody), charset);
  if (part.transferEncoding === 'quoted-printable') return decodeCharset(quotedPrintableToBytes(part.rawBody), charset);
  // 7bit/8bit/binary/unspecified: already plain text on the wire. A
  // non-UTF-8 charset declared here can't be un-decoded from the JS string
  // we already have — known v1 limitation, same as the old code's.
  return part.rawBody;
}

function htmlToText(html: string): string {
  let text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
  return text
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Entry point — given a raw RFC822 message (headers + body, as returned
 * by BODY.PEEK[]), returns clean, readable plain text: the first
 * text/plain part if one exists, otherwise the first text/html part
 * converted to text, otherwise empty. */
export function parseMimeMessageToText(raw: string): string {
  const parts = collectLeafParts(raw);
  const plain = parts.find((p) => p.contentType === 'text/plain');
  if (plain) return decodePart(plain).trim();
  const html = parts.find((p) => p.contentType === 'text/html');
  if (html) return htmlToText(decodePart(html));
  return '';
}
