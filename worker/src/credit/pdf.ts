import type { Bureau, CreditAccount, CreditInquiry } from './types';

/** Rule-based readers for the CURRENT (2025–2026) AnnualCreditReport layouts
 * of Equifax, Experian and TransUnion, working on pdf.js text
 * (statements/pdfText.ts). No AI. The bureaus change layouts every year or
 * two — when a reader can't find what it expects it returns an error and the
 * file shows "Not read yet" on the page (Claude reads it and drops a JSON in
 * the folder instead; see credit/drive.ts). Output is the import shape —
 * it still goes through cleanReport before it is stored. */

export interface ParsedCreditPdf {
  report: Record<string, unknown>;
  /** Report printed its own account count and ours differs. */
  mismatch: string | null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON3 = MONTHS.map((m) => m.slice(0, 3));

/** "YYYY.MM.DD - Bureau.pdf" → { date, bureau } (Mike's naming). */
export function parseReportFileName(name: string): { date: string | null; bureau: Bureau | null } {
  const m = /^(\d{4})[.\-_](\d{2})[.\-_](\d{2})\s*[-–—]\s*(.+?)\.(pdf|json)$/i.exec(name.trim());
  if (!m) return { date: null, bureau: null };
  const b = m[4].toLowerCase().replace(/\s+/g, '');
  const bureau: Bureau | null = b.startsWith('equifax') ? 'equifax' : b.startsWith('experian') ? 'experian' : b.startsWith('transunion') ? 'transunion' : null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, bureau };
}

export function detectBureau(text: string): Bureau | null {
  const head = text.slice(0, 6000);
  if (/EFX-ACR|Equifax Credit Report|888-EQUIFAX/i.test(head)) return 'equifax';
  if (/usa\.experian\.com|Annual Credit Report - Experian/i.test(head)) return 'experian';
  if (/transunion\.com|TransUnion/i.test(head)) return 'transunion';
  return null;
}

const mdy = (s: string | undefined | null): string | null => {
  const m = s ? /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s) : null;
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
const money = (s: string | undefined | null): number | null => {
  const m = s ? /\$\s?([\d,]+)/.exec(s) : null;
  return m ? Number(m[1].replace(/,/g, '')) : null;
};
/** "Feb 2026" / "February 2026" → "2026-02". */
const monthYear = (s: string | undefined | null): string | null => {
  const m = s ? /([A-Za-z]{3,9})\.?\s+(\d{4})/.exec(s) : null;
  if (!m) return null;
  const i = MON3.indexOf(m[1].slice(0, 3).toLowerCase());
  return i >= 0 ? `${m[2]}-${String(i + 1).padStart(2, '0')}` : null;
};
const longDate = (s: string | undefined | null): string | null => {
  const m = s ? /([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})/.exec(s) : null;
  if (!m) return null;
  const i = MON3.indexOf(m[1].slice(0, 3).toLowerCase());
  return i >= 0 ? `${m[3]}-${String(i + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};

/** Account type text → schema type + kind. */
function classify(text: string): { type: CreditAccount['type']; kind: string } {
  const t = text.toLowerCase();
  if (/mortgage|real estate/.test(t)) return { type: 'mortgage', kind: 'mortgage' };
  if (/home equity|heloc/.test(t)) return { type: 'revolving', kind: 'heloc' };
  if (/auto|automobile|vehicle|lease/.test(t)) return { type: 'installment', kind: 'auto' };
  if (/student|education/.test(t)) return { type: 'installment', kind: 'student' };
  if (/collection/.test(t)) return { type: 'other', kind: 'collection' };
  if (/charge account|charge card/.test(t)) return { type: 'revolving', kind: 'charge_card' };
  if (/credit card|flexible spending|revolving|line of credit/.test(t)) return { type: 'revolving', kind: 'credit_card' };
  if (/installment|personal|unsecured|secured loan/.test(t)) return { type: 'installment', kind: 'personal' };
  return { type: null, kind: 'other' };
}

/** Status text → status + late counts (from words like "30 days past due"). */
function statusOf(text: string, closedDate: string | null): { status: CreditAccount['status']; late: CreditAccount['late_counts'] } {
  const t = text.toLowerCase();
  const late = { '30': 0, '60': 0, '90': 0, '120': 0 };
  for (const m of t.matchAll(/(\d{2,3})\s*days?\s*(?:past due|late|delinquent)/g)) {
    const d = Number(m[1]);
    if (d >= 120) late['120']++;
    else if (d >= 90) late['90']++;
    else if (d >= 60) late['60']++;
    else if (d >= 30) late['30']++;
  }
  const status: CreditAccount['status'] = /transferred/.test(t)
    ? 'transferred'
    : /charge(d)?[ -]?off/.test(t)
      ? 'charged_off'
      : /collection/.test(t)
        ? 'collection'
        : /paid/.test(t) && (closedDate || /closed/.test(t))
          ? 'paid'
          : closedDate || /closed/.test(t)
            ? 'closed'
            : 'open';
  return { status, late };
}

function blankAccount(): CreditAccount {
  return {
    creditor: '',
    last4: null,
    type: null,
    kind: 'other',
    owner: null,
    status: null,
    status_text: null,
    opened: null,
    closed: null,
    last_reported: null,
    limit: null,
    high_balance: null,
    balance: null,
    monthly_payment: null,
    past_due: null,
    terms: null,
    late_counts: { '30': 0, '60': 0, '90': 0, '120': 0 },
    late_months: [],
    history_from: null,
    remarks: [],
  };
}

const owner = (s: string | undefined | null): CreditAccount['owner'] => {
  const t = (s ?? '').toLowerCase();
  return /authori[sz]ed/.test(t) ? 'authorized_user' : /joint/.test(t) ? 'joint' : /individual/.test(t) ? 'individual' : null;
};
const field = (block: string, label: string): string | null => {
  const re = new RegExp(`^${label.replace(/[()/]/g, '\\$&')}[ :]+(.*)$`, 'm');
  const m = re.exec(block);
  return m ? m[1].trim() || null : null;
};

/** Drop page furniture lines that pdf.js interleaves everywhere. */
function cleanLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => !/^https?:\/\//.test(l) && !/^\d{1,2}\/\d{1,2}\/\d{2}, \d{1,2}:\d{2} [AP]M Annual Credit Report/.test(l) && !/^0{6,}\d*-DISC Page/.test(l));
}

// ── Equifax ──────────────────────────────────────────────────────────────
function parseEquifax(lines: string[]) {
  const text = lines.join('\n');
  const accounts: CreditAccount[] = [];
  // Each account starts on its own page: the creditor is the first line after
  // the page header ("Confirmation # …") or the section intro.
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (/Date Reported: [\d/]+ \| Balance:/.test(l)) starts.push(i);
  });
  const nameIdx = starts.map((i) => {
    for (let j = i; j > Math.max(0, i - 8); j--) if (/^Confirmation #|lines of credit\.$/.test(lines[j - 1] ?? '')) return j;
    return i - 1;
  });
  const endAt = (k: number) => (k + 1 < starts.length ? nameIdx[k + 1] : lines.findIndex((l, i) => i > starts[k] && /^Inquiries$/.test(l)));
  starts.forEach((s, k) => {
    const end = endAt(k);
    const block = lines.slice(nameIdx[k], end > s ? end : s + 40).join('\n');
    const a = blankAccount();
    a.creditor = lines[nameIdx[k]]
      .replace(/\s+Date Reported:.*$/, '')
      .replace(/\s+-\s+Closed$/i, '')
      .trim();
    const dr = /Date Reported: ([\d/]+) \| Balance: (\$[\d,]+)?/.exec(block);
    a.last_reported = mdy(dr?.[1]);
    a.balance = money(dr?.[2]);
    a.last4 = /Account Number: \*?[\dX*]*?(\d{4})\b/.exec(block)?.[1] ?? null;
    a.owner = owner(/Owner: ([A-Za-z ]+?)(?: Account|\s+Credit Limit|$)/m.exec(block)?.[1]);
    a.limit = money(/Credit Limit: (\$[\d,]+)/.exec(block)?.[1]);
    a.high_balance = money(/High Credit: (\$[\d,]+)/.exec(block)?.[1]);
    const lt = /Loan\/Account Type: (.*?) \| Status: (.*)$/m.exec(block);
    Object.assign(a, classify(lt?.[1] ?? ''));
    a.opened = mdy(/Date Opened: ([\d/]+)/.exec(block)?.[1]);
    a.closed = mdy(/Date Closed: ([\d/]+)/.exec(block)?.[1]);
    a.monthly_payment = money(/Scheduled Payment Amount: (\$[\d,]+)/.exec(block)?.[1]);
    a.past_due = money(/Amount Past Due: (\$[\d,]+)/.exec(block)?.[1]);
    a.terms = /Term Duration: (\d+ \w+)/.exec(block)?.[1] ?? null;
    a.status_text = lt?.[2]?.trim() ?? null;
    const st = statusOf(a.status_text ?? '', a.closed);
    a.status = st.status;
    a.late_counts = st.late;
    accounts.push(a);
  });

  // Inquiries: NAME / address / Phone: … / "Hard|Soft mm/dd/yyyy, …" (+ wrapped date lines).
  const inquiries: CreditInquiry[] = [];
  let pending: string[] = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^Company Information Inquiry Type Inquiry Date\(s\)/.test(l)) {
      inSection = true;
      pending = [];
      continue;
    }
    if (!inSection) continue;
    if (/^(Prepared for:|Date: |Confirmation #|Inquiries$|A request for your credit|rating\/score|l (Hard|Soft) Inquiries|you've applied|promotional offers|file\.)/.test(l)) {
      if (/^Prepared for:/.test(l)) pending = [];
      continue;
    }
    const m = /^(Hard|Soft) (\d{2}\/\d{2}\/\d{4}.*)$/.exec(l);
    if (m) {
      let dates = m[2];
      while (i + 1 < lines.length && /^[\d/, ]+$/.test(lines[i + 1])) dates += ` ${lines[++i]}`;
      const name = pending[0] ?? 'Unknown';
      for (const d of dates.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []) inquiries.push({ name, date: mdy(d), type: m[1] === 'Hard' ? 'hard' : 'soft' });
      pending = [];
      continue;
    }
    if (/^(Summary|Public Records|Collections|Consumer Statements|Your Rights|A Summary of Your Rights)/.test(l)) inSection = false;
    pending.push(l);
  }

  // Personal: current address line + Former Address(es) until Consumer Statement.
  const addresses: { address: string; reported: string | null; current: boolean }[] = [];
  const cur = lines.find((l) => /^\d+[A-Z]? .+, [A-Z]{2} \d{5}/.test(l));
  if (cur) addresses.push({ address: cur.replace(/\s*\|.*$/, ''), reported: null, current: true });
  const fi = lines.findIndex((l) => /^Former Address\(es\):/.test(l));
  if (fi >= 0) {
    let buf = '';
    for (let i = fi + 1; i < lines.length && !/^Consumer Statement/.test(lines[i]); i++) {
      const l = lines[i];
      if (/^\(\d{3}\) \d{3}-\d{4}$/.test(l)) continue;
      buf = buf ? `${buf} ${l}` : l;
      if (/[A-Z]{2} \d{5}(-\d{4})?$/.test(buf)) {
        addresses.push({ address: buf, reported: null, current: false });
        buf = '';
      }
    }
  }
  const name = lines[lines.findIndex((l) => /^Prepared for:/.test(l)) + 1] ?? null;
  return {
    printedDate: longDate(/Report Date ([A-Za-z]+ \d{1,2}, \d{4})/.exec(text)?.[1]) ?? longDate(/Date: ([A-Za-z]+ \d{1,2}, \d{4})/.exec(text)?.[1]),
    accounts,
    inquiries,
    names: name ? [name] : [],
    addresses,
    employers: [] as { name: string; reported: string | null }[],
    printedCount: null as number | null,
    printedHard: null as number | null,
    noPublicRecords: true,
  };
}

// ── Experian ─────────────────────────────────────────────────────────────
function parseExperian(lines: string[]) {
  const text = lines.join('\n');
  const accounts: CreditAccount[] = [];
  const starts = lines.map((l, i) => (l === 'Account Info' && /^Account Name /.test(lines[i + 1] ?? '') ? i : -1)).filter((i) => i >= 0);
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.findIndex((l, i) => i > s && /^Hard Inquiries$/.test(l));
    const block = lines.slice(s, end > s ? end : s + 60).join('\n');
    const a = blankAccount();
    a.creditor = field(block, 'Account Name') ?? 'Unknown';
    const num = field(block, 'Account Number') ?? '';
    // Experian prints most numbers masked at the END ("XXXX"); keep the last 4 only when they are digits.
    a.last4 = /(\d{4})$/.exec(num.replace(/\s/g, ''))?.[1] ?? null;
    Object.assign(a, classify(field(block, 'Account Type') ?? ''));
    a.owner = owner(field(block, 'Responsibility'));
    a.opened = mdy(field(block, 'Date Opened'));
    a.status_text = field(block, 'Status');
    const updated = monthYear(field(block, 'Status Updated'));
    const closedish = /closed|paid|transferred/i.test(a.status_text ?? '');
    a.closed = closedish ? updated : null;
    a.balance = money(/^Balance (\$[\d,]+)/m.exec(block)?.[1]);
    a.last_reported = mdy(field(block, 'Balance Updated'));
    a.monthly_payment = money(field(block, 'Monthly Payment'));
    a.limit = money(field(block, 'Credit Limit'));
    a.high_balance = money(field(block, 'Original Balance')) ?? money(field(block, 'Highest Balance'));
    const terms = field(block, 'Terms');
    a.terms = terms && terms !== '-' ? terms : null;
    const st = statusOf(a.status_text ?? '', a.closed);
    a.status = st.status;
    a.late_counts = st.late;
    accounts.push(a);
  });

  // Inquiries: hard ones carry "This inquiry is scheduled to continue on record";
  // soft ones sit in a 3-column grid that pdf.js scrambles — best effort.
  const inquiries: CreditInquiry[] = [];
  const hi = lines.findIndex((l) => /^Hard Inquiries$/.test(l));
  if (hi >= 0) {
    const tail = lines.slice(hi);
    for (let i = 0; i < tail.length; i++) {
      if (!/^Inquired on/.test(tail[i])) continue;
      let dates = tail[i].replace(/^Inquired on/, '');
      let j = i + 1;
      while (j < tail.length && /^[\d/ ,]+(an)?$|^d [\d/]+$|^and [\d/]+/.test(tail[j])) dates += ` ${tail[j++]}`;
      dates = dates.replace(/an\s*\n?\s*d/g, ',');
      let next = tail.findIndex((l, x) => x > i && /^Inquired on/.test(l));
      if (next < 0) next = tail.length;
      const window = tail.slice(i, Math.min(next, i + 14)).join(' ');
      const hard = /scheduled to\s+continue on\s+record/.test(window);
      // Name = up to two lines above that aren't address/phone/date furniture.
      const nameParts: string[] = [];
      for (let b = i - 1; b >= Math.max(0, i - 4) && nameParts.length < 3; b--) {
        const l = tail[b];
        if (!l || /\d{5}|^\(\d{3}\)|^PO BOX|^P\.?O\.? |record|^until |^Unspecified|^scheduled|^inquiry is|^Soft Inquiries|^Hard Inquiries|credit report|,$/i.test(l) || l.length > 40) break;
        nameParts.unshift(l);
      }
      // Wrapped names: a 1–2 letter tail ("CONSOLIDATE" + "D") or a long unspaced first part joins without a space.
      const name = nameParts.reduce((acc, part) => (!acc ? part : part.length <= 2 || (!acc.includes(' ') && acc.length >= 10) ? acc + part : `${acc} ${part}`), '');
      for (const d of dates.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []) inquiries.push({ name: name || 'Unknown', date: mdy(d), type: hard ? 'hard' : 'soft' });
      i = j - 1;
    }
  }

  // Names (blocks ending "Name ID #"), addresses (blocks ending "Address ID").
  const names: string[] = [];
  const addresses: { address: string; reported: string | null; current: boolean }[] = [];
  const ni = lines.findIndex((l) => l === 'Names');
  const ai = lines.findIndex((l) => l === 'Addresses');
  if (ni >= 0 && ai > ni) {
    let buf: string[] = [];
    for (const l of lines.slice(ni + 1, ai)) {
      if (/^Name ID #/.test(l)) {
        if (buf.length) names.push(buf.join(' '));
        buf = [];
      } else buf.push(l);
    }
  }
  if (ai >= 0) {
    let buf: string[] = [];
    for (let i = ai + 1; i < lines.length && !/^(Year of Birth|Phone Numbers|Accounts|Spouse)/.test(lines[i]); i++) {
      const l = lines[i];
      if (/^Address ID$/.test(l)) {
        if (buf.length) addresses.push({ address: buf.join(' ').replace(/\s+,/g, ','), reported: null, current: addresses.length === 0 });
        buf = [];
        i++; // the "#0020…" id line
        continue;
      }
      if (/^(Single family|Apartment|complex|Multi-family|Mobile home|Business|Rural route|Post office box|Unknown)$/i.test(l)) continue;
      buf.push(l);
    }
  }
  const glance = /(\d+) Accounts (\d+) Public Records (\d+) Hard Inquiries/.exec(text);
  return {
    printedDate: longDate(/Date Generated ([A-Za-z]+ \d{1,2}, \d{4})/.exec(text)?.[1]),
    accounts,
    inquiries,
    names,
    addresses,
    employers: [] as { name: string; reported: string | null }[],
    printedCount: glance ? Number(glance[1]) : null,
    printedHard: glance ? Number(glance[3]) : null,
    noPublicRecords: !glance || glance[2] === '0',
  };
}

// ── TransUnion ───────────────────────────────────────────────────────────
function parseTransUnion(lines: string[]) {
  const text = lines.join('\n');
  const accounts: CreditAccount[] = [];
  const starts = lines.map((l, i) => (l === 'Account Information' ? i : -1)).filter((i) => i >= 0);
  const inqStart = lines.findIndex((l) => /^Regular Inquiries$/.test(l));
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] - 1 : inqStart > s ? inqStart : s + 400;
    const block = lines.slice(s, end).join('\n');
    const a = blankAccount();
    // The line above "Account Information" is "NAME 349992724274****" (sometimes a section header sits between).
    let nl = s - 1;
    while (nl > 0 && /^(Satisfactory Accounts|Adverse Accounts|Account Name|Closed Accounts)$/.test(lines[nl])) nl--;
    a.creditor = lines[nl].replace(/\s+\S*\*{2,}\S*$/, '').trim();
    a.monthly_payment = money(field(block, 'Monthly Payment'));
    a.opened = mdy(field(block, 'Date Opened'));
    a.closed = mdy(field(block, 'Date Closed'));
    a.owner = owner(field(block, 'Responsibility'));
    const acctType = field(block, 'Account Type') ?? '';
    const loanType = field(block, 'Loan Type') ?? '';
    Object.assign(a, classify(`${loanType} ${acctType}`));
    if (/revolving/i.test(acctType) && a.kind === 'other') a.kind = 'credit_card';
    a.balance = money(/^Balance (\$[\d,]+)/m.exec(block)?.[1]);
    a.last_reported = mdy(field(block, 'Date Updated'));
    a.past_due = money(field(block, 'Past Due'));
    a.terms = field(block, 'Terms');
    // "Credit limit of $12,000 from 08/2022 to 01/2025" — the LAST range is current.
    const lims = [...block.matchAll(/Credit limit of (\$[\d,]+)/g)].map((m) => money(m[1])!);
    a.limit = lims.length ? lims[lims.length - 1] : null;
    const highs = [...block.matchAll(/High balance of (\$[\d,]+)/gi)].map((m) => money(m[1])!);
    a.high_balance = money(field(block, 'Original Balance')) ?? money(field(block, 'High Balance')) ?? (highs.length ? Math.max(...highs) : null);
    const pay = field(block, 'Pay Status') ?? '';
    const remarks = [...block.matchAll(/^Remarks (.+)$/gm)].map((m) => m[1].trim()).filter((r) => r && r !== '-');
    a.remarks = remarks;
    a.status_text = pay || null;
    const st = statusOf(`${pay} ${remarks.join(' ')}`, a.closed);
    a.status = st.status;
    // Payment history grid: "<Month> <Year>" then a status cell (OK / 30 / 60 …).
    const blockLines = lines.slice(s, end);
    const lateMonths: { month: string; days: number }[] = [];
    let first: string | null = null;
    for (let i = 0; i < blockLines.length; i++) {
      const mm = /^([A-Z] ?[a-z ]+?) (\d{4})$/.exec(blockLines[i]);
      if (!mm) continue;
      const mi = MONTHS.indexOf(mm[1].replace(/\s+/g, '').toLowerCase());
      if (mi < 0) continue;
      const month = `${mm[2]}-${String(mi + 1).padStart(2, '0')}`;
      if (!first || month < first) first = month;
      for (let j = i + 1; j < Math.min(blockLines.length, i + 6); j++) {
        const cell = blockLines[j].trim();
        if (/^- - -$/.test(cell)) continue;
        const n = /^(30|60|90|120|150|180)$/.exec(cell);
        if (n) lateMonths.push({ month, days: Number(n[1]) });
        break;
      }
    }
    a.late_months = lateMonths;
    a.history_from = first;
    const counts = { '30': 0, '60': 0, '90': 0, '120': 0 };
    for (const l of lateMonths) counts[l.days >= 120 ? '120' : (String(l.days) as '30' | '60' | '90')]++;
    a.late_counts = lateMonths.length ? counts : st.late;
    accounts.push(a);
  });

  // Inquiries: NAME / Location / … / Requested On / dates / Phone / … [/ Inquiry Type] —
  // only regular (hard) inquiries carry an "Inquiry Type" line.
  const inquiries: CreditInquiry[] = [];
  if (inqStart >= 0) {
    for (let i = inqStart; i < lines.length; i++) {
      if (lines[i] !== 'Requested On') continue;
      let j = i + 1;
      let dates = '';
      while (j < lines.length && /^[\d/ ,]+$/.test(lines[j])) dates += ` ${lines[j++]}`;
      let n = i - 1;
      while (n > 0 && lines[n] !== 'Location') n--;
      const name = lines[n - 1] ?? 'Unknown';
      const after = lines.slice(j, j + 5).join('\n');
      const hard = /Inquiry Type/.test(after);
      for (const d of dates.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []) inquiries.push({ name, date: mdy(d), type: hard ? 'hard' : 'soft' });
      i = j - 1;
    }
  }
  return {
    printedDate: mdy(/(?:Report Date|Date Created|File Date)[: ]+([\d/]+)/.exec(text)?.[1]),
    accounts,
    inquiries,
    names: [] as string[],
    addresses: [] as { address: string; reported: string | null; current: boolean }[],
    employers: [] as { name: string; reported: string | null }[],
    printedCount: null as number | null,
    printedHard: null as number | null,
    noPublicRecords: true,
  };
}

/** Read one report PDF's text. Throws with a short reason when the layout isn't recognized. */
export function parseCreditPdf(text: string, fileName: string, fileId: string | null = null): ParsedCreditPdf {
  const lines = cleanLines(text);
  if (lines.join('').replace(/\s/g, '').length < 2000) throw new Error('No text in this PDF (a scan or image) — needs Claude to read it');
  const fromName = parseReportFileName(fileName);
  const bureau = detectBureau(text) ?? fromName.bureau;
  if (!bureau || bureau === 'other') throw new Error('Not an Equifax, Experian or TransUnion report layout MikeOS knows');
  const p = bureau === 'equifax' ? parseEquifax(lines) : bureau === 'experian' ? parseExperian(lines) : parseTransUnion(lines);
  if (!p.accounts.length) throw new Error(`No accounts found — ${bureau} may have changed its layout`);
  const pulled = fromName.date ?? p.printedDate;
  if (!pulled) throw new Error('No report date in the file name or the report');
  const mismatch = p.printedCount !== null && p.printedCount !== p.accounts.length ? `Report lists ${p.printedCount} accounts; read ${p.accounts.length}` : null;
  const hard = p.inquiries.filter((q) => q.type === 'hard').length;
  const notes = [
    `Read automatically from the PDF by MikeOS (${bureau} layout reader).`,
    mismatch,
    p.printedHard !== null && p.printedHard !== hard ? `Report lists ${p.printedHard} hard inquiries; read ${hard}.` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    mismatch,
    report: {
      bureau,
      source: 'AnnualCreditReport.com',
      pulled_on: pulled,
      file_name: fileName,
      file_id: fileId,
      unreadable: false,
      partial: !!mismatch,
      scores: [],
      summary: { total_accounts: p.printedCount, hard_inquiries: p.printedHard },
      personal: { names: p.names, addresses: p.addresses, employers: p.employers },
      accounts: p.accounts,
      inquiries: p.inquiries,
      negatives: [],
      notes,
    },
  };
}
