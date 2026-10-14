/** Structured "meeting-record" briefs (Mike's work Claude Project).
 *
 *  Mike pastes Claude's whole response: a markdown brief followed by ONE
 *  JSON block whose "format" starts with "meeting-record/". Copying the
 *  rendered response (instead of the copy button) drops the ``` fences,
 *  leaves the fence's language label on its own line ("meeting") and
 *  flattens the markdown — so nothing here relies on the fence:
 *
 *   1. find `"format": "meeting-record/` (straight or curly quotes),
 *   2. walk back to the `{` that encloses it, brace-match forward
 *      (string-aware) to its `}`,
 *   3. parse (tolerating curly quotes and trailing commas), normalize,
 *   4. everything else is the note: the record (+ a 1–2 word label line or
 *      fence right above it) is cut out, and if the note has no `#`
 *      headings, lines that are exactly a known section name become `##`.
 *
 *  No AI here — the thinking happened in Claude; this only files it. */

export type RecordKind = 'debrief' | 'prep' | 'weekly' | 'thread';

export interface RecordPersonRef {
  name: string;
  email: string | null;
}
export interface RecordAction {
  id: string;
  text: string;
  owner: string | null; // 'me' | a name | null (unowned / a team)
  ownerEmail: string | null;
  due: string | null;
  confidence: 'stated' | 'implied';
  source: string | null;
}
export interface RecordPerson extends RecordPersonRef {
  context: string[];
}
export interface RecordAssist {
  title: string;
  actionId: string | null;
  prompt: string;
}
export interface RecordMaterial {
  name: string;
  type: string;
  takeaway: string;
  url: string | null;
}
/** How last time's next steps went (Claude compares the carry-forward in
 * Mike's Copy for Claude packet with this meeting's notes). */
export interface RecordFollowThrough {
  text: string;
  owner: string | null;
  status: 'done' | 'in_progress' | 'open' | 'unclear';
  note: string | null;
}
export interface MeetingRecord {
  format: string;
  kind: RecordKind;
  meeting: { title: string; date: string | null; series: string | null; attendees: RecordPersonRef[]; attendeesConfirmed: boolean | null } | null;
  thread: { title: string; source: string; channel: string | null; date: string | null; participants: RecordPersonRef[] } | null;
  weekOf: string | null;
  tldr: string[];
  decisions: string[];
  actions: RecordAction[];
  people: RecordPerson[];
  watchOuts: string[];
  openQuestions: string[];
  assists: RecordAssist[];
  materials: RecordMaterial[];
  projects: string[];
  followThrough: RecordFollowThrough[];
  goals: string[];
  talkingPoints: string[];
  questions: string[];
  priorities: string[];
  highlights: string[];
  start: string[];
  stop: string[];
  continue: string[];
}

export interface Extracted {
  /** A "meeting-record/" marker was found (even if it didn't parse). */
  found: boolean;
  record: MeetingRecord | null;
  /** The brief without the record — markdown, headings restored. */
  note: string;
  /** Why the record couldn't be read (found but unparseable / unusable). */
  error: string | null;
}

export const SECTION_NAMES = [
  'TL;DR',
  'What Happened',
  'Decisions',
  'Not Actually Decided',
  'Materials Review',
  'The Deck',
  'Narrative & Positioning',
  'Watch-Outs',
  'Stakeholder Notes',
  'People',
  'Next Steps',
  'Open Questions',
  'Where AI Can Help',
  'Update Project Knowledge',
  'Suggested Reply',
  'Follow-Through',
  'Follow-Through From Last Time',
  'Your Update',
  'Marketing Lens',
  'The Meeting in One Line',
  'What Mike Should Get Out of It',
  'Open Items With These People',
  'Talking Points',
  'Questions to Ask',
  'Accomplished',
  'In Flight',
  'Blocked / Waiting On',
  "Next Week's Priorities",
  'Start / Stop / Continue',
];

const MARKER = /["“”]format["“”]\s*:\s*["“”]meeting-record\//;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The index of the `{` that encloses position `at` (backwards scan). */
function openerBefore(s: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = s[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** The index just past the `}` matching the `{` at `open` (string-aware;
 * curly double quotes count as string delimiters too). */
function closerAfter(s: string, open: number): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"' || ((inStr === '“' || inStr === '”') && (ch === '”' || ch === '“'))) inStr = null;
      continue;
    }
    if (ch === '"' || ch === '“' || ch === '”') inStr = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** JSON.parse with the usual copy-paste damage repaired. */
export function lenientParse(json: string): unknown {
  const attempts = [
    json,
    json.replace(/,\s*([}\]])/g, '$1'),
    // Curly quotes used as JSON delimiters (around keys and values).
    json.replace(/[“”]/g, '"'),
    json.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1'),
    // Unescaped curly quotes INSIDE strings: make them safe, keep delimiters.
    json.replace(/(^|[{[,:]\s*)[“”]/g, '$1"').replace(/[“”](\s*[:,}\]])/g, '"$1').replace(/,\s*([}\]])/g, '$1'),
  ];
  let last: unknown;
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const strOrNull = (v: unknown, max = 500): string | null => {
  const s = str(v, max);
  return s && s.toLowerCase() !== 'null' ? s : null;
};
const strList = (v: unknown, max = 60, len = 2000): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => str(x, len))
        .filter(Boolean)
        .slice(0, max)
    : typeof v === 'string' && v.trim()
      ? [v.trim().slice(0, len)]
      : [];
const dateOrNull = (v: unknown): string | null => {
  const s = str(v, 40);
  if (DATE.test(s)) return s;
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(s);
  return m ? m[1] : null;
};
const email = (v: unknown): string | null => {
  const s = str(v, 320).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};
const bool = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  const s = str(v, 20).toLowerCase();
  if (s === 'true' || s === 'yes') return true;
  if (s === 'false' || s === 'no') return false;
  return null;
};
function people(v: unknown, max = 60): RecordPersonRef[] {
  if (!Array.isArray(v)) return [];
  const out: RecordPersonRef[] = [];
  for (const p of v) {
    if (typeof p === 'string' && p.trim()) out.push({ name: p.trim().slice(0, 200), email: null });
    else if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>;
      const name = str(o.name, 200);
      if (name) out.push({ name, email: email(o.email) });
    }
    if (out.length >= max) break;
  }
  return out;
}

/** Turn whatever JSON came back into a clean record, or explain why not. */
export function normalizeRecord(raw: unknown): MeetingRecord | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'The record is not a JSON object.';
  const o = raw as Record<string, unknown>;
  const format = str(o.format, 60);
  if (!format.startsWith('meeting-record/')) return 'The record has no "format": "meeting-record/1".';
  const kindRaw = str(o.kind, 20).toLowerCase();
  const kind: RecordKind = kindRaw === 'prep' || kindRaw === 'weekly' || kindRaw === 'thread' ? kindRaw : 'debrief';

  const mo = o.meeting && typeof o.meeting === 'object' ? (o.meeting as Record<string, unknown>) : null;
  const meeting = mo
    ? {
        title: str(mo.title, 200) || 'Meeting',
        date: dateOrNull(mo.date),
        series: strOrNull(mo.series, 200),
        attendees: people(mo.attendees),
        attendeesConfirmed: bool(mo.attendees_confirmed ?? mo.attendeesConfirmed),
      }
    : null;
  const to = o.thread && typeof o.thread === 'object' ? (o.thread as Record<string, unknown>) : null;
  const thread = to
    ? {
        title: str(to.title, 200) || 'Thread',
        source: (str(to.source, 20).toLowerCase() || 'other').replace(/[^a-z]/g, '') || 'other',
        channel: strOrNull(to.channel, 200),
        date: dateOrNull(to.date),
        participants: people(to.participants),
      }
    : null;
  if ((kind === 'debrief' || kind === 'prep') && !meeting) return 'The record has no "meeting".';
  if (kind === 'thread' && !thread) return 'The record has no "thread".';

  const actions: RecordAction[] = [];
  if (Array.isArray(o.actions)) {
    o.actions.forEach((a, i) => {
      if (!a || typeof a !== 'object') return;
      const x = a as Record<string, unknown>;
      const text = str(x.text, 1000);
      if (!text) return;
      const owner = strOrNull(x.owner, 200);
      actions.push({
        id: str(x.id, 40) || `a${i + 1}`,
        text,
        owner: owner && /^(unowned|none|n\/a|team)$/i.test(owner) ? null : owner,
        ownerEmail: email(x.owner_email ?? x.ownerEmail),
        due: dateOrNull(x.due),
        confidence: str(x.confidence, 20).toLowerCase() === 'implied' ? 'implied' : 'stated',
        source: strOrNull(x.source, 40),
      });
    });
  }

  const ppl: RecordPerson[] = [];
  if (Array.isArray(o.people)) {
    for (const p of o.people) {
      if (!p || typeof p !== 'object') continue;
      const x = p as Record<string, unknown>;
      const name = str(x.name, 200);
      if (!name) continue;
      ppl.push({ name, email: email(x.email), context: strList(x.context, 20, 600) });
    }
  }

  const assists: RecordAssist[] = [];
  if (Array.isArray(o.assists)) {
    for (const a of o.assists) {
      if (!a || typeof a !== 'object') continue;
      const x = a as Record<string, unknown>;
      const prompt = str(x.prompt, 8000);
      if (!prompt) continue;
      assists.push({ title: str(x.title, 200) || 'Prompt', actionId: strOrNull(x.action_id ?? x.actionId, 40), prompt });
    }
  }

  const materials: RecordMaterial[] = [];
  if (Array.isArray(o.materials)) {
    for (const m of o.materials) {
      if (!m || typeof m !== 'object') continue;
      const x = m as Record<string, unknown>;
      const name = str(x.name, 300);
      if (!name) continue;
      const url = str(x.url ?? x.link, 2000);
      materials.push({ name, type: str(x.type, 20).toLowerCase() || 'other', takeaway: str(x.takeaway, 1000), url: /^https?:\/\//i.test(url) ? url : null });
    }
  }

  const followThrough: RecordFollowThrough[] = [];
  const ftRaw = o.follow_through ?? o.followThrough;
  if (Array.isArray(ftRaw)) {
    for (const f of ftRaw) {
      if (!f || typeof f !== 'object') continue;
      const x = f as Record<string, unknown>;
      const text = str(x.text, 1000);
      if (!text) continue;
      const st = str(x.status, 20).toLowerCase().replace(/[\s-]+/g, '_');
      followThrough.push({
        text,
        owner: strOrNull(x.owner, 200),
        status: st === 'done' || st === 'in_progress' || st === 'open' ? st : 'unclear',
        note: strOrNull(x.note, 600),
      });
    }
  }

  return {
    format,
    kind,
    followThrough: followThrough.slice(0, 60),
    meeting,
    thread,
    weekOf: dateOrNull(o.week_of ?? o.weekOf),
    tldr: strList(o.tldr, 10),
    decisions: strList(o.decisions),
    actions: actions.slice(0, 80),
    people: ppl.slice(0, 60),
    watchOuts: strList(o.watch_outs ?? o.watchOuts),
    openQuestions: strList(o.open_questions ?? o.openQuestions),
    assists: assists.slice(0, 12),
    materials: materials.slice(0, 20),
    projects: strList(o.projects, 20, 200),
    goals: strList(o.goals),
    talkingPoints: strList(o.talking_points ?? o.talkingPoints),
    questions: strList(o.questions),
    priorities: strList(o.priorities),
    highlights: strList(o.highlights),
    start: strList(o.start),
    stop: strList(o.stop),
    continue: strList(o.continue),
  };
}

const LABEL_LINE = /^\s*(?:```\s*[\w-]*|[A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*)?)\s*$/;
const FENCE_LINE = /^\s*```\s*$/;

/** Cut the record (and its fence / stray label) out of the pasted text. */
function cutRecord(text: string, open: number, close: number): string {
  const beforeLines = text.slice(0, open).split('\n');
  // The opener's own line may hold a label before the `{` (rare) — drop it.
  beforeLines[beforeLines.length - 1] = '';
  // Drop trailing blank lines, then ONE fence/label line right above.
  while (beforeLines.length && !beforeLines[beforeLines.length - 1].trim()) beforeLines.pop();
  if (beforeLines.length && LABEL_LINE.test(beforeLines[beforeLines.length - 1]) && !isSectionName(beforeLines[beforeLines.length - 1])) beforeLines.pop();
  const afterLines = text.slice(close).split('\n');
  while (afterLines.length && (!afterLines[0].trim() || FENCE_LINE.test(afterLines[0]))) afterLines.shift();
  return [...beforeLines, '', ...afterLines].join('\n').trim();
}

function sectionKey(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*\*(.*)\*\*:?$/, '$1')
    .replace(/:$/, '')
    .trim()
    .toLowerCase();
}
const SECTION_KEYS = new Set(SECTION_NAMES.map((s) => s.toLowerCase()));
export function isSectionName(line: string): boolean {
  return SECTION_KEYS.has(sectionKey(line));
}

/** Plain-text paste (no `#` headings): known section names → `## Name`. */
export function rehydrateHeadings(note: string): string {
  const lines = note.split('\n');
  if (lines.some((l) => /^\s{0,3}#{1,6}\s/.test(l))) return note;
  return lines
    .map((l) => {
      if (!isSectionName(l)) return l;
      const name = SECTION_NAMES.find((s) => s.toLowerCase() === sectionKey(l)) ?? l.trim();
      return `## ${name}`;
    })
    .join('\n');
}

export function extractRecord(text: string): Extracted {
  const src = text.replace(/\r\n?/g, '\n');
  const m = MARKER.exec(src);
  if (!m) return { found: false, record: null, note: rehydrateHeadings(src.trim()), error: null };
  const open = openerBefore(src, m.index);
  const close = open === -1 ? -1 : closerAfter(src, open);
  if (open === -1 || close === -1) {
    return { found: true, record: null, note: rehydrateHeadings(src.slice(0, Math.max(0, open === -1 ? m.index : open)).trim()), error: "The record block is cut off — ask Claude to resend just the meeting-record block." };
  }
  const note = rehydrateHeadings(cutRecord(src, open, close));
  let parsed: unknown;
  try {
    parsed = lenientParse(src.slice(open, close));
  } catch {
    return { found: true, record: null, note, error: "Record couldn't be read — ask Claude to resend just the meeting-record block." };
  }
  const rec = normalizeRecord(parsed);
  if (typeof rec === 'string') return { found: true, record: null, note, error: rec };
  return { found: true, record: rec, note, error: null };
}

// ---------------------------------------------------------------------------
// Markdown → TipTap (the note body) and → plain text (search)
// ---------------------------------------------------------------------------

type Mark = { type: 'bold' } | { type: 'italic' } | { type: 'code' } | { type: 'link'; attrs: { href: string; target: string; rel: string } };
const linkMark = (href: string): Mark => ({ type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer nofollow' } });
type TextNode = { type: 'text'; text: string; marks?: Mark[] };

/** **bold**, *italic*, `code`, [text](url) and bare https:// links. */
function inline(s: string): TextNode[] {
  const out: TextNode[] = [];
  const re = /(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(s))) {
    if (mm.index > last) out.push({ type: 'text', text: s.slice(last, mm.index) });
    const t = mm[0];
    const md = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(t);
    if (md) out.push({ type: 'text', text: md[1], marks: [linkMark(md[2])] });
    else if (/^https?:\/\//i.test(t)) out.push({ type: 'text', text: t, marks: [linkMark(t)] });
    else if (t.startsWith('**') || t.startsWith('__')) out.push({ type: 'text', text: t.slice(2, -2), marks: [{ type: 'bold' }] });
    else if (t.startsWith('`')) out.push({ type: 'text', text: t.slice(1, -1), marks: [{ type: 'code' }] });
    else out.push({ type: 'text', text: t.slice(1, -1), marks: [{ type: 'italic' }] });
    last = mm.index + t.length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out.filter((n) => n.text);
}

const para = (s: string) => ({ type: 'paragraph', attrs: { textAlign: null }, ...(s ? { content: inline(s) } : {}) });

export function markdownToTiptap(md: string): string {
  const content: unknown[] = [];
  let list: { type: 'bulletList' | 'orderedList'; items: unknown[] } | null = null;
  let inFence = false;
  let fence: string[] = [];
  const flush = () => {
    if (list?.items.length) content.push({ type: list.type, content: list.items });
    list = null;
  };
  for (const raw of md.split('\n')) {
    if (/^\s*```/.test(raw)) {
      if (inFence) {
        content.push({ type: 'codeBlock', attrs: { language: null }, content: fence.length ? [{ type: 'text', text: fence.join('\n') }] : undefined });
        fence = [];
      } else flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fence.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      content.push({ type: 'heading', attrs: { level: Math.min(3, Math.max(2, h[1].length)), textAlign: null }, content: inline(h[2].replace(/\s*#+\s*$/, '')) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      content.push({ type: 'horizontalRule' });
      continue;
    }
    const b = /^\s*(?:[-*•+]|\[\s?[xX ]?\s?\])\s+(.*)$/.exec(line);
    const n = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (b || n) {
      const type = b ? 'bulletList' : 'orderedList';
      if (list && list.type !== type) flush();
      if (!list) list = { type, items: [] };
      list.items.push({ type: 'listItem', content: [para((b ?? n)![1])] });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flush();
      content.push({ type: 'blockquote', content: [para(line.replace(/^\s*>\s?/, ''))] });
      continue;
    }
    flush();
    content.push(para(line.trim()));
  }
  if (inFence && fence.length) content.push({ type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: fence.join('\n') }] });
  flush();
  return JSON.stringify({ type: 'doc', content: content.length ? content : [para('')] });
}

/** Every link in a brief: [text](url) (text kept as the name) and bare URLs. */
export function briefLinks(md: string): { url: string; name: string | null }[] {
  const out = new Map<string, string | null>();
  for (const m of md.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) out.set(m[2], m[1].trim());
  for (const m of md.replace(/\[[^\]]+\]\([^)]*\)/g, ' ').matchAll(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g)) if (!out.has(m[0])) out.set(m[0], null);
  return [...out].map(([url, name]) => ({ url, name }));
}

export function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*•+]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Short title fragment for a thread note: "Slack", "Email", "Doc". */
export function threadSourceLabel(source: string): string {
  return { slack: 'Slack', email: 'Email', doc: 'Doc', teams: 'Teams' }[source] ?? 'Thread';
}
