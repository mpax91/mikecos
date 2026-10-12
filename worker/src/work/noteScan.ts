/** Mike's own meeting notes → next steps (Mike, 2026-10-12). Rule-based, no
 * AI. The 📝 note on a meeting starts from a template (Notes / Decisions /
 * Next Steps with "Mike will …" / "<Name> will …" lines) and the WHOLE note
 * is read for action lines afterwards, so it doesn't matter whether Mike
 * remembered to use the Next Steps section:
 *
 *  - anything under a "Next Steps" / "Action Items" / "To-Dos" heading
 *    (an ownerless line there is Mike's);
 *  - anywhere: "<Name> will|to|should …" when Name is Mike or someone on
 *    the meeting, "<Name>: …", "@Name …", "… → Name", "[Name] …";
 *  - anywhere: "I'll / I will / I need to / I owe …", "Me: …",
 *    "TODO …", "Action: …", "[ ] …" and unchecked checklist items (Mike's,
 *    unless the line names an owner).
 *
 * Checked checklist items, empty template prompts ("Elliott will …") and
 * lines under a Decisions heading are ignored. */

import { parseActionLine, type ParsedAction } from './gemini';

export interface NoteLine {
  text: string;
  heading: boolean;
  /** true/false for a checklist item, null otherwise. */
  checked: boolean | null;
}

type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: Node[] };

/** TipTap JSON → one entry per block (heading, paragraph, list item). */
export function noteLines(contentJson: string | null | undefined): NoteLine[] {
  if (!contentJson) return [];
  let doc: Node;
  try {
    doc = JSON.parse(contentJson) as Node;
  } catch {
    return [];
  }
  const out: NoteLine[] = [];
  const inline = (n: Node): string => {
    if (typeof n.text === 'string') return n.text;
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'mention') return String(n.attrs?.label ?? n.attrs?.id ?? '');
    return (n.content ?? []).map(inline).join('');
  };
  const push = (text: string, heading: boolean, checked: boolean | null) => {
    for (const part of text.split('\n')) {
      const t = part.replace(/ /g, ' ').trim();
      if (t) out.push({ text: t, heading, checked });
    }
  };
  const walk = (n: Node, checked: boolean | null) => {
    switch (n.type) {
      case 'heading':
        push(inline(n), true, null);
        return;
      case 'paragraph':
        push(inline(n), false, checked);
        return;
      case 'taskItem': {
        const c = n.attrs?.checked === true;
        // The item's own paragraph(s) carry its checked state; nested lists
        // inside it are walked as their own items.
        for (const child of n.content ?? []) walk(child, child.type === 'paragraph' ? c : null);
        return;
      }
      case 'codeBlock':
      case 'attachment':
      case 'linkPreview':
      case 'image':
        return;
      default:
        for (const child of n.content ?? []) walk(child, checked);
    }
  };
  walk(doc, null);
  return out;
}

const ACTION_HEADING = /^(suggested\s+)?(next\s+steps|action\s+items?|to-?dos?|follow[\s-]?ups?)\b/i;
const OTHER_HEADING_SKIP = /^(key\s+)?decisions?\b/i;
/** A template prompt nobody filled in: "Elliott will …" / "Mike will". */
const EMPTY_PROMPT = /^[\s.…_-]*$/;
const MINE_PREFIX = /^(?:i'?ll|i\s+will|i\s+need\s+to|i\s+should|i\s+owe|i\s+have\s+to|i\s+must|me\s*[:\-–]|todo\b\s*[:\-–]?|to-?do\s*[:\-–]|action(?:\s+item)?\s*[:\-–])\s*/i;
const OPEN_BOX = /^\s*(?:\[\s?\]|☐)\s*/;
const AT_OWNER = /^@([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*)?)\s*[:\-–]?\s+(.+)$/u;
const ARROW_OWNER = /^(.+?)\s*(?:→|->|=>)\s*@?([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*)?)\s*$/u;
const BULLET = /^\s*(?:[-*•▪◦–]|\d+[.)])\s*/;

function cap(s: string): string {
  const t = s.trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function known(name: string, knownNames: string[]): boolean {
  const n = name.trim().toLowerCase();
  return knownNames.some((k) => k.trim().toLowerCase() === n);
}

/** One line read outside a Next Steps section: an action, or null. */
function looseAction(raw: string, checked: boolean | null, knownNames: string[], me: string): ParsedAction | null {
  let line = raw.replace(BULLET, '').trim();
  const boxed = OPEN_BOX.test(line) || checked === false;
  line = line.replace(OPEN_BOX, '').trim();

  let m = MINE_PREFIX.exec(line);
  if (m) {
    const rest = line.slice(m[0].length).trim();
    return EMPTY_PROMPT.test(rest) ? null : { owners: [me], text: cap(rest) };
  }
  m = AT_OWNER.exec(line);
  if (m) {
    // "@Sarah Chen send…" vs "@Sarah share…": prefer the two-word name only
    // when it's someone we know.
    const words = line.slice(1).split(/\s+/);
    for (const n of [2, 1]) {
      const name = words
        .slice(0, n)
        .join(' ')
        .replace(/[:\-–,]+$/, '');
      if (words.length > n && known(name, knownNames)) {
        const rest = words
          .slice(n)
          .join(' ')
          .replace(/^[:\-–]\s*/, '');
        return EMPTY_PROMPT.test(rest) ? null : { owners: [name], text: cap(rest) };
      }
    }
  }
  m = ARROW_OWNER.exec(line);
  if (m && known(m[2], knownNames)) return { owners: [m[2]], text: cap(m[1]) };

  const p = parseActionLine(line, knownNames);
  if (p && p.owners.length && p.owners.every((o) => known(o, knownNames))) {
    return EMPTY_PROMPT.test(p.text) ? null : p;
  }
  if (boxed && line.length >= 3) return { owners: p?.owners.length && p.owners.every((o) => known(o, knownNames)) ? p.owners : [me], text: cap(p?.text ?? line) };
  return null;
}

/** Every next step in a note. `me` is the owner used for "I'll …" lines
 * (Mike's first configured name). */
export function scanNoteActions(lines: NoteLine[], knownNames: string[], me: string): ParsedAction[] {
  const out: ParsedAction[] = [];
  const seen = new Set<string>();
  let inActions = false;
  let inDecisions = false;
  for (const l of lines) {
    if (l.heading || (l.text.length <= 40 && /:$/.test(l.text) && (ACTION_HEADING.test(l.text) || OTHER_HEADING_SKIP.test(l.text)))) {
      const t = l.text.replace(/:$/, '').trim();
      inActions = ACTION_HEADING.test(t);
      inDecisions = OTHER_HEADING_SKIP.test(t);
      continue;
    }
    if (l.checked === true) continue;
    // A tip line from the template, if Mike left it.
    if (/^tip:/i.test(l.text)) continue;
    let a: ParsedAction | null = null;
    if (inActions) {
      a = looseAction(l.text, l.checked, knownNames, me);
      if (!a) {
        const p = parseActionLine(l.text.replace(OPEN_BOX, ''), knownNames);
        if (p && !EMPTY_PROMPT.test(p.text)) {
          // Owners the parser found that aren't people we know ("Budget",
          // "The team") → treat the whole line as Mike's.
          a = p.owners.length && p.owners.every((o) => known(o, knownNames)) ? p : { owners: [me], text: cap(l.text.replace(BULLET, '').replace(OPEN_BOX, '')) };
          if (a.owners.length && known(a.owners[0], knownNames) && EMPTY_PROMPT.test(a.text)) a = null;
        }
      }
    } else if (!inDecisions) {
      a = looseAction(l.text, l.checked, knownNames, me);
    }
    if (!a || a.text.length < 2) continue;
    const key = `${a.owners.map((o) => o.toLowerCase()).join(',')}|${a.text.toLowerCase().replace(/\W+/g, ' ').trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The template a new meeting note starts from
// ---------------------------------------------------------------------------

const p = (text?: string, marks?: unknown[]) => ({ type: 'paragraph', attrs: { textAlign: null }, ...(text ? { content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] } : {}) });
const h2 = (text: string) => ({ type: 'heading', attrs: { level: 2, textAlign: null }, content: [{ type: 'text', text }] });
const li = (text: string) => ({ type: 'listItem', content: [p(text)] });

export const TEMPLATE_TIP = 'Tip: write "Name will …" anywhere in this note — after the meeting it becomes a task for you or a follow-up on them.';

/** Notes / Decisions / Next Steps, with a "<First> will …" line per person. */
export function meetingNoteTemplate(meFirst: string, peopleFirst: string[], tip: boolean): string {
  const names = [meFirst, ...peopleFirst.filter((n) => n.toLowerCase() !== meFirst.toLowerCase())].slice(0, 8);
  const content: unknown[] = [];
  if (tip) content.push(p(TEMPLATE_TIP, [{ type: 'italic' }]));
  content.push(h2('Notes'), { type: 'bulletList', content: [li('')] }, h2('Decisions'), { type: 'bulletList', content: [li('')] }, h2('Next Steps'));
  content.push({ type: 'bulletList', content: names.map((n) => li(`${n} will …`)) });
  return JSON.stringify({ type: 'doc', content });
}

/** "Elliott Smith" → "Elliott"; "Dr. Jane Roe" → "Jane". */
export function firstName(full: string): string {
  const parts = full
    .trim()
    .split(/\s+/)
    .filter((x) => !/^(dr|mr|mrs|ms|prof)\.?$/i.test(x));
  return parts[0] ?? full.trim();
}
