import type { SsaEarningsRow, SsaLayout, SsaStatement } from './types';

/** Rule-based reader for "Your Social Security Statement" PDFs downloaded
 * from my Social Security (no AI), working on pdf.js text
 * (statements/pdfText.ts). Three online layouts so far:
 *   classic   2016 → Apr 2021  "your payment would be about … $ 2,854 a month" (62 / FRA / 70)
 *   chart2021 Sep 2021         "Personalized Retirement Benefit Estimates" chart 62–70
 *   chart     2022 → today     "Personalized Monthly Retirement Benefit Estimates" chart 62–70
 * The 2009–2010 mailed statements are image-only scans → "No text" (Claude
 * reads those once and drops a JSON in the folder; see ssa/drive.ts). A
 * layout SSA hasn't used yet throws with the reason, and the file shows
 * "Not read yet" on the page. Output still goes through cleanStatement. */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const num = (s: string | undefined | null): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function longDate(m: RegExpExecArray | null, mi = 1): string | null {
  if (!m) return null;
  const i = MONTHS.indexOf(m[mi].slice(0, 3).toLowerCase());
  if (i < 0) return null;
  return `${m[mi + 2]}-${String(i + 1).padStart(2, '0')}-${m[mi + 1].padStart(2, '0')}`;
}

/** "SSA - 2026.04.13.pdf" → 2026-04-13 (Mike's naming). */
export function dateFromFileName(name: string): string | null {
  const m = /(\d{4})[.\-_](\d{2})[.\-_](\d{2})/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function detectLayout(text: string): SsaLayout | null {
  if (/Personalized Monthly Retirement Benefit Estimates/i.test(text)) return 'chart';
  if (/Personalized Retirement Benefit Estimates/i.test(text)) return 'chart2021';
  if (/full retirement age \(\d{2}(?: and \d+ months)? years\), your payment would be about/i.test(text)) return 'classic';
  return null;
}

/** Dollar amount after a label, across dotted leaders / colons / line breaks. */
function after(text: string, label: RegExp): number | null {
  const re = new RegExp(`${label.source}[\\s.:…]*\\$\\s?([\\d,]+)`, 'i');
  return num(re.exec(text)?.[1]);
}

function earningsRows(text: string): SsaEarningsRow[] {
  const start = text.search(/Earnings Record/i);
  if (start < 0) return [];
  const rest = text.slice(start);
  const end = rest.search(/Taxes Paid|Total Social Security and Medicare taxes|Estimated taxes paid/i);
  const block = end > 0 ? rest.slice(0, end) : rest;
  const rows: SsaEarningsRow[] = [];
  for (const line of block.split('\n')) {
    const m = /^(\d{4})(?:\s*-\s*(\d{4}))?\s+\$?\s?([\d,]+)\s+\$?\s?([\d,]+)\s*$/.exec(line.trim());
    if (!m) continue;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1937 || to < from || to > 2100) continue;
    rows.push({ from, to, ss: num(m[3]) ?? 0, medicare: num(m[4]) ?? 0 });
  }
  return rows;
}

export interface ParsedSsaPdf {
  statement: Omit<SsaStatement, 'file_id' | 'file_name'>;
  /** Things that looked off (shown on the Statements list; the statement is still stored). */
  issues: string[];
}

export function parseSsaPdf(text: string, fileName: string): ParsedSsaPdf {
  if (text.replace(/\s/g, '').length < 200) throw new Error('No text — a scanned paper statement (ask Claude to read it)');
  if (!/Social Security Statement/i.test(text)) throw new Error("Doesn't look like a Social Security Statement");
  const layout = detectLayout(text);
  if (!layout) throw new Error('New statement layout — MikeOS doesn\'t know this one yet (ask Claude to read it)');
  const issues: string[] = [];

  const dateRe = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})/;
  const statementDate = longDate(dateRe.exec(text)) ?? dateFromFileName(fileName);
  if (!statementDate) throw new Error('No statement date found');
  const fileDate = dateFromFileName(fileName);
  if (fileDate && fileDate !== statementDate) issues.push(`File name says ${fileDate}, the statement says ${statementDate}`);

  const dobM = /date\s+of\s+birth[^]{0,140}?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})/i.exec(text);
  const birthDate = longDate(dobM);
  const fra = num(/full retirement age (?:is|\()\s*(\d{2})/i.exec(text)?.[1]);

  const retirement: Record<string, number> = {};
  if (layout === 'classic') {
    const fraAmt = after(text, /full retirement age \(\d{2}(?: and \d+ months)? years\), your payment would be about/);
    const a70 = after(text, /age 70, your payment would be about/);
    const a62 = after(text, /age 62, your payment would be about/);
    if (fraAmt != null && fra) retirement[String(fra)] = fraAmt;
    if (a70 != null) retirement['70'] = a70;
    if (a62 != null) retirement['62'] = a62;
  } else {
    const chartStart = text.search(/Personalized (?:Monthly )?Retirement Benefit Estimates/i);
    for (const line of text.slice(chartStart).split('\n').slice(0, 40)) {
      const m = /^(6[2-9]|70)\s+\$([\d,]+)\s*$/.exec(line.trim());
      if (m && retirement[m[1]] == null) retirement[m[1]] = num(m[2])!;
    }
    if (Object.keys(retirement).length !== 9) issues.push(`Benefit chart has ${Object.keys(retirement).length} of 9 ages`);
  }
  if (!fra || retirement[String(fra)] == null) throw new Error('No full-retirement-age estimate found');

  const assumed = num(/continue to earn\s*\$([\d,]+)/i.exec(text)?.[1]) ?? after(text, /taxable earnings per year after \d{4}/);

  const disIdx = text.search(/\bDisability\b/);
  const disability = disIdx >= 0 ? num(/would\s+be\s+about[\s.]*\$\s?([\d,]+)/i.exec(text.slice(disIdx))?.[1]) : null;

  const survivors = {
    child: after(text, /(?:Minor child|Your child)/),
    spouse_caring: after(text, /(?:younger than age 16|who is caring for your child)/),
    spouse_fra: after(text, /(?:Spouse, if benefits start at|Your spouse, if benefits start at|spouse who reaches) full retirement age/),
    family_max: after(text, /Total family benefits cannot be more than/),
  };
  const death = num(/death benefit of\s*\$([\d,]+)/i.exec(text)?.[1]);

  const earnings = earningsRows(text);
  if (earnings.length < 3) throw new Error(`Earnings record not found (${earnings.length} rows)`);

  const youPaid = [...text.matchAll(/You paid:?[\s.]*\$\s?([\d,]+)/gi)].map((m) => num(m[1]));
  const employerPaid = [...text.matchAll(/(?:Your employers paid|Employer\(s\)(?: paid)?):?[\s.]*\$\s?([\d,]+)/gi)].map((m) => num(m[1]));
  const taxes = { ss_you: youPaid[0] ?? null, medicare_you: youPaid[1] ?? null, ss_employer: employerPaid[0] ?? null, medicare_employer: employerPaid[1] ?? null };
  if (youPaid.length !== 2 || employerPaid.length !== 2) issues.push('Taxes Paid section not fully read');

  let trust: { year: number; pct: number } | null = null;
  const tfClassic = /by\s+(\d{4}),\s+the\s+payroll\s+taxes\s+collected\s+will\s+be\s+enough\s+to\s+pay\s+only\s+about\s+(\d{2})\s+percent/i.exec(text);
  const tfChart = /until\s+(\d{4})\.\s+In\s+\d{4},\s+Social\s+Security\s+would\s+still\s+be\s+able\s+to\s+pay\s+about\s+\$(\d{3})\s+for/i.exec(text);
  if (tfClassic) trust = { year: Number(tfClassic[1]), pct: Number(tfClassic[2]) };
  else if (tfChart) trust = { year: Number(tfChart[1]), pct: Math.round(Number(tfChart[2]) / 10) };

  return {
    statement: {
      id: statementDate,
      statement_date: statementDate,
      layout,
      birth_date: birthDate,
      fra_years: fra,
      retirement,
      age62_stop_now: false,
      assumed_earnings: assumed,
      disability,
      survivors,
      death_benefit: death,
      earnings,
      taxes,
      trust_fund: trust,
      notes: null,
    },
    issues,
  };
}
