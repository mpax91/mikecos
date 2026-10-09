# American Express Bank — template `amexBank`

Drive folder **"American Express Bank"**, files `AMEX FSB - YYYY.MM.DD.pdf`,
one per month dated the 10th (the 11th in 2013–2019), **2011-06 → today
(184 PDFs)**. Owner: Household. Kind: `balance` (counts toward Finance
totals). One account: **High Yield Savings ••8815** (printed
`151-991881-5` until mid-2013, `xxxxxxxx8815` after). Bank name changed
from "American Express Bank, FSB" to "American Express National Bank" —
the parser doesn't care.

## Layouts
| Era | Files | How it reads |
|---|---|---|
| Scans | 2011-06 → 2012-12 (19) | Image-only, no text layer → **unreadable** (one info flag for all of them, not 19). |
| A — "Statement of Account" | 2013-02 → 2013-06-16 | `This statement:` / `Last statement:` dates; rows `MM-DD # Type amount` (signed: Additions +, Subtractions −) with the counterparty on the next line; `Ending totals adds subs $end`; `Annual percentage yield earned`, `Average balance for APY`, `Interest earned`. No running balance, no interest YTD. 2013-06-16 is a 6-day stub. |
| B — "Account Statement For:" | 2013-06-17 → today | `Statement Period: <date> - <date>`; **Account Summary** either inline (`MM/DD/YYYY Balance Last Statement $x`, 2021+) or *columnar* (2013-07 → 2020-12: every label first, then every value in the same order — dollar values and percent values are zipped against their labels); **Account Activity** rows `MM/DD/YYYY <Type>`, description lines, then `$amount $balance` — **one amount column**, so debit vs credit is read off the running balance. Rows span pages; everything between a page break (`TAMXDS…`, `Page n of m`, the EFT notice) and the next column header is skipped. |

Row types: ACH Deposit, ACH Withdrawal, External ACH Withdrawal, Interest
Payment (era A: Preauthorized Credit, External ACH Debit, Interest). Kinds
stored: deposit · withdrawal · interest · fee · other. Description =
`Type · counterparty · …` (era A keeps only the counterparty line; the rest
is ACH plumbing). Stated APY + interest rate print from 2016; before that
the dashboard uses the APY earned.

## Checks
Per statement: summary adds up (begin + credits − debits = end; credits
include interest); row credits / debits / interest match the summary;
running balance (era B); Beginning/Ending rows match; account line on
page 1 = ending; days in period. Era A: ending totals add up; interest
earned matches. Across statements (on load): beginning = previous ending
(when the periods touch), interest YTD carries forward (resets in January).

## Report card (2026-10-09, local workerd, 181 of 184 PDFs)
- **162 / 162 text statements read**, 19 image-only (2011–2012), 0 failed,
  0 duplicates. 3 small 2013 files (2013.02.10, 2013.06.10, 2013.06.16)
  couldn't be pulled through the Drive connector in the sandbox (they come
  back inline); all three are era A — 2013.06.16 confirmed by Drive's text
  view — and get read by the live scan.
- **1,455 / 1,455** in-statement + **318 / 318** cross-statement checks.
  421 transactions. 61 APY changes. Lifetime interest (readable
  statements) $4,650; 2025 $1,597.68; 2026 YTD $536.17.
- Missing month: 2013-01 (inside the scan years, so not flagged).
- Latest (9/10/2026): $894.22 at 3.00% APY (rate 2.956%).

## Outputs (`amexBankDerive.ts`, `amexBankSummary.ts`)
- **Vault "American Express Savings"**: seeded facts Savings ••8815,
  Customer Service (once). Note "Account Details": Account (intro) +
  owned sections Balance as of… · Rate History · Interest by Year ·
  Recent Statements · Change History. Links: American Express Savings ·
  Finance Dashboard · Drive Folder.
- **Flags**: image-only scans (one info flag); other unreadable / duplicate
  files; failed checks; a missing month; no new statement 10 days after
  it was due; a fee on the latest statement; APY change on the latest
  statement (info); APY down ≥ 0.25 pp over 3 statements (info).
- **Tax Packet** (this year + last): interest (full year once the
  December statement is in — interest is credited on the statement date),
  1099-INT expected when ≥ $10; a PDF in the folder with "1099" + the year
  in its name is skipped as a statement and linked / checked off.
- **Wallet**: `values.accounts[]` (savings ••8815) → shows up under "Found
  on your statements" in Wallet → Bank Accounts.
- **Cash Placement**: `CASH_SOURCES.amexBank` — savings only, so only the
  cross-bank rule applies (vs Ally savings).
- **Dashboard** (`AmexBankDashboard.tsx`): stats (Balance, APY, Interest
  YTD, Last Rate Change), Balance Over Time + APY Over Time (1Y/3Y/All),
  Interest by Year, Rate Changes, Cash Placement (savings-only), Money In
  & Out (13 statements), Where Money Comes From & Goes (counterparties,
  24 statements), Transactions (type filter + search), all Statements with
  math + PDF links.
