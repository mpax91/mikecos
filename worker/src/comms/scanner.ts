/** Streaming reader for SMS Backup & Restore XML (calls-*.xml, sms-*.xml).
 *
 * The sms file is ~2 GB because picture messages carry their photos and
 * videos inline as base64 `data="…"` attributes. This never holds a
 * message or an attachment in memory: it walks the text chunk by chunk,
 * jumps from one `<` to the next with indexOf (base64 has no `<`), and
 * only buffers the small tags it needs (<call>, <sms>, <mms>, <addr>).
 * <part> tags (message text + attachments) are skipped entirely — message
 * content is never read.
 *
 * Can start at any byte offset (a Range read): until the first recognized
 * tag it simply finds nothing. */

export interface CallEvent {
  kind: 'call';
  date: number;
  number: string;
  duration: number;
  type: number; // 1 in · 2 out · 3 missed · 4 voicemail · 5 rejected · 6 blocked · 7 answered elsewhere
}
export interface SmsEvent {
  kind: 'sms';
  date: number;
  address: string;
  type: number; // 1 received · 2 sent (others: draft/outbox/failed/queued)
}
export interface MmsEvent {
  kind: 'mms';
  date: number; // ms
  box: number; // msg_box: 1 received · 2 sent
  address: string;
  self: string | null;
  addrs: { address: string; type: number }[]; // 137 from · 151 to · 130 cc · 129 bcc
}
export type BackupEvent = CallEvent | SmsEvent | MmsEvent;

const MAX_TAG = 256 * 1024; // a long text body; anything longer is truncated (attrs we need come first)

export class BackupScanner {
  /** 'out' = between tags; 'tag' = buffering a wanted tag; 'skip' = inside
   * a tag we don't need (a <part> with its attachment). Every tag ends where
   * the next `<` begins — XML never allows a raw `<` inside an attribute,
   * so this needs no quote tracking (a stray `"` in a backed-up message
   * can't knock the reader out of step). */
  private state: 'out' | 'tag' | 'skip' = 'out';
  private tagName = '';
  private buf = '';
  private carry = '';
  private mms: MmsEvent | null = null;
  /** True once a <mms tag has been seen (the plain-text block is over). */
  sawMms = false;
  sawSms = false;
  /** Date on the first <mms> opening tag seen (for date probes). */
  firstMmsDate: number | null = null;
  readonly events: BackupEvent[] = [];

  constructor(private readonly want: { call?: boolean; sms?: boolean; mms?: boolean }) {}

  /** Feed the next chunk of text. Events land in `events` (caller drains). */
  push(chunk: string): void {
    const s = this.carry + chunk;
    this.carry = '';
    let i = 0;
    const n = s.length;
    while (i < n) {
      if (this.state !== 'out') {
        const j = s.indexOf('<', i);
        if (j < 0) {
          if (this.state === 'tag') this.append(s.slice(i));
          return;
        }
        if (this.state === 'tag') {
          this.append(s.slice(i, j));
          this.endTag();
        }
        this.state = 'out';
        i = j;
        continue;
      }
      const j = s.indexOf('<', i);
      if (j < 0) return;
      if (n - j < 8) {
        this.carry = s.slice(j);
        return;
      }
      const m = /^<(\/?)([a-zA-Z]+)/.exec(s.slice(j, j + 12));
      i = j + 1;
      if (!m) continue;
      const [, close, name] = m;
      if (close) {
        if (name === 'mms' && this.mms) this.finishMms();
        continue;
      }
      if (name === 'call' || name === 'sms' || name === 'mms' || name === 'addr') {
        if (name === 'mms') this.sawMms = true;
        if (name === 'sms') this.sawSms = true;
        this.state = 'tag';
        this.tagName = name;
        this.buf = '';
        i = j + 1 + name.length;
      } else if (name === 'part') {
        this.state = 'skip';
        i = j + 5;
      }
    }
  }

  private append(t: string) {
    if (this.buf.length < MAX_TAG) this.buf += t.length > MAX_TAG ? t.slice(0, MAX_TAG) : t;
  }

  private attr(name: string): string | null {
    const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(this.buf);
    return m ? m[1] : null;
  }

  private endTag() {
    const name = this.tagName;
    if (name === 'call') {
      if (this.want.call) {
        const date = Number(this.attr('date'));
        if (date) this.events.push({ kind: 'call', date, number: this.attr('number') ?? '', duration: Number(this.attr('duration') ?? 0) || 0, type: Number(this.attr('type') ?? 0) });
      }
    } else if (name === 'sms') {
      if (this.want.sms) {
        const date = Number(this.attr('date'));
        if (date) this.events.push({ kind: 'sms', date, address: this.attr('address') ?? '', type: Number(this.attr('type') ?? 0) });
      }
    } else if (name === 'mms') {
      if (this.mms) this.finishMms();
      const date = Number(this.attr('date'));
      // A self-closing <mms …/> has no parts/addrs.
      const selfClosing = /\/\s*>\s*$/.test(this.buf);
      if (date && this.firstMmsDate === null) this.firstMmsDate = date;
      if (date && this.want.mms) {
        this.mms = { kind: 'mms', date, box: Number(this.attr('msg_box') ?? 0), address: this.attr('address') ?? '', self: this.attr('self_phone_number'), addrs: [] };
        if (selfClosing) this.finishMms();
      }
    } else if (name === 'addr') {
      if (this.mms) this.mms.addrs.push({ address: this.attr('address') ?? '', type: Number(this.attr('type') ?? 0) });
    }
    this.buf = '';
  }

  private finishMms() {
    if (this.mms) this.events.push(this.mms);
    this.mms = null;
  }
}
