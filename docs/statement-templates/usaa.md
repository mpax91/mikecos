# USAA Checking — template `usaa`

Drive folder **"USAA Checking Account"**, files `USAA FSB - YYYY.MM.DD.pdf`,
one per month (closing mid-month), **2007-11 → today (228 PDFs)**. Owner:
Household. Kind: `balance` (counts toward Finance totals). One account:
**USAA Classic Checking** (printed "USAA Secure Checking" 2013–2016,
"Four Star Checking" before) — keyed by its last 4 digits; the full number
is never stored. Vault entry "USAA Checking".

## Layouts
| Era | Files | How it reads |
|---|---|---|
| classic | 2007-11 → 2021-01 (159) | One summary line of seven numbers (balance last statement · no. of debits · total debits · no. of deposits · total deposits · service charges · balance this statement). pdf.js often reads these PDFs **letter by letter** (`0 8 / 2 9 2 , 0 1 6 . 7 3`), so counts run into amounts — the line is split every possible way and the split whose arithmetic holds (last − debits + deposits − charges = balance) wins, preferring the one whose counts/totals match the rows. Sections: DEPOSITS AND OTHER CREDITS, CHECKS (1–2 per line, `MM/DD NNNN[*] amount` — the number is tried as 4, 3, 2, 5 digits), OTHER DEBITS, ACCOUNT BALANCE SUMMARY (end-of-day balances; `158.39OD` = overdrawn), interest paragraph (APY earned, YTD interest, days). Statement date = the spaced `MM/DD/YY` near the top; period start = first end-of-day date. Rows on the period's first day belong to the previous statement. Up to 3 description lines follow a row; page furniture ends them. |
| modern | 2021-02 → today (69) | `Statement Period: A to B`; Activity Summary (Beginning, `N Deposits/Credits $x`, `N Withdrawals/Debits $x`, Service Charges, Ending); OD / NSF fee table (period + YTD, `N/A` = null); Transactions rows `MM/DD <type>` then description lines and `<debit|0> <credit|0> <running balance>` spread over lines. Page furniture (MDATA, `USAA_DOCUMENT_BREAK`, repeated headers) is dropped first. **Rows aren't always in date order** (2021-05 prints its 04/16 items last) → rows are sorted by date and the running balance is checked per day. |

Kinds: deposit · interest (incl. "Promotional Credit", which USAA counts as
interest) · transfer_in / transfer_out (Mike's own accounts: USAA funds
transfers, Ally, Amex savings, Schwab, Robinhood, PayPal transfers) ·
payment (credit card payments) · withdrawal · fee.

## Checks
Per statement: summary adds up; row credits / debits = printed totals;
classic: end-of-day balances follow the rows and start/end at the summary
balances; modern: per-day running balance, Beginning / Ending rows. Item
counts are NOT checked (USAA counts deposit items, not rows — 18 statements
differ while the totals agree). Across statements (on load): beginning =
previous ending; classic YTD interest carries (resets in January).

**Report card (2026-10-14, local workerd):** 228/228 read, 1,368/1,368
in-statement checks pass, 227/227 carry-overs, no months missing, 6,832
transactions. YTD interest carry fails only where a Promotional Credit
was printed as interest — fixed by counting it as interest.

## Outputs
- Finance row: balance. Dashboard (`UsaaDashboard.tsx`, on the dash kit):
  range tiles Balance / Money In / Money Out / Net → sheets; Balance Over
  Time (statement + average daily); Recurring Payments; Where Money Comes
  From & Goes (rule categories: Paychecks, Unemployment, Card Payments,
  Transfers, Sportsbooks, Venmo/Zelle/PayPal, Checks, Cash & ATM, Deposits,
  Debit Card, Bedford Bee (Stripe), Interest, Fees, Bills & Other) → payees;
  Card Payments by issuer (12 months); Cash Placement; By Year; Interest;
  Fees & Overdrafts; Transactions (last 24 statements); Statements.
- Flags: unreadable / duplicate file, failed check, missing month (`gap:`),
  late statement (`missing_after:`), and on the latest statement a fee
  (`fee:`), returned item (`return:`), negative day (`od:`).
- Cash Placement: `CASH_SOURCES.usaa`. Checking only, so the idle-cash
  target is the best savings account at another bank of the same owner.
  Outflow excludes transfers to Mike's own accounts.
- Tax Packet: interest this year + last; 1099-INT only when ≥ $10 (USAA
  interest is ~$3/yr, so "not expected").
