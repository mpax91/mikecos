import { connect } from 'cloudflare:sockets';

/** Minimal SMTP client for Inbox's "reply" feature — plain-text only, one
 * recipient path (reply-to-sender), AUTH LOGIN over implicit TLS (port
 * 465, avoiding the extra STARTTLS upgrade step 587 would need). Same
 * caveat as imapClient.ts: written carefully against RFC 5321 but not
 * exercised against a live server from this environment. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export class SmtpError extends Error {}

class LineReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = '';

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  /** Reads one multi-line SMTP reply (e.g. "250-...\r\n250 ...\r\n"),
   * returning once a line's 4th character is a space rather than '-'. */
  async readReply(): Promise<{ code: number; text: string }> {
    let lines: string[] = [];
    while (true) {
      while (!this.buf.includes('\r\n')) {
        const { value, done } = await this.reader.read();
        if (done) throw new SmtpError('SMTP connection closed while reading');
        this.buf += dec.decode(value, { stream: true });
      }
      const idx = this.buf.indexOf('\r\n');
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      lines.push(line);
      if (line.length >= 4 && line[3] === ' ') {
        const code = parseInt(line.slice(0, 3), 10);
        return { code, text: lines.map((l) => l.slice(4)).join('\n') };
      }
    }
  }
}

export async function sendMail(opts: {
  host: string;
  port: number;
  user: string;
  pass: string;
  fromEmail: string;
  /** One or more "To" recipients — a reply-all can have several. */
  toEmails: string[];
  /** Additional Cc recipients (reply-all's other original recipients). Left
   * out (or empty) sends with no Cc header at all. */
  ccEmails?: string[];
  subject: string;
  bodyText: string;
  inReplyTo?: string | null;
  references?: string | null;
}): Promise<void> {
  const socket = connect({ hostname: opts.host, port: opts.port }, { secureTransport: 'on', allowHalfOpen: false });
  await socket.opened;
  const writer = socket.writable.getWriter();
  const reader = new LineReader(socket.readable);

  async function expect(cmd: string | null, okCodes: number[]): Promise<string> {
    if (cmd !== null) await writer.write(enc.encode(cmd + '\r\n'));
    const { code, text } = await reader.readReply();
    if (!okCodes.includes(code)) throw new SmtpError(`SMTP ${cmd ?? '(greeting)'} failed: ${code} ${text}`);
    return text;
  }

  try {
    await expect(null, [220]);
    await expect(`EHLO mikeos`, [250]);
    await expect('AUTH LOGIN', [334]);
    await expect(btoa(opts.user), [334]);
    await expect(btoa(opts.pass), [235]);
    await expect(`MAIL FROM:<${opts.fromEmail}>`, [250]);
    const allRecipients = [...opts.toEmails, ...(opts.ccEmails ?? [])];
    for (const rcpt of allRecipients) {
      await expect(`RCPT TO:<${rcpt}>`, [250, 251]);
    }
    await expect('DATA', [354]);

    const messageId = `<${crypto.randomUUID()}@mikeos>`;
    const headers = [
      `From: ${opts.fromEmail}`,
      `To: ${opts.toEmails.join(', ')}`,
      opts.ccEmails && opts.ccEmails.length > 0 ? `Cc: ${opts.ccEmails.join(', ')}` : null,
      `Subject: ${opts.subject}`,
      `Message-ID: ${messageId}`,
      opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : null,
      opts.references ? `References: ${opts.references}` : null,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ].filter((h): h is string => h !== null);
    // Dot-stuffing: a line that starts with '.' gets an extra '.' prepended,
    // per RFC 5321, so it isn't mistaken for the end-of-data marker.
    const bodyLines = opts.bodyText.split(/\r?\n/).map((l) => (l.startsWith('.') ? '.' + l : l));
    const message = headers.join('\r\n') + '\r\n\r\n' + bodyLines.join('\r\n') + '\r\n.';
    await expect(message, [250]);
    await expect('QUIT', [221]);
  } finally {
    try {
      await writer.close();
    } catch {
      /* already closing */
    }
  }
}
