# Template `targetCard` — Target RedCard / Target Circle Card (credit card)

Drive folder **Target RedCard** (also matches "Target Circle Card", "Target
Card"), files `Target RedCard - YYYY.MM.DD.pdf`. Issued by TD Bank USA,
serviced by Target Card Services. A store card used only at Target.

## Layouts

| Layout  | Dates             | Notes |
|---------|-------------------|-------|
| classic | 2020-08 → 2025-02 | pdf.js drops the spaces inside words (`PreviousBalance $0.00`, `StatementClosingDate 8/19/2020`). Rows `Aug.11 TARGET.COM 800-591-3869 $4.15` — May has no dot (`May16`); the last row of a section can carry the section total glued on (`-$4.15-$4.15`); the interest row `INTERESTCHARGE-PURCHASES $4.90` has no date (dated at closing). YTD savings = the `$X` line after `SaveatTargetandTarget.com`; January statements don't print it. |
| modern  | 2025-04 → today   | Spaced labels (`Previous Balance $0.00`, `Total Credit Limit`), rows `4/15 TARGET.COM 800-591-3869 MN $82.62` (1- or 2-digit month), `Target Circle Card Savings this Year: $4.35` (amount inline or on the next line). |

Labels are matched with all spaces removed, so one set of rules reads both.

## What's read

Closing date, days in cycle (opening = closing − days + 1), due date,
previous / payments & credits / purchases & debits / fees / interest / new
balance, minimum, credit limit, available credit, purchase APR, fees and
interest charged year-to-date, **savings so far this year**, card name
(RedCard → Circle Card), last 4 digits only. Transactions: purchase
(Target.com vs in store), refund (returns), payment, fee, interest,
adjustment.

## Checks

In-statement: summary adds up; payments + returns rows = Payments and Other
Credits; purchase rows = Purchases and Other Debits; fee rows = Fees
Charged; interest rows = Interest Charged. Available credit is NOT checked —
it reflects pending charges. Cross-statement: balance carries over; savings this year never go
down within a year.

**Report card (2026-10-15):** 43/43 PDFs (2020-08 → 2025-10) read in local
workerd, 215/215 in-statement + 69/69 cross checks, 141 transactions.

## Savings (the card's "reward")

The 5% comes off at the register — the card is charged the discounted
price; there's nothing to redeem. Each statement prints "You've saved $X this
year"; a statement's share = its figure − the last one printed earlier that
calendar year (a January statement that doesn't print it pushes its savings
onto the next one). A year's total = the last figure printed that year, so
purchases after the year's last closing (≈ Dec 20–31) aren't in any year.
`rewardsFromTargetCard`: unit dollars, label "Savings", `available: null`
(→ no redeem reminder), redeemed = earned.

## Statements only when used

Target sends a statement only for a month with activity or a balance. The
month right after a statement with a balance must have one (it shows the
payment) — missing otherwise; later empty months are quiet if the next
statement's previous balance is $0 (`targetGaps`). `missing_after` fires
only while the latest statement has a balance.

## AutoPay

Not printed. Inferred: a payment equal to the previous statement's full
balance dated on its due date (or one day after) = AutoPay. Feeds
`billing.autopay` (Bills & Due Dates, Auto-Pay Quick Fact); Mike can
override in Bills.

## Outputs

- Vault entry "Target RedCard": seeded facts Card, Perk, Customer Service;
  note "Account Details" with Balance, Savings, Spend by Year, Recent
  Statements, Fees & Interest, Change History; links Manage My Circle Card,
  Finance Dashboard, Drive Folder.
- Flags: file / dup / check / `gap:` / `gaps_old:` / `missing_after:` /
  `interest:` / `fee:` / `carried:` / `change:apr|credit_line` /
  `utilization:` / `credit_balance:` + `cardChargeFlags` + `payerFlags`.
- `meta.billing`, `meta.card` (Card Quick Facts; Rewards = "5% Target and
  Target.com (off at checkout)" unless a Wallet Rewards card says otherwise),
  `meta.rewards`.
- Finance headline `kind 'card'`, `pointsValue: null`.
- Tax Packet: nothing.
- Dashboard `TargetCardDashboard.tsx` (dash kit): RangePicker YTD/1Y/All
  (default All); tiles Spent / Saved / Balance / Saved This Year → sheets;
  Spend & Savings by Year (tap → year sheet with Target.com vs in store);
  Latest Statement; Worth Knowing; Statements (cards on phones) → statement
  sheet with every row and its checks.
