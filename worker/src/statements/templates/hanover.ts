import { check, mdy, money, NotAStatement, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, StatementCheck } from '../common';

/** The Hanover Insurance Group — one Drive folder ("Hanover Insurance") holds
 * every Hanover PDF for the auto + home + umbrella bundle, so this template
 * reads four kinds of document (no AI — regexes over pdf.js text):
 *
 *  - **Billing notice** ("Payment schedule" / "Withdrawal schedule"): sent
 *    when Auto-Pay (EFT) starts or a change moves the amount. Statement date,
 *    the bank account's last 4, every scheduled withdrawal (total + a column
 *    per policy + the $2 installment fee) and Recent activity (endorsements,
 *    installment fees). Hanover sends no monthly bill on EFT.
 *  - **Auto declarations** (new term or amended): term, effective date,
 *    reason, total + per-vehicle premium, vehicles (VIN, annual mileage,
 *    additional insured = lease / loan company), liability / SUM / med pay /
 *    deductibles, the accident-prevention (defensive driving) discount.
 *  - **Homeowners declarations**: term, Coverages A–F, deductible, premium,
 *    mortgagee.
 *  - **Umbrella declarations**: term, limit, excess UM/UIM, premium (old →
 *    new on an amendment).
 *
 * Several documents share an effective date (an auto change and the
 * umbrella change it triggers), so the period key carries the document kind:
 * `2026-07-18:auto`, `2026-07-18:umbrella`, `2026-07-22:bill`. The first ten
 * characters are always the date. Anything else in the folder (ID cards on
 * their own, letters) is NotAStatement → Skipped. */

export type HanoverLine = 'auto' | 'home' | 'umbrella';

export interface HanoverScheduleRow {
  date: string;
  total: number;
  /** Amount per policy number ("A1S M123456" → 210.50). */
  parts: Record<string, number>;
}

export interface HanoverActivity {
  date: string;
  description: string;
  policy: string;
  effective: string;
  amount: number;
}

export interface HanoverBillValues {
  doc: 'bill';
  statementDate: string;
  customer: string | null;
  last4: string | null;
  /** Printed EFT enrollment / debit authorization → true; otherwise null. */
  autopay: boolean | null;
  policies: string[];
  installmentFee: number | null;
  schedule: HanoverScheduleRow[];
  activity: HanoverActivity[];
}

export interface HanoverVehicle {
  unit: string;
  year: number;
  make: string;
  model: string;
  vin: string;
  mileage: number | null;
  premium: number | null;
  additionalInsured: string | null;
  defensiveDiscount: number | null;
}

export interface HanoverPolicyValues {
  doc: 'policy';
  line: HanoverLine;
  policyNumber: string;
  termStart: string;
  termEnd: string;
  effective: string;
  /** "New Term" or the amendment reason, Title Cased ("Change Vehicle"). */
  reason: string;
  amended: boolean;
  premium: number;
  prevPremium: number | null;
  /** Auto */
  vehicles?: HanoverVehicle[];
  liabilityCsl?: number | null;
  sum?: number | null;
  medPay?: number | null;
  collisionDeductible?: number | null;
  comprehensiveDeductible?: number | null;
  fullGlass?: boolean;
  /** Home */
  dwelling?: number | null;
  otherStructures?: number | null;
  personalProperty?: number | null;
  lossOfUse?: string | null;
  personalLiability?: number | null;
  medPayOthers?: number | null;
  deductible?: number | null;
  mortgagee?: string | null;
  address?: string | null;
  /** Umbrella */
  limit?: number | null;
  excessUm?: number | null;
  retainedLimit?: number | null;
}

export type HanoverValues = HanoverBillValues | HanoverPolicyValues;

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bEv(\d)/g, 'EV$1')
    .replace(/\b(Bmw|Gmc|Llc|Na|Usa)\b/g, (m) => m.toUpperCase())
    .replace(/(?!^)\b(Of|And|The)\b/g, (m) => m.toLowerCase())
    .trim();

/** "09/21/26" → "2026-09-21". */
function mdyy(raw: string): string {
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `20${m[3]}-${m[1]}-${m[2]}`;
}

const dollars = (raw: string | undefined | null): number | null => {
  if (!raw) return null;
  const n = Number(raw.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const addYear = (iso: string) => `${Number(iso.slice(0, 4)) + 1}${iso.slice(4)}`;

export function parseHanover(text: string): ParsedStatement {
  if (!/HANOVER|ALLMERICA|MASSACHUSETTS BAY/i.test(text)) throw new NotAStatement('Not a Hanover document');
  if (/^(Payment|Withdrawal) schedule$/m.test(text) && /Statement date:/.test(text)) return parseBill(text);
  if (/TOTAL PREMIUM PER UNIT/.test(text)) return parseAuto(text);
  if (/H O M E O W N E R S P O L I C Y/.test(text)) return parseHome(text);
  if (/LIMIT OF LIABILITY EACH OCCURRENCE:/.test(text)) return parseUmbrella(text);
  throw new NotAStatement('No declarations page or payment schedule in this Hanover document');
}

// ---- Billing notice ----

function parseBill(text: string): ParsedStatement {
  const lines = text.split('\n').map((l) => l.trim());
  const dateM = text.match(/Statement date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (!dateM) throw new UnreadableStatement('No statement date');
  const statementDate = mdy(dateM[1]);
  const last4 = text.match(/(?:Bank account number|Payment Method):\s*\*+(\d{4})/)?.[1] ?? null;
  const customer = text.match(/Customer number:\s*([\d-]+)/)?.[1] ?? null;
  const feeM = text.match(/includes a \$([\d.]+) installment fee/);
  const installmentFee = feeM ? Number(feeM[1]) : null;
  const autopay = /electronic funds transfer \(EFT\)|authorized .{0,120}to\s+debit your/is.test(text) ? true : null;

  const start = lines.findIndex((l) => /^(Payment|Withdrawal) schedule$/.test(l));
  const policies: string[] = [];
  const schedule: HanoverScheduleRow[] = [];
  const checks: StatementCheck[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const row = l.match(/^(\d{1,2}\/\d{1,2}\/\d{4})((?:\s+\$[\d,]+\.\d{2})+)$/);
    if (row) {
      const amounts = row[2].trim().split(/\s+/).map(money);
      const [total, ...parts] = amounts;
      if (parts.length !== policies.length) throw new UnreadableStatement(`Schedule row ${row[1]} has ${parts.length} policy amounts for ${policies.length} policies`);
      const byPolicy: Record<string, number> = {};
      policies.forEach((p, k) => (byPolicy[p] = parts[k]));
      schedule.push({ date: mdy(row[1]), total, parts: byPolicy });
      // The first (down) payment carries no installment fee; later ones do.
      const sum = round2(parts.reduce((a, b) => a + b, 0));
      const fee = round2(total - sum);
      checks.push(check(`${row[1]} adds up`, Math.abs(fee) < 0.005 || Math.abs(fee - (installmentFee ?? 0)) < 0.005, `policies ${sum.toFixed(2)} + fee ${fee.toFixed(2)} vs ${total.toFixed(2)}`));
      continue;
    }
    if (schedule.length) break;
    const pol = l.match(/^([A-Z0-9]{3}) (M\d{6})$/);
    if (pol) policies.push(`${pol[1]} ${pol[2]}`);
  }
  if (!schedule.length) throw new UnreadableStatement('Payment schedule has no rows');
  checks.push(check('Policies in schedule header', policies.length > 0, `${policies.length} policies`));

  const activity: HanoverActivity[] = [];
  const actStart = lines.findIndex((l) => l === 'Recent activity');
  if (actStart >= 0) {
    for (let i = actStart + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(\d{1,2}\/\d{1,2}\/\d{4}) (.+?) ([A-Z0-9]{3} M\d{6}) (\d{1,2}\/\d{1,2}\/\d{4}) (\(?\$[\d,]+\.\d{2}\)?)$/);
      if (m) activity.push({ date: mdy(m[1]), description: m[2], policy: m[3], effective: mdy(m[4]), amount: money(m[5]) });
      else if (activity.length && !/^Activity date/.test(lines[i])) break;
    }
  }
  const values: HanoverBillValues = { doc: 'bill', statementDate, customer, last4, autopay, policies, installmentFee, schedule, activity };
  return { periodStart: statementDate, periodEnd: `${statementDate}:bill`, values: values as unknown as Record<string, unknown>, transactions: [], checks };
}

// ---- Auto declarations ----

function parseAuto(text: string): ParsedStatement {
  const lines = text.split('\n').map((l) => l.trim());
  const head = text.match(/(\d{2}\/\d{2}\/\d{2}) (\d{2}\/\d{2}\/\d{2}) ((?:A1S|[A-Z0-9]{3}) M\d{6})/);
  if (!head) throw new UnreadableStatement('No auto policy period');
  const termStart = mdyy(head[1]);
  const termEnd = mdyy(head[2]);
  const eff = text.match(/^EFFECTIVE (\d{2}\/\d{2}\/\d{2})$/m);
  const amended = /AMENDED DECLARATION/.test(text);
  const reasonRaw = text.match(/REASON FOR AMENDMENT: ([A-Z ]+)$/m)?.[1];
  const premM = text.match(/TOTAL POLICY PREMIUM \$ ?([\d,]+\.\d{2})/);
  if (!premM) throw new UnreadableStatement('No total policy premium');
  const premium = money(premM[1]);
  const prevPremium = dollars(text.match(/PREV PREMIUM \$([\d,]+\.\d{2})/)?.[1]);
  const unitPremiums = (text.match(/TOTAL PREMIUM PER UNIT \$ ?([\d. ,]+)$/m)?.[1] ?? '').trim().split(/\s+/).filter(Boolean).map((s) => Number(s.replace(/,/g, '')));

  // Vehicle lines: "002 NY ABC 26 MAKE MODEL 1HGCM82633A004352 12000" (sample VIN)
  const seen = new Set<string>();
  const vehicles: HanoverVehicle[] = [];
  for (const l of lines) {
    const m = l.match(/^(\d{3}) [A-Z]{2} [A-Z]{3} (\d{2}) ([A-Z]+) (.+?) ([A-HJ-NPR-Z0-9]{17})(?: (\d+))?$/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    vehicles.push({ unit: m[1], year: 2000 + Number(m[2]), make: titleCase(m[3]), model: titleCase(m[4]).replace(/\bE-Tr$/, 'e-tron').replace(/\bGladiat$/, 'Gladiator'), vin: m[5], mileage: m[6] ? Number(m[6]) : null, premium: null, additionalInsured: null, defensiveDiscount: null });
  }
  if (!vehicles.length) throw new UnreadableStatement('No vehicles on the auto declarations');
  vehicles.forEach((v, i) => (v.premium = unitPremiums[i] ?? null));
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ADDITIONAL INSURED UNIT # (\d{3})$/);
    if (!m) continue;
    const v = vehicles.find((x) => x.unit === m[1]);
    if (v && lines[i + 1]) v.additionalInsured = titleCase(lines[i + 1]);
  }
  const apc = text.match(/^ACCIDENT PREVENTION COURSE((?: \$[\d,]+)+)$/m);
  if (apc) apc[1].trim().split(/\s+/).forEach((a, i) => vehicles[i] && (vehicles[i].defensiveDiscount = dollars(a)));

  const collIdx = lines.findIndex((l) => /^1\.COLLISION- DEDUCTIBLE$/.test(l));
  const collisionDeductible = collIdx >= 0 ? dollars(lines[collIdx + 1]?.match(/^\$([\d,]+)/)?.[1]) : null;
  const otcIdx = lines.findIndex((l) => /^2\.OTHER THAN COLLISION$/.test(l));
  const compLine = otcIdx >= 0 ? lines.slice(otcIdx + 1, otcIdx + 4).find((l) => /^\$[\d,]+/.test(l)) : undefined;
  const compM = compLine?.match(/^\$([\d,]+)( FULL COVERAGE GLASS)?/);
  const checks: StatementCheck[] = [];
  const unitSum = round2(unitPremiums.reduce((a, b) => a + b, 0));
  checks.push(check('Vehicle premiums add up', unitPremiums.length === vehicles.length && Math.abs(unitSum - premium) < 0.005, `${unitSum.toFixed(2)} vs ${premium.toFixed(2)}`));

  const effective = eff ? mdyy(eff[1]) : termStart;
  const values: HanoverPolicyValues = {
    doc: 'policy',
    line: 'auto',
    policyNumber: head[3],
    termStart,
    termEnd,
    effective,
    reason: reasonRaw ? titleCase(reasonRaw) : amended ? 'Amendment' : 'New Term',
    amended,
    premium,
    prevPremium,
    vehicles,
    liabilityCsl: dollars(text.match(/SINGLE LIMIT LIABILITY - \$([\d,]+)/)?.[1]),
    sum: dollars(text.match(/SUPPL UNINSURED MOTORIST-\$([\d,]+)/)?.[1]),
    medPay: dollars(text.match(/MEDICAL PAYMENTS-\$([\d,]+)/)?.[1]),
    collisionDeductible,
    comprehensiveDeductible: compM ? dollars(compM[1]) : null,
    fullGlass: !!compM?.[2],
  };
  return { periodStart: effective, periodEnd: `${effective}:auto`, values: values as unknown as Record<string, unknown>, transactions: [], checks };
}

// ---- Homeowners declarations ----

function parseHome(text: string): ParsedStatement {
  // pdf.js splits the period box: "- 27 01/15/2026 01/15/20 HVS M123456".
  const head = text.match(/(\d{2}\/\d{2}\/\d{4})\s+\d{2}\/\d{2}\/\d{0,4}\s*([A-Z]{3} M\d{6})/);
  if (!head) throw new UnreadableStatement('No homeowners policy period');
  const termStart = mdy(head[1]);
  const full = text.match(/(\d{2}\/\d{2}\/\d{4}) ?- ?(\d{2}\/\d{2}\/\d{4})/);
  const termEnd = full && mdy(full[1]) === termStart ? mdy(full[2]) : addYear(termStart);
  const eff = text.match(/^EFFECTIVE (\d{2}\/\d{2}\/\d{2})$/m);
  const reasonRaw = text.match(/REASON FOR AMENDMENT: ([A-Z ]+)$/m)?.[1];
  const premM = text.match(/TOTAL POLICY PREMIUM \$([\d,]+\.\d{2})/);
  if (!premM) throw new UnreadableStatement('No total policy premium');
  const premium = money(premM[1]);
  const lines = text.split('\n').map((l) => l.trim());
  const mi = lines.findIndex((l) => l === 'MORTGAGEE');
  const std = dollars(text.match(/STANDARD POLICY PREMIUM \$([\d,]+\.\d{2})/)?.[1]);
  const opt = dollars(text.match(/TOTAL OPTIONAL COVERAGES PREMIUM \$([\d,]+\.\d{2})/)?.[1]);
  const checks: StatementCheck[] = [];
  if (std !== null && opt !== null) checks.push(check('Standard + optional = total', Math.abs(round2(std + opt) - premium) < 0.005, `${round2(std + opt).toFixed(2)} vs ${premium.toFixed(2)}`));
  const effective = eff ? mdyy(eff[1]) : termStart;
  const values: HanoverPolicyValues = {
    doc: 'policy',
    line: 'home',
    policyNumber: head[2],
    termStart,
    termEnd,
    effective,
    reason: reasonRaw ? titleCase(reasonRaw) : /AMENDED DECLARATION/.test(text) ? 'Amendment' : 'New Term',
    amended: /AMENDED DECLARATION/.test(text),
    premium,
    prevPremium: dollars(text.match(/PREV(?:IOUS)? PREMIUM \$([\d,]+\.\d{2})/)?.[1]),
    dwelling: dollars(text.match(/A\. DWELLING \$([\d,]+)/)?.[1]),
    otherStructures: dollars(text.match(/B\. OTHER STRUCTURES \$([\d,]+)/)?.[1]),
    personalProperty: dollars(text.match(/C\. PERSONAL PROPERTY \$([\d,]+)/)?.[1]),
    lossOfUse: text.match(/D\. LOSS OF USE (ACTUAL LOSS SUSTAINED|\$[\d,]+)/)?.[1] ?? null,
    personalLiability: dollars(text.match(/E\. PERSONAL LIABILITY \$([\d,]+)/)?.[1]),
    medPayOthers: dollars(text.match(/F\. MEDICAL PAY TO OTHERS \$([\d,]+)/)?.[1]),
    deductible: dollars(text.match(/\$([\d,]+) PER OCCURRENCE/)?.[1]),
    mortgagee: mi >= 0 && lines[mi + 1] ? titleCase(lines[mi + 1]).replace(/\bLlc\b/, 'LLC') : null,
    address: text.match(/LOCATED AT:\s*\n?([^\n]+)/)?.[1]?.trim() ?? null,
  };
  return { periodStart: effective, periodEnd: `${effective}:home`, values: values as unknown as Record<string, unknown>, transactions: [], checks };
}

// ---- Umbrella declarations ----

function parseUmbrella(text: string): ParsedStatement {
  const head = text.match(/([A-Z]{3} M\d{6}) \d{2} (\d{2}\/\d{2}\/\d{4}) (\d{2}\/\d{2}\/\d{4})/);
  if (!head) throw new UnreadableStatement('No umbrella policy period');
  const termStart = mdy(head[2]);
  const termEnd = mdy(head[3]);
  const amend = text.match(/AMENDMENT: Effective (\d{2}\/\d{2}\/\d{4})/);
  const reasonRaw = text.match(/^Reason: ([A-Z ]+)$/m)?.[1];
  const change = text.match(/TOTAL PREMIUM: Old: \$([\d,]+\.\d{2}) New: \$([\d,]+\.\d{2})/);
  let premium: number;
  let prevPremium: number | null = null;
  if (change) {
    prevPremium = money(change[1]);
    premium = money(change[2]);
  } else {
    const nb = text.match(/Total 12 Month Policy Premium:[\s\S]{0,120}?\$([\d,]+\.\d{2})/);
    if (!nb) throw new UnreadableStatement('No umbrella premium');
    premium = money(nb[1]);
  }
  const effective = amend ? mdy(amend[1]) : termStart;
  const values: HanoverPolicyValues = {
    doc: 'policy',
    line: 'umbrella',
    policyNumber: head[1],
    termStart,
    termEnd,
    effective,
    reason: reasonRaw ? titleCase(reasonRaw) : amend ? 'Amendment' : 'New Term',
    amended: !!amend,
    premium,
    prevPremium,
    limit: dollars(text.match(/LIMIT OF LIABILITY EACH OCCURRENCE:\s*\$([\d,]+)/)?.[1]),
    excessUm: dollars(text.match(/EXCESS UM\/UIM COVERAGE:\s*\$([\d,]+)/)?.[1]),
    retainedLimit: dollars(text.match(/RETAINED LIMIT:\s*\$([\d,]+)/)?.[1]),
  };
  return { periodStart: effective, periodEnd: `${effective}:umbrella`, values: values as unknown as Record<string, unknown>, transactions: [], checks: [] };
}
