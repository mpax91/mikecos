# T-Mobile — Wireless (template `tmobile`)

Drive folder **T-Mobile** (Household). Files `T-Mobile - YYYY.MM.DD.pdf`,
monthly bills dated the 8th, Sep 2019 → today (86 files as of Oct 2026),
account 967709602. Code: `worker/src/statements/templates/tmobile.ts`
(parser + checks), `tmobileSummary.ts` (pure summary), `tmobileDerive.ts`
(Vault, flags, billing snapshot), dashboard
`src/components/TmobileDashboard.tsx`.

It's a **bill** account (`account.kind = 'bill'`): Finance shows the latest
bill and the usual monthly cost (median of the last 6 bills); it's left out
of the balance total. AutoPay → Bills & Due Dates shows a green Auto-Pay
marker on the 1st, no task.

## Lines

`TMOBILE_LINE_NAMES` in the template: (914) 263-9681 = **Mike**,
(508) 221-5290 = **Wife** (Mike, 2026-10-11). Lines that came and went are
named by type + last 4: Line ••9482 (third voice line, Sep 2019 → Apr 2022),
Wearable ••4580 (Galaxy Watch, Jul 2022 → Jul 2024), Digits ••2438 (one
bill, Aug 2026).

## Layout

One layout family the whole time; only the page header changed:

| Era | Bills | Header |
|---|---|---|
| period | 2019-09 → 2023-01 | `Bill period / Oct 09, 2022 - Nov 08, 2022` (bill date = end date) |
| issue | 2023-02 → today | `Bill issue date / Oct 08, 2026` |

pdf.js text order is clean (no scrambling). The parser reads the bill body
only — everything after `APPENDIX_BEGIN` / `USAGE DETAILS` (every call and
text) is ignored and never stored.

## Fields

- Page 1: `TOTAL DUE / $ / 122 / .50`, `Your bill is due by …`,
  `AutoPay is scheduled for … using Visa ****2374.` (→ `autopayCard`
  "Visa ••2374"), `Thanks for paying your last bill of $X on …`, and when
  last month didn't simply get paid: a `BALANCE` / `BALANCE FORWARD` /
  `PAST DUE BALANCE` box (split amount, `-$` for a credit).
- `YOUR LAST BILL`: Previous balance, `Payment - thank you Oct 30 -$x`
  (→ payment transactions), `Credits & adjustments (914) … Device recovery
  credit Oct 17 -$x` (→ adjustment transactions; rows may wrap). Short
  dates get the bill's year (a month two+ after the bill month = last year).
  No block → last month was paid in full; the page-1 "Thanks for paying"
  line becomes the payment.
- `THIS BILL SUMMARY`: header names the columns (`Plans Equipment Services
  [One-time charges] Total`; 2019-09 has no `Line Type`). Rows: `Totals`,
  `Account`, and one per line `(508) 221-5290 [- Status] Voice …` with
  cells `Included` / `-` / `$x`. **Totals = this bill's charges** (taxes are
  inside T-Mobile's prices).
- `DETAILED CHARGES`: plan name (`Account Go5G Plus Military $120.00`),
  `REGULAR CHARGES Oct 09 - Nov 08` (service period, charged in advance),
  equipment items — each ends `ID: <plan id>, Balance: $x, Installment k of
  N` then an amount line (`$2.50`, `-$37.71`, or `-` for a completed plan).
  Names come from the lines above the ID (a leading phone number sets the
  line). Promo credits (`P416 Smarthpone Trade…`, `… Buy and Save`,
  `Trade-In EIP Prepayment Credit`) are kept as `promos`. The equipment
  block can run across a page break with the YOU SAVED / YOU USED side
  column in between (2022-07) — those rows have no `ID:` line and are
  skipped.
- `YOU SAVED` (total + AutoPay / Service / Subscription / Device discounts),
  `YOU USED` (total GB, GB per line, minutes, messages).
- Taxes (informational): `INCLUDED TAXES & FEES` items (not the "before
  taxes & fees" base lines) + `ADDITIONAL GOVERNMENT TAXES & FEES`.
- Late fee: `had a Late Payment of $2.25` / `Late fee for invoice … $2.19`.

## Checks

In each bill: Balance + This Bill = Total Due · Plans + Equipment + Services
+ One-Time = Totals · Account + Lines = Totals · Previous Balance + Payments
+ Credits = Balance (when YOUR LAST BILL prints) · Itemized Equipment =
Equipment. Across bills (≤ 40 days apart): Prior Total Due = This Previous
Balance.

## Report card (2026-10-11)

- 86 PDFs in Drive. **75 tested locally in workerd**; 11 (2023-04 → 06,
  2023-09 → 12, 2024-09 → 12) are 6.3–9.2 MB and too big for the Drive
  connector — same layout as their neighbours; the live scan reads them.
- 75/75 read · **377/377 checks** (306 in-bill + 71 cross-bill).
- Local D1 with the real app routes: Finance headline $122.50 (Oct 8, 2026,
  AutoPay, usual $125.50); Bills & Due Dates → due the 1st, Auto-Pay marker
  Nov 1 $122.50; payment Quick Facts written (Due Date 1st, Auto-Pay Yes,
  Latest $122.50, Avg 12-mo $125.62).
- Data: plan Go5G Plus Military $120 for 2 lines since Aug 2023 (Magenta
  Plus Military $100 before, 3 lines); Galaxy S24 (Mike) installment 23 of
  24, $35.67 left → paid off with the Nov 2026 bill; $11,538 billed since
  Sep 2019 (75 bills), $2,176 of it for phones; $4,663 in discounts.
- History: Feb 2023 bill was past due ($182.96 carried, $2.25 late fee,
  AutoPay discount lost that month) — paid Feb 21 + 27.

## Flags

`file:` / `dup:` · `check:` (failed math) · `past_due:` (unpaid balance
carried — attention) · `fee:late:` (late fee on the latest bill —
attention) · `plan:` (plan name or account plan price changed, info) ·
`line:` (line added / removed, info) · `device_payoff:<plan id>` (one
installment left, info) · `missing_after:` (no bill 45 days after the last —
attention) · `high_bill:` (anomalies.ts) · payer flags.

## Vault

Entry **T-Mobile**. Seeded facts: Account, Lines (Mike / Wife numbers),
Customer Service. Note "Account Details" owned sections: Current Bill,
Lines, Device Payments, Spend by Year, Recent Bills, Change History.
Links: T-Mobile Account, Finance Dashboard, Drive Folder. Tax Packet: none.
