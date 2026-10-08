# Ally Bank — template `ally`

Drive folder **"Ally Bank"**, files `Ally - YYYY.MM.DD - Statement.pdf`, one
per month dated the 25th, **2014-01 → today (153 PDFs, no gaps)**. Owner:
Household. Kind: `balance` (counts toward Finance totals).

## One statement, several accounts
Ally's *combined* statement covers every account in the relationship, so a
single PDF holds:

| Account | Last 4 | Opened | Names over time |
|---|---|---|---|
| Savings | ••4477 | 2014-01-01 | "Online Savings Account" → 2023 "Savings" / "Savings Account" |
| Checking | ••5585 | 2020-03-25 | "Interest Checking" → 2023 "Checking" / "Spending Account" |

Accounts are keyed by **last 4 digits**, never by name. Transactions carry
`statement_transactions.account` (migration 0093). Mike chose (2026-10-07)
**one Vault entry + one Finance row** ("Ally Bank") with both accounts broken
out, not two separate accounts. ••6104 seen in transfers is an Ally account
outside this statement (treated as an outside account).

## Layout (one era, "STMTCMB100 05/2013", 2014 → today)
- Page 1: `Statement Date` / `MM/DD/YYYY`; account list
  `<Name> xxxxxx1234 $begin $end`; `Total Account Balances: $a $b`.
- Per account: `Summary For: <holders>` (preceded by the section name),
  `Account Number: xxxxxx1234 Open Date: MM/DD/YYYY`, `Product: … Account
  Ownership: Joint`, summary block (Beginning/Ending Balance as of,
  Deposits and Other Credits, Interest Paid This Period, ATM Fees Reimbursed
  (checking), Withdrawals and Other Debits, Days, APY Earned, Average Daily
  Balance, Interest Paid YTD, Overdraft Items Paid/Returned).
- Activity: `MM/DD/YYYY <Type>`, description lines, then
  `$credit -$debit $balance` (or all on one line). Rows can span pages —
  page furniture is filtered out. Everything after the `Ending Balance` row
  is the back-page reconciliation form and is ignored.
- Row types seen: ACH Withdrawal, WEB Funds Transfer, Direct Deposit,
  Interest Paid, NOW Withdrawal, Check, ATM Withdrawal, eCheck Deposit,
  Overdraft Transfer, ACH Return, Wire Transfer, Wire Fee, Check Card
  Purchase. Kinds stored: deposit · interest · transfer_in · transfer_out ·
  withdrawal · fee · other. Descriptions drop the "~ Future Amount … ~ Tran:"
  ACH noise.

## Checks
Per account, per statement: summary adds up (begin + credits + interest +
ATM reimbursed + debits = end); row credits / interest / debits match the
summary; running balance on every row; Beginning/Ending rows match; period
ends on the statement date; page-1 list matches each section; total adds up.
Across statements (on load): each account's beginning = previous ending;
interest YTD carries forward (resets in January). Skipped across a missing
month (the gap is flagged instead).

## Report card (2026-10-07, local workerd, all 153 PDFs)
- **153 / 153 read**, 0 unreadable, 0 duplicates, 0 missing months.
- **2,241 / 2,241** in-statement checks + **461 / 461** cross-statement
  checks pass. 1,618 transactions.
- Lifetime interest $8,049 (savings $7,882, checking $167).

## Outputs (`allyDerive.ts`, `allySummary.ts`)
- **Vault "Ally Bank"**: seeded facts Checking ••5585, Savings ••4477,
  Customer Service (once). Note "Account Details": Account table (intro) +
  owned sections Balances as of… · Recurring Payments · Interest by Year ·
  Recent Statements · Change History. Links: Ally Bank · Finance Dashboard ·
  Drive Folder.
- **Flags**: unreadable/duplicate files; failed checks; a missing month; no
  new statement 10 days after it was due; a fee, overdraft-protection
  transfer or ACH return on the latest statement; returned overdraft items;
  savings APY earned down ≥ 0.25 pp over the last 3 statements.
- **Tax Packet** (this year + last only): interest by account, total
  (full year / through date), 1099-INT expected when interest ≥ $10; a PDF
  in the folder with "1099" and the year in its name is linked and checked
  off (it's recorded as Skipped, never parsed).
- **Recurring payments**: a payee (outside transfers excluded) in ≥ 3 of the
  last 6 statements, with its usual day and latest amount.
- **Money In & Out**: per statement, both accounts, transfers between the
  two (and overdraft protection) excluded.
- **Dashboard** (`AllyDashboard.tsx`): stat strip, Balances Over Time
  (1Y/3Y/All), Interest by Year, Savings APY Earned, Recurring Payments,
  Money In & Out, Transactions (last 24 months; account filter + search),
  all Statements with math + PDF links.
