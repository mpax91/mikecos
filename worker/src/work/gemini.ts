/** Rule-based reader for meeting summaries — Google Meet's "Notes by
 * Gemini" docs (pasted, or downloaded as .txt/.md) and anything shaped like
 * them. No AI: it finds the section headings, drops Gemini's boilerplate and
 * the (00:12:34) timestamps, and splits "Suggested next steps" into action
 * items with an owner ("Sarah Chen will send the deck", "[Mike Palladino]
 * Q4 brief: draft it…"). Text without headings is kept whole as the summary
 * and still scanned for "<Name> will …" lines. */

export interface ParsedAction {
  text: string;
  owners: string[];
}

export interface ParsedSummary {
  summary: string;
  details: string;
  decisions: string;
  actions: ParsedAction[];
  /** Any other headed sections, kept so nothing pasted is lost. */
  other: { heading: string; body: string }[];
}

type SectionKey = 'summary' | 'details' | 'decisions' | 'actions' | 'skip';

const HEADINGS: [RegExp, SectionKey][] = [
  [/^(meeting\s+)?summary:?$/i, 'summary'],
  [/^(overview|tl;?dr|key takeaways?):?$/i, 'summary'],
  [/^(details|discussion|notes|discussion points|topics):?$/i, 'details'],
  [/^(key\s+)?decisions?(\s+made)?:?$/i, 'decisions'],
  [/^(suggested\s+)?next\s+steps:?$/i, 'actions'],
  [/^(action\s+items?|to-?dos?|follow[\s-]?ups?|takeaways and next steps):?$/i, 'actions'],
  [/^(attachments?|meeting records?|invited|transcript|recording)\b.*$/i, 'skip'],
];

const BOILERPLATE = [
  /^you should review gemini'?s notes/i,
  /^please provide feedback/i,
  /^get tips and learn how gemini/i,
  /^this editable transcript was/i,
  /^notes by gemini$/i,
  /^📝\s*notes$/i,
];

const TIMESTAMP = /\s*\((?:\d{1,2}:)?\d{1,2}:\d{2}\)/g;
const BULLET = /^\s*(?:[-*•▪◦–]|\d+[.)]|\[\s?[xX ]?\s?\]|☐|☑|✅)\s*/;

function clean(line: string): string {
  return line.replace(TIMESTAMP, '').replace(/ /g, ' ').trimEnd();
}

function stripBullet(line: string): string {
  let out = line;
  // "* [ ] Mike will…" has two markers.
  for (let i = 0; i < 2; i++) out = out.replace(BULLET, '');
  return out.trim();
}

function sectionOf(line: string): SectionKey | null {
  const t = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
  if (!t || t.length > 40) return null;
  for (const [re, key] of HEADINGS) if (re.test(t)) return key;
  return null;
}

const NAME = `[A-Z][\\p{L}'’.-]+(?:\\s+(?:[A-Z][\\p{L}'’.-]+|de|van|von|da|di|del|la|le)){0,3}`;
const OWNER_LIST = `${NAME}(?:\\s*(?:,|&|\\band\\b)\\s*${NAME})*`;
const VERBS = `will|to|should|needs? to|is going to|are going to|agreed to|plans? to|committed to|owns|is to|are to|must|has to|have to|can`;
const VERB_FORM = new RegExp(`^(${OWNER_LIST})\\s+(?:${VERBS})\\s+(.+)$`, 'u');
const BRACKET_FORM = /^\[([^\]]{2,80})\]\s*[:\-–]?\s*(.+)$/u;
const COLON_OWNER = new RegExp(`^(${OWNER_LIST})\\s*[:\\-–]\\s+(.+)$`, 'u');

function splitOwners(s: string): string[] {
  return s
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((x) => x.trim())
    .filter((x) => x.length > 1);
}

function capFirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** One next-step line → text + owners (owners may be empty). */
export function parseActionLine(raw: string, knownNames: string[] = []): ParsedAction | null {
  const line = stripBullet(clean(raw));
  if (line.length < 3) return null;
  let m = BRACKET_FORM.exec(line);
  if (m) return { owners: splitOwners(m[1]), text: capFirst(m[2].trim()) };
  m = VERB_FORM.exec(line);
  if (m) {
    const owners = splitOwners(m[1]);
    // "The team will…" / "We will…" aren't people.
    if (owners.every((o) => /^(the|we|they|team|everyone|all|it|this|that)$/i.test(o.split(/\s+/)[0]))) return { owners: [], text: capFirst(line) };
    // "Budget will be finalized…" — a passive sentence, not a person.
    if (/^be\b/i.test(m[2]) && !owners.some((o) => knownNames.some((n) => n.toLowerCase() === o.toLowerCase()))) return { owners: [], text: capFirst(line) };
    return { owners, text: capFirst(m[2].trim()) };
  }
  m = COLON_OWNER.exec(line);
  if (m && knownNames.some((n) => splitOwners(m![1]).some((o) => o.toLowerCase() === n.toLowerCase()))) {
    return { owners: splitOwners(m[1]), text: capFirst(m[2].trim()) };
  }
  return { owners: [], text: capFirst(line) };
}

export function parseMeetingSummary(input: string, knownNames: string[] = []): ParsedSummary {
  const lines = input.replace(/\r\n?/g, '\n').split('\n').map(clean);
  const buckets: Record<Exclude<SectionKey, 'skip'>, string[]> = { summary: [], details: [], decisions: [], actions: [] };
  const other: { heading: string; body: string[] }[] = [];
  let current: SectionKey | 'preamble' | 'other' = 'preamble';
  let sawHeading = false;
  const preamble: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    if (BOILERPLATE.some((re) => re.test(t))) continue;
    const sec = sectionOf(t);
    if (sec) {
      sawHeading = true;
      current = sec;
      continue;
    }
    // A markdown heading we don't recognize starts an "other" section.
    if (/^#{1,4}\s+\S/.test(t) && sawHeading) {
      other.push({ heading: t.replace(/^#+\s*/, ''), body: [] });
      current = 'other';
      continue;
    }
    if (current === 'skip') {
      // Gemini puts "Invited …" / "Attachments …" on one line each; a blank
      // line ends the block.
      if (!t) current = 'preamble';
      continue;
    }
    if (current === 'preamble') preamble.push(line);
    else if (current === 'other') other[other.length - 1].body.push(line);
    else buckets[current].push(line);
  }

  const join = (arr: string[]) => arr.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  let summary = join(buckets.summary);
  if (!sawHeading) summary = join(preamble);

  const actionLines = sawHeading
    ? buckets.actions
    : // No headings: any line that reads like "<Name> will …" is a next step.
      preamble.filter((l) => VERB_FORM.test(stripBullet(l)) || BRACKET_FORM.test(stripBullet(l)));
  const actions: ParsedAction[] = [];
  for (const raw of actionLines) {
    if (!raw.trim()) continue;
    // Continuation lines (indented, no bullet) belong to the previous item.
    if (actions.length && /^\s{2,}\S/.test(raw) && !BULLET.test(raw)) {
      actions[actions.length - 1].text += ' ' + raw.trim();
      continue;
    }
    const a = parseActionLine(raw, knownNames);
    if (a) actions.push(a);
  }

  return {
    summary,
    details: join(buckets.details),
    decisions: join(buckets.decisions),
    actions,
    other: other.map((o) => ({ heading: o.heading, body: join(o.body) })).filter((o) => o.body),
  };
}

/** Does this owner string refer to Mike? `myNames` = "Mike Palladino, Mike, …". */
export function isMe(owner: string, myNames: string[]): boolean {
  const o = owner.trim().toLowerCase();
  return myNames.some((n) => n.trim().toLowerCase() === o);
}
