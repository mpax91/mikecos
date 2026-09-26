import { connect } from 'cloudflare:sockets';

/** A minimal, purpose-built IMAP client over Cloudflare Workers' raw TCP
 * socket API (`cloudflare:sockets`) — not a general-purpose library, just
 * the specific handful of commands Inbox needs: LOGIN, SELECT, UID SEARCH,
 * UID FETCH (a fixed attribute set), UID STORE, LOGOUT. Written from
 * scratch rather than pulling in a Node-oriented npm IMAP client, since
 * those assume Node's `net`/`tls` modules and haven't been verified against
 * Workers' runtime.
 *
 * IMAP responses are hard to parse line-by-line because a "literal" value
 * (`{123}\r\n` followed by exactly 123 raw bytes, which can themselves
 * contain \r\n) can appear in the middle of a response line — the reader
 * here is byte-level and literal-aware for that reason. This has been
 * written carefully against RFC 3501, but has NOT been exercised against a
 * live Gmail server from this environment (no raw TCP egress available
 * here to test with) — the first real account added in production is the
 * real test, and some protocol edge case is more likely than not to need a
 * follow-up fix once that happens. */

const CR = 13;
const LF = 10;
const SP = 32;
const LPAREN = 40;
const RPAREN = 41;
const LBRACE = 123;
const RBRACE = 125;
const LBRACKET = 91;
const RBRACKET = 93;
const DQUOTE = 34;
const BACKSLASH = 92;

export type ImapToken = string | ImapToken[] | null;

export interface FetchedMessage {
  uid: number;
  gmMsgId: string | null;
  gmThrId: string | null;
  flags: string[];
  headerBlock: string; // raw "From: ...\r\nSubject: ...\r\n" text
  snippet: string; // raw, still-MIME-encoded first bytes of part 1 — see mimeParser.decodeSnippet
  snippetMime: string; // part 1's own MIME headers (Content-Type/-Transfer-Encoding), needed to decode `snippet`
}

export interface ParsedHeaders {
  fromName: string | null;
  fromEmail: string | null;
  subject: string;
  dateIso: string | null;
  messageId: string | null;
}

class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  private async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done || !value) return false;
    if (this.pos > 0) this.buf = this.buf.slice(this.pos);
    this.pos = 0;
    const merged = new Uint8Array(this.buf.length + value.length);
    merged.set(this.buf, 0);
    merged.set(value, this.buf.length);
    this.buf = merged;
    return true;
  }

  private async ensure(n: number): Promise<void> {
    while (this.buf.length - this.pos < n) {
      const got = await this.fill();
      if (!got) throw new Error('IMAP connection closed while reading');
    }
  }

  async peekByte(): Promise<number> {
    await this.ensure(1);
    return this.buf[this.pos];
  }

  async readByte(): Promise<number> {
    await this.ensure(1);
    return this.buf[this.pos++];
  }

  async readExact(n: number): Promise<Uint8Array> {
    await this.ensure(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  async expectCRLF(): Promise<void> {
    const cr = await this.readByte();
    const lf = await this.readByte();
    if (cr !== CR || lf !== LF) throw new Error('IMAP protocol error: expected CRLF');
  }

  /** True if the very next bytes are CRLF (does not consume). */
  async atCRLF(): Promise<boolean> {
    await this.ensure(1);
    if (this.buf[this.pos] !== CR) return false;
    await this.ensure(2);
    return this.buf[this.pos + 1] === LF;
  }
}

const dec = new TextDecoder();
const enc = new TextEncoder();

/** Reads one IMAP "data item" at the current position: a parenthesized
 * list, a quoted string, NIL, a literal ({n}\r\n<n bytes>), or a bare atom
 * (which covers numbers and keywords like FLAGS/UID/X-GM-MSGID alike, plus
 * bracketed fetch-section names like BODY[HEADER.FIELDS (FROM SUBJECT)]). */
async function readItem(r: ByteReader): Promise<ImapToken> {
  const b = await r.peekByte();
  if (b === LPAREN) {
    await r.readByte();
    const items: ImapToken[] = [];
    while (true) {
      const nb = await r.peekByte();
      if (nb === RPAREN) {
        await r.readByte();
        break;
      }
      if (nb === SP) {
        await r.readByte();
        continue;
      }
      items.push(await readItem(r));
    }
    return items;
  }
  if (b === DQUOTE) {
    await r.readByte();
    const bytes: number[] = [];
    while (true) {
      const c = await r.readByte();
      if (c === DQUOTE) break;
      if (c === BACKSLASH) {
        bytes.push(await r.readByte());
      } else {
        bytes.push(c);
      }
    }
    return dec.decode(new Uint8Array(bytes));
  }
  if (b === LBRACE) {
    await r.readByte();
    let digits = '';
    while (true) {
      const c = await r.readByte();
      if (c === RBRACE) break;
      digits += String.fromCharCode(c);
    }
    await r.expectCRLF();
    const n = parseInt(digits, 10);
    const bytes = await r.readExact(n);
    return dec.decode(bytes);
  }
  // Bare atom: consume until whitespace/paren at depth 0, tracking [ ]
  // bracket depth so a fetch section name like BODY[HEADER.FIELDS (FROM
  // SUBJECT)] reads as one token instead of breaking on its inner space.
  const chars: number[] = [];
  let bracketDepth = 0;
  while (true) {
    const c = await r.peekByte();
    if (bracketDepth === 0 && (c === SP || c === RPAREN || c === CR)) break;
    if (c === LBRACKET) bracketDepth++;
    if (c === RBRACKET) bracketDepth = Math.max(0, bracketDepth - 1);
    chars.push(await r.readByte());
    // A literal can follow immediately inside brackets (rare for our fetch
    // set) or right after the atom closes — handled by the caller re-
    // invoking readItem for the next top-level item, so nothing special
    // needed here beyond stopping at the right boundary.
  }
  const text = dec.decode(new Uint8Array(chars));
  return text === 'NIL' ? null : text;
}

/** Reads one full response line: `<tag or "*" or "+"> <items...>\r\n`. */
async function readResponseLine(r: ByteReader): Promise<{ tag: string; items: ImapToken[] }> {
  const tagChars: number[] = [];
  while (true) {
    const c = await r.peekByte();
    if (c === SP) {
      await r.readByte();
      break;
    }
    tagChars.push(await r.readByte());
  }
  const tag = dec.decode(new Uint8Array(tagChars));

  const items: ImapToken[] = [];
  while (!(await r.atCRLF())) {
    const b = await r.peekByte();
    if (b === SP) {
      await r.readByte();
      continue;
    }
    items.push(await readItem(r));
  }
  await r.expectCRLF();
  return { tag, items };
}

export class ImapAuthError extends Error {}
export class ImapProtocolError extends Error {}

export class ImapClient {
  private socket: ReturnType<typeof connect> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private r: ByteReader | null = null;
  private tagCounter = 0;

  async connect(host: string, port: number): Promise<void> {
    this.socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
    await this.socket.opened;
    this.writer = this.socket.writable.getWriter();
    this.r = new ByteReader(this.socket.readable);
    // Server greeting — a single untagged "* OK ..." line.
    await readResponseLine(this.r);
  }

  private nextTag(): string {
    this.tagCounter++;
    return `A${this.tagCounter}`;
  }

  private async send(line: string): Promise<void> {
    if (!this.writer) throw new ImapProtocolError('not connected');
    await this.writer.write(enc.encode(line + '\r\n'));
  }

  /** Sends one command and collects every response line up to and including
   * the tagged completion — returns the untagged lines' items plus the
   * completion status ('OK' | 'NO' | 'BAD'). */
  private async command(cmd: string): Promise<{ status: string; text: string; untagged: ImapToken[][] }> {
    if (!this.r) throw new ImapProtocolError('not connected');
    const tag = this.nextTag();
    await this.send(`${tag} ${cmd}`);
    const untagged: ImapToken[][] = [];
    while (true) {
      const { tag: rtag, items } = await readResponseLine(this.r);
      if (rtag === tag) {
        const status = typeof items[0] === 'string' ? items[0] : 'BAD';
        const text = items
          .slice(1)
          .map((i) => (typeof i === 'string' ? i : ''))
          .join(' ');
        return { status, text, untagged };
      }
      // '*' (untagged) or '+' (continuation, not expected for our commands)
      untagged.push(items);
    }
  }

  async login(user: string, pass: string): Promise<void> {
    // Literal-free login is fine here since app passwords don't contain the
    // characters IMAP's quoted-string syntax needs escaped (space/quote/
    // backslash) — Google generates them as four groups of four lowercase
    // letters. Still escape defensively in case that ever changes.
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const res = await this.command(`LOGIN "${esc(user)}" "${esc(pass)}"`);
    if (res.status !== 'OK') throw new ImapAuthError(`IMAP login failed: ${res.text || res.status}`);
  }

  async selectInbox(): Promise<void> {
    const res = await this.command('SELECT INBOX');
    if (res.status !== 'OK') throw new ImapProtocolError(`SELECT INBOX failed: ${res.text || res.status}`);
  }

  /** Diagnostic only — lists every mailbox the account has, so a
   * Gmail-specific virtual mailbox (e.g. "[Gmail]/Snoozed", if Gmail
   * exposes one at all — unconfirmed, this is how we check) can be found
   * without guessing its exact name/casing. */
  async listMailboxes(): Promise<string[]> {
    const res = await this.command('LIST "" "*"');
    if (res.status !== 'OK') throw new ImapProtocolError(`LIST failed: ${res.text || res.status}`);
    const names: string[] = [];
    for (const line of res.untagged) {
      // shape: ['LIST', [flags...], delimiter, mailboxName]
      if (line[0] === 'LIST' && typeof line[3] === 'string') names.push(line[3]);
    }
    return names;
  }

  /** Diagnostic only — SELECT an arbitrary mailbox by name (quoted, so a
   * name containing spaces/brackets like "[Gmail]/Snoozed" works) and
   * return the gm_msgids currently in it, to check whether a message
   * MikeOS has flagged in_inbox also shows up under a different mailbox
   * Gmail uses for snoozed mail. */
  async selectAndListGmMsgIds(mailboxName: string): Promise<string[]> {
    const esc = mailboxName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const selRes = await this.command(`SELECT "${esc}"`);
    if (selRes.status !== 'OK') throw new ImapProtocolError(`SELECT "${mailboxName}" failed: ${selRes.text || selRes.status}`);
    const uids = await this.searchAllUids();
    if (uids.length === 0) return [];
    const res = await this.command(`UID FETCH ${uids.join(',')} (X-GM-MSGID)`);
    if (res.status !== 'OK') throw new ImapProtocolError(`UID FETCH failed: ${res.text || res.status}`);
    const ids: string[] = [];
    for (const line of res.untagged) {
      if (line[1] !== 'FETCH') continue;
      const attrs = line[2];
      if (!Array.isArray(attrs)) continue;
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === 'X-GM-MSGID' && typeof attrs[i + 1] === 'string') ids.push(attrs[i + 1] as string);
      }
    }
    return ids;
  }

  /** UIDs of every message currently in the selected mailbox. */
  async searchAllUids(): Promise<number[]> {
    const res = await this.command('UID SEARCH ALL');
    if (res.status !== 'OK') throw new ImapProtocolError(`UID SEARCH failed: ${res.text || res.status}`);
    const uids: number[] = [];
    for (const line of res.untagged) {
      if (line[0] === 'SEARCH') {
        for (const item of line.slice(1)) {
          if (typeof item === 'string') {
            const n = parseInt(item, 10);
            if (!Number.isNaN(n)) uids.push(n);
          }
        }
      }
    }
    return uids;
  }

  /** Fetches the fixed attribute set Inbox needs for a set of UIDs (a
   * comma-separated ranges string, e.g. "12,14:20"). Empty uidSet returns
   * []. `snippetBytes` caps how much of the message's first text part gets
   * pulled for the list-view preview — full body is a separate on-demand
   * fetch (see fetchFullText). */
  async fetchMessages(uidSet: string, snippetBytes = 400): Promise<FetchedMessage[]> {
    if (!uidSet) return [];
    const items = `(UID FLAGS X-GM-MSGID X-GM-THRID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)] BODY.PEEK[1.MIME] BODY.PEEK[1]<0.${snippetBytes}>)`;
    const res = await this.command(`UID FETCH ${uidSet} ${items}`);
    if (res.status !== 'OK') throw new ImapProtocolError(`UID FETCH failed: ${res.text || res.status}`);
    return res.untagged.filter((l) => l[1] === 'FETCH').map((l) => parseFetchLine(l));
  }

  /** Full plain-text-ish body for a single UID, for peek/reply — same
   * BODY.PEEK[1] part but uncapped. Multipart/HTML-only messages will
   * return that part's raw content (may be HTML or MIME boundary text
   * rather than clean plain text) — a known v1 limitation without a real
   * MIME parser; good enough for a preview, worth revisiting if it reads
   * garbled on HTML-heavy senders.
   *
   * Superseded by fetchRawMessage + mimeParser.ts for the actual peek UI
   * (see email.ts), which decodes properly instead of returning whichever
   * part's raw encoded bytes happen to be first. Left in place only for
   * reply-quoting, which just needs *some* text, not a clean read. */
  async fetchFullText(uid: number): Promise<string> {
    const res = await this.command(`UID FETCH ${uid} (BODY.PEEK[1])`);
    if (res.status !== 'OK') throw new ImapProtocolError(`UID FETCH failed: ${res.text || res.status}`);
    const line = res.untagged.find((l) => l[1] === 'FETCH');
    if (!line) return '';
    const attrs = line[2];
    if (!Array.isArray(attrs)) return '';
    for (let i = 0; i < attrs.length; i += 2) {
      const name = attrs[i];
      if (typeof name === 'string' && name.startsWith('BODY[1]') && typeof attrs[i + 1] === 'string') {
        return attrs[i + 1] as string;
      }
    }
    return '';
  }

  /** The entire raw RFC822 message (headers + body, still MIME-encoded) —
   * what mimeParser.ts needs to walk the real part tree and decode
   * properly, rather than guessing at a single fixed part number. */
  async fetchRawMessage(uid: number): Promise<string> {
    const res = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    if (res.status !== 'OK') throw new ImapProtocolError(`UID FETCH failed: ${res.text || res.status}`);
    const line = res.untagged.find((l) => l[1] === 'FETCH');
    if (!line) return '';
    const attrs = line[2];
    if (!Array.isArray(attrs)) return '';
    for (let i = 0; i < attrs.length; i += 2) {
      const name = attrs[i];
      if (typeof name === 'string' && name.startsWith('BODY[]') && typeof attrs[i + 1] === 'string') {
        return attrs[i + 1] as string;
      }
    }
    return '';
  }

  /** Removes the \Inbox label (Gmail's archive) or sets/clears \Seen — the
   * two write operations Inbox needs. Gmail's IMAP maps "remove from
   * INBOX" to the X-GM-LABELS extension when given -X-GM-LABELS (\Inbox),
   * which is the correct archive action (same as Thunderbird's own Archive
   * button) rather than a generic IMAP MOVE, which would need a second
   * destination-folder round trip. */
  async archive(uid: number): Promise<void> {
    const res = await this.command(`UID STORE ${uid} -X-GM-LABELS (\\Inbox)`);
    if (res.status !== 'OK') throw new ImapProtocolError(`archive failed: ${res.text || res.status}`);
  }

  /** Real delete — moves the message to Gmail's Trash, same mechanism as
   * archive() (a special-use label assigned via the X-GM-LABELS
   * extension), which Gmail treats as "move this message's location",
   * removing it from Inbox/All Mail the same as clicking Delete in Gmail
   * itself. Gmail auto-purges Trash after 30 days; this doesn't touch that
   * timer or bypass it. */
  async trash(uid: number): Promise<void> {
    const res = await this.command(`UID STORE ${uid} +X-GM-LABELS (\\Trash)`);
    if (res.status !== 'OK') throw new ImapProtocolError(`trash failed: ${res.text || res.status}`);
  }

  async setSeen(uid: number, seen: boolean): Promise<void> {
    const op = seen ? '+FLAGS.SILENT' : '-FLAGS.SILENT';
    const res = await this.command(`UID STORE ${uid} ${op} (\\Seen)`);
    if (res.status !== 'OK') throw new ImapProtocolError(`mark ${seen ? 'read' : 'unread'} failed: ${res.text || res.status}`);
  }

  /** Diagnostic only — not used by the regular sync path (see
   * fetchMessages). Pulls X-GM-LABELS alongside FLAGS/Subject for a set of
   * UIDs already in the selected mailbox, so a live account's actual Gmail
   * label state can be inspected directly (e.g. GET
   * /api/email/accounts/:id/debug-inbox) rather than inferred from
   * whether UID SEARCH ALL happened to return that UID. */
  async fetchLabelsDebug(uidSet: string): Promise<{ uid: number; flags: string[]; gmLabels: string[]; subject: string }[]> {
    if (!uidSet) return [];
    const res = await this.command(`UID FETCH ${uidSet} (UID FLAGS X-GM-LABELS BODY.PEEK[HEADER.FIELDS (SUBJECT)])`);
    if (res.status !== 'OK') throw new ImapProtocolError(`UID FETCH failed: ${res.text || res.status}`);
    return res.untagged.filter((l) => l[1] === 'FETCH').map((line) => {
      const attrs = line[2];
      const out = { uid: 0, flags: [] as string[], gmLabels: [] as string[], subject: '' };
      if (!Array.isArray(attrs)) return out;
      for (let i = 0; i < attrs.length; i += 2) {
        const name = attrs[i];
        const val = attrs[i + 1];
        if (typeof name !== 'string') continue;
        if (name === 'UID' && typeof val === 'string') out.uid = parseInt(val, 10);
        else if (name === 'FLAGS' && Array.isArray(val)) out.flags = val.filter((f): f is string => typeof f === 'string');
        else if (name === 'X-GM-LABELS' && Array.isArray(val)) out.gmLabels = val.filter((f): f is string => typeof f === 'string');
        else if (name.startsWith('BODY[HEADER.FIELDS') && typeof val === 'string') out.subject = val.replace(/^Subject:\s*/i, '').trim();
      }
      return out;
    });
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT');
    } catch {
      // best-effort — the socket close below is what actually matters
    }
    try {
      await this.writer?.close();
    } catch {
      /* already closing */
    }
  }
}

function parseFetchLine(line: ImapToken[]): FetchedMessage {
  // line shape: [seq, 'FETCH', [attr, val, attr, val, ...]]
  const attrs = line[2];
  const out: FetchedMessage = { uid: 0, gmMsgId: null, gmThrId: null, flags: [], headerBlock: '', snippet: '', snippetMime: '' };
  if (!Array.isArray(attrs)) return out;
  for (let i = 0; i < attrs.length; i += 2) {
    const name = attrs[i];
    const val = attrs[i + 1];
    if (typeof name !== 'string') continue;
    if (name === 'UID' && typeof val === 'string') out.uid = parseInt(val, 10);
    else if (name === 'X-GM-MSGID' && typeof val === 'string') out.gmMsgId = val;
    else if (name === 'X-GM-THRID' && typeof val === 'string') out.gmThrId = val;
    else if (name === 'FLAGS' && Array.isArray(val)) out.flags = val.filter((f): f is string => typeof f === 'string');
    else if (name.startsWith('BODY[HEADER.FIELDS') && typeof val === 'string') out.headerBlock = val;
    else if (name.startsWith('BODY[1.MIME]') && typeof val === 'string') out.snippetMime = val;
    else if (name.startsWith('BODY[1]') && typeof val === 'string') out.snippet = val;
  }
  return out;
}

/** Pulls From/Subject/Date out of a raw RFC822 header block — deliberately
 * simple line-based parsing (not a full RFC 2822 header parser: no folded-
 * header unwrapping beyond the basic continuation-line case, no RFC 2047
 * encoded-word decoding for non-ASCII names/subjects) since IMAP ENVELOPE's
 * own nested-list format is considerably more work to parse correctly for
 * the same three fields. Good enough for a preview; worth revisiting if
 * Mike's actual senders show mangled names/subjects in practice. */
export function parseHeaderBlock(block: string): ParsedHeaders {
  const lines = block.split(/\r\n/);
  const folded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && folded.length > 0) {
      folded[folded.length - 1] += ' ' + line.trim();
    } else if (line.trim()) {
      folded.push(line);
    }
  }
  let fromRaw = '';
  let subject = '';
  let dateRaw = '';
  let messageId: string | null = null;
  for (const line of folded) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'from') fromRaw = m[2];
    else if (key === 'subject') subject = m[2];
    else if (key === 'date') dateRaw = m[2];
    else if (key === 'message-id') messageId = m[2].trim();
  }
  let fromName: string | null = null;
  let fromEmail: string | null = null;
  const emailMatch = fromRaw.match(/<([^>]+)>/);
  if (emailMatch) {
    fromEmail = emailMatch[1].trim();
    fromName = fromRaw.slice(0, emailMatch.index).trim().replace(/^"|"$/g, '') || null;
  } else if (fromRaw.includes('@')) {
    fromEmail = fromRaw.trim();
  }
  let dateIso: string | null = null;
  if (dateRaw) {
    const d = new Date(dateRaw);
    if (!Number.isNaN(d.getTime())) dateIso = d.toISOString();
  }
  return { fromName, fromEmail, subject, dateIso, messageId };
}
